// The jobs machinery (brief sections 9 and 10, M-017) with a fake handler and a fake createTask: one job per request
// id, "already running", the work task's origin, request id and start: false, a work task that cannot be created,
// finish on done with the work step's report (not a landing verify step's), failure on failed or stopped, waiting
// with a task that waits on the owner, cancel only when queued, the view and its text.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-jobs-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const J = await import('../src/jobs.js');
const { JvError } = await import('../src/errors.js');
type Handler = import('../src/jobs.js').JobHandler;

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
const project = store.createProject({ name: 'sandbox', path: '/tmp/sandbox', default_branch: 'main' }).row;

const finished: string[] = [];
const handler: Handler = {
  kind: 'improve-docs',
  duty: 'document',
  origin: 'improver',
  requestId: (p, now) => `improve-docs:${p.name}:${J.isoWeek(now)}`,
  workTask: () => ({ title: 'Update the docs', text: 'Bring the README up to date.', input: { landed: [] } }),
  finish: (_s, job, report) => {
    finished.push(job.id);
    if (report?.summary === 'explode') throw new Error('the block is not valid');
    return { summary: 'done by the fake', changed: 1 };
  },
};

let n = 0;
let failCreate: string | undefined;
const createdTasks: Array<{ requestId?: string; origin?: string; duty?: string; kind: string; start?: boolean }> = [];
const deps = {
  now: () => new Date('2026-11-04T10:00:00Z'),
  createTask: async (s: typeof store, input: { requestId?: string; origin?: string; duty?: string; kind: string; title: string; text: string; start?: boolean }) => {
    if (failCreate) throw new JvError(failCreate, 2);
    createdTasks.push(input);
    const t = s.createTask({ project_id: project.id, request_id: input.requestId ?? `x${++n}`, kind: 'single', title: input.title, task_text: input.text, workflow_json: '{"steps":[]}', origin: input.origin ?? 'owner' }).row;
    s.createStep({ task_id: t.id, ordinal: 1, duty: input.duty ?? 'answer' });
    return { task: t };
  },
};

/** A report of the task's step `ordinal` (the work step is 1; a verify-then-land landing appends a verify step). */
function report(taskId: string, ordinal: number, summary: string): void {
  const step = store.listSteps(taskId).find((s) => s.ordinal === ordinal)!;
  const run = store.createSession({ project_id: project.id, task_id: taskId, step_id: step.id, request_id: `s-${taskId}-${ordinal}-${summary.length}`, kind: 'step', runtime: 'llm', provider: 'p', model: 'm', effort: 'low', cwd: '/tmp' }).row;
  store.createReport({ session_id: run.id, step_id: step.id, task_id: taskId, status: 'done', summary });
}

describe('jobs', () => {
  test('one job per request id; a second kind run while one is open is refused; --force makes another', () => {
    const a = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs' }, deps);
    assert.equal(a.created, true);
    assert.equal(a.job.request_id, 'improve-docs:sandbox:2026-W45');
    const again = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs' }, deps);
    assert.deepEqual([again.created, again.job.id], [false, a.job.id], 'same week, same job');
    assert.throws(() => J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs', force: true }, deps), (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message === `already running: ${a.job.id}`);
    assert.throws(() => J.createJob(store, [handler], { project: 'sandbox', kind: 'plan' }, deps), /no handler for job kind plan/);
    assert.throws(() => J.createJob(store, [handler], { project: 'sandbox', kind: 'nap' }, deps), /job kind is one of/);
    assert.throws(() => J.createJob(store, [handler], { project: 'nope', kind: 'improve-docs' }, deps), (e: unknown) => e instanceof JvError && e.exitCode === 3);
  });

  test('step: a queued job gets its single work task with origin and request id; a done task finishes it', async () => {
    const job = store.listJobs({ kind: 'improve-docs' })[0]!;
    const s1 = await J.stepJobs(store, [handler], deps);
    assert.equal(s1.started.length, 1);
    const running = store.getJob(job.id)!;
    assert.equal(running.state, 'running');
    assert.deepEqual(createdTasks.at(-1), { project: 'sandbox', kind: 'single', duty: 'document', title: 'Update the docs', text: 'Bring the README up to date.', visible: false, requestId: `job:${job.id}`, origin: `improver:${job.id}`, start: false });
    assert.deepEqual(JSON.parse(running.input_json), { landed: [] });
    // Nothing changes while the task runs or waits on the owner.
    store.setTaskState(running.task_id!, 'waiting-owner', 'needs a decision');
    assert.deepEqual((await J.stepJobs(store, [handler], deps)).finished, []);
    store.setTaskState(running.task_id!, 'done', 'landed');
    const s3 = await J.stepJobs(store, [handler], deps);
    assert.deepEqual(s3.finished, [{ job: job.id, state: 'done', reason: 'done by the fake' }]);
    const done = store.getJob(job.id)!;
    assert.equal(done.state, 'done');
    assert.ok(done.ended_at);
    assert.deepEqual(JSON.parse(done.result_json!), { summary: 'done by the fake', changed: 1 });
    const view = J.jobView(store, done);
    assert.equal(view.project, 'sandbox');
    assert.equal(view.taskState, 'done');
    assert.equal(typeof view.durationMs, 'number');
  });

  test('a failed or stopped task fails the job with its reason; a finish that throws fails it with the message', async () => {
    const a = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs', force: true }, deps).job;
    await J.stepJobs(store, [handler], deps);
    store.setTaskState(store.getJob(a.id)!.task_id!, 'stopped', 'discarded by the owner');
    await J.stepJobs(store, [handler], deps);
    assert.deepEqual([store.getJob(a.id)!.state, store.getJob(a.id)!.state_reason], ['failed', 'discarded by the owner']);

    const b = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs', force: true, requestId: 'improve-docs:sandbox:explode' }, deps).job;
    await J.stepJobs(store, [handler], deps);
    const taskId = store.getJob(b.id)!.task_id!;
    report(taskId, 1, 'explode');
    store.setTaskState(taskId, 'done', 'landed');
    await J.stepJobs(store, [handler], deps);
    assert.deepEqual([store.getJob(b.id)!.state, store.getJob(b.id)!.state_reason], ['failed', 'the block is not valid']);
  });

  test('finish reads the work step\'s report, not the report of a verify step a landing appended after it', async () => {
    const reports: Array<string | undefined> = [];
    const reading: Handler = { ...handler, finish: (_s, _job, r) => (reports.push(r?.summary), { summary: 'read' }) };
    const j = J.createJob(store, [reading], { project: 'sandbox', kind: 'improve-docs', force: true, requestId: 'improve-docs:sandbox:verify' }, deps).job;
    await J.stepJobs(store, [reading], deps);
    const taskId = store.getJob(j.id)!.task_id!;
    report(taskId, 1, 'the work, with its json block');
    store.createStep({ task_id: taskId, ordinal: 2, duty: 'verify' });
    report(taskId, 2, 'verified before landing');
    store.setTaskState(taskId, 'done', 'landed');
    await J.stepJobs(store, [reading], deps);
    assert.deepEqual(reports, ['the work, with its json block']);
    assert.equal(J.workReport(store, taskId, 'document')?.summary, 'the work, with its json block');
    assert.equal(J.workReport(store, taskId, 'plan'), undefined, 'no step of that duty, no report');
  });

  test('a work task that cannot be created keeps the job queued with the reason, and the next pass makes it', async () => {
    const q = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs', force: true, requestId: 'improve-docs:sandbox:retry' }, deps).job;
    failCreate = 'worktree not created: the disk is full';
    const s1 = await J.stepJobs(store, [handler], deps);
    failCreate = undefined;
    assert.deepEqual(s1.errors, [{ job: q.id, message: 'worktree not created: the disk is full' }]);
    assert.deepEqual([store.getJob(q.id)!.state, store.getJob(q.id)!.state_reason], ['queued', 'work task not created: worktree not created: the disk is full']);
    const s2 = await J.stepJobs(store, [handler], deps);
    assert.equal(s2.started.find((x) => x.job === q.id)?.task, store.getJob(q.id)!.task_id);
    assert.equal(store.getJob(q.id)!.state, 'running');
    store.setTaskState(store.getJob(q.id)!.task_id!, 'failed', 'given up');
    await J.stepJobs(store, [handler], deps);
  });

  test('the text of jv job list and show: ids first, at most 100 characters, local times, the reason last', () => {
    const views = store.listJobs({ kind: 'improve-docs' }).map((j) => J.jobView(store, j));
    const text = J.formatJobList(views);
    const lines = text.split('\n');
    assert.equal(lines.length, views.length);
    for (const [i, line] of lines.entries()) {
      assert.ok([...line].length <= 100, line);
      assert.ok(line.startsWith(`${views[i]!.id}  improve-docs  sandbox  `), line);
      assert.match(line, / \d{2}:\d{2} /);
    }
    const done = views.find((v) => v.state === 'done' && v.reason === 'done by the fake')!;
    assert.match(lines[views.indexOf(done)]!, /\d+ s +done by the fake$/);
    assert.equal(J.formatJobList([]), 'No jobs.');
    const show = J.formatJobView(done);
    assert.match(show, new RegExp(`^${done.id}  improve-docs  sandbox  done: done by the fake\nRequest id improve-docs:sandbox:2026-W45\\.`));
    assert.match(show, /Result:\n\{\n {2}"summary": "done by the fake"/);
    assert.equal(J.durationText(4_000), '4 s');
    assert.equal(J.durationText(125_000), '2 min 05 s');
    assert.equal(J.durationText(3_900_000), '1 h 05 min');
  });

  test('cancel only a queued job', () => {
    const q = J.createJob(store, [handler], { project: 'sandbox', kind: 'improve-docs', force: true, requestId: 'improve-docs:sandbox:cancel' }, deps).job;
    const c = J.cancelJob(store, q.id);
    assert.deepEqual([c.state, c.state_reason], ['failed', 'cancelled by the owner']);
    assert.throws(() => J.cancelJob(store, q.id), (e: unknown) => e instanceof JvError && e.exitCode === 2);
    assert.throws(() => J.cancelJob(store, 'JZZZZZZ'), (e: unknown) => e instanceof JvError && e.exitCode === 3);
  });
});
