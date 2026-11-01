// What changed in jevellan-skills since the lift, and where each changed file lives in this repository now (brief
// section 15, point 1). It compares the skills checkout's current HEAD with the lifted commit that
// packages/core/test/fixtures/skills/SOURCE.json records (M-001), for the runtime under
// .apm/skills/jevellan-router/scripts/jv (src/, test/, templates/, ui/, bin/, package.json) and for the skills that
// packages/core/test/fixtures/skills copies (section 11), and prints one line per changed file with its home here.
// Read-only: it runs git rev-parse, merge-base, rev-list and diff in the skills checkout and reads files only.
// The owner lands what it lists as one task on this repository.
//
//   node scripts/sync-from-skills.mjs [--skills PATH] [--lifted COMMIT] [--monorepo PATH] [--json]
//
// --skills defaults to ~/dev/jevellan-skills, --lifted to SOURCE.json's commit, --monorepo to this checkout. Exit 0
// when it could compare (changes or not), 2 when it could not (no checkout, unknown commit, no SOURCE.json).
//
// Where the lift put each file (M-008): src/cli.ts, src/command.ts and src/commands/* in packages/cli/src;
// src/ui/* in packages/ui/server; every other src file in packages/core/src (the run(args, io) shims of doctor.ts
// and project.ts in packages/cli/src/commands); ui/* in packages/ui/viewer; templates/* in packages/core/templates;
// test files in packages/core|cli|ui/test, wherever a file of that name is now (the fixtures are in each);
// bin/bootstrap.mjs became packages/core/src/bootstrap.ts (M-007) and bin/jv.mjs the root bin/jv.mjs with
// packages/cli/src/bin.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNTIME_DIR = '.apm/skills/jevellan-router/scripts/jv';
export const RUNTIME_PATHS = ['src', 'test', 'templates', 'ui', 'bin', 'package.json'];
export const SKILL_PATHS = ['.apm/skills', '.apm/agents/jevellan-coordinator.agent.md', '.apm/hooks/jevellan.json'];
export const SOURCE_JSON = 'packages/core/test/fixtures/skills/SOURCE.json';
const FIXTURE_DIR = 'packages/core/test/fixtures/skills';
const DEFAULT_MONOREPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_PACKAGES = ['core', 'cli', 'ui'];

// Test files the lift split: part of the suite moved to the command layer's tests.
const SPLITS = {
  'test/launcher.test.ts': [{ path: 'packages/cli/test/tail-report.test.ts', note: 'its jv tail and jv report tests' }],
  'test/ui.test.ts': [{ path: 'packages/cli/test/ui-command.test.ts', note: 'its jv ui command test' }],
};
// Core modules whose `run(args, io)` command shim moved to the command layer.
const SHIMS = {
  'src/doctor.ts': 'packages/cli/src/commands/doctor.ts',
  'src/project.ts': 'packages/cli/src/commands/project.ts',
};

class SyncError extends Error {}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim().split('\n')[0];
    throw new SyncError(`git ${args[0]} failed in ${cwd}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

/** The lifted commit recorded in the monorepo's skills fixture. */
export function liftedCommit(monorepo) {
  const path = join(monorepo, SOURCE_JSON);
  if (!existsSync(path)) throw new SyncError(`${path} is missing; pass --lifted COMMIT`);
  const commit = JSON.parse(readFileSync(path, 'utf8')).commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) throw new SyncError(`${path} has no commit`);
  return commit;
}

function moduleHome(srcRel) {
  // srcRel is relative to the runtime's src/ folder.
  if (srcRel === 'cli.ts' || srcRel === 'command.ts' || srcRel.startsWith('commands/')) return `packages/cli/src/${srcRel}`;
  if (srcRel.startsWith('ui/')) return `packages/ui/server/${srcRel.slice(3)}`;
  return `packages/core/src/${srcRel}`;
}

/** The package a test of this name belongs to when no file of that name exists here yet. */
function testPackage(testRel, skillsSrc) {
  const base = posix.basename(testRel).replace(/\.test\.ts$/, '');
  if (base === 'cli' || (skillsSrc && existsSync(join(skillsSrc, 'commands', `${base}.ts`)))) return 'cli';
  if (base === 'ui') return 'ui';
  return 'core';
}

/**
 * Where a runtime file (relative to the runtime folder) lives in the monorepo: [{ path, exists, note? }]. The
 * first entry is its home; later ones hold part of it. skillsSrc (the runtime's src folder in the skills checkout)
 * tells a command's test from a core test when no test of that name exists here yet.
 */
export function runtimeHomes(rel, monorepo, skillsSrc = '') {
  const at = (path, note) => ({ path, exists: existsSync(join(monorepo, path)), ...(note ? { note } : {}) });
  if (rel.startsWith('src/')) {
    const homes = [at(moduleHome(rel.slice(4)))];
    if (SHIMS[rel]) homes.push(at(SHIMS[rel], 'its command shim'));
    return homes;
  }
  if (rel.startsWith('ui/')) return [at(`packages/ui/viewer/${rel.slice(3)}`)];
  if (rel.startsWith('templates/')) return [at(`packages/core/${rel}`)];
  if (rel.startsWith('test/')) {
    const found = TEST_PACKAGES.map((pkg) => at(`packages/${pkg}/${rel}`)).filter((home) => home.exists);
    const homes = found.length ? found : [at(`packages/${testPackage(rel, skillsSrc)}/${rel}`)];
    for (const split of SPLITS[rel] ?? []) homes.push(at(split.path, split.note));
    return homes;
  }
  if (rel === 'bin/bootstrap.mjs') return [at('packages/core/src/bootstrap.ts', 'rewritten in TypeScript, M-007')];
  if (rel === 'bin/jv.mjs') return [at('bin/jv.mjs'), at('packages/cli/src/bin.ts')];
  if (rel === 'package.json') {
    return [at('packages/core/package.json', 'runtime dependencies'), at('packages/cli/package.json'), at('package.json', 'dev dependencies')];
  }
  return [at(rel, 'no rule for this path; it may not have been lifted')];
}

/** Where a skills file (relative to the skills repository) is in the monorepo's skills fixture. */
export function skillHomes(rel, monorepo) {
  const at = (path, note) => ({ path, exists: existsSync(join(monorepo, path)), ...(note ? { note } : {}) });
  if (rel === '.apm/agents/jevellan-coordinator.agent.md') return [at(`${FIXTURE_DIR}/agents/jevellan-coordinator.agent.md`)];
  if (rel === '.apm/hooks/jevellan.json') return [at(`${FIXTURE_DIR}/hooks/jevellan.json`)];
  const name = rel.split('/')[2] ?? '';
  if (rel.startsWith('.apm/skills/') && name.startsWith('jevellan-')) return [at(`${FIXTURE_DIR}/${rel.slice('.apm/skills/'.length)}`)];
  return [{ path: '', exists: false, note: 'not copied into the fixture' }];
}

function parseNameStatus(output) {
  const fields = output.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      entries.push({ status: status[0], from: fields[i++], path: fields[i++] });
    } else entries.push({ status: status[0], path: fields[i++] });
  }
  return entries;
}

function parseNumstat(output) {
  const counts = new Map();
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; ) {
    const field = fields[i++];
    if (!field) continue;
    const [added, deleted, path] = field.split('\t');
    let target = path;
    if (path === '') {
      // A rename or copy: "added\tdeleted\t", then the old path and the new path as fields of their own.
      i++;
      target = fields[i++];
    }
    const count = (n) => (n === '-' ? null : Number(n));
    counts.set(target, { added: count(added), deleted: count(deleted) });
  }
  return counts;
}

function changedFiles(skills, lifted, head, pathspecs) {
  const range = [lifted, head, '--', ...pathspecs];
  const entries = parseNameStatus(git(skills, ['diff', '--name-status', '-M', '-z', ...range]));
  const counts = parseNumstat(git(skills, ['diff', '--numstat', '-M', '-z', ...range]));
  return entries.map((entry) => ({ ...entry, ...(counts.get(entry.path) ?? { added: null, deleted: null }) }));
}

/**
 * Compares the skills checkout's HEAD with the lifted commit. Returns { skills, lifted, head, commits, descends,
 * runtime: [...], skillFiles: [...] }; each file is { status, path, from?, added, deleted, homes, moveTo? }, where
 * homes says where the file (its old name for a rename) lives here and moveTo where a rename takes it.
 */
export function syncReport({ skills, monorepo = DEFAULT_MONOREPO, lifted } = {}) {
  const skillsRoot = skills ?? join(homedir(), 'dev', 'jevellan-skills');
  if (!existsSync(skillsRoot)) throw new SyncError(`no jevellan-skills checkout at ${skillsRoot}; pass --skills PATH`);
  const top = git(skillsRoot, ['rev-parse', '--show-toplevel']).trim();
  const from = lifted ?? liftedCommit(monorepo);
  const liftedFull = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { cwd: top, encoding: 'utf8' });
  if (liftedFull.status !== 0) {
    throw new SyncError(`the lifted commit ${from} is not in ${top}; fetch it (a shallow clone lacks it) or pass --lifted`);
  }
  const liftedId = liftedFull.stdout.trim();
  const head = git(top, ['rev-parse', 'HEAD']).trim();
  const descends = spawnSync('git', ['merge-base', '--is-ancestor', liftedId, head], { cwd: top }).status === 0;
  const commits = descends ? Number(git(top, ['rev-list', '--count', `${liftedId}..${head}`]).trim()) : null;
  const skillsSrc = join(top, RUNTIME_DIR, 'src');
  const rel = (p) => p.slice(RUNTIME_DIR.length + 1);
  const runtime = changedFiles(top, liftedId, head, RUNTIME_PATHS.map((p) => `${RUNTIME_DIR}/${p}`)).map((file) => {
    const path = rel(file.path);
    if (!file.from) return { ...file, path, homes: runtimeHomes(path, monorepo, skillsSrc) };
    // A rename: the file lives here under its old name; its new name says where it moves to.
    const from = rel(file.from);
    return { ...file, path, from, homes: runtimeHomes(from, monorepo, skillsSrc), moveTo: runtimeHomes(path, monorepo, skillsSrc)[0]?.path };
  });
  const skillFiles = changedFiles(top, liftedId, head, [...SKILL_PATHS, `:(exclude)${RUNTIME_DIR}`]).map((file) => {
    if (!file.from) return { ...file, homes: skillHomes(file.path, monorepo) };
    return { ...file, homes: skillHomes(file.from, monorepo), moveTo: skillHomes(file.path, monorepo)[0]?.path };
  });
  return { skills: top, lifted: liftedId, head, commits, descends, runtime, skillFiles };
}

const STATUS_WORDS = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

function fileLine(file, root) {
  const counts = file.added === null ? ' (binary)' : ` +${file.added} -${file.deleted}`;
  const was = file.from ? ` (was ${file.from})` : '';
  const [home, ...rest] = file.homes;
  const where = (h) => (h.path ? `${h.path}${h.exists ? '' : ' (not here yet)'}` : '');
  const homeText = home?.path ? `${where(home)}${home.note ? ` (${home.note})` : ''}` : home?.note ?? '';
  const extra = rest.map((h) => `; also ${where(h)}${h.note ? ` (${h.note})` : ''}`).join('');
  const move = file.moveTo && file.status === 'R' ? `; moves to ${file.moveTo}` : file.moveTo ? `; copy at ${file.moveTo}` : '';
  const label = (STATUS_WORDS[file.status] ?? file.status).padEnd(8);
  const added = file.status === 'A' ? ' new on the skills side,' : '';
  return `  ${label} ${root}${file.path}${was}${counts}  ->${added} ${homeText}${extra}${move}`;
}

/** The text the command prints for a syncReport() result. */
export function formatReport(report) {
  const short = report.lifted.slice(0, 7);
  if (!report.runtime.length && !report.skillFiles.length) return [`nothing changed since ${short}`];
  const lines = [];
  const span = report.descends
    ? `${report.commits} commit${report.commits === 1 ? '' : 's'}`
    : `HEAD does not descend from ${short}; compared the two trees`;
  lines.push(`jevellan-skills ${short}..${report.head.slice(0, 7)} (${span}) at ${report.skills}`);
  if (report.runtime.length) {
    lines.push(`runtime files changed since the lift (${RUNTIME_DIR}/), and where each lives here:`);
    for (const file of report.runtime) lines.push(fileLine(file, ''));
  } else lines.push(`runtime: nothing changed since ${short}`);
  if (report.skillFiles.length) {
    lines.push(`skill files changed since the lift; the copy in ${FIXTURE_DIR} (and SOURCE.json) needs a refresh:`);
    for (const file of report.skillFiles) lines.push(fileLine(file, ''));
  }
  const all = [...report.runtime, ...report.skillFiles];
  const added = all.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = all.reduce((n, f) => n + (f.deleted ?? 0), 0);
  lines.push(`${all.length} file${all.length === 1 ? '' : 's'} changed, +${added} -${deleted}`);
  return lines;
}

function usage() {
  return 'usage: node scripts/sync-from-skills.mjs [--skills PATH] [--lifted COMMIT] [--monorepo PATH] [--json]';
}

/** The command: returns the exit code and writes its lines through out and err. */
export function main(argv, { out = console.log, err = console.error } = {}) {
  const options = {};
  let json = false;
  const valueOf = (flag, value) => {
    if (!value || value.startsWith('--')) throw new SyncError(`${flag} needs a value`);
    return value;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json') json = true;
      else if (arg === '--skills') options.skills = valueOf(arg, argv[++i]);
      else if (arg === '--lifted') options.lifted = valueOf(arg, argv[++i]);
      else if (arg === '--monorepo') options.monorepo = valueOf(arg, argv[++i]);
      else if (arg === '--help' || arg === '-h') {
        out(usage());
        return 0;
      } else throw new SyncError(`unknown argument ${arg}\n${usage()}`);
    }
    const report = syncReport(options);
    if (json) out(JSON.stringify(report, null, 2));
    else for (const line of formatReport(report)) out(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) out(JSON.stringify({ error: message }));
    else err(`sync-from-skills: ${message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
