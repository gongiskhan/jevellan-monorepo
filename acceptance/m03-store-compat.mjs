#!/usr/bin/env node
// M3 Store compatibility (brief section 14, section 3): a store created by the skills runtime (temporary JV_HOME,
// one project, one `single` task run to done) opens with this jv, migrates to schema 2 with the store.sqlite.v1.bak
// copy, `jv status --json` lists the same task and `jv task show` shows it; what the skills runtime does on the
// migrated store is recorded (expected: it refuses with its schema message, so the two cannot share ~/.jv).
//
// With --real (the run for the record; it costs a little quota): a temporary JV_HOME under ~/.jv-test/<run id>/
// gets copies of ~/.jv/providers.json (paths kept as ~/.jv/..., which map onto JV_HOME), ~/.jv/secrets/* (mode 600,
// copied file to file, never read into this process) and ~/.jv/seeds.json; the Codex provider is disabled there and
// left out of seeds.json, because every copy of the member's Codex login shares its refresh token (jevellan-skills
// D-022) and an answer task never runs on Codex (D-031). The skills runtime from a temporary copy of
// ~/dev/jevellan-skills bootstraps that home (`node <copy>/.../bin/jv.mjs bootstrap`, which installs into JV_HOME
// only), registers the sandbox clone (~/jevellan-projects/jv-mono-sandbox-clone, cloned from the sandbox when
// missing), and creates the answer task "Reply with the word ready." (real Jev placement, real provider), waited
// for up to 10 minutes. Then this jv opens the home. The temporary home, secrets included, is removed at the end
// unless --keep.
//
// Without a flag the script prints what --real would do and does nothing. --offline is a self-test of the same
// path without providers, secrets or Jev: the skills runtime bootstraps a temporary home with its own template,
// registers a throwaway clone of the sandbox, and the task is written and closed through the installed runtime's
// dist modules (as M2 and D-035 do); nothing is recorded in acceptance/results.
//
// Usage: node acceptance/m03-store-compat.mjs [--real | --offline] [--keep]
// Exit 0 when every check passes, 1 otherwise. --real writes acceptance/results/m03.json.

import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  childEnv,
  cleanup,
  ensureSandboxClone,
  fileUrl,
  finish,
  jv,
  jvJson,
  leakCheck,
  log,
  NODE,
  note,
  parseFlags,
  query,
  queryOne,
  REAL_JV_HOME,
  run,
  runDir,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_CLONE,
  SANDBOX_CLONE_NAME,
  schemaVersionOf,
  secretFiles,
  skillsRuntimeCopy,
  sleep,
  storeFile,
  tail,
  tempHome,
  waitFor,
} from './lib.mjs';

const JOURNEY = 'm03';
const USAGE = 'Usage: node acceptance/m03-store-compat.mjs [--real | --offline] [--keep]';
const TITLE = 'Reply with the word ready';
const TEXT = 'Reply with the word ready.';
const TIMEOUT_MS = 10 * 60_000;
const END_STATES = ['done', 'failed', 'stopped', 'waiting-owner'];

const PLAN = `M3 Store compatibility: what --real does (nothing was done now).
  1. Creates ~/.jv-test/<run id>/home (mode 700) and copies into it, without printing anything:
     ~/.jv/providers.json (the codex-subscription providers disabled), ~/.jv/secrets/* (mode 600),
     ~/.jv/seeds.json (without the codex-subscription entries, D-022).
  2. Copies ~/dev/jevellan-skills to ~/.jv-test/<run id>/jevellan-skills and runs its
     .apm/skills/jevellan-router/scripts/jv/bin/jv.mjs bootstrap with JV_HOME set to that home.
  3. Registers ${SANDBOX_CLONE} (cloned from ${SANDBOX} when missing) with the skills runtime.
  4. jv task create --kind single --duty answer --text "${TEXT}" with the skills runtime (Jev places it on a real
     provider; one small model call plus the login probes), and waits up to 10 minutes for done.
  5. Opens the home with this jv: jv status --json (migrates to schema 2, store.sqlite.v1.bak), jv task show T --json.
  6. Runs the skills runtime's jv status --json on the migrated store and records what it does.
  7. Greps the store, its WAL and backup and the logs for the copied secrets (file names only).
  8. Removes ~/.jv-test/<run id>/ (secrets included) unless --keep.
Run: node acceptance/m03-store-compat.mjs --real   (or --offline for a self-test without providers)`;

/** ~/.jv/providers.json for the temporary home: ~/.jv paths kept (they map onto JV_HOME), Codex disabled. */
function providersForTempHome() {
  const text = readFileSync(join(REAL_JV_HOME, 'providers.json'), 'utf8').split(`${REAL_JV_HOME}/`).join('~/.jv/');
  const cfg = JSON.parse(text);
  const disabled = [];
  for (const p of cfg.providers ?? []) {
    if (p.kind === 'codex-subscription' && p.enabled !== false) {
      p.enabled = false;
      disabled.push(p.name);
    }
  }
  return { cfg, disabled, codex: (cfg.providers ?? []).filter((p) => p.kind === 'codex-subscription').map((p) => p.name) };
}

/** Copies the real home's provider setup into `home`; returns what it did (names only). */
function seedTempHome(home) {
  const providers = providersForTempHome();
  writeFileSync(join(home, 'providers.json'), `${JSON.stringify(providers.cfg, null, 2)}\n`, { mode: 0o600 });
  const secretsDir = join(home, 'secrets');
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const copied = [];
  for (const f of secretFiles(join(REAL_JV_HOME, 'secrets'))) {
    const to = join(secretsDir, f.slice(f.lastIndexOf('/') + 1));
    copyFileSync(f, to, constants.COPYFILE_EXCL);
    chmodSync(to, 0o600);
    copied.push(to.slice(to.lastIndexOf('/') + 1));
  }
  let seeds = [];
  const seedsFile = join(REAL_JV_HOME, 'seeds.json');
  if (existsSync(seedsFile)) {
    const all = JSON.parse(readFileSync(seedsFile, 'utf8'));
    const kept = Object.fromEntries(Object.entries(all).filter(([name]) => !providers.codex.includes(name)));
    writeFileSync(join(home, 'seeds.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
    seeds = Object.keys(kept);
  }
  return { secrets: copied, seeds, disabled: providers.disabled };
}

/** Whether a pid is alive (signal 0). */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Offline: the answer task written and closed through the installed skills runtime's dist modules. */
async function offlineTask(home, projectId, cwd, tag) {
  process.env.JV_HOME = home; // the skills runtime's paths resolve JV_HOME once, at import
  const dist = join(home, 'runtime', 'dist');
  const { openStore } = await import(fileUrl(join(dist, 'store.js')));
  const { createRun } = await import(fileUrl(join(dist, 'launcher.js')));
  const { writeReport } = await import(fileUrl(join(dist, 'report.js')));
  const store = openStore();
  try {
    const task = store.createTask({
      project_id: projectId,
      request_id: `acceptance-m03-${tag}`,
      kind: 'single',
      title: TITLE,
      task_text: TEXT,
      workflow_json: JSON.stringify({ name: 'single', steps: [{ duty: 'answer', instructions: '' }] }),
      state_reason: 'created by acceptance/m03-store-compat.mjs --offline',
    }).row;
    const step = store.createStep({ task_id: task.id, ordinal: 1, duty: 'answer', state_reason: 'created with the task' }).row;
    const runRow = createRun(store, { requestId: `acceptance-m03-${tag}-run1`, projectId, taskId: task.id, stepId: step.id, kind: 'step', runtime: 'llm', provider: 'claude-main', model: 'claude-haiku-5-5', effort: 'low', cwd, stateReason: 'queued with an owner placement (offline self-test)' }).row;
    store.tx(() => {
      store.incrementStepAttempts(step.id);
      store.setStepState(step.id, 'running', `attempt 1 on run ${runRow.id}`);
      store.setTaskState(task.id, 'running', `step 1 answer running (${runRow.id})`, { current_step: 1 });
      store.setSessionState(runRow.id, 'running', 'running (offline self-test, no process)');
    });
    const r = writeReport(store, runRow.id, { status: 'done', summary: 'ready' });
    if (r.outcome !== 'recorded') throw new Error(`writeReport: ${r.outcome} ${r.text}`);
    store.tx(() => {
      store.setSessionState(runRow.id, 'done', 'turn ended with a report');
      store.setStepState(step.id, 'done', 'reported done');
      store.setTaskState(task.id, 'done', 'every step done');
    });
    return task.id;
  } finally {
    store.close();
  }
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { booleans: ['offline'], usage: USAGE });
  if (flags.real && flags.offline) {
    process.stderr.write(`--real and --offline exclude each other\n${USAGE}\n`);
    return 2;
  }
  if (!flags.real && !flags.offline) {
    log(PLAN);
    return 0;
  }
  const realRun = !!flags.real;
  const mode = realRun ? 'real providers and Jev in a temporary JV_HOME' : 'offline self-test (no providers, nothing recorded)';
  const started = Date.now();
  const id = runId(JOURNEY);
  const dir = runDir(id);
  const home = tempHome(id, 'home');
  const file = storeFile(home);
  const skills = (args, options = {}) => jv(args, { home, shim: true, cwd: dir, ...options });
  let taskId;
  log(`M3 Store compatibility ${id} (${mode})\ntemporary home ${home}\n`);
  note(`mode: ${mode}`);

  try {
    // 1. Preconditions and the copied provider setup.
    if (realRun) {
      const missing = [join(REAL_JV_HOME, 'providers.json'), join(REAL_JV_HOME, 'secrets')].filter((p) => !existsSync(p));
      if (missing.length) return finish(JOURNEY, { startedAt: started, mode, blocked: `missing ${missing.join(', ')} (bootstrap ~/.jv and copy the secrets first)` });
      if (!existsSync(join(SANDBOX, '.git'))) return finish(JOURNEY, { startedAt: started, mode, blocked: `no sandbox at ${SANDBOX}` });
      if (!(await check('temporary home seeded from ~/.jv (providers.json, secrets mode 600, seeds.json)', () => {
        const s = seedTempHome(home);
        const realPaths = ['providers.json', 'seeds.json']
          .map((n) => join(home, n))
          .filter((f) => existsSync(f) && readFileSync(f, 'utf8').includes(`${REAL_JV_HOME}/`));
        return {
          ok: s.secrets.length > 0 && realPaths.length === 0,
          detail: `${s.secrets.length} secret files (${s.secrets.join(', ')}), seeds for ${s.seeds.join(', ') || 'none'}, disabled ${s.disabled.join(', ') || 'none'}${realPaths.length ? `; still naming the real ~/.jv: ${realPaths.join(', ')}` : ''}`,
        };
      }))) return finish(JOURNEY, { startedAt: started, mode });
    }

    // 2. The skills runtime bootstraps the temporary home from a temporary copy of the checkout.
    let rt;
    if (!(await check('skills runtime bootstraps the temporary home (from a temporary copy)', () => {
      rt = skillsRuntimeCopy(dir, { build: false });
      const r = run(NODE, ['--disable-warning=ExperimentalWarning', rt.bin, 'bootstrap'], { cwd: dir, env: childEnv({ JV_HOME: home }), timeoutMs: 15 * 60_000 });
      const ok = r.code === 0 && existsSync(join(home, 'bin', 'jv')) && existsSync(join(home, 'runtime', 'dist', 'cli.js'));
      return { ok, detail: ok ? `${rt.root} at ${rt.commit}, ${Math.round(r.ms / 1000)} s` : `exit ${r.code}: ${tail(r.stderr || r.stdout, 6)}` };
    }))) return finish(JOURNEY, { startedAt: started, mode, record: realRun });

    // 3. The project.
    let project;
    if (!(await check('skills runtime: jv project add (the sandbox clone)', () => {
      let path;
      if (realRun) {
        const c = ensureSandboxClone();
        path = c.path;
        if (c.created) note(`cloned ${SANDBOX} to ${SANDBOX_CLONE} (push URL /nonexistent/no-push)`);
      } else {
        path = join(dir, 'sandbox-clone');
        const c = run('git', ['clone', '--quiet', SANDBOX, path], { cwd: dir });
        if (c.code !== 0) return { ok: false, detail: `git clone: ${tail(c.stderr, 3)}` };
      }
      const r = skills(['project', 'add', path, '--name', SANDBOX_CLONE_NAME, '--json']);
      project = r.json?.project;
      return { ok: r.code === 0 && !!project?.id, detail: r.code === 0 ? `${project.id} ${project.name} at ${project.path}` : `exit ${r.code}: ${tail(r.stderr || r.stdout, 4)}` };
    }))) return finish(JOURNEY, { startedAt: started, mode, record: realRun });

    // 4. One single answer task, run to done.
    if (realRun) {
      if (!(await check(`skills runtime: jv task create --kind single --duty answer "${TEXT}"`, () => {
        const r = skills(['task', 'create', '--project', SANDBOX_CLONE_NAME, '--kind', 'single', '--duty', 'answer', '--title', TITLE, '--text', TEXT, '--request-id', `acceptance-m03-${id}`, '--json'], { timeoutMs: 5 * 60_000 });
        taskId = r.json?.task?.id;
        return { ok: r.code === 0 && !!taskId, detail: r.code === 0 ? `${taskId} ${r.json.task.state}: ${r.json.task.state_reason}` : `exit ${r.code}: ${tail(r.json?.error ?? (r.stderr || r.stdout), 6)}` };
      }))) return finish(JOURNEY, { startedAt: started, mode });
      let lastStatus = 0;
      const ended = await waitFor(
        () => {
          const t = queryOne(file, 'SELECT state, state_reason FROM tasks WHERE id = ?', taskId);
          return t && END_STATES.includes(t.state) ? t : undefined;
        },
        {
          timeoutMs: TIMEOUT_MS,
          intervalMs: 5000,
          onTick: () => {
            if (Date.now() - lastStatus > 30_000) {
              lastStatus = Date.now();
              skills(['status', '--json']); // marks lost runs at read time (D-040)
            }
          },
        },
      );
      if (!(await check('the task ran to done within 10 minutes', () => {
        const t = ended ?? queryOne(file, 'SELECT state, state_reason FROM tasks WHERE id = ?', taskId);
        return { ok: t?.state === 'done', detail: `${t?.state}: ${t?.state_reason}` };
      }))) return finish(JOURNEY, { startedAt: started, mode });
      // The detached jv run of the skills runtime exits a moment after the task is done (D-041); let it go first.
      const pids = () => runPids(file, taskId).filter(alive);
      await waitFor(() => pids().length === 0, { timeoutMs: 30_000, intervalMs: 500 });
    } else {
      await check('skills runtime: the answer task written and closed through its dist modules', async () => {
        taskId = await offlineTask(home, project.id, project.path, id);
        return { ok: !!taskId, detail: taskId };
      });
    }

    const before = queryOne(file, 'SELECT t.state, (SELECT COUNT(*) FROM reports r WHERE r.task_id = t.id) AS reports FROM tasks t WHERE t.id = ?', taskId);
    await check('the skills runtime left a schema 1 store with the task done and its report', () => ({
      ok: schemaVersionOf(file) === '1' && before?.state === 'done' && before.reports > 0,
      detail: `schema ${schemaVersionOf(file)}, ${taskId} ${before?.state}, ${before?.reports ?? 0} report(s)`,
    }));

    // 5. This jv opens the home.
    await check('this jv: jv status --json lists the task', () => {
      const r = jvJson(['status'], { home, cwd: dir });
      const listed = [...(r.json?.tasks ?? []), ...(r.json?.recent ?? [])].find((t) => t.id === taskId);
      return { ok: r.code === 0 && !!listed, detail: r.code === 0 ? (listed ? `${taskId} under ${r.json.tasks?.some((t) => t.id === taskId) ? 'tasks' : 'recent'}` : `${taskId} not listed`) : `exit ${r.code}: ${tail(r.json?.error ?? r.stderr, 3)}` };
    });
    const bak = `${file}.v1.bak`;
    await check('migrated to schema 2 with store.sqlite.v1.bak (schema 1, the task in it)', () => {
      const inBak = existsSync(bak) ? queryOne(bak, 'SELECT state FROM tasks WHERE id = ?', taskId) : undefined;
      return {
        ok: schemaVersionOf(file) === '2' && schemaVersionOf(bak) === '1' && inBak?.state === 'done',
        detail: `store schema ${schemaVersionOf(file)}; ${existsSync(bak) ? `backup schema ${schemaVersionOf(bak)}, task ${inBak?.state ?? 'missing'}` : 'no backup'}`,
      };
    });
    await check('this jv: jv task show T --json shows the same task', () => {
      const r = jvJson(['task', 'show', taskId], { home, cwd: dir });
      const report = r.json?.steps?.[0]?.runs?.at(-1)?.report;
      return {
        ok: r.code === 0 && r.json?.id === taskId && r.json.state === 'done' && report?.status === 'done',
        detail: r.code === 0 ? `${r.json.id} ${r.json.state}, ${r.json.steps?.length} step(s), report ${report?.status ?? 'none'}` : `exit ${r.code}: ${tail(r.json?.error ?? r.stderr, 3)}`,
      };
    });

    // 6. The skills runtime on the migrated store.
    await check('the skills runtime on the migrated store: recorded, the store unharmed', () => {
      const r = skills(['status', '--json']);
      const message = r.json?.error ?? tail(r.stderr || r.stdout, 2);
      const behaviour = r.code === 0 ? 'opens' : r.code === 2 && /schema/.test(message) ? 'refuses' : 'other';
      note(`skills runtime on the migrated store: ${behaviour} (exit ${r.code}: ${message})`);
      const still = jvJson(['status'], { home, cwd: dir });
      return {
        ok: behaviour !== 'other' && schemaVersionOf(file) === '2' && still.code === 0,
        detail: `${behaviour}, exit ${r.code}; store schema ${schemaVersionOf(file)} afterwards, this jv status exit ${still.code}`,
      };
    });

    // 7. No copied secret in the store, its WAL, the backup or the logs.
    if (realRun) {
      await check('no secret in the store, WAL, backup or logs of the temporary home', () => {
        const r = leakCheck([file, `${file}-wal`, bak, join(home, 'logs')], { secretsDir: join(home, 'secrets') });
        return {
          ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0,
          detail: `${r.secrets} key files against ${r.checked.length} paths${r.leaks.length ? `; found in: ${r.leaks.map((l) => `${l.secret} in ${l.file}`).join(', ')}` : ''}${r.errors.length ? `; ${r.errors.join(', ')}` : ''}`,
        };
      });
    } else note('leak check skipped offline (no secrets were copied)');

    return finish(JOURNEY, { startedAt: started, mode, record: realRun });
  } finally {
    if (realRun && taskId) {
      const t = existsSync(file) ? queryOne(file, 'SELECT state FROM tasks WHERE id = ?', taskId) : undefined;
      const live = existsSync(file) ? runPids(file, taskId).filter(alive) : [];
      if (live.length) {
        log(`stopping the journey's own run of ${taskId} (state ${t?.state}) before removing its home`);
        skills(['task', 'stop', taskId]);
        await sleep(2000);
      }
    }
    if (flags.keep) log(`kept ${dir}${realRun ? ' (it holds copies of the secrets: remove it when done)' : ''}`);
    else cleanup(id);
  }
}

/** The pids of the runs of a task (read-only store). */
function runPids(file, taskId) {
  try {
    return query(file, 'SELECT pid FROM sessions WHERE task_id = ? AND pid IS NOT NULL', taskId).map((r) => r.pid);
  } catch {
    return [];
  }
}

runJourney(JOURNEY, main);
