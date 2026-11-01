// The text of jv status (brief section 4) and the bot line (section 8): the block for a fixture store at a fixed
// time in a fixed local zone (projects, every group, a needs-decision with options, a landing ask, a failed step, a
// lost run, a landing task, a queued task after another and one waiting for a slot, landed and failed lists), the
// 100 character cap, local times with a date only when not today, the providers.json label, the bot line alive and
// not running (heartbeat rows written here, as the bot writes them), and the `bot` key of the JSON view.

// Local times are part of the text: pin a zone without daylight saving and away from UTC, before any Date is made.
process.env.TZ = 'Asia/Kolkata';

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-status-format-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const S = await import('../src/status.js');
const B = await import('../src/bot-state.js');
const { loadProviders } = await import('../src/providers.js');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

// 12:45 UTC is 18:15 in Kolkata on 1 November 2026.
const NOW = Date.parse('2026-11-01T12:45:00.000Z');
const at = (iso: string) => new Date(iso).toISOString();

function set(table: 'tasks' | 'sessions' | 'reports' | 'landings', id: string, fields: Record<string, string | number | null>): void {
  const keys = Object.keys(fields);
  store.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]!), id);
}

let n = 0;
interface Made {
  id: string;
  steps: string[];
}
function task(projectId: string, title: string, duties: string[], createdAt: string, extra: { after?: string } = {}): Made {
  n++;
  const t = store.createTask({
    project_id: projectId,
    request_id: `fmt-${n}`,
    kind: 'feature',
    title,
    task_text: 'x',
    workflow_json: '{}',
    ...(extra.after ? { after_task_id: extra.after } : {}),
  }).row;
  const steps = duties.map((duty, i) => store.createStep({ task_id: t.id, ordinal: i + 1, duty }).row.id);
  set('tasks', t.id, { created_at: at(createdAt) });
  return { id: t.id, steps };
}
function run(projectId: string, made: Made, ordinal: number, provider = 'claude-main', model = 'model-strong', effort = 'high'): string {
  n++;
  return store.createSession({
    project_id: projectId,
    task_id: made.id,
    step_id: made.steps[ordinal - 1]!,
    request_id: `fmt-run-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider,
    model,
    effort,
    cwd: '/tmp',
  }).row.id;
}

const ekoa = store.createProject({ name: 'ekoa-code', path: '/Users/owner/dev/ekoa-code', default_branch: 'main' }).row;
store.createProject({ name: 'quiet', path: '/Users/owner/dev/quiet', default_branch: 'main' });
const P = ekoa.id;

// waiting on you: a needs-decision with options (step 3 of 4), a landing ask, a failed step with no question
const decide = task(P, 'Customers empty state', ['plan', 'implement', 'verify', 'document'], '2026-11-01T05:00:00Z');
const decideRun = run(P, decide, 3);
store.setSessionState(decideRun, 'running', 'turn running');
writeReport(store, decideRun, { status: 'needs-decision', summary: 'Two ways to show it.', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] });
store.setSessionState(decideRun, 'done', 'turn ended: report needs-decision');
store.setTaskState(decide.id, 'waiting-owner', 'the step asks: Which colour?', { current_step: 3 });
set('sessions', decideRun, { last_event_at: at('2026-11-01T07:11:00Z') });
set('reports', store.getReportBySession(decideRun)!.id, { created_at: at('2026-11-01T07:11:00Z') });

const ask = task(P, 'Billing totals', ['implement'], '2026-11-01T04:00:00Z');
const askRun = run(P, ask, 1);
store.setSessionState(askRun, 'done', 'turn ended: report done');
set('sessions', askRun, { last_event_at: at('2026-11-01T06:40:00Z') });
const landing = store.createLanding({ task_id: ask.id, route: 'ask-owner', state: 'asked', reason: 'Touches money.' });
set('landings', landing.id, { created_at: at('2026-11-01T06:50:00Z') });
store.setTaskState(ask.id, 'waiting-owner', 'landing asks the owner', { current_step: 1 });

const failedStep = task(P, 'Search box', ['implement', 'verify'], '2026-11-01T03:00:00Z');
const failedStepRun = run(P, failedStep, 2);
store.setSessionState(failedStepRun, 'failed', 'tests failed');
set('sessions', failedStepRun, { last_event_at: at('2026-11-01T05:00:00Z') });
store.setTaskState(failedStep.id, 'waiting-owner', 'step 2 (verify) failed: tests failed', { current_step: 2 });

// running: a live run, a lost run, a run on another provider with a 120 character title; and a task that is landing
const running = task(P, 'README how-to-run', ['implement', 'verify'], '2026-11-01T06:00:00Z');
const runningRun = run(P, running, 1);
store.setSessionState(runningRun, 'running', 'turn running');
set('sessions', runningRun, { started_at: at('2026-11-01T07:09:00Z'), last_event_at: at('2026-11-01T07:20:00Z') });
store.setTaskState(running.id, 'running', 'step 1 running', { current_step: 1 });

const lost = task(P, 'Fix flaky login test', ['implement'], '2026-11-01T05:30:00Z');
const lostRun = run(P, lost, 1);
store.setSessionState(lostRun, 'running', 'turn running', { pid: 999999 });
set('sessions', lostRun, { last_event_at: at('2026-11-01T06:00:00Z') });
store.setTaskState(lost.id, 'running', 'step 1 running', { current_step: 1 });

const LONG_TITLE = `Rework the import of contacts from CSV files so that ${'every row error is reported '.repeat(3)}`.slice(0, 120);
const long = task(P, LONG_TITLE, ['implement'], '2026-11-01T06:30:00Z');
const longRun = run(P, long, 1, 'glm', 'glm-big', 'high');
store.setSessionState(longRun, 'running', 'turn running');
set('sessions', longRun, { started_at: at('2026-11-01T07:15:00Z'), last_event_at: at('2026-11-01T07:30:00Z') });
store.setTaskState(long.id, 'running', 'step 1 running', { current_step: 1 });

const landingTask = task(P, 'Pricing page', ['implement', 'verify'], '2026-11-01T02:00:00Z');
const landingRun = run(P, landingTask, 2);
store.setSessionState(landingRun, 'done', 'turn ended: report done');
set('sessions', landingRun, { last_event_at: at('2026-11-01T08:00:00Z') });
store.setTaskState(landingTask.id, 'landing', 'deciding the landing route', { current_step: 2 });

// queued: after the running task, and one waiting for a slot
const queuedAfter = task(P, 'Unit test for slugify', ['implement'], '2026-11-01T06:10:00Z', { after: running.id });
store.setTaskState(queuedAfter.id, 'queued', `waiting for ${running.id} (README how-to-run) to finish`);
const queuedSlot = task(P, 'Docs for the CLI', ['document'], '2026-11-01T06:20:00Z');
store.setTaskState(queuedSlot.id, 'queued', 'waiting for a slot');

// landed today (12:02 and 00:30 local), done yesterday (local) within 24 h, failed yesterday, stopped today, failed long ago
function ended(title: string, state: 'done' | 'failed' | 'stopped', endedAt: string): string {
  const t = task(P, title, ['implement'], '2026-10-30T01:00:00Z');
  store.setTaskState(t.id, state, `${state} for the test`, { current_step: 1, ...(state === 'done' ? { landed_commit: 'abc123' } : {}) });
  set('tasks', t.id, { ended_at: at(endedAt) });
  return t.id;
}
const landed = ended('Landed one', 'done', '2026-11-01T06:32:00Z');
ended('Landed early', 'done', '2026-10-31T19:00:00Z');
ended('Done yesterday', 'done', '2026-10-31T17:30:00Z');
const failed = ended('Failed one', 'failed', '2026-10-31T17:00:00Z');
const stopped = ended('Stopped one', 'stopped', '2026-11-01T08:00:00Z');
ended('Failed long ago', 'failed', '2026-10-30T10:00:00Z');

// The bot: alive, with a heartbeat 4 s old.
B.writeBotHeartbeat(store, { pid: process.pid, startedAt: at('2026-11-01T10:00:00Z'), tick: 7, at: at('2026-11-01T12:44:56Z') });

const line = (id: string, titleField: string, rest: string) => `    ${id}  ${titleField}  ${rest}`;

describe('jv status text', () => {
  const view = S.statusView(store, { now: NOW });
  const text = S.formatStatus(store, view, { now: NOW });
  const lines = text.split('\n');

  test('the block: bot line, projects with their path, the three groups, landed and failed', () => {
    const expected = [
      `bot: alive 4 s ago (pid ${process.pid}) · running 3/4 · queued 2`,
      'ekoa-code (/Users/owner/dev/ekoa-code)',
      '  waiting on you',
      // oldest wait first; columns aligned within the group, whose title column narrows until every line fits in
      // 100 characters (never below 10)
      line(failedStep.id, 'Search box', `${'step 2/2 verify'.padEnd(18)}  step 2 (verify) failed: tests failed  ${failedStepRun}  10:30`),
      line(ask.id, 'Billing...', `step 1/1 implement  ask-owner  ${askRun}  12:20  options: Land now | Leave it`),
      line(decide.id, 'Custome...', `${'step 3/4 verify'.padEnd(18)}  needs-decision  ${decideRun}  12:41  options: Blue | Green`),
      '  running',
      // the lost line needs the title column at 21; a landing task with no live run shows its reason
      line(lost.id, 'Fix flaky login test'.padEnd(21), `step 1/1 implement  LOST: jv task resume ${lost.id}  ${lostRun}  11:30`),
      line(running.id, 'README how-to-run'.padEnd(21), `step 1/2 implement  Strong high via claude-main  ${runningRun}  12:39`),
      line(long.id, 'Rework the import...'.padEnd(21), `step 1/1 implement  Big high via glm  ${longRun}  12:45`),
      line(landingTask.id, 'Pricing page'.padEnd(21), `${'step 2/2 verify'.padEnd(18)}  deciding the landing route`),
      '  queued',
      // no step column: the reason takes its place, as in the brief's block
      line(queuedAfter.id, 'Unit test for slugify', `after ${running.id}`),
      line(queuedSlot.id, 'Docs for the CLI'.padEnd(21), 'waiting for a slot'),
      // newest first; landed ids give way to keep the line within 100 characters
      `  landed today: ${landed} (12:02), +1 more   failed: ${stopped} (13:30), ${failed} (2026-10-31 22:30)`,
      'quiet (/Users/owner/dev/quiet)',
      '  landed today: none   failed: none',
    ];
    assert.deepEqual(lines, expected);
  });

  test('no line is longer than 100 characters', () => {
    for (const l of lines) assert.ok([...l].length <= S.STATUS_LINE_MAX, `${[...l].length}: ${l}`);
    assert.equal(S.STATUS_LINE_MAX, 100);
  });

  test('the JSON keys stay the lifted ones, plus bot', () => {
    assert.deepEqual(Object.keys(view), ['tasks', 'sessions', 'recent', 'lost', 'bot']);
    assert.deepEqual(Object.keys(view.tasks[0]!).sort(), ['id', 'project', 'title', 'kind', 'state', 'state_reason', 'step', 'run', 'lost', 'report', 'updatedAt'].sort());
    assert.deepEqual(view.lost, [lostRun]);
    assert.equal(view.bot.alive, true);
    assert.equal(view.bot.pid, process.pid);
    assert.equal(view.bot.heartbeatAgeSeconds, 4);
    assert.equal(view.bot.tick, 7);
    assert.equal(view.bot.startedAt, at('2026-11-01T10:00:00Z'));
    assert.equal(view.bot.running, 3, 'three tasks in state running, the lost one included (M-013)');
    assert.equal(view.bot.queued, 2);
    assert.deepEqual(view.bot.limits, { perProject: 2, total: 4 });
  });

  test('--project prints that project only; the bot line stays the machine\'s', () => {
    const v = S.statusView(store, { project: 'quiet', now: NOW, markLost: false });
    assert.deepEqual(S.formatStatus(store, v, { now: NOW, project: 'quiet' }).split('\n'), [
      `bot: alive 4 s ago (pid ${process.pid}) · running 3/4 · queued 2`,
      'quiet (/Users/owner/dev/quiet)',
      '  landed today: none   failed: none',
    ]);
    assert.deepEqual(v.tasks, []);
  });

  test('without providers.json the model id stands in for its label', () => {
    const t = S.formatStatus(store, view, { now: NOW, providers: null });
    assert.match(t, new RegExp(`model-strong high via claude-main  ${runningRun}  12:39`));
    const labelled = S.formatStatus(store, view, { now: NOW, providers: loadProviders() });
    assert.equal(labelled, text);
  });
});

describe('the bot line', () => {
  const state = (now = NOW) => B.readBotState(store, now);

  test('alive: "bot: alive N s ago (pid P) · running r/total · queued q"', () => {
    assert.equal(B.botLine(state(), NOW), `bot: alive 4 s ago (pid ${process.pid}) · running 3/4 · queued 2`);
  });

  test('a stale heartbeat (60 s at the default 15 s tick) reads not running', () => {
    const s = state(NOW + 56_000);
    assert.equal(s.heartbeatAgeSeconds, 60);
    assert.equal(s.alive, false);
    assert.equal(B.botLine(s, NOW + 56_000), 'bot: not running');
    assert.equal(state(NOW + 55_000).alive, true);
  });

  test('bot.json tickSeconds widens the window to 3 ticks; limits come from bot.json', () => {
    writeFileSync(join(home, 'bot.json'), JSON.stringify({ tickSeconds: 100, limits: { perProject: 1, total: 3 } }));
    try {
      const s = state(NOW + 246_000);
      assert.equal(s.alive, true);
      assert.equal(B.botLine(s, NOW + 246_000), `bot: alive 4 min ago (pid ${process.pid}) · running 3/3 · queued 2`);
      assert.equal(state(NOW + 296_000).alive, false);
    } finally {
      rmSync(join(home, 'bot.json'));
    }
  });

  test('a pid that is gone reads not running however fresh the heartbeat', () => {
    store.setMeta(B.BOT_META.pid, '999999');
    try {
      assert.equal(state().alive, false);
      assert.equal(B.botLine(state(), NOW), 'bot: not running');
    } finally {
      store.setMeta(B.BOT_META.pid, String(process.pid));
    }
  });

  test('a store the bot never ran on, with no project yet', () => {
    const fresh = openStore({ file: join(home, 'fresh.sqlite') });
    try {
      const s = B.readBotState(fresh, NOW);
      assert.deepEqual(s, { alive: false, pid: null, heartbeatAt: null, heartbeatAgeSeconds: null, startedAt: null, tick: null, running: 0, queued: 0, limits: { perProject: 2, total: 4 } });
      assert.equal(B.botLine(s, NOW), 'bot: not running');
      assert.equal(S.formatStatus(fresh, S.statusView(fresh, { now: NOW }), { now: NOW }), 'bot: not running\nNo projects yet: jv project add <path>');
    } finally {
      fresh.close();
    }
  });
});

describe('local times', () => {
  test('HH:MM today, the date in front otherwise', () => {
    assert.equal(S.clockTime('2026-11-01T07:11:00Z', NOW), '12:41');
    assert.equal(S.clockTime('2026-10-31T18:29:00Z', NOW), '2026-10-31 23:59');
    assert.equal(S.clockTime('2026-10-31T18:30:00Z', NOW), '00:00');
    assert.equal(S.clockTime(null, NOW), undefined);
    assert.equal(S.clockTime('not a time', NOW), undefined);
  });
});
