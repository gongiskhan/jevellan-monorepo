// jv schedule add|list|show|run|pause|resume (brief section 9) end to end through the command line, on a temporary
// JV_HOME with a git repository: add (a task schedule, a job schedule) and its refusals with their exit codes, list
// and show (text: ids first, local times, lines of at most 100 characters; --json: the scheduler's views), pause and
// resume, run of a job schedule (a queued job row, next run unmoved) and of a task schedule (the task is created as
// jv task create creates it; Jev has no key in this home, so its start is refused without any network call and the
// run records the queued task with a warning).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-schedule-command-test-');
process.env.JV_HOME = home;
const { main, COMMANDS } = await import('../src/cli.js');
const { openStore } = await import('jevellan-core/store');
const { recordProviderAuth } = await import('jevellan-core/providers');

const repo = join(home, 'repos', 'sandbox');
mkdirSync(repo, { recursive: true });
const gitIn = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
gitIn('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# sandbox\n');
gitIn('add', '.');
gitIn('commit', '-q', '-m', 'first');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' });
for (const p of ['claude-main', 'glm']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });

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
const json = <T>(r: { out: string }) => JSON.parse(r.out) as T;
type View = { id: string; project: string; name: string; cron: string; tz: string; kind: string; spec: Record<string, unknown>; enabled: boolean; nextRunAt: string; nextRuns: string[]; lastRunAt: string | null; lastResult: string };

const taskArgs = ['--task-kind', 'single', '--duty', 'implement', '--title', 'Nightly tests', '--text', 'Run the tests and report testsRun.'];
let nightly: View;
let plan: View;

test('jv schedule is in the command table with --visible as a flag', () => {
  assert.equal(COMMANDS.schedule!.module, './commands/schedule.js');
  assert.deepEqual(COMMANDS.schedule!.booleans, ['visible']);
  assert.match(COMMANDS.schedule!.usage, /^jv schedule add\|list\|show\|run\|pause\|resume/);
});

test('add: a task schedule and a job schedule; {schedule: view}; the text names the next run', async () => {
  const a = await jv('schedule', 'add', '--project', 'sandbox', '--name', 'Nightly tests', '--cron', '0 3 * * *', '--tz', 'Europe/Lisbon', ...taskArgs, '--json');
  assert.equal(a.code, 0, a.err);
  nightly = json<{ schedule: View }>(a).schedule;
  assert.match(nightly.id, /^C[0-9A-Z]{6}$/);
  assert.equal(nightly.tz, 'Europe/Lisbon');
  assert.deepEqual(nightly.spec, { kind: 'single', duty: 'implement', title: 'Nightly tests', text: 'Run the tests and report testsRun.', visible: false });
  assert.equal(nightly.nextRuns.length, 3);
  const b = await jv('schedule', 'add', '--project', 'sandbox', '--name', 'Plan', '--cron', '30 3 * * *', '--job', 'plan');
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /^C[0-9A-Z]{6} Plan: added, 30 3 \* \* \* in \S+, next run (\d{4}-\d\d-\d\d )?\d\d:\d\d\n$/);
  plan = json<{ schedules: View[] }>(await jv('schedule', 'list', '--json')).schedules.find((s) => s.name === 'Plan')!;
  assert.equal(plan.kind, 'job');
  assert.deepEqual(plan.spec, { job: 'plan' });
});

test('add refuses what it cannot run, with the exit codes', async () => {
  const add = (...extra: string[]) => jv('schedule', 'add', '--project', 'sandbox', '--name', `x${Math.random()}`, '--cron', '0 4 * * *', ...extra);
  assert.equal((await add(...taskArgs, '--job', 'plan')).code, 2, 'a task and a job');
  assert.equal((await add()).code, 2, 'neither');
  assert.match((await add('--job', 'plan', '--title', 'x')).err, /--title is for task schedules/);
  assert.equal((await add('--job', 'nap')).code, 2);
  assert.match((await jv('schedule', 'add', '--project', 'sandbox', '--name', 'y', '--cron', '0 3 * *', '--job', 'plan')).err, /five fields/);
  assert.equal((await jv('schedule', 'add', '--project', 'nope', '--name', 'y', '--cron', '0 3 * * *', '--job', 'plan')).code, 3);
  assert.equal((await jv('schedule', 'add', '--project', 'sandbox', '--name', 'Plan', '--cron', '0 5 * * *', '--job', 'plan')).code, 4, 'one name per project');
  assert.equal((await jv('schedule', 'add', '--project', 'sandbox', '--cron', '0 5 * * *', '--job', 'plan')).code, 2, '--name is required');
});

test('list and show: ids first, local times, at most 100 characters; by id or by name with --project', async () => {
  const list = await jv('schedule', 'list', '--project', 'sandbox');
  assert.equal(list.code, 0);
  const lines = list.out.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.match(l, /^C[0-9A-Z]{6} {2}/);
    assert.ok(l.length <= 100, l);
    assert.match(l, /next (\d{4}-\d\d-\d\d )?\d\d:\d\d +enabled +not run yet$/);
  }
  const byName = await jv('schedule', 'show', 'Nightly tests', '--project', 'sandbox', '--json');
  assert.equal(json<{ schedule: View }>(byName).schedule.id, nightly.id);
  const byId = await jv('schedule', 'show', nightly.id.toLowerCase());
  assert.match(byId.out, new RegExp(`^${nightly.id} Nightly tests \\(sandbox\\)\\ncron 0 3 \\* \\* \\* in Europe/Lisbon; enabled\\nruns a single implement task "Nightly tests"\\nnext runs: `));
  assert.equal((await jv('schedule', 'show', 'Nightly tests')).code, 3, 'a name needs its project');
  assert.equal((await jv('schedule', 'show', 'CZZZZZZ')).code, 3);
  assert.equal((await jv('schedule', 'list', '--project', 'nope')).code, 3);
});

test('pause and resume flip enabled; resume computes the next run from now', async () => {
  const p = await jv('schedule', 'pause', plan.id, '--json');
  assert.equal(json<{ schedule: View }>(p).schedule.enabled, false);
  assert.match((await jv('schedule', 'list')).out, /next - +paused +not run yet/);
  const r = await jv('schedule', 'resume', 'Plan', '--project', 'sandbox');
  assert.match(r.out, /^C[0-9A-Z]{6} Plan: resumed, next run /);
  const v = json<{ schedule: View }>(await jv('schedule', 'show', plan.id, '--json')).schedule;
  assert.equal(v.enabled, true);
  assert.ok(Date.parse(v.nextRunAt) > Date.now());
});

test('run of a job schedule queues a job now, without moving the next run', async () => {
  const before = store.getSchedule(plan.id)!.next_run_at;
  const r = await jv('schedule', 'run', plan.id, '--json');
  assert.equal(r.code, 0, r.err);
  const out = json<{ schedule: View; result: string; job: string }>(r);
  assert.deepEqual(Object.keys(out), ['schedule', 'result', 'job']);
  assert.match(out.result, /^created J[0-9A-Z]{6} \(run now\)$/);
  const job = store.getJob(out.job)!;
  assert.equal(job.state, 'queued');
  assert.match(job.request_id, new RegExp(`^schedule:${plan.id}:run:`));
  assert.equal(store.getSchedule(plan.id)!.next_run_at, before);
  assert.equal(out.schedule.lastResult, out.result);
});

test('run of a task schedule creates the task as jv task create does; a refused start leaves it queued and is a warning', async () => {
  const r = await jv('schedule', 'run', 'Nightly tests', '--project', 'sandbox', '--json');
  assert.equal(r.code, 0, r.err);
  const out = json<{ schedule: View; result: string; task: string }>(r);
  assert.match(out.result, /^created T[0-9A-Z]{6} \(run now\)$/);
  const task = store.getTask(out.task)!;
  assert.equal(task.origin, `schedule:${nightly.id}`);
  assert.equal(task.state, 'queued');
  assert.match(task.title, /^Nightly tests \d{4}-\d\d-\d\d$/);
  assert.match(r.err, /^jv: .*task T[0-9A-Z]{6} is queued/m, 'Jev has no key here: the start was refused, the task kept');
  const text = await jv('schedule', 'list');
  assert.match(text.out, new RegExp(`created ${out.task} \\(run now\\)`));
});
