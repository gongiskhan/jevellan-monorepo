// The skills fixture (brief section 11, M-001): test/fixtures/skills/ is a copy of the fourteen jevellan-* skills of
// gongiskhan/jevellan-skills at the commit SOURCE.json names (the router without scripts/, D-010), plus the
// coordinator agent file and the Stop hook file. The unit tests read it instead of ~/.jv/skills, so it must agree
// with that commit byte for byte, in both directions, and is refreshed on purpose, never by accident:
//
//   fixture <skill>/<path>   is   <commit>:.apm/skills/<skill>/<path>
//   fixture agents/<path>    is   <commit>:.apm/agents/<path>
//   fixture hooks/<path>     is   <commit>:.apm/hooks/<path>
//
// The clone is ~/dev/jevellan-skills (JV_SKILLS_CHECKOUT overrides it). It is only read (git show, git ls-tree): never
// fetched, pulled or checked out. When it is missing, or does not have the commit, the test is skipped with the
// reason, so the suite still runs on a machine without the clone.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-skills-fixture-test-'));
process.env.JV_HOME = home;
const { RUNTIME_ROOT } = await import('../src/paths.js');
after(() => rmSync(home, { recursive: true, force: true }));

const FIXTURE = join(RUNTIME_ROOT, 'test', 'fixtures', 'skills');
const source = JSON.parse(readFileSync(join(FIXTURE, 'SOURCE.json'), 'utf8')) as { repository: string; commit: string };
const clone = process.env.JV_SKILLS_CHECKOUT?.trim() || join(homedir(), 'dev', 'jevellan-skills');

function git(args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', clone, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function whySkip(): string | false {
  if (!existsSync(clone)) return `no jevellan-skills clone at ${clone} (set JV_SKILLS_CHECKOUT to one)`;
  try {
    git(['cat-file', '-e', `${source.commit}^{commit}`]);
  } catch {
    return `the clone at ${clone} does not have commit ${source.commit}`;
  }
  return false;
}
const skip = whySkip();

function fixtureFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...fixtureFiles(path));
    else out.push(relative(FIXTURE, path).split(sep).join('/'));
  }
  return out;
}

/** The path at the commit of a fixture file (relative, with / separators); undefined for SOURCE.json. */
function sourcePath(file: string): string | undefined {
  if (file === 'SOURCE.json') return undefined;
  if (file.startsWith('agents/') || file.startsWith('hooks/')) return `.apm/${file}`;
  return `.apm/skills/${file}`;
}

/** The fixture path of a file at the commit, or undefined when the fixture does not copy it. */
function fixturePath(path: string): string | undefined {
  if (path.startsWith('.apm/agents/') || path.startsWith('.apm/hooks/')) return path.slice('.apm/'.length);
  const m = /^\.apm\/skills\/(jevellan-[^/]+)\/(.+)$/.exec(path);
  if (!m) return undefined;
  if (m[1] === 'jevellan-router' && m[2]!.startsWith('scripts/')) return undefined; // the runtime itself (D-010)
  return `${m[1]}/${m[2]}`;
}

test('SOURCE.json names a full commit of jevellan-skills', () => {
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  assert.equal(source.repository, 'https://github.com/gongiskhan/jevellan-skills');
});

test('every fixture file is the file at the commit, byte for byte', { skip }, () => {
  const files = fixtureFiles(FIXTURE);
  assert.ok(files.length > 100, `only ${files.length} fixture files`);
  for (const file of files) {
    const path = sourcePath(file);
    if (path === undefined) continue;
    let atCommit: Buffer;
    try {
      atCommit = git(['show', `${source.commit}:${path}`]);
    } catch {
      assert.fail(`fixture ${file} has no ${path} at ${source.commit.slice(0, 7)}; refresh the fixture from the commit`);
    }
    assert.ok(readFileSync(join(FIXTURE, file)).equals(atCommit), `fixture ${file} differs from ${path} at ${source.commit.slice(0, 7)}`);
  }
});

test('every file of the skills, the agent and the hook at the commit is in the fixture', { skip }, () => {
  const listed = git(['ls-tree', '-r', '--name-only', source.commit, '--', '.apm/skills', '.apm/agents', '.apm/hooks'])
    .toString('utf8')
    .split('\n')
    .filter((l) => l !== '');
  const expected = listed.map(fixturePath).filter((p): p is string => p !== undefined);
  const skills = new Set(expected.filter((p) => !p.startsWith('agents/') && !p.startsWith('hooks/')).map((p) => p.split('/')[0]));
  assert.equal(skills.size, 14, `the commit has ${skills.size} jevellan-* skills: ${[...skills].join(', ')}`);
  const have = new Set(fixtureFiles(FIXTURE));
  const missing = expected.filter((p) => !have.has(p));
  assert.deepEqual(missing, [], 'files at the commit that the fixture lacks');
  const extra = [...have].filter((p) => p !== 'SOURCE.json' && !expected.includes(p));
  assert.deepEqual(extra, [], 'fixture files that the commit does not have');
  assert.ok(![...have].some((p) => p.startsWith('jevellan-router/scripts/')), 'the router is copied without scripts/');
});
