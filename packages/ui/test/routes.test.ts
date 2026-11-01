// jv ui routes (brief section 7, the UI route contract): every operation-backed route calls the operation of section
// 5 by name with the input built from the path, the query and the body, origin 'ui', and answers its data; schema and
// operation refusals map to {error, exitCode} with 400, 404 or 409; and the routes only the UI has (A2UI actions,
// the coordinator start, notes, workflows, the schedule preview, pausing a goal, decisions, the memory list, the bot
// extras) do what the contract says. Fake operations record their calls; no model, Jev or tmux is reached.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome, seedTask } from './fixtures/run-fixture.js';
import { Client, fakeOperations, type FakeSchemaKey } from './fixtures/server-fixture.js';
import { FakeTmux, writeCoordinatorHome } from './fixtures/coordinator-fixture.js';
import type { Operation } from 'jevellan-mcp/ops';
import type { UiOperation } from '../server/operations.js';

// Compile-time check: jevellan-mcp's operations table fits startUiServer({operations}) as it is (zod 4 schemas and
// all), so jv ui can pass it without an adapter.
export const operationsFit: (ops: readonly Operation[]) => readonly UiOperation[] = (ops) => ops;

const home = makeHome('jv-ui-routes-test-');
process.env.JV_HOME = home;
writeCoordinatorHome(home);
const { openStore } = await import('jevellan-core/store');
const { JvError } = await import('jevellan-core/errors');
const { nextRuns } = await import('jevellan-scheduler/cron');
const { startUiServer, OPERATION_ROUTES, missingOperations } = await import('../server/server.js');

const store = openStore();
const seeded = seedTask(store, home, { name: 'sandbox' });

const S: FakeSchemaKey = { type: 'string' };
const SR: FakeSchemaKey = { type: 'string', required: true };
const N: FakeSchemaKey = { type: 'number' };
const B: FakeSchemaKey = { type: 'boolean' };
const O: FakeSchemaKey = { type: 'object' };
const read = (keys: Record<string, FakeSchemaKey> = {}) => ({ mutates: false, keys });
const write = (keys: Record<string, FakeSchemaKey> = {}) => ({ mutates: true, keys });

/** The tools of brief section 5 with their inputs. */
const fakes = fakeOperations({
  jv_status: read({ project: S }),
  jv_project_list: read(),
  jv_project_add: write({ path: SR, name: S }),
  jv_task_list: read({ project: S, state: S, limit: N }),
  jv_task_show: read({ task: SR }),
  jv_task_create: write({ project: SR, kind: SR, duty: S, title: SR, text: SR, parent: S, after: S, visible: B }),
  jv_task_message: write({ task: SR, text: SR }),
  jv_task_answer: write({ task: SR, answer: SR }),
  jv_task_stop: write({ task: SR, discard: B }),
  jv_task_resume: write({ task: SR }),
  jv_task_override: write({ task: SR, model: SR, effort: S, provider: S, mode: SR }),
  jv_task_changes: read({ task: SR, stat: B }),
  jv_land: write({ task: SR, force: B }),
  jv_report_get: read({ session: SR }),
  jv_tail: read({ session: SR, sinceSeq: N, limit: N }),
  jv_coordinator_status: read({ project: SR }),
  jv_coordinator_message: write({ project: SR, text: SR }),
  jv_coordinator_transcript: read({ project: SR, limit: N }),
  jv_memory_search: read({ query: SR, project: S, limit: N }),
  jv_memory_add: write({ kind: SR, text: SR, tags: O, scope: SR, project: S }),
  jv_memory_archive: write({ id: SR, reason: SR }),
  jv_schedule_list: read({ project: S }),
  jv_schedule_add: write({ project: SR, name: SR, cron: SR, tz: S, kind: SR, task: O, job: S }),
  jv_schedule_run: write({ schedule: SR }),
  jv_schedule_pause: write({ schedule: SR }),
  jv_schedule_resume: write({ schedule: SR }),
  jv_goal_list: read({ project: S }),
  jv_goal_add: write({ project: SR, title: SR, text: SR, priority: N }),
  jv_goal_done: write({ goal: SR }),
  jv_job_list: read({ project: S }),
  jv_job_run: write({ project: SR, kind: SR, force: B }),
  jv_usage: read({ week: S }),
  jv_doctor: read(),
  jv_bot_status: read(),
});
const SECTION_5_TOOLS = fakes.operations.map((o) => o.name);

const memoryCalls: unknown[] = [];
const tmux = new FakeTmux();
const ui = await startUiServer({
  port: 0,
  operations: fakes.operations,
  logFile: false,
  tail: () => undefined,
  listMemories: (_store, filter) => {
    memoryCalls.push(filter);
    return { memories: [{ id: 'M1ABCD', kind: 'fact', text: 'made-up memory' }] };
  },
  nextRuns,
  coordinatorDeps: {
    tmux: tmux.run,
    jvCommand: '/opt/jv/bin/jv',
    claudePath: '/usr/bin/claude',
    sleep: async () => {},
    readyTimeoutMs: 50,
    stopWaitMs: 50,
    readCmdline: (pid: number) => tmux.cmdline(pid),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  },
});
const client = new Client(ui.url);
await client.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

type Case = [method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, operation: string, input: Record<string, unknown>];

const T = 'T1AAB2';
const CASES: Case[] = [
  ['GET', '/api/status', undefined, 'jv_status', {}],
  ['GET', '/api/status?project=sandbox', undefined, 'jv_status', { project: 'sandbox' }],
  ['GET', '/api/projects', undefined, 'jv_project_list', {}],
  ['POST', '/api/projects', { path: '/repos/x', name: 'x' }, 'jv_project_add', { path: '/repos/x', name: 'x' }],
  ['GET', '/api/tasks?project=sandbox&state=queued&limit=5', undefined, 'jv_task_list', { project: 'sandbox', state: 'queued', limit: 5 }],
  ['GET', '/api/tasks?project=&state=', undefined, 'jv_task_list', {}],
  [
    'POST',
    '/api/tasks',
    { project: 'sandbox', kind: 'single', duty: 'answer', title: 'Hi', text: 'Say hi.', parent: 'T9', after: 'T8', visible: true },
    'jv_task_create',
    { project: 'sandbox', kind: 'single', duty: 'answer', title: 'Hi', text: 'Say hi.', parent: 'T9', after: 'T8', visible: true },
  ],
  ['GET', `/api/tasks/${T}`, undefined, 'jv_task_show', { task: T }],
  ['POST', `/api/tasks/${T}/message`, { text: 'Use the blue one.' }, 'jv_task_message', { task: T, text: 'Use the blue one.' }],
  ['POST', `/api/tasks/${T}/answer`, { answer: 'Blue' }, 'jv_task_answer', { task: T, answer: 'Blue' }],
  ['POST', `/api/tasks/${T}/stop`, { discard: true }, 'jv_task_stop', { task: T, discard: true }],
  ['POST', `/api/tasks/${T}/stop`, {}, 'jv_task_stop', { task: T }],
  ['POST', `/api/tasks/${T}/resume`, {}, 'jv_task_resume', { task: T }],
  [
    'POST',
    `/api/tasks/${T}/override`,
    { model: 'model-strong', effort: 'high', provider: 'claude-main', mode: 'keep' },
    'jv_task_override',
    { task: T, model: 'model-strong', effort: 'high', provider: 'claude-main', mode: 'keep' },
  ],
  ['GET', `/api/tasks/${T}/changes`, undefined, 'jv_task_changes', { task: T }],
  ['GET', `/api/tasks/${T}/changes?stat=true`, undefined, 'jv_task_changes', { task: T, stat: true }],
  ['GET', `/api/tasks/${T}/changes?stat=0`, undefined, 'jv_task_changes', { task: T, stat: false }],
  ['POST', `/api/tasks/${T}/land`, { force: true }, 'jv_land', { task: T, force: true }],
  ['GET', '/api/sessions/R9Q1XX/report', undefined, 'jv_report_get', { session: 'R9Q1XX' }],
  ['GET', '/api/sessions/R9Q1XX/events?sinceSeq=10&limit=50', undefined, 'jv_tail', { session: 'R9Q1XX', sinceSeq: 10, limit: 50 }],
  ['GET', '/api/projects/sandbox/coordinator', undefined, 'jv_coordinator_status', { project: 'sandbox' }],
  ['POST', '/api/projects/sandbox/coordinator/message', { text: 'status' }, 'jv_coordinator_message', { project: 'sandbox', text: 'status' }],
  ['GET', '/api/projects/sandbox/coordinator/transcript?limit=20', undefined, 'jv_coordinator_transcript', { project: 'sandbox', limit: 20 }],
  ['GET', '/api/memory?query=npm%20ci&project=sandbox&limit=5', undefined, 'jv_memory_search', { query: 'npm ci', project: 'sandbox', limit: 5 }],
  [
    'POST',
    '/api/memory',
    { kind: 'environment', text: 'Tests need npm ci first.', tags: ['tests'], scope: 'project', project: 'sandbox' },
    'jv_memory_add',
    { kind: 'environment', text: 'Tests need npm ci first.', tags: ['tests'], scope: 'project', project: 'sandbox' },
  ],
  ['POST', '/api/memory/M1ABCD/archive', { reason: 'obsolete' }, 'jv_memory_archive', { id: 'M1ABCD', reason: 'obsolete' }],
  ['GET', '/api/schedules?project=sandbox', undefined, 'jv_schedule_list', { project: 'sandbox' }],
  [
    'POST',
    '/api/schedules',
    { project: 'sandbox', name: 'Nightly tests', cron: '0 3 * * *', tz: 'Europe/Lisbon', kind: 'task', task: { kind: 'single', duty: 'verify', title: 'Nightly tests', text: 'Run the tests.' } },
    'jv_schedule_add',
    { project: 'sandbox', name: 'Nightly tests', cron: '0 3 * * *', tz: 'Europe/Lisbon', kind: 'task', task: { kind: 'single', duty: 'verify', title: 'Nightly tests', text: 'Run the tests.' } },
  ],
  ['POST', '/api/schedules/C1ABCD/run', {}, 'jv_schedule_run', { schedule: 'C1ABCD' }],
  ['POST', '/api/schedules/C1ABCD/pause', {}, 'jv_schedule_pause', { schedule: 'C1ABCD' }],
  ['POST', '/api/schedules/C1ABCD/resume', {}, 'jv_schedule_resume', { schedule: 'C1ABCD' }],
  ['GET', '/api/goals?project=sandbox', undefined, 'jv_goal_list', { project: 'sandbox' }],
  ['POST', '/api/goals', { project: 'sandbox', title: 'CSV import', text: 'Customers import a CSV.', priority: 2 }, 'jv_goal_add', { project: 'sandbox', title: 'CSV import', text: 'Customers import a CSV.', priority: 2 }],
  ['POST', '/api/goals/G1ABCD/done', {}, 'jv_goal_done', { goal: 'G1ABCD' }],
  ['GET', '/api/jobs?project=sandbox', undefined, 'jv_job_list', { project: 'sandbox' }],
  ['POST', '/api/jobs', { project: 'sandbox', kind: 'plan', force: true }, 'jv_job_run', { project: 'sandbox', kind: 'plan', force: true }],
  ['GET', '/api/usage?week=2026-W44', undefined, 'jv_usage', { week: '2026-W44' }],
  ['GET', '/api/doctor', undefined, 'jv_doctor', {}],
  ['GET', '/api/bot', undefined, 'jv_bot_status', {}],
];

test('the routes cover exactly the tools of section 5', () => {
  assert.deepEqual([...new Set(OPERATION_ROUTES.map((r) => r.operation))].sort(), [...SECTION_5_TOOLS].sort());
  assert.deepEqual(missingOperations(fakes.operations), []);
  assert.deepEqual(missingOperations([]).length, SECTION_5_TOOLS.length);
  const covered = new Set(CASES.map((c) => c[3]));
  for (const name of SECTION_5_TOOLS) assert.ok(covered.has(name), `${name} has a case below`);
});

test('every operation-backed route calls its operation by name with the path, query and body input, origin ui', async () => {
  for (const [method, path, body, operation, input] of CASES) {
    fakes.calls.length = 0;
    const r = method === 'GET' ? await client.get(path) : await client.post(path, body);
    assert.equal(r.status, 200, `${method} ${path}: ${r.text}`);
    assert.equal(fakes.calls.length, 1, `${method} ${path} made one call`);
    assert.deepEqual(fakes.calls[0], { name: operation, input, origin: 'ui' }, `${method} ${path}`);
    const data = r.json();
    assert.equal(data.op, operation, 'the body is the operation data');
    assert.deepEqual(data.input, input);
  }
});

test('the path ids win over the body; HEAD runs a GET route without a body', async () => {
  fakes.calls.length = 0;
  await client.post(`/api/tasks/${T}/message`, { task: 'T999999', text: 'hi' });
  assert.deepEqual(fakes.calls[0]!.input, { task: T, text: 'hi' });
  const head = await client.get('/api/status', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('a schema refusal is 400 {error, exitCode: 2} and the operation is not run', async () => {
  fakes.calls.length = 0;
  const r = await client.post(`/api/tasks/${T}/message`, {});
  assert.equal(r.status, 400);
  assert.deepEqual(r.json(), { error: 'text: Required', exitCode: 2 });
  const typed = await client.get('/api/tasks?limit=lots');
  assert.equal(typed.status, 400);
  assert.deepEqual(typed.json(), { error: 'limit: expected number', exitCode: 2 });
  const extra = await client.post('/api/tasks', { project: 'p', kind: 'single', title: 't', text: 'x', colour: 'blue' });
  assert.equal(extra.status, 400);
  assert.equal(fakes.calls.length, 0);
});

test('operation refusals carry their exit code: 400, 404, 409; anything else is 500 without its message', async () => {
  const cases: Array<[Error, number, Record<string, unknown>]> = [
    [new JvError('task T1 is done; it takes no messages', 2), 400, { error: 'task T1 is done; it takes no messages', exitCode: 2 }],
    [new JvError('no task T1', 3), 404, { error: 'no task T1', exitCode: 3 }],
    [new JvError('request id reused with other input', 4), 409, { error: 'request id reused with other input', exitCode: 4 }],
    [new Error('boom at /private/var/secret/path'), 500, { error: 'internal error', exitCode: 1 }],
  ];
  const stderr = process.stderr.write.bind(process.stderr);
  for (const [error, status, body] of cases) {
    fakes.fail('jv_task_show', error);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let r;
    try {
      r = await client.get(`/api/tasks/${T}`);
    } finally {
      process.stderr.write = stderr;
    }
    assert.equal(r.status, status, error.message);
    assert.deepEqual(r.json(), body);
  }
  fakes.fail('jv_task_show', undefined);
});

test('a route whose operation is not in this build answers "not available" (400, exit 2)', async () => {
  const bare = await startUiServer({ port: 0, logFile: false, tail: () => undefined });
  try {
    const c = new Client(bare.url);
    await c.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());
    const r = await c.get('/api/status');
    assert.equal(r.status, 400);
    assert.deepEqual(r.json(), { error: 'jv_status is not available in this build of jv ui', exitCode: 2 });
    assert.match((await c.get('/api/memory')).json().error, /memory list is not available/);
    assert.match((await c.get('/api/schedules/preview?cron=0%203%20*%20*%20*')).json().error, /preview is not available/);
  } finally {
    await bare.close();
  }
});

test('unknown endpoints are 404, a known path with the wrong method 405, a POST must be JSON', async () => {
  const r = await client.get('/api/nothing-here');
  assert.equal(r.status, 404);
  assert.equal(r.json().exitCode, 3);
  const wrong = await client.get(`/api/tasks/${T}/message`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST');
  const text = await client.post(`/api/tasks/${T}/message`, {}, { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(text.status, 400);
  assert.match(text.json().error, /application\/json/);
  const bad = await client.post('/api/tasks', undefined, { body: '{not json' });
  assert.equal(bad.status, 400);
  const arr = await client.post('/api/tasks', [1, 2]);
  assert.equal(arr.status, 400);
});

test('GET /api/memory without a query is the memory list, with its filters', async () => {
  memoryCalls.length = 0;
  fakes.calls.length = 0;
  const r = await client.get('/api/memory?project=sandbox&kind=fact&status=archived&limit=7');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { memories: [{ id: 'M1ABCD', kind: 'fact', text: 'made-up memory' }] });
  assert.deepEqual(memoryCalls, [{ project: 'sandbox', kind: 'fact', status: 'archived', limit: 7 }]);
  assert.equal(fakes.calls.length, 0, 'no search');
  await client.get('/api/memory?query=');
  assert.deepEqual(memoryCalls.at(-1), {}, 'an empty query is the list');
  assert.equal((await client.get('/api/memory?limit=x')).status, 400);
});

test('GET /api/bot is jv_bot_status plus the last 100 lines of bot.log and the queue', async () => {
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, 'logs', 'bot.log'), Array.from({ length: 150 }, (_, i) => `2026-11-01T12:00:${String(i % 60).padStart(2, '0')}Z tick ${i}`).join('\n') + '\n');
  const p = store.getProjectByName('sandbox')!;
  const first = store.createTask({ project_id: p.id, request_id: 'q1', kind: 'single', title: 'First queued', task_text: 'x', workflow_json: '{"steps":[]}' }).row;
  store.setTaskState(first.id, 'queued', 'waiting for a slot');
  await new Promise((r) => setTimeout(r, 5));
  const second = store.createTask({ project_id: p.id, request_id: 'q2', kind: 'single', title: 'Second queued', task_text: 'x', workflow_json: '{"steps":[]}' }).row;
  store.setTaskState(second.id, 'queued', `after ${first.id}`);
  const r = await client.get('/api/bot');
  assert.equal(r.status, 200);
  const d = r.json();
  assert.equal(d.op, 'jv_bot_status');
  assert.equal(d.log.length, 100);
  assert.equal(d.log[0], '2026-11-01T12:00:50Z tick 50');
  assert.equal(d.log[99], '2026-11-01T12:00:29Z tick 149');
  const queued = d.queue.filter((t: any) => t.id === first.id || t.id === second.id);
  assert.deepEqual(queued.map((t: any) => [t.id, t.stateReason]), [[first.id, 'waiting for a slot'], [second.id, `after ${first.id}`]], 'oldest first, with the wait reason');
});

test('GET /api/decisions is the lifted viewer decisions view', async () => {
  const r = await client.get('/api/decisions?kind=placement&project=sandbox');
  assert.equal(r.status, 200);
  const d = r.json();
  assert.deepEqual(d.filter, { kind: 'placement', from: null, to: null, project: 'sandbox', task: null });
  assert.deepEqual(d.kinds, ['placement', 'landing', 'workflow']);
  assert.equal(d.total, 0);
});

test('notes: read as {project, text}; written through jv notes write, the old text archived', async () => {
  assert.deepEqual((await client.get('/api/projects/sandbox/notes')).json(), { project: 'sandbox', text: '' });
  const w = await client.post('/api/projects/sandbox/notes', { text: 'Prefer small tasks.' });
  assert.equal(w.status, 200);
  assert.deepEqual({ ...w.json(), file: undefined }, { project: 'sandbox', bytes: 20, unchanged: false, file: undefined });
  assert.equal(readFileSync(join(home, 'projects', 'sandbox', 'notes.md'), 'utf8'), 'Prefer small tasks.\n');
  assert.equal((await client.get('/api/projects/sandbox/notes')).json().text, 'Prefer small tasks.\n');
  assert.equal((await client.post('/api/projects/sandbox/notes', { text: 'Prefer small tasks.' })).json().unchanged, true);
  const again = (await client.post('/api/projects/sandbox/notes', { text: 'Prefer tiny tasks.' })).json();
  assert.ok(existsSync(again.archived), 'the previous notes are archived, never deleted');
  assert.equal((await client.post('/api/projects/sandbox/notes', { text: '  ' })).status, 400);
  assert.equal((await client.post('/api/projects/sandbox/notes', {})).status, 400);
  assert.equal((await client.get('/api/projects/nope/notes')).status, 404);
});

test('workflows: the file each kind uses (project override or default) and its steps', async () => {
  const feature = join(home, 'skills', 'jevellan-workflow-feature');
  mkdirSync(feature, { recursive: true });
  writeFileSync(join(feature, 'workflow.json'), JSON.stringify({ name: 'feature', steps: [{ duty: 'plan' }, { duty: 'implement' }] }));
  const own = join(home, 'projects', 'sandbox', 'workflows');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'bug.json'), JSON.stringify({ name: 'bug', steps: [{ duty: 'investigate', instructions: 'Find it.' }] }));
  const d = (await client.get('/api/projects/sandbox/workflows')).json();
  const byKind = Object.fromEntries(d.workflows.map((w: any) => [w.kind, w]));
  assert.deepEqual(Object.keys(byKind), ['feature', 'bug', 'automation']);
  assert.equal(byKind.feature.source, 'default');
  assert.equal(byKind.feature.file, join(feature, 'workflow.json'));
  // A file outside the owner's home folder is shown as it is (one under it starts with ~).
  assert.equal(byKind.feature.shown, byKind.feature.file);
  assert.deepEqual(byKind.feature.steps.map((s: any) => s.duty), ['plan', 'implement']);
  assert.equal(byKind.bug.source, 'project');
  assert.equal(byKind.bug.file, join(own, 'bug.json'));
  assert.equal(byKind.bug.steps[0].instructions, 'Find it.');
  assert.deepEqual(byKind.automation.steps, []);
  assert.match(byKind.automation.error, /no workflow for automation/);
});

test('the schedule preview prints the next three runs of a cron in a time zone', async () => {
  const r = await client.get('/api/schedules/preview?cron=0%203%20*%20*%20*&tz=UTC');
  assert.equal(r.status, 200);
  const runs: string[] = r.json().nextRuns;
  assert.equal(runs.length, 3);
  for (const iso of runs) assert.match(iso, /T03:00:00\.000Z$/);
  assert.ok(Date.parse(runs[0]!) > Date.now() - 1000);
  const bad = await client.get('/api/schedules/preview?cron=61%20*%20*%20*%20*&tz=UTC');
  assert.equal(bad.status, 400);
  assert.equal(bad.json().exitCode, 2);
  assert.equal(typeof bad.json().error, 'string');
  assert.equal((await client.get('/api/schedules/preview')).status, 400);
});

test('GET /api/providers is the providers.json menu of the Override dialog: names, kinds and models, no file or home', async () => {
  const r = await client.get('/api/providers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), {
    providers: [
      {
        name: 'claude-main',
        kind: 'claude-subscription',
        models: [
          { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
          { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low'] },
        ],
      },
    ],
  });
  assert.doesNotMatch(r.text, /secrets|tokenFile|keyFile|homes/);
});

test('POST /api/goals/:id/pause pauses an open goal and answers {goal}', async () => {
  const p = store.getProjectByName('sandbox')!;
  const g = store.createGoal({ project_id: p.id, title: 'CSV import', text: 'Customers import a CSV.' });
  const r = await client.post(`/api/goals/${g.id.toLowerCase()}/pause`, {});
  assert.equal(r.status, 200);
  const goal = r.json().goal;
  assert.equal(goal.id, g.id);
  assert.equal(goal.state, 'paused');
  assert.equal(goal.project, 'sandbox');
  assert.deepEqual(Object.keys(goal), ['id', 'project', 'title', 'text', 'priority', 'state', 'createdAt', 'updatedAt']);
  assert.equal(store.getGoal(g.id)!.state, 'paused');
  assert.equal((await client.post('/api/goals/G000000/pause', {})).status, 404);
  store.setGoalState(g.id, 'done');
  assert.equal((await client.post(`/api/goals/${g.id}/pause`, {})).status, 400);
});

test('POST /api/projects/:name/coordinator/start starts the coordinator as jv coordinator start does', async () => {
  const r = await client.post('/api/projects/sandbox/coordinator/start', {});
  assert.equal(r.status, 200, r.text);
  const d = r.json();
  assert.equal(d.started, true);
  assert.equal(d.tmuxSession, 'jv-coord-sandbox');
  assert.equal(store.getSession(d.sessionId)!.kind, 'coordinator');
  const again = (await client.post('/api/projects/sandbox/coordinator/start', {})).json();
  assert.equal(again.started, false);
  assert.equal((await client.post('/api/projects/nope/coordinator/start', {})).status, 404);
  assert.ok(seeded.taskId);
});
