// jv task list, jv task changes and jv task create's slot rule and --origin (brief sections 3 and 4): through
// jevellan-core (listTaskSummaries, createTask) and through the command line (main), on a temporary JV_HOME and git
// repository. The router, spawn and wake are fakes where a test injects them; the command line runs with the real
// ones and never reaches Jev (the paths tested here stop before a placement).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-task-list-test-');
process.env.JV_HOME = home;
// One slot per project: the first task below holds it.
writeFileSync(join(home, 'bot.json'), JSON.stringify({ limits: { perProject: 1, total: 10 } }));
const T = await import('jevellan-core/tasks');
const { openStore } = await import('jevellan-core/store');
const { recordProviderAuth } = await import('jevellan-core/providers');
const { WAITING_FOR_A_SLOT } = await import('jevellan-core/limits');
const { main, helpText, COMMANDS } = await import('../src/cli.js');
type TaskDeps = import('jevellan-core/tasks').TaskDeps;

const repo = join(home, 'repos', 'sandbox');
mkdirSync(repo, { recursive: true });
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
gitIn(repo, 'init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# sandbox\n');
gitIn(repo, 'add', '.');
gitIn(repo, 'commit', '-q', '-m', 'first');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
const sandbox = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
const otherRepo = join(home, 'repos', 'other');
mkdirSync(otherRepo, { recursive: true });
const other = store.createProject({ name: 'other', path: otherRepo, default_branch: 'main' }).row;
for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });

let placed = 0;
const deps: Partial<TaskDeps> = {
  placeStep: async (input) => {
    placed++;
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
  spawn: () => {},
  notify: async () => {},
};

/**
 * Runs jv with its stdout and stderr captured. jv writes strings; the test runner's own reports (buffers, written
 * while main awaits) go through untouched.
 */
async function jv(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: process.stdout.write, err: process.stderr.write };
  const capture = (into: string[], stream: NodeJS.WriteStream, original: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) =>
      typeof chunk === 'string' ? (into.push(chunk), true) : (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest)) as typeof process.stdout.write;
  process.stdout.write = capture(out, process.stdout, write.out);
  process.stderr.write = capture(err, process.stderr, write.err);
  try {
    return { code: await main(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
}

const pause = () => new Promise((r) => setTimeout(r, 3));
let n = 0;
const input = (extra: Partial<import('jevellan-core/tasks').CreateTaskInput> = {}) => ({
  project: 'sandbox',
  kind: 'single',
  duty: 'implement',
  title: `Unit test for slugify ${++n}`,
  text: 'Add a unit test for slugify.',
  ...extra,
});

let holder = '';

test('jv task create starts step 1 only in a free slot; otherwise exit 0, queued, "waiting for a slot", no Jev call', async () => {
  const first = await T.createTask(store, input(), deps);
  assert.equal(first.start?.state, 'started');
  assert.equal(first.task.origin, 'owner');
  holder = first.task.id;
  assert.equal(placed, 1);

  // The command line: the real router would need a Jev key this home does not have, so exit 0 here proves no
  // placement was even tried.
  const r = await jv('task', 'create', '--project', 'sandbox', '--kind', 'single', '--duty', 'implement', '--title', 'README how to run', '--text', 'Explain npm start.', '--origin', 'ui', '--json');
  assert.equal(r.code, 0, r.out + r.err);
  const created = JSON.parse(r.out) as { task: { id: string; state: string; state_reason: string; origin: string }; start?: { state: string; reason: string } };
  assert.equal(created.task.state, 'queued');
  assert.equal(created.task.state_reason, WAITING_FOR_A_SLOT);
  assert.equal(created.task.origin, 'ui');
  assert.deepEqual(created.start, { state: 'waiting', reason: 'waiting for a slot' });
  assert.equal(store.listSessions({ task_id: created.task.id }).length, 0);

  // Text output says so too.
  const text = await jv('task', 'create', '--project', 'sandbox', '--kind', 'single', '--duty', 'implement', '--title', 'Lint config', '--text', 'Add lint.');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /State queued: waiting for a slot/);

  // jv task resume of a queued task is held back the same way.
  const resumed = await T.resumeTask(store, created.task.id, deps);
  assert.equal(resumed.how, 'waiting');
  assert.equal(resumed.reason, WAITING_FOR_A_SLOT);
  assert.equal(placed, 1, 'still no placement');
});

test('--origin is checked before anything is written and is not in --help; JV_SESSION of a coordinator makes it coordinator', async () => {
  const before = store.listTasks().length;
  const bad = await jv('task', 'create', '--project', 'sandbox', '--kind', 'single', '--duty', 'implement', '--title', 'Bad origin', '--text', 'x', '--origin', 'planner:nope', '--json');
  assert.equal(bad.code, 2);
  assert.match((JSON.parse(bad.out) as { error: string }).error, /--origin "planner:nope" is not one of/);
  assert.equal(store.listTasks().length, before, 'nothing was created');
  assert.doesNotMatch(helpText(), /--origin/);
  assert.doesNotMatch(COMMANDS.task!.usage, /origin/);
  assert.match(COMMANDS.task!.usage, /list: \[--project N\] \[--state S\] \[--limit N\]; changes: T \[--stat\]/);

  const coordinator = store.createSession({
    project_id: sandbox.id,
    request_id: `coordinator:${sandbox.id}:test`,
    kind: 'coordinator',
    runtime: 'claude-tmux',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: repo,
  }).row;
  const byCoordinator = await T.createTask(store, input({ env: { JV_SESSION: coordinator.id } }), deps);
  assert.equal(byCoordinator.task.origin, 'coordinator');
  const scheduled = await T.createTask(store, input({ origin: 'schedule:C0A1B2C', env: { JV_SESSION: coordinator.id } }), deps);
  assert.equal(scheduled.task.origin, 'schedule:C0A1B2C', 'an explicit origin wins');
  assert.equal(T.taskView(store, scheduled.task).origin, 'schedule:C0A1B2C');
  assert.match(T.formatTaskView(T.taskView(store, scheduled.task)), /Origin schedule:C0A1B2C\./);

  // start: false (the planner) leaves the start to the bot.
  await pause();
  const later = await T.createTask(store, input({ origin: 'planner:J0A1B2C', start: false }), deps);
  assert.equal(later.task.state, 'queued');
  assert.equal(later.task.state_reason, T.QUEUED_FOR_THE_BOT);
  assert.equal(later.start, undefined);
});

test('listTaskSummaries: newest first, with origin, filtered by project, state and origin, limited; bad input refused', async () => {
  await pause();
  const elsewhere = store.createTask({
    project_id: other.id,
    request_id: 'req-list-other',
    kind: 'single',
    title: 'A task in another project',
    task_text: 'x',
    workflow_json: '{"steps":[]}',
    origin: 'mcp',
  }).row;
  const all = T.listTaskSummaries(store);
  assert.equal(all[0]!.id, elsewhere.id, 'newest first');
  const created = all.map((t) => t.createdAt);
  assert.deepEqual(created, [...created].sort().reverse());
  assert.ok(all.every((t) => typeof t.origin === 'string'));
  assert.equal(all.find((t) => t.id === holder)?.origin, 'owner');
  assert.equal(all.some((t) => t.title === 'Coordinator conversation'), false, 'the coordinator conversation task is not work');
  const h = all.find((t) => t.id === holder)!;
  assert.deepEqual(h.step, { ordinal: 1, duty: 'implement', state: 'running', of: 1 });
  assert.equal(h.run?.state, 'queued');
  assert.equal(h.state, 'running');

  assert.deepEqual(T.listTaskSummaries(store, { project: 'other' }).map((t) => t.id), [elsewhere.id]);
  assert.ok(T.listTaskSummaries(store, { state: 'queued' }).every((t) => t.state === 'queued'));
  assert.deepEqual(T.listTaskSummaries(store, { origin: 'mcp' }).map((t) => t.id), [elsewhere.id]);
  assert.equal(T.listTaskSummaries(store, { limit: 2 }).length, 2);
  assert.throws(() => T.listTaskSummaries(store, { state: 'sleeping' }), /--state "sleeping" is not one of queued, running/);
  assert.throws(() => T.listTaskSummaries(store, { limit: 0 }), /--limit must be a whole number from 1 to 1000/);
  assert.throws(() => T.listTaskSummaries(store, { project: 'nope' }), (e: unknown) => (e as { exitCode?: number }).exitCode === 3);
});

test('jv task list: --json, one text line per task of at most 100 characters, ids first, local HH:MM, the date when not today', async () => {
  const long = store.createTask({
    project_id: sandbox.id,
    request_id: 'req-list-long',
    kind: 'feature',
    title: 'A very long title that goes on and on about the customers page and its empty state and the copy it shows',
    task_text: 'x',
    workflow_json: '{"steps":[]}',
    origin: 'improver:J9Z8Y7X',
  }).row;
  store.db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-03-04T10:05:00.000Z', long.id);

  const json = await jv('task', 'list', '--json');
  assert.equal(json.code, 0, json.err);
  const tasks = (JSON.parse(json.out) as { tasks: Array<{ id: string; origin: string; createdAt: string }> }).tasks;
  assert.equal(tasks.length, T.listTaskSummaries(store).length);
  assert.equal(tasks.at(-1)!.id, long.id, 'the oldest is last');
  assert.ok(tasks.every((t) => /Z$/.test(t.createdAt)), 'JSON keeps ISO UTC times');

  const text = await jv('task', 'list');
  assert.equal(text.code, 0, text.err);
  const lines = text.out.trimEnd().split('\n');
  assert.equal(lines.length, tasks.length);
  for (const [i, line] of lines.entries()) {
    assert.ok([...line].length <= 100, `${line.length}: ${line}`);
    assert.ok(line.startsWith(`${tasks[i]!.id}  `), line);
  }
  const holderLine = lines.find((l) => l.startsWith(holder))!;
  assert.match(holderLine, /^T\w{6} {2}running {2}owner +\d\d:\d\d +1\/1 implement {2}sandbox {2}Unit test for/);
  const longLine = lines.at(-1)!;
  const d = new Date('2026-03-04T10:05:00.000Z');
  const pad = (x: number) => String(x).padStart(2, '0');
  assert.ok(longLine.includes(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`), longLine);
  assert.ok(longLine.includes('improver:J9Z8Y7X'));
  assert.ok(longLine.endsWith('...'), 'cut at 100 characters');

  const one = await jv('task', 'list', '--project', 'other');
  assert.equal(one.out.trim().split('\n').length, 1);
  assert.doesNotMatch(one.out, / other {2}/, 'the project is left out of a one-project list');
  assert.equal((await jv('task', 'list', '--state', 'nope')).code, 2);
  assert.equal((await jv('task', 'list', '--limit', 'x')).code, 2);
  assert.equal((await jv('task', 'list', '--project', 'nope')).code, 3);
  assert.equal(T.formatTaskList([]), 'No tasks.');
});

test('jv task changes: --stat numstat lines, --json with the diff, exit 3 for an unknown task and 2 for one with no branch', async () => {
  const task = store.requireTask(holder);
  writeFileSync(join(task.worktree_path!, 'slugify.test.js'), "test('slugify', () => {});\n");
  gitIn(task.worktree_path!, 'add', '.');
  gitIn(task.worktree_path!, 'commit', '-q', '-m', 'test');
  writeFileSync(join(task.worktree_path!, 'README.md'), '# sandbox\n\nnpm test\n');

  const stat = await jv('task', 'changes', holder, '--stat');
  assert.equal(stat.code, 0, stat.err);
  assert.deepEqual(stat.out.trimEnd().split('\n'), ['1\t0\tslugify.test.js', '2\t0\tREADME.md\t(uncommitted)']);

  const json = await jv('task', 'changes', holder.toLowerCase(), '--json');
  assert.equal(json.code, 0, json.err);
  const r = JSON.parse(json.out) as { task: string; base: string; files: Array<{ path: string; uncommitted: boolean }>; diff: string };
  assert.equal(r.task, holder);
  assert.equal(r.base, task.base_commit);
  assert.deepEqual(r.files.map((f) => [f.path, f.uncommitted]), [['slugify.test.js', false], ['README.md', true]]);
  assert.match(r.diff, /\+\+\+ b\/slugify\.test\.js/);
  assert.equal('diff' in (JSON.parse((await jv('task', 'changes', holder, '--stat', '--json')).out) as object), false);

  const text = await jv('task', 'changes', holder);
  assert.match(text.out, new RegExp(`^Task ${holder}: jv/unit-test-for-slugify-1-\\w{6} against \\w{12}, 2 changed files \\(1 uncommitted\\)\n`));

  assert.equal((await jv('task', 'changes', 'TZZZZZZ')).code, 3);
  const answer = store.createTask({ project_id: sandbox.id, request_id: 'req-answer', kind: 'single', title: 'What is it', task_text: 'x', workflow_json: '{"steps":[]}' }).row;
  const refusedOne = await jv('task', 'changes', answer.id, '--json');
  assert.equal(refusedOne.code, 2);
  assert.match((JSON.parse(refusedOne.out) as { error: string }).error, /has no branch/);
  assert.equal((await jv('task', 'changes')).code, 2, 'the task id is required');
});
