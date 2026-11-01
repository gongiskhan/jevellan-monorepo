// Tests of scripts/sync-from-skills.mjs with a temporary jevellan-skills repository (two commits: the lift and a
// later one) and a temporary monorepo tree laid out the way the lift left this repository (M-008).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';

const { formatReport, liftedCommit, main, runtimeHomes, syncReport, RUNTIME_DIR, SOURCE_JSON } = await import('../sync-from-skills.mjs');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = mkdtempSync(join(realpathSync(tmpdir()), 'jv-sync-skills-test-'));
after(() => rmSync(base, { recursive: true, force: true }));

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}
function runtime(files) {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [`${RUNTIME_DIR}/${name}`, text]));
}
function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const skills = join(base, 'jevellan-skills');
const monorepo = join(base, 'monorepo');
let lifted = '';
let head = '';

before(() => {
  mkdirSync(skills);
  git(skills, 'init', '-q', '-b', 'main');
  const longText = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n');
  write(skills, {
    'README.md': 'skills\n',
    '.apm/skills/jevellan-router/SKILL.md': 'router\n',
    '.apm/skills/jevellan-landing/SKILL.md': 'landing\n',
    '.apm/skills/someone-else/SKILL.md': 'not ours\n',
    '.apm/agents/jevellan-coordinator.agent.md': 'agent\n',
    ...runtime({
      'package.json': '{"name":"jv"}\n',
      'bin/bootstrap.mjs': 'bootstrap\n',
      'src/store.ts': 'store\n',
      'src/cli.ts': 'cli\n',
      'src/commands/task.ts': 'task command\n',
      'src/doctor.ts': 'doctor\n',
      'src/ui/server.ts': 'viewer server\n',
      'src/old.ts': 'old\n',
      'src/gone.ts': `${longText}\n`,
      'test/store.test.ts': 'store test\n',
      'test/launcher.test.ts': 'launcher test\n',
      'test/fixtures/run-fixture.ts': 'fixture\n',
      'templates/project.json': '{}\n',
      'ui/app.js': 'app\n',
    }),
  });
  git(skills, 'add', '-A');
  git(skills, 'commit', '-q', '-m', 'the lifted commit');
  lifted = git(skills, 'rev-parse', 'HEAD');

  write(monorepo, {
    [SOURCE_JSON]: `${JSON.stringify({ repository: 'https://example.invalid/jevellan-skills', commit: lifted }, null, 2)}\n`,
    'packages/core/src/store.ts': 'store\n',
    'packages/core/src/doctor.ts': 'doctor\n',
    'packages/core/src/old.ts': 'old\n',
    'packages/core/src/gone.ts': 'gone\n',
    'packages/core/src/bootstrap.ts': 'bootstrap\n',
    'packages/core/templates/project.json': '{}\n',
    'packages/core/test/store.test.ts': 'store test\n',
    'packages/core/test/launcher.test.ts': 'launcher test\n',
    'packages/core/test/fixtures/run-fixture.ts': 'fixture\n',
    'packages/cli/src/cli.ts': 'cli\n',
    'packages/cli/src/commands/task.ts': 'task command\n',
    'packages/cli/src/commands/doctor.ts': 'doctor shim\n',
    'packages/cli/test/fixtures/run-fixture.ts': 'fixture\n',
    'packages/cli/test/tail-report.test.ts': 'tail report\n',
    'packages/ui/server/server.ts': 'viewer server\n',
    'packages/ui/viewer/app.js': 'app\n',
    'packages/core/test/fixtures/skills/jevellan-router/SKILL.md': 'router\n',
    'packages/core/test/fixtures/skills/agents/jevellan-coordinator.agent.md': 'agent\n',
  });
});

test('nothing changed since the lifted commit', () => {
  const report = syncReport({ skills, monorepo });
  assert.equal(report.lifted, lifted);
  assert.equal(report.head, lifted);
  assert.equal(report.commits, 0);
  assert.deepEqual([report.runtime, report.skillFiles], [[], []]);
  assert.deepEqual(formatReport(report), [`nothing changed since ${lifted.slice(0, 7)}`]);
  const result = run(['--skills', skills, '--monorepo', monorepo]);
  assert.equal(result.code, 0);
  assert.equal(result.out, `nothing changed since ${lifted.slice(0, 7)}`);
});

test('every changed file is listed with where it lives in the monorepo', () => {
  const longText = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join('\n');
  write(skills, {
    'README.md': 'skills, changed outside the runtime\n',
    '.apm/skills/jevellan-router/SKILL.md': 'router, changed\n',
    '.apm/skills/someone-else/SKILL.md': 'not ours, changed\n',
    '.apm/agents/jevellan-coordinator.agent.md': 'agent, changed\n',
    ...runtime({
      'src/store.ts': 'store\nmore\n',
      'src/commands/task.ts': 'task command, changed\n',
      'src/commands/memory.ts': 'a new command\n',
      'src/doctor.ts': 'doctor, changed\n',
      'src/ui/server.ts': 'viewer server, changed\n',
      'src/fresh.ts': 'a new module\n',
      'src/moved.ts': `${longText}\n`,
      'test/launcher.test.ts': 'launcher test, changed\n',
      'test/fixtures/run-fixture.ts': 'fixture, changed\n',
      'test/memory.test.ts': 'a new command test\n',
      'test/fresh.test.ts': 'a new core test\n',
      'templates/project.json': '{"a":1}\n',
      'ui/app.js': 'app, changed\n',
      'bin/bootstrap.mjs': 'bootstrap, changed\n',
      'package.json': '{"name":"jv","version":"2"}\n',
    }),
  });
  rmSync(join(skills, RUNTIME_DIR, 'src/old.ts'));
  rmSync(join(skills, RUNTIME_DIR, 'src/gone.ts'));
  git(skills, 'add', '-A');
  git(skills, 'commit', '-q', '-m', 'later work on the skills side');
  head = git(skills, 'rev-parse', 'HEAD');

  const report = syncReport({ skills, monorepo });
  assert.equal(report.head, head);
  assert.equal(report.commits, 1);
  assert.equal(report.descends, true);
  const byPath = Object.fromEntries(report.runtime.map((f) => [f.path, f]));
  const homes = (path) => byPath[path].homes.map((h) => `${h.path}${h.exists ? '' : ' (missing)'}${h.note ? ` [${h.note}]` : ''}`);

  assert.deepEqual(Object.keys(byPath).sort(), [
    'bin/bootstrap.mjs', 'package.json', 'src/commands/memory.ts', 'src/commands/task.ts', 'src/doctor.ts', 'src/fresh.ts',
    'src/moved.ts', 'src/old.ts', 'src/store.ts', 'src/ui/server.ts', 'templates/project.json', 'test/fixtures/run-fixture.ts',
    'test/fresh.test.ts', 'test/launcher.test.ts', 'test/memory.test.ts', 'ui/app.js',
  ]);
  assert.deepEqual([byPath['src/store.ts'].status, byPath['src/store.ts'].added, byPath['src/store.ts'].deleted], ['M', 1, 0]);
  assert.deepEqual(homes('src/store.ts'), ['packages/core/src/store.ts']);
  assert.deepEqual(homes('src/commands/task.ts'), ['packages/cli/src/commands/task.ts']);
  assert.deepEqual(homes('src/commands/memory.ts'), ['packages/cli/src/commands/memory.ts (missing)']);
  assert.equal(byPath['src/commands/memory.ts'].status, 'A');
  assert.deepEqual(homes('src/doctor.ts'), ['packages/core/src/doctor.ts', 'packages/cli/src/commands/doctor.ts [its command shim]']);
  assert.deepEqual(homes('src/ui/server.ts'), ['packages/ui/server/server.ts']);
  assert.deepEqual(homes('src/fresh.ts'), ['packages/core/src/fresh.ts (missing)']);
  assert.equal(byPath['src/old.ts'].status, 'D');
  assert.deepEqual(homes('src/old.ts'), ['packages/core/src/old.ts']);
  assert.equal(byPath['src/moved.ts'].status, 'R');
  assert.equal(byPath['src/moved.ts'].from, 'src/gone.ts');
  assert.deepEqual(homes('src/moved.ts'), ['packages/core/src/gone.ts'], 'a renamed file lives here under its old name');
  assert.equal(byPath['src/moved.ts'].moveTo, 'packages/core/src/moved.ts');
  assert.deepEqual(homes('test/launcher.test.ts'), ['packages/core/test/launcher.test.ts', 'packages/cli/test/tail-report.test.ts [its jv tail and jv report tests]']);
  assert.deepEqual(homes('test/fixtures/run-fixture.ts'), ['packages/core/test/fixtures/run-fixture.ts', 'packages/cli/test/fixtures/run-fixture.ts']);
  assert.deepEqual(homes('test/memory.test.ts'), ['packages/cli/test/memory.test.ts (missing)'], 'a new command test goes with the command layer');
  assert.deepEqual(homes('test/fresh.test.ts'), ['packages/core/test/fresh.test.ts (missing)']);
  assert.deepEqual(homes('templates/project.json'), ['packages/core/templates/project.json']);
  assert.deepEqual(homes('ui/app.js'), ['packages/ui/viewer/app.js']);
  assert.deepEqual(homes('bin/bootstrap.mjs'), ['packages/core/src/bootstrap.ts [rewritten in TypeScript, M-007]']);
  assert.equal(homes('package.json')[0], 'packages/core/package.json (missing) [runtime dependencies]');

  const skillsByPath = Object.fromEntries(report.skillFiles.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(skillsByPath).sort(), [
    '.apm/agents/jevellan-coordinator.agent.md', '.apm/skills/jevellan-router/SKILL.md', '.apm/skills/someone-else/SKILL.md',
  ], 'README.md and the runtime are not skill files');
  assert.deepEqual(skillsByPath['.apm/skills/jevellan-router/SKILL.md'].homes, [
    { path: 'packages/core/test/fixtures/skills/jevellan-router/SKILL.md', exists: true },
  ]);
  assert.deepEqual(skillsByPath['.apm/agents/jevellan-coordinator.agent.md'].homes[0].path, 'packages/core/test/fixtures/skills/agents/jevellan-coordinator.agent.md');
  assert.equal(skillsByPath['.apm/skills/someone-else/SKILL.md'].homes[0].note, 'not copied into the fixture');

  const text = formatReport(report);
  assert.equal(text[0], `jevellan-skills ${lifted.slice(0, 7)}..${head.slice(0, 7)} (1 commit) at ${realpathSync(skills)}`);
  assert.ok(text.includes('  changed  src/store.ts +1 -0  -> packages/core/src/store.ts'), text.join('\n'));
  assert.ok(text.includes('  added    src/commands/memory.ts +1 -0  -> new on the skills side, packages/cli/src/commands/memory.ts (not here yet)'));
  assert.ok(text.some((line) => line.startsWith('  renamed  src/moved.ts (was src/gone.ts)') && line.endsWith('-> packages/core/src/gone.ts; moves to packages/core/src/moved.ts')), text.join('\n'));
  assert.ok(text.some((line) => line.startsWith('skill files changed since the lift')));
  assert.match(text.at(-1), /^19 files changed, \+\d+ -\d+$/);

  const result = run(['--skills', skills, '--monorepo', monorepo]);
  assert.equal(result.code, 0);
  assert.equal(result.out, text.join('\n'));
  const json = JSON.parse(run(['--skills', skills, '--monorepo', monorepo, '--json']).out);
  assert.equal(json.lifted, lifted);
  assert.equal(json.runtime.length, 16);
});

test('--lifted overrides SOURCE.json', () => {
  const report = syncReport({ skills, monorepo, lifted: head });
  assert.deepEqual([report.runtime, report.skillFiles], [[], []]);
  assert.equal(run(['--skills', skills, '--monorepo', monorepo, '--lifted', head.slice(0, 9)]).out, `nothing changed since ${head.slice(0, 7)}`);
});

test('a missing checkout, an unknown commit or a missing SOURCE.json exits 2', () => {
  const missing = run(['--skills', join(base, 'nowhere'), '--monorepo', monorepo]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no jevellan-skills checkout/);
  const unknown = run(['--skills', skills, '--monorepo', monorepo, '--lifted', 'deadbeefdeadbeef']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /the lifted commit deadbeefdeadbeef is not in/);
  const noSource = run(['--skills', skills, '--monorepo', join(base, 'empty-monorepo')]);
  assert.equal(noSource.code, 2);
  assert.match(noSource.err, /SOURCE\.json is missing/);
  assert.equal(run(['--skills']).code, 2);
  assert.equal(run(['--frobnicate']).code, 2);
  assert.deepEqual(JSON.parse(run(['--json', '--skills', join(base, 'nowhere')]).out).error.includes('no jevellan-skills checkout'), true);
});

test('this repository records the lifted commit, and maps the lifted files where they are', () => {
  assert.match(liftedCommit(repoRoot), /^[0-9a-f]{40}$/);
  for (const rel of ['src/store.ts', 'src/cli.ts', 'src/commands/task.ts', 'src/ui/server.ts', 'templates/worker-rules.md', 'ui/app.js', 'test/store.test.ts']) {
    assert.equal(runtimeHomes(rel, repoRoot)[0].exists, true, rel);
  }
});
