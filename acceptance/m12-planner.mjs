// M12 Planner (brief section 14), on the sandbox with the real providers and Jev in a temporary JV_HOME (lib.mjs
// realJvHome; Codex disabled there, D-022):
// 1. A goal (jv goal add).
// 2. jv job run plan creates the job, queued, with the request id of the project and the local day.
// 3. jv bot tick in a loop on the temporary home until the job ends: the first tick gives the job its plan task (kind
//    single, duty plan, origin planner:<J>, request id job:<J>), the next ones admit and run it, and the tick after the
//    task is done runs the planner's post-processor. The loop stops the moment the job has ended, so no further tick
//    admits the planned tasks (they would run on the real sandbox and cost quota).
// 4. One to three tasks with origin planner:<J> are queued and not started, with after links exactly where the plan's
//    json block proposed them, and result_json lists them.
// 5. A second jv job run plan the same day returns the existing job (exit 0, the same id) and creates nothing.
// 6. --force creates a new job; the journey cancels it (jv job cancel) so nothing is left queued.
// The temporary home and its worktrees are removed at the end (the planned tasks' worktrees are under it) unless
// --keep. Blocked, with the reason, when this jv has no `jv bot tick`.
//
// Usage: node acceptance/m12-planner.mjs [--keep] [--timeout-min 30]
// Exit 0 when every check passes, 1 otherwise, 2 blocked. Writes acceptance/results/m12.json.

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
} from './lib.mjs';

const JOURNEY = 'm12';
const USAGE = 'node acceptance/m12-planner.mjs [--keep] [--timeout-min 30]';

const GOAL = {
  title: 'Search customers by name',
  text:
    'The customers page gets a search box that filters the list by name as the owner types, case-insensitively, ' +
    'with an empty state ("No customers match") when nothing matches. The customers module gets a search function ' +
    'with unit tests, and the page keeps working at phone width.',
};

/** The local date, YYYY-MM-DD, as jevellan-core's localDay. */
function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The last fenced json block of a text, as the planner reads it (jevellan-core's lastJsonBlock). */
function lastJsonBlock(text) {
  const re = /```json[^\S\n]*\r?\n([\s\S]*?)```/g;
  let last;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last;
}

/** Why `jv bot tick` cannot drive the journey, or undefined when it can (one tick on the temporary home). */
function botTickBlocked(home) {
  const r = jv(['bot', 'tick', '--json'], { home, timeoutMs: 300_000 });
  if (r.code === 0) return undefined;
  const text = `${r.stdout} ${r.stderr}`;
  if (/unknown command "bot"|jv bot is not available in this build/.test(text)) return `jv bot tick is not available in this build (${text.trim().slice(0, 200)})`;
  return `jv bot tick failed (exit ${r.code}): ${text.trim().slice(0, 300)}`;
}

const counts = (home) => ({
  jobs: queryOne(storeFile(home), 'SELECT count(*) AS n FROM jobs').n,
  tasks: queryOne(storeFile(home), 'SELECT count(*) AS n FROM tasks').n,
});

async function journey(home, timeoutMs) {
  let goalId;
  await check('a goal for the sandbox (jv goal add)', () => {
    const r = jvJson(['goal', 'add', '--project', SANDBOX_NAME, '--title', GOAL.title, '--text', GOAL.text, '--priority', '1'], { home });
    goalId = r.json?.goal?.id;
    return { ok: r.code === 0 && /^G[0-9A-Z]{6}$/.test(goalId ?? '') && r.json.goal.state === 'open', detail: r.code === 0 ? `${goalId} ${r.json.goal.title}` : r.stderr || r.stdout };
  });

  let jobId;
  await check('jv job run plan creates the job, queued, with the request id of the project and the day', () => {
    const r = jvJson(['job', 'run', 'plan', '--project', SANDBOX_NAME], { home });
    const job = r.json?.job;
    jobId = job?.id;
    const ok = r.code === 0 && r.json.created === true && /^J[0-9A-Z]{6}$/.test(jobId ?? '') && job.state === 'queued' && job.requestId === `plan:${SANDBOX_NAME}:${localDay()}`;
    return { ok, detail: r.code === 0 ? `${jobId} ${job?.state} ${job?.requestId}` : r.stderr || r.stdout };
  });
  if (!jobId) return;

  let job;
  let ticks = 0;
  await check('jv bot tick in a loop until the job ends: the plan task runs and the job is done', async () => {
    const started = Date.now();
    job = await waitFor(
      () => {
        const t = jv(['bot', 'tick'], { home, timeoutMs: 300_000 });
        ticks++;
        if (t.code !== 0) log(`tick ${ticks}: exit ${t.code} ${(t.stderr || t.stdout).trim().slice(0, 200)}`);
        const j = jvJson(['job', 'show', jobId], { home }).json?.job;
        if (j && ticks % 10 === 0) log(`tick ${ticks}: job ${j.state} (${j.reason}); task ${j.task ?? 'none'} ${j.taskState ?? ''}`);
        return j && (j.state === 'done' || j.state === 'failed') ? j : undefined;
      },
      { timeoutMs, intervalMs: 5000 },
    );
    note(`the plan job ended after ${ticks} ticks in ${Math.round((Date.now() - started) / 1000)} s`);
    return { ok: job?.state === 'done', detail: `${jobId} ${job?.state ?? 'not ended'}: ${job?.reason ?? ''}; task ${job?.task ?? 'none'}` };
  });
  if (!job?.task) return;

  await check('the plan task: kind single, duty plan, origin planner:<J>, request id job:<J>, not visible, done', () => {
    const t = queryOne(storeFile(home), 'SELECT t.id, t.kind, t.origin, t.request_id, t.visible, t.state, s.duty FROM tasks t JOIN steps s ON s.task_id = t.id AND s.ordinal = 1 WHERE t.id = ?', job.task);
    const ok = t?.kind === 'single' && t.duty === 'plan' && t.origin === `planner:${jobId}` && t.request_id === `job:${jobId}` && t.visible === 0 && t.state === 'done';
    return { ok, detail: t ? `${t.id} ${t.kind} ${t.duty} ${t.origin} ${t.request_id} visible ${t.visible} ${t.state}` : 'no task' };
  });

  // The plan the task proposed: the last json block of its plan step's report, as the post-processor read it.
  const report = queryOne(
    storeFile(home),
    "SELECT r.summary FROM reports r JOIN steps s ON s.id = r.step_id WHERE r.task_id = ? AND s.duty = 'plan' ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1",
    job.task,
  );
  let proposal = [];
  try {
    proposal = JSON.parse(lastJsonBlock(report?.summary ?? '') ?? '{}').tasks ?? [];
  } catch {
    proposal = [];
  }
  note(`the plan proposed ${proposal.length} tasks: ${proposal.map((t, i) => `${i} "${t.title}"${t.after !== null && t.after !== undefined ? ` after ${t.after}` : ''}`).join('; ')}`);

  const planned = () =>
    query(
      storeFile(home),
      "SELECT id, title, kind, state, request_id, after_task_id, visible, origin FROM tasks WHERE origin = ? AND request_id LIKE 'plan:%' ORDER BY request_id",
      `planner:${jobId}`,
    );
  await check('one to three tasks with origin planner:<J> are queued and not started; result_json lists them', () => {
    const rows = planned();
    const sessions = rows.map((t) => queryOne(storeFile(home), 'SELECT count(*) AS n FROM sessions WHERE task_id = ?', t.id).n);
    const created = job.result?.created ?? [];
    const ok =
      rows.length >= 1 &&
      rows.length <= 3 &&
      rows.every((t) => t.state === 'queued' && t.visible === 0) &&
      sessions.every((n) => n === 0) &&
      JSON.stringify([...created].sort()) === JSON.stringify(rows.map((t) => t.id).sort());
    return { ok, detail: `${rows.map((t, i) => `${t.id} ${t.kind} ${t.state} (${sessions[i]} runs) ${t.title}`).join('; ') || 'none'}; result ${JSON.stringify(job.result ?? null).slice(0, 300)}` };
  });

  await check('after links exactly where the plan proposed them (request id plan:<J>:<index>)', () => {
    const rows = planned();
    const byIndex = new Map(rows.map((t) => [Number(t.request_id.split(':').at(-1)), t]));
    const problems = [];
    for (const [index, t] of byIndex) {
      const proposed = proposal[index];
      if (!proposed) {
        problems.push(`${t.id}: no proposal ${index}`);
        continue;
      }
      const after = proposed.after === null || proposed.after === undefined ? undefined : Number(proposed.after);
      const expected = after === undefined ? null : (byIndex.get(after)?.id ?? 'missing');
      if (t.after_task_id !== expected) problems.push(`${t.id} (proposal ${index}) after ${t.after_task_id ?? 'none'}, proposed ${expected ?? 'none'}`);
    }
    const links = rows.filter((t) => t.after_task_id).map((t) => `${t.id} after ${t.after_task_id}`);
    return { ok: rows.length > 0 && problems.length === 0, detail: problems.join('; ') || (links.length ? links.join(', ') : 'the plan proposed no after links') };
  });

  await check('a second jv job run plan the same day returns the existing job: exit 0, the same id, nothing created', () => {
    const before = counts(home);
    const r = jvJson(['job', 'run', 'plan', '--project', SANDBOX_NAME], { home });
    const after = counts(home);
    const ok = r.code === 0 && r.json?.created === false && r.json?.job?.id === jobId && after.jobs === before.jobs && after.tasks === before.tasks;
    return { ok, detail: `exit ${r.code}, ${r.json?.job?.id} created ${r.json?.created}; jobs ${before.jobs} -> ${after.jobs}, tasks ${before.tasks} -> ${after.tasks}` };
  });

  await check('--force creates a new job (another id), which the journey then cancels', () => {
    const before = counts(home);
    const r = jvJson(['job', 'run', 'plan', '--project', SANDBOX_NAME, '--force'], { home });
    const forced = r.json?.job;
    const created = r.code === 0 && r.json?.created === true && forced?.id && forced.id !== jobId && forced.state === 'queued' && forced.requestId.startsWith(`plan:${SANDBOX_NAME}:${localDay()}:force:`);
    const c = forced?.id ? jvJson(['job', 'cancel', forced.id], { home }) : undefined;
    const cancelled = c?.code === 0 && c.json?.job?.state === 'failed' && c.json.job.reason === 'cancelled by the owner';
    const after = counts(home);
    return {
      ok: Boolean(created && cancelled && after.jobs === before.jobs + 1 && after.tasks === before.tasks),
      detail: `${forced?.id ?? 'none'} ${forced?.requestId ?? r.stderr ?? ''}; cancel exit ${c?.code}: ${c?.json?.job?.state ?? ''} ${c?.json?.job?.reason ?? ''}`,
    };
  });

  await check('the planned tasks are still queued and not started at the end', () => {
    const rows = planned();
    const runs = queryOne(storeFile(home), `SELECT count(*) AS n FROM sessions WHERE task_id IN (${rows.map(() => '?').join(',') || "''"})`, ...rows.map((t) => t.id)).n;
    return { ok: rows.length > 0 && rows.every((t) => t.state === 'queued') && runs === 0, detail: `${rows.map((t) => `${t.id} ${t.state}`).join(', ')}; runs ${runs}` };
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['timeout-min'], usage: USAGE });
  const timeoutMs = Number(flags['timeout-min'] ?? 30) * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(USAGE);
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M12 Planner ${id}`);
  let home;
  try {
    const setup = realJvHome(id);
    home = setup.home;
    note(`temporary home ${home}; seeded ${setup.seeded.secrets.length} secret files; codex disabled: ${setup.seeded.disabled.join(', ') || 'none'}`);
    const blocked = botTickBlocked(home);
    if (blocked) return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME', blocked });
    await journey(home, timeoutMs);
    await check('no secret in the store, its WAL or the logs of the temporary home', () => {
      const file = storeFile(home);
      const r = leakCheck([file, `${file}-wal`, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
      return { ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0, detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in ${r.leaks.map((l) => l.file).join(', ')}` : ''}` };
    });
    return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });
  } finally {
    if (home) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    if (!flags.keep) cleanup(id);
  }
}

runJourney(JOURNEY, main);
