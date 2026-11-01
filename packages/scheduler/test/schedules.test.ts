// Schedules on a temporary store (brief section 9): add and its refusals, due, fire (request id per slot, the title's
// local date, late catch-up once, quiet hours, errors), run now, pause and resume, job schedules, the view.

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-schedules-test-'));
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { JvError } = await import('jevellan-core/errors');
const S = await import('../src/schedules.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
store.createProject({ name: 'sandbox', path: join(home, 'repo'), default_branch: 'main' });

type Call = { requestId?: string; title: string; origin?: string; project: string; kind: string; duty?: string };
const calls: Call[] = [];
const byRequest = new Map<string, string>();
const deps = {
  createTask: async (_s: unknown, input: Call) => {
    calls.push(input);
    const known = byRequest.get(input.requestId!);
    if (known) return { task: { id: known } };
    const id = `T${String(calls.length).padStart(6, '0')}`;
    byRequest.set(input.requestId!, id);
    return { task: { id } };
  },
};

const NOW = new Date('2026-11-02T12:00:00Z');
const task = { kind: 'single' as const, duty: 'verify', title: 'Nightly tests', text: 'Run the tests. Report testsRun.' };

describe('add', () => {
  test('validates the cron, the zone and the spec; computes the next run', () => {
    const s = S.addSchedule(store, { project: 'sandbox', name: 'Nightly tests', cron: '0 3 * * *', tz: 'Europe/Lisbon', kind: 'task', task }, NOW);
    assert.match(s.id, /^C[0-9A-Z]{6}$/);
    assert.equal(s.next_run_at, '2026-11-03T03:00:00.000Z');
    assert.deepEqual(JSON.parse(s.spec_json), { ...task, visible: false });
    const refused = (input: object, why: RegExp) =>
      assert.throws(() => S.addSchedule(store, { project: 'sandbox', name: `x${Math.random()}`, kind: 'task', task, cron: '0 3 * * *', ...input } as never, NOW), (e: unknown) => e instanceof JvError && why.test(e.message));
    refused({ cron: '0 3 * *' }, /five fields/);
    refused({ cron: '0 0 30 2 *' }, /never fires/);
    refused({ tz: 'Mars/Olympus' }, /IANA time zone/);
    refused({ task: { ...task, duty: undefined } }, /needs --duty/);
    refused({ task: { ...task, title: 'x'.repeat(110) } }, /longer than 109/);
    refused({ kind: 'job', job: 'nap' }, /--job is one of/);
    assert.throws(() => S.addSchedule(store, { project: 'sandbox', name: 'Nightly tests', cron: '0 4 * * *', kind: 'task', task }, NOW), (e: unknown) => e instanceof JvError && e.exitCode === 4, 'one name per project');
    assert.throws(() => S.addSchedule(store, { project: 'nope', name: 'n', cron: '0 4 * * *', kind: 'task', task }, NOW), (e: unknown) => e instanceof JvError && e.exitCode === 3);
    assert.equal(S.addSchedule(store, { project: 'sandbox', name: 'local zone', cron: '0 4 * * *', kind: 'job', job: 'plan' }, NOW).tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('fire', () => {
  test('a due task schedule creates its task with the slot request id, origin and dated title, then moves on', async () => {
    const s = S.requireSchedule(store, 'Nightly tests', 'sandbox');
    assert.deepEqual(S.due(store, NOW).map((x) => x.id).includes(s.id), false);
    const at = new Date('2026-11-03T03:00:10Z');
    assert.ok(S.due(store, at).some((x) => x.id === s.id));
    const r = await S.fire(store, s, at, { deps });
    assert.equal(r.result, `created ${r.task}`);
    const call = calls.at(-1)!;
    assert.deepEqual([call.requestId, call.origin, call.title, call.project, call.duty], [`schedule:${s.id}:2026-11-03T03:00:00.000Z`, `schedule:${s.id}`, 'Nightly tests 2026-11-03', 'sandbox', 'verify']);
    assert.equal(r.schedule.next_run_at, '2026-11-04T03:00:00.000Z');
    assert.equal(r.schedule.last_run_at, at.toISOString());
    assert.equal(r.schedule.last_result, `created ${r.task}`);
    // The same slot fired again (a tick that ran twice) asks for the same request id: nothing is created twice.
    const again = await S.fire(store, s, at, { deps });
    assert.equal(again.task, r.task);
  });

  test('a slot missed while the bot was down fires once, late, and the next run is from now', async () => {
    const s = S.requireSchedule(store, 'Nightly tests', 'sandbox');
    const late = new Date('2026-11-06T09:15:00Z');
    const r = await S.fire(store, store.getSchedule(s.id)!, late, { deps });
    assert.equal(r.late, true);
    assert.match(r.result, /^created T\d+ \(fired late \(missed 03:00\)\)$/);
    assert.equal(r.schedule.next_run_at, '2026-11-07T03:00:00.000Z', 'one catch-up, not one per missed slot');
    assert.equal(calls.at(-1)!.requestId, `schedule:${s.id}:2026-11-04T03:00:00.000Z`);
  });

  test('quiet hours skip the slot; an error is recorded and the schedule still moves on', async () => {
    const s = store.getSchedule(S.requireSchedule(store, 'Nightly tests', 'sandbox').id)!;
    const n = calls.length;
    const q = await S.fire(store, s, new Date('2026-11-07T03:00:05Z'), { quiet: true, deps });
    assert.equal(q.result, 'skipped: quiet hours');
    assert.equal(calls.length, n);
    assert.equal(q.schedule.next_run_at, '2026-11-08T03:00:00.000Z');
    const e = await S.fire(store, q.schedule, new Date('2026-11-08T03:00:05Z'), { deps: { createTask: async () => { throw new JvError('no slot'); } } });
    assert.equal(e.result, 'error: no slot');
    assert.equal(e.schedule.next_run_at, '2026-11-09T03:00:00.000Z');
  });

  test('a job schedule queues one job per slot', async () => {
    const s = S.addSchedule(store, { project: 'sandbox', name: 'Plan', cron: '30 3 * * *', tz: 'UTC', kind: 'job', job: 'plan' }, NOW);
    const at = new Date('2026-11-03T03:30:00Z');
    const r = await S.fire(store, s, at, { deps });
    assert.match(r.job!, /^J[0-9A-Z]{6}$/);
    const job = store.getJob(r.job!)!;
    assert.deepEqual([job.kind, job.state, job.request_id], ['plan', 'queued', `schedule:${s.id}:2026-11-03T03:30:00.000Z`]);
    const twice = await S.fire(store, s, at, { deps });
    assert.equal(twice.job, r.job, 'the same slot is the same job');
  });

  test('run now fires without moving next_run_at; pause and resume flip enabled and recompute the next run', async () => {
    const s = store.getSchedule(S.requireSchedule(store, 'Nightly tests', 'sandbox').id)!;
    const r = await S.runNow(store, s, new Date('2026-11-08T10:00:00Z'), deps);
    assert.match(r.result, /^created T\d+ \(run now\)$/);
    assert.equal(r.schedule.next_run_at, s.next_run_at);
    assert.equal(calls.at(-1)!.title, 'Nightly tests 2026-11-08');
    const p = S.pause(store, r.schedule);
    assert.equal(p.enabled, 0);
    assert.ok(!S.due(store, new Date('2027-01-01T00:00:00Z')).some((x) => x.id === s.id), 'a paused schedule is never due');
    const back = S.resume(store, p, new Date('2026-12-01T12:00:00Z'));
    assert.equal(back.enabled, 1);
    assert.equal(back.next_run_at, '2026-12-02T03:00:00.000Z');
    const view = S.scheduleView(store, back, new Date('2026-12-01T12:00:00Z'));
    assert.deepEqual(view.nextRuns, ['2026-12-02T03:00:00.000Z', '2026-12-03T03:00:00.000Z', '2026-12-04T03:00:00.000Z']);
    assert.equal(view.project, 'sandbox');
  });
  test('run now counts a task Jev refused to start as created and reports the refusal; any other error is the run result', async () => {
    const s = store.getSchedule(S.requireSchedule(store, 'Nightly tests', 'sandbox').id)!;
    const heard: string[] = [];
    const refusing = S.runNowCreator((m) => heard.push(m), async () => {
      throw new JvError('Jev refused to start T000099: no slot', 2, { taskId: 'T000099' });
    });
    const r = await S.runNow(store, s, new Date('2026-11-09T10:00:00Z'), { createTask: refusing });
    assert.equal(r.result, 'created T000099 (run now)');
    assert.deepEqual(heard, ['Jev refused to start T000099: no slot']);
    const failing = S.runNowCreator(undefined, async () => {
      throw new JvError('no project sandbox', 3);
    });
    const failed = await S.runNow(store, s, new Date('2026-11-09T11:00:00Z'), { createTask: failing });
    assert.equal(failed.result, 'error: no project sandbox');
    assert.equal(failed.task, undefined);
  });
});
