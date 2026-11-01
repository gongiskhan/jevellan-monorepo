// Tests of scripts/bump-version.mjs on temporary repository trees (no git needed): one exact version in the root,
// every packages/* manifest, every cross-workspace dependency and package-lock.json's workspace entries.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { bumpVersion, checkVersions, main, workspaceDirs } = await import('../bump-version.mjs');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = mkdtempSync(join(realpathSync(tmpdir()), 'jv-bump-version-test-'));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
function writeJson(path, data, indent = 2) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function tree(version = '0.1.0') {
  const root = join(base, `tree-${++count}`);
  writeJson(join(root, 'package.json'), { name: 'mono', version, private: true, workspaces: ['packages/*'], devDependencies: { typescript: '5.9.3' } });
  writeJson(join(root, 'packages/core/package.json'), { name: 'pkg-core', version, dependencies: { zod: '4.6.7' } });
  writeJson(
    join(root, 'packages/cli/package.json'),
    { name: 'pkg-cli', version, dependencies: { 'pkg-core': version, zod: '4.6.7' }, devDependencies: { 'pkg-ui': version }, peerDependencies: { 'pkg-core': version } },
    4,
  );
  writeJson(join(root, 'packages/ui/package.json'), { name: 'pkg-ui', version, optionalDependencies: { 'pkg-core': version } });
  mkdirSync(join(root, 'packages/empty'), { recursive: true }); // a folder a later phase fills: no package.json yet
  writeJson(join(root, 'package-lock.json'), {
    name: 'mono',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'mono', version, workspaces: ['packages/*'], devDependencies: { typescript: '5.9.3' } },
      'node_modules/pkg-core': { resolved: 'packages/core', link: true },
      'node_modules/zod': { version: '4.6.7', resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz' },
      'packages/cli': { name: 'pkg-cli', version, dependencies: { 'pkg-core': version, zod: '4.6.7' }, devDependencies: { 'pkg-ui': version }, peerDependencies: { 'pkg-core': version } },
      'packages/core': { name: 'pkg-core', version, dependencies: { zod: '4.6.7' } },
      'packages/ui': { name: 'pkg-ui', version, optionalDependencies: { 'pkg-core': version } },
    },
  });
  return root;
}
function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('workspace folders are the packages/* folders that hold a package.json', () => {
  assert.deepEqual(workspaceDirs(tree()), ['packages/cli', 'packages/core', 'packages/ui']);
});

test('one version everywhere: manifests, cross-workspace dependencies and the lock file', () => {
  const root = tree();
  const changed = bumpVersion(root, '0.2.0');
  assert.deepEqual(changed, ['package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/ui/package.json', 'package-lock.json']);
  assert.equal(readJson(join(root, 'package.json')).version, '0.2.0');
  const cli = readJson(join(root, 'packages/cli/package.json'));
  assert.equal(cli.version, '0.2.0');
  assert.deepEqual(cli.dependencies, { 'pkg-core': '0.2.0', zod: '4.6.7' });
  assert.deepEqual(cli.devDependencies, { 'pkg-ui': '0.2.0' });
  assert.deepEqual(cli.peerDependencies, { 'pkg-core': '0.2.0' });
  assert.deepEqual(readJson(join(root, 'packages/ui/package.json')).optionalDependencies, { 'pkg-core': '0.2.0' });
  assert.deepEqual(readJson(join(root, 'package.json')).devDependencies, { typescript: '5.9.3' }, 'third-party versions stay');
  const lock = readJson(join(root, 'package-lock.json'));
  assert.equal(lock.version, '0.2.0');
  assert.equal(lock.packages[''].version, '0.2.0');
  assert.equal(lock.packages['packages/core'].version, '0.2.0');
  assert.deepEqual(lock.packages['packages/cli'].dependencies, { 'pkg-core': '0.2.0', zod: '4.6.7' });
  assert.deepEqual(lock.packages['node_modules/zod'], { version: '4.6.7', resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz' });
  assert.deepEqual(checkVersions(root), []);
  assert.deepEqual(bumpVersion(root, '0.2.0'), [], 'a second run changes nothing');
});

test('each file keeps its indentation and final newline', () => {
  const root = tree();
  bumpVersion(root, '1.0.0-rc.1');
  const cli = readFileSync(join(root, 'packages/cli/package.json'), 'utf8');
  assert.match(cli, /^\{\n {4}"name": "pkg-cli",\n {4}"version": "1\.0\.0-rc\.1",/);
  assert.ok(cli.endsWith('}\n'));
  assert.match(readFileSync(join(root, 'packages/core/package.json'), 'utf8'), /^\{\n {2}"name"/);
});

test('--check exits 1 naming each difference, and 0 when every version agrees', () => {
  const root = tree();
  assert.equal(run(['--check', '--root', root]).code, 0);
  const ui = join(root, 'packages/ui/package.json');
  writeJson(ui, { name: 'pkg-ui', version: '0.1.1', optionalDependencies: { 'pkg-core': '^0.1.0' } });
  const differences = checkVersions(root);
  assert.deepEqual(
    differences.map((d) => `${d.file} ${d.where} ${d.actual}`),
    ['packages/ui/package.json pkg-ui version 0.1.1', 'packages/ui/package.json pkg-ui optionalDependencies.pkg-core ^0.1.0'],
  );
  const result = run(['--check', '--root', root]);
  assert.equal(result.code, 1);
  assert.match(result.err, /packages\/ui\/package\.json: pkg-ui version is 0\.1\.1, expected 0\.1\.0/);
  assert.match(result.err, /optionalDependencies\.pkg-core is \^0\.1\.0, expected 0\.1\.0/);
  const wanted = run(['--check', '0.3.0', '--root', tree()]);
  assert.equal(wanted.code, 1, 'a version given to --check is the one every slot must hold');
  assert.equal(run(['0.1.0', '--root', root]).code, 0);
  assert.equal(run(['--check', '--root', root]).code, 0);
});

test('--check names a workspace the lock file does not know yet', () => {
  const root = tree();
  writeJson(join(root, 'packages/bot/package.json'), { name: 'pkg-bot', version: '0.1.0' });
  const result = run(['--check', '--root', root]);
  assert.equal(result.code, 1);
  assert.match(result.err, /package-lock\.json: lock packages\["packages\/bot"\] version is \(missing\)/);
});

test('a tree without package-lock.json is fine', () => {
  const root = tree();
  rmSync(join(root, 'package-lock.json'));
  assert.deepEqual(bumpVersion(root, '0.4.0').includes('package-lock.json'), false);
  assert.deepEqual(checkVersions(root), []);
});

test('a bad argument exits 2 and writes nothing', () => {
  const root = tree();
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  for (const argv of [['1.2', '--root', root], ['^1.2.0', '--root', root], ['--root', root], ['1.0.0', '2.0.0', '--root', root], ['--bogus'], ['1.0.0', '--root', join(root, 'missing')]]) {
    assert.equal(run(argv).code, 2, argv.join(' '));
  }
  assert.throws(() => bumpVersion(root, 'v1.0.0'), /not an exact version/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before);
});

test('every package of this repository has one version', () => {
  assert.deepEqual(checkVersions(repoRoot), []);
});
