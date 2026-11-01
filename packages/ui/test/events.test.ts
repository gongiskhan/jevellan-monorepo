// GET /api/events (brief section 7): hello at connect, `change` after another connection writes to the store (PRAGMA
// data_version), `heartbeat` on its interval, the coordinators tailed every poll while a page listens (and never
// without one, and never in --readonly mode). Short intervals keep the suite fast.

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';
import { Client, EventReader, sleep } from './fixtures/server-fixture.js';

const home = makeHome('jv-ui-events-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { startUiServer } = await import('../server/server.js');

const store = openStore();
let tails = 0;
const ui = await startUiServer({ port: 0, pollMs: 50, heartbeatMs: 200, logFile: false, tail: () => void tails++ });
const client = new Client(ui.url);
await client.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test('the stream says hello, then change after a store write, and a heartbeat on its interval', async () => {
  const events = new EventReader(`${ui.url}/api/events`, client.cookie);
  const r = await events.open();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  try {
    await events.until(/event: hello\ndata: \{"version":0,/, 2000);
    await sleep(150);
    assert.doesNotMatch(events.text, /event: change/, 'nothing changed yet');
    store.setMeta('test:poke', 'one');
    await events.until(/event: change\ndata: \{"version":1,"at":"[^"]+"\}/, 3000);
    await events.until(/event: heartbeat\ndata: \{"at":"[^"]+"\}/, 2000);
    const changes = events.count(/event: change/);
    await sleep(300);
    assert.equal(events.count(/event: change/), changes, 'no change event without a write');
  } finally {
    await events.close();
  }
});

test('the coordinators are tailed every poll while a page listens, and not without one', async () => {
  await sleep(150);
  const idle = tails;
  await sleep(200);
  assert.equal(tails, idle, 'no tail without a client');
  const events = new EventReader(`${ui.url}/api/events`, client.cookie);
  await events.open();
  try {
    await events.until(/event: hello/, 2000);
    const start = tails;
    await sleep(400);
    assert.ok(tails - start >= 4, `tailed ${tails - start} times in 400 ms at a 50 ms poll`);
  } finally {
    await events.close();
  }
  await sleep(150);
  const after = tails;
  await sleep(200);
  assert.equal(tails, after, 'tailing stops when the last page goes');
});

test('a failing tail never stops the stream', async () => {
  let calls = 0;
  const failing = await startUiServer({
    port: 0,
    pollMs: 50,
    logFile: false,
    tail: () => {
      calls++;
      throw new Error('transcript unreadable');
    },
  });
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const c = new Client(failing.url);
    await c.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());
    const events = new EventReader(`${failing.url}/api/events`, c.cookie);
    await events.open();
    await events.until(/event: hello/, 2000);
    await sleep(200);
    assert.ok(calls >= 2, 'the poller went on after the first failure');
    store.setMeta('test:poke', 'two');
    await events.until(/event: change/, 3000);
    await events.close();
  } finally {
    process.stderr.write = stderr;
    await failing.close();
  }
});

test('a --readonly server never tails (tailing writes), and still streams changes', async () => {
  let roTails = 0;
  const ro = await startUiServer({ port: 0, readonly: true, pollMs: 50, logFile: false, tail: () => void roTails++ });
  try {
    const c = new Client(ro.url);
    await c.login(readFileSync(join(home, 'ui-password'), 'utf8').trim());
    const events = new EventReader(`${ro.url}/api/events`, c.cookie);
    await events.open();
    await events.until(/event: hello/, 2000);
    store.setMeta('test:poke', 'three');
    await events.until(/event: change/, 3000);
    assert.equal(roTails, 0);
    await events.close();
  } finally {
    await ro.close();
  }
});
