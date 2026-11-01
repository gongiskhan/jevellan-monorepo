// jv bootstrap and jv update: installs this checkout as the jv of a JV_HOME (M-007: the checkout is the install).
//
// 1. One bootstrap at a time ($JV_HOME/bootstrap.lock, O_EXCL with the pid; a lock whose pid is gone is taken over).
// 2. The folders of section 1 (the home and secrets mode 700).
// 3. $JV_HOME/runtime becomes a symlink to <checkout>/packages/core, switched with one rename(2), so the paths
//    D-008, D-016 and the APM hook name ($JV_HOME/runtime/dist/report-guard.mjs, dist/report-mcp.js, dist/evals.js)
//    keep resolving. A real folder or another link there (the skills repository's own install, D-021) is moved to
//    $JV_HOME/archive/runtimes/ first, never deleted.
// 4. The fourteen jevellan-* skill folders of a jevellan-skills checkout (`.apm/skills/`, the router without
//    scripts/, D-010) are copied into a fresh $JV_HOME/skill-sets/<id>/ and $JV_HOME/skills switches to it the same
//    way (D-021's skill sets are kept); an unchanged skills tree is not copied again. Sets other than the current and
//    the previous move to $JV_HOME/archive/skill-sets/.
// 5. The shim $JV_HOME/bin/jv runs the Node binary of this bootstrap with --disable-warning=ExperimentalWarning on
//    <checkout>/packages/cli/dist/bin.js (D-001), keeping a JV_HOME the caller set (D-024).
// 6. seed() (providers.json from the template when missing, provider homes, seeds.json, the Stop hook, the skills
//    and the coordinator agent in every Claude home, the .jv links; D-002, D-008, D-009, D-015, D-016).
// 7. install.json records the checkout, the CLI entry, the Node binary and the skills (source, commit, jv-version,
//    tree hash); jvEntry() and bootstrapNode() read it.
// `jv update` is the same from the recorded checkout and skills source, and never opens the store. Nothing here
// prints: the command layer prints the returned summary.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { refused } from './errors.js';
import { paths, realpathAsFarAsExists, RUNTIME_ROOT } from './paths.js';
import { seed, type SeedSummary } from './seeds.js';
import { packageVersion } from './version.js';

const MIN_MAJOR = 22;
const MIN_MINOR = 13;
const SKILL_PREFIX = 'jevellan-';
const ROUTER_SKILL = 'jevellan-router';
const LOCK_FILE = 'bootstrap.lock';

export interface BootstrapOptions {
  /** A jevellan-skills checkout (the folder holding .apm/). Default: install.json's, else ~/dev/jevellan-skills. */
  skills?: string;
  /** The Node binary the shim and every detached jv process run. Default: install.json's (update), else this one. */
  node?: string;
  /** jv update: reuse the recorded checkout, skills source and Node, and never open the store. */
  update?: boolean;
  /** How long to wait for another bootstrap's lock, in ms (default 300 000). */
  lockWaitMs?: number;
  log?: (line: string) => void;
}

export interface InstallRecord {
  version: string;
  checkout: string;
  cliEntry: string;
  core: string;
  nodePath: string;
  skillsSource: string;
  skillsCommit: string | null;
  skillsVersion: string | null;
  skillsHash: string;
  skills: string;
  at: string;
}

export interface BootstrapSummary {
  jvHome: string;
  install: InstallRecord;
  shim: string;
  runtimeLink: string;
  skillsLink: string;
  skillNames: string[];
  skillsCopied: boolean;
  archived: string[];
  seed: SeedSummary;
  storeOpened: boolean;
  pathLine: string;
  onPath: boolean;
}

/** The checkout this jevellan-core belongs to: <checkout>/packages/core. */
export function checkoutRoot(): string {
  return resolve(RUNTIME_ROOT, '..', '..');
}

/** The CLI entry of this checkout. */
export function checkoutCliEntry(root: string = checkoutRoot()): string {
  return join(root, 'packages', 'cli', 'dist', 'bin.js');
}

export function readInstall(file: string = paths.installFile): Partial<InstallRecord> | undefined {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<InstallRecord>) : undefined;
  } catch {
    return undefined;
  }
}

function nodeVersionOf(node: string): string {
  if (resolve(node) === resolve(process.execPath)) return process.versions.node;
  try {
    return execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    throw refused(`cannot run ${node} to read its version`);
  }
}

function recentEnough(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major! > MIN_MAJOR || (major === MIN_MAJOR && minor! >= MIN_MINOR);
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function shQuote(s: string): string {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireLock(jvHome: string, waitMs: number, log: (l: string) => void): Promise<() => void> {
  const file = join(jvHome, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = Number(readFileSync(file, 'utf8').trim());
    if (!Number.isInteger(holder) || holder <= 0 || !pidAlive(holder)) {
      log(`taking over the bootstrap lock of pid ${String(holder)}, which is gone`);
      try {
        unlinkSync(file);
      } catch {
        // someone else took it over first
      }
      continue;
    }
    if (Date.now() > deadline) throw refused(`another jv bootstrap is running (pid ${holder}); try again when it ends`);
    if (!told) {
      log(`waiting for the jv bootstrap of pid ${holder}`);
      told = true;
    }
    await sleep(200);
  }
}

function linkTarget(link: string): string | undefined {
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    return resolve(dirname(link), readlinkSync(link));
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Moves whatever is at `path` to archive/<kind>/<name>-<time>; returns where it went. */
function archiveAside(jvHome: string, path: string, kind: string): string {
  const dir = join(jvHome, 'archive', kind);
  mkdirSync(dir, { recursive: true });
  let dest = join(dir, `${relative(jvHome, path).replace(/[/\\]/g, '-')}-${stamp()}`);
  if (exists(dest)) dest = `${dest}-${process.pid}`;
  renameSync(path, dest);
  return dest;
}

/** Points `link` at `target` with one rename(2). Returns what was moved aside (paths), if anything. */
function switchLink(jvHome: string, link: string, target: string, kind: string, keepLinks: boolean): string[] {
  const moved: string[] = [];
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st && !st.isSymbolicLink()) {
    if (st.isDirectory() && readdirSync(link).length === 0) rmSync(link, { recursive: false, force: true });
    else moved.push(archiveAside(jvHome, link, kind));
  } else if (st && !keepLinks) {
    const current = linkTarget(link);
    // A link into another install (the skills repository's runtimes/<id>) is replaced; its folder stays where it is.
    if (current !== undefined && resolve(current) !== resolve(target)) moved.push(`${link} -> ${current} (link replaced)`);
  }
  const tmp = `${link}.link-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // none left over
  }
  symlinkSync(target, tmp);
  renameSync(tmp, link);
  return moved;
}

// ---- the skills -------------------------------------------------------------------------------------------

/** The jevellan-* skill folders of a skills folder (.apm/skills of a checkout, or an installed skill set). */
export function skillNames(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(SKILL_PREFIX))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function skillFilter(name: string, skillDir: string): (src: string) => boolean {
  // The router's scripts/ is the skills repository's own copy of the runtime; it is never installed (D-010).
  const scripts = join(skillDir, 'scripts');
  return (src) => !(name === ROUTER_SKILL && (src === scripts || src.startsWith(`${scripts}/`))) && !/(^|\/)(node_modules|dist|dist-test)(\/|$)/.test(src.slice(skillDir.length));
}

function hashTree(hash: ReturnType<typeof createHash>, root: string, rel: string, keep: (p: string) => boolean): void {
  const abs = join(root, rel);
  if (!keep(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const n of readdirSync(abs).sort()) hashTree(hash, root, rel === '' ? n : `${rel}/${n}`, keep);
    return;
  }
  hash.update(`${rel}\0`);
  hash.update(readFileSync(abs));
  hash.update('\0');
}

/**
 * A hash of the jevellan-* skill folders under `skillsDir` (the router without scripts/), the same for a checkout's
 * `.apm/skills` and for an installed skill set holding the same files. jv doctor compares the two with it.
 */
export function skillsTreeHash(skillsDir: string): string {
  const hash = createHash('sha256');
  for (const name of skillNames(skillsDir)) {
    const dir = join(skillsDir, name);
    hashTree(hash, skillsDir, name, skillFilter(name, dir));
  }
  return hash.digest('hex');
}

/** The jv-version frontmatter of a SKILL.md, or null. */
export function skillJvVersion(skillFile: string): string | null {
  try {
    const text = readFileSync(skillFile, 'utf8');
    const front = text.startsWith('---\n') ? text.slice(4, text.indexOf('\n---', 4)) : '';
    const m = /^jv-version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(front);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function gitCommit(dir: string): string | null {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Resolves a skills checkout argument to its .apm/skills folder; refuses anything that is not one. */
export function skillsSourceDir(checkout: string): string {
  const dir = join(checkout, '.apm', 'skills');
  if (!existsSync(join(dir, ROUTER_SKILL, 'SKILL.md'))) {
    throw refused(`${checkout} is not a jevellan-skills checkout (no .apm/skills/${ROUTER_SKILL}/SKILL.md); pass --skills <path to a checkout of gongiskhan/jevellan-skills>`);
  }
  return dir;
}

function defaultSkillsCheckout(): string | undefined {
  const guess = join(homedir(), 'dev', 'jevellan-skills');
  return existsSync(join(guess, '.apm', 'skills', ROUTER_SKILL, 'SKILL.md')) ? guess : undefined;
}

function archiveOldSkillSets(jvHome: string, current: string, previous: string | undefined): string[] {
  const dir = join(jvHome, 'skill-sets');
  const keep = new Set([current, previous].filter((p): p is string => p !== undefined).map((p) => resolve(p)));
  const moved: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (keep.has(resolve(p))) continue;
    if (name.endsWith('.partial')) {
      // A copy that failed part way: jv's own output, never used.
      rmSync(p, { recursive: true, force: true });
      continue;
    }
    if (!lstatSync(p).isDirectory()) continue;
    moved.push(archiveAside(jvHome, p, 'skill-sets'));
  }
  return moved;
}

// ---- the shim ---------------------------------------------------------------------------------------------

export function shimText(jvHome: string, node: string, cliEntry: string): string {
  // ${JV_HOME:-} keeps a JV_HOME the caller set (D-024); the default is quoted outside the expansion.
  return [
    '#!/bin/sh',
    '# Written by jv bootstrap: runs this checkout\'s jv with the Node binary it was installed with (D-001, M-007).',
    '# A JV_HOME set by the caller wins over the home this shim was installed in (D-024).',
    'JV_HOME="${JV_HOME:-}"',
    `[ -n "$JV_HOME" ] || JV_HOME=${shQuote(jvHome)}`,
    'export JV_HOME',
    `exec ${shQuote(node)} --disable-warning=ExperimentalWarning ${shQuote(cliEntry)} "$@"`,
    '',
  ].join('\n');
}

// ---- bootstrap --------------------------------------------------------------------------------------------

export async function bootstrap(options: BootstrapOptions = {}): Promise<BootstrapSummary> {
  const log = options.log ?? (() => {});
  const jvHome = paths.home;
  const installed = readInstall();
  const node = resolve(options.node ?? (options.update && installed?.nodePath && existsSync(installed.nodePath) ? installed.nodePath : process.execPath));
  const nodeVersion = nodeVersionOf(node);
  if (!recentEnough(nodeVersion)) {
    throw refused(`Node ${nodeVersion} (${node}) is too old; jv needs Node 22.13 or later (node:sqlite); pass --node <a Node 22 binary>`);
  }

  const checkout = checkoutRoot();
  const cliEntry = checkoutCliEntry(checkout);
  if (!existsSync(cliEntry)) throw refused(`${cliEntry} is missing: run npm ci && npm run build in ${checkout} first`);
  const coreDir = join(checkout, 'packages', 'core');

  const skillsArg = options.skills ?? (options.update ? installed?.skillsSource : undefined) ?? installed?.skillsSource ?? defaultSkillsCheckout();
  if (skillsArg === undefined) {
    throw refused('no jevellan-skills checkout: pass --skills <path to a checkout of gongiskhan/jevellan-skills> (~/dev/jevellan-skills is the default when it exists)');
  }
  const skillsSource = realpathAsFarAsExists(resolve(skillsArg));
  const sourceSkillsDir = skillsSourceDir(skillsSource);

  for (const d of [jvHome, paths.secretsDir]) {
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o700);
  }
  for (const d of [paths.binDir, join(jvHome, 'skill-sets'), paths.homesDir, paths.projectsDir, paths.worktreesDir, paths.logsDir, paths.archiveDir, join(jvHome, 'run')]) {
    mkdirSync(d, { recursive: true });
  }

  const release = await acquireLock(jvHome, options.lockWaitMs ?? 300_000, log);
  try {
    const archived: string[] = [];

    // The runtime link: $JV_HOME/runtime -> <checkout>/packages/core.
    const runtimeLink = paths.runtimeDir;
    if (linkTarget(runtimeLink) === undefined || realpathAsFarAsExists(linkTarget(runtimeLink)!) !== realpathAsFarAsExists(coreDir)) {
      archived.push(...switchLink(jvHome, runtimeLink, coreDir, 'runtimes', false));
      log(`linked ${runtimeLink} -> ${coreDir}`);
    }

    // The skills: a fresh skill set when the tree changed.
    const skillsLink = paths.skillsDir;
    const hash = skillsTreeHash(sourceSkillsDir);
    const currentSet = linkTarget(skillsLink);
    const unchanged = currentSet !== undefined && existsSync(join(currentSet, ROUTER_SKILL, 'SKILL.md')) && skillsTreeHash(currentSet) === hash;
    let skillsCopied = false;
    if (!unchanged) {
      const version = skillJvVersion(join(sourceSkillsDir, ROUTER_SKILL, 'SKILL.md')) ?? '0.0.0';
      const id = `${version}-${hash.slice(0, 8)}-${stamp()}`;
      const partial = join(jvHome, 'skill-sets', `${id}.partial`);
      mkdirSync(partial, { recursive: true });
      for (const name of skillNames(sourceSkillsDir)) {
        const from = join(sourceSkillsDir, name);
        cpSync(from, join(partial, name), { recursive: true, force: true, filter: skillFilter(name, from) });
      }
      const setDir = join(jvHome, 'skill-sets', id);
      renameSync(partial, setDir);
      archived.push(...switchLink(jvHome, skillsLink, setDir, 'skill-sets', true));
      archived.push(...archiveOldSkillSets(jvHome, setDir, currentSet));
      skillsCopied = true;
      log(`installed ${skillNames(setDir).length} skills into ${setDir}`);
    } else {
      log('the skills are unchanged; nothing copied');
    }

    // The shim.
    const shim = paths.shim;
    writeAtomic(shim, shimText(jvHome, node, cliEntry), 0o755);
    log(`wrote ${shim}`);

    const previousAt = installed?.at;
    const install: InstallRecord = {
      version: packageVersion(),
      checkout,
      cliEntry,
      core: coreDir,
      nodePath: node,
      skillsSource,
      skillsCommit: gitCommit(skillsSource),
      skillsVersion: skillJvVersion(join(skillsLink, ROUTER_SKILL, 'SKILL.md')),
      skillsHash: hash,
      skills: relative(jvHome, realpathSync(skillsLink)),
      at: skillsCopied || previousAt === undefined ? new Date().toISOString() : previousAt,
    };
    writeAtomic(paths.installFile, `${JSON.stringify(install, null, 2)}\n`, 0o600);

    // Provider homes, providers.json, seeds, hooks, skills and agents in the homes.
    const seeded = await seed({ jvHome, runtimeDir: coreDir, skillsDir: skillsLink, sourceSkillsDir, nodePath: node, log });

    let storeOpened = false;
    if (!options.update) {
      const { openStore } = await import('./store.js');
      openStore().close();
      storeOpened = true;
    }

    const onPath = (process.env.PATH ?? '').split(delimiter).some((p) => p !== '' && realpathAsFarAsExists(resolve(p)) === realpathAsFarAsExists(paths.binDir));
    return {
      jvHome,
      install,
      shim,
      runtimeLink,
      skillsLink,
      skillNames: skillNames(skillsLink),
      skillsCopied,
      archived,
      seed: seeded,
      storeOpened,
      pathLine: `export PATH="${paths.binDir}:$PATH"`,
      onPath,
    };
  } finally {
    release();
  }
}
