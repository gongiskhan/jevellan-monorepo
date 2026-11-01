// reconcile() (brief sections 3 and 8): admission under the per-project and total limits, oldest first and never twice;
// --after waits; Jev refusals retried once a minute with one wake per refusal; lost runs marked (read-only too),
// resumed on the same native session, advanced by their report, failed after too many losses in a row, placed again
// without a native session; tasks another process is starting skipped; message delivery to live claude-tmux runs;
// wake lines a dead flusher left; one failing sub-step not stopping the others; and one lost run end to end through
// a real `jv run` with the fake runtime. The router, spawn, wake and tmux are fakes unless a test says otherwise;
// no model, no Jev, no network.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-reconcile-test-');
process.env.JV_HOME = home;
const R = await import('../src/reconcile.js');
const A = await import('../src/advance.js');
const T = await import('../src/tasks.js');
const launcher = await import('../src/launcher.js');
const { openStore } = await import('../src/store.js');
const { writeReport } = await import('../src/report.js');
const { recordEvent } = await import('../src/events.js');
const { refused } = await import('../src/errors.js');
const { CONTINUE_PROMPT } = await import('../src/prompt.js');
const { WAITING_FOR_A_SLOT } = await import('../src/limits.js');
const { wakeMetaKey } = await import('../src/wake.js');
const { coordinatorMetaKey } = await import('../src/coordinator.js');
type ReconcileDeps = import('../src/reconcile.js').ReconcileDeps;
type TmuxRunner = import('../src/coordinator.js').TmuxRunner;
type SessionRow = import('../src/types.js').SessionRow;

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

let k = 0;
function project(name: string) {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  return store.createProject({ name, path: repo, default_branch: 'main' }).row;
}

const pause = () => new Promise((r) => setTimeout(r, 3));

/** A queued task with one step per duty, its worktree recorded (no git: the spawn is a fake). */
async function newTask(projectId: string, extra: { duties?: string[]; after?: string; when?: string; kind?: 'single' | 'bug' } = {}) {
  await pause(); // created_at orders admission; one millisecond apart at least
  const duties = extra.duties ?? ['implement'];
  const t = store.createTask({
    project_id: projectId,
    request_id: `req-reconcile-${++k}`,
    kind: extra.kind ?? 'single',
    title: `Task ${k}`,
    task_text: 'Do the thing.',
    workflow_json: JSON.stringify({ name: 'single', steps: duties.map((duty) => ({ duty, when: extra.when ?? 'always', instructions: '' })) }),
    ...(extra.after ? { after_task_id: extra.after } : {}),
  }).row;
  duties.forEach((duty, i) => store.createStep({ task_id: t.id, ordinal: i + 1, duty, ...(extra.when ? { when_rule: extra.when } : {}) }));
  return store.updateTask(t.id, { worktree_path: join(home, 'worktrees', `t${k}`), branch: `jv/t-${k}`, base_commit: 'a'.repeat(40) });
}

let clock = Date.parse('2026-11-01T09:00:00.000Z');
let placed: string[] = [];
let spawned: string[] = [];
let woken: string[] = [];
let typed: Array<{ session: string; text: string }> = [];
let jevRefusal: string | undefined;
const dead = new Set<string>();
const LIVE_PID = 4242;

beforeEach(() => {
  placed = [];
  spawned = [];
  woken = [];
  typed = [];
  jevRefusal = undefined;
});

// Every test leaves no live work behind, so the next one starts with every slot free.
afterEach(() => {
  for (const s of store.listSessions({ states: ['queued', 'starting', 'running'] })) store.setSessionState(s.id, 'done', 'test cleanup');
  for (const t of store.listTasks({ states: ['queued', 'running', 'waiting-owner', 'landing'] })) store.setTaskState(t.id, 'stopped', 'test cleanup');
});

const deps: Partial<ReconcileDeps> = {
  placeStep: async (input) => {
    placed.push(input.taskId);
    if (jevRefusal) throw refused(jevRefusal);
    const task = store.requireTask(input.taskId);
    const decision = store.createDecision({
      kind: 'placement',
      project_id: task.project_id,
      task_id: task.id,
      step_id: input.stepId,
      skill_name: 'jevellan-router',
      skill_hash: 'hash',
      jev_model: 'jev-test',
      state_json: '{}',
      questions_json: '{}',
      answers_json: '{}',
      chosen_json: '{}',
      latency_ms: 1,
      usage_json: '{}',
    });
    return { runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', decisionId: decision.id, decision };
  },
  // The run starts at once: running, a pid the `alive` fake calls alive, a native session.
  spawn: (s, id) => {
    spawned.push(id);
    const row = s.requireSession(id);
    s.setSessionState(id, 'running', 'fake turn', { pid: LIVE_PID, ...(row.native_session_id ? {} : { native_session_id: `native-${id}` }) });
  },
  notify: async (_s, input) => {
    woken.push(input.line);
  },
  land: async (_s, taskId) => ({ route: 'land', state: 'landed', reason: 'fake', taskId }),
  closeWindows: async () => [],
  typeIntoLive: async (_s, session, text) => {
    typed.push({ session: session.id, text });
    return true;
  },
  alive: (s: SessionRow) => !dead.has(s.id),
  pidAlive: () => false,
  now: () => clock,
  // Only for the tests' own startStep calls; reconcile uses the limits it is given.
  limits: () => ({ perProject: 100, total: 100 }),
};

const runsOf = (taskId: string) => store.listSessions({ task_id: taskId, kind: 'step' });
const lastRun = (taskId: string) => runsOf(taskId).at(-1)!;

test('admission: oldest first within the per-project and total limits, never twice, the next one when a slot frees', async () => {
  const alpha = project('alpha');
  const beta = project('beta');
  const a1 = await newTask(alpha.id);
  const a2 = await newTask(alpha.id);
  const b1 = await newTask(beta.id);
  const a3 = await newTask(alpha.id);
  const b2 = await newTask(beta.id);
  const limits = { perProject: 2, total: 3 };

  const first = await R.reconcile(store, limits, { deps });
  assert.deepEqual(first.admitted, [a1.id, a2.id, b1.id]);
  assert.deepEqual(placed, [a1.id, a2.id, b1.id], 'no Jev call for a task that does not fit');
  assert.deepEqual(first.errors, []);
  for (const t of [a3, b2]) {
    const row = store.requireTask(t.id);
    assert.equal(row.state, 'queued');
    assert.equal(row.state_reason, WAITING_FOR_A_SLOT);
    assert.equal(runsOf(t.id).length, 0);
  }
  assert.equal(store.requireTask(a1.id).state, 'running');

  const again = await R.reconcile(store, limits, { deps });
  assert.deepEqual(again.admitted, []);
  assert.equal(spawned.length, 3, 'running reconcile twice admits nothing twice');

  // a1 ends: its slot goes to a3 (alpha has room again, the total too); b2 still waits for the total.
  store.setSessionState(lastRun(a1.id).id, 'done', 'turn ended');
  store.setTaskState(a1.id, 'done', 'step implement done');
  const third = await R.reconcile(store, limits, { deps });
  assert.deepEqual(third.admitted, [a3.id]);
  assert.equal(store.requireTask(b2.id).state_reason, WAITING_FOR_A_SLOT);

  // With admissions off (quiet hours) nothing starts, even with a free slot.
  store.setSessionState(lastRun(b1.id).id, 'done', 'turn ended');
  store.setTaskState(b1.id, 'done', 'done');
  assert.deepEqual((await R.reconcile(store, limits, { deps, admit: false })).admitted, []);
  assert.deepEqual((await R.reconcile(store, limits, { deps })).admitted, [b2.id]);
});

test('a task queued --after another starts only once that task is done', async () => {
  const p = project('after');
  const first = await newTask(p.id);
  const second = await newTask(p.id, { after: first.id });
  const limits = { perProject: 4, total: 4 };
  assert.deepEqual((await R.reconcile(store, limits, { deps })).admitted, [first.id]);
  assert.deepEqual((await R.reconcile(store, limits, { deps })).admitted, []);
  store.setSessionState(lastRun(first.id).id, 'done', 'turn ended');
  store.setTaskState(first.id, 'done', 'done');
  assert.deepEqual((await R.reconcile(store, limits, { deps })).admitted, [second.id]);
});

test('a Jev refusal: queued with the message, retried at most once a minute, the coordinator woken once per refusal', async () => {
  const p = project('jev');
  const task = await newTask(p.id);
  const limits = { perProject: 2, total: 4 };
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  clock = t0;
  jevRefusal = 'Jev: no key configured';
  const r1 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r1.refused, [{ task: task.id, reason: 'Jev: no key configured' }]);
  assert.deepEqual(r1.admitted, []);
  assert.equal(woken.length, 1);
  assert.equal(r1.woke, 1);
  const row = store.requireTask(task.id);
  assert.equal(row.state, 'queued');
  assert.match(row.state_reason, /not placed: Jev: no key configured/);
  assert.deepEqual(A.readAdmitAttempt(store, task.id), { at: new Date(t0).toISOString(), reason: 'Jev: no key configured' });

  clock = t0 + 30_000;
  const r2 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r2.refused, []);
  assert.equal(placed.length, 1, 'not retried within the minute');

  clock = t0 + 61_000;
  const r3 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r3.refused, [{ task: task.id, reason: 'Jev: no key configured' }]);
  assert.equal(placed.length, 2, 'retried after a minute');
  assert.equal(woken.length, 1, 'a retry refused for the same reason wakes nobody');
  assert.equal(r3.woke, 0);

  clock = t0 + 122_000;
  jevRefusal = 'Jev: timed out after 20000 ms';
  await R.reconcile(store, limits, { deps });
  assert.equal(woken.length, 2, 'a new refusal wakes the coordinator again');

  clock = t0 + 183_000;
  jevRefusal = undefined;
  const r5 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r5.admitted, [task.id]);
  assert.equal(A.readAdmitAttempt(store, task.id)?.reason, null, 'the start cleared the refusal');
});

test('a refusal of the workflow questions at creation counts as the first attempt: no retry within the minute, no second wake', async () => {
  const p = project('questions');
  const task = await newTask(p.id, { when: 'jev:needs_plan' });
  const t0 = Date.parse('2026-11-01T11:00:00.000Z');
  clock = t0;
  let asked = 0;
  const qdeps: Partial<ReconcileDeps> = {
    ...deps,
    askWorkflowQuestions: async () => {
      asked++;
      throw refused('Jev: no key configured');
    },
  };
  // What jv task create runs for a new task.
  const created = await T.admitTask(store, task.id, { reason: 'task created', deps: qdeps });
  assert.equal(created.state, 'refused');
  assert.equal(woken.length, 1);
  assert.equal(store.requireTask(task.id).state_reason, 'Jev: no key configured');

  clock = t0 + 15_000;
  await R.reconcile(store, { perProject: 2, total: 4 }, { deps: qdeps });
  assert.equal(asked, 1, 'the bot waits a minute after the refusal at creation');
  clock = t0 + 75_000;
  const r = await R.reconcile(store, { perProject: 2, total: 4 }, { deps: qdeps });
  assert.equal(asked, 2);
  assert.deepEqual(r.refused, [{ task: task.id, reason: 'Jev: no key configured' }]);
  assert.equal(woken.length, 1, 'the same refusal wakes once');
});

/** A task running its first step, with a run in state running whose process the `alive` fake controls. */
async function runningTask(projectId: string, extra: { duties?: string[]; native?: string | null } = {}) {
  const task = await newTask(projectId, extra.duties ? { duties: extra.duties } : {});
  const start = await A.startStep(store, task.id, { reason: 'go', deps });
  assert.equal(start.state, 'started');
  const run = lastRun(task.id);
  if (extra.native === null) store.updateSession(run.id, { native_session_id: null });
  return { task, run: store.requireSession(run.id) };
}

test('a lost run is marked (read-only too), then resumed by the bot on the same native session, once', async () => {
  const p = project('lost');
  const { task, run } = await runningTask(p.id);
  dead.add(run.id);
  const limits = { perProject: 2, total: 4 };

  const read = await R.reconcile(store, limits, { deps, readOnly: true });
  assert.deepEqual(read.lost, [run.id]);
  assert.deepEqual(read.resumed, []);
  assert.equal(store.requireSession(run.id).state, 'lost');
  assert.equal(runsOf(task.id).length, 1, 'read-only resumes nothing');

  const r = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r.lost, [], 'already marked');
  assert.equal(r.resumed.length, 1);
  const resumed = store.requireSession(r.resumed[0]!);
  assert.equal(resumed.native_session_id, run.native_session_id);
  assert.equal(resumed.request_id, `resume:${run.id}`);
  assert.equal(launcher.runMessage(store, resumed.id), CONTINUE_PROMPT);
  assert.deepEqual(r.recovered, [{ session: run.id, task: task.id, action: 'resumed', run: resumed.id }]);
  assert.equal(store.requireTask(task.id).state_reason, `step 1 (implement) resumed by the bot after ${run.id} was lost`);
  assert.deepEqual(placed, [task.id], 'no new placement: the conversation continues');

  const again = await R.reconcile(store, limits, { deps });
  assert.deepEqual(again.resumed, []);
  assert.equal(runsOf(task.id).length, 2, 'resumed once');
});

test('lost runs: advanced by the report they wrote, a failure after too many losses in a row, placed again without a native session', async () => {
  const p = project('lost-kinds');
  const limits = { perProject: 4, total: 4 };

  // Reported, then the process died: the report is the turn's outcome.
  const reported = await runningTask(p.id);
  writeReport(store, reported.run.id, { status: 'done', summary: 'Implemented, then the process died.' });
  dead.add(reported.run.id);

  // Lost three times in a row already; the fourth loss is a failure of the step (no on_fail: the owner).
  const flaky = await runningTask(p.id);
  for (let i = 0; i < A.MAX_LOST_RESUMES; i++) {
    const r = lastRun(flaky.task.id);
    store.setSessionState(r.id, 'lost', 'gone');
    await T.recoverLostRun(store, r.id, deps);
  }
  assert.equal(runsOf(flaky.task.id).length, A.MAX_LOST_RESUMES + 1);
  dead.add(lastRun(flaky.task.id).id);

  // Never got a native session: nothing to continue, so the step is placed again.
  const fresh = await runningTask(p.id, { native: null });
  dead.add(fresh.run.id);

  placed = [];
  const r = await R.reconcile(store, limits, { deps });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const byTask = new Map(r.recovered.map((x) => [x.task, x]));
  assert.equal(byTask.get(reported.task.id)?.action, 'advanced');
  assert.equal(store.requireTask(reported.task.id).state, 'done', 'a single task is done after its reported step');

  assert.equal(byTask.get(flaky.task.id)?.action, 'failed');
  const f = store.requireTask(flaky.task.id);
  assert.equal(f.state, 'waiting-owner');
  assert.match(f.state_reason, /failed: run R\w+ was lost 4 times in a row/);

  assert.equal(byTask.get(fresh.task.id)?.action, 'placed');
  assert.deepEqual(placed, [fresh.task.id]);
  assert.ok(r.resumed.includes(byTask.get(fresh.task.id)!.run!));
  assert.equal(lastRun(fresh.task.id).native_session_id, `native-${lastRun(fresh.task.id).id}`);
});

test('a task another process is starting is skipped; a starting row that never got a pid is lost after 60 s', async () => {
  const p = project('starting');
  const limits = { perProject: 4, total: 4 };
  const now = Date.now();
  clock = now;

  // Another process moved the run to starting a moment ago and its pid is not alive (yet): left alone.
  const busy = await runningTask(p.id);
  store.setSessionState(busy.run.id, 'starting', 'launching jv run');
  dead.add(busy.run.id);
  const r1 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r1.lost, []);
  assert.equal(store.requireSession(busy.run.id).state, 'starting');

  // An orphan: starting, no pid; lost once it is older than 60 s, then resumed.
  const orphan = await runningTask(p.id);
  store.setSessionState(orphan.run.id, 'starting', 'launching jv run', { pid: null });
  store.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(new Date(now - 61_000).toISOString(), orphan.run.id);
  store.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(new Date(now - 61_000).toISOString(), busy.run.id);
  const r2 = await R.reconcile(store, limits, { deps });
  assert.deepEqual(r2.lost.sort(), [busy.run.id, orphan.run.id].sort(), 'both are older than 60 s now');
  assert.match(store.requireSession(orphan.run.id).state_reason, /no process was recorded within 60 s/);
  assert.equal(r2.resumed.length, 2);
});

test('delivery: undelivered messages are typed into a running claude-tmux run, not the ones its prompt carries, not the youngest', async () => {
  const p = project('tmux');
  const { task, run } = await runningTask(p.id);
  store.db.prepare(`UPDATE sessions SET runtime = 'claude-tmux', tmux_target = ? WHERE id = ?`).run(`jv-${run.id}`, run.id);
  const carried = store.createMessage({ task_id: task.id, direction: 'owner', text: 'Already in the prompt.' });
  recordEvent(store, run.id, 'message', { from: 'jv', text: 'From the owner: Already in the prompt.', messages: [carried.id] });
  const old = store.createMessage({ task_id: task.id, direction: 'coordinator', text: 'Use the empty state copy from the docs.' });
  const young = store.createMessage({ task_id: task.id, direction: 'owner', text: 'Just typed.' });
  const at = (id: string, ms: number) => store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(ms).toISOString(), id);
  clock = Date.parse('2026-11-01T12:00:00.000Z');
  at(carried.id, clock - 60_000);
  at(old.id, clock - 30_000);
  at(young.id, clock - 2_000);

  const r = await R.reconcile(store, { perProject: 4, total: 4 }, { deps });
  assert.deepEqual(r.delivered, [old.id]);
  assert.deepEqual(typed, [{ session: run.id, text: 'From the coordinator: Use the empty state copy from the docs.' }]);
  assert.equal(store.getMessage(old.id)!.session_id, run.id);
  assert.notEqual(store.getMessage(old.id)!.delivered_at, null);
  assert.equal(store.getMessage(carried.id)!.delivered_at, null, 'run.ts marks it when the turn ends');
  assert.equal(store.getMessage(young.id)!.delivered_at, null);

  clock += 10_000;
  const r2 = await R.reconcile(store, { perProject: 4, total: 4 }, { deps });
  assert.deepEqual(r2.delivered, [young.id]);
  assert.equal(typed.length, 2, 'nothing is typed twice');
});

test('wake lines a dead flusher left behind are typed as one line once the window allows', async () => {
  const p = project('wake');
  const coord = store.createSession({
    project_id: p.id,
    request_id: `coordinator:${p.id}:x`,
    kind: 'coordinator',
    runtime: 'claude-tmux',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: join(home, 'repos', 'wake'),
    state: 'running',
  }).row;
  const name = 'jv-coord-wake';
  store.setMeta(
    coordinatorMetaKey(p.id),
    JSON.stringify({ sessionId: coord.id, projectId: p.id, projectName: 'wake', tmuxSession: name, promptFile: '/x', startedAt: new Date().toISOString(), remoteControl: { requested: false } }),
  );
  const sent: string[] = [];
  const tmux: TmuxRunner = (args) => {
    if (args[0] === 'send-keys' && args.includes('-l')) sent.push(String(args.at(-1)));
    return { code: 0, stdout: '', stderr: '' };
  };
  clock = Date.parse('2026-11-01T13:00:00.000Z');
  const pending = ['[jv] T1 (One) step verify: failed. Run: jv report R1', '[jv] T2 (Two) step plan: needs-decision. Run: jv report R2'];
  const state = (flusherPid: number, last: number) =>
    JSON.stringify({ lastSentAt: new Date(last).toISOString(), pending, flusher: { pid: flusherPid, dueAt: new Date(last + 5_000).toISOString() } });

  // A live flusher that is not late yet flushes itself.
  store.setMeta(wakeMetaKey(p.id), state(777, clock - 2_000));
  const live = await R.reconcile(store, { perProject: 4, total: 4 }, { deps: { ...deps, tmux, pidAlive: (pid) => pid === 777 } });
  assert.equal(live.woke, 0);
  assert.deepEqual(sent, []);

  // A dead one, inside the window: next tick. After the window: one merged line, and the queue is empty.
  store.setMeta(wakeMetaKey(p.id), state(888, clock - 2_000));
  assert.equal((await R.reconcile(store, { perProject: 4, total: 4 }, { deps: { ...deps, tmux } })).woke, 0);
  clock += 4_000;
  const flushed = await R.reconcile(store, { perProject: 4, total: 4 }, { deps: { ...deps, tmux } });
  assert.equal(flushed.woke, 1);
  assert.deepEqual(sent, ['[jv] 2 updates. Run: jv status --json']);
  assert.deepEqual(JSON.parse(store.getMeta(wakeMetaKey(p.id))!).pending, []);
  assert.equal((await R.reconcile(store, { perProject: 4, total: 4 }, { deps: { ...deps, tmux } })).woke, 0);
  store.setSessionState(coord.id, 'stopped', 'test cleanup');
});

test('a sub-step that fails is recorded in errors and the others still run', async () => {
  const p = project('errors');
  const { task, run } = await runningTask(p.id);
  store.db.prepare(`UPDATE sessions SET runtime = 'claude-tmux', tmux_target = ? WHERE id = ?`).run(`jv-${run.id}`, run.id);
  const m = store.createMessage({ task_id: task.id, direction: 'owner', text: 'Hello.' });
  store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(clock - 60_000).toISOString(), m.id);
  const queued = await newTask(p.id);
  const broken: Partial<ReconcileDeps> = {
    ...deps,
    typeIntoLive: async () => {
      throw new Error('tmux is gone');
    },
  };
  const r = await R.reconcile(store, { perProject: 4, total: 4 }, { deps: broken });
  assert.deepEqual(r.errors, [{ step: 'deliver', message: `${run.id}: tmux is gone` }]);
  assert.deepEqual(r.admitted, [queued.id], 'admission ran');
  assert.equal(store.getMessage(m.id)!.delivered_at, null);
});

test('end to end: a run whose process died is lost, and the resumed turn finishes on the same native session', async () => {
  const p = project('e2e');
  const task = await newTask(p.id, { duties: ['investigate'] });
  store.updateTask(task.id, { worktree_path: join(home, 'repos', 'e2e') });
  const entry = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
  const env = (mode: string, dump?: string) => ({
    ...process.env,
    JV_TEST_RUNTIME_MODULE: fileURLToPath(new URL('./fixtures/fake-runtime.js', import.meta.url)),
    JV_TEST_WORKER_RULES: join(home, 'worker-rules.md'),
    FAKE_RUNTIME_MODE: mode,
    ...(dump ? { FAKE_RUNTIME_DUMP: dump } : {}),
  });
  const realSpawn = (mode: string, dump?: string) => (s: typeof store, id: string) => {
    spawned.push(id);
    launcher.spawnRun(s, id, { node: process.execPath, entry, env: env(mode, dump) });
  };
  const waitFor = async <V>(what: string, fn: () => V | undefined | false, ms = 20_000): Promise<V> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const start = await A.startStep(store, task.id, { reason: 'go', deps: { ...deps, spawn: realSpawn('crash') } });
  assert.equal(start.state, 'started');
  const first = lastRun(task.id);
  await waitFor('the crashed process to exit', () => store.requireSession(first.id).native_session_id && !launcher.isAlive(store.requireSession(first.id).pid));

  const dump = join(home, 'e2e-dump.json');
  clock = Date.now();
  const r = await R.reconcile(store, { perProject: 4, total: 4 }, { deps: { ...deps, alive: launcher.isRunAlive, spawn: realSpawn('done', dump) } });
  assert.deepEqual(r.lost, [first.id]);
  assert.equal(r.resumed.length, 1);
  const second = r.resumed[0]!;
  await waitFor('the resumed turn to end', () => store.requireSession(second).state === 'done');
  assert.equal(store.requireSession(second).native_session_id, `fake-native-${first.id}`);
  assert.equal((JSON.parse(readFileSync(dump, 'utf8')) as { prompt: string }).prompt, CONTINUE_PROMPT);
  assert.equal(store.getReportBySession(second)?.status, 'done');
  await waitFor('the task to be done', () => store.requireTask(task.id).state === 'done');
});
