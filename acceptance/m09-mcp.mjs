// M9 MCP (brief section 14): the control MCP of jevellan-mcp, driven the way its clients drive it, in a temporary
// JV_HOME under ~/.jv-test/<run id>/ (removed at the end unless --keep):
//
// 1. stdio: a Claude Code session started by this script (~/.local/bin/claude, the owner's own login: no provider
//    token, CLAUDE_CODE_* variables removed by lib.mjs childEnv) with --mcp-config naming `<checkout>/bin/jv.mjs mcp`
//    with JV_HOME set, --strict-mcp-config, --setting-sources user, --permission-mode dontAsk, --allowedTools for the
//    jv read tools only, --max-turns 3 and -p "Use jv_status and tell me how many projects there are" answers with
//    the number of projects the home has (realJvHome registers the sandbox: one), and the server's log shows the call.
//    Like every `claude -p` run, that session records its working folder (~/.jv-test/<run id>/) in the owner's
//    ~/.claude.json; the brief asks for this session, and nothing else of the owner's configuration is written.
// 2. HTTP: `jv mcp --http --json` on a free loopback port (never 7072): tools/list with the token (read from
//    <home>/secrets/mcp.token, never printed) returns every tool of section 5, without the token 401 and no body,
//    GET /health 200 {"ok":true,"version":"<version>"}; a tool call over HTTP works.
// 3. <home>/logs/mcp.log holds one line per tool call (the HTTP ones counted exactly, the session's all jv tools) and
//    none of the arguments; no secret of the home is in the log or the store.
//
// --offline runs everything without a model or the real providers: a plain temporary home with a throwaway git
// repository registered as its one project, and in place of the Claude Code session a scripted stdio client (raw
// JSON-RPC: initialize, tools/list, tools/call jv_status) on the same `bin/jv.mjs mcp`. It checks the journey's
// wiring and records nothing.
//
// Usage: node acceptance/m09-mcp.mjs [--offline] [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m09.json (not with --offline).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN_JV,
  CHECKOUT,
  check,
  childEnv,
  cleanup,
  fileUrl,
  finish,
  firstJsonObject,
  freePort,
  git,
  HOME,
  jvJson,
  leakCheck,
  log,
  neutralCwd,
  NODE,
  note,
  packageVersion,
  parseFlags,
  realJvHome,
  removeWorktreesUnder,
  run,
  runDir,
  runId,
  runJourney,
  SANDBOX,
  startJv,
  stopChild,
  storeFile,
  tempHome,
} from './lib.mjs';

const JOURNEY = 'm09';
const USAGE = 'node acceptance/m09-mcp.mjs [--offline] [--keep]';
const CLAUDE = join(HOME, '.local', 'bin', 'claude');
const PROMPT = 'Use jv_status and tell me how many projects there are';
/** The key of the server in the MCP config: Claude Code names its tools mcp__<key>__<tool>. */
const SERVER_KEY = 'jv';

/** The tools of brief section 5, in its order. */
const SECTION_5 = [
  'jv_status', 'jv_project_list', 'jv_project_add',
  'jv_task_list', 'jv_task_show', 'jv_task_create', 'jv_task_message', 'jv_task_answer', 'jv_task_stop', 'jv_task_resume', 'jv_task_override', 'jv_task_changes',
  'jv_land', 'jv_report_get', 'jv_tail',
  'jv_coordinator_status', 'jv_coordinator_message', 'jv_coordinator_transcript',
  'jv_memory_search', 'jv_memory_add', 'jv_memory_archive',
  'jv_schedule_list', 'jv_schedule_add', 'jv_schedule_run', 'jv_schedule_pause', 'jv_schedule_resume',
  'jv_goal_list', 'jv_goal_add', 'jv_goal_done',
  'jv_job_list', 'jv_job_run',
  'jv_usage', 'jv_doctor', 'jv_bot_status',
];

/** One line of mcp.log: time, tool, the project and task ids, duration, exit code (section 5), nothing else. */
const LOG_LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (jv_[a-z_]+)( project=[A-Za-z0-9._:-]+)?( task=[A-Za-z0-9._:-]+)? \d+ms exit=\d$/;

function logLines(home) {
  const file = join(home, 'logs', 'mcp.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l !== '') : [];
}

/** The tools that change nothing (jevellan-mcp's own table), the only ones the Claude Code session may call. */
async function readTools() {
  const { operations } = await import(fileUrl(join(CHECKOUT, 'packages', 'mcp', 'dist', 'tools.js')));
  return { names: operations.map((o) => o.name), reads: operations.filter((o) => !o.mutates).map((o) => o.name) };
}

/** The MCP config Claude Code is given: this checkout's jv over stdio, with the temporary home. */
function writeMcpConfig(dir, home) {
  const file = join(dir, 'mcp-config.json');
  const config = { mcpServers: { [SERVER_KEY]: { type: 'stdio', command: NODE, args: ['--disable-warning=ExperimentalWarning', BIN_JV, 'mcp'], env: { JV_HOME: home } } } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** A word or digit count in an answer: "1", "one", "a single". */
function mentionsCount(text, n) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const t = String(text).toLowerCase();
  if (new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(t)) return true;
  if (words[n] && new RegExp(`\\b${words[n]}\\b`).test(t)) return true;
  return n === 1 && /\ba single\b|\bonly one\b|\bjust one\b/.test(t);
}

/** Raw JSON-RPC over the stdio of `bin/jv.mjs mcp`: initialize, then each request; resolves the responses by id. */
function stdioExchange(home, requests, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', BIN_JV, 'mcp'], { cwd: neutralCwd(), env: childEnv({ JV_HOME: home }), stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = new Map();
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`no answer within ${timeoutMs / 1000} s: ${stderr.slice(-500)}`));
    }, timeoutMs);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const all = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm09', version: '0' } } }, ...requests];
    child.stdout.on('data', (c) => {
      buffer += c.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        responses.set(msg.id, msg);
        if (msg.id === 0) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          for (const r of requests) send(r);
        }
        if (responses.size === all.length) {
          clearTimeout(timer);
          child.stdin.end();
        }
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (responses.size === all.length) resolve({ responses, code, stderr });
      else reject(new Error(`jv mcp exited ${code} after ${responses.size} of ${all.length} answers: ${stderr.slice(-500)}`));
    });
    send(all[0]);
  });
}

async function httpRpc(url, token, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

/** A home without real providers: a throwaway repository registered as its one project (--offline). */
function offlineHome(id) {
  const home = tempHome(id);
  const repo = join(runDir(id), 'repo');
  mkdirSync(repo, { recursive: true });
  const g = (args) => run('git', ['-c', 'user.name=M9', '-c', 'user.email=m9@example.test', '-C', repo, ...args], { env: childEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  g(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), '# m09 offline\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'first']);
  const r = jvJson(['project', 'add', repo, '--name', 'm09-offline'], { home });
  if (r.code !== 0) throw new Error(`jv project add: ${r.stderr || r.stdout}`);
  return { home, projects: [{ name: 'm09-offline', path: repo }] };
}

async function stdioPart({ home, dir, expected, offline, reads }) {
  const before = logLines(home).length;
  if (offline) {
    await check('stdio (scripted client): initialize, every tool of section 5, jv_status names the projects', async () => {
      const { responses } = await stdioExchange(home, [
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jv_status', arguments: {} } },
      ]);
      const names = responses.get(1)?.result?.tools?.map((t) => t.name) ?? [];
      const text = responses.get(2)?.result?.content?.[0]?.text ?? '';
      const listed = expected.filter((p) => text.includes(`${p.name} (`)).length;
      const ok = responses.get(0)?.result?.serverInfo?.name === 'jevellan' && JSON.stringify(names) === JSON.stringify(SECTION_5) && listed === expected.length;
      return { ok, detail: `${names.length} tools; jv_status lists ${listed} of ${expected.length} projects` };
    });
  } else {
    await check(`Claude Code over stdio answers "${PROMPT}" with ${expected.length}`, async () => {
      if (!existsSync(CLAUDE)) return { ok: false, detail: `no Claude Code at ${CLAUDE}` };
      const config = writeMcpConfig(dir, home);
      const allowed = reads.map((t) => `mcp__${SERVER_KEY}__${t}`).join(',');
      const r = run(
        CLAUDE,
        ['-p', PROMPT, '--mcp-config', config, '--strict-mcp-config', '--setting-sources', 'user', '--permission-mode', 'dontAsk', '--allowedTools', allowed, '--max-turns', '3', '--output-format', 'json'],
        { cwd: dir, env: childEnv(), timeoutMs: 300_000 },
      );
      const answer = r.json?.result ?? '';
      const ok = r.code === 0 && r.json?.is_error !== true && /project/i.test(answer) && mentionsCount(answer, expected.length);
      return { ok, detail: ok ? `${String(answer).replace(/\s+/g, ' ').slice(0, 200)} (${r.json?.num_turns ?? '?'} turns, ${Math.round(r.ms / 1000)} s)` : `exit ${r.code}: ${String(answer || r.stderr || r.stdout).replace(/\s+/g, ' ').slice(0, 400)}` };
    });
  }
  await check('the stdio calls are in mcp.log: jv_status among them, jv tools only, exit 0', () => {
    const lines = logLines(home).slice(before);
    const tools = lines.map((l) => LOG_LINE.exec(l)?.[1]);
    const ok = lines.length > 0 && tools.includes('jv_status') && tools.every((t) => t && (offline || reads.includes(t))) && lines.every((l) => l.endsWith(' exit=0'));
    return { ok, detail: lines.map((l) => l.split(' ').slice(1).join(' ')).join('; ') || 'no line' };
  });
}

async function httpPart({ home, expected }) {
  const port = await freePort();
  const before = logLines(home).length;
  let server;
  try {
    await check(`jv mcp --http --json listens on 127.0.0.1:${port} and writes the token (mode 600) without printing it`, async () => {
      server = await startJv(['mcp', '--http', '--port', String(port), '--json'], { home, ready: (out) => firstJsonObject(out) });
      const file = join(home, 'secrets', 'mcp.token');
      const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      const out = server.output();
      const shown = token !== '' && (out.stdout.includes(token) || out.stderr.includes(token));
      const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0;
      const ok = server.value.url === `http://127.0.0.1:${port}/mcp` && /^[A-Za-z0-9_-]{43}$/.test(token) && mode === 0o600 && !shown;
      return { ok, detail: `${server.value.url}, token ${token ? 'written' : 'missing'}, mode ${mode.toString(8)}${shown ? ', PRINTED' : ''}` };
    });
    if (!server) return;
    const url = server.value.url;
    const token = readFileSync(join(home, 'secrets', 'mcp.token'), 'utf8').trim();
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    await check('tools/list with the token returns every tool of section 5', async () => {
      const r = await httpRpc(url, token, list);
      const names = r.json?.result?.tools?.map((t) => t.name) ?? [];
      const missing = SECTION_5.filter((n) => !names.includes(n));
      const extra = names.filter((n) => !SECTION_5.includes(n));
      return { ok: r.status === 200 && missing.length === 0 && extra.length === 0, detail: `HTTP ${r.status}, ${names.length} tools${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}` };
    });
    await check('without the token (or with a wrong one) 401 and no body', async () => {
      const none = await httpRpc(url, undefined, list);
      const wrong = await httpRpc(url, 'fake-not-the-token', list);
      return { ok: none.status === 401 && none.text === '' && wrong.status === 401 && wrong.text === '', detail: `no token: ${none.status} (${none.text.length} bytes); wrong token: ${wrong.status} (${wrong.text.length} bytes)` };
    });
    await check('GET /health answers 200 {"ok":true,"version":...} without a token; anything else 404', async () => {
      const base = url.replace(/\/mcp$/, '');
      const h = await fetch(`${base}/health`);
      const body = await h.text();
      const other = await fetch(`${base}/status`);
      const want = JSON.stringify({ ok: true, version: packageVersion() });
      return { ok: h.status === 200 && body === want && other.status === 404, detail: `${h.status} ${body}; /status ${other.status}` };
    });
    await check('a tool call over HTTP: jv_status lists the projects (stateless: no initialize, no session)', async () => {
      const r = await httpRpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jv_status', arguments: {} } });
      const text = r.json?.result?.content?.[0]?.text ?? '';
      const listed = expected.filter((p) => text.includes(`${p.name} (`)).length;
      return { ok: r.status === 200 && !r.json?.result?.isError && listed === expected.length, detail: `HTTP ${r.status}; ${listed} of ${expected.length} projects` };
    });
    await check('mcp.log: exactly one line for the one HTTP tool call (none for tools/list)', () => {
      const lines = logLines(home).slice(before);
      return { ok: lines.length === 1 && /^\S+Z jv_status \d+ms exit=0$/.test(lines[0]), detail: lines.join('; ') || 'no line' };
    });
  } finally {
    if (server) await stopChild(server.child);
  }
  await check('SIGTERM stopped jv mcp --http and removed its pid file', () => {
    const pid = join(home, 'run', 'mcp.pid');
    return { ok: server?.child.exitCode === 0 && !existsSync(pid), detail: `exit ${server?.child.exitCode ?? 'none'}, pid file ${existsSync(pid) ? 'left behind' : 'removed'}` };
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { booleans: ['offline'], usage: USAGE });
  const offline = flags.offline === true;
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M9 MCP ${id}${offline ? ' (offline)' : ''}`);
  let home;
  try {
    const { names, reads } = await readTools();
    await check('jevellan-mcp serves exactly the tools of section 5', () => ({ ok: JSON.stringify(names) === JSON.stringify(SECTION_5), detail: `${names.length} tools, ${reads.length} read-only` }));
    const setup = offline ? offlineHome(id) : realJvHome(id);
    home = setup.home;
    note(`temporary home ${home}${offline ? '' : `; seeded ${setup.seeded.secrets.length} secret files; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}`}`);
    const expected = setup.projects;
    await stdioPart({ home, dir: runDir(id), expected, offline, reads });
    await httpPart({ home, expected });
    await check('mcp.log: one line per call, the format of section 5, none of the arguments', () => {
      const lines = logLines(home);
      const bad = lines.filter((l) => !LOG_LINE.test(l) || l.includes(PROMPT) || l.includes('how many'));
      return { ok: lines.length > 0 && bad.length === 0, detail: `${lines.length} lines${bad.length ? `; not in the format: ${bad.join(' | ')}` : ''}` };
    });
    await check('no secret of the home (the MCP token included) in the store, its WAL or the logs', () => {
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
    return finish(JOURNEY, { startedAt: started, mode: offline ? 'offline (scripted stdio client)' : 'Claude Code (owner login) over stdio, HTTP on a free port', record: !offline });
  } finally {
    if (home && !offline) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    if (!flags.keep) cleanup(id);
    else if (home) note(`kept ${home} (git ${git(CHECKOUT, ['rev-parse', '--short', 'HEAD'])})`);
  }
}

runJourney(JOURNEY, main);
