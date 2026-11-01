// M10 Memory (brief section 14), on the sandbox with the real providers and Jev in a temporary JV_HOME (lib.mjs
// realJvHome; Codex disabled there, D-022):
//
// Part one: a single investigate task whose text says "Remember with jv_remember that the sandbox tests need `npm
// ci` first (kind environment)" creates the memory; `jv memory search "npm ci"` finds it; the next task's start event
// carries "What this project remembers:" with that line.
// Part two: two near-duplicate memories added by hand; `jv job run improve-memory`; the bot ticks until the job ends;
// one memory is archived with superseded_by set, none deleted, and result_json lists the merge.
//
// Usage: node acceptance/m10-memory.mjs [--part one|two|all] [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m10.json (part all only).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cleanup,
  finish,
  jv,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  query,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  storeFile,
  waitFor,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm10';
const USAGE = 'node acceptance/m10-memory.mjs [--part one|two|all] [--keep]';
const MEMORY_TEXT = 'npm ci';

async function partOne(home) {
  let taskA;
  let memoryId;
  await check('a single investigate task asked to remember the setup runs to done', async () => {
    const r = jvJson(
      [
        'task', 'create', '--project', SANDBOX_NAME, '--kind', 'single', '--duty', 'investigate',
        '--title', 'Remember how the sandbox tests are set up',
        '--text', 'Remember with jv_remember that the sandbox tests need `npm ci` first (kind environment). Then report done with a one-line summary. Change nothing in the repository.',
      ],
      { home, timeoutMs: 180_000 },
    );
    if (r.code !== 0) return { ok: false, detail: r.stderr || r.stdout };
    taskA = r.json.task?.id ?? r.json.id;
    const end = await waitForTask(home, taskA, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 15 * 60_000 });
    return { ok: end?.state === 'done', detail: `${taskA} ${end?.state}: ${end?.stateReason ?? ''}` };
  });

  await check('the memory was written through jv_remember (kind environment, the project scope, source session:<R>)', () => {
    const rows = query(storeFile(home), "SELECT id, scope, kind, text, source FROM memories WHERE status = 'active'");
    const m = rows.find((x) => x.text.includes(MEMORY_TEXT));
    if (!m) return { ok: false, detail: `no memory with "${MEMORY_TEXT}" among ${rows.length}: ${rows.map((x) => x.text).join(' | ')}` };
    memoryId = m.id;
    return { ok: m.kind === 'environment' && m.scope === `project:${SANDBOX_NAME}` && /^session:R[0-9A-Z]{6}$/.test(m.source), detail: `${m.id} (${m.kind}, ${m.scope}, ${m.source}): ${m.text}` };
  });

  await check('jv memory search "npm ci" finds it', () => {
    const r = jvJson(['memory', 'search', MEMORY_TEXT], { home });
    const found = (r.json?.memories ?? []).map((m) => m.id);
    return { ok: r.code === 0 && found.includes(memoryId), detail: `found ${found.join(', ') || 'nothing'}` };
  });

  await check('memory.md of the project lists it', () => {
    const file = join(home, 'projects', SANDBOX_NAME, 'memory.md');
    return { ok: existsSync(file), detail: file };
  });

  let taskB;
  await check('the next task\'s start event carries "What this project remembers:" with that memory', async () => {
    const r = jvJson(
      ['task', 'create', '--project', SANDBOX_NAME, '--kind', 'single', '--duty', 'investigate', '--title', 'Name the unit test command', '--text', 'Which npm script runs the sandbox unit tests? Answer from package.json. Change nothing.'],
      { home, timeoutMs: 180_000 },
    );
    if (r.code !== 0) return { ok: false, detail: r.stderr || r.stdout };
    taskB = r.json.task?.id ?? r.json.id;
    const start = await waitFor(
      () => {
        const row = queryOne(storeFile(home), "SELECT e.payload FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.task_id = ? AND e.kind = 'start' ORDER BY e.id LIMIT 1", taskB);
        return row ? JSON.parse(row.payload) : undefined;
      },
      { timeoutMs: 5 * 60_000, intervalMs: 2000 },
    );
    const block = start?.memory?.block ?? '';
    const ok = block.startsWith('What this project remembers:') && block.includes(MEMORY_TEXT) && (start.memory.ids ?? []).includes(memoryId);
    return { ok, detail: ok ? block.split('\n').slice(0, 3).join(' / ') : `start payload: ${JSON.stringify(start ?? null).slice(0, 300)}` };
  });
  if (taskB) await waitForTask(home, taskB, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 15 * 60_000 });
  return { taskA, taskB, memoryId };
}

async function partTwo(home) {
  const add = (text) => jvJson(['memory', 'add', '--scope', 'project', '--project', SANDBOX_NAME, '--kind', 'environment', text], { home });
  let a;
  let b;
  await check('two near-duplicate memories added by hand', () => {
    const x = add('The sandbox web pages are served by npm start on port 4173');
    const y = add('npm start serves the sandbox pages, on port 4173');
    a = x.json?.id;
    b = y.json?.id;
    return { ok: x.code === 0 && y.code === 0 && a && b && a !== b, detail: `${a}, ${b}` };
  });
  let jobId;
  await check('jv job run improve-memory creates the job', () => {
    const r = jvJson(['job', 'run', 'improve-memory', '--project', SANDBOX_NAME], { home });
    jobId = r.json?.job?.id ?? r.json?.id;
    return { ok: r.code === 0 && /^J[0-9A-Z]{6}$/.test(jobId ?? ''), detail: r.code === 0 ? jobId : r.stderr || r.stdout };
  });
  await check('the bot ticks the job through its task to done', async () => {
    const end = await waitFor(
      () => {
        jv(['bot', 'tick'], { home, timeoutMs: 300_000 });
        const j = jvJson(['job', 'show', jobId], { home }).json;
        return j && (j.state === 'done' || j.state === 'failed') ? j : undefined;
      },
      { timeoutMs: 20 * 60_000, intervalMs: 5000 },
    );
    return { ok: end?.state === 'done', detail: `${jobId} ${end?.state ?? 'not ended'}: ${end?.reason ?? ''}` };
  });
  await check('one of the two is archived with superseded_by, none deleted, and result_json lists the merge', () => {
    const rows = query(storeFile(home), 'SELECT id, status, superseded_by FROM memories WHERE id IN (?, ?)', a, b);
    const archived = rows.filter((r) => r.status === 'archived' && r.superseded_by);
    const job = queryOne(storeFile(home), 'SELECT result_json FROM jobs WHERE id = ?', jobId);
    const result = job?.result_json ? JSON.parse(job.result_json) : {};
    const merged = (result.merged ?? []).some((m) => [a, b].includes(m.keep) && m.archived.some((x) => [a, b].includes(x)));
    return { ok: rows.length === 2 && archived.length === 1 && merged, detail: `rows ${rows.map((r) => `${r.id} ${r.status}${r.superseded_by ? ` -> ${r.superseded_by}` : ''}`).join(', ')}; result ${JSON.stringify(result).slice(0, 300)}` };
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['part'], usage: USAGE });
  const part = flags.part ?? 'all';
  if (!['one', 'two', 'all'].includes(part)) throw new Error(USAGE);
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M10 Memory ${id} (part ${part})`);
  let home;
  try {
    const setup = realJvHome(id);
    home = setup.home;
    note(`temporary home ${home}; seeded ${setup.seeded.secrets.length} secret files; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}`);
    if (part !== 'two') await partOne(home);
    if (part !== 'one') await partTwo(home);
    await check('no secret in the store, its WAL or the logs of the temporary home', () => {
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
    return finish(JOURNEY, { startedAt: started, mode: `real providers in a temporary JV_HOME, part ${part}`, record: part === 'all' });
  } finally {
    if (home) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    if (!flags.keep) cleanup(id);
  }
}

runJourney(JOURNEY, main);
