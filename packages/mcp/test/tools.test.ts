// jevellan-mcp through the SDK's Client over InMemoryTransport (brief section 5): tools/list names every tool of the
// section with a JSON Schema built from its zod 4 input; the read tools return structuredContent equal to what `jv ...
// --json` prints on the same store (the command line's main() runs in this process), or to the view function the
// command calls where that command belongs to another package's work (schedules, goals, jobs, the bot); jv_task_create
// creates a task with origin mcp through fake placement and spawn; refusals are error results with {error, exitCode};
// resources return the tools' JSON; the call log has one line per call and none of the arguments. A temporary JV_HOME
// and git repository; no model, Jev, provider or tmux is reached.

import assert from 'node:assert/strict';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildFixture, cliJson, fakeTaskDeps, loadCli, makeHome, readText } from './fixtures/home.js';

const coreRoot = dirname(createRequire(import.meta.url).resolve('jevellan-core/package.json'));
const home = makeHome('jv-mcp-tools-test-', coreRoot);
const main = await loadCli(coreRoot);
const { openStore } = await import('jevellan-core/store');
const { coordinatorStatus } = await import('jevellan-core/coordinator');
const { runChecks } = await import('jevellan-core/doctor');
const { jobView } = await import('jevellan-core/jobs');
const { recordProviderAuth } = await import('jevellan-core/providers');
const { StatusSchema, TaskShowSchema } = await import('jevellan-core/contracts/index');
const { scheduleView } = await import('jevellan-scheduler');
const { goalView, listGoals } = await import('jevellan-planner');
const { createMcpServer, mcpLogFile } = await import('../src/server.js');
const { operationByName, operations, resources, TOOL_NAMES } = await import('../src/tools.js');
const { botStatusView } = await import('../src/views.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
type OpContext = import('../src/ops.js').OpContext;
type CallResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text?: string }> };

/** The tools of brief section 5, in its order. */
const SECTION_5 = [
  'jv_status',
  'jv_project_list',
  'jv_project_add',
  'jv_task_list',
  'jv_task_show',
  'jv_task_create',
  'jv_task_message',
  'jv_task_answer',
  'jv_task_stop',
  'jv_task_resume',
  'jv_task_override',
  'jv_task_changes',
  'jv_land',
  'jv_report_get',
  'jv_tail',
  'jv_coordinator_status',
  'jv_coordinator_message',
  'jv_coordinator_transcript',
  'jv_memory_search',
  'jv_memory_add',
  'jv_memory_archive',
  'jv_schedule_list',
  'jv_schedule_add',
  'jv_schedule_run',
  'jv_schedule_pause',
  'jv_schedule_resume',
  'jv_goal_list',
  'jv_goal_add',
  'jv_goal_done',
  'jv_job_list',
  'jv_job_run',
  'jv_usage',
  'jv_doctor',
  'jv_bot_status',
];

const store = openStore();
const fx = await buildFixture(store, home);
for (const p of ['claude-main']) recordProviderAuth(store, p, { auth: 'ready', observedAt: new Date().toISOString() });
const taskDeps = fakeTaskDeps(store);
const FIXED_NOW = new Date('2026-11-01T12:00:00.000Z');
const fakeTmux = () => ({ code: 1, stdout: '', stderr: "can't find session" });
const context: OpContext = {
  origin: 'mcp',
  deps: { task: taskDeps, coordinator: { tmux: fakeTmux }, now: () => FIXED_NOW, ownerHome: home, platform: 'darwin' },
};

const server = createMcpServer({ context });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'jv-mcp-test', version: '0.0.0' });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

after(async () => {
  await client.close();
  await server.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** Tool calls that reached an operation (and so the log). */
let logged = 0;
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  logged++;
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

async function data(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} failed: ${r.content.map((c) => c.text).join(' ')}`);
  assert.ok(r.structuredContent, `${name} has structured content`);
  assert.ok((r.content[0]?.text ?? '') !== '', `${name} has text for people`);
  return r.structuredContent;
}

const cli = (argv: string[]) => cliJson(main, argv);

test('tools/list: every tool of section 5 by name, each described by its jv command, with a JSON Schema input', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    SECTION_5,
  );
  assert.deepEqual(TOOL_NAMES, SECTION_5);
  for (const t of tools) {
    assert.match(t.description ?? '', /\bjv\b|jv_/, `${t.name} names the jv command it mirrors`);
    assert.ok(!/\.\s+\S/.test(t.description ?? ''), `${t.name}: one sentence`);
    assert.equal(t.inputSchema.type, 'object');
  }
  // zod 4 schemas went through the SDK's own conversion: properties and required fields are there.
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const t of tools) {
    const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>);
    if (['jv_project_list', 'jv_doctor', 'jv_bot_status'].includes(t.name)) assert.deepEqual(props, [], t.name);
    else assert.ok(props.length > 0, `${t.name} lists its input properties`);
  }
  const create = byName.get('jv_task_create')!.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] };
  assert.deepEqual(Object.keys(create.properties), ['project', 'kind', 'duty', 'title', 'text', 'parent', 'after', 'visible']);
  assert.deepEqual([...(create.required ?? [])].sort(), ['kind', 'project', 'text', 'title']);
  assert.deepEqual(create.properties.kind!.enum, ['feature', 'bug', 'automation', 'single']);
  const override = byName.get('jv_task_override')!.inputSchema as { properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(override.properties.mode!.enum, ['undo', 'keep']);
});

test('the server instructions are the coordinator skill with the tool names', () => {
  const text = client.getInstructions() ?? '';
  assert.match(text, /^This server operates Jevellan/);
  assert.match(text, /jv_task_create/);
  assert.ok(!text.includes('{{'), 'no unfilled placeholder');
});

test('mutating tools are marked, read tools are not', () => {
  const reads = operations.filter((o) => !o.mutates).map((o) => o.name);
  assert.deepEqual(reads, [
    'jv_status',
    'jv_project_list',
    'jv_task_list',
    'jv_task_show',
    'jv_task_changes',
    'jv_report_get',
    'jv_tail',
    'jv_coordinator_status',
    'jv_coordinator_transcript',
    'jv_memory_search',
    'jv_schedule_list',
    'jv_goal_list',
    'jv_job_list',
    'jv_usage',
    'jv_doctor',
    'jv_bot_status',
  ]);
  assert.equal(operationByName('jv_land').name, 'jv_land');
  assert.throws(() => operationByName('jv_nothing'), /no operation jv_nothing/);
});

test('jv_status equals jv status --json, and the status contract', async () => {
  await cli(['status']); // a first reading marks what it marks; both below read the same store
  const mcp = await data('jv_status');
  const { code, json } = await cli(['status']);
  assert.equal(code, 0);
  assert.deepEqual(mcp, json);
  StatusSchema.parse(mcp);
  assert.deepEqual(await data('jv_status', { project: 'sandbox' }), (await cli(['status', '--project', 'sandbox'])).json);
});

test('jv_project_list equals jv project list --json, as {projects}', async () => {
  const mcp = await data('jv_project_list');
  const { json } = await cli(['project', 'list']);
  assert.deepEqual(mcp, { projects: json });
  assert.equal((mcp.projects as unknown[]).length, 1);
});

test('jv_task_list and jv_task_show equal jv task list|show --json', async () => {
  assert.deepEqual(await data('jv_task_list'), (await cli(['task', 'list'])).json);
  assert.deepEqual(await data('jv_task_list', { project: 'sandbox', state: 'queued', limit: 5 }), (await cli(['task', 'list', '--project', 'sandbox', '--state', 'queued', '--limit', '5'])).json);
  const show = await data('jv_task_show', { task: fx.asked });
  assert.deepEqual(show, (await cli(['task', 'show', fx.asked])).json);
  TaskShowSchema.parse(show);
  // A lower-case id is the same task, as on the command line.
  assert.deepEqual(await data('jv_task_show', { task: fx.asked.toLowerCase() }), show);
});

test('jv_report_get equals jv report S --json', async () => {
  const mcp = await data('jv_report_get', { session: fx.askedRun });
  assert.deepEqual(mcp, (await cli(['report', fx.askedRun])).json);
  assert.equal(mcp.question, 'Which colour?');
});

test('jv_tail: the events of jv tail S --json in one page; long text cut to 2000 characters; at most 200', async () => {
  const page = await data('jv_tail', { session: fx.askedRun });
  const lines = (await cliJson(main, ['tail', fx.askedRun], { lines: true })).json as unknown[];
  assert.deepEqual(page.events, lines);
  assert.equal(page.more, false);
  assert.equal(page.nextSeq, (lines.at(-1) as { seq: number }).seq);

  const long = await data('jv_tail', { session: fx.longRun, limit: 2 });
  const events = long.events as Array<{ seq: number; payload: { text: string }; truncated?: true }>;
  assert.equal(events.length, 2);
  assert.equal(events[0]!.payload.text.length, 2000);
  assert.equal(events[0]!.truncated, true);
  assert.equal(events[1]!.truncated, undefined);
  assert.equal(long.more, true);
  const next = await data('jv_tail', { session: fx.longRun, sinceSeq: long.nextSeq, limit: 500 });
  assert.equal((next.events as unknown[]).length, 3);
  assert.equal(next.more, false);
});

test('jv_usage equals jv usage --json, for this week and a given week', async () => {
  assert.deepEqual(await data('jv_usage'), (await cli(['usage'])).json);
  assert.deepEqual(await data('jv_usage', { week: '2026-W44' }), (await cli(['usage', '--week', '2026-W44'])).json);
});

/** A search result without the rank scores, which age with the clock between two searches. */
function unscored(v: unknown): unknown {
  const r = v as { memories: Array<Record<string, unknown>> };
  return { ...r, memories: r.memories.map(({ score: _score, ...m }) => m) };
}

test('jv_memory_search equals jv memory search --json; jv_memory_add writes with source mcp and memory.md; archive', async () => {
  assert.deepEqual(unscored(await data('jv_memory_search', { query: 'npm ci' })), unscored((await cli(['memory', 'search', 'npm ci'])).json));
  const scoped = await data('jv_memory_search', { query: 'npm ci', project: 'sandbox' });
  assert.deepEqual(unscored(scoped), unscored((await cli(['memory', 'search', '--project', 'sandbox', 'npm ci'])).json));
  assert.equal(typeof (scoped.memories as Array<{ score: unknown }>)[0]!.score, 'number');
  assert.deepEqual(
    (scoped.memories as Array<{ id: string }>).map((m) => m.id),
    [fx.memory],
  );

  const added = await data('jv_memory_add', { kind: 'lesson', text: 'Seed ekoa-data before the browser tests', tags: ['Tests'], scope: 'project', project: 'sandbox' });
  assert.equal(added.created, true);
  const m = added.memory as { id: string; source: string; scope: string; tags: string[] };
  assert.equal(m.source, 'mcp');
  assert.equal(m.scope, 'project:sandbox');
  assert.deepEqual(m.tags, ['tests']);
  assert.match(readText(join(home, 'projects', 'sandbox', 'memory.md')), new RegExp(m.id));
  const again = await data('jv_memory_add', { kind: 'lesson', text: 'Seed  ekoa-data before the browser tests', scope: 'project', project: 'sandbox' });
  assert.deepEqual([again.created, again.id], [false, m.id]);

  const archived = await data('jv_memory_archive', { id: m.id, reason: 'obsolete' });
  assert.equal((archived.memory as { status: string }).status, 'archived');
  const list = (await cli(['memory', 'list', '--status', 'archived'])).json as { memories: Array<{ id: string }> };
  assert.deepEqual(
    list.memories.map((x) => x.id),
    [m.id],
  );
});

test('jv_coordinator_status equals coordinatorStatus on the same tmux; the transcript of a project without one', async () => {
  const mcp = await data('jv_coordinator_status', { project: 'sandbox' });
  assert.deepEqual(mcp, JSON.parse(JSON.stringify(coordinatorStatus(store, 'sandbox', { tmux: fakeTmux }))));
  assert.equal(mcp.running, false);
  assert.deepEqual(await data('jv_coordinator_transcript', { project: 'sandbox', limit: 10 }), { project: 'sandbox', session: null, entries: [], turns: [] });
});

test('schedules: list, add, pause, resume and run are the scheduler views', async () => {
  const list = await data('jv_schedule_list');
  assert.deepEqual(list, JSON.parse(JSON.stringify({ schedules: store.listSchedules().map((s) => scheduleView(store, s, FIXED_NOW)) })));
  assert.deepEqual(await data('jv_schedule_list', { project: 'sandbox' }), list);

  const added = (await data('jv_schedule_add', {
    project: 'sandbox',
    name: 'Nightly tests',
    cron: '0 3 * * *',
    tz: 'Europe/Lisbon',
    kind: 'task',
    task: { kind: 'single', duty: 'verify', title: 'Nightly tests', text: 'Run the tests. Report testsRun.' },
  })).schedule as Record<string, unknown>;
  assert.deepEqual(added, JSON.parse(JSON.stringify(scheduleView(store, store.getSchedule(added.id as string)!, FIXED_NOW))));
  assert.equal(added.nextRunAt, '2026-11-02T03:00:00.000Z');
  assert.deepEqual(added.spec, { kind: 'single', duty: 'verify', title: 'Nightly tests', text: 'Run the tests. Report testsRun.', visible: false });

  const paused = (await data('jv_schedule_pause', { schedule: added.id as string })).schedule as Record<string, unknown>;
  assert.equal(paused.enabled, false);
  const resumed = (await data('jv_schedule_resume', { schedule: (added.id as string).toLowerCase() })).schedule as Record<string, unknown>;
  assert.equal(resumed.enabled, true);

  const ran = await data('jv_schedule_run', { schedule: fx.schedule });
  assert.match(String(ran.result), /^created J[0-9A-Z]{6} \(run now\)$/);
  assert.equal(ran.job, String(ran.result).split(' ')[1]);
  assert.deepEqual(ran.schedule, JSON.parse(JSON.stringify(scheduleView(store, store.getSchedule(fx.schedule)!, FIXED_NOW))));

  const bad = await call('jv_schedule_add', { project: 'sandbox', name: 'Never', cron: '0 0 31 2 *', kind: 'job', job: 'plan' });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent?.exitCode, 2);
});

test('goals: list, add and done are the planner views', async () => {
  const list = await data('jv_goal_list', { project: 'sandbox' });
  assert.deepEqual(list, { goals: listGoals(store, { project: 'sandbox' }).map((g) => goalView(store, g)) });
  const added = (await data('jv_goal_add', { project: 'sandbox', title: 'Search by name', text: 'Customers can be found by name.', priority: 1 })).goal as Record<string, unknown>;
  assert.deepEqual(added, goalView(store, store.getGoal(added.id as string)!));
  const done = (await data('jv_goal_done', { goal: fx.goal })).goal as Record<string, unknown>;
  assert.equal(done.state, 'done');
  assert.deepEqual((await data('jv_goal_list')).goals, listGoals(store).map((g) => goalView(store, g)));
});

test('jobs: list is jobView; run returns the job of the day, refuses a busy kind and an unregistered jevellan-skills', async () => {
  const list = await data('jv_job_list', { project: 'sandbox' });
  assert.deepEqual(list, JSON.parse(JSON.stringify({ jobs: store.listJobs({ project_id: fx.projectId }).map((j) => jobView(store, j)) })));

  const same = await data('jv_job_run', { project: 'sandbox', kind: 'plan' });
  assert.equal(same.created, false);
  assert.equal((same.job as { id: string }).id, fx.job);

  const forced = await call('jv_job_run', { project: 'sandbox', kind: 'plan', force: true });
  assert.equal(forced.isError, true);
  assert.equal(forced.structuredContent?.exitCode, 2);
  assert.match(String(forced.structuredContent?.error), /already running: J/);

  const skills = await call('jv_job_run', { project: 'sandbox', kind: 'improve-skills' });
  assert.deepEqual(skills.structuredContent, { error: 'register jevellan-skills first: jv project add ~/dev/jevellan-skills --name jevellan-skills', exitCode: 2 });

  const memoryJob = await data('jv_job_run', { project: 'sandbox', kind: 'improve-memory' });
  assert.equal(memoryJob.created, true);
  const job = memoryJob.job as Record<string, unknown>;
  assert.deepEqual(job, JSON.parse(JSON.stringify(jobView(store, store.getJob(job.id as string)!))));
  assert.deepEqual([job.kind, job.state, job.project], ['improve-memory', 'queued', 'sandbox']);
});

test('jv_bot_status: the heartbeat, bot.json over the defaults and the service file', async () => {
  const v = await data('jv_bot_status');
  assert.deepEqual(v, JSON.parse(JSON.stringify(botStatusView(store, FIXED_NOW.getTime(), { home, platform: 'darwin' }))));
  assert.equal((v.bot as { alive: boolean }).alive, false);
  assert.deepEqual(v.config, { tickSeconds: 15, limits: { perProject: 100, total: 100 }, quietHours: null, health: { bind: '127.0.0.1', port: 7073 }, logLines: 20000 });
  assert.deepEqual(v.service, { file: join(home, 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist'), installed: false });
});

test('jv_doctor: {ok, checks} of the doctor; a FAIL makes it an error result that keeps the data', async () => {
  const doctorDeps = {
    exec: async () => ({ code: null, stdout: '', stderr: '', error: 'not-found' }),
    fetch: (async () => {
      throw new Error('no network in tests');
    }) as unknown as typeof fetch,
    cwd: home,
    env: { PATH: '/usr/bin:/bin' },
    freeBytes: () => 100 * 1024 ** 3,
    probeTimeoutMs: 1000,
    codexProbe: async () => {
      throw new Error('no codex in tests');
    },
    claudeModels: async () => [],
    recordAuth: () => undefined,
    platform: 'linux' as const,
    ownerHome: home,
    fts5Probe: () => undefined,
    findFts5Node: async () => undefined,
  };
  const ctx: OpContext = { origin: 'mcp', deps: { doctor: doctorDeps } };
  const r = await operationByName('jv_doctor').run({}, ctx);
  const expected = await runChecks([], doctorDeps);
  assert.deepEqual(r.data, { ok: !expected.some((c) => c.status === 'FAIL'), checks: expected });
  assert.equal(r.data.ok, false, 'no git, tmux or claude: FAIL lines');
  assert.equal(r.exitCode, 2);

  const doctorServer = createMcpServer({ context: ctx, instructions: '' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'doctor', version: '0' });
  await Promise.all([doctorServer.connect(b), c.connect(a)]);
  const res = (await c.callTool({ name: 'jv_doctor', arguments: {} })) as CallResult;
  logged++;
  assert.equal(res.isError, true);
  assert.equal((res.structuredContent as { ok: boolean }).ok, false);
  assert.ok(Array.isArray(res.structuredContent?.checks));
  await c.close();
  await doctorServer.close();
});

let created: { id: string; worktree: string };
test('jv_task_create creates a task with origin mcp and starts step 1, the JSON of jv task create', async () => {
  const input = { project: 'sandbox', kind: 'single', duty: 'investigate', title: 'Where does the app start', text: 'Name the file and line where the app starts.' };
  const r = await data('jv_task_create', input);
  // The keys of jv task create --json (questions when the workflow questions were answered; no worktree key).
  assert.deepEqual(Object.keys(r), ['task', 'steps', 'created', 'workflow', 'questions', 'start', 'warnings']);
  const task = r.task as { id: string; origin: string; state: string; worktree_path: string };
  assert.equal(task.origin, 'mcp');
  assert.equal(r.created, true);
  assert.equal((r.start as { state: string }).state, 'started');
  assert.equal(store.requireTask(task.id).origin, 'mcp');
  assert.equal(taskDeps.spawned.length, 1);
  assert.ok(existsSync(task.worktree_path));
  created = { id: task.id, worktree: task.worktree_path };
  const show = (await cli(['task', 'show', task.id])).json as { origin: string };
  assert.equal(show.origin, 'mcp');

  // The same input is the same task (the request id), and nothing starts twice.
  const again = await data('jv_task_create', input);
  assert.equal(again.created, false);
  assert.equal((again.task as { id: string }).id, task.id);
  assert.equal(taskDeps.spawned.length, 1);

  // Through the UI the same operation writes origin ui.
  const ui = await operationByName('jv_task_create').run(
    { project: 'sandbox', kind: 'single', duty: 'investigate', title: 'From the UI', text: 'Where are the tests?' },
    { origin: 'ui', deps: { task: taskDeps } },
  );
  assert.equal((ui.data.task as { origin: string }).origin, 'ui');
});

test('jv_task_changes equals jv task changes T --json; message; stop with discard keeps the worktree', async () => {
  writeFileSync(join(created.worktree, 'NOTES.md'), 'entry point: src/main.ts\n');
  assert.deepEqual(await data('jv_task_changes', { task: created.id }), (await cli(['task', 'changes', created.id])).json);
  assert.deepEqual(await data('jv_task_changes', { task: created.id, stat: true }), (await cli(['task', 'changes', created.id, '--stat'])).json);

  const msg = await data('jv_task_message', { task: created.id, text: 'Also name the test command.' });
  assert.equal((msg.message as { direction: string }).direction, 'owner');

  const stopped = await data('jv_task_stop', { task: created.id, discard: true });
  assert.equal((stopped.task as { state: string }).state, 'stopped');
  assert.equal(stopped.discarded, true);
  assert.ok(statSync(created.worktree).isDirectory(), 'the worktree stays');
});

test('refusals are error results with {error, exitCode}; schema errors are the SDK\'s', async () => {
  const unknown = await call('jv_task_show', { task: 'TZZZZZZ' });
  assert.equal(unknown.isError, true);
  assert.deepEqual(unknown.structuredContent, { error: 'no task TZZZZZZ', exitCode: 3 });

  const noProject = await call('jv_task_create', { project: 'nowhere', kind: 'feature', title: 'X', text: 'Y' });
  assert.equal(noProject.isError, true);
  assert.equal(noProject.structuredContent?.exitCode, 3);

  const scope = await call('jv_memory_add', { kind: 'fact', text: 'Something', scope: 'project' });
  assert.deepEqual(scope.structuredContent, { error: 'project is required for scope project', exitCode: 2 });

  const landing = await call('jv_land', { task: fx.queued });
  assert.equal(landing.isError, true);
  assert.equal(landing.structuredContent?.exitCode, 2);

  const invalid = (await client.callTool({ name: 'jv_task_show', arguments: {} })) as CallResult;
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.match(invalid.content[0]?.text ?? '', /Input validation error/);
});

test('resources: jv://status, jv://tasks/{id} and jv://sessions/{id}/report give the tools\' JSON', async () => {
  const { resources: fixed } = await client.listResources();
  assert.deepEqual(
    fixed.map((r) => r.uri),
    ['jv://status'],
  );
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.deepEqual(
    resourceTemplates.map((t) => t.uriTemplate),
    ['jv://tasks/{id}', 'jv://sessions/{id}/report'],
  );
  assert.equal(resources.length, 3);
  const read = async (uri: string) => {
    const r = await client.readResource({ uri });
    assert.equal(r.contents[0]?.mimeType, 'application/json');
    return JSON.parse(String((r.contents[0] as { text: string }).text)) as unknown;
  };
  assert.deepEqual(await read('jv://status'), await data('jv_status'));
  assert.deepEqual(await read(`jv://tasks/${fx.asked}`), await data('jv_task_show', { task: fx.asked }));
  assert.deepEqual(await read(`jv://sessions/${fx.askedRun}/report`), await data('jv_report_get', { session: fx.askedRun }));
  await assert.rejects(client.readResource({ uri: 'jv://tasks/TZZZZZZ' }), /no task TZZZZZZ/);
});

test('the call log: one line per call with the tool, ids, duration and exit code, never the arguments', () => {
  const text = readText(mcpLogFile());
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, logged);
  for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT\S+Z jv_[a-z_]+( project=\S+)?( task=\S+)? \d+ms exit=[0-4]$/);
  assert.ok(lines.some((l) => /^\S+ jv_task_show task=TZZZZZZ \d+ms exit=3$/.test(l)));
  assert.ok(lines.some((l) => /^\S+ jv_task_create project=sandbox \d+ms exit=0$/.test(l)));
  assert.ok(lines.some((l) => /^\S+ jv_doctor \d+ms exit=2$/.test(l)));
  for (const secret of ['Name the file and line', 'Seed ekoa-data', 'Run the tests', 'npm ci', 'Also name the test command', 'obsolete']) {
    assert.ok(!text.includes(secret), `the log does not hold "${secret}"`);
  }
  assert.equal(statSync(mcpLogFile()).mode & 0o777, 0o600);
});
