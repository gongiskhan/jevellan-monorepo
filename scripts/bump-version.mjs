// Sets one version on every package of this repository: `node scripts/bump-version.mjs <version>` writes it to the
// root package.json, to every packages/*/package.json and to every dependency one workspace package has on another
// (dependencies, devDependencies, peerDependencies, optionalDependencies), as an exact version, never a range. It
// updates package-lock.json's workspace entries the same way, so `npm ci` keeps working without a fresh install.
// `--check` changes nothing and exits 1, naming each difference, when any of those versions is not the root's (or
// the one given). `--root PATH` points it at another checkout (the tests use it). Exit 2 on a bad argument.
//
// Brief section 2: one version for every package (0.1.0 at the end of the first run), exact versions, no ranges.
// The version jv prints is jevellan-core's package.json version (packages/core/src/version.ts), so nothing else
// carries it.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  const text = readFileSync(path, 'utf8');
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  return { data: JSON.parse(text), indent, newline: text.endsWith('\n') ? '\n' : '' };
}

function writeJson(path, { data, indent, newline }) {
  writeFileSync(path, `${JSON.stringify(data, null, indent)}${newline}`);
}

/** The workspace package folders, relative to the root: packages/* folders that hold a package.json. */
export function workspaceDirs(root) {
  const packages = join(root, 'packages');
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packages, entry.name, 'package.json')))
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

/** The manifests a version lives in: the root first, then every workspace package. */
export function manifests(root) {
  return [{ dir: '', path: join(root, 'package.json') }, ...workspaceDirs(root).map((dir) => ({ dir, path: join(root, dir, 'package.json') }))];
}

/**
 * Every place a version is written, as { file, where, actual }: each manifest's own version, each dependency on a
 * workspace package, and the same in package-lock.json when it exists.
 */
export function versionSlots(root) {
  const loaded = manifests(root).map((m) => ({ ...m, json: readJson(m.path) }));
  const names = new Set(loaded.filter((m) => m.dir).map((m) => m.json.data.name).filter(Boolean));
  const slots = [];
  const collect = (file, where, pkg) => {
    slots.push({ file, where: `${where} version`, actual: pkg?.version });
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
        if (names.has(name)) slots.push({ file, where: `${where} ${field}.${name}`, actual: spec });
      }
    }
  };
  for (const m of loaded) collect(m.dir ? `${m.dir}/package.json` : 'package.json', m.json.data.name ?? m.dir, m.json.data);
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath).data;
    slots.push({ file: 'package-lock.json', where: 'lock version', actual: lock.version });
    for (const m of loaded) {
      const entry = lock.packages?.[m.dir];
      if (entry) collect('package-lock.json', `lock packages["${m.dir}"]`, entry);
      else slots.push({ file: 'package-lock.json', where: `lock packages["${m.dir}"] version`, actual: undefined });
    }
  }
  return { names: [...names].sort(), slots };
}

/** The differences from one version (the root's when none is given): [] when every slot holds it. */
export function checkVersions(root, expected) {
  const { slots } = versionSlots(root);
  const want = expected ?? slots[0]?.actual;
  return slots.filter((slot) => slot.actual !== want).map((slot) => ({ ...slot, expected: want }));
}

/** Writes version into every slot of versionSlots(root); returns the files it changed. */
export function bumpVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`bump-version: "${version}" is not an exact version (for example 0.2.0)`);
  const loaded = manifests(root).map((m) => ({ ...m, json: readJson(m.path) }));
  const names = new Set(loaded.filter((m) => m.dir).map((m) => m.json.data.name).filter(Boolean));
  const setAll = (pkg) => {
    let changed = false;
    if (pkg.version !== version) {
      pkg.version = version;
      changed = true;
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (names.has(name) && pkg[field][name] !== version) {
          pkg[field][name] = version;
          changed = true;
        }
      }
    }
    return changed;
  };
  const changedFiles = [];
  for (const m of loaded) {
    if (setAll(m.json.data)) {
      writeJson(m.path, m.json);
      changedFiles.push(m.dir ? `${m.dir}/package.json` : 'package.json');
    }
  }
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = readJson(lockPath);
    let changed = false;
    if (lock.data.version !== version) {
      lock.data.version = version;
      changed = true;
    }
    for (const m of loaded) {
      const entry = lock.data.packages?.[m.dir];
      if (entry && setAll(entry)) changed = true;
    }
    if (changed) {
      writeJson(lockPath, lock);
      changedFiles.push('package-lock.json');
    }
  }
  return changedFiles;
}

function usage() {
  return 'usage: node scripts/bump-version.mjs <version> [--root PATH] | --check [<version>] [--root PATH]';
}

/** The command: returns the exit code and writes its lines through out and err. */
export function main(argv, { out = console.log, err = console.error } = {}) {
  const refuse = (message) => {
    err(`bump-version: ${message}\n${usage()}`);
    return 2;
  };
  let root = DEFAULT_ROOT;
  let check = false;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--root') {
      root = argv[++i];
      if (!root) return refuse('--root needs a folder');
    } else if (arg === '--help' || arg === '-h') {
      out(usage());
      return 0;
    } else if (arg.startsWith('-')) return refuse(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) return refuse('one version at most');
  if (!check && positional.length !== 1) return refuse('the version to set is missing');
  const version = positional[0];
  if (version !== undefined && !SEMVER.test(version)) return refuse(`"${version}" is not an exact version (for example 0.2.0)`);
  if (!existsSync(join(root, 'package.json'))) return refuse(`no package.json in ${root}`);
  try {
    if (check) {
      const differences = checkVersions(root, version);
      for (const d of differences) {
        err(`bump-version: ${d.file}: ${d.where} is ${d.actual ?? '(missing)'}, expected ${d.expected}`);
      }
      if (differences.length) return 1;
      out(`Every package is at ${version ?? versionSlots(root).slots[0]?.actual}.`);
      return 0;
    }
    const changed = bumpVersion(root, version);
    out(changed.length ? `Set ${version} in ${changed.join(', ')}.` : `Every package is already at ${version}.`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : 'bump-version: failed');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
