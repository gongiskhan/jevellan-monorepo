// jv bootstrap and jv update (M-007: the checkout is the install), through the built CLI of this checkout against
// temporary JV_HOMEs and a temporary skills checkout made from jevellan-core's skills fixture. Every child gets
// JV_HOME, so the real ~/.jv is never touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { RUNTIME_ROOT } = await import('jevellan-core/paths');

const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'jv-bootstrap-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

const checkout = resolve(RUNTIME_ROOT, '..', '..');
const cliEntry = join(checkout, 'packages', 'cli', 'dist', 'bin.js');
const rootEntry = join(checkout, 'bin', 'jv.mjs');

// A skills checkout: the fixture's skills under .apm/skills, its agent and hook under .apm/agents and .apm/hooks, and
// a stand-in for the router's scripts/ (the skills repository's runtime), which must never be installed (D-010).
const fixture = join(RUNTIME_ROOT, 'test', 'fixtures', 'skills');
const skillsCheckout = join(root, 'jevellan-skills');
for (const name of readdirSync(fixture)) {
  if (!name.startsWith('jevellan-')) continue;
  cpSync(join(fixture, name), join(skillsCheckout, '.apm', 'skills', name), { recursive: true });
}
cpSync(join(fixture, 'agents'), join(skillsCheckout, '.apm', 'agents'), { recursive: true });
cpSync(join(fixture, 'hooks'), join(skillsCheckout, '.apm', 'hooks'), { recursive: true });
mkdirSync(join(skillsCheckout, '.apm', 'skills', 'jevellan-router', 'scripts', 'jv'), { recursive: true });
writeFileSync(join(skillsCheckout, '.apm', 'skills', 'jevellan-router', 'scripts', 'jv', 'package.json'), '{}\n');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function env(jvHome: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, JV_HOME: jvHome };
  delete e.JV_SESSION;
  delete e.JV_CLI_ENTRY;
  return e;
}

function jv(jvHome: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', rootEntry, ...args], { env: env(jvHome), encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function home(name: string): string {
  return join(root, name);
}

describe('jv bootstrap', () => {
  const h = home('first');

  test('a first bootstrap links the runtime to this checkout, installs the skills, writes the shim, install.json and the store', () => {
    const r = jv(h, 'bootstrap', '--skills', skillsCheckout, '--json');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { install: Record<string, unknown>; skillNames: string[]; skillsCopied: boolean; storeOpened: boolean };
    assert.equal(out.skillsCopied, true);
    assert.equal(out.storeOpened, true);
    assert.equal(out.skillNames.length, 14);

    assert.ok(lstatSync(join(h, 'runtime')).isSymbolicLink());
    assert.equal(realpathSync(join(h, 'runtime')), realpathSync(join(checkout, 'packages', 'core')));
    assert.ok(existsSync(join(h, 'runtime', 'dist', 'report-guard.mjs')), 'the D-008 hook path resolves through the link');
    assert.ok(lstatSync(join(h, 'skills')).isSymbolicLink());
    assert.ok(readlinkSync(join(h, 'skills')).includes(join('skill-sets', '0.1.0-')));
    assert.ok(existsSync(join(h, 'skills', 'jevellan-router', 'SKILL.md')));
    assert.ok(!existsSync(join(h, 'skills', 'jevellan-router', 'scripts')), 'the router is installed without scripts/ (D-010)');

    const shim = readFileSync(join(h, 'bin', 'jv'), 'utf8');
    assert.match(shim, /^#!\/bin\/sh\n/);
    assert.ok(shim.includes(`exec ${process.execPath} --disable-warning=ExperimentalWarning ${cliEntry} "$@"`));
    assert.equal(statSync(join(h, 'bin', 'jv')).mode & 0o777, 0o755);
    assert.equal(statSync(h).mode & 0o777, 0o700);
    assert.equal(statSync(join(h, 'secrets')).mode & 0o777, 0o700);

    const install = JSON.parse(readFileSync(join(h, 'install.json'), 'utf8')) as Record<string, string>;
    assert.equal(install.checkout, checkout);
    assert.equal(install.cliEntry, cliEntry);
    assert.equal(install.nodePath, process.execPath);
    assert.equal(install.skillsSource, skillsCheckout);
    assert.equal(install.skillsVersion, '0.1.0');
    assert.match(install.skillsHash!, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(join(h, 'store.sqlite')));
    assert.ok(existsSync(join(h, 'providers.json')), 'providers.json from the template');
    assert.ok(existsSync(join(h, 'agents', 'jevellan-coordinator.agent.md')));
    const settings = readFileSync(join(h, 'homes', 'claude-main', '.claude', 'settings.json'), 'utf8');
    assert.ok(settings.includes(`${process.execPath} --disable-warning=ExperimentalWarning ${join(h, 'runtime', 'dist', 'report-guard.mjs')}`));
  });

  test('the shim runs this checkout with the recorded Node, and a JV_HOME set by the caller wins (D-024)', () => {
    const r = spawnSync(join(h, 'bin', 'jv'), ['--version'], { env: { ...env(h), JV_HOME: '' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^jevellan 0\.1\.0 \(store schema \d+, skills 0\.1\.0\)$/m);
    const other = home('other');
    mkdirSync(other, { recursive: true });
    const o = spawnSync(join(h, 'bin', 'jv'), ['--version', '--json'], { env: env(other), encoding: 'utf8' });
    assert.equal(o.status, 0, o.stderr);
    assert.equal((JSON.parse(o.stdout) as { store: string }).store, join(other, 'store.sqlite'));
  });

  test('a rerun with unchanged skills copies nothing; jv update never opens the store', () => {
    const before = readdirSync(join(h, 'skill-sets'));
    const r = jv(h, 'bootstrap', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { skillsCopied: boolean }).skillsCopied, false);
    assert.deepEqual(readdirSync(join(h, 'skill-sets')), before);

    const u = home('update-only');
    assert.equal(jv(u, 'bootstrap', '--skills', skillsCheckout).status, 0);
    rmSync(join(u, 'store.sqlite'));
    for (const f of ['store.sqlite-wal', 'store.sqlite-shm']) rmSync(join(u, f), { force: true });
    const up = jv(u, 'update', '--json');
    assert.equal(up.status, 0, up.stderr);
    assert.equal((JSON.parse(up.stdout) as { storeOpened: boolean }).storeOpened, false);
    assert.ok(!existsSync(join(u, 'store.sqlite')), 'jv update never touches the store');
  });

  test('changed skills get a new skill set; the current and the previous stay, older ones are archived, never deleted', () => {
    const router = join(skillsCheckout, '.apm', 'skills', 'jevellan-router', 'SKILL.md');
    const original = readFileSync(router, 'utf8');
    try {
      for (const n of [1, 2]) {
        writeFileSync(router, `${original}\n<!-- change ${n} -->\n`);
        const r = jv(h, 'update', '--json');
        assert.equal(r.status, 0, r.stderr);
        assert.equal((JSON.parse(r.stdout) as { skillsCopied: boolean }).skillsCopied, true);
      }
    } finally {
      writeFileSync(router, original);
    }
    assert.equal(readdirSync(join(h, 'skill-sets')).length, 2);
    assert.equal(readdirSync(join(h, 'archive', 'skill-sets')).length, 1);
    assert.match(readFileSync(join(h, 'skills', 'jevellan-router', 'SKILL.md'), 'utf8'), /change 2/);
  });

  test('a runtime folder of another install is moved to the archive, never deleted', () => {
    const o = home('legacy');
    mkdirSync(join(o, 'runtime', 'dist'), { recursive: true });
    writeFileSync(join(o, 'runtime', 'dist', 'cli.js'), '// the skills repository\'s runtime\n');
    const r = jv(o, 'bootstrap', '--skills', skillsCheckout, '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(lstatSync(join(o, 'runtime')).isSymbolicLink());
    const archived = readdirSync(join(o, 'archive', 'runtimes'));
    assert.equal(archived.length, 1);
    assert.ok(existsSync(join(o, 'archive', 'runtimes', archived[0]!, 'dist', 'cli.js')));
  });

  test('a folder that is not a jevellan-skills checkout is refused with exit 2', () => {
    const r = jv(home('refused'), 'bootstrap', '--skills', join(root, 'nothing-here'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a jevellan-skills checkout/);
  });

  test('a stale lock (its pid is gone) is taken over', () => {
    const s = home('stale');
    mkdirSync(s, { recursive: true });
    writeFileSync(join(s, 'bootstrap.lock'), '999999\n');
    const r = jv(s, 'bootstrap', '--skills', skillsCheckout);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /taking over the bootstrap lock/);
    assert.ok(!existsSync(join(s, 'bootstrap.lock')));
  });
});

test('this file runs from the checkout it tests', () => {
  assert.ok(fileURLToPath(import.meta.url).startsWith(join(checkout, 'packages', 'cli')));
});
