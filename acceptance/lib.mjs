// Shared helpers of the acceptance journeys M1 to M17 (brief section 14). Plain ESM, Node 22.13 or later, no
// dependencies; ported from jevellan-skills acceptance/lib.mjs and viewer-lib.mjs and adapted to the monorepo.
//
// - The checkout is the repository holding this folder (M-007: the checkout is the install); `jv()` runs its
//   bin/jv.mjs with the Node 22.22.0 binary by path (D-001), or the shim of a home with `shim: true`.
// - Every journey that could leave state uses a temporary JV_HOME under ~/.jv-test/<run id>/ and removes it at the
//   end (brief section 1). `jv()` refuses the real ~/.jv unless the call says `real: true` (a journey's --real).
// - A journey records its checks with `check()` and its result with `recordResult()` / `finish()` in
//   acceptance/results/<journey>.json; run-all.mjs turns those files into acceptance/RESULTS.md.
// - Secrets are never printed, logged or put on a command line (D-007, D-014): the leak check feeds the lines of
//   each key file to `grep -F -f -` on stdin and prints only file names.
// - The skills runtime (jevellan-skills, the lifted code's origin) is only ever built and run in a temporary copy,
//   never inside ~/dev/jevellan-skills itself, and its dist/cli.js only exports main() (its bin/jv.mjs would first
//   bootstrap a runtime into JV_HOME), so `skillsJv()` calls that main() through `node -e`.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// node:sqlite prints an ExperimentalWarning on first use; drop that one warning and keep the others (as bin.ts).
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

// ---- machine facts and paths (brief sections 1, 12 and 14) --------------------------------------------------

export const HOME = homedir();
export const ACCEPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The repository root: the nearest folder above this one whose package.json is the jevellan-monorepo root. */
function findCheckout() {
  let dir = ACCEPT_DIR;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && /"name"\s*:\s*"jevellan-monorepo"/.test(readFileSync(pkg, 'utf8'))) return dir;
    dir = dirname(dir);
  }
  return resolve(ACCEPT_DIR, '..');
}

export const CHECKOUT = findCheckout();
export const BIN_JV = join(CHECKOUT, 'bin', 'jv.mjs');
export const CLI_ENTRY = join(CHECKOUT, 'packages', 'cli', 'dist', 'bin.js');
export const CLI_DIST = join(CHECKOUT, 'packages', 'cli', 'dist', 'cli.js');

/** The Node binary every journey and every shim uses (brief section 12, D-001). */
export const NODE_VERSION = '22.22.0';
export const NODE = join(HOME, '.nvm', 'versions', 'node', `v${NODE_VERSION}`, 'bin', 'node');
export const NODE_BIN = dirname(NODE);

export const REAL_JV_HOME = join(HOME, '.jv');
export const TEST_ROOT = join(HOME, '.jv-test');

/** The jevellan-skills checkout (read only; JV_ACCEPT_SKILLS overrides it) and its runtime folder. */
export const SKILLS_REPO = process.env.JV_ACCEPT_SKILLS || join(HOME, 'dev', 'jevellan-skills');
export const SKILLS_RUNTIME_REL = join('.apm', 'skills', 'jevellan-router', 'scripts', 'jv');

/** The sandbox project of section 12 and the disposable clone that journeys may dirty (M5, M3). */
export const SANDBOX = join(HOME, 'jevellan-projects', 'jv-mono-sandbox');
export const SANDBOX_NAME = 'jv-mono-sandbox';
export const SANDBOX_CLONE = join(HOME, 'jevellan-projects', 'jv-mono-sandbox-clone');
export const SANDBOX_CLONE_NAME = 'jv-mono-sandbox-clone';

export const RESULTS_DIR = join(ACCEPT_DIR, 'results');
export const RESULTS_FILE = join(ACCEPT_DIR, 'RESULTS.md');
export const SHOTS_DIR = join(ACCEPT_DIR, 'shots');
export const OWNER_SHOTS_DIR = join(HOME, '.jevellan-build', 'manager', 'shots');
export const BASELINE_DIR = join(ACCEPT_DIR, 'baseline');
export const PLAYWRIGHT_BROWSERS = join(HOME, 'Library', 'Caches', 'ms-playwright');

/** The ports this run owns (section 1): UI, MCP over HTTP, bot health. */
export const PORTS = Object.freeze({ ui: 7071, mcp: 7072, bot: 7073 });

/** The seventeen journeys of section 14, in the order run-all.mjs runs them. */
export const JOURNEYS = Object.freeze([
  { id: 'm01', name: 'M1', title: 'Install' },
  { id: 'm02', name: 'M2', title: 'Command parity' },
  { id: 'm03', name: 'M3', title: 'Store compatibility' },
  { id: 'm04', name: 'M4', title: 'One task end to end' },
  { id: 'm05', name: 'M5', title: 'Queue under the bot' },
  { id: 'm06', name: 'M6', title: 'UI actions' },
  { id: 'm07', name: 'M7', title: 'Coordinator chat' },
  { id: 'm08', name: 'M8', title: 'A2UI' },
  { id: 'm09', name: 'M9', title: 'MCP' },
  { id: 'm10', name: 'M10', title: 'Memory' },
  { id: 'm11', name: 'M11', title: 'Scheduler' },
  { id: 'm12', name: 'M12', title: 'Planner' },
  { id: 'm13', name: 'M13', title: 'Bot recovery' },
  { id: 'm14', name: 'M14', title: 'Service file' },
  { id: 'm15', name: 'M15', title: 'Phone' },
  { id: 'm16', name: 'M16', title: 'No leaks' },
  { id: 'm17', name: 'M17', title: 'Member untouched' },
]);

export function journeyInfo(id) {
  const j = JOURNEYS.find((x) => x.id === id);
  if (!j) throw new Error(`unknown journey ${id}`);
  return j;
}

// ---- flags --------------------------------------------------------------------------------------------------

/**
 * Flags every journey accepts, so run-all.mjs can pass them to all of them: --real (use the real providers or the
 * real ~/.jv where the journey says so), --keep (leave the temporary home for inspection), --no-build (M1: skip npm
 * ci and npm run build). A journey that has no use for one ignores it.
 */
export const SHARED_BOOLEANS = Object.freeze(['real', 'keep', 'no-build', 'help']);

/** Parses --flag and --flag value; unknown flags are refused (exit 2) so a typo never runs the wrong journey. */
export function parseFlags(argv, { booleans = [], values = [], usage = '' } = {}) {
  const known = new Set([...SHARED_BOOLEANS, ...booleans]);
  const valued = new Set(values);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (known.has(name)) flags[name] = eq >= 0 ? body.slice(eq + 1) !== 'false' : true;
    else if (valued.has(name)) {
      const value = eq >= 0 ? body.slice(eq + 1) : argv[++i];
      if (value === undefined) usageExit(`--${name} needs a value`, usage);
      flags[name] = value;
    } else usageExit(`unknown flag ${token}`, usage);
  }
  if (flags.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  return { flags, positionals };
}

function usageExit(message, usage) {
  process.stderr.write(`${message}${usage ? `\n${usage}` : ''}\n`);
  process.exit(2);
}

// ---- run ids and temporary homes ----------------------------------------------------------------------------

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').replace('T', 't');
}

/** A run id: <prefix>-<UTC stamp>-<4 hex>, safe as a folder name and a request id suffix. */
export function runId(prefix = 'run') {
  return `${prefix}-${stamp()}-${randomBytes(2).toString('hex')}`;
}

function checkRunId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`invalid run id ${String(id)}`);
}

/** ~/.jv-test/<run id>/ (mode 700), created on first use. */
export function runDir(id) {
  checkRunId(id);
  const dir = join(TEST_ROOT, id);
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** A temporary JV_HOME ~/.jv-test/<run id>/<name>/ (mode 700, like the real home). */
export function tempHome(id, name = 'home') {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`invalid home name ${name}`);
  const dir = join(runDir(id), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Removes ~/.jv-test/<run id>/ (and everything in it: temporary homes, copies of secrets, the skills copy). Only a
 * folder strictly inside ~/.jv-test is ever removed; symlinks inside are unlinked, never followed.
 */
export function cleanup(id) {
  checkRunId(id);
  const dir = resolve(TEST_ROOT, id);
  if (!dir.startsWith(`${resolve(TEST_ROOT)}${sep}`) || dir === resolve(TEST_ROOT)) throw new Error(`refusing to remove ${dir}`);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return true;
}

// ---- child processes ----------------------------------------------------------------------------------------

/** Folders that go first on PATH: Node 22.22.0, Claude Code and Codex, Homebrew (git, tmux), the system. */
export const PATH_HEAD = [NODE_BIN, join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The environment of every child: the caller's, with PATH_HEAD first, without JV_HOME and JV_SESSION (each call
 * sets its own home), and without the variables of a Claude Code session the journey may itself run in (the owner
 * runs jv from a plain terminal).
 */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env.JV_HOME;
  delete env.JV_SESSION;
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  const rest = (env.PATH ?? '').split(':').filter((p) => p !== '' && !PATH_HEAD.includes(p));
  env.PATH = [...PATH_HEAD, ...rest].join(':');
  if (!env.PLAYWRIGHT_BROWSERS_PATH && existsSync(PLAYWRIGHT_BROWSERS)) env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS;
  return { ...env, ...extra };
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Whether `home` is the owner's real ~/.jv (symlinks resolved). */
export function isRealHome(home) {
  return realOr(home) === realOr(REAL_JV_HOME);
}

function guardHome(home, real) {
  if (typeof home !== 'string' || home === '') throw new Error('jv(): pass the JV_HOME explicitly ({ home })');
  if (isRealHome(home) && !real) throw new Error(`jv(): ${home} is the real ~/.jv; only a journey run with --real may use it`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A neutral working folder for jv calls (not inside any git repository). */
export function neutralCwd() {
  mkdirSync(TEST_ROOT, { recursive: true });
  return TEST_ROOT;
}

/** Runs a program synchronously. Returns {code, signal, stdout, stderr, json, ms}; exits are data, not exceptions. */
export function run(command, args, { cwd = neutralCwd(), env = childEnv(), timeoutMs = 120_000, input } = {}) {
  const started = Date.now();
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  const stdout = r.stdout ?? '';
  return {
    code: r.status,
    signal: r.signal,
    stdout,
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
    json: parseJson(stdout),
    ms: Date.now() - started,
    error: r.error ? r.error.message : undefined,
  };
}

/**
 * Runs this checkout's jv (`<checkout>/bin/jv.mjs` with Node 22.22.0) against `home`, or the shim `<home>/bin/jv`
 * with `shim: true` (whatever installed it). `real: true` is required for the real ~/.jv.
 */
export function jv(args, { home, env = {}, timeoutMs = 120_000, cwd, input, shim = false, real = false } = {}) {
  guardHome(home, real);
  const childEnvironment = childEnv({ ...env, JV_HOME: home });
  const [command, prefix] = shim ? [join(home, 'bin', 'jv'), []] : [NODE, ['--disable-warning=ExperimentalWarning', BIN_JV]];
  return run(command, [...prefix, ...args], { cwd: cwd ?? neutralCwd(), env: childEnvironment, timeoutMs, input });
}

/** jv with --json appended. */
export function jvJson(args, options = {}) {
  return jv([...args, '--json'], options);
}

/**
 * Runs main() of a skills runtime build (`<runtime>/dist/cli.js`) against `home`. Its dist/cli.js only exports
 * main and COMMANDS, and its bin/jv.mjs installs a runtime into JV_HOME on first use, so a two-line driver calls
 * main() directly. Use `jv(args, { home, shim: true })` instead once the skills runtime bootstrapped that home.
 */
export function skillsJv(runtimeDir, args, { home, env = {}, timeoutMs = 120_000, cwd, input, real = false } = {}) {
  guardHome(home, real);
  const cli = join(runtimeDir, 'dist', 'cli.js');
  const driver = [
    "process.removeAllListeners('warning');",
    "process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\\n`); });",
    "const { pathToFileURL } = await import('node:url');",
    'const { main } = await import(pathToFileURL(process.argv[1]).href);',
    'process.exitCode = await main(process.argv.slice(2));',
  ].join('\n');
  return run(NODE, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', driver, cli, ...args], {
    cwd: cwd ?? neutralCwd(),
    env: childEnv({ ...env, JV_HOME: home }),
    timeoutMs,
    input,
  });
}

/** git in a folder; returns trimmed stdout ('' on failure). */
export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: childEnv() });
  return (r.stdout ?? '').trim();
}

/** npm of Node 22.22.0 in a folder. */
export function npm(cwd, args, { timeoutMs = 15 * 60_000 } = {}) {
  return run(join(NODE_BIN, 'npm'), args, { cwd, timeoutMs });
}

/** The last `n` lines of a process output, for a FAIL detail (never used on output that can hold a secret). */
export function tail(text, n = 15) {
  return String(text ?? '').trimEnd().split('\n').slice(-n).join('\n');
}

// ---- versions -----------------------------------------------------------------------------------------------

/** The monorepo version (one for every package, brief section 2). */
export function packageVersion() {
  return JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')).version;
}

/** A frontmatter value of a SKILL.md, or null. */
export function frontmatterValue(file, key) {
  if (!existsSync(file)) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : null;
}

/** The skills folder of a jevellan-skills checkout and the jevellan-* skill names in it. */
export function skillsOf(repo = SKILLS_REPO) {
  const dir = join(repo, '.apm', 'skills');
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith('jevellan-') && existsSync(join(dir, n, 'SKILL.md')))
        .sort()
    : [];
  return { dir, names, version: frontmatterValue(join(dir, 'jevellan-router', 'SKILL.md'), 'jv-version') };
}

// ---- the skills runtime in a temporary copy -----------------------------------------------------------------

/**
 * Copies the jevellan-skills checkout into <dir>/jevellan-skills (without node_modules and build output; .git is
 * kept so the copy names its commit) and, unless `build: false`, builds its runtime there: npm ci, then
 * npx tsc -p tsconfig.json. Nothing is written into the checkout itself.
 */
export function skillsRuntimeCopy(dir, { build = true, repo = SKILLS_REPO } = {}) {
  const root = join(dir, 'jevellan-skills');
  const skip = new Set(['node_modules', 'dist', 'dist-test']);
  cpSync(repo, root, { recursive: true, filter: (src) => !skip.has(basename(src)) });
  const runtimeDir = join(root, SKILLS_RUNTIME_REL);
  const out = { root, runtimeDir, cli: join(runtimeDir, 'dist', 'cli.js'), bin: join(runtimeDir, 'bin', 'jv.mjs'), commit: git(root, ['rev-parse', '--short', 'HEAD']) };
  if (!build) return { ...out, ok: true, log: '' };
  const ci = npm(runtimeDir, ['ci', '--no-audit', '--no-fund']);
  if (ci.code !== 0) return { ...out, ok: false, log: `npm ci exit ${ci.code}\n${tail(ci.stdout + ci.stderr)}` };
  const tsc = run(join(NODE_BIN, 'npx'), ['tsc', '-p', 'tsconfig.json'], { cwd: runtimeDir, timeoutMs: 10 * 60_000 });
  if (tsc.code !== 0) return { ...out, ok: false, log: `tsc exit ${tsc.code}\n${tail(tsc.stdout + tsc.stderr)}` };
  return { ...out, ok: existsSync(out.cli), log: `npm ci ${Math.round(ci.ms / 1000)} s, tsc ${Math.round(tsc.ms / 1000)} s` };
}

// ---- the sandbox clone --------------------------------------------------------------------------------------

/**
 * The disposable clone of the sandbox (M5, M3): cloned from the sandbox when missing, with a push URL that cannot
 * push (as jevellan-skills D-066 did). The sandbox itself is only read.
 */
export function ensureSandboxClone() {
  if (existsSync(join(SANDBOX_CLONE, '.git'))) return { path: SANDBOX_CLONE, created: false };
  if (!existsSync(join(SANDBOX, '.git'))) throw new Error(`no sandbox at ${SANDBOX}`);
  if (existsSync(SANDBOX_CLONE)) throw new Error(`${SANDBOX_CLONE} exists and is not a git checkout`);
  const r = run('git', ['clone', '--quiet', SANDBOX, SANDBOX_CLONE], { cwd: dirname(SANDBOX_CLONE) });
  if (r.code !== 0) throw new Error(`git clone of the sandbox failed: ${tail(r.stderr, 3)}`);
  git(SANDBOX_CLONE, ['remote', 'set-url', '--push', 'origin', '/nonexistent/no-push']);
  return { path: SANDBOX_CLONE, created: true };
}

// ---- the store, read only -----------------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** A read-only connection to a store file (closed by the caller). */
export function readStore(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

/** One query on a fresh read-only connection. */
export function query(file, sql, ...params) {
  const db = readStore(file);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function queryOne(file, sql, ...params) {
  return query(file, sql, ...params)[0];
}

/** meta.schema_version of a store file, or undefined. */
export function schemaVersionOf(file) {
  if (!existsSync(file)) return undefined;
  try {
    return queryOne(file, "SELECT value FROM meta WHERE key = 'schema_version'")?.value;
  } catch {
    return undefined;
  }
}

export function storeFile(home) {
  return join(home, 'store.sqlite');
}

// ---- waiting ------------------------------------------------------------------------------------------------

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls `predicate` until it returns something other than undefined, null or false, or the timeout passes
 * (resolves undefined). `options` is the timeout in ms or {timeoutMs, intervalMs, onTick}.
 */
export async function waitFor(predicate, options) {
  const { timeoutMs, intervalMs = 2000, onTick } = typeof options === 'number' ? { timeoutMs: options } : options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await predicate();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() >= deadline) return undefined;
    if (onTick) await onTick();
    await sleep(intervalMs);
  }
}

// ---- checks and results -------------------------------------------------------------------------------------

const collected = [];
const notes = [];

export function log(line) {
  process.stdout.write(`${line}\n`);
}

function secs(ms) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** "2 min 05 s" style, for RESULTS. */
export function duration(ms) {
  if (ms === undefined || ms === null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * Runs one check and prints `PASS|FAIL name (elapsed): detail`. `fn` returns true/false, or {ok, detail}; a throw
 * is a FAIL with its message. Details must never hold a secret value (they go to the results file).
 */
export async function check(name, fn) {
  const started = Date.now();
  let ok = false;
  let detail = '';
  try {
    const v = typeof fn === 'function' ? await fn() : fn;
    if (v !== null && typeof v === 'object') {
      ok = !!v.ok;
      detail = v.detail === undefined ? '' : String(v.detail);
    } else ok = !!v;
  } catch (error) {
    ok = false;
    detail = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  const ms = Date.now() - started;
  collected.push({ name, ok, detail, ms });
  log(`${ok ? 'PASS' : 'FAIL'} ${name} (${secs(ms)})${detail ? `: ${detail}` : ''}`);
  return ok;
}

/** A line for the results file and RESULTS.md (what was observed, a difference and its reason, a skip). */
export function note(text) {
  notes.push(String(text));
  log(`NOTE ${text}`);
}

export function collectedChecks() {
  return collected.slice();
}

export function collectedNotes() {
  return notes.slice();
}

/**
 * Writes acceptance/results/<journey>.json: {journey, name, title, status, startedAt, finishedAt, elapsedMs,
 * mode, checks, notes}. `status` is 'pass', 'fail' or 'blocked' (a blocked journey names its reason in notes).
 */
export function recordResult(journey, { status, checks = collectedChecks(), elapsedMs, notes: journeyNotes = collectedNotes(), mode = '', startedAt } = {}) {
  if (!['pass', 'fail', 'blocked'].includes(status)) throw new Error(`invalid status ${status}`);
  const info = journeyInfo(journey);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const finishedAt = new Date().toISOString();
  const result = {
    journey,
    name: info.name,
    title: info.title,
    status,
    mode,
    startedAt: startedAt ?? new Date(Date.now() - (elapsedMs ?? 0)).toISOString(),
    finishedAt,
    elapsedMs: elapsedMs ?? null,
    host: hostname(),
    checkout: CHECKOUT,
    commit: git(CHECKOUT, ['rev-parse', '--short', 'HEAD']),
    checks,
    notes: journeyNotes,
  };
  const file = join(RESULTS_DIR, `${journey}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/**
 * Ends a journey: status blocked when `blocked` names a reason, else pass when every check passed (and at least one
 * ran), else fail; records it (unless `record: false`), prints the summary and returns the exit code (0 pass, 1
 * fail, 2 blocked).
 */
export function finish(journey, { startedAt, mode = '', blocked, record = true } = {}) {
  if (blocked) note(`blocked: ${blocked}`);
  const all = collectedChecks();
  const passed = all.filter((c) => c.ok).length;
  const status = blocked ? 'blocked' : all.length > 0 && passed === all.length ? 'pass' : 'fail';
  const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
  const file = record
    ? recordResult(journey, { status, elapsedMs, mode, ...(startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}) })
    : undefined;
  log(`\n${journeyInfo(journey).name} ${status}: ${passed}/${all.length} checks passed${elapsedMs !== undefined ? ` in ${duration(elapsedMs)}` : ''}${file ? ` (${file})` : ' (not recorded)'}`);
  return status === 'pass' ? 0 : status === 'blocked' ? 2 : 1;
}

/** The standard ending of a journey script's main(): exit with its code, or 1 with the stack when it crashed. */
export function runJourney(journey, main) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`${journeyInfo(journey).name} crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}

// ---- secrets: the leak check --------------------------------------------------------------------------------

/**
 * The patterns of one secret file: every line of at least 6 characters, and the value of NAME=value lines (the
 * redactor's rule, D-014). Shorter lines are not keys and would match ordinary text.
 */
function secretPatterns(file) {
  const out = new Set();
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length >= 6) out.add(line);
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(.+)$/.exec(line);
    if (m && m[1].trim().length >= 6) out.add(m[1].trim());
  }
  return [...out];
}

/** The regular files of a secrets folder (default ~/.jv/secrets). */
export function secretFiles(dir = join(REAL_JV_HOME, 'secrets')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((f) => statSync(f).isFile())
    .sort();
}

function grepFiles(patterns, targets) {
  // -a binary as text, -r folders, -l file names only, -F fixed strings, -f - patterns from stdin, -s no messages.
  const r = spawnSync('grep', ['-a', '-r', '-l', '-s', '-F', '-f', '-', '--', ...targets], { input: `${patterns.join('\n')}\n`, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const files = (r.stdout ?? '').split('\n').filter(Boolean);
  return { files, error: r.status !== 0 && r.status !== 1 && files.length === 0 ? `grep exit ${r.status}` : undefined };
}

/**
 * Greps `targets` (files or folders, recursively; missing ones are skipped) for the contents of every file in
 * `secretsDir` (default ~/.jv/secrets) and for each of `literals`. Patterns go to grep on stdin, never on argv;
 * the result names files only: {secrets, checked, leaks: [{secret, file}], errors}. `secret` is the key file's
 * name (or "literal:<text>" for a literal), never its content.
 */
export function leakCheck(targets, { secretsDir = join(REAL_JV_HOME, 'secrets'), literals = [] } = {}) {
  const checked = [...new Set(targets)].filter((t) => existsSync(t));
  const leaks = [];
  const errors = [];
  const sets = secretFiles(secretsDir).map((f) => ({ label: basename(f), patterns: secretPatterns(f) }));
  literals.forEach((l, i) => sets.push({ label: `literal ${i + 1}`, patterns: [l] }));
  if (checked.length) {
    for (const s of sets) {
      if (!s.patterns.length) continue;
      const r = grepFiles(s.patterns, checked);
      for (const file of r.files) leaks.push({ secret: s.label, file });
      if (r.error) errors.push(`${s.label}: ${r.error}`);
    }
  }
  return { secrets: sets.filter((s) => !s.label.startsWith('literal ')).length, checked, leaks, errors };
}

// ---- ports, long-running jv commands ------------------------------------------------------------------------

/** A free loopback TCP port. */
export function freePort(host = '127.0.0.1') {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

/** The pids listening on a TCP port (lsof, as section 1 checks ports). */
export function listeners(port) {
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 10_000 });
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
}

/**
 * Starts a long-running jv command (jv ui, jv mcp --http, jv bot start) and resolves once `ready(stdoutSoFar,
 * stderrSoFar)` returns a value: {child, value, output()}. Rejects when the process exits first or after
 * `timeoutMs`. Stop it with stopChild().
 */
export function startJv(args, { home, env = {}, ready, timeoutMs = 30_000, cwd, shim = false, real = false } = {}) {
  guardHome(home, real);
  const [command, prefix] = shim ? [join(home, 'bin', 'jv'), []] : [NODE, ['--disable-warning=ExperimentalWarning', BIN_JV]];
  const child = spawn(command, [...prefix, ...args], { cwd: cwd ?? neutralCwd(), env: childEnv({ ...env, JV_HOME: home }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const output = () => ({ stdout: out, stderr: err });
  return new Promise((resolveStart, reject) => {
    let done = false;
    const settle = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new Error(`jv ${args.join(' ')} was not ready within ${Math.round(timeoutMs / 1000)} s: ${tail(err || out, 5)}`));
      });
    }, timeoutMs);
    const probe = () => {
      let v;
      try {
        v = ready ? ready(out, err) : true;
      } catch {
        v = undefined;
      }
      if (v !== undefined && v !== null && v !== false) settle(() => resolveStart({ child, value: v, output }));
    };
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      probe();
    });
    child.stderr.on('data', (c) => {
      err += c.toString('utf8');
      probe();
    });
    child.on('exit', (code, signal) => settle(() => reject(new Error(`jv ${args.join(' ')} exited (${code ?? signal}) before it was ready: ${tail(err || out, 5)}`))));
  });
}

/** The first JSON object printed on stdout (for `ready` of startJv with --json commands). */
export function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    const v = parseJson(text.slice(start, end + 1));
    if (v !== undefined) return v;
  }
  return undefined;
}

/** SIGTERM, then SIGKILL after `graceMs`, for a child this journey started. */
export async function stopChild(child, graceMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// ---- Playwright ---------------------------------------------------------------------------------------------

/** Points Playwright at ~/Library/Caches/ms-playwright (or ~/.cache/ms-playwright) when not set (section 2). */
export function playwrightBrowsersPath() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const linux = join(HOME, '.cache', 'ms-playwright');
    if (existsSync(PLAYWRIGHT_BROWSERS)) process.env.PLAYWRIGHT_BROWSERS_PATH = PLAYWRIGHT_BROWSERS;
    else if (existsSync(linux)) process.env.PLAYWRIGHT_BROWSERS_PATH = linux;
  }
  return process.env.PLAYWRIGHT_BROWSERS_PATH;
}

/** Folders that may hold the playwright package, in order: JV_PLAYWRIGHT_DIR, packages/ui, the root, the sandbox. */
export function playwrightCandidates() {
  const out = [];
  if (process.env.JV_PLAYWRIGHT_DIR) out.push(process.env.JV_PLAYWRIGHT_DIR);
  out.push(join(CHECKOUT, 'packages', 'ui', 'node_modules', 'playwright'), join(CHECKOUT, 'node_modules', 'playwright'));
  out.push(join(SANDBOX, 'node_modules', 'playwright'), join(SANDBOX, 'node_modules', '@playwright', 'test'));
  return out;
}

/** Loads Playwright from outside any package (it is a dev dependency of packages/ui): {pw, dir, version}. */
export function loadPlaywright() {
  playwrightBrowsersPath();
  const tried = [];
  for (const dir of playwrightCandidates()) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    try {
      const pw = require(dir);
      if (pw?.chromium) return { pw, dir, version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version };
    } catch (error) {
      tried.push(`${dir}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  throw new Error(`Playwright not found (set JV_PLAYWRIGHT_DIR). Tried: ${playwrightCandidates().join(', ')}${tried.length ? `; errors: ${tried.join('; ')}` : ''}`);
}

/** file:// URL of a path, for dynamic imports of build output. */
export function fileUrl(path) {
  return pathToFileURL(path).href;
}

// ---- a temporary home with the real providers (M4 to M17) --------------------------------------------------------

/**
 * ~/.jv/providers.json for a temporary home: ~/.jv paths kept (they map onto JV_HOME), every codex-subscription
 * provider disabled. Each copy of the member's Codex login shares one refresh token (D-022), so a throwaway home must
 * never refresh it.
 */
export function providersForTempHome() {
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

/** Copies the real home's providers.json (Codex disabled), secrets (mode 600) and seeds.json into `home`. */
export function seedTempHome(home) {
  const providers = providersForTempHome();
  writeFileSync(join(home, 'providers.json'), `${JSON.stringify(providers.cfg, null, 2)}\n`, { mode: 0o600 });
  const secretsDir = join(home, 'secrets');
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const copied = [];
  for (const f of secretFiles(join(REAL_JV_HOME, 'secrets'))) {
    const to = join(secretsDir, basename(f));
    if (!existsSync(to)) copyFileSync(f, to);
    chmodSync(to, 0o600);
    copied.push(basename(f));
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

/** M-004's project.json settings of the sandbox and its clone. */
export const SANDBOX_SETTINGS = Object.freeze({ testCommand: 'TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test', devCommand: 'npm start', pushAfterLanding: false });

/** Registers a project in `home` and applies `settings` to its project.json; returns its name and path. */
export function registerProject(home, path, name, settings = SANDBOX_SETTINGS) {
  const r = jvJson(['project', 'add', path, '--name', name], { home });
  if (r.code !== 0) throw new Error(`jv project add ${name}: ${r.stderr || r.stdout}`);
  const file = join(home, 'projects', name, 'project.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify({ ...cfg, ...settings }, null, 2)}\n`, { mode: 0o600 });
  return { name, path };
}

/**
 * A temporary JV_HOME with the real providers and Jev: seeded from ~/.jv (seedTempHome), bootstrapped with this
 * checkout and the skills checkout, and with `projects` registered ([path, name] pairs, M-004's settings). Returns
 * the home and what was seeded.
 */
export function realJvHome(id, { projects = [[SANDBOX, SANDBOX_NAME]], name = 'home' } = {}) {
  const home = tempHome(id, name);
  const seeded = seedTempHome(home);
  const b = jvJson(['bootstrap', '--skills', SKILLS_REPO], { home, timeoutMs: 300_000 });
  if (b.code !== 0) throw new Error(`jv bootstrap: ${b.stderr || b.stdout}`);
  const registered = projects.map(([path, projectName]) => registerProject(home, path, projectName));
  return { home, seeded, projects: registered };
}

/**
 * Removes the git worktrees of `repo` that lie inside `dir` (a journey's temporary home), so a journey leaves no
 * worktree record behind in the sandbox; branches stay. Returns the paths removed.
 */
export function removeWorktreesUnder(repo, dir) {
  const out = run('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  const removed = [];
  const base = realpathSync(dir);
  for (const line of out.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      // gone already
    }
    if (real === base || !real.startsWith(`${base}${sep}`)) continue;
    const r = run('git', ['-C', repo, 'worktree', 'remove', '--force', path]);
    if (r.code === 0) removed.push(path);
  }
  run('git', ['-C', repo, 'worktree', 'prune', '--expire', 'now']);
  return removed;
}

/** Polls `jv task show T --json` until the task is in one of `states`; returns the last view. */
export async function waitForTask(home, taskId, states, { timeoutMs = 15 * 60_000, onTick } = {}) {
  let last;
  await waitFor(
    () => {
      const r = jvJson(['task', 'show', taskId], { home });
      if (r.code === 0 && r.json) last = r.json;
      onTick?.(last);
      return last && states.includes(last.state) ? last : undefined;
    },
    { timeoutMs, intervalMs: 3000 },
  );
  return last;
}
