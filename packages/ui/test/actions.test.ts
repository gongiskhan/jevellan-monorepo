// POST /api/tasks/:id/ui-action (brief section 7, A2UI): a Button named "answer" with a string context.label is
// `jv task answer T "<label>"`; any other action is `jv task message T "UI action <name>: <context JSON>"` (cut at 4000
// characters); both keep the raw action in messages.meta_json. Runs never start for real (spawn is a fake).

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';
import { Client } from './fixtures/server-fixture.js';

const home = makeHome('jv-ui-actions-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { writeReport } = await import('jevellan-core/report');
const { startUiServer } = await import('../server/server.js');
const { actionMessageText, answerLabel, parseUiAction, UI_ACTION_CONTEXT_MAX } = await import('../server/actions.js');

const store = openStore();
const spawned: string[] = [];
const ui = await startUiServer({
  port: 0,
  logFile: false,
  tail: () => undefined,
  taskDeps: {
    spawn: (_store, id) => {
      spawned.push(id);
    },
    notify: async () => undefined,
    closeWindows: async () => [],
    typeIntoLive: async () => false,
  },
});
const client = new Client(ui.url);
await client.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
/** A task whose step reported needs-decision with options Blue and Green and waits on the owner. */
function waitingTask(): { taskId: string; sessionId: string } {
  const s = seedTask(store, home, { name: `p${++n}` });
  const run = store.createSession({
    project_id: s.projectId,
    task_id: s.taskId,
    step_id: s.stepIds[0]!,
    request_id: `run-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: s.repo,
    native_session_id: `native-${n}`,
    state: 'running',
  }).row;
  writeReport(store, run.id, { status: 'needs-decision', summary: 'Which colour?', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] });
  store.setSessionState(run.id, 'done', 'report needs-decision');
  store.setStepState(s.stepIds[0]!, 'running', 'waiting on the owner');
  store.setTaskState(s.taskId, 'waiting-owner', 'step 1 (investigate): needs-decision');
  return { taskId: s.taskId, sessionId: run.id };
}

/** A task whose step runs now (claude-sdk: a message waits for the next turn). */
function runningTask(): string {
  const s = seedTask(store, home, { name: `p${++n}` });
  store.createSession({
    project_id: s.projectId,
    task_id: s.taskId,
    step_id: s.stepIds[0]!,
    request_id: `run-${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: s.repo,
    state: 'running',
  });
  store.setStepState(s.stepIds[0]!, 'running', 'running');
  store.setTaskState(s.taskId, 'running', 'step 1 running');
  return s.taskId;
}

test('an "answer" action with a string context.label is jv task answer, with the raw action in meta_json', async () => {
  const { taskId, sessionId } = waitingTask();
  const action = {
    name: 'answer',
    surfaceId: 'colour-picker',
    sourceComponentId: 'submit',
    timestamp: '2026-11-01T12:00:00.000Z',
    context: { label: 'blue', picked: ['blue'] },
  };
  const r = await client.post(`/api/tasks/${taskId.toLowerCase()}/ui-action`, { action });
  assert.equal(r.status, 200, r.text);
  const d = r.json();
  assert.equal(d.kind, 'answer');
  assert.equal(d.answer, 'Blue', 'an option label matched without case is recorded as the option');
  assert.equal(d.message.direction, 'answer');
  assert.equal(d.message.text, 'Blue');
  assert.deepEqual(JSON.parse(d.message.meta_json), action);
  const row = store.getMessage(d.message.id)!;
  assert.deepEqual(JSON.parse(row.meta_json!), action, 'meta_json is stored on the messages row');
  assert.equal(row.task_id, taskId);
  // The step continues: a new run on the same native session, started through spawn.
  assert.ok(d.session && spawned.includes(d.session));
  assert.equal(store.getSession(d.session)!.native_session_id, store.getSession(sessionId)!.native_session_id);
  assert.equal(store.getTask(taskId)!.state, 'running');
});

test('any other action is jv task message "UI action <name>: <context JSON>", with the raw action in meta_json', async () => {
  const taskId = runningTask();
  const action = { name: 'choose', surfaceId: 's1', sourceComponentId: 'go', timestamp: '2026-11-01T12:00:00.000Z', context: { colour: 'Green', count: 2 } };
  const r = await client.post(`/api/tasks/${taskId}/ui-action`, { action });
  assert.equal(r.status, 200, r.text);
  const d = r.json();
  assert.equal(d.kind, 'message');
  assert.equal(d.delivery, 'next-turn');
  assert.equal(d.message.direction, 'owner');
  assert.equal(d.message.text, 'UI action choose: {"colour":"Green","count":2}');
  assert.deepEqual(JSON.parse(store.getMessage(d.message.id)!.meta_json!), action);
});

test('an "answer" without a string label is a message too; an action with no context says {}', async () => {
  const taskId = runningTask();
  const numeric = await client.post(`/api/tasks/${taskId}/ui-action`, { action: { name: 'answer', context: { label: 3 } } });
  assert.equal(numeric.json().kind, 'message');
  assert.equal(numeric.json().message.text, 'UI action answer: {"label":3}');
  const bare = await client.post(`/api/tasks/${taskId}/ui-action`, { action: { name: 'refresh', surfaceId: 's1' } });
  assert.equal(bare.json().message.text, 'UI action refresh: {}');
  assert.deepEqual(JSON.parse(bare.json().message.meta_json), { name: 'refresh', surfaceId: 's1' });
});

test('a context longer than 4000 characters is cut in the text; meta_json keeps the whole action', async () => {
  const taskId = runningTask();
  const action = { name: 'submit', context: { notes: 'x'.repeat(5000) } };
  const d = (await client.post(`/api/tasks/${taskId}/ui-action`, { action })).json();
  const text: string = d.message.text;
  assert.equal(text.length, 'UI action submit: '.length + UI_ACTION_CONTEXT_MAX);
  assert.ok(text.endsWith('...'));
  assert.deepEqual(JSON.parse(store.getMessage(d.message.id)!.meta_json!), action);
});

test('known secrets in an action are masked in the stored text and meta_json, also across the 4000-character cut', async () => {
  const taskId = runningTask();
  const action = { name: 'submit', context: { notes: `${'x'.repeat(4000 - 30)}${FAKE_TOKEN} more`, token: FAKE_TOKEN } };
  const d = (await client.post(`/api/tasks/${taskId}/ui-action`, { action })).json();
  // The response passes the UI's second redaction pass, so the stored row is what is checked.
  const row = store.getMessage(d.message.id)!;
  assert.ok(!row.text.includes(FAKE_TOKEN.slice(0, 12)), 'the message text keeps part of the secret');
  assert.ok(!row.meta_json!.includes(FAKE_TOKEN));
  assert.deepEqual(JSON.parse(row.meta_json!), { name: 'submit', context: { notes: `${'x'.repeat(4000 - 30)}[redacted] more`, token: '[redacted]' } });
  const { taskId: waiting } = waitingTask();
  const answer = { name: 'answer', context: { label: `Blue ${FAKE_TOKEN}` } };
  const a = (await client.post(`/api/tasks/${waiting}/ui-action`, { action: answer })).json();
  const arow = store.getMessage(a.message.id)!;
  assert.equal(arow.text, 'Blue [redacted]');
  assert.ok(!arow.meta_json!.includes(FAKE_TOKEN));
});

test('refusals: no action, no name, a context that is not an object, a done task, an unknown task', async () => {
  const taskId = runningTask();
  for (const body of [{}, { action: 'answer' }, { action: { context: {} } }, { action: { name: '' } }, { action: { name: 'go', context: [1] } }]) {
    const r = await client.post(`/api/tasks/${taskId}/ui-action`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json().exitCode, 2);
  }
  const big = await client.post(`/api/tasks/${taskId}/ui-action`, { action: { name: 'go', context: { x: 'y'.repeat(70_000) } } });
  assert.equal(big.status, 400);
  store.setTaskState(taskId, 'done', 'landed');
  assert.equal((await client.post(`/api/tasks/${taskId}/ui-action`, { action: { name: 'go' } })).status, 400);
  assert.equal((await client.post('/api/tasks/T000000/ui-action', { action: { name: 'go' } })).status, 404);
});

test('the mapping helpers', () => {
  assert.equal(answerLabel({ name: 'answer', context: { label: 'Blue' } }), 'Blue');
  assert.equal(answerLabel({ name: 'Answer', context: { label: 'Blue' } }), undefined);
  assert.equal(answerLabel({ name: 'answer' }), undefined);
  assert.equal(actionMessageText({ name: 'x', context: { a: 1 } }), 'UI action x: {"a":1}');
  assert.throws(() => parseUiAction(null), /A2UI action/);
  assert.equal(parseUiAction({ name: 'ok' }).json, '{"name":"ok"}');
});
