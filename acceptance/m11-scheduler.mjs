// M11 Scheduler (brief section 14), on the sandbox with the real providers and Jev in a temporary JV_HOME (lib.mjs
// realJvHome; Codex disabled there, D-022):
//
// 1. jv schedule add with cron "* * * * *" and a single answer task (the answer duty runs on the llm runtime, so it
//    needs a ready provider that runtime can use; no worktree).
// 2. jv bot start in the background (the default tick of 15 s; the health endpoint on a free port).
// 3. Within 75 s of the bot's start a task with origin schedule:<id> exists, and the schedule's last_result names it
//    ("created T..."). The bot creates it queued and admits it at its next tick (jevellan-bot's tick).
// 4. jv schedule pause; 70 s later no new task of that origin exists.
// 5. The DST unit tests of nextRun exist: packages/scheduler/test/cron.test.ts covers 25 October 2026 (the clock goes
//    back) and 29 March in Europe/Lisbon (read from the file; npm test runs them).
// 6. The scheduled tasks end; jv bot stop ends the bot with exit 0 and the lock released; no secret in the store or
//    the logs.
//
// Usage: node acceptance/m11-scheduler.mjs [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m11.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKOUT,
  check,
  cleanup,
  finish,
  freePort,
  jv,
  jvJson,
  leakCheck,
  log,
  note,
  parseFlags,
  query,
  realJvHome,
  removeWorktreesUnder,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  sleep,
  startJv,
  stopChild,
  storeFile,
  waitFor,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm11';
const USAGE = 'node acceptance/m11-scheduler.mjs [--keep]';
const SCHEDULE_NAME = 'M11 every minute';
const TITLE = 'M11 scheduled answer';
const TEXT = 'Answer in one short sentence: what is 2 + 3? Change nothing.';

function scheduledTasks(home, scheduleId) {
  return query(storeFile(home), 'SELECT id, title, state, state_reason, origin, created_at FROM tasks WHERE origin = ? ORDER BY created_at', `schedule:${scheduleId}`);
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: USAGE });
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M11 Scheduler ${id}`);
  let home;
  let bot;
  try {
    const setup = realJvHome(id);
    home = setup.home;
    const port = await freePort();
    writeFileSync(join(home, 'bot.json'), `${JSON.stringify({ tickSeconds: 15, limits: { perProject: 2, total: 4 }, quietHours: null, health: { bind: '127.0.0.1', port }, logLines: 20000 }, null, 2)}\n`);
    note(`temporary home ${home}; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}; tick 15 s; health port ${port}`);

    let schedule;
    await check('jv schedule add: cron "* * * * *", a single answer task', () => {
      const r = jvJson(['schedule', 'add', '--project', SANDBOX_NAME, '--name', SCHEDULE_NAME, '--cron', '* * * * *', '--task-kind', 'single', '--duty', 'answer', '--title', TITLE, '--text', TEXT], { home });
      schedule = r.json?.schedule;
      const ok = r.code === 0 && /^C[0-9A-Z]{6}$/.test(schedule?.id ?? '') && schedule.enabled === true && schedule.cron === '* * * * *';
      return { ok, detail: ok ? `${schedule.id}, next run ${schedule.nextRunAt}` : r.stderr || r.stdout };
    });
    if (!schedule) return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });

    let botStart = 0;
    await check('jv bot start runs in the background and answers its health endpoint', async () => {
      botStart = Date.now();
      bot = await startJv(['bot', 'start'], { home, ready: (out) => /health (http\S+)/.exec(out)?.[1], timeoutMs: 60_000 });
      const body = await (await fetch(bot.value)).json();
      return { ok: body.ok === true && Object.keys(body).join(',') === 'ok,heartbeatAgeSeconds,running,queued,version', detail: `pid ${bot.child.pid}; ${JSON.stringify(body)}` };
    });

    let first;
    await check('a task with origin schedule:<id> exists within 75 s of the bot\'s start', async () => {
      first = await waitFor(() => scheduledTasks(home, schedule.id)[0], { timeoutMs: 75_000 - (Date.now() - botStart), intervalMs: 1000 });
      const s = Math.round((Date.now() - botStart) / 1000);
      return { ok: !!first && first.title.startsWith(`${TITLE} `), detail: first ? `${first.id} "${first.title}" after ${s} s (${first.state}: ${first.state_reason})` : `none after ${s} s` };
    });

    await check('the schedule\'s last_result names the task it created', () => {
      const v = jvJson(['schedule', 'show', schedule.id], { home }).json?.schedule;
      const tasks = scheduledTasks(home, schedule.id).map((t) => t.id);
      const named = /^created (T[0-9A-Z]{6})/.exec(v?.lastResult ?? '')?.[1];
      return { ok: !!named && tasks.includes(named), detail: `last_result "${v?.lastResult ?? ''}"; tasks ${tasks.join(', ')}` };
    });

    let countAtPause = 0;
    await check('jv schedule pause, then 70 s with no new task of that origin', async () => {
      const r = jvJson(['schedule', 'pause', schedule.id], { home });
      if (r.code !== 0 || r.json?.schedule?.enabled !== false) return { ok: false, detail: r.stderr || r.stdout };
      countAtPause = scheduledTasks(home, schedule.id).length;
      await sleep(70_000);
      const after = scheduledTasks(home, schedule.id);
      return { ok: after.length === countAtPause, detail: `${countAtPause} task(s) at the pause, ${after.length} after 70 s: ${after.map((t) => t.id).join(', ')}` };
    });

    await check('the nextRun unit tests include the 2026-10-25 DST change in Europe/Lisbon', () => {
      const file = join(CHECKOUT, 'packages', 'scheduler', 'test', 'cron.test.ts');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const ok = /25 October 2026/.test(text) && /2026-10-25T00:30:00\.000Z/.test(text) && /Europe\/Lisbon/.test(text) && /29 March/.test(text);
      return { ok, detail: ok ? `${file}: 25 October (back) and 29 March (forward) in Europe/Lisbon` : `not found in ${file}` };
    });

    await check('the scheduled tasks end (the bot admitted and ran them)', async () => {
      const ends = [];
      for (const t of scheduledTasks(home, schedule.id)) {
        const end = await waitForTask(home, t.id, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 10 * 60_000 });
        ends.push(`${t.id} ${end?.state ?? 'not ended'}`);
      }
      return { ok: ends.length > 0 && ends.every((e) => / done$/.test(e)), detail: ends.join(', ') };
    });

    await check('jv bot stop ends the bot with exit 0 and releases the lock', async () => {
      const exit = new Promise((r) => bot.child.once('exit', (code) => r(code)));
      const r = jvJson(['bot', 'stop'], { home, timeoutMs: 30_000 });
      const code = await Promise.race([exit, sleep(15_000).then(() => 'still running')]);
      const lock = existsSync(join(home, 'run', 'bot.lock'));
      bot = undefined;
      return { ok: r.code === 0 && r.json?.stopped === true && code === 0 && !lock, detail: `stop ${r.code} ${JSON.stringify(r.json)}; bot exit ${code}; lock ${lock ? 'left' : 'gone'}` };
    });

    await check('the bot log names the firing; no secret in the store, its WAL or the logs', () => {
      const botLog = readFileSync(join(home, 'logs', 'bot.log'), 'utf8');
      const fired = botLog.includes(`schedule ${schedule.id} "${SCHEDULE_NAME}": created`);
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: fired && r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `fired in bot.log: ${fired}; ${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
  } finally {
    if (bot) await stopChild(bot.child, 15_000);
    if (home) {
      jv(['schedule', 'pause', SCHEDULE_NAME, '--project', SANDBOX_NAME], { home });
      note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    }
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });
}

runJourney(JOURNEY, main);
