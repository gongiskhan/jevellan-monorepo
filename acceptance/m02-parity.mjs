#!/usr/bin/env node
// M2 Command parity (brief section 14, section 4): for every command of the skills runtime, `jv <command> --help`
// of this jv and of the skills runtime are identical except a version line; `--json` outputs of `jv status`,
// `jv task show` and `jv report` on the same store have the same keys. Differences are listed with their reason
// (or a placeholder for RESULTS.md).
//
// The skills runtime is built in a temporary copy of ~/dev/jevellan-skills (npm ci and tsc in its scripts/jv;
// nothing is built inside the checkout) and run through main() of its dist/cli.js (lib.mjs skillsJv: that file
// only exports main, its bin/jv.mjs would bootstrap a runtime into JV_HOME first). Its command list is its own
// COMMANDS table, internal commands excluded.
//
// The store: a temporary JV_HOME with a made-up providers.json (no secret, no model, no Jev), one project (a
// throwaway git repository registered with the skills runtime's `jv project add`) and tasks written through the
// skills runtime's own dist/store.js, dist/launcher.js (createRun, never spawnRun) and dist/report.js (writeReport),
// as jevellan-skills' acceptance/phase2-investigate.mjs does (D-035), with an owner placement: T1 waiting on the
// owner with a needs-decision report, a message and an owner placement row (D-033); T2 running with a queued run;
// T3 done (listed under recent). The skills runtime refuses a schema 2 store, so its three outputs are taken first,
// on the schema 1 store; then this jv runs the same three commands on the same store (its first open migrates it
// to schema 2 and writes store.sqlite.v1.bak), and the skills runtime is run once more to record its answer.
//
// Key comparison: key paths, recursive, array elements merged as `[]`. A key the skills runtime prints and this jv
// does not is a FAIL (the coordinator skill reads these outputs); a key only this jv prints is an addition, listed
// with its reason. Help: a text difference passes only when every flag and subcommand of the skills usage is kept.
//
// Usage: node acceptance/m02-parity.mjs [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m02.json.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  CLI_DIST,
  cleanup,
  fileUrl,
  finish,
  jv,
  jvJson,
  log,
  note,
  parseFlags,
  run,
  runDir,
  runId,
  runJourney,
  schemaVersionOf,
  skillsJv,
  skillsRuntimeCopy,
  storeFile,
  tail,
  tempHome,
  NODE,
} from './lib.mjs';

const JOURNEY = 'm02';
const USAGE = 'Usage: node acceptance/m02-parity.mjs [--keep]';
const PLACEHOLDER = '<reason: to be written in RESULTS.md>';
const MODE = 'temporary JV_HOME, made-up providers, no model';

/** Help differences the brief asks for, by command (section 4 adds commands and flags). */
const KNOWN_HELP = {
  status: 'brief section 4: jv status gains --watch',
  task: 'brief section 4: jv task gains list and changes',
  coordinator: 'brief section 4: jv coordinator gains message',
  ui: 'brief section 7: jv ui gains --readonly and --password-reset',
};

/** JSON keys this jv adds on purpose, by output (sections 3 and 4). */
const KNOWN_ADDITIONS = {
  status: {
    bot: 'brief section 4: the status header gains the bot line',
    'tasks[].origin': 'brief section 3: tasks.origin (store schema 2)',
  },
  'task show': {
    origin: 'brief section 3: tasks.origin (store schema 2)',
  },
  report: {
    ui: 'brief section 3: the optional ui field of the report (reports.ui_json)',
  },
};

// ---- comparisons --------------------------------------------------------------------------------------------

/** Every key path of a JSON value; array elements are merged under `[]`. Also collects arrays that were empty. */
function keyPaths(value, prefix = '', out = { keys: new Set(), emptyArrays: new Set(), filledArrays: new Set() }) {
  if (Array.isArray(value)) {
    const path = `${prefix}[]`;
    (value.length ? out.filledArrays : out.emptyArrays).add(path);
    for (const v of value) keyPaths(v, path, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.keys.add(path);
      keyPaths(v, path, out);
    }
  }
  return out;
}

/** Paths under which the two values differ (leaves compared as JSON), at most `max`. */
function valueDiffs(a, b, prefix = '', out = [], max = 12) {
  if (out.length >= max) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${prefix || '.'} (length ${a.length} vs ${b.length})`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) valueDiffs(a[i], b[i], `${prefix}[${i}]`, out, max);
  } else if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of Object.keys(a)) if (k in b) valueDiffs(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, max);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix || '.');
  return out;
}

/** Compares the key sets of one --json output pair; prints every difference. */
function compareKeys(label, skillsJson, thisJson) {
  const s = keyPaths(skillsJson);
  const t = keyPaths(thisJson);
  const missing = [...s.keys].filter((k) => !t.keys.has(k)).sort();
  const added = [...t.keys].filter((k) => !s.keys.has(k)).sort();
  const known = KNOWN_ADDITIONS[label] ?? {};
  for (const k of missing) note(`DIFF ${label} --json: "${k}" only in the skills runtime; reason: ${PLACEHOLDER}`);
  for (const k of added) note(`DIFF ${label} --json: "${k}" only in this jv; reason: ${known[k] ?? PLACEHOLDER}`);
  const emptyBoth = [...s.emptyArrays].filter((p) => !s.filledArrays.has(p) && !t.filledArrays.has(p));
  if (emptyBoth.length) note(`${label} --json: arrays empty in both outputs, element keys not compared: ${emptyBoth.join(', ')}`);
  const values = valueDiffs(skillsJson, thisJson);
  if (values.length) note(`${label} --json: values that differ on the shared keys (not a parity failure): ${values.join(', ')}`);
  return {
    ok: missing.length === 0,
    detail: `${s.keys.size} keys in the skills runtime, ${t.keys.size} in this jv${missing.length ? `; missing in this jv: ${missing.join(', ')}` : ''}${added.length ? `; added: ${added.join(', ')}` : ''}`,
  };
}

function normaliseHelp(text) {
  return text
    .split('\n')
    .filter((l) => !/^(jevellan|jv)[ -]v?\d+\.\d+\.\d+/.test(l.trim()))
    .join('\n')
    .trimEnd();
}

/** The flags and subcommand words of a usage line (`--name`, the words of `a|b|c`, `jv cmd <sub>`). */
function usageTokens(usage) {
  const tokens = new Set(usage.match(/--[a-z][a-z0-9-]*/g) ?? []);
  for (const alt of usage.match(/[a-z][a-z-]*(?:\|[a-z][a-z-]*)+/g) ?? []) for (const w of alt.split('|')) tokens.add(w);
  for (const m of usage.matchAll(/\bjv [a-z-]+ ([a-z][a-z-]*)\b/g)) tokens.add(m[1]);
  return tokens;
}

function words(text) {
  return new Set(text.split(/[^A-Za-z0-9-]+/).filter(Boolean));
}

// ---- the store fixture (skills runtime modules, in this process) --------------------------------------------

const PLACEMENT = { runtime: 'claude-sdk', provider: 'made-up', model: 'claude-sonnet-5-5', effort: 'low' };

function madeUpProviders() {
  return {
    jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest', timeoutMs: 4000 },
    providers: [
      {
        name: 'made-up',
        kind: 'claude-subscription',
        home: '~/.jv/homes/made-up',
        ceilingPct: 90,
        models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', efforts: ['low', 'medium', 'high'] }],
      },
    ],
  };
}

/** A throwaway git repository with one commit, registered as the project. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# m02 fixture\n');
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', 'README.md'], ['commit', '--quiet', '-m', 'Fixture for the M2 parity journey']]) {
    const r = run('git', args, { cwd: dir });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr, 3)}`);
  }
  return dir;
}

/** Writes T1, T2, T3 through the skills runtime's dist modules. Returns their ids. */
async function writeFixture(dist, projectId, cwd, tag) {
  const { openStore } = await import(fileUrl(join(dist, 'store.js')));
  const { createRun } = await import(fileUrl(join(dist, 'launcher.js')));
  const { writeReport } = await import(fileUrl(join(dist, 'report.js')));
  const store = openStore();
  try {
    const single = (duty) => JSON.stringify({ name: 'single', steps: [{ duty, instructions: '' }] });
    const newTask = (n, title, text, duty) => {
      const task = store.createTask({ project_id: projectId, request_id: `acceptance-m02-${tag}-t${n}`, kind: 'single', title, task_text: text, workflow_json: single(duty), state_reason: 'created by acceptance/m02-parity.mjs' }).row;
      const step = store.createStep({ task_id: task.id, ordinal: 1, duty, state_reason: 'created with the task' }).row;
      const runRow = createRun(store, { requestId: `acceptance-m02-${tag}-t${n}-run1`, projectId, taskId: task.id, stepId: step.id, kind: 'step', ...PLACEMENT, cwd, stateReason: 'queued with the owner placement of the M2 journey' }).row;
      return { task, step, run: runRow };
    };

    // T1: ran, reported needs-decision, waits on the owner; one owner message; one owner placement row.
    const t1 = newTask(1, 'Pick the empty-state colour', 'Ask the owner which colour the empty state uses: Blue or Green.', 'investigate');
    store.tx(() => {
      store.incrementStepAttempts(t1.step.id);
      store.setStepState(t1.step.id, 'running', `attempt 1 on run ${t1.run.id}`);
      store.setTaskState(t1.task.id, 'running', `step 1 investigate running (${t1.run.id})`, { current_step: 1 });
      store.setSessionState(t1.run.id, 'running', 'running (M2 fixture, no process)');
    });
    const report = writeReport(store, t1.run.id, {
      status: 'needs-decision',
      summary: 'Two colours fit the design tokens.',
      question: 'Which colour?',
      options: [{ label: 'Blue', description: 'the primary token' }, { label: 'Green' }],
      testsRun: { command: 'npm test', passed: true, summary: '12 passed' },
      changedFiles: ['src/empty-state.css'],
      screenshots: [{ path: '.jv-evidence/empty.png', caption: 'The empty state' }],
      limitations: 'Not checked on a phone.',
      ownerCommands: [{ command: 'npm run dev', cwd: 'worktree', why: 'to see both colours' }],
    });
    if (report.outcome !== 'recorded') throw new Error(`writeReport: ${report.outcome} ${report.text}`);
    store.tx(() => {
      store.setSessionState(t1.run.id, 'done', 'turn ended with a report');
      store.setStepState(t1.step.id, 'running', 'waiting for the owner: needs-decision');
      store.setTaskState(t1.task.id, 'waiting-owner', 'step 1 needs a decision: Which colour?');
    });
    store.createMessage({ task_id: t1.task.id, session_id: t1.run.id, direction: 'owner', text: 'Prefer the token colours.' });
    store.createDecision({
      kind: 'placement',
      project_id: projectId,
      task_id: t1.task.id,
      step_id: t1.step.id,
      session_id: t1.run.id,
      skill_name: 'jevellan-router',
      skill_hash: 'none',
      jev_model: 'none',
      state_json: '{}',
      questions_json: '[]',
      answers_json: '[]',
      chosen_json: JSON.stringify({ ...PLACEMENT, source: 'owner' }),
      latency_ms: 0,
      usage_json: '{}',
    });

    // T2: running, its run queued (no process, so nothing marks it lost).
    const t2 = newTask(2, 'List the pure functions', 'Which pure functions in src/ have no unit test?', 'investigate');
    store.tx(() => {
      store.incrementStepAttempts(t2.step.id);
      store.setStepState(t2.step.id, 'running', `attempt 1 on run ${t2.run.id}`);
      store.setTaskState(t2.task.id, 'running', `step 1 investigate running (${t2.run.id})`, { current_step: 1 });
    });

    // T3: done in the last 24 hours (status lists it under recent).
    const t3 = newTask(3, 'Say ready', 'Reply with the word ready.', 'answer');
    store.tx(() => {
      store.setSessionState(t3.run.id, 'done', 'answered');
      store.setStepState(t3.step.id, 'done', 'answered');
      store.setTaskState(t3.task.id, 'done', 'every step done', { current_step: 1 });
    });
    return { t1: t1.task.id, r1: t1.run.id, t2: t2.task.id, r2: t2.run.id, t3: t3.task.id };
  } finally {
    store.close();
  }
}

// ---- the journey --------------------------------------------------------------------------------------------

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: USAGE });
  const started = Date.now();
  const id = runId(JOURNEY);
  const dir = runDir(id);
  const home = tempHome(id, 'home');
  const helpHome = tempHome(id, 'help-home');
  // Paths of the skills runtime resolve JV_HOME once, when its modules load in this process (writeFixture).
  process.env.JV_HOME = home;
  log(`M2 Command parity ${id}\nrun folder ${dir}\n`);

  try {
    let rt;
    if (!(await check('skills runtime built in a temporary copy', () => {
      rt = skillsRuntimeCopy(dir);
      return { ok: rt.ok, detail: `${rt.root} at ${rt.commit}: ${rt.log}` };
    }))) return finish(JOURNEY, { startedAt: started, mode: MODE });

    const bare = run(NODE, ['--disable-warning=ExperimentalWarning', rt.cli, 'status', '--help'], { env: { ...process.env, JV_HOME: helpHome } });
    note(`node <copy>/dist/cli.js status --help printed ${bare.stdout.trim() === '' ? 'nothing' : `"${bare.stdout.trim()}"`} (exit ${bare.code}): dist/cli.js only exports main(), so the journey calls it through a driver`);

    // ---- --help of every command ----
    const theirs = (await import(fileUrl(rt.cli))).COMMANDS;
    const ours = (await import(fileUrl(CLI_DIST))).COMMANDS;
    const theirNames = Object.keys(theirs).filter((c) => !theirs[c].internal);
    const ourNames = Object.keys(ours).filter((c) => !ours[c].internal);
    const kept = new Map();
    for (const c of theirNames) {
      await check(`jv ${c} --help`, () => {
        if (!Object.hasOwn(ours, c)) return { ok: false, detail: 'this jv has no such command' };
        const s = skillsJv(rt.runtimeDir, [c, '--help'], { home: helpHome });
        const t = jv([c, '--help'], { home: helpHome });
        const sj = skillsJv(rt.runtimeDir, [c, '--help', '--json'], { home: helpHome }).json;
        const tj = jv([c, '--help', '--json'], { home: helpHome }).json;
        const jsonKeys = (v) => Object.keys(v ?? {}).sort().join(',');
        if (s.code !== 0 || t.code !== 0) return { ok: false, detail: `exit ${s.code} (skills) and ${t.code} (this jv): ${tail(s.stderr || t.stderr, 3)}` };
        if (jsonKeys(sj) !== jsonKeys(tj)) return { ok: false, detail: `--help --json keys differ: ${jsonKeys(sj)} vs ${jsonKeys(tj)}` };
        const a = normaliseHelp(s.stdout);
        const b = normaliseHelp(t.stdout);
        if (a === b) return { ok: true, detail: 'identical' };
        const ourWords = words(b);
        const lost = [...usageTokens(a)].filter((w) => !ourWords.has(w));
        const reason = KNOWN_HELP[c] ?? PLACEHOLDER;
        note(`DIFF jv ${c} --help\n  skills runtime: ${a}\n  this jv:        ${b}\n  reason: ${reason}`);
        if (lost.length === 0) kept.set(c, reason);
        return { ok: lost.length === 0, detail: lost.length ? `this jv drops: ${lost.join(', ')}` : `differs, every flag and subcommand kept; reason: ${reason}` };
      });
    }
    await check('jv --help lists every command line of the skills runtime', () => {
      const a = normaliseHelp(skillsJv(rt.runtimeDir, ['--help'], { home: helpHome }).stdout).split('\n');
      const b = normaliseHelp(jv(['--help'], { home: helpHome }).stdout).split('\n');
      const missing = a.filter((l) => !b.includes(l));
      const unexplained = missing.filter((l) => {
        const m = /^\s*jv ([a-z-]+)/.exec(l);
        return !(m && kept.has(m[1]));
      });
      const extra = b.filter((l) => !a.includes(l));
      if (extra.length) note(`jv --help: lines only in this jv: ${extra.map((l) => l.trim()).join(' | ')}`);
      return { ok: unexplained.length === 0, detail: unexplained.length ? `missing: ${unexplained.map((l) => l.trim()).join(' | ')}` : `${a.length} lines, ${missing.length} changed with their command, ${extra.length} added` };
    });
    const onlyOurs = ourNames.filter((c) => !theirNames.includes(c));
    note(`commands only in this jv (not compared): ${onlyOurs.length ? onlyOurs.join(', ') : 'none'}`);
    const sv = skillsJv(rt.runtimeDir, ['--version'], { home: helpHome });
    const tv = jv(['--version'], { home: helpHome });
    note(`version lines (expected to differ): skills runtime "${sv.stdout.trim()}", this jv "${tv.stdout.trim()}"`);

    // ---- one store, the skills runtime first (schema 1) ----
    writeFileSync(join(home, 'providers.json'), `${JSON.stringify(madeUpProviders(), null, 2)}\n`, { mode: 0o600 });
    const repo = makeRepo(join(dir, 'project'));
    let projectId;
    if (!(await check('skills runtime: jv project add (made-up providers, throwaway repository)', () => {
      const r = skillsJv(rt.runtimeDir, ['project', 'add', repo, '--name', 'm02-fixture', '--json'], { home });
      projectId = r.json?.project?.id;
      return { ok: r.code === 0 && !!projectId, detail: r.code === 0 ? `${projectId} at ${r.json.project.path}` : `exit ${r.code}: ${tail(r.stderr || r.stdout, 4)}` };
    }))) return finish(JOURNEY, { startedAt: started, mode: MODE });

    let ids;
    if (!(await check('skills runtime: tasks, runs, report written through its dist modules', async () => {
      ids = await writeFixture(join(rt.runtimeDir, 'dist'), projectId, repo, id);
      return { ok: true, detail: `T1 ${ids.t1} (waiting-owner, report on ${ids.r1}), T2 ${ids.t2} (running, ${ids.r2} queued), T3 ${ids.t3} (done)` };
    }))) return finish(JOURNEY, { startedAt: started, mode: MODE });

    const file = storeFile(home);
    await check('the store is schema 1 before this jv opens it', () => {
      const v = schemaVersionOf(file);
      return { ok: v === '1', detail: `schema_version ${v}` };
    });

    const commands = [
      ['status', ['status']],
      ['task show', ['task', 'show', ids.t1]],
      ['report', ['report', ids.r1]],
    ];
    const skillsOut = {};
    for (const [label, args] of commands) {
      await check(`skills runtime: jv ${args.join(' ')} --json`, () => {
        const r = skillsJv(rt.runtimeDir, [...args, '--json'], { home });
        skillsOut[label] = r.json;
        return { ok: r.code === 0 && r.json !== undefined && !('error' in r.json), detail: r.code === 0 ? `${Object.keys(r.json ?? {}).length} top-level keys` : `exit ${r.code}: ${tail(r.stderr || r.stdout, 3)}` };
      });
    }

    // ---- this jv on the same store (its first open migrates it) ----
    const thisOut = {};
    for (const [label, args] of commands) {
      await check(`this jv: jv ${args.join(' ')} --json`, () => {
        const r = jvJson(args, { home });
        thisOut[label] = r.json;
        return { ok: r.code === 0 && r.json !== undefined && !('error' in r.json), detail: r.code === 0 ? `${Object.keys(r.json ?? {}).length} top-level keys` : `exit ${r.code}: ${tail(r.stderr || r.stdout, 3)}` };
      });
    }
    for (const [label] of commands) {
      if (skillsOut[label] === undefined || thisOut[label] === undefined) continue;
      await check(`jv ${label} --json: every key of the skills runtime is kept`, () => compareKeys(label, skillsOut[label], thisOut[label]));
    }

    const bak = `${file}.v1.bak`;
    note(`after this jv: store schema ${schemaVersionOf(file)}, ${existsSync(bak) ? `${bak} schema ${schemaVersionOf(bak)}` : 'no .v1.bak'}`);
    const again = skillsJv(rt.runtimeDir, ['status', '--json'], { home });
    note(`skills runtime on the migrated store: exit ${again.code}, ${again.json?.error ?? tail(again.stderr || again.stdout, 2)}`);

    return finish(JOURNEY, { startedAt: started, mode: MODE });
  } finally {
    if (flags.keep) log(`kept ${dir}`);
    else cleanup(id);
  }
}

runJourney(JOURNEY, main);
