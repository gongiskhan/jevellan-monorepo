// jevellan-mcp over real processes (brief sections 4 and 5): `jv mcp` (the built jevellan-cli) and the jv-mcp bin
// over stdio with the SDK's Client (initialize, tools/list, a call; no pid file; the process ends with stdin), and
// `jv mcp --http` on an ephemeral loopback port: the token written once (mode 600) and printed once, 401 and no body
// without it or with a wrong one, tools/list with it (raw requests, stateless: two independent requests both work, and
// the SDK client), GET /health without a token, 404 elsewhere, 405 for GET /mcp, the pid file (a second instance
// refused with the running pid, a stale one taken over, removed on SIGTERM), a port in use refused naming --port,
// --token-reset, --json without the token, and one log line per call. Temporary JV_HOMEs; port 7072 is never bound.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome, readText } from './fixtures/home.js';

const coreRoot = dirname(createRequire(import.meta.url).resolve('jevellan-core/package.json'));
const CLI_BIN = join(coreRoot, '..', 'cli', 'dist', 'bin.js');
const MCP_BIN = join(coreRoot, '..', 'mcp', 'dist', 'bin.js');
const VERSION = (JSON.parse(readFileSync(join(coreRoot, '..', 'mcp', 'package.json'), 'utf8')) as { version: string }).version;
const home = makeHome('jv-mcp-transports-test-', coreRoot);
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const homes = [home];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const SECTION_5_COUNT = 34;
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

function env(jvHome: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? jvHome, JV_HOME: jvHome };
}

function jv(jvHome: string, args: string[]) {
  return spawnSync(process.execPath, [...NODE_ARGS, CLI_BIN, ...args], { env: env(jvHome), encoding: 'utf8', timeout: 30_000 });
}

/** Starts `jv mcp --http --port 0 ...` and resolves when its URL line is printed. */
function startHttp(jvHome: string, extra: string[] = []): Promise<{ child: ChildProcess; url: string; stdout: () => string; stderr: () => string; exited: Promise<number | null> }> {
  const child = spawn(process.execPath, [...NODE_ARGS, CLI_BIN, 'mcp', '--http', '--port', '0', ...extra], { env: env(jvHome), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL within 20 s: ${out} ${err}`)), 20_000);
    const check = () => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1]!, stdout: () => out, stderr: () => err, exited });
      }
    };
    child.stdout!.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      check();
    });
    child.stderr!.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`jv mcp --http exited ${code}: ${out} ${err}`));
    });
  });
}

const pidFile = (jvHome: string) => join(jvHome, 'run', 'mcp.pid');
const tokenFile = (jvHome: string) => join(jvHome, 'secrets', 'mcp.token');
const logLines = (jvHome: string) =>
  readText(join(jvHome, 'logs', 'mcp.log'))
    .split('\n')
    .filter((l) => l !== '');

async function rpc(url: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function stdioClient(command: string, args: string[], jvHome: string) {
  const transport = new StdioClientTransport({ command, args, env: env(jvHome), stderr: 'pipe' });
  const client = new Client({ name: 'jv-mcp-stdio-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

test('jv mcp over stdio: initialize, every tool, a call; no pid file; it ends when stdin closes', async () => {
  const { client, transport } = await stdioClient(process.execPath, [...NODE_ARGS, CLI_BIN, 'mcp'], home);
  const pid = transport.pid;
  try {
    assert.equal(client.getServerVersion()?.name, 'jevellan');
    assert.equal(client.getServerVersion()?.version, VERSION);
    const { tools } = await client.listTools();
    assert.equal(tools.length, SECTION_5_COUNT);
    assert.ok(tools.some((t) => t.name === 'jv_task_create'));
    const r = (await client.callTool({ name: 'jv_status', arguments: {} })) as unknown as { structuredContent: { tasks: unknown[] }; content: Array<{ text: string }> };
    assert.deepEqual(r.structuredContent.tasks, []);
    assert.match(r.content[0]!.text, /No projects yet/);
    assert.ok(!existsSync(pidFile(home)), 'stdio writes no pid file');
  } finally {
    await client.close();
  }
  assert.ok(pid !== null);
  for (let i = 0; i < 50 && isAliveLike(pid!); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAliveLike(pid!), false, 'the server ended with its stdin');
  assert.deepEqual(
    logLines(home).map((l) => l.split(' ')[1]),
    ['jv_status'],
  );
});

function isAliveLike(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('the jv-mcp bin serves the same over stdio, and registers memory on a fresh home', async () => {
  const fresh = makeHome('jv-mcp-bin-test-', coreRoot);
  homes.push(fresh);
  const { client } = await stdioClient(process.execPath, [...NODE_ARGS, MCP_BIN], fresh);
  after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, SECTION_5_COUNT);
  const r = (await client.callTool({ name: 'jv_memory_add', arguments: { kind: 'fact', text: 'Made up for the test', scope: 'global' } })) as unknown as { isError?: boolean; structuredContent: { created: boolean; memory: { source: string } } };
  assert.ok(!r.isError);
  assert.deepEqual([r.structuredContent.created, r.structuredContent.memory.source], [true, 'mcp']);
  await client.close();
});

test('jv mcp --http: token once, 401 without it, tools/list with it, stateless, /health, 404, 405, the log', async () => {
  const server = await startHttp(home);
  const token = readFileSync(tokenFile(home), 'utf8').trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(statSync(tokenFile(home)).mode & 0o777, 0o600);
  assert.ok(server.stdout().includes(`MCP token written to ${tokenFile(home)} (shown once):\n${token}\n`), server.stdout());
  assert.equal(readFileSync(pidFile(home), 'utf8'), `${server.child.pid}\n`);

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  for (const bad of [undefined, 'fake-wrong-token']) {
    const r = await rpc(server.url, bad, list);
    assert.equal(r.status, 401);
    assert.equal(await r.text(), '');
  }
  // Stateless: two independent requests, no initialize, no session id.
  for (const id of [1, 2]) {
    const r = await rpc(server.url, token, { ...list, id });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { id: number; result: { tools: Array<{ name: string }> } };
    assert.equal(body.id, id);
    assert.equal(body.result.tools.length, SECTION_5_COUNT);
  }

  const base = server.url.replace(/\/mcp$/, '');
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), `{"ok":true,"version":"${VERSION}"}`);
  for (const path of ['/', '/mcp/x', '/health/x', '/api/status']) {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 404, path);
    assert.equal(await r.text(), '');
  }
  const get = await fetch(server.url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(get.status, 405);

  // The SDK's own client, as Claude Code or the Claude app would connect.
  const client = new Client({ name: 'jv-mcp-http-test', version: '0.0.0' });
  after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, SECTION_5_COUNT);
  const status = (await client.callTool({ name: 'jv_status', arguments: { project: 'nowhere' } })) as { isError?: boolean; structuredContent: unknown };
  assert.equal(status.isError, true);
  assert.deepEqual(status.structuredContent, { error: 'no project nowhere', exitCode: 3 });
  await client.close();

  // A second instance is refused with the running pid; --token-reset is refused while it runs.
  const second = jv(home, ['mcp', '--http', '--port', '0']);
  assert.equal(second.status, 2);
  assert.match(second.stderr, new RegExp(`already running \\(pid ${server.child.pid}\\)`));
  const reset = jv(home, ['mcp', '--token-reset']);
  assert.equal(reset.status, 2);
  assert.match(reset.stderr, /is running/);
  assert.equal(readFileSync(tokenFile(home), 'utf8').trim(), token);

  server.child.kill('SIGTERM');
  assert.equal(await server.exited, 0);
  assert.ok(!existsSync(pidFile(home)), 'the pid file is removed on SIGTERM');

  // One line per tool call (the stdio test's and this one's), none for tools/list.
  const lines = logLines(home);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0]!, /^\S+Z jv_status \d+ms exit=0$/);
  assert.match(lines[1]!, /^\S+Z jv_status project=nowhere \d+ms exit=3$/);
});

test('jv mcp --http: a stale pid file is taken over, the token is not printed again, --token-reset rotates it', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  mkdirSync(dirname(pidFile(home)), { recursive: true });
  writeFileSync(pidFile(home), `${dead}\n`);
  const before = readFileSync(tokenFile(home), 'utf8').trim();
  const server = await startHttp(home);
  assert.equal(readFileSync(pidFile(home), 'utf8'), `${server.child.pid}\n`);
  assert.ok(!server.stdout().includes(before), 'an existing token is never printed');
  assert.ok(!server.stdout().includes('shown once'));
  server.child.kill('SIGINT');
  assert.equal(await server.exited, 0);

  const reset = jv(home, ['mcp', '--token-reset']);
  assert.equal(reset.status, 0, reset.stderr);
  const after = readFileSync(tokenFile(home), 'utf8').trim();
  assert.notEqual(after, before);
  assert.equal(reset.stdout, `MCP token written to ${tokenFile(home)} (shown once):\n${after}\n`);
  assert.equal(statSync(tokenFile(home)).mode & 0o777, 0o600);

  const refused = jv(home, ['mcp', '--stdio', '--http']);
  assert.equal(refused.status, 2);
  const stdioReset = jv(home, ['mcp', '--stdio', '--token-reset']);
  assert.equal(stdioReset.status, 2);
});

test('jv mcp --http: a port in use is refused naming --port, and leaves no pid file', async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const port = (blocker.address() as { port: number }).port;
  try {
    const r = jv(home, ['mcp', '--http', '--port', String(port)]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`port ${port} on 127\\.0\\.0\\.1 is in use; give another with --port`));
    assert.ok(!existsSync(pidFile(home)));
    const bind = jv(home, ['mcp', '--http', '--port', '0', '--bind', '0.0.0.0']);
    assert.equal(bind.status, 2);
    assert.match(bind.stderr, /every-interface/);
  } finally {
    blocker.close();
  }
});

test('jv mcp --http --json prints {url, port, bind, pid, tokenFile, tokenWritten} and never the token', async () => {
  const fresh = makeHome('jv-mcp-json-test-', coreRoot);
  homes.push(fresh);
  const server = await startHttp(fresh, ['--json']);
  for (let i = 0; i < 50 && !server.stdout().trimEnd().endsWith('}'); i++) await new Promise((r) => setTimeout(r, 50));
  const printed = JSON.parse(server.stdout()) as Record<string, unknown>;
  const token = readFileSync(tokenFile(fresh), 'utf8').trim();
  assert.deepEqual(Object.keys(printed), ['url', 'port', 'bind', 'pid', 'tokenFile', 'tokenWritten']);
  assert.deepEqual([printed.bind, printed.pid, printed.tokenFile, printed.tokenWritten], ['127.0.0.1', server.child.pid, tokenFile(fresh), true]);
  assert.ok(!server.stdout().includes(token) && !server.stderr().includes(token), 'the token is not printed with --json');
  server.child.kill('SIGTERM');
  assert.equal(await server.exited, 0);
});
