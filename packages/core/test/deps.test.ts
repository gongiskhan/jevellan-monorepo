// Dependency direction (brief section 2): read every packages/*/package.json of the repository and check that core
// and memory depend on nothing in the repository; scheduler, planner and improver only on core and memory, mcp also on
// scheduler, planner and improver (M-019: its tools call them); bot
// on those and scheduler, planner, improver; ui on everything but bot and cli; cli on everything. A package lists only
// what it imports and imports only what it lists: its source (src/, server/, web/) is scanned for jevellan-*
// specifiers (static, re-export and dynamic imports) and they must be exactly its jevellan-* dependencies. A repository
// dependency names the repository's one version, and every third-party version is exact (no ranges). Packages the
// brief names that do not exist yet are skipped; a folder the table does not know fails until it is added here.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-deps-test-'));
process.env.JV_HOME = home;
const { RUNTIME_ROOT } = await import('../src/paths.js');
after(() => rmSync(home, { recursive: true, force: true }));

/** The repository packages each package may depend on (by folder name), from section 2. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  core: [],
  memory: [],
  scheduler: ['core', 'memory'],
  planner: ['core', 'memory'],
  improver: ['core', 'memory'],
  // M-019: every tool of section 5 is a thin call into core, memory, scheduler, planner or improver.
  mcp: ['core', 'memory', 'scheduler', 'planner', 'improver'],
  bot: ['core', 'memory', 'scheduler', 'planner', 'improver'],
  ui: ['core', 'memory', 'scheduler', 'planner', 'improver', 'mcp'],
  cli: ['core', 'memory', 'scheduler', 'planner', 'improver', 'mcp', 'ui', 'bot'],
};

const SOURCE_DIRS = ['src', 'server', 'web'];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-test', '.vite']);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const packagesDir = resolve(RUNTIME_ROOT, '..');
const repositoryRoot = resolve(packagesDir, '..');

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
}

const present = new Map<string, PackageJson>(
  readdirSync(packagesDir)
    .filter((d) => existsSync(join(packagesDir, d, 'package.json')))
    .sort()
    .map((d) => [d, readJson(join(packagesDir, d, 'package.json'))]),
);

const repoNames = new Map([...Object.keys(ALLOWED)].map((d) => [`jevellan-${d}`, d]));

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Code without its comments (a header comment may quote an import). */
function withoutComments(text: string): string {
  // Line comments first: one may hold a glob such as docs/** that would otherwise open a block comment.
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](jevellan-[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

/** The repository packages a package's source imports, by package name, with one file that imports each. */
function importedPackages(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(packagesDir, folder, dir))) {
      for (const m of withoutComments(readFileSync(file, 'utf8')).matchAll(SPECIFIER)) {
        if (!found.has(m[1]!)) found.set(m[1]!, file.slice(packagesDir.length + 1));
      }
    }
  }
  return found;
}

function repositoryDependencies(pkg: PackageJson, field: (typeof DEPENDENCY_FIELDS)[number]): string[] {
  return Object.keys(pkg[field] ?? {}).filter((name) => name.startsWith('jevellan-'));
}

test('the packages folder is the repository root packages/, and core is in it', () => {
  assert.ok(existsSync(join(repositoryRoot, 'package.json')), `no root package.json at ${repositoryRoot}`);
  assert.equal(present.get('core')?.name, 'jevellan-core');
});

test('every package folder is in the dependency table and named jevellan-<folder>', () => {
  for (const [folder, pkg] of present) {
    assert.ok(folder in ALLOWED, `packages/${folder} is not in the dependency table of brief section 2; add it to ALLOWED in this test`);
    assert.equal(pkg.name, `jevellan-${folder}`, `packages/${folder}/package.json`);
  }
});

describe('dependency direction (brief section 2)', () => {
  for (const folder of Object.keys(ALLOWED)) {
    const pkg = present.get(folder);
    const name = `jevellan-${folder}`;
    const allowed = ALLOWED[folder]!.map((d) => `jevellan-${d}`);
    test(`${name} depends on ${allowed.length ? allowed.join(', ') : 'nothing in the repository'} at most`, { skip: pkg ? false : `packages/${folder} does not exist yet` }, () => {
      for (const field of DEPENDENCY_FIELDS) {
        for (const dep of repositoryDependencies(pkg!, field)) {
          assert.ok(repoNames.has(dep), `${name} ${field} names ${dep}, which is not a package of this repository`);
          assert.ok(allowed.includes(dep), `${name} must not depend on ${dep} (${field}); it may depend on ${allowed.join(', ') || 'nothing in the repository'}`);
        }
      }
    });
    test(`${name} lists exactly the repository packages its source imports`, { skip: pkg ? false : `packages/${folder} does not exist yet` }, () => {
      const imported = importedPackages(folder);
      imported.delete(name); // a self-reference is not a dependency
      const listed = repositoryDependencies(pkg!, 'dependencies').sort();
      for (const [dep, file] of imported) {
        assert.ok(listed.includes(dep), `${file} imports ${dep}, which packages/${folder}/package.json does not list in dependencies`);
      }
      for (const dep of listed) assert.ok(imported.has(dep), `packages/${folder}/package.json lists ${dep}, which nothing under ${SOURCE_DIRS.join('/, ')}/ imports`);
    });
  }
});

describe('versions', () => {
  test('a repository dependency names that package\'s version', () => {
    for (const [folder, pkg] of present) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const dep of repositoryDependencies(pkg, field)) {
          const target = present.get(repoNames.get(dep) ?? '');
          assert.ok(target, `${pkg.name} ${field} names ${dep}, which does not exist in packages/`);
          assert.equal(pkg[field]![dep], target.version, `packages/${folder} ${field}.${dep}`);
        }
      }
    }
  });

  test('every third-party dependency of every package and of the root is an exact version', () => {
    const manifests: Array<[string, PackageJson]> = [['package.json', readJson(join(repositoryRoot, 'package.json'))]];
    for (const [folder, pkg] of present) manifests.push([`packages/${folder}/package.json`, pkg]);
    for (const [file, pkg] of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dep, version] of Object.entries(pkg[field] ?? {})) {
          if (dep.startsWith('jevellan-')) continue;
          assert.match(version, EXACT_VERSION, `${file} ${field}.${dep} is "${version}"; pin an exact version (no ^, ~ or ranges)`);
        }
      }
    }
  });
});

describe('the scanner', () => {
  test('finds static, re-export, side-effect and dynamic imports, and ignores comments', () => {
    const code = [
      "// import { x } from 'jevellan-bot'",
      '/* from "jevellan-mcp" */',
      "import { openStore } from 'jevellan-core/store';",
      "export { brief } from 'jevellan-memory';",
      "import 'jevellan-scheduler/register';",
      "const ui = await import('jevellan-ui/server');",
      "const s = 'jevellan-planner is a name, not an import';",
    ].join('\n');
    const names = [...withoutComments(code).matchAll(SPECIFIER)].map((m) => m[1]);
    assert.deepEqual(names, ['jevellan-core', 'jevellan-memory', 'jevellan-scheduler', 'jevellan-ui']);
  });
});
