// recordEvent (section 6): seq, trimming with the truncated flag, redaction before trimming, token counters and the
// stream usage rows.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-events-test-');
process.env.JV_HOME = home;
const { recordEvent, tailEvents, trimText, EVENT_TEXT_MAX } = await import('../src/events.js');
const { openStore } = await import('../src/store.js');

after(() => rmSync(home, { recursive: true, force: true }));

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home);
let n = 0;
function newRun() {
  n++;
  return store.createSession({
    project_id: seeded.projectId,
    task_id: seeded.taskId,
    step_id: seeded.stepIds[0]!,
    request_id: `req-ev-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
  }).row;
}

test('seq counts per session and last_event_at follows', () => {
  const a = newRun();
  const b = newRun();
  assert.equal(recordEvent(store, a.id, 'start', { model: 'm' }).seq, 1);
  assert.equal(recordEvent(store, a.id, 'text', { text: 'hi' }).seq, 2);
  assert.equal(recordEvent(store, b.id, 'text', { text: 'hi' }).seq, 1);
  const last = recordEvent(store, a.id, 'end', { status: 'done' });
  assert.equal(last.seq, 3);
  assert.equal(store.getSession(a.id)!.last_event_at, last.at);
});

test('long strings are cut to 20000 characters with truncated: true', () => {
  const s = newRun();
  const row = recordEvent(store, s.id, 'text', { text: 'x'.repeat(EVENT_TEXT_MAX + 50), other: 'short' });
  const p = JSON.parse(row.payload) as { text: string; truncated: boolean; other: string };
  assert.equal(p.text.length, EVENT_TEXT_MAX);
  assert.equal(p.truncated, true);
  assert.equal(p.other, 'short');
  const small = JSON.parse(recordEvent(store, s.id, 'text', { text: 'short' }).payload) as Record<string, unknown>;
  assert.equal(small.truncated, undefined);
  assert.equal(trimText('\u{1D11E}\u{1D11E}\u{1D11E}', 2).text, '\u{1D11E}\u{1D11E}');
});

test('secrets are redacted before the cut, so a secret across the boundary never survives in part', () => {
  const s = newRun();
  const text = `${'y'.repeat(EVENT_TEXT_MAX - 5)}${FAKE_TOKEN} tail`;
  const row = recordEvent(store, s.id, 'tool-result', { output: text, [FAKE_TOKEN]: FAKE_TOKEN, nested: [{ t: `a ${FAKE_TOKEN}` }] });
  assert.ok(!row.payload.includes(FAKE_TOKEN));
  assert.ok(!row.payload.includes(FAKE_TOKEN.slice(0, 5)));
  assert.match(row.payload, /\[redacted\]/);
});

// A made-up value of 97 characters, built at run time, that the redactor knows.
const LONG_SECRET = `fake-long-secret-${'Q1w2E3r4'.repeat(10)}`;

test('a tool text cut at 4000 characters keeps no part of a secret that crosses the cut (transcriptEvents, then recordEvent)', async () => {
  const { transcriptEvents, TOOL_TEXT_MAX } = await import('../src/transcript.js');
  const { Redactor } = await import('../src/redact.js');
  const redactor = new Redactor([LONG_SECRET]);
  const s = newRun();
  for (const start of [TOOL_TEXT_MAX - 50, TOOL_TEXT_MAX - 90, TOOL_TEXT_MAX - 10]) {
    const text = `${'z'.repeat(start)}${LONG_SECRET} and more after it ${'w'.repeat(200)}`;
    const turns = [
      { id: `t${start}`, role: 'assistant' as const, blocks: [{ type: 'tool' as const, id: `tu${start}`, name: 'Write', input: text, output: text, state: 'completed' as const }] },
    ];
    const events = transcriptEvents(turns, redactor);
    assert.deepEqual(events.map((e) => e.kind), ['tool-call', 'tool-result']);
    for (const e of events) {
      const row = recordEvent(store, s.id, e.kind, e.payload, { redactor });
      assert.ok(!row.payload.includes(LONG_SECRET.slice(0, 20)), `${e.kind} at ${start} keeps part of the secret`);
      assert.match(row.payload, /\[redacted\]/);
    }
  }
});

test('redactedTrim masks first and cuts after, flagging the cut on the masked text', async () => {
  const { redactedTrim } = await import('../src/events.js');
  const { Redactor } = await import('../src/redact.js');
  const redactor = new Redactor([LONG_SECRET]);
  const cut = redactedTrim(redactor, `${'a'.repeat(30)}${LONG_SECRET}`, 40);
  assert.equal(cut.text, `${'a'.repeat(30)}[redacted]`);
  assert.equal(cut.truncated, false, 'the masked text fits');
  const long = redactedTrim(redactor, `${'a'.repeat(35)}${LONG_SECRET}bbbb`, 40);
  assert.equal(long.text, `${'a'.repeat(35)}[reda`);
  assert.equal(long.truncated, true);
  assert.deepEqual(redactedTrim(redactor, 'nothing secret here', 40), { text: 'nothing secret here', truncated: false });
});

test('usage events add to the session counters', () => {
  const s = newRun();
  recordEvent(store, s.id, 'usage', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 0.25 });
  recordEvent(store, s.id, 'usage', { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  const row = store.getSession(s.id)!;
  assert.equal(row.input_tokens, 101);
  assert.equal(row.output_tokens, 22);
  assert.equal(row.cache_read_tokens, 1003);
  assert.equal(row.cache_write_tokens, 54);
  assert.equal(row.cost_usd, 0.25);
});

test('rate-limit events are stream rows of provider_usage under the session provider', () => {
  const s = newRun();
  recordEvent(store, s.id, 'rate-limit', { fiveHourPct: 12.5, weeklyPct: 40, weeklyResetsAt: '2026-11-05T00:00:00.000Z' });
  const u = store.latestProviderUsage('claude-main', 'stream')!;
  assert.equal(u.five_hour_pct, 12.5);
  assert.equal(u.weekly_pct, 40);
  assert.equal(u.weekly_resets_at, '2026-11-05T00:00:00.000Z');
  assert.equal(u.five_hour_resets_at, null);
});

test('tailEvents reads after a seq, and with follow stops at the end event', async () => {
  const s = newRun();
  for (const t of ['a', 'b', 'c']) recordEvent(store, s.id, 'text', { text: t });
  const seen: number[] = [];
  for await (const e of tailEvents(store, s.id, 1)) seen.push(e.seq);
  assert.deepEqual(seen, [2, 3]);
  setTimeout(() => recordEvent(store, s.id, 'end', { status: 'done' }), 100);
  const followed: string[] = [];
  for await (const e of tailEvents(store, s.id, 3, { follow: true, pollMs: 20 })) followed.push(e.kind);
  assert.deepEqual(followed, ['end']);

  // stopRun writes `stopped` before the run process writes its `end`: follow waits for it.
  const stopped = newRun();
  store.setSessionState(stopped.id, 'stopped', 'stopped by the owner');
  setTimeout(() => recordEvent(store, stopped.id, 'end', { status: 'stopped' }), 100);
  const tailStopped: string[] = [];
  for await (const e of tailEvents(store, stopped.id, 0, { follow: true, pollMs: 20 })) tailStopped.push(e.kind);
  assert.deepEqual(tailStopped, ['end']);
  // A lost run never gets one.
  const lost = newRun();
  store.setSessionState(lost.id, 'lost', 'process gone');
  const tailLost: string[] = [];
  for await (const e of tailEvents(store, lost.id, 0, { follow: true, pollMs: 20 })) tailLost.push(e.kind);
  assert.deepEqual(tailLost, []);
});
