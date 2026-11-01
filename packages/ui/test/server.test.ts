// The jv ui server itself (brief section 7): the web app's files with index.html for every page route and the
// content security policy, the page shown when the app is not built, /health, the Host guard and --bind rule (D-064),
// methods, the evidence route (only images under the task worktree's .jv-evidence/, D-064's checks), the request log
// (no query values, bodies or cookies), the pid file, and a store of a newer schema refused at start.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';
import { Client, raw } from './fixtures/server-fixture.js';

const home = makeHome('jv-ui-server-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { JvError } = await import('jevellan-core/errors');
const { startUiServer, validateBind, hostAllowed, PAGE_CSP, WEB_DIR, UI_ROOT } = await import('../server/server.js');
const { NOT_BUILT_HTML } = await import('../server/static.js');
const { acquirePidFile, readPidRecord } = await import('../server/pidfile.js');
const { buildUiFixture } = await import('./fixtures/ui-fixture.js');

const store = openStore();
const fx = buildUiFixture(store, home);

// A stand-in for Vite's output: index.html, a hashed asset, the manifest and the icon.
const web = join(home, 'web-build');
mkdirSync(join(web, 'assets'), { recursive: true });
const INDEX = '<!doctype html><html><head><script type="module" src="/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>\n';
writeFileSync(join(web, 'index.html'), INDEX);
writeFileSync(join(web, 'assets', 'index-abc123.js'), 'console.log("app");\n');
writeFileSync(join(web, 'assets', 'index-abc123.css'), 'body{margin:0}\n');
writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"Jevellan","start_url":"/"}\n');
writeFileSync(join(web, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
writeFileSync(join(home, 'outside-web.txt'), 'not for the browser\n');
symlinkSync(join(home, 'outside-web.txt'), join(web, 'escape.txt'));

const logFile = join(home, 'logs', 'ui.log');
const ui = await startUiServer({ port: 0, staticDir: web, logFile, tail: () => undefined });
const client = new Client(ui.url);
const password = readFileSync(join(home, 'ui-password'), 'utf8').trim();
await client.login(password);

after(async () => {
  await ui.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test('the web app: index.html for / and every page route, with the content security policy', async () => {
  for (const path of ['/', '/login', '/p/jevellan-live-sandbox', `/t/${fx.tasks.asked}`, '/s/R1', '/memory?project=x', '/schedules', '/bot']) {
    const r = await raw(ui.url, path);
    assert.equal(r.status, 200, path);
    assert.match(String(r.headers['content-type']), /^text\/html/);
    assert.equal(r.text, INDEX, path);
    assert.equal(r.headers['cache-control'], 'no-cache');
    const csp = String(r.headers['content-security-policy']);
    assert.equal(csp, PAGE_CSP);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|style-src 'self' 'unsafe-inline'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  }
});

test('files of the build with their types; hashed assets cached for a year; misses under /assets are 404', async () => {
  const types: Array<[string, RegExp]> = [
    ['/assets/index-abc123.js', /^text\/javascript/],
    ['/assets/index-abc123.css', /^text\/css/],
    ['/manifest.webmanifest', /^application\/manifest\+json/],
    ['/icon.svg', /^image\/svg\+xml/],
  ];
  for (const [path, type] of types) {
    const r = await raw(ui.url, path);
    assert.equal(r.status, 200, path);
    assert.match(String(r.headers['content-type']), type, path);
    assert.equal(r.text, readFileSync(join(web, path.slice(1)), 'utf8'));
  }
  assert.equal((await raw(ui.url, '/assets/index-abc123.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await raw(ui.url, '/icon.svg')).headers['cache-control'], 'no-cache');
  const etag = String((await raw(ui.url, '/icon.svg')).headers.etag);
  assert.equal((await raw(ui.url, '/icon.svg', { headers: { 'If-None-Match': etag } })).status, 304);
  for (const path of ['/assets/missing.js', '/missing.css', '/favicon.ico', '/assets/', '/escape.txt', '/..%2Fpackage.json', '/a/%2e%2e/%2e%2e/outside-web.txt', '/assets/..%2F..%2Foutside-web.txt']) {
    const r = await raw(ui.url, path);
    assert.ok(r.status === 404 || (r.status === 200 && r.text === INDEX), `${path} answered ${r.status}`);
    assert.doesNotMatch(r.text, /not for the browser/, path);
  }
  assert.equal((await raw(ui.url, '/assets/missing.js')).status, 404);
  assert.equal((await raw(ui.url, '/escape.txt')).status, 404, 'a symlink out of the build is not served');
  const head = await raw(ui.url, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('without a build every page says the web app is not built; the API still works', async () => {
  const bare = await startUiServer({ port: 0, staticDir: join(home, 'no-build-here'), logFile: false, tail: () => undefined });
  try {
    const r = await raw(bare.url, '/p/x');
    assert.equal(r.status, 503);
    assert.equal(r.text, NOT_BUILT_HTML);
    assert.match(r.text, /The web app is not built\. Run <code>npm run build<\/code>/);
    assert.doesNotMatch(r.text, /style=|<script/, 'nothing the policy would refuse');
    assert.equal((await raw(bare.url, '/health')).status, 200);
    assert.equal((await raw(bare.url, '/api/session')).status, 200);
  } finally {
    await bare.close();
  }
  assert.equal(WEB_DIR, join(UI_ROOT, 'dist', 'web'), 'the default is the Vite output of this package');
});

test('/health answers {ok, version} without sign-in', async () => {
  const r = await raw(ui.url, '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { ok: true, version: '0.1.0' });
});

test('methods: GET, HEAD and POST only; a page path takes no POST', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const r = await raw(ui.url, '/api/status', { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD, POST');
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no CORS, so no preflight ever passes');
  }
  assert.equal((await raw(ui.url, '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 405);
});

test('the Host header must name this machine (DNS rebinding guard)', async () => {
  const port = new URL(ui.url).port;
  assert.equal((await raw(ui.url, '/api/session', { host: `evil.example:${port}` })).status, 403);
  assert.equal((await raw(ui.url, '/', { host: 'evil.example' })).status, 403);
  assert.equal((await raw(ui.url, '/api/session', { host: `localhost:${port}` })).status, 200);
  assert.equal((await raw(ui.url, '/api/session', { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal(hostAllowed('dev-madrid.tail1234.ts.net:7071'), true);
  assert.equal(hostAllowed('100.101.102.103:7071'), true);
  assert.equal(hostAllowed('[::1]:7071'), true);
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed('attacker.example.com'), false);
});

test('--bind takes one IP address, never a wildcard', async () => {
  assert.equal(validateBind('localhost'), '127.0.0.1');
  assert.equal(validateBind('100.101.102.103'), '100.101.102.103');
  assert.equal(validateBind('[::1]'), '::1');
  for (const bad of ['0.0.0.0', '::', 'example.com', '']) {
    assert.throws(() => validateBind(bad), (e: unknown) => e instanceof JvError && e.exitCode === 2, bad);
  }
  await assert.rejects(startUiServer({ port: 0, bind: '0.0.0.0', logFile: false }), (e: unknown) => e instanceof JvError && e.exitCode === 2);
  await assert.rejects(startUiServer({ port: ui.port, logFile: false }), (e: unknown) => e instanceof JvError && /in use; pass another --port/.test((e as Error).message));
});

test('the evidence route serves only images under the task worktree .jv-evidence, after sign-in', async () => {
  const ok = await client.get(`/evidence/${fx.tasks.asked}/customers-empty-desktop.png`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
  assert.deepEqual(ok.body, readFileSync(join(fx.worktree, '.jv-evidence', 'customers-empty-desktop.png')));
  const head = await client.get(`/evidence/${fx.tasks.asked}/customers-empty-phone.png`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const refused = [
    `/evidence/${fx.tasks.asked}/notes.png`,
    `/evidence/${fx.tasks.asked}/link.png`,
    `/evidence/${fx.tasks.asked}/..%2Foutside.png`,
    `/evidence/${fx.tasks.asked}/%2e%2e/outside.png`,
    `/evidence/${fx.tasks.asked}/..%2Fsecret.txt`,
    `/evidence/${fx.tasks.asked}/missing.png`,
    `/evidence/${fx.tasks.asked}/%2Fetc%2Fpasswd`,
    `/evidence/${fx.tasks.asked}/customers-empty-desktop.png%00.txt`,
    `/evidence/${fx.tasks.running}/customers-empty-desktop.png`,
    '/evidence/T000000/customers-empty-desktop.png',
    `/evidence/${fx.tasks.asked}/`,
    `/evidence/${fx.tasks.asked}/../outside.png`,
    `/evidence/%zz/x.png`,
  ];
  for (const path of refused) {
    const r = await client.get(path);
    assert.equal(r.status, 404, path);
    assert.doesNotMatch(r.text, /not for the viewer|jv-evidence|\/tmp\/|\/var\//, path);
  }
  // A raw ../ climbing out of /evidence/ is normalised away by the URL parser: the page shell, never the file.
  const climb = await client.get(`/evidence/${fx.tasks.asked}/../../../../etc/passwd`);
  assert.ok(climb.status === 404 || climb.text === INDEX);
  assert.doesNotMatch(climb.text, /root:/);
  assert.equal((await raw(ui.url, `/evidence/${fx.tasks.asked}/customers-empty-desktop.png`)).status, 401);
});

test('one log line per request: time, method, path without query values, status, ms; no bodies or cookies', async () => {
  await client.get('/api/tasks?project=secret-project-name&state=queued');
  await client.post('/api/login', { password });
  await client.get('/nowhere-route');
  await new Promise((r) => setTimeout(r, 50));
  const log = readFileSync(logFile, 'utf8');
  const lines = log.trim().split('\n');
  for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \S+ \d{3} \d+ms$/, line);
  assert.ok(lines.some((l) => / GET \/api\/tasks\?project&state \d{3} /.test(l)));
  assert.ok(lines.some((l) => / POST \/api\/login 200 /.test(l)));
  assert.doesNotMatch(log, /secret-project-name|queued/);
  assert.ok(!log.includes(password), 'never the password');
  assert.ok(!log.includes(client.cookie.split('=')[1]!), 'never the cookie');
});

test('the pid file: held while serving, a second instance refused with the pid, stale taken over, removed on close', async () => {
  const file = join(home, 'run', 'ui.pid');
  const first = await startUiServer({ port: 0, pidFile: file, logFile: false, tail: () => undefined });
  try {
    const record = readPidRecord(file)!;
    assert.equal(record.pid, process.pid);
    assert.equal(record.url, first.url);
    assert.equal(record.readonly, false);
    await assert.rejects(
      startUiServer({ port: 0, pidFile: file, logFile: false }),
      (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message.includes(`jv ui is already running (pid ${process.pid}, ${first.url})`),
    );
  } finally {
    await first.close();
  }
  assert.equal(existsSync(file), false, 'removed on close');

  // A stale file (its process is gone) is taken over.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const dead = await new Promise<number>((resolve) => child.on('exit', () => resolve(child.pid!)));
  writeFileSync(file, `${JSON.stringify({ pid: dead, startedAt: '2026-11-01T00:00:00.000Z' })}\n`);
  const takeover = await startUiServer({ port: 0, pidFile: file, logFile: false, tail: () => undefined });
  assert.equal(readPidRecord(file)!.pid, process.pid);
  await takeover.close();

  // A live process that started before the file was written holds it; one that started after it (a pid reused
  // after a crash or a reboot) does not.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(file, `${JSON.stringify({ pid: other.pid, startedAt: new Date(Date.now() + 2000).toISOString() })}\n`);
    assert.throws(() => acquirePidFile(file), (e: unknown) => e instanceof JvError && e.message.includes(`pid ${other.pid}`));
    writeFileSync(file, `${JSON.stringify({ pid: other.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() })}\n`);
    const taken = acquirePidFile(file);
    assert.equal(readPidRecord(file)!.pid, process.pid, 'a reused pid is stale');
    taken.release();
    writeFileSync(file, `${other.pid}\n`);
    assert.throws(() => acquirePidFile(file), /already running/, 'a bare pid of a live process holds it');
  } finally {
    other.kill();
  }
  rmSync(file, { force: true });
  assert.equal(existsSync(file), false);
});

test('a store of a newer schema is refused at start, and the pid file is let go', async () => {
  const file = join(home, 'newer.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '9')");
  db.close();
  const pid = join(home, 'run', 'newer.pid');
  await assert.rejects(
    startUiServer({ port: 0, storeFile: file, pidFile: pid, logFile: false }),
    (e: unknown) => e instanceof JvError && e.exitCode === 2 && /store schema 9 is newer than this jv/.test(e.message),
  );
  assert.equal(existsSync(pid), false);
});
