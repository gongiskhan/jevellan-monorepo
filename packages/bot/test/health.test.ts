// The health endpoint (brief section 8): GET /health answers exactly {ok, heartbeatAgeSeconds, running, queued,
// version} in that order, from the store; a stale heartbeat answers ok false with 503; every other path or method is
// 404 with an empty body; a taken port refuses with exit 2 and the fix.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-health-test-');
process.env.JV_HOME = home;
const H = await import('../src/health.js');
const { openStore } = await import('jevellan-core/store');
const { writeBotHeartbeat } = await import('jevellan-core/bot-state');
const { JvError } = await import('jevellan-core/errors');
const { packageVersion } = await import('jevellan-core/version');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
const project = store.createProject({ name: 'sandbox', path: home, default_branch: 'main' }).row;
store.createTask({ project_id: project.id, request_id: 'health-q', kind: 'single', title: 'Queued one', task_text: 'x', workflow_json: '{}', state: 'queued', state_reason: 'waiting for a slot' });

const health = await H.startHealthServer(store, { bind: '127.0.0.1', port: 0, tickSeconds: 15 });
after(() => health.close());

test('GET /health is exactly the contract, in its key order', async () => {
  writeBotHeartbeat(store, { pid: process.pid, startedAt: new Date().toISOString(), tick: 3, at: new Date(Date.now() - 3000).toISOString() });
  const r = await fetch(health.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const text = await r.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['ok', 'heartbeatAgeSeconds', 'running', 'queued', 'version']);
  assert.equal(body.ok, true);
  assert.ok((body.heartbeatAgeSeconds as number) >= 3 && (body.heartbeatAgeSeconds as number) <= 5);
  assert.equal(body.running, 0);
  assert.equal(body.queued, 1);
  assert.equal(body.version, packageVersion());
  assert.match(text, /^\{"ok":true,"heartbeatAgeSeconds":\d+,"running":0,"queued":1,"version":"\d+\.\d+\.\d+"\}$/);
  assert.match(health.url, /^http:\/\/127\.0\.0\.1:\d+\/health$/);
});

test('a stale heartbeat answers ok false with 503', async () => {
  writeBotHeartbeat(store, { pid: process.pid, startedAt: new Date().toISOString(), tick: 4, at: new Date(Date.now() - 120_000).toISOString() });
  const r = await fetch(health.url);
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { ok: boolean }).ok, false);
});

test('nothing else is served: other paths and methods are 404 with an empty body', async () => {
  const base = health.url.replace(/\/health$/, '');
  for (const [path, method] of [['/', 'GET'], ['/healthz', 'GET'], ['/health/x', 'GET'], ['/api/status', 'GET'], ['/health', 'POST'], ['/health', 'DELETE']] as const) {
    const r = await fetch(`${base}${path}`, { method });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(await r.text(), '');
  }
  const head = await fetch(health.url, { method: 'HEAD' });
  assert.notEqual(head.status, 404);
});

test('a port in use refuses the start with exit 2 and the fix', async () => {
  const taken = createServer();
  await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
  const port = (taken.address() as { port: number }).port;
  try {
    await assert.rejects(
      H.startHealthServer(store, { bind: '127.0.0.1', port, tickSeconds: 15 }),
      (e: unknown) => e instanceof JvError && e.exitCode === 2 && new RegExp(`port ${port} on 127\\.0\\.0\\.1 is in use: set health\\.port in .*bot\\.json`).test(e.message),
    );
  } finally {
    taken.close();
  }
});
