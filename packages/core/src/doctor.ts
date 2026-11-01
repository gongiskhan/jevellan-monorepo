// jv doctor: the preflights of section 11. Each check gives lines of OK, WARN or FAIL with a fix; runChecks(names)
// runs a subset, so jv task create can run the Jev and provider checks it needs before creating anything.
//
// Every effect on the outside world (child processes, HTTP, the clock, the disk) goes through DoctorDeps, so tests
// run with fakes. Probe output is never shown raw: at most its first line, through the redactor. Secrets travel
// only in child environments (D-007), never in argv. `--check NAME` takes a group or one line of it (D-013), and
// jv doctor exits 2 when any line is FAIL, 0 otherwise.
//
// The monorepo's checks (brief sections 1, 4, 6, 8 and 11), on top of the lifted ones:
// - skills: this jv does not run without $JV_HOME/skills/jevellan-router/SKILL.md (FAIL); the installed skills are
//   compared by tree hash with the jevellan-skills checkout install.json records (M-007), and the router's
//   jv-version with the one jv bootstrap recorded (WARN, jv update). The lifted per-skill jv-version line stays.
// - ports: 7071 (jv ui), 7072 (jv mcp --http) and the bot's health port (bot.json, default 7073) are free, or held
//   by the jv process whose pid is in $JV_HOME/run/<ui|mcp>.pid or run/bot.lock; anything else holding one is FAIL
//   with the --port fix. Listeners come from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc -w` (pid and command, no
//   warnings); lsof is looked for on PATH, then in /usr/sbin (macOS) and /usr/bin; without it the line is WARN.
// - memory: node:sqlite of this Node can create an FTS5 table (jevellan-memory needs it), else FAIL naming a Node
//   on this machine that can.
// - service: the bot's service file (launchd plist on macOS, systemd user unit on Linux) under the owner's home
//   (env.ownerHome, never a provider HOME); WARN when it is not installed.
// - member: an informational line when launchd runs Jevellan's member daemon (dev.jevellan.daemon); jv only reads
//   `launchctl list` and never acts on it.
//
// The version probes of the two agent CLIs (`claude --version`, `codex --version`) never run with the owner's HOME:
// Codex creates $CODEX_HOME/tmp/arg0/ on every start, --version included, so a probe run with the owner's HOME
// would write into ~/.codex, which brief section 1 keeps unmodified. They run with the base variables only, HOME =
// $JV_HOME/run/probe-home (mode 700, created first) and CODEX_HOME = its .codex (Codex warns when CODEX_HOME does
// not exist), cwd that folder; CLAUDE_CONFIG_DIR is never set (as for workers, env.ts). When the folder cannot be
// made the line is WARN and the CLI is not run.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readInstall, skillJvVersion, skillsSourceDir, skillsTreeHash, type InstallRecord } from './bootstrap.js';
import { listClaudeModels, type OfferedModel } from './claude-control.js';
import { isAuthError, probeCodex, type CodexProbe } from './codex-control.js';
import { packageVersion } from './version.js';
import { jevClient } from './jev/client.js';
import { JevError } from './jev/contract.js';
import { ownerHome } from './env.js';
import { botConfigFile } from './limits.js';
import { paths } from './paths.js';
import { gitTopLevel } from './project.js';
import {
  allModelIds,
  cheapestModel,
  CLAUDE_KINDS,
  keyFileStatus,
  loadProviders,
  providerEnv,
  providerSecretFile,
  recordProviderAuth,
  type Provider,
  type ProviderAuthRecord,
  type ProvidersConfig,
} from './providers.js';
import { redact } from './redact.js';
import { REPORT_GUARD_MARK } from './seeds.js';
import { openStore, SCHEMA_VERSION } from './store.js';
import type { ProjectRow } from './types.js';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface ExecResult {
  /** Exit code, or null when the process did not exit normally (not found, killed, timed out). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 'not-found' when the command is not on PATH, 'timeout' when it was killed after timeoutMs. */
  error?: 'not-found' | 'timeout' | string;
}

export interface ExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface DoctorDeps {
  exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  fetch: typeof fetch;
  /** Folder whose git repository is "the current project" (default process.cwd()). */
  cwd: string;
  /** The process environment the minimal child environments are built from. */
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  /** Free bytes available to jv at a path. */
  freeBytes: (path: string) => number;
  /** Timeout of a Claude login probe (default 60 s). */
  probeTimeoutMs: number;
  /** The Codex login probe (app-server account/read and account/rateLimits/read) under a provider's environment. */
  codexProbe: (env: Record<string, string>, cwd: string) => Promise<CodexProbe>;
  /** The models a Claude login offers (the agent SDK's supportedModels()) under a provider's environment. */
  claudeModels: (env: Record<string, string>, cwd: string) => Promise<OfferedModel[]>;
  /** Stores a login probe's result for placement (meta provider_auth:<name>, D-012). */
  recordAuth: (provider: string, record: ProviderAuthRecord) => void;
  /** The platform the service and member lines are about (default process.platform). */
  platform: NodeJS.Platform;
  /** The owner's own home (env.ownerHome): where the bot's service file lives. Never a provider's HOME. */
  ownerHome: string;
  /** The Node binary running this doctor (default process.execPath). */
  execPath: string;
  /** Tries an FTS5 table in this Node's node:sqlite: undefined when it works, else why not (brief section 6). */
  fts5Probe: () => string | undefined;
  /** Another Node binary on this machine whose node:sqlite has FTS5; asked only when this one has none. */
  findFts5Node: () => Promise<NodeBinary | undefined>;
}

export interface NodeBinary {
  path: string;
  version: string;
}

export const MIN_NODE: readonly [number, number] = [22, 13];
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
export const APM_INSTALL_COMMAND = 'apm install gongiskhan/jevellan-skills --target claude';
const BASE_ENV_KEYS = ['PATH', 'USER', 'LANG', 'TERM', 'SHELL', 'TMPDIR'] as const;
const SKILL_PREFIX = 'jevellan-';
const ROUTER_SKILL = 'jevellan-router';

/** The loopback ports of brief section 1: jv ui, jv mcp --http and the bot's health endpoint (bot.json can move it). */
export const JV_PORTS = { ui: 7071, mcp: 7072, bot: 7073 } as const;
/** The launchd label of the bot's service (section 8), distinct from Jevellan's member daemon. */
export const BOT_SERVICE_LABEL = 'dev.jevellan.bot';
/** The launchd label of the Jevellan member daemon, which jv only ever reads about (section 1). */
export const MEMBER_DAEMON_LABEL = 'dev.jevellan.daemon';

// ---- default effects ---------------------------------------------------------------------------------------

/** How long output may still drain after the process exited, before the pipes are closed. */
export const EXEC_DRAIN_MS = 300;
/** Grace between SIGTERM and SIGKILL of a timed out process group. */
export const EXEC_KILL_GRACE_MS = 2000;

/**
 * Runs a command without a shell, stdin closed, in its own process group so a timeout kills everything it started.
 * It settles when the process exits (plus a short drain of its output), not when its pipes close: a grandchild that
 * left the group and holds stdout open can never hold jv up. On a timeout it settles after the SIGKILL grace even if
 * the process never reports its exit.
 */
export function execCommand(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise(r);
    };
    const result = (code: number | null): ExecResult => ({
      code: timedOut ? null : code,
      stdout,
      stderr,
      ...(timedOut ? { error: 'timeout' } : {}),
    });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        timers.push(
          setTimeout(() => {
            kill('SIGKILL');
            timers.push(setTimeout(() => done(result(null)), EXEC_DRAIN_MS));
          }, EXEC_KILL_GRACE_MS),
        );
      }, options.timeoutMs ?? 30_000),
    );
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      done({ code: null, stdout, stderr, error: error.code === 'ENOENT' ? 'not-found' : error.message });
    });
    // 'close' comes first when nothing else holds the pipes; otherwise 'exit' plus a short drain settles it.
    child.on('close', (code) => done(result(code)));
    child.on('exit', (code) => {
      timers.push(setTimeout(() => done(result(code)), EXEC_DRAIN_MS));
    });
  });
}

function freeBytesAt(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const st = statfsSync(p);
  return Number(st.bavail) * Number(st.bsize);
}

/** Whether this Node's node:sqlite can create an FTS5 table: undefined when it can, else the error's message. */
export function probeFts5(): string | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    db?.close();
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The Node binaries of this machine worth trying when this one has no FTS5: the owner's nvm versions (newest first),
 * `node` in every PATH folder, and the usual system places. Existing files only, each real path once.
 */
export function nodeCandidates(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const nvm = join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvm).filter((n) => /^v\d+\.\d+\.\d+$/.test(n)).sort((a, b) => compareVersions(b, a))) out.push(join(nvm, v, 'bin', 'node'));
  } catch {
    // no nvm
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir !== '') out.push(join(dir, 'node'));
  out.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of out) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    found.push(candidate);
  }
  return found;
}

/** Run by each candidate Node: exit 0 printing its version when it is 22.13 or later and node:sqlite has FTS5. */
const FTS5_NODE_SCRIPT = [
  "const [a, b] = process.versions.node.split('.').map(Number);",
  'if (a < 22 || (a === 22 && b < 13)) process.exit(3);',
  "const { DatabaseSync } = require('node:sqlite');",
  "const db = new DatabaseSync(':memory:');",
  "db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(x)');",
  'db.close();',
  'process.stdout.write(process.versions.node);',
].join(' ');

/** The newest of `candidates` whose node:sqlite has FTS5 (each asked with a one-line script), or undefined. */
export async function findFts5Node(candidates: readonly string[], exec: DoctorDeps['exec'] = execCommand): Promise<NodeBinary | undefined> {
  const results = await Promise.all(
    candidates.slice(0, 16).map(async (path): Promise<NodeBinary | undefined> => {
      const r = await exec(path, ['-e', FTS5_NODE_SCRIPT], { timeoutMs: 15_000 });
      const version = r.stdout.trim();
      return r.code === 0 && /^\d+\.\d+\.\d+/.test(version) ? { path, version } : undefined;
    }),
  );
  return results
    .filter((n): n is NodeBinary => n !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function defaultDeps(): DoctorDeps {
  const owner = ownerHome();
  return {
    exec: execCommand,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    env: process.env,
    nodeVersion: process.versions.node,
    freeBytes: freeBytesAt,
    probeTimeoutMs: 60_000,
    codexProbe: (env, cwd) => probeCodex({ env, cwd }),
    claudeModels: (env, cwd) => listClaudeModels({ env, cwd }),
    recordAuth: (provider, record) => {
      const store = openStore();
      try {
        recordProviderAuth(store, provider, record);
      } finally {
        store.close();
      }
    },
    platform: process.platform,
    ownerHome: owner,
    execPath: process.execPath,
    fts5Probe: probeFts5,
    findFts5Node: () => {
      const self = realOr(process.execPath);
      return findFts5Node(nodeCandidates(owner).filter((n) => realOr(n) !== self));
    },
  };
}

// ---- helpers -----------------------------------------------------------------------------------------------

function firstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  const masked = redact(line);
  return masked.length > max ? `${masked.slice(0, max - 3)}...` : masked;
}

function ok(name: string, detail: string): CheckResult {
  return { name, status: 'OK', detail };
}
function warn(name: string, detail: string, fix?: string): CheckResult {
  return { name, status: 'WARN', detail, ...(fix ? { fix } : {}) };
}
function fail(name: string, detail: string, fix?: string): CheckResult {
  return { name, status: 'FAIL', detail, ...(fix ? { fix } : {}) };
}

function sha256(file: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** The child environment of a provider probe: the base variables, the provider's HOME and login, and jv's flags. */
export function probeEnvironment(p: Provider, base: NodeJS.ProcessEnv): { env: Record<string, string>; missing?: string } {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k]!;
  const provider = providerEnv(p);
  Object.assign(env, provider.env);
  if (CLAUDE_KINDS.includes(p.kind)) {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }
  return { env, ...(provider.missing ? { missing: provider.missing } : {}) };
}

/** Frontmatter value of a SKILL.md (simple `key: value` lines between the first two --- lines). */
export function frontmatterValue(text: string, key: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv && kv[1] === key) return kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/**
 * The model ids that have a line in the router policy's "## model descriptions" section ("<model id>: <text>"),
 * or undefined when the policy has no such section.
 */
export function policyModelDescriptions(body: string): Map<string, string> | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+model descriptions\s*$/i.test(l));
  if (start < 0) return undefined;
  const out = new Map<string, string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line)) break;
    // The id ends at the first colon followed by a space, so ids with a colon (qwen3:8b) still parse.
    const m = /^(\S+?):\s+(\S.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function stopHookRegistered(settingsFile: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as { hooks?: { Stop?: unknown } };
    const stop = settings.hooks?.Stop;
    if (!Array.isArray(stop)) return false;
    return stop.some(
      (g) =>
        g &&
        typeof g === 'object' &&
        Array.isArray((g as { hooks?: unknown }).hooks) &&
        (g as { hooks: unknown[] }).hooks.some(
          (h) => !!h && typeof h === 'object' && typeof (h as { command?: unknown }).command === 'string' && (h as { command: string }).command.includes(REPORT_GUARD_MARK),
        ),
    );
  } catch {
    return false;
  }
}

function jvSkillNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(SKILL_PREFIX) && existsSync(join(dir, n, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

// ---- the checks --------------------------------------------------------------------------------------------

interface Ctx {
  deps: DoctorDeps;
  providers(): ProvidersConfig | { error: string };
  /** Whether a result is asked for (a check skips expensive work, a probe, for results nobody asked for). */
  wants(resultName: string): boolean;
}

type Check = (ctx: Ctx) => Promise<CheckResult[]>;

function providersOrFail(ctx: Ctx, name: string): ProvidersConfig | CheckResult {
  const c = ctx.providers();
  return 'error' in c ? fail(name, `providers.json: ${c.error}`, 'fix providers.json, or run jv update to write it from the template') : c;
}

async function tool(ctx: Ctx, name: string, command: string, args: string[], missing: CheckStatus, fix: string, where: Pick<ExecOptions, 'env' | 'cwd'> = {}): Promise<CheckResult[]> {
  const r = await ctx.deps.exec(command, args, { ...where, timeoutMs: 15_000 });
  if (r.error === 'not-found') return [{ name, status: missing, detail: `${command} is not on PATH`, fix }];
  if (r.code !== 0) return [{ name, status: missing, detail: `${command} ${args.join(' ')} failed: ${firstLine(r.stderr || r.stdout) || `exit ${r.code ?? r.error}`}`, fix }];
  return [ok(name, firstLine(r.stdout || r.stderr))];
}

const checkNode: Check = async (ctx) => {
  const [major = 0, minor = 0] = ctx.deps.nodeVersion.split('.').map(Number);
  const good = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return [
    good
      ? ok('node', `Node ${ctx.deps.nodeVersion}`)
      : fail('node', `Node ${ctx.deps.nodeVersion} is older than ${MIN_NODE.join('.')} (node:sqlite)`, 'install Node 22.13 or later and run jv bootstrap with it'),
  ];
};

const checkGit: Check = (ctx) => tool(ctx, 'git', 'git', ['--version'], 'FAIL', 'install git');
const checkTmux: Check = (ctx) => tool(ctx, 'tmux', 'tmux', ['-V'], 'FAIL', 'install tmux (sudo apt install tmux)');
/** The HOME of the agent CLIs' version probes: a folder jv owns, never the owner's home (see the header). */
function probeHome(): string {
  return join(paths.home, 'run', 'probe-home');
}

/**
 * The environment of an agent CLI's version probe: the base variables of `base` (never its HOME, CODEX_HOME or
 * CLAUDE_CONFIG_DIR), HOME = probeHome() and CODEX_HOME = its .codex, both created (mode 700) before the probe.
 */
function versionProbeEnvironment(base: NodeJS.ProcessEnv): { env: Record<string, string>; cwd: string } {
  const home = probeHome();
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (base[k] !== undefined) env[k] = base[k]!;
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  return { env, cwd: home };
}

/** tool() for claude and codex, in the probe environment; WARN without running the CLI when it cannot be made. */
async function agentTool(ctx: Ctx, name: string, command: string, missing: CheckStatus, fix: string): Promise<CheckResult[]> {
  let where: { env: Record<string, string>; cwd: string };
  try {
    where = versionProbeEnvironment(ctx.deps.env);
  } catch (error) {
    const why = firstLine(error instanceof Error ? error.message : String(error));
    return [warn(name, `${command} --version not probed: cannot create ${probeHome()} (${why})`, `make ${paths.home} writable, then run jv doctor again`)];
  }
  return tool(ctx, name, command, ['--version'], missing, fix, where);
}

const checkClaude: Check = (ctx) => agentTool(ctx, 'claude', 'claude', 'FAIL', 'install Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
const checkCodex: Check = (ctx) => agentTool(ctx, 'codex', 'codex', 'WARN', 'install Codex: npm install -g @openai/codex');

const checkProviders: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'providers');
  if ('status' in c) return [c];
  const on = c.providers.filter((p) => p.enabled).length;
  return [ok('providers', `${c.providers.length} providers (${on} enabled) in ${c.file}`)];
};

const checkKeys: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'keys');
  if ('status' in c) return [c];
  return c.providers.map((p): CheckResult => {
    const name = `key:${p.name}`;
    const file = providerSecretFile(p);
    if (file === undefined) {
      return ok(name, p.kind === 'openai-compatible' ? 'no key needed' : 'no key file; the home holds its own login');
    }
    const st = keyFileStatus(file);
    const write = `write the key to ${file} and run chmod 600 ${file}`;
    switch (st.state) {
      case 'ok':
        return ok(name, `key file present, mode 600 (${file})`);
      case 'missing':
        return warn(name, `key file missing (${file})`, write);
      case 'empty':
        return warn(name, `key file empty (${file})`, write);
      case 'mode':
        return fail(name, `key file ${file} has mode ${st.mode}, not 600`, `chmod 600 ${file}`);
      default:
        return fail(name, `${file} is not a regular file`, write);
    }
  });
};

/** A login check's line and the login state it establishes (recorded for placement; undefined: nothing probed). */
type Probed = { result: CheckResult; auth?: ProviderAuthRecord['auth'] };

async function claudeLogin(ctx: Ctx, p: Provider): Promise<Probed> {
  const name = `login:${p.name}`;
  const home = p.home!;
  const login = `jv providers login ${p.name}`;
  if (!existsSync(join(home, '.claude'))) return { result: fail(name, `provider home ${home} is not set up`, 'run jv update'), auth: 'unknown' };
  const { env, missing } = probeEnvironment(p, ctx.deps.env);
  if (missing) {
    return { result: warn(name, `key file missing (${missing}); login not probed`, `write the key to ${missing} (mode 600)`), auth: 'needs-login' };
  }
  if (p.kind === 'claude-subscription' && p.tokenFile === undefined && !existsSync(join(home, '.claude', '.credentials.json'))) {
    return { result: warn(name, `needs login: no token file and no login in ${home}`, login), auth: 'needs-login' };
  }
  const model = cheapestModel(p).id;
  const r = await ctx.deps.exec(
    'claude',
    ['-p', 'Reply with the single word OK.', '--max-turns', '1', '--model', model, '--output-format', 'json'],
    { env, cwd: home, timeoutMs: ctx.deps.probeTimeoutMs },
  );
  if (r.error === 'not-found') return { result: fail(name, 'claude is not on PATH; login not probed', 'install Claude Code'), auth: 'unknown' };
  if (r.error === 'timeout') {
    const secs = Math.round(ctx.deps.probeTimeoutMs / 1000);
    return { result: fail(name, `the one-turn probe on ${model} did not answer within ${secs} s`, login), auth: 'unknown' };
  }
  let parsed: { is_error?: unknown; result?: unknown; subtype?: unknown } | undefined;
  try {
    const lastJson = r.stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).at(-1) ?? r.stdout;
    parsed = JSON.parse(lastJson) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (r.code === 0 && parsed && parsed.is_error !== true) {
    return { result: ok(name, `logged in: a one-turn probe on ${model} answered`), auth: 'ready' };
  }
  const text = typeof parsed?.result === 'string' ? parsed.result : '';
  const why = firstLine(text || r.stderr || r.stdout) || `exit ${r.code}`;
  const auth = isAuthError(`${text}\n${r.stderr}\n${r.stdout}`) ? 'needs-login' : 'unknown';
  return { result: fail(name, `the one-turn probe on ${model} failed: ${why}`, login), auth };
}

async function codexLogin(ctx: Ctx, p: Provider): Promise<Probed> {
  const name = `login:${p.name}`;
  const home = p.home!;
  const loginCommand = `jv providers login ${p.name}`;
  if (!existsSync(join(home, '.codex'))) return { result: fail(name, `provider home ${home} is not set up`, 'run jv update'), auth: 'unknown' };
  const { env } = probeEnvironment(p, ctx.deps.env);
  const r = await ctx.deps.codexProbe(env, home);
  if (r.error === 'codex is not on PATH') {
    return { result: warn(name, 'codex is not on PATH; login not checked', 'install Codex: npm install -g @openai/codex'), auth: 'unknown' };
  }
  const usage = r.usage
    ? [r.usage.weeklyPct !== undefined ? `week ${r.usage.weeklyPct}%` : '', r.usage.fiveHourPct !== undefined ? `five hours ${r.usage.fiveHourPct}%` : '']
        .filter(Boolean)
        .join(', ')
    : '';
  if (r.auth === 'ready') {
    return { result: ok(name, `ready: ChatGPT ${r.plan ?? 'login'} answered account/rateLimits/read${usage ? ` (${usage})` : ''}`), auth: 'ready' };
  }
  if (r.auth === 'needs-login') return { result: warn(name, `needs login: ${r.error ?? 'no login'}`, loginCommand), auth: 'needs-login' };
  return { result: warn(name, `login state unknown: ${r.error ?? 'the probe did not complete'}`, `run jv doctor again; if it persists, ${loginCommand}`), auth: 'unknown' };
}

const checkLogins: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'logins');
  if ('status' in c) return [c];
  const probes = c.providers.map(async (p): Promise<CheckResult | undefined> => {
    if (p.kind === 'openai-compatible' || !ctx.wants(`login:${p.name}`)) return undefined;
    if (!p.enabled) return ok(`login:${p.name}`, 'disabled in providers.json; not probed');
    const probed = p.kind === 'codex-subscription' ? await codexLogin(ctx, p) : await claudeLogin(ctx, p);
    if (probed.auth !== undefined) {
      try {
        ctx.deps.recordAuth(p.name, { auth: probed.auth, observedAt: new Date().toISOString(), detail: probed.result.detail.slice(0, 300) });
      } catch (error) {
        return warn(probed.result.name, `${probed.result.detail} (not recorded in the store: ${firstLine(error instanceof Error ? error.message : String(error))})`, probed.result.fix);
      }
    }
    return probed.result;
  });
  return (await Promise.all(probes)).filter((r): r is CheckResult => r !== undefined);
};

const checkModels: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'models');
  if ('status' in c) return [c];
  const probes = c.providers.map(async (p): Promise<CheckResult | undefined> => {
    const name = `models:${p.name}`;
    if (!ctx.wants(name)) return undefined;
    if (p.kind === 'openai-compatible') return openAiModels(ctx, p, name);
    if (!CLAUDE_KINDS.includes(p.kind)) return undefined;
    if (!p.enabled) return ok(name, 'disabled in providers.json; not probed');
    if (p.kind === 'claude-endpoint') return ok(name, `the endpoint serves its configured models (${p.models.map((m) => m.id).join(', ')}); not probed`);
    const { env, missing } = probeEnvironment(p, ctx.deps.env);
    if (missing) return warn(name, `key file missing (${missing}); supportedModels not probed`, `write the key to ${missing} (mode 600)`);
    let offered: OfferedModel[];
    try {
      offered = await ctx.deps.claudeModels(env, p.home!);
    } catch (error) {
      return fail(name, `the supportedModels probe could not run: ${firstLine(error instanceof Error ? error.message : String(error))}`, `jv providers login ${p.name}`);
    }
    const ids = new Set(offered.map((m) => m.id));
    const absent = p.models.filter((m) => !ids.has(m.id)).map((m) => m.id);
    if (absent.length) {
      return warn(
        name,
        `not offered to this login: ${absent.join(', ')} (offered: ${[...ids].join(', ') || 'none'})`,
        `change the model ids of ${p.name} in ${c.file} to offered ones`,
      );
    }
    return ok(name, `all ${p.models.length} models in providers.json are offered (${offered.length} offered)`);
  });
  return (await Promise.all(probes)).filter((r): r is CheckResult => r !== undefined);
};

/**
 * The models of an openai-compatible provider (GET <baseUrl>/models), M-020: a local Ollama with nothing pulled is a
 * WARN "no models" (brief section 12), an unreachable endpoint a WARN; a provider whose key file is missing is left to
 * its key line. The key is sent as a bearer header and never printed.
 */
async function openAiModels(ctx: Ctx, p: Provider, name: string): Promise<CheckResult | undefined> {
  if (!p.enabled) return ok(name, 'disabled in providers.json; not probed');
  const base = (p.baseUrl ?? '').replace(/\/+$/, '');
  if (base === '') return warn(name, 'no baseUrl in providers.json', `set baseUrl of ${p.name}`);
  let key: string | undefined;
  if (p.keyFile) {
    if (keyFileStatus(p.keyFile).state !== 'ok') return undefined;
    key = readFileSync(p.keyFile, 'utf8').trim();
  }
  const configured = p.models.map((m) => m.id);
  try {
    const res = await ctx.deps.fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return warn(name, `GET ${base}/models answered ${res.status}`, `check ${p.name} in providers.json or set enabled false`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
    const pull = p.name === 'ollama' || /:11434\b/.test(base) ? `ollama pull ${configured[0] ?? '<model>'}` : `change the model ids of ${p.name} to offered ones`;
    if (ids.length === 0) return warn(name, `${p.name} has no models (${configured.join(', ')} not installed)`, pull);
    const absent = configured.filter((id) => !ids.includes(id));
    if (absent.length) return warn(name, `not offered by ${base}: ${absent.join(', ')} (offered: ${ids.slice(0, 8).join(', ')})`, pull);
    return ok(name, `all ${configured.length} models in providers.json are offered (${ids.length} offered)`);
  } catch {
    return warn(name, `${base} is not reachable`, `make sure ${base} is reachable or set enabled false for ${p.name}`);
  }
}

const checkJev: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'jev');
  if ('status' in c) return [c];
  const file = c.jev.keyFile;
  const st = keyFileStatus(file);
  const write = `write the Jev key to ${file} and run chmod 600 ${file}`;
  if (st.state === 'missing' || st.state === 'empty') return [fail('jev', 'no key configured', write)];
  if (st.state !== 'ok') return [fail('jev', `the Jev key file ${file} has mode ${st.mode ?? '?'}, not 600`, `chmod 600 ${file}`)];
  try {
    const models = await jevClient(c.jev, { fetch: ctx.deps.fetch }).models();
    const names = models.models.map((m) => m.name);
    if (!names.includes(c.jev.model)) {
      return [
        fail('jev', `reachable, but the configured model ${c.jev.model} is not listed (listed: ${names.join(', ') || 'none'})`, `set jev.model in ${c.file} to a listed model`),
      ];
    }
    return [ok('jev', `reachable, model ${c.jev.model} listed (${names.length} models)`)];
  } catch (error) {
    const message = error instanceof JevError ? error.message : error instanceof Error ? firstLine(error.message) : String(error);
    const fix = error instanceof JevError && (error.kind === 'auth' || error.kind === 'no-key') ? write : 'check the network and run jv doctor again';
    return [fail('jev', `GET /v1/models: ${message}`, fix)];
  }
};

const checkStore: Check = async () => {
  try {
    const store = openStore();
    try {
      const v = store.schemaVersion();
      return [
        v === SCHEMA_VERSION
          ? ok('store', `schema ${v} at ${store.file}`)
          : fail('store', `schema ${v} at ${store.file}, this runtime needs ${SCHEMA_VERSION}`, 'run jv update'),
      ];
    } finally {
      store.close();
    }
  } catch (error) {
    return [fail('store', `cannot open ${paths.store}: ${firstLine(error instanceof Error ? error.message : String(error))}`, 'run jv update')];
  }
};

const checkDisk: Check = async (ctx) => {
  try {
    const free = ctx.deps.freeBytes(paths.home);
    const gb = (free / 1024 ** 3).toFixed(1);
    return [
      free >= MIN_FREE_BYTES
        ? ok('disk', `${gb} GB free for ${paths.home}`)
        : fail('disk', `only ${gb} GB free for ${paths.home}; jv needs 5 GB for worktrees and logs`, 'free disk space, or run jv gc'),
    ];
  } catch (error) {
    return [warn('disk', `free space unknown: ${firstLine(error instanceof Error ? error.message : String(error))}`)];
  }
};

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The registered project whose checkout holds `dir` (symlinks resolved), or undefined. */
export function registeredProjectAt(dir: string, projects: ReadonlyArray<Pick<ProjectRow, 'name' | 'path'>>): Pick<ProjectRow, 'name' | 'path'> | undefined {
  const at = realOr(dir);
  return projects
    .map((p) => ({ p, root: realOr(p.path) }))
    .filter(({ root }) => at === root || at.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
    .sort((a, b) => b.root.length - a.root.length)[0]?.p;
}

/**
 * The Stop hook of the project the doctor runs in. Only a registered project (jv project add) is checked: anywhere
 * else the line is OK and skipped, because the fix (apm install) would write a .claude/ folder into whatever
 * repository the owner happens to be in, this package's own checkout included.
 */
const checkHook: Check = async (ctx) => {
  let projects: ProjectRow[];
  try {
    const store = openStore();
    try {
      projects = store.listProjects();
    } finally {
      store.close();
    }
  } catch {
    projects = [];
  }
  const project = registeredProjectAt(ctx.deps.cwd, projects);
  if (!project) return [ok('hook', 'not inside a registered project; skipped')];
  const top = gitTopLevel(ctx.deps.cwd) ?? project.path;
  const file = join(top, '.claude', 'settings.json');
  return [
    stopHookRegistered(file)
      ? ok('hook', `the jv Stop hook is registered in ${file}`)
      : warn('hook', `the jv Stop hook is not registered in ${file}`, `in ${top}: ${APM_INSTALL_COMMAND}`),
  ];
};

/** What `jv bootstrap --skills` should be given: the recorded checkout while it is still one, else a placeholder. */
function bootstrapSkillsFix(install: Partial<InstallRecord> | undefined): string {
  const recorded = install?.skillsSource;
  const usable = typeof recorded === 'string' && recorded !== '' && existsSync(join(recorded, '.apm', 'skills', ROUTER_SKILL, 'SKILL.md'));
  return `jv bootstrap --skills ${usable ? recorded : '<path to a jevellan-skills checkout>'}`;
}

/** The installed skills against the jevellan-skills checkout install.json records (M-007), by tree hash. */
function skillsCheckoutLine(install: Partial<InstallRecord> | undefined): CheckResult {
  const name = 'skills:checkout';
  const recorded = install?.skillsSource;
  if (typeof recorded !== 'string' || recorded === '') {
    return warn(name, `no skills checkout recorded in ${paths.installFile}; the installed skills cannot be compared with one`, bootstrapSkillsFix(install));
  }
  let sourceDir: string;
  try {
    sourceDir = skillsSourceDir(recorded);
  } catch {
    const why = existsSync(recorded) ? 'is not a jevellan-skills checkout any more' : 'is missing';
    return warn(name, `the recorded skills checkout ${recorded} ${why}`, bootstrapSkillsFix(undefined));
  }
  if (skillsTreeHash(sourceDir) === skillsTreeHash(paths.skillsDir)) {
    return ok(name, `the skills in ${paths.skillsDir} match the checkout ${recorded}`);
  }
  return warn(name, `the skills in ${paths.skillsDir} differ from the checkout ${recorded}`, 'jv update');
}

/** The router's jv-version against the one jv bootstrap recorded in install.json (brief section 11). */
function skillsVersionLine(install: Partial<InstallRecord> | undefined, routerFile: string): CheckResult {
  const name = 'skills:version';
  const installed = skillJvVersion(routerFile);
  const recorded = install?.skillsVersion;
  if (typeof recorded !== 'string' || recorded === '') {
    return warn(
      name,
      `jv bootstrap recorded no skills version in ${paths.installFile} (the router's jv-version is ${installed ?? 'missing'})`,
      install ? 'jv update' : bootstrapSkillsFix(install),
    );
  }
  if (installed === recorded) return ok(name, `the router's jv-version ${installed} is the one jv bootstrap recorded`);
  return warn(name, `the router's jv-version is ${installed ?? 'missing'}, jv bootstrap recorded ${recorded}`, 'jv update');
}

const checkSkills: Check = async (ctx) => {
  const install = readInstall();
  const routerFile = paths.skillFile(ROUTER_SKILL);
  if (!existsSync(routerFile)) {
    return [fail('skills', `no ${ROUTER_SKILL} skill at ${routerFile}: this jv does not run without the skills`, bootstrapSkillsFix(install))];
  }
  // The lifted line, every installed skill's jv-version against one version. The monorepo versions jv and the skills
  // apart (M-022), so the reference is the installed router's jv-version: a skill set copied from one checkout agrees
  // with itself, and skills:version compares the router with what jv bootstrap recorded.
  const names = jvSkillNames(paths.skillsDir);
  const version = frontmatterValue(readFileSync(routerFile, 'utf8'), 'jv-version') ?? packageVersion();
  const off = names
    .map((n) => {
      const v = frontmatterValue(readFileSync(join(paths.skillsDir, n, 'SKILL.md'), 'utf8'), 'jv-version');
      return v === version ? undefined : `${n} ${v ?? 'no jv-version'}`;
    })
    .filter((x): x is string => x !== undefined);
  const out: CheckResult[] = [
    off.length === 0
      ? ok('skills', `${names.length} skills in ${paths.skillsDir} at version ${version}`)
      : warn('skills', `the router is at ${version}, these skills differ: ${off.join(', ')}`, 'run jv update'),
  ];
  if (ctx.wants('skills:checkout')) out.push(skillsCheckoutLine(install));
  if (ctx.wants('skills:version')) out.push(skillsVersionLine(install, routerFile));
  return out;
};

function compareCopies(label: string, dir: string, reference: string[], expectInstalled: boolean, fix: string): CheckResult {
  const name = `skill-copies:${label}`;
  const installed = jvSkillNames(dir);
  if (installed.length === 0) {
    return expectInstalled ? warn(name, `no jevellan skills in ${dir}`, fix) : ok(name, `no jevellan skills installed in ${dir}`);
  }
  const differ = installed.filter((n) => sha256(join(dir, n, 'SKILL.md')) !== sha256(join(paths.skillsDir, n, 'SKILL.md')));
  const missing = expectInstalled ? reference.filter((n) => !installed.includes(n)) : [];
  if (differ.length === 0 && missing.length === 0) return ok(name, `${installed.length} skills in ${dir} match ${paths.skillsDir}`);
  const parts = [];
  if (differ.length) parts.push(`differ from ${paths.skillsDir}: ${differ.join(', ')}`);
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  return warn(name, `skills in ${dir} ${parts.join('; ')}`, fix);
}

const checkSkillCopies: Check = async (ctx) => {
  const reference = jvSkillNames(paths.skillsDir);
  const out: CheckResult[] = [];
  const top = gitTopLevel(ctx.deps.cwd);
  if (top) {
    out.push(compareCopies('project', join(top, '.claude', 'skills'), reference, false, `in ${top}: ${APM_INSTALL_COMMAND}`));
  }
  const c = ctx.providers();
  if (!('error' in c)) {
    for (const p of c.providers) {
      if (!CLAUDE_KINDS.includes(p.kind) || p.home === undefined || !p.enabled) continue;
      out.push(compareCopies(p.name, join(p.home, '.claude', 'skills'), reference, true, 'run jv update'));
    }
  }
  return out;
};

const checkModelDescriptions: Check = async (ctx) => {
  const c = providersOrFail(ctx, 'model-descriptions');
  if ('status' in c) return [c];
  const file = paths.skillFile(ROUTER_SKILL);
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return [fail('model-descriptions', `no router policy at ${file}`, 'run jv update')];
  }
  const described = policyModelDescriptions(body);
  if (!described) {
    return [warn('model-descriptions', `the router policy (${file}) has no "## model descriptions" section yet`, 'run jv update with a package whose router policy is written')];
  }
  const ids = allModelIds(c);
  const missing = ids.filter((id) => !described.has(id));
  // A line whose id no provider serves is stale (a renamed model): Jev never sees it, and it hides the rename.
  const stale = [...described.keys()].filter((id) => !ids.includes(id));
  if (missing.length === 0 && stale.length === 0) return [ok('model-descriptions', `every model in providers.json has a description line in ${file}`)];
  const details: string[] = [];
  const fixes: string[] = [];
  if (missing.length) {
    details.push(`no description line in the router policy for: ${missing.join(', ')}`);
    fixes.push(`add "<model id>: <text>" lines to "## model descriptions" in the router policy, or remove the models from ${c.file}`);
  }
  if (stale.length) {
    details.push(`description lines for models no provider in providers.json has: ${stale.join(', ')}`);
    fixes.push(`remove those lines from "## model descriptions" in ${file}, or add the models to ${c.file}`);
  }
  return [warn('model-descriptions', details.join('; '), fixes.join('; '))];
};

// ---- the monorepo's machine checks: memory, ports, service, member ------------------------------------------

const checkMemory: Check = async (ctx) => {
  const problem = ctx.deps.fts5Probe();
  if (problem === undefined) return [ok('memory', `node:sqlite of Node ${ctx.deps.nodeVersion} has FTS5`)];
  const other = await ctx.deps.findFts5Node();
  const fix = other
    ? `use ${other.path} (Node ${other.version}, FTS5 present): jv bootstrap --node ${other.path}`
    : 'install a Node 22.13 or later built with FTS5 and run jv bootstrap --node <its path>';
  return [fail('memory', `node:sqlite of this Node (${ctx.deps.execPath}, ${ctx.deps.nodeVersion}) cannot create an FTS5 table, which jv memory needs: ${firstLine(problem)}`, fix)];
};

/** $JV_HOME/run/<file>: the pid files of jv ui and jv mcp, and the bot's lock. */
export function runFile(file: string): string {
  return join(paths.home, 'run', file);
}

/** The pid a pid file or lock holds ("<pid>" on its first line, or JSON with a pid), or undefined. */
export function readPidFile(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  let pid: unknown;
  if (text.startsWith('{')) {
    try {
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      return undefined;
    }
  } else {
    pid = Number(text.split(/\s+/)[0]);
  }
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** The bot's health port: health.port of bot.json, read leniently (the bot validates the file), else 7073. */
export function botHealthPort(file: string = botConfigFile()): number {
  try {
    const port = (JSON.parse(readFileSync(file, 'utf8')) as { health?: { port?: unknown } })?.health?.port;
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  } catch {
    // no bot.json yet, or not JSON: the bot refuses it at its start
  }
  return JV_PORTS.bot;
}

export interface Listener {
  pid: number;
  command: string;
}

/** The listening processes in `lsof -F pc` output: a `p<pid>` line starts one, a `c<command>` line names it. */
export function parseLsofListeners(stdout: string): Listener[] {
  const out: Listener[] = [];
  let current: Listener | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) && pid > 0 ? out.find((l) => l.pid === pid) : undefined;
      if (current === undefined && Number.isInteger(pid) && pid > 0) {
        current = { pid, command: '' };
        out.push(current);
      }
    } else if (line.startsWith('c') && current !== undefined && current.command === '') {
      current.command = line.slice(1);
    }
  }
  return out;
}

/**
 * Runs the first of `commands` that exists: the bare name (PATH), then the system places. lsof lives in /usr/sbin on
 * macOS, which the PATH of a service or a minimal shell often leaves out.
 */
async function execFirst(ctx: Ctx, commands: readonly string[], args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  let last: ExecResult = { code: null, stdout: '', stderr: '', error: 'not-found' };
  for (const command of commands) {
    last = await ctx.deps.exec(command, args, options);
    if (last.error !== 'not-found') return last;
  }
  return last;
}

export const LSOF_COMMANDS: readonly string[] = ['lsof', '/usr/sbin/lsof', '/usr/bin/lsof'];
export const LAUNCHCTL_COMMANDS: readonly string[] = ['launchctl', '/bin/launchctl'];

interface PortLine {
  name: string;
  port: number;
  /** Who should hold the port: "jv ui", "jv mcp", "jv bot". */
  owner: string;
  pidFile: string;
  fix: string;
}

function portLines(): PortLine[] {
  const config = botConfigFile();
  return [
    { name: 'ports:ui', port: JV_PORTS.ui, owner: 'jv ui', pidFile: runFile('ui.pid'), fix: 'jv ui --port <another free port>' },
    { name: 'ports:mcp', port: JV_PORTS.mcp, owner: 'jv mcp', pidFile: runFile('mcp.pid'), fix: 'jv mcp --http --port <another free port>' },
    { name: 'ports:bot', port: botHealthPort(config), owner: 'jv bot', pidFile: runFile('bot.lock'), fix: `set health.port in ${config} to another free port` },
  ];
}

async function portLine(ctx: Ctx, line: PortLine): Promise<CheckResult> {
  const { name, port } = line;
  const r = await execFirst(ctx, LSOF_COMMANDS, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc', '-w'], { timeoutMs: 15_000 });
  if (r.error === 'not-found') return warn(name, `port ${port} not checked: lsof is not on PATH, /usr/sbin or /usr/bin`, 'install lsof');
  if (r.error !== undefined) return warn(name, `port ${port} not checked: lsof ${r.error === 'timeout' ? 'did not answer' : `failed: ${firstLine(r.error)}`}`);
  const listeners = parseLsofListeners(r.stdout);
  // lsof exits 1 both when nothing matches (a free port) and on an error; with -w (no warnings) only an error
  // writes to stderr.
  if (listeners.length === 0) {
    return (r.code === 0 || r.code === 1) && r.stderr.trim() === ''
      ? ok(name, `port ${port} is free`)
      : warn(name, `port ${port} not checked: lsof failed: ${firstLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
  }
  const pid = readPidFile(line.pidFile);
  if (pid !== undefined && listeners.some((l) => l.pid === pid)) return ok(name, `port ${port}: ${line.owner} running (pid ${pid})`);
  const holder = listeners[0]!;
  return fail(name, `port ${port} is in use by ${holder.command || 'another process'} (pid ${holder.pid})`, line.fix);
}

const checkPorts: Check = async (ctx) => {
  const wanted = portLines().filter((l) => ctx.wants(l.name));
  return Promise.all(wanted.map((l) => portLine(ctx, l)));
};

/** Where `jv bot install-service` writes the bot's service file under the owner's home, or undefined (section 8). */
export function botServiceFile(platform: NodeJS.Platform, home: string): string | undefined {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${BOT_SERVICE_LABEL}.plist`);
  if (platform === 'linux') return join(home, '.config', 'systemd', 'user', 'jevellan-bot.service');
  return undefined;
}

const checkService: Check = async (ctx) => {
  const file = botServiceFile(ctx.deps.platform, ctx.deps.ownerHome);
  if (file === undefined) return [ok('service', `the bot has service files for macOS and Linux only, not ${ctx.deps.platform}; skipped`)];
  // Not installed is informational (M-020): the bot runs in the foreground without it, and loading it is the owner's step.
  return [existsSync(file) ? ok('service', `installed (${file})`) : ok('service', `not installed (no ${file}); jv bot install-service writes it`)];
};

/**
 * A launchd job's pid in `launchctl list` output ("PID<tab>Status<tab>Label" lines): a number when it runs, null
 * when it is loaded without a process ("-"), undefined when the label is not listed.
 */
export function launchdJobPid(stdout: string, label: string): number | null | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[2] !== label) continue;
    const pid = Number(cols[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return undefined;
}

/** Informational only: whether Jevellan's member daemon runs here. jv reads launchctl list and never acts on it. */
const checkMember: Check = async (ctx) => {
  const none = ok('member', 'no Jevellan member on this machine');
  if (ctx.deps.platform !== 'darwin') return [none];
  const r = await execFirst(ctx, LAUNCHCTL_COMMANDS, ['list'], { timeoutMs: 15_000 });
  if (r.error !== undefined || r.code !== 0) {
    return [ok('member', `no Jevellan member detected (launchctl list ${r.error === 'not-found' ? 'is not available' : 'failed'})`)];
  }
  const pid = launchdJobPid(r.stdout, MEMBER_DAEMON_LABEL);
  if (pid === undefined) return [none];
  if (pid === null) return [ok('member', `Jevellan member loaded but not running (${MEMBER_DAEMON_LABEL}); jv leaves it alone`)];
  return [ok('member', `Jevellan member running (pid ${pid}); jv leaves it alone`)];
};

/** Every check group, in the order jv doctor prints them. */
export const CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ['node', checkNode],
  ['git', checkGit],
  ['tmux', checkTmux],
  ['claude', checkClaude],
  ['models', checkModels],
  ['codex', checkCodex],
  ['providers', checkProviders],
  ['keys', checkKeys],
  ['logins', checkLogins],
  ['jev', checkJev],
  ['store', checkStore],
  ['memory', checkMemory],
  ['disk', checkDisk],
  ['hook', checkHook],
  ['skills', checkSkills],
  ['skill-copies', checkSkillCopies],
  ['model-descriptions', checkModelDescriptions],
  ['ports', checkPorts],
  ['service', checkService],
  ['member', checkMember],
];

export const CHECK_NAMES: readonly string[] = CHECKS.map(([n]) => n);

/**
 * Group of a result-level name: key:<p> -> keys, login:<p> -> logins, skill-copies:<x> -> skill-copies,
 * skills:checkout -> skills, ports:ui -> ports.
 */
function groupOf(name: string): string {
  const prefix = name.split(':')[0]!;
  if (prefix === 'key') return 'keys';
  if (prefix === 'login') return 'logins';
  return prefix;  // models:<p> -> models
}

/**
 * Runs the named checks (all when `names` is empty or omitted). A name is a group ("jev", "logins", "keys", "skills",
 * "ports", "memory", "service", "member") or one result ("login:claude-main", "key:glm", "ports:ui"). Results come
 * back in the order of CHECKS.
 */
export async function runChecks(names: readonly string[] = [], overrides: Partial<DoctorDeps> = {}): Promise<CheckResult[]> {
  const deps: DoctorDeps = { ...defaultDeps(), ...overrides };
  const unknown = names.filter((n) => !CHECK_NAMES.includes(groupOf(n)));
  if (unknown.length) throw new Error(`unknown doctor check: ${unknown.join(', ')} (known: ${CHECK_NAMES.join(', ')})`);
  const groups = new Set(names.map(groupOf));
  const exact = new Set(names.filter((n) => n.includes(':')));
  const wholeGroups = new Set(names.filter((n) => !n.includes(':')));

  let cached: ProvidersConfig | { error: string } | undefined;
  const wants = (r: string) => names.length === 0 || wholeGroups.has(groupOf(r)) || exact.has(r) || !r.includes(':');
  const ctx: Ctx = {
    deps,
    wants,
    providers() {
      if (!cached) {
        try {
          cached = loadProviders();
        } catch (error) {
          cached = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      return cached;
    },
  };
  const selected = CHECKS.filter(([n]) => names.length === 0 || groups.has(n));
  const results = await Promise.all(
    selected.map(async ([group, check]) => {
      try {
        return await check(ctx);
      } catch (error) {
        return [fail(group, `the check failed: ${firstLine(error instanceof Error ? error.message : String(error))}`)];
      }
    }),
  );
  return results.flat().filter((r) => wants(r.name));
}

/** One line per check: STATUS name: detail - fix: ... */
export function formatCheck(r: CheckResult): string {
  return `${r.status.padEnd(4)} ${r.name}: ${r.detail}${r.fix && r.status !== 'OK' ? ` - fix: ${r.fix}` : ''}`;
}


