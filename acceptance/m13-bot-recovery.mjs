// M13 Bot recovery (brief section 14), with the real providers and Jev in a temporary JV_HOME (lib.mjs realJvHome;
// Codex disabled there, D-022), on the sandbox clone ~/jevellan-projects/jv-mono-sandbox-clone: the step's task may
// land when it finishes, and a journey must never dirty the main sandbox (M5's rule).
//
// 1. A single implement task is created (jv task create starts its step); the journey waits until the step's run is
//    running with a pid and a native session.
// 2. The run's process group is killed by hand (SIGKILL to the group of the run's pid, the detached `jv run`).
// 3. One `jv bot tick` (no bot runs beside it, so the recovery is that one tick and nothing else): it marks the run
//    lost and starts a resume turn on the same native session (M-024).
// 4. The bot runs (jv bot start in the background) until the step finishes; then jv bot stop.
//
// Which runtime Jev placed the step on is noted: the process group of a claude-sdk run holds the model's process; a
// claude-tmux run's model lives in its tmux window, outside that group, and its run process is what dies.
//
// Usage: node acceptance/m13-bot-recovery.mjs [--keep] [--timeout-min 30]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m13.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cleanup,
  ensureSandboxClone,
  finish,
  freePort,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  query,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  run,
  runId,
  runJourney,
  SANDBOX_CLONE,
  SANDBOX_CLONE_NAME,
  sleep,
  startJv,
  stopChild,
  storeFile,
  waitFor,
} from './lib.mjs';

const JOURNEY = 'm13';
const USAGE = 'node acceptance/m13-bot-recovery.mjs [--keep] [--timeout-min 30]';
// The first turn must still be working when the journey kills it, so it starts with a long sleep; the resumed turn
// is told not to sleep again, so the recovery finishes quickly.
const TEXT = [
  'First, at the very start of your first turn, run `sleep 90` in the shell once (this test needs the turn to be busy for a while). If you are resumed after an interruption, do not sleep again: go straight on with the work.',
  'What: add a one-line JSDoc comment above every exported function in src/invoices/index.ts that says what the function returns.',
  'Why: the module has no documentation of its return values.',
  'Where: src/invoices/index.ts only; do not change any code, only add comments.',
  'Done when: every exported function there has its comment and `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test` still passes.',
].join('\n');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function stepRuns(home, taskId) {
  return query(
    storeFile(home),
    "SELECT s.id, s.state, s.state_reason, s.pid, s.native_session_id, s.runtime, s.provider, s.model, s.step_id, st.ordinal, st.duty, st.state AS step_state FROM sessions s JOIN steps st ON st.id = s.step_id WHERE s.task_id = ? AND s.kind = 'step' ORDER BY s.rowid",
    taskId,
  );
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['timeout-min'], usage: USAGE });
  const timeoutMs = Number(flags['timeout-min'] ?? 30) * 60_000;
  const started = Date.now();
  const id = runId(JOURNEY);
  ensureSandboxClone();
  log(`M13 Bot recovery ${id}`);
  let home;
  let bot;
  try {
    const setup = realJvHome(id, { projects: [[SANDBOX_CLONE, SANDBOX_CLONE_NAME]] });
    home = setup.home;
    writeFileSync(join(home, 'bot.json'), `${JSON.stringify({ tickSeconds: 15, health: { bind: '127.0.0.1', port: await freePort() } }, null, 2)}\n`);
    note(`temporary home ${home}; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}`);

    let taskId;
    let lostRun;
    await check('a single implement task starts its step, and the run is running with a pid and a native session', async () => {
      const r = jvJson(['task', 'create', '--project', SANDBOX_CLONE_NAME, '--kind', 'single', '--duty', 'implement', '--title', 'JSDoc for the invoice functions', '--text', TEXT], { home, timeoutMs: 300_000 });
      if (r.code !== 0) return { ok: false, detail: r.stderr || r.stdout };
      taskId = r.json.task?.id;
      lostRun = await waitFor(
        () => {
          const runs = stepRuns(home, taskId).filter((s) => s.duty === 'implement');
          const last = runs.at(-1);
          return last && last.state === 'running' && last.pid && last.native_session_id && alive(last.pid) ? last : undefined;
        },
        { timeoutMs: 5 * 60_000, intervalMs: 2000 },
      );
      return { ok: !!lostRun, detail: lostRun ? `${taskId} run ${lostRun.id} pid ${lostRun.pid} on ${lostRun.runtime} (${lostRun.provider}, ${lostRun.model}), native ${lostRun.native_session_id}` : `${taskId}: no running run` };
    });
    if (!lostRun) return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME, the sandbox clone' });
    note(`the step runs on ${lostRun.runtime}${lostRun.runtime === 'claude-tmux' ? ' (its model is in a tmux window, outside the run\'s process group)' : ''}`);

    await check('its process group is killed by hand', async () => {
      // Let the turn get going first (it starts with a 90 s sleep), so the kill lands in the middle of the work.
      await sleep(12_000);
      if (!alive(lostRun.pid)) return { ok: false, detail: `pid ${lostRun.pid} ended before the kill (the turn finished early)` };
      const pgid = Number(run('ps', ['-o', 'pgid=', '-p', String(lostRun.pid)]).stdout.trim());
      if (!Number.isInteger(pgid) || pgid <= 1) return { ok: false, detail: `no process group for pid ${lostRun.pid}` };
      if (pgid === process.pid || pgid === Number(run('ps', ['-o', 'pgid=', '-p', String(process.pid)]).stdout.trim())) return { ok: false, detail: 'the run shares this journey\'s process group; not killing it' };
      process.kill(-pgid, 'SIGKILL');
      const gone = await waitFor(() => !alive(lostRun.pid), { timeoutMs: 15_000, intervalMs: 250 });
      return { ok: !!gone, detail: `SIGKILL to process group ${pgid}; pid ${lostRun.pid} ${gone ? 'gone' : 'still there'}` };
    });

    let resumed;
    await check('one jv bot tick marks the run lost and starts a resume turn on the same native session', () => {
      const r = jvJson(['bot', 'tick'], { home, timeoutMs: 300_000 });
      const s = r.json;
      const recovered = s?.reconcile?.recovered?.find((x) => x.session === lostRun.id);
      const lostRow = queryOne(storeFile(home), 'SELECT state, state_reason FROM sessions WHERE id = ?', lostRun.id);
      resumed = recovered?.run ? queryOne(storeFile(home), 'SELECT id, state, native_session_id, request_id FROM sessions WHERE id = ?', recovered.run) : undefined;
      const ok = r.code === 0 && s.reconcile.lost.includes(lostRun.id) && lostRow?.state === 'lost' && recovered?.action === 'resumed' && resumed?.native_session_id === lostRun.native_session_id;
      return {
        ok,
        detail: `tick exit ${r.code}; lost ${JSON.stringify(s?.reconcile?.lost ?? [])}; ${lostRun.id} ${lostRow?.state} (${lostRow?.state_reason}); recovery ${JSON.stringify(recovered ?? null)}; resume run ${resumed?.id ?? 'none'} native ${resumed?.native_session_id ?? '-'} (${resumed?.request_id ?? ''})`,
      };
    });

    await check('with the bot running, the step finishes', async () => {
      bot = await startJv(['bot', 'start'], { home, ready: (out) => /health http/.test(out), timeoutMs: 60_000 });
      const done = await waitFor(
        () => {
          const runs = stepRuns(home, taskId).filter((x) => x.duty === 'implement');
          const step = runs.at(-1)?.step_state;
          return step === 'done' || step === 'failed' ? { step, runs } : undefined;
        },
        { timeoutMs, intervalMs: 10_000 },
      );
      const task = queryOne(storeFile(home), 'SELECT state, state_reason FROM tasks WHERE id = ?', taskId);
      return { ok: done?.step === 'done', detail: `step ${done?.step ?? 'not finished'} after ${done?.runs.length ?? '?'} runs (${(done?.runs ?? []).map((x) => `${x.id} ${x.state}`).join(', ')}); task ${task?.state}: ${task?.state_reason}` };
    });

    await check('jv bot stop ends the bot; the bot log names the lost run and its resume', async () => {
      const exit = new Promise((r) => bot.child.once('exit', (code) => r(code)));
      const r = jvJson(['bot', 'stop'], { home, timeoutMs: 30_000 });
      const code = await Promise.race([exit, sleep(15_000).then(() => 'still running')]);
      bot = undefined;
      const text = query(storeFile(home), "SELECT value FROM meta WHERE key = 'bot:heartbeat'")[0]?.value ?? '';
      const botLog = readFileSync(join(home, 'logs', 'bot.log'), 'utf8');
      const named = botLog.includes(`lost run ${lostRun.id} of ${taskId}: resumed as ${resumed?.id ?? '?'}`);
      return { ok: r.code === 0 && code === 0 && named, detail: `stop ${r.code}; exit ${code}; last heartbeat ${text}; bot.log names the resume: ${named}` };
    });

    await check('no secret in the store, its WAL or the logs of the temporary home', () => {
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
  } finally {
    if (bot) await stopChild(bot.child, 15_000);
    if (home) {
      note(`worktrees removed from the clone: ${removeWorktreesUnder(SANDBOX_CLONE, home).length}`);
    }
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME, the sandbox clone' });
}

runJourney(JOURNEY, main);
