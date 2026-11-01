// jv ui sign-in (brief section 7): the password file, the jv_ui cookie and its flags, the hashed ui_tokens row valid
// 30 days and refreshed on use, signing out, 429 after five wrong passwords in a minute, the 401 of every /api route
// but /api/login and /api/session, and --readonly (sign-in allowed, every other POST 403).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';
import { Client, raw } from './fixtures/server-fixture.js';

const home = makeHome('jv-ui-auth-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { startUiServer } = await import('../server/server.js');
const auth = await import('../server/auth.js');

const store = openStore();
let clock = Date.parse('2026-11-01T12:00:00.000Z');
const ui = await startUiServer({ port: 0, now: () => clock, logFile: false, tail: () => undefined });
const password = readFileSync(join(home, 'ui-password'), 'utf8').trim();

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const DAY = 86_400_000;

function tokenRow(cookie: string): { token_hash: string; created_at: string; last_seen_at: string; user_agent: string } | undefined {
  const token = cookie.split('=')[1]!;
  return store.db.prepare('SELECT * FROM ui_tokens WHERE token_hash = ?').get(createHash('sha256').update(token).digest('hex')) as any;
}

test('the first start writes 20 base32 characters to ui-password, mode 600, and reports it once', async () => {
  assert.match(password, /^[A-Z2-7]{20}$/);
  assert.equal(statSync(join(home, 'ui-password')).mode & 0o777, 0o600);
  assert.equal(ui.newPassword, password, 'the start that created it hands it over for jv ui to print');
  assert.equal(ui.passwordFile, join(home, 'ui-password'));
  const again = await startUiServer({ port: 0, logFile: false, tail: () => undefined });
  try {
    assert.equal(again.newPassword, undefined, 'a later start does not show it again');
    assert.equal(readFileSync(join(home, 'ui-password'), 'utf8').trim(), password);
  } finally {
    await again.close();
  }
  assert.equal(auth.newPassword().length, 20);
  assert.notEqual(auth.newPassword(), auth.newPassword());
});

test('a wrong password is 401 "Wrong password."; the right one sets jv_ui HttpOnly, SameSite=Lax, 30 days', async () => {
  const c = new Client(ui.url);
  const wrong = await c.login('not-the-password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json(), { error: 'Wrong password.' });
  assert.equal(wrong.headers['set-cookie'], undefined);
  const ok = await c.login(password);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { ok: true });
  const cookie = String(ok.headers['set-cookie']);
  assert.match(cookie, /^jv_ui=[A-Za-z0-9_-]{43}; /, '32 random bytes, base64url');
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=2592000/);
  assert.doesNotMatch(cookie, /Secure/, 'not Secure over plain http');
  const session = await c.get('/api/session');
  assert.deepEqual(session.json(), { authenticated: true, readonly: false, version: '0.1.0' });
});

test('the store keeps only the sha256 of the token, with the times and the user agent', async () => {
  const c = new Client(ui.url);
  await c.post('/api/login', { password }, { headers: { 'User-Agent': 'TestPhone/1.0' } }).then((r) => {
    c.cookie = String(r.headers['set-cookie']).split(';')[0]!;
  });
  const token = c.cookie.split('=')[1]!;
  const rows = store.db.prepare('SELECT * FROM ui_tokens').all() as Array<Record<string, string>>;
  assert.ok(rows.every((r) => r.token_hash !== token), 'the raw token is never stored');
  const row = tokenRow(c.cookie)!;
  assert.ok(row, 'a row keyed by the hash');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.created_at, new Date(clock).toISOString());
  assert.equal(row.last_seen_at, row.created_at);
  assert.equal(row.user_agent, 'TestPhone/1.0');
  const all = JSON.stringify(rows);
  assert.ok(!all.includes(password), 'the password is in no row');
});

test('a token is valid for 30 days from its last use and is refreshed on use', async () => {
  const c = new Client(ui.url);
  await c.login(password);
  const row = tokenRow(c.cookie)!;
  // Within 5 minutes: no write (every write sends the open pages a change event).
  clock += 60_000;
  assert.equal((await c.get('/api/session')).json().authenticated, true);
  assert.equal(tokenRow(c.cookie)!.last_seen_at, row.last_seen_at);
  // Later: last_seen_at moves and the cookie is sent again with a fresh Max-Age.
  clock += 29 * DAY;
  const used = await c.get('/api/session');
  assert.equal(used.json().authenticated, true);
  assert.equal(tokenRow(c.cookie)!.last_seen_at, new Date(clock).toISOString());
  assert.match(String(used.headers['set-cookie']), /^jv_ui=.*Max-Age=2592000/);
  // 30 days without use: expired.
  clock += 30 * DAY;
  assert.equal((await c.get('/api/session')).json().authenticated, false);
  assert.equal((await c.get('/api/status')).status, 401);
  clock -= 59 * DAY + 60_000;
});

test('every /api route but login and session needs the cookie: 401 "Sign in."', async () => {
  const anon = new Client(ui.url);
  for (const path of ['/api/status', '/api/projects', '/api/tasks', '/api/events', '/api/decisions', '/api/memory', '/api/bot', '/api/nope']) {
    const r = await anon.get(path);
    assert.equal(r.status, 401, path);
    assert.deepEqual(r.json(), { error: 'Sign in.' });
  }
  for (const path of ['/api/tasks', '/api/logout', '/api/tasks/T1/ui-action']) {
    assert.equal((await anon.post(path, {})).status, 401, path);
  }
  assert.equal((await anon.get('/api/session')).json().authenticated, false);
  assert.equal((await anon.get('/evidence/T1/a.png')).status, 401, 'evidence too');
  const forged = await raw(ui.url, '/api/status', { cookie: `jv_ui=${'A'.repeat(43)}` });
  assert.equal(forged.status, 401);
  assert.equal((await raw(ui.url, '/health')).status, 200, '/health needs no cookie');
});

test('sign out expires the token (the row stays) and clears the cookie', async () => {
  const c = new Client(ui.url);
  await c.login(password);
  const before = store.db.prepare('SELECT count(*) AS n FROM ui_tokens').get() as { n: number };
  const out = await c.post('/api/logout');
  assert.equal(out.status, 200);
  assert.match(String(out.headers['set-cookie']), /^jv_ui=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax/);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM ui_tokens').get() as { n: number }).n, before.n, 'nothing is deleted');
  assert.equal(tokenRow(c.cookie)!.last_seen_at, auth.SIGNED_OUT_AT);
  assert.equal((await c.get('/api/status')).status, 401);
});

test('five wrong passwords from one address in a minute: 429 for a minute, even with the right one', async () => {
  const limited = await startUiServer({ port: 0, now: () => clock, logFile: false, tail: () => undefined });
  try {
    const c = new Client(limited.url);
    for (let i = 0; i < 5; i++) assert.equal((await c.login(`wrong-${i}`)).status, 401, `attempt ${i + 1}`);
    const blocked = await c.login(password);
    assert.equal(blocked.status, 429);
    assert.match(blocked.json().error, /Too many wrong passwords/);
    assert.equal(blocked.headers['retry-after'], '60');
    clock += 30_000;
    assert.equal((await c.login(password)).status, 429, 'still blocked after 30 s');
    clock += 31_000;
    assert.equal((await c.login(password)).status, 200, 'free again after a minute');
    // Four wrong, a right one, four wrong: never five in a row, never blocked.
    for (let i = 0; i < 4; i++) await c.login('wrong');
    assert.equal((await c.login(password)).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await c.login('wrong')).status, 401);
    // Failures older than a minute do not count.
    clock += 61_000;
    assert.equal((await c.login('wrong')).status, 401);
    assert.equal((await c.login(password)).status, 200);
  } finally {
    await limited.close();
  }
});

test('the LoginLimiter counts per address', () => {
  let t = 0;
  const l = new auth.LoginLimiter(() => t);
  for (let i = 0; i < 5; i++) l.fail('a');
  assert.ok(l.retryAfter('a') > 0);
  assert.equal(l.retryAfter('b'), 0);
  t += 60_000;
  assert.equal(l.retryAfter('a'), 0);
});

test('the Secure flag follows TLS: X-Forwarded-Proto https from a proxy', async () => {
  const r = await raw(ui.url, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({ password }),
  });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['set-cookie']), /; Secure$/);
});

test('sign-in needs a JSON request; the password is compared whole', async () => {
  const form = await raw(ui.url, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${password}` });
  assert.equal(form.status, 400);
  assert.equal((await new Client(ui.url).login(password.slice(0, 19))).status, 401);
  assert.equal((await new Client(ui.url).login(`${password}X`)).status, 401);
  assert.equal(auth.passwordMatches(undefined, join(home, 'ui-password')), false);
  assert.equal(auth.passwordMatches(password, join(home, 'no-such-file')), false);
});

test('--password-reset writes a new password and signs every browser out', async () => {
  const c = new Client(ui.url);
  await c.login(password);
  assert.equal((await c.get('/api/session')).json().authenticated, true);
  const reset = await startUiServer({ port: 0, passwordReset: true, logFile: false, tail: () => undefined });
  try {
    const fresh = readFileSync(join(home, 'ui-password'), 'utf8').trim();
    assert.match(fresh, /^[A-Z2-7]{20}$/);
    assert.notEqual(fresh, password);
    assert.equal(reset.newPassword, fresh);
    assert.equal(statSync(join(home, 'ui-password')).mode & 0o777, 0o600);
    assert.equal((await c.get('/api/session')).json().authenticated, false, 'the old token is signed out');
    assert.equal((await new Client(ui.url).login(password)).status, 401, 'the running server reads the new password');
    assert.equal((await new Client(ui.url).login(fresh)).status, 200);
  } finally {
    await reset.close();
  }
});

test('an empty password file is refused at start', async () => {
  const file = join(home, 'empty-password');
  writeFileSync(file, '\n', { mode: 0o600 });
  await assert.rejects(startUiServer({ port: 0, passwordFile: file, logFile: false }), (e: any) => e.exitCode === 2 && /--password-reset/.test(e.message));
  assert.ok(existsSync(file));
});

test('--readonly: sign-in works, the session says readonly, every other POST is 403 read-only', async () => {
  const ro = await startUiServer({ port: 0, readonly: true, logFile: false, tail: () => undefined });
  try {
    const fresh = readFileSync(join(home, 'ui-password'), 'utf8').trim();
    const c = new Client(ro.url);
    assert.equal((await c.login(fresh)).status, 200);
    assert.deepEqual((await c.get('/api/session')).json(), { authenticated: true, readonly: true, version: '0.1.0' });
    for (const path of ['/api/tasks', '/api/projects', '/api/tasks/T1/answer', '/api/tasks/T1/ui-action', '/api/projects/p/notes', '/api/goals/G1/pause', '/api/memory']) {
      const r = await c.post(path, {});
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json(), { error: 'read-only' });
    }
    assert.equal((await new Client(ro.url).post('/api/tasks', {})).status, 403, 'refused before sign-in too');
    assert.equal((await c.post('/api/logout')).status, 200, 'signing out is allowed');
  } finally {
    await ro.close();
  }
});
