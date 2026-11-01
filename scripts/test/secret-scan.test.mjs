// Tests of scripts/secret-scan.mjs against temporary git repositories. Every token-shaped value is assembled at run
// time from parts, so this file itself holds no secret shape and the scan of this repository stays clean.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Temporary repositories must not read the machine's git configuration (signing, hooks, credential helpers).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';

const { main, scanBytes, scanFiles, scanHistory, shapesIn, valuesFrom } = await import('../secret-scan.mjs');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = mkdtempSync(join(realpathSync(tmpdir()), 'jv-secret-scan-test-'));
after(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function repo(files = {}) {
  const dir = join(base, `repo-${++count}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  if (Object.keys(files).length) git(dir, 'add', '-A');
  return dir;
}
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}
function run(argv, cwd) {
  const out = [];
  const err = [];
  const code = main(argv, { cwd, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// One made-up value per shape, joined from parts at run time.
const fakes = {
  'Anthropic or OpenAI key shape': ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-'),
  'GitHub token shape': `gh${'p_'}${'A1'.repeat(18)}`,
  'GitHub fine-grained token shape': `github${'_pat_'}${'B2'.repeat(15)}`,
  'Jevellan token shape': `jv${'a_'}abc.${'C'.repeat(43)}`,
  'npm token shape': `np${'m_'}${'d4'.repeat(18)}`,
  'AWS access key shape': `AK${'IA'}${'EXAMPLE0EXAMPLE0'}`,
  'Google API key shape': `AI${'za'}${'e'.repeat(35)}`,
  'Slack token shape': `xo${'xb-'}1234567890-abcdef`,
  'private key block': ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' '),
  'JWT shape': ['ey' + 'J' + 'f'.repeat(16), 'g'.repeat(16), 'h'.repeat(16)].join('.'),
};

test('every shape is found, and the made-up values of the repository tests are not', () => {
  for (const [label, value] of Object.entries(fakes)) {
    assert.deepEqual(shapesIn(`const x = '${value}';`), [label], label);
  }
  for (const value of ['fake-oauth-token-ABCDEF0123456789', 'fake-codex-refresh-token-bbbbbbbbbbb', 'sk-short', 'task-ant-1']) {
    assert.deepEqual(shapesIn(value), [], value);
  }
  assert.deepEqual(shapesIn(['-----BEGIN', 'PUBLIC', 'KEY-----'].join(' ')), []);
  assert.deepEqual(shapesIn(['-----BEGIN', 'ENCRYPTED', 'PRIVATE', 'KEY-----'].join(' ')), ['private key block']);
});

test('a clean repository passes with exit 0', () => {
  const dir = repo({ 'README.md': 'nothing secret\n', 'src/a.ts': "export const token = 'fake-oauth-token-ABCDEF0123456789';\n" });
  assert.deepEqual(scanFiles(dir), []);
  const result = run([], dir);
  assert.equal(result.code, 0);
  assert.equal(result.out, 'Secret scan passed.');
});

test('a tracked secret fails with exit 1 naming the file and line, never the value', () => {
  const value = fakes['Anthropic or OpenAI key shape'];
  const dir = repo({ 'ok.txt': 'fine\n', 'src/config.ts': `// line 1\n// line 2\nexport const key = '${value}';\n` });
  assert.deepEqual(scanFiles(dir), [{ file: 'src/config.ts', line: 3, reason: 'Anthropic or OpenAI key shape' }]);
  const result = run([], dir);
  assert.equal(result.code, 1);
  assert.match(result.err, /^secret-scan: src\/config\.ts:3: Anthropic or OpenAI key shape$/m);
  assert.ok(!result.err.includes(value) && !result.out.includes(value));
  assert.ok(!result.err.includes(value.slice(0, 20)));
});

test('from a subfolder it scans the whole repository', () => {
  const dir = repo({ 'deep/inner/x.txt': `${fakes['GitHub token shape']}\n`, 'sub/y.txt': 'clean\n' });
  const result = run([], join(dir, 'sub'));
  assert.equal(result.code, 1);
  assert.match(result.err, /deep\/inner\/x\.txt:1: GitHub token shape/);
});

test('untracked files count only with --untracked, and ignored files never', () => {
  const dir = repo({ '.gitignore': 'ignored.txt\n', 'tracked.txt': 'clean\n' });
  write(dir, { 'loose.txt': `${fakes['private key block']}\n`, 'ignored.txt': `${fakes['npm token shape']}\n` });
  assert.deepEqual(scanFiles(dir), []);
  assert.deepEqual(scanFiles(dir, { untracked: true }), [{ file: 'loose.txt', line: 1, reason: 'private key block' }]);
  assert.equal(run(['--untracked'], dir).code, 1);
  assert.equal(run([], dir).code, 0);
});

test('a tracked file deleted on disk is skipped; the file on disk is what is scanned', () => {
  const dir = repo({ 'gone.txt': 'clean\n', 'edited.txt': 'clean\n' });
  rmSync(join(dir, 'gone.txt'));
  write(dir, { 'edited.txt': `now ${fakes['Slack token shape']}\n` });
  assert.deepEqual(scanFiles(dir), [{ file: 'edited.txt', line: 1, reason: 'Slack token shape' }]);
});

test('--values-from finds the exact values of key files without printing them', () => {
  const dir = repo({ 'notes.md': 'line one\nthe key is plain-looking-value-123456 here\n', 'env.txt': 'X=1\n' });
  const secrets = join(base, `secrets-${++count}`);
  mkdirSync(secrets);
  writeFileSync(join(secrets, 'jev.key'), 'plain-looking-value-123456\n');
  writeFileSync(join(secrets, 'env'), 'SHORT=abc\nTOKEN=another-made-up-value-xyz\n');
  const values = valuesFrom(secrets);
  assert.ok(values.includes('plain-looking-value-123456'));
  assert.ok(values.includes('another-made-up-value-xyz'));
  assert.ok(!values.includes('abc'), 'values under 6 characters are ignored (D-014)');
  assert.deepEqual(scanFiles(dir, { values }), [{ file: 'notes.md', line: 2, reason: 'a value from --values-from' }]);
  const result = run(['--values-from', secrets], dir);
  assert.equal(result.code, 1);
  assert.match(result.err, /notes\.md:2: a value from --values-from/);
  assert.ok(!result.err.includes('plain-looking-value-123456'));
  assert.equal(run([], dir).code, 0, 'without the flag no value is looked for');
});

test('--history finds a secret that a later commit removed', () => {
  const value = fakes['JWT shape'];
  const dir = repo({ 'a.txt': 'clean\n', 'old/session.txt': `token: ${value}\n` });
  git(dir, 'commit', '-q', '-m', 'first');
  rmSync(join(dir, 'old'), { recursive: true });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'second');
  assert.deepEqual(scanFiles(dir), []);
  const history = scanHistory(dir);
  assert.equal(history.length, 1);
  assert.equal(history[0].file, 'old/session.txt');
  assert.equal(history[0].line, 1);
  assert.equal(history[0].reason, 'JWT shape');
  assert.match(history[0].blob, /^[0-9a-f]{40}$/);
  const result = run(['--history'], dir);
  assert.equal(result.code, 1);
  assert.match(result.err, /old\/session\.txt:1 \(blob [0-9a-f]{12} in history\): JWT shape/);
  assert.ok(!result.err.includes(value));
  assert.equal(run([], dir).code, 0);
});

test('a binary file is named without a line', () => {
  const bytes = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(fakes['AWS access key shape'])]);
  assert.deepEqual(scanBytes(bytes), [{ line: 0, reason: 'AWS access key shape' }]);
  const dir = repo();
  writeFileSync(join(dir, 'image.bin'), bytes);
  git(dir, 'add', '-A');
  const result = run([], dir);
  assert.equal(result.code, 1);
  assert.match(result.err, /^secret-scan: image\.bin: AWS access key shape$/m);
});

test('outside a repository, or with an unknown option, it exits 2', () => {
  const plain = join(base, `plain-${++count}`);
  mkdirSync(plain);
  assert.equal(run([], plain).code, 2);
  const dir = repo({ 'a.txt': 'x\n' });
  const result = run(['--nope'], dir);
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown option --nope/);
  assert.equal(run(['--values-from'], dir).code, 2);
});

test('this repository passes the scan', () => {
  assert.deepEqual(scanFiles(repoRoot), []);
});
