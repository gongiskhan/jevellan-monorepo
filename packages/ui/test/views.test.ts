// The lifted viewer's views (section 10 of the skills brief), now the read side of jv ui: overview, task, session,
// decisions and usage built from the read-only store; the evidence helpers; the ReadOnlyStore guarantees; the
// redaction of what is served; and the viewer's browser helpers (viewer/markdown.js, viewer/format.js), which stay in
// the package. The HTTP routes of the server have their own suites (server, auth, routes, events).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-ui-views-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { defaultRedactor } = await import('jevellan-core/redact');
const { UI_ROOT } = await import('../server/server.js');
const { ReadOnlyStore } = await import('../server/db.js');
const { evidenceUrl, isoWeek, currentStep, overview, taskDetail, sessionPage, usage, decisions } = await import('../server/views.js');
const { sniffImage, evidenceSegments } = await import('../server/evidence.js');
const { buildUiFixture } = await import('./fixtures/ui-fixture.js');
const markdown = (await import(pathToFileURL(join(UI_ROOT, 'viewer', 'markdown.js')).href)) as {
  renderMarkdown(text: string): string;
  renderInline(text: string): string;
};
const format = (await import(pathToFileURL(join(UI_ROOT, 'viewer', 'format.js')).href)) as {
  dateFmt: Intl.DateTimeFormat;
  fullFmt: Intl.DateTimeFormat;
  clockFmt: Intl.DateTimeFormat;
  rateLimitParts(p: unknown, formatDate: (iso: string) => string): string[];
  toolResultView(p: unknown): { name: string; command?: string; body: string; detail: string; failed: boolean };
  hiddenNote(n: number): string;
  providerUsageNote(p: unknown): string;
};

const store = openStore();
const fx = buildUiFixture(store, home);
const aliveIds = new Set(fx.alive);
const db = new ReadOnlyStore(store.file);
const opts = { alive: (s: { id: string }) => aliveIds.has(s.id) };

after(() => {
  db.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A view as a client receives it: redacted, then through JSON. */
function served<T = any>(value: unknown): T {
  return JSON.parse(JSON.stringify(defaultRedactor().redactValue(value))) as T;
}

test('the first page groups tasks as section 10 lists them, with step, model, last event and the lost dot', async () => {
  const d = served(overview(db, opts));
  assert.equal(d.projects.length, 1);
  const p = d.projects[0];
  assert.equal(p.name, 'jevellan-live-sandbox');
  assert.deepEqual(
    p.groups.map((g: any) => g.state),
    ['waiting-owner', 'running', 'queued', 'landing', 'done', 'failed'],
  );
  const ids = p.groups.flatMap((g: any) => g.tasks.map((t: any) => t.id));
  assert.ok(!ids.includes(fx.tasks.doneOld), 'a task done three days ago is not listed');
  assert.ok(p.hidden >= 1);
  const line = (id: string) => p.groups.flatMap((g: any) => g.tasks).find((t: any) => t.id === id);
  const running = line(fx.tasks.running);
  assert.equal(running.kind, 'feature');
  assert.equal(running.step.duty, 'implement');
  assert.equal(running.step.ordinal, 1);
  assert.equal(running.session.model, 'claude-sonnet-5-5');
  assert.equal(running.session.provider, 'claude-second');
  assert.ok(running.lastEventAt);
  assert.equal(running.lost, false);
  const lost = line(fx.tasks.lost);
  assert.equal(lost.lost, true, 'a running row whose process is gone shows the lost dot');
  assert.equal(lost.step.state, 'retrying');
  const asked = line(fx.tasks.asked);
  assert.match(asked.stateReason, /ask-owner/);
  assert.equal(asked.step.duty, 'verify', 'the step at the end of the workflow, the last one that ran');
});

test('the task page has the text, the steps with attempts, sessions, reports, decisions, landing and children', async () => {
  const d = served(taskDetail(db, fx.tasks.asked, opts));
  assert.equal(d.task.id, fx.tasks.asked);
  assert.match(d.task.text, /No customers yet/);
  assert.deepEqual(d.steps.map((s: any) => [s.ordinal, s.duty, s.state]), [
    [1, 'plan', 'skipped'],
    [2, 'implement', 'done'],
    [3, 'verify', 'done'],
    [4, 'document', 'skipped'],
  ]);
  const impl = d.steps[1];
  assert.equal(impl.attempts, 1);
  assert.equal(impl.sessions.length, 1);
  const s = impl.sessions[0];
  assert.equal(s.runtime, 'claude-sdk');
  assert.equal(s.provider, 'claude-main');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'medium');
  assert.equal(s.nativeSessionId, '3c9e1f52-7a4b-4d0e-9b1a-6f2c8d7e5a10');
  assert.equal(s.tokens.input, 48210);
  assert.equal(s.costUsd, 0.84);
  assert.equal(s.report.status, 'done');
  assert.deepEqual(s.report.changedFiles.length, 3);
  assert.equal(s.report.testsRun.passed, true);
  const placement = impl.placements[0];
  assert.equal(placement.kind, 'placement');
  assert.match(placement.summary, /Opus medium via claude-main \(claude-sdk\)/);
  const model = placement.answers.find((a: any) => a.question === 'model');
  assert.equal(model.choice, 'Opus via claude-main (claude-sdk)');
  assert.equal(model.probabilities[0].p, 0.62);
  assert.ok(placement.answers.some((a: any) => a.question === 'provider' && a.source === 'only-option'));
  assert.deepEqual(placement.outcome, { status: 'done', attempts: 1, durationMs: 312000, costUsd: 0.84 });

  const verify = d.steps[2];
  assert.equal(verify.placements[0].overrideMode, 'keep');
  assert.equal(verify.placements[0].override.model, 'claude-fable-5-1');
  const shots = verify.sessions[0].report.screenshots;
  assert.equal(shots.length, 3);
  assert.equal(shots[0].url, `/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(shots[1].url, `/evidence/${fx.tasks.asked}/customers-empty-phone.png`);
  assert.equal(shots[2].url, null, 'a path outside .jv-evidence gets no URL');

  assert.equal(d.workflowDecisions.length, 1);
  assert.match(d.workflowDecisions[0].summary, /needs_plan no \(0\.18\), needs_docs no \(0\.07\)/);
  assert.equal(d.landings.length, 1);
  assert.equal(d.landings[0].route, 'ask-owner');
  assert.equal(d.landings[0].state, 'asked');
  assert.equal(d.landings[0].checks[0].passed, true);
  assert.equal(d.landings[0].decision.summary, 'ask-owner');
  assert.equal(d.landings[0].decision.answers[0].probabilities[0].option, 'ask-owner');
  assert.deepEqual(d.landingDecisions, [], 'a decision a landing row points at is shown with that landing only');
  assert.deepEqual(d.children.map((c: any) => c.id), [fx.tasks.child]);
  assert.equal(d.messages.length, 1);

  const child = served(taskDetail(db, fx.tasks.child, opts));
  assert.equal(child.parent.id, fx.tasks.asked);
  const queued = served(taskDetail(db, fx.tasks.queued, opts));
  assert.equal(queued.after.id, fx.tasks.asked);
  assert.equal(queued.steps.length, 3);

  assert.equal(taskDetail(db, 'T000000', opts), undefined);
});

test('the session page streams events oldest first, pages with after, and links report screenshots', async () => {
  const d = served(sessionPage(db, fx.sessions.live, 0, opts));
  assert.equal(d.session.runtime, 'claude-tmux');
  assert.equal(d.session.tmuxTarget, `jv-${fx.sessions.live}`);
  assert.equal(d.task.id, fx.tasks.running);
  assert.equal(d.step.duty, 'implement');
  const seqs = d.events.map((e: any) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
  assert.deepEqual(
    [...new Set(d.events.map((e: any) => e.kind))].sort(),
    ['message', 'rate-limit', 'start', 'text', 'thinking', 'tool-call', 'tool-result'].sort(),
  );
  assert.equal(d.lastSeq, seqs.at(-1));
  assert.equal(d.more, false);
  const later = served(sessionPage(db, fx.sessions.live, seqs.at(-3), opts));
  assert.deepEqual(later.events.map((e: any) => e.seq), seqs.slice(-2));

  const verify = served(sessionPage(db, fx.sessions.verify, 0, opts));
  const report = verify.events.find((e: any) => e.kind === 'report');
  assert.equal(report.payload.screenshots[0].url, `/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(report.payload.screenshots[2].url, null);
  const lost = served(sessionPage(db, fx.sessions.lost, 0, opts));
  assert.equal(lost.session.lost, true);
  assert.equal(sessionPage(db, 'R000000', 0, opts), undefined);
});

test('decisions filter by kind and by date', async () => {
  const all = served(decisions(db));
  assert.equal(all.total, 4);
  assert.deepEqual([...new Set(all.decisions.map((d: any) => d.kind))].sort(), ['landing', 'placement', 'workflow']);
  const newestFirst = all.decisions.map((d: any) => d.createdAt);
  assert.deepEqual(newestFirst, [...newestFirst].sort().reverse());
  const placement = served(decisions(db, { kind: 'placement' }));
  assert.equal(placement.total, 2);
  assert.ok(placement.decisions.every((d: any) => d.kind === 'placement' && d.task && d.step));
  assert.equal(placement.decisions.find((d: any) => d.id === fx.decisions.verify).task.title, 'Empty state on the customers page');
  const created = Date.parse(all.decisions.at(-1).createdAt);
  const today = new Date(created).toISOString().slice(0, 10);
  const tomorrow = new Date(created + 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(created - 86_400_000).toISOString().slice(0, 10);
  assert.equal(decisions(db, { from: today, to: today }).total, 4);
  assert.equal(decisions(db, { from: tomorrow }).total, 0);
  assert.equal(decisions(db, { to: yesterday }).total, 0);
  assert.equal(decisions(db, { kind: 'landing', from: today }).decisions[0]!.id, fx.decisions.landing);
  assert.equal(decisions(db, { kind: 'bogus' }).total, 4, 'an unknown kind is no filter');
  assert.equal(decisions(db, { task: fx.tasks.asked }).total, 4);
  assert.equal(decisions(db, { project: 'other' }).total, 0);
});

test('usage rows are grouped by ISO week, newest week first, with session totals', async () => {
  const d = served(usage(db));
  assert.ok(d.weeks.length >= 2);
  assert.equal(d.weeks[0].week, isoWeek(Date.now()));
  const thisWeek = d.weeks[0];
  const main = thisWeek.providers.find((p: any) => p.provider === 'claude-main');
  assert.equal(main.weeklyPct, 48, 'the newest observation of the week (a stream rate limit) wins');
  assert.ok(main.sources.probe >= 1 && main.sources.stream >= 1);
  assert.ok(main.sessions.count >= 2);
  const deepseek = thisWeek.providers.find((p: any) => p.provider === 'deepseek');
  assert.equal(deepseek.localInputTokens, 120400);
  const older = d.weeks.find((w: any) => w.week === isoWeek(Date.now() - 8 * 86_400_000));
  assert.ok(older.providers.some((p: any) => p.provider === 'claude-second' && p.weeklyPct === 76));
  assert.equal(isoWeek('2026-01-01T12:00:00Z'), '2026-W01');
  assert.equal(isoWeek('2026-11-01T12:00:00Z'), '2026-W44');
  assert.equal(isoWeek('2027-01-01T00:00:00Z'), '2026-W53');
});

test('evidence helpers: report screenshot URLs, plain path segments and image signatures', () => {
  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/a/b.png'), '/evidence/T1/a/b.png');
  assert.equal(evidenceUrl('T1', '/w', './.jv-evidence/a b.png'), '/evidence/T1/a%20b.png');
  assert.equal(evidenceUrl('T1', '/w', '/w/.jv-evidence/x.webp'), '/evidence/T1/x.webp');
  assert.equal(evidenceUrl('T1', '/w', '/w/other/x.png'), null);
  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/../x.png'), null);
  assert.equal(evidenceUrl('T1', '/w', '.jv-evidence/out.txt'), null);
  assert.equal(evidenceUrl('T1', null, '.jv-evidence/x.png'), null);
  assert.equal(evidenceSegments('a/%2e%2e/b.png'), undefined);
  assert.equal(evidenceSegments('a%2Fb.png'), undefined);
  assert.deepEqual(evidenceSegments('a/b%20c.png'), ['a', 'b c.png']);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('hello world, not an image')), undefined);
});

test('the read-only connection refuses writes, and the views show lost rows without marking them', () => {
  const reader = new ReadOnlyStore(store.file);
  assert.throws(() => reader.all("UPDATE tasks SET title = 'x'"), /readonly/);
  reader.close();
  overview(db, opts);
  sessionPage(db, fx.sessions.lost, 0, opts);
  assert.equal(store.getSession(fx.sessions.lost)!.state, 'running', 'the views show the dot but never write lost');
  const missing = new ReadOnlyStore(join(home, 'no-store-here.sqlite'));
  assert.throws(() => missing.all('SELECT 1'), /no store yet/);
  assert.match(missing.dataVersion(), /^unavailable/);
});

test('a secret that reached the store by mistake is masked in what is served', () => {
  // Writers redact; this writes around them on purpose to check the viewer's own redaction.
  store.appendEvent(fx.sessions.investigate, 'text', { text: `leaked ${FAKE_TOKEN} here` });
  const body = JSON.stringify(served(sessionPage(db, fx.sessions.investigate, 0, opts)));
  assert.ok(!body.includes(FAKE_TOKEN));
  assert.match(body, /leaked \[redacted\] here/);
});

test('the Markdown renderer escapes HTML and links only http(s), site paths and anchors', () => {
  const { renderMarkdown, renderInline } = markdown;
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderInline('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(renderInline('[x](javascript:alert(1))'), 'x');
  assert.equal(renderInline('[x](data:text/html,hi)'), 'x');
  assert.equal(renderInline('[t](/task/T1)'), '<a href="/task/T1">t</a>');
  assert.equal(renderInline('[t](https://a.example/?a=1&b="2")'), '<a href="https://a.example/?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener noreferrer">t</a>');
  assert.equal(renderInline('`<b>`'), '<code>&lt;b&gt;</code>');
  assert.equal(renderInline('**bold** and *it* and snake_case_name'), '<strong>bold</strong> and <em>it</em> and snake_case_name');
  assert.equal(renderMarkdown('```\n<x>&\n```'), '<pre><code>&lt;x&gt;&amp;</code></pre>');
  assert.equal(renderMarkdown('# Title\n\n- a\n- b\n  - c'), '<h3>Title</h3><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>');
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| <i>1</i> | 2 |'), /<td>&lt;i&gt;1&lt;\/i&gt;<\/td>/);
  assert.equal(renderMarkdown('![alt](https://img.example/x.png)'), '<p><a href="https://img.example/x.png" target="_blank" rel="noopener noreferrer">alt</a></p>');
  // Whatever the input, the output holds only the renderer's own tags, and no tag carries an event handler.
  const allowed = /^<\/?(p|a|code|pre|strong|em|del|ul|ol|li|h[3-6]|blockquote|hr|br|table|thead|tbody|tr|th|td|div)(\s|>|\/)/i;
  const nasty = ['<a href="x" onclick="y">', '[a](https://x" onmouseover="y)', '<svg/onload=alert(1)>', '`` ` ``<iframe>', '> <script>', '**<b onmouseover=1>**', '[<img src=x>](https://a.example)'];
  for (const n of nasty) {
    for (const tag of renderMarkdown(n).match(/<[^>]*>/g) ?? []) {
      assert.match(tag, allowed, `${n} gave ${tag}`);
      assert.doesNotMatch(tag, /\son\w+\s*=/i, `${n} gave ${tag}`);
    }
  }
});

test('page text helpers: 24-hour clock everywhere, no dash for unknown rate limits, jv tool results, hidden note', () => {
  // Dates said "02:53 PM" while the event clocks said "14:53:05" on the same page.
  for (const f of [format.dateFmt, format.fullFmt, format.clockFmt]) assert.equal(f.resolvedOptions().hourCycle, 'h23');
  // A stream rate-limit event without a five-hour value read "five hours -, week 63%".
  const day = (iso: string) => `D(${iso})`;
  assert.deepEqual(format.rateLimitParts({ weeklyPct: 63, weeklyResetsAt: '2026-11-02T05:00:00.000Z' }, day), ['week 63%', 'week resets D(2026-11-02T05:00:00.000Z)']);
  assert.deepEqual(format.rateLimitParts({ fiveHourPct: 14.4, weeklyPct: 48 }, day), ['five hours 14%', 'week 48%']);
  assert.deepEqual(format.rateLimitParts({}, day), []);
  assert.equal(format.providerUsageNote({ weeklyPct: 63.2, ceilingPct: 90, fiveHourPct: null }), 'week 63% of 90%');
  assert.equal(format.providerUsageNote({ weeklyPct: 41, ceilingPct: 90, fiveHourPct: 12 }), 'week 41% of 90%, five hours 12%');
  assert.equal(format.providerUsageNote({ weeklyPct: null, ceilingPct: null }), 'week unknown');
  // The worktree setup result has no tool call; it showed as a bare "result" row with an empty body.
  const setup = format.toolResultView({ name: 'worktree-setup', command: 'npm ci', ok: true, exitCode: 0, timedOut: false, durationMs: 2046, text: 'Worktree setup: npm ci ok.' });
  assert.equal(setup.name, 'worktree-setup');
  assert.equal(setup.command, 'npm ci');
  assert.equal(setup.detail, '$ npm ci\nWorktree setup: npm ci ok.\nexit code 0, 2.0s');
  assert.equal(setup.failed, false);
  const failed = format.toolResultView({ name: 'worktree-setup', command: 'npm ci', ok: false, exitCode: 1, timedOut: true, text: 'Worktree setup: npm ci failed.' });
  assert.equal(failed.failed, true);
  assert.match(failed.detail, /exit code 1, timed out$/);
  // A result whose call is not in the stream keeps the old shape.
  assert.deepEqual(format.toolResultView({ id: 'x', ok: true, output: 'done' }), { name: 'result', command: undefined, body: 'done', detail: 'done', failed: false });
  // A task stopped a minute ago is hidden too, so the note does not call every hidden task "older".
  assert.equal(format.hiddenNote(0), '');
  assert.equal(format.hiddenNote(1), '1 task not shown (stopped, or ended more than a day ago)');
  assert.equal(format.hiddenNote(3), '3 tasks not shown (stopped, or ended more than a day ago)');
});

test('currentStep: running or retrying first, then tasks.current_step, then the first pending', () => {
  const s = (ordinal: number, state: string) => ({ id: `S${ordinal}`, ordinal, state }) as any;
  assert.equal(currentStep({ current_step: 1 }, [s(1, 'done'), s(2, 'retrying'), s(3, 'pending')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 3 }, [s(1, 'done'), s(2, 'done'), s(3, 'pending')])!.id, 'S3');
  assert.equal(currentStep({ current_step: 0 }, [s(1, 'done'), s(2, 'pending')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 0 }, [s(1, 'done'), s(2, 'done')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 3 }, [s(1, 'done'), s(2, 'done'), s(3, 'skipped')])!.id, 'S2');
  assert.equal(currentStep({ current_step: 0 }, []), undefined);
});
