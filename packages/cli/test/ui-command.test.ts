// jv ui through the CLI (brief sections 4 and 7): prints the URL (and the new password once, on stderr, never in the
// JSON), holds $JV_HOME/run/ui.pid while it serves, refuses a second instance with exit 2 and the pid, serves the
// sign-in API, --readonly refuses actions, and SIGTERM stops it and removes the pid file.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-ui-command-test-');
process.env.JV_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openStore } = await import('jevellan-core/store');
openStore().close();

const cliUrl = new URL('../src/cli.js', import.meta.url).href;

interface Running {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
}

function jv(args: string[]): Running {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(${JSON.stringify(args)});`],
    { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stdout!.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr!.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => out, err: () => err, exited };
}

async function started(r: Running): Promise<{ url: string; port: number; bind: string; readonly: boolean; passwordFile: string }> {
  const deadline = Date.now() + 15_000;
  while (!/\}\s*$/.test(r.out().trim()) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  return JSON.parse(r.out());
}

test('jv ui --port 0 --json prints the URL, writes the password once, holds the pid file, stops on SIGTERM', async () => {
  const first = jv(['ui', '--port', '0', '--json']);
  const info = await started(first);
  assert.equal(info.bind, '127.0.0.1');
  assert.equal(info.readonly, false);
  assert.ok(info.port > 0);
  assert.equal(info.passwordFile, join(home, 'ui-password'));
  assert.ok(!('password' in info) && !first.out().includes(readFileSync(info.passwordFile, 'utf8').trim()), 'the password is not in the JSON');
  const password = readFileSync(info.passwordFile, 'utf8').trim();
  assert.match(password, /^[A-Z2-7]{20}$/);
  assert.equal(statSync(info.passwordFile).mode & 0o777, 0o600);
  assert.ok(first.err().includes(`UI password written to ${info.passwordFile} (shown once): ${password}`), first.err());

  const pidFile = join(home, 'run', 'ui.pid');
  const record = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.equal(record.pid, first.child.pid);
  assert.equal(record.url, info.url);

  const second = jv(['ui', '--port', '0', '--json']);
  assert.equal(await second.exited, 2, 'a second jv ui is refused');
  assert.match(JSON.parse(second.out()).error, new RegExp(`jv ui is already running \\(pid ${first.child.pid}`));

  assert.equal((await fetch(`${info.url}/health`)).status, 200);
  assert.deepEqual(await (await fetch(`${info.url}/api/session`)).json(), { authenticated: false, readonly: false, version: '0.1.0' });
  assert.equal((await fetch(`${info.url}/api/status`)).status, 401);
  const login = await fetch(`${info.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get('set-cookie')).split(';')[0]!;
  // GET /api/memory without a query is jv memory list --json, through jevellan-memory on the store.
  const list = await fetch(`${info.url}/api/memory`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { memories: [] });
  const bogus = await fetch(`${info.url}/api/memory?status=bogus`, { headers: { Cookie: cookie } });
  assert.equal(bogus.status, 400);
  assert.deepEqual(await bogus.json(), { error: 'status is active, archived or all', exitCode: 2 });
  first.child.kill('SIGTERM');
  assert.equal(await first.exited, 0);
  assert.equal(existsSync(pidFile), false, 'the pid file is removed on exit');
});

test('jv ui --readonly: the session says so and actions are refused; the password is not shown again', async () => {
  const r = jv(['ui', '--port', '0', '--json', '--readonly']);
  const info = await started(r);
  try {
    assert.equal(info.readonly, true);
    assert.doesNotMatch(r.err(), /shown once/);
    assert.equal(((await (await fetch(`${info.url}/api/session`)).json()) as { readonly: boolean }).readonly, true);
    const post = await fetch(`${info.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 403);
    assert.deepEqual(await post.json(), { error: 'read-only' });
  } finally {
    r.child.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  }
});

test('jv ui --password-reset writes a new password and shows it once', async () => {
  const before = readFileSync(join(home, 'ui-password'), 'utf8').trim();
  const r = jv(['ui', '--port', '0', '--password-reset']);
  const deadline = Date.now() + 15_000;
  while (!/jv ui: http/.test(r.out()) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  try {
    const after = readFileSync(join(home, 'ui-password'), 'utf8').trim();
    assert.notEqual(after, before);
    assert.ok(r.err().includes(`(shown once): ${after}`));
    assert.match(r.out(), /^jv ui: http:\/\/127\.0\.0\.1:\d+; Ctrl-C stops it$/m);
  } finally {
    r.child.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  }
});
