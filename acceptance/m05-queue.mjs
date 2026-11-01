// M5 Queue under the bot (brief section 14), on the sandbox clone ~/jevellan-projects/jv-mono-sandbox-clone (so a
// failed journey never dirties the main sandbox), with the real providers and Jev in a temporary JV_HOME (lib.mjs
// realJvHome; Codex disabled there, D-022):
// 1. bot.json limits perProject 2, total 2; the coordinator started for the clone; the bot running.
// 2. Three feature tasks created at once through jv_task_create over the MCP (stdio, an SDK client on `jv mcp`).
// 3. The bot admits two; the third waits with reason "waiting for a slot" and starts when one ends.
// 4. All three land (route land) or are asked with a stated reason; the elapsed time of each is recorded.
// 5. The coordinator received the wake lines (its transcript holds [jv] lines naming the tasks).
// The clone's main branch keeps what landed. The coordinator and the bot are stopped at the end and the temporary home
// removed (with its worktrees, from the clone's worktree list) unless --keep.
//
// Usage: node acceptance/m05-queue.mjs [--keep] [--timeout-min 90]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m05.json.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BIN_JV,
  CHECKOUT,
  check,
  childEnv,
  cleanup,
  ensureSandboxClone,
  finish,
  freePort,
  jv,
  jvJson,
  log,
  NODE,
  note,
  parseFlags,
  query,
  realJvHome,
  removeWorktreesUnder,
  runId,
  runJourney,
  SANDBOX_CLONE,
  SANDBOX_CLONE_NAME,
  startJv,
  stopChild,
  storeFile,
  waitFor,
} from './lib.mjs';

const JOURNEY = 'm05';
const USAGE = 'node acceptance/m05-queue.mjs [--keep] [--timeout-min 90]';

const TASKS = [
  {
    title: 'README: how to run the unit tests',
    text: 'What: add a short "Running the tests" section to README.md that says to run `npm ci` once and then `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test`.\nWhy: the bare `npm test` fails without those variables and new contributors do not know.\nWhere: README.md only.\nDone when: the section is in README.md and the unit tests still pass.',
  },
  {
    title: 'CONTRIBUTING.md with three short rules',
    text: 'What: add CONTRIBUTING.md with three short rules: work on a branch, run the unit tests before asking for a review, keep changes small.\nWhy: the project has no contribution guide.\nWhere: a new file CONTRIBUTING.md at the root, nothing else.\nDone when: the file exists with the three rules and the unit tests still pass.',
  },
  {
    title: 'Unit test: invoice total of no lines is zero',
    text: 'What: add one unit test to src/invoices/index.test.ts that checks the invoice total of an invoice with no lines is 0.\nWhy: the empty case is not covered.\nWhere: src/invoices/index.test.ts only; do not change the source.\nDone when: the new test passes with `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test`.',
  },
];

async function botConfig() {
  return { tickSeconds: 15, limits: { perProject: 2, total: 2 }, quietHours: null, health: { bind: '127.0.0.1', port: await freePort() }, logLines: 20000 };
}

/** An MCP client on `jv mcp` (stdio) for the temporary home, from the SDK the checkout installs. */
async function mcpClient(home) {
  const require = createRequire(join(CHECKOUT, 'packages', 'mcp', 'package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const transport = new StdioClientTransport({ command: NODE, args: ['--disable-warning=ExperimentalWarning', BIN_JV, 'mcp'], env: childEnv({ JV_HOME: home }) });
  const client = new Client({ name: 'acceptance-m05', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['timeout-min'], usage: USAGE });
  const timeoutMs = Number(flags['timeout-min'] ?? 90) * 60_000;
  const started = Date.now();
  const id = runId(JOURNEY);
  ensureSandboxClone();
  log(`M5 Queue under the bot ${id}`);
  let home;
  let bot;
  let client;
  const created = [];
  try {
    const setup = realJvHome(id, { projects: [[SANDBOX_CLONE, SANDBOX_CLONE_NAME]] });
    home = setup.home;
    writeFileSync(join(home, 'bot.json'), `${JSON.stringify(await botConfig(), null, 2)}\n`);
    note(`temporary home ${home}; limits perProject 2, total 2; codex disabled`);

    await check('the coordinator starts for the clone', () => {
      const r = jvJson(['coordinator', 'start', '--project', SANDBOX_CLONE_NAME], { home, timeoutMs: 180_000 });
      return { ok: r.code === 0 && (r.json?.running ?? r.json?.started) !== false, detail: r.code === 0 ? `session ${r.json?.session ?? r.json?.sessionId ?? '?'}` : r.stderr || r.stdout };
    });

    await check('the bot starts', async () => {
      bot = await startJv(['bot', 'start'], { home, ready: (out, err) => /tick|started|bot/i.test(out + err), timeoutMs: 60_000 });
      return { ok: true, detail: `pid ${bot.child.pid}` };
    });

    await check('three feature tasks created at once through jv_task_create over the MCP (stdio)', async () => {
      client = await mcpClient(home);
      const results = await Promise.all(
        TASKS.map((t) => client.callTool({ name: 'jv_task_create', arguments: { project: SANDBOX_CLONE_NAME, kind: 'feature', title: t.title, text: t.text } })),
      );
      for (const r of results) {
        if (r.isError) return { ok: false, detail: r.content?.[0]?.text ?? 'error' };
        created.push({ id: r.structuredContent.task.id, title: r.structuredContent.task.title, created: Date.now() });
      }
      const origins = query(storeFile(home), `SELECT id, origin FROM tasks WHERE id IN (${created.map(() => '?').join(',')})`, ...created.map((t) => t.id));
      return { ok: created.length === 3 && origins.every((o) => o.origin === 'mcp'), detail: created.map((t) => t.id).join(', ') };
    });

    let waiting;
    await check('two are admitted; the third waits with reason "waiting for a slot"', async () => {
      const state = await waitFor(
        () => {
          const rows = query(storeFile(home), `SELECT id, state, state_reason FROM tasks WHERE id IN (${created.map(() => '?').join(',')})`, ...created.map((t) => t.id));
          const queued = rows.filter((r) => r.state === 'queued');
          const running = rows.filter((r) => r.state === 'running');
          return running.length === 2 && queued.length === 1 ? { running, queued } : undefined;
        },
        { timeoutMs: 5 * 60_000, intervalMs: 2000 },
      );
      waiting = state?.queued[0];
      return { ok: !!state && waiting.state_reason === 'waiting for a slot', detail: state ? `running ${state.running.map((r) => r.id).join(', ')}; queued ${waiting.id}: ${waiting.state_reason}` : 'not seen' };
    });

    await check('the third starts when a slot frees', async () => {
      if (!waiting) return { ok: false, detail: 'no waiting task' };
      const started3 = await waitFor(() => {
        const row = query(storeFile(home), 'SELECT state FROM tasks WHERE id = ?', waiting.id)[0];
        return row && row.state !== 'queued' ? row.state : undefined;
      }, { timeoutMs, intervalMs: 5000 });
      return { ok: !!started3, detail: `${waiting.id} ${started3 ?? 'still queued'}` };
    });

    await check('all three land (route land) or are asked with a stated reason', async () => {
      const ends = await waitFor(
        () => {
          const rows = created.map((t) => {
            const task = query(storeFile(home), 'SELECT id, state, state_reason, landed_commit, ended_at FROM tasks WHERE id = ?', t.id)[0];
            const landing = query(storeFile(home), 'SELECT route, state, reason FROM landings WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', t.id)[0];
            return { ...task, landing };
          });
          const settled = rows.every((r) => (r.state === 'done' && r.landed_commit) || (r.landing?.state === 'asked' && r.landing.reason) || r.state === 'failed');
          return settled ? rows : undefined;
        },
        { timeoutMs, intervalMs: 10_000 },
      );
      if (!ends) return { ok: false, detail: 'not settled in time' };
      for (const r of ends) {
        const t = created.find((x) => x.id === r.id);
        note(`${r.id} ${t.title}: ${r.state}${r.landed_commit ? ` landed ${r.landed_commit.slice(0, 10)}` : ''}${r.landing ? ` (route ${r.landing.route}, ${r.landing.state}${r.landing.reason ? `: ${r.landing.reason}` : ''})` : ''}; ${r.ended_at ? Math.round((Date.parse(r.ended_at) - t.created) / 1000) : '?'} s`);
      }
      const ok = ends.every((r) => (r.state === 'done' && r.landed_commit && r.landing?.route === 'land') || (r.landing?.state === 'asked' && r.landing.reason));
      return { ok, detail: ends.map((r) => `${r.id} ${r.state}`).join(', ') };
    });

    await check('the coordinator received the wake lines', () => {
      const rows = query(
        storeFile(home),
        "SELECT e.payload FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.kind = 'coordinator' AND e.kind IN ('message','text') ORDER BY e.id",
      );
      const text = rows.map((r) => r.payload).join('\n');
      const named = created.filter((t) => text.includes(t.id));
      return { ok: /\[jv\]/.test(text) && named.length >= 1, detail: `${rows.length} coordinator events; tasks named in wake lines: ${named.map((t) => t.id).join(', ') || 'none'}` };
    });
  } finally {
    try {
      await client?.close();
    } catch {
      // closed already
    }
    if (bot) await stopChild(bot.child, 15_000);
    if (home) {
      jv(['coordinator', 'stop', '--project', SANDBOX_CLONE_NAME], { home, timeoutMs: 60_000 });
      note(`worktrees removed from the clone: ${removeWorktreesUnder(SANDBOX_CLONE, home).length}`);
    }
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME, the sandbox clone' });
}

runJourney(JOURNEY, main);
