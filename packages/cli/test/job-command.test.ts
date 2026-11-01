// jv job run|list|show|cancel and jv improve memory|docs|skills through the command line on a temporary home and git
// repository (brief sections 4, 9 and 10; M-017, M-018). The bot's part (stepJobs) runs in process with jevellan-core's
// real createTask, which creates the unstarted work tasks and the planned tasks without reaching Jev; the workers'
// reports are written to the store as a run would. Covered: the JSON contract ({job, created}, {jobs}, {job}), the
// same-day idempotence of plan (exit 0, the same id, nothing created), --force, "already running", cancel only a
// queued job, a plan job run to done (queued planner:<J> tasks with after links), an improve-memory job run to done
// (one memory archived with superseded_by, none deleted), the improve-skills refusal until jevellan-skills is
// registered, and the landing.json jv project add writes for jevellan-skills.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome, writeSkill } from './fixtures/run-fixture.js';

// Temporary repositories run git without the machine's configuration (AGENTS.md); the child jv processes inherit it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const home = makeHome('jv-job-command-test-');
process.env.JV_HOME = home;
// A feature workflow and the duty skills it and the jobs use, as the bootstrap would install them.
writeSkill(home, 'verify', ['repo-read', 'shell'], 'Run the tests.');
writeSkill(home, 'document', ['repo-write'], 'Update the docs.');
mkdirSync(join(home, 'skills', 'jevellan-workflow-feature'), { recursive: true });
writeFileSync(join(home, 'skills', 'jevellan-workflow-feature', 'workflow.json'), JSON.stringify({ name: 'feature', steps: [{ duty: 'implement', instructions: 'Do it.' }, { duty: 'verify', instructions: 'Check it.' }] }));
mkdirSync(join(home, 'agents'), { recursive: true });
writeFileSync(join(home, 'agents', 'jevellan-coordinator.agent.md'), '---\nname: jevellan-coordinator\n---\n');

await import('../src/setup.js');
const memory = await import('jevellan-memory');
const { openStore } = await import('jevellan-core/store');
const { recordProviderAuth } = await import('jevellan-core/providers');
const { isoWeek, localDay, stepJobs } = await import('jevellan-core/jobs');
const { QUEUED_FOR_THE_BOT } = await import('jevellan-core/tasks');
const { JOB_HANDLERS } = await import('../src/commands/job.js');
const { helpText } = await import('../src/cli.js');

after(() => rmSync(home, { recursive: true, force: true }));

const entry = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
function jv(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { env: { ...process.env, JV_HOME: home, JV_SESSION: '' }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function json<T>(...args: string[]): T {
  const r = jv(...args, '--json');
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout) as T;
}
function refusal(code: number, ...args: string[]): string {
  const r = jv(...args, '--json');
  assert.equal(r.code, code, r.stdout || r.stderr);
  return (JSON.parse(r.stdout) as { error: string }).error;
}

interface Job {
  id: string;
  project: string;
  kind: string;
  state: string;
  reason: string;
  requestId: string;
  task: string | null;
  taskState: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
}
const JOB_KEYS = ['id', 'project', 'kind', 'state', 'reason', 'requestId', 'task', 'taskState', 'input', 'result', 'createdAt', 'endedAt', 'durationMs'];

function makeRepo(name: string): string {
  const repo = join(home, 'repos', name);
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return repo;
}

const store = openStore();
after(() => store.close());
const sandbox = store.createProject({ name: 'sandbox', path: makeRepo('sandbox'), default_branch: 'main' }).row;
for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });

/** What a worker's run leaves: a session on the task's step 1 with its report, then the step and the task done. */
function workerReports(taskId: string, summary: string): void {
  const step = store.listSteps(taskId)[0]!;
  const run = store.createSession({ project_id: sandbox.id, task_id: taskId, step_id: step.id, request_id: `test-run:${taskId}`, kind: 'step', runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: sandbox.path }).row;
  store.createReport({ session_id: run.id, step_id: step.id, task_id: taskId, status: 'done', summary });
  store.setStepState(step.id, 'done', 'reported done');
  store.setTaskState(taskId, 'done', 'done');
}
const block = (value: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(value, null, 1)}\n\`\`\``;

describe('jv job run plan, through the bot\'s step, to queued planner tasks', () => {
  let goal = '';
  let plan = '';
  test('run: {job, created}, queued, with the request id of the project and local day; the text says what happens next', () => {
    goal = json<{ goal: { id: string } }>('goal', 'add', '--project', 'sandbox', '--title', 'Import contacts', '--text', 'Customers import a CSV of contacts and see errors per row.', '--priority', '1').goal.id;
    const r = json<{ job: Job; created: boolean }>('job', 'run', 'plan', '--project', 'sandbox');
    assert.deepEqual(Object.keys(r), ['job', 'created']);
    assert.deepEqual(Object.keys(r.job), JOB_KEYS);
    assert.equal(r.created, true);
    assert.match(r.job.id, /^J[0-9A-Z]{6}$/);
    assert.deepEqual([r.job.kind, r.job.project, r.job.state, r.job.task, r.job.requestId], ['plan', 'sandbox', 'queued', null, `plan:sandbox:${localDay(new Date())}`]);
    plan = r.job.id;
    const again = jv('job', 'run', 'plan', '--project', 'sandbox');
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, `${plan} is the plan job of sandbox for this day (queued: waiting for the bot's next tick); --force makes another\n`);
  });

  test('--force while the job is queued is refused: "already running: J..." (exit 2); bad kinds and projects too', () => {
    assert.equal(refusal(2, 'job', 'run', 'plan', '--project', 'sandbox', '--force'), `already running: ${plan}`);
    assert.match(refusal(2, 'job', 'run', 'nap', '--project', 'sandbox'), /^job kind is one of plan, improve-memory, improve-docs, improve-skills$/);
    assert.match(refusal(2, 'job', 'run', '--project', 'sandbox'), /the job kind \(plan, improve-memory/);
    assert.match(refusal(2, 'job', 'run', 'plan'), /--project is required/);
    assert.match(refusal(3, 'job', 'run', 'plan', '--project', 'nope'), /no project nope/);
    assert.match(refusal(2, 'job'), /^jv job run <kind> --project N/);
    assert.match(refusal(2, 'job', 'start'), /unknown subcommand "job start"/);
  });

  test('show before the bot: {job}, no task yet', () => {
    const s = json<{ job: Job }>('job', 'show', plan.toLowerCase());
    assert.deepEqual(Object.keys(s), ['job']);
    assert.equal(s.job.id, plan);
    assert.match(jv('job', 'show', plan).stdout, new RegExp(`^${plan}  plan  sandbox  queued: waiting for the bot's next tick\\nRequest id plan:sandbox:\\d{4}-\\d{2}-\\d{2}\\.\\nCreated \\d{2}:\\d{2}\\.\\nNo task yet: the bot creates it at its next tick\\.`));
    assert.match(refusal(3, 'job', 'show', 'JZZZZZZ'), /no job JZZZZZZ/);
  });

  let planTask = '';
  test('the bot\'s step gives the job its plan task: single, duty plan, origin planner:<J>, request id job:<J>, not started', async () => {
    const s = await stepJobs(store, JOB_HANDLERS);
    assert.deepEqual(s.errors, []);
    assert.equal(s.started.length, 1);
    const job = store.getJob(plan)!;
    assert.equal(job.state, 'running');
    planTask = job.task_id!;
    const task = store.requireTask(planTask);
    assert.deepEqual([task.kind, task.origin, task.request_id, task.visible, task.state, task.state_reason], ['single', `planner:${plan}`, `job:${plan}`, 0, 'queued', QUEUED_FOR_THE_BOT]);
    assert.deepEqual(store.listSteps(planTask).map((x) => x.duty), ['plan']);
    assert.equal(store.listSessions({ task_id: planTask }).length, 0, 'the bot\'s admission starts it, not the jobs step');
    assert.match(task.task_text, /^You are planning the next tasks for the project "sandbox"/);
    assert.ok(task.task_text.includes(`- ${goal} (priority 1) Import contacts`));
    assert.deepEqual(JSON.parse(job.input_json), { maxTasks: 3, goals: [goal] });
    // Nothing changes while the plan task runs.
    assert.deepEqual((await stepJobs(store, JOB_HANDLERS)).finished, []);
  });

  let created: string[] = [];
  test('the plan task reports done: the proposed tasks are created queued and unstarted, with after links; the job is done', async () => {
    workerReports(planTask, block({ tasks: [
      { goal, kind: 'feature', duty: null, title: 'CSV upload endpoint', text: 'Add POST /contacts/import that takes a CSV.', after: null },
      { goal, kind: 'feature', title: 'Row errors page', text: 'Show the errors of an import per row.', after: 0 },
      { goal, kind: 'single', duty: 'investigate', title: 'csv upload endpoint', text: 'The same title again.', after: null },
    ] }));
    const s = await stepJobs(store, JOB_HANDLERS);
    assert.deepEqual(s.finished, [{ job: plan, state: 'done', reason: 'created 2, skipped 1' }]);
    const show = json<{ job: Job }>('job', 'show', plan).job;
    assert.equal(show.state, 'done');
    assert.equal(show.taskState, 'done');
    assert.equal(typeof show.durationMs, 'number');
    created = show.result!.created as string[];
    assert.equal(created.length, 2);
    assert.deepEqual(show.result!.skipped, [{ title: 'csv upload endpoint', reason: 'the same title as an earlier task of this plan' }]);
    const tasks = json<{ tasks: Array<{ id: string; origin: string; state: string; after: string | null; kind: string }> }>('task', 'list', '--project', 'sandbox').tasks.filter((t) => t.origin === `planner:${plan}` && t.id !== planTask);
    assert.deepEqual(tasks.map((t) => t.id).sort(), [...created].sort());
    assert.ok(tasks.every((t) => t.state === 'queued' && t.kind === 'feature'));
    assert.equal(tasks.find((t) => t.id === created[1])!.after, created[0]);
    assert.equal(tasks.find((t) => t.id === created[0])!.after, null);
    for (const id of created) assert.equal(store.listSessions({ task_id: id }).length, 0, `${id} is not started`);
    assert.deepEqual(created.map((id) => store.requireTask(id).request_id), [`plan:${plan}:0`, `plan:${plan}:1`]);
  });

  test('a second run the same day returns the done job (exit 0, the same id) and creates nothing; --force makes a new one', () => {
    const jobs = store.listJobs().length;
    const tasks = store.listTasks().length;
    const again = json<{ job: Job; created: boolean }>('job', 'run', 'plan', '--project', 'sandbox');
    assert.deepEqual([again.created, again.job.id, again.job.state], [false, plan, 'done']);
    assert.equal(store.listJobs().length, jobs);
    assert.equal(store.listTasks().length, tasks);
    const forced = json<{ job: Job; created: boolean }>('job', 'run', 'plan', '--project', 'sandbox', '--force');
    assert.equal(forced.created, true);
    assert.notEqual(forced.job.id, plan);
    assert.ok(forced.job.requestId.startsWith(`plan:sandbox:${localDay(new Date())}:force:`));
    assert.equal(store.listJobs().length, jobs + 1);
    // Cancel: only a queued job. The forced one is queued; the done one and an unknown one are refused.
    const c = json<{ job: Job }>('job', 'cancel', forced.job.id);
    assert.deepEqual([c.job.state, c.job.reason], ['failed', 'cancelled by the owner']);
    assert.match(refusal(2, 'job', 'cancel', forced.job.id), /is failed; only a queued job can be cancelled/);
    assert.match(refusal(2, 'job', 'cancel', plan), /is done; only a queued job can be cancelled/);
    assert.match(refusal(3, 'job', 'cancel', 'JZZZZZZ'), /no job JZZZZZZ/);
  });

  test('list: {jobs}, newest first, by project; text one line per job, ids first, at most 100 characters', () => {
    const list = json<{ jobs: Job[] }>('job', 'list', '--project', 'sandbox');
    assert.deepEqual(Object.keys(list), ['jobs']);
    assert.equal(list.jobs.at(-1)!.id, plan);
    assert.match(refusal(3, 'job', 'list', '--project', 'nope'), /no project/);
    const text = jv('job', 'list').stdout.trimEnd().split('\n');
    assert.equal(text.length, list.jobs.length);
    assert.ok(text.every((l) => [...l].length <= 100), text.join('\n'));
    assert.match(text.at(-1)!, new RegExp(`^${plan}  plan  sandbox  done +${planTask}  \\d{2}:\\d{2}  \\d+ s +created 2, skipped 1$`));
  });
});

describe('jv improve and jv job run improve-*', () => {
  let a = '';
  let b = '';
  let job = '';
  test('jv improve memory is jv job run improve-memory: the same output; a second kind run while it is queued is refused', () => {
    a = json<{ id: string }>('memory', 'add', '--scope', 'project', '--project', 'sandbox', '--kind', 'environment', 'The sandbox pages are served by npm start on port 4173').id;
    b = json<{ id: string }>('memory', 'add', '--scope', 'project', '--project', 'sandbox', '--kind', 'environment', 'npm start serves the sandbox pages, on port 4173').id;
    const r = json<{ job: Job; created: boolean }>('improve', 'memory', '--project', 'sandbox');
    assert.equal(r.created, true);
    assert.deepEqual([r.job.kind, r.job.requestId], ['improve-memory', `improve-memory:sandbox:${localDay(new Date())}`]);
    job = r.job.id;
    assert.deepEqual(json('job', 'run', 'improve-memory', '--project', 'sandbox'), { ...r, created: false });
    assert.equal(refusal(2, 'improve', 'memory', '--project', 'sandbox', '--force'), `already running: ${job}`);
    assert.match(refusal(2, 'improve', 'everything', '--project', 'sandbox'), /unknown subcommand "improve everything"/);
    assert.match(refusal(2, 'improve'), /^jv improve memory\|docs\|skills --project N/);
    assert.match(refusal(2, 'improve', 'docs'), /--project is required/);
  });

  test('the improve-memory job runs to done: one near-duplicate archived with superseded_by, none deleted, the merge in result_json', async () => {
    const memories = (store.db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n;
    await stepJobs(store, JOB_HANDLERS);
    const running = store.getJob(job)!;
    assert.equal(running.state, 'running');
    const task = store.requireTask(running.task_id!);
    assert.deepEqual([task.origin, store.listSteps(task.id)[0]!.duty], [`improver:${job}`, 'investigate']);
    assert.ok(task.task_text.includes(`"id": "${a}"`) && task.task_text.includes(`"id": "${b}"`), 'the work task lists the memories');
    workerReports(task.id, block({ merge: [{ keep: a, archive: [b], text: null }], archive: [], add: [], expire: [] }));
    await stepJobs(store, JOB_HANDLERS);
    const done = json<{ job: Job }>('job', 'show', job).job;
    assert.equal(done.state, 'done', done.reason);
    assert.deepEqual(done.result!.merged, [{ keep: a, archived: [b] }]);
    assert.equal(memory.get(store.db, b)!.status, 'archived');
    assert.equal(memory.get(store.db, b)!.superseded_by, a);
    assert.equal(memory.get(store.db, a)!.status, 'active');
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n, memories, 'none deleted');
  });

  test('improve-docs is weekly: its request id names the ISO week', () => {
    const r = json<{ job: Job; created: boolean }>('improve', 'docs', '--project', 'sandbox');
    assert.deepEqual([r.created, r.job.requestId], [true, `improve-docs:sandbox:${isoWeek(new Date())}`]);
    assert.match(jv('improve', 'docs', '--project', 'sandbox').stdout, new RegExp(`^${r.job.id} is the improve-docs job of sandbox for this week`));
  });

  test('improve-skills is refused until jevellan-skills is registered; jv project add gives it riskyPaths ["**"]', () => {
    assert.match(refusal(2, 'improve', 'skills'), /^register jevellan-skills first: jv project add ~\/dev\/jevellan-skills --name jevellan-skills$/);
    assert.match(refusal(2, 'job', 'run', 'improve-skills', '--project', 'sandbox'), /register jevellan-skills first/);
    const skillsRepo = makeRepo('skills-checkout');
    const added = json<{ project: { name: string }; files: Record<string, string> }>('project', 'add', skillsRepo, '--name', 'jevellan-skills');
    assert.deepEqual([added.project.name, added.files['landing.json']], ['jevellan-skills', 'created']);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'projects', 'jevellan-skills', 'landing.json'), 'utf8')), { riskyPaths: ['**'], checks: [] });
    // Any other project keeps the template as it is.
    json('project', 'add', makeRepo('plain'), '--name', 'plain');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'projects', 'plain', 'landing.json'), 'utf8')), { riskyPaths: [], checks: [] });
    const r = json<{ job: Job; created: boolean }>('improve', 'skills');
    assert.deepEqual([r.created, r.job.project, r.job.requestId], [true, 'jevellan-skills', `improve-skills:${isoWeek(new Date())}`]);
    assert.equal(json<{ job: Job }>('job', 'run', 'improve-skills', '--project', 'sandbox').job.id, r.job.id, 'improve-skills always runs on jevellan-skills');
  });

  test('jv --help lists the three commands', () => {
    const help = helpText();
    assert.match(help, /^ {2}jv goal add\|list\|show\|done\|pause /m);
    assert.match(help, /^ {2}jv job run <kind> --project N \[--force\] \| jv job list \[--project N\] \| jv job show\|cancel J$/m);
    assert.match(help, /^ {2}jv improve memory\|docs\|skills --project N \[--force\]$/m);
  });
});
