// Secret scan of this repository (`npm run scan:secrets`), ported from gongiskhan/jevellan at 8e2788ec
// (scripts/secret-scan.mjs). It reads every tracked file (`git ls-files`) as it is on disk and fails when a line
// holds a secret shape: provider keys, GitHub and npm tokens, cloud keys, private key blocks, JWTs. It prints the
// file, the line and the kind of shape, never the matched text, and exits 1 when anything is found, 0 when not,
// 2 when it cannot scan (not a git repository, unreadable values folder).
//
// Options:
//   --untracked         also scan untracked files that are not ignored (what a commit could pick up next)
//   --history           also scan every blob reachable from any ref (a public repository keeps its history)
//   --values-from DIR   also fail on the exact values of the files in DIR, for example ~/.jv/secrets (M16); a value
//                       is the whole file, each line, and the value of NAME=value lines, of at least 6 characters,
//                       the rule of the runtime's redactor (D-014). Never read unless asked.
//
// Brief section 1 (secrets never in logs, events, the store or command lines; tests use made-up values) and
// section 2 (`scan:secrets`, run in phase 7 and in M16, no git hooks installed). Jevellan's pre-push mode is not
// ported because this repository installs no hooks; its JEVELLAN_TEST_* environment values became --values-from,
// since jv keeps keys in files under ~/.jv/secrets, not in the environment.

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Each shape has a label that is printed instead of the match.
export const patterns = [
  { label: 'Anthropic or OpenAI key shape', re: /\bsk-(?:ant-[A-Za-z0-9_-]*|proj-[A-Za-z0-9_-]*|[A-Za-z0-9_-]{20,})/ },
  { label: 'GitHub token shape', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'GitHub fine-grained token shape', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'Jevellan token shape', re: /\bjva_[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}\b/ },
  { label: 'npm token shape', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'AWS access key shape', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'Google API key shape', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slack token shape', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { label: 'JWT shape', re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/ },
];

// Exact source text that matches a shape but is not a credential, each with the file it is in and why. Each entry
// is removed before matching, so a real token elsewhere on the same line is still found. Jevellan's one entry
// belonged to a spike script this repository does not have; the made-up values of this repository's tests
// ("fake-oauth-token-...") match no shape, so the list is empty.
export const allowed = [];

const MIN_VALUE_LENGTH = 6;

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`secret-scan: git ${args[0]} failed in ${cwd}; run it inside a git repository`);
  }
  return result.stdout;
}

/** The top folder of the repository that holds cwd. */
export function repositoryRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
}

/** The labels of the shapes one line holds (allowed text removed first). */
export function shapesIn(line) {
  const rest = allowed.reduce((text, entry) => text.replaceAll(entry, ''), line);
  return patterns.filter(({ re }) => re.test(rest)).map(({ label }) => label);
}

/** Exact values to look for, from the files of a folder (D-014's rule: whole, per line, NAME=value). */
export function valuesFrom(dir) {
  const values = new Set();
  const add = (value) => {
    const trimmed = value.trim();
    // A value of several lines (a PEM) is found through its lines, each a value of its own.
    if (trimmed.length >= MIN_VALUE_LENGTH && !trimmed.includes('\n')) values.add(trimmed);
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = readFileSync(join(dir, entry.name), 'utf8');
    add(text);
    for (const line of text.split(/\r?\n/)) {
      add(line);
      const eq = line.indexOf('=');
      if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq).trim())) add(line.slice(eq + 1));
    }
  }
  return [...values];
}

function isBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0);
}

/** Findings of one file's bytes: { line, reason } for every line with a shape or a known value (line 0: binary). */
export function scanBytes(bytes, values = []) {
  if (isBinary(bytes)) {
    const text = bytes.toString('latin1');
    const reasons = patterns.filter(({ re }) => re.test(text)).map(({ label }) => label);
    if (values.some((value) => bytes.includes(Buffer.from(value)))) reasons.push('a value from --values-from');
    return reasons.map((reason) => ({ line: 0, reason }));
  }
  const findings = [];
  bytes.toString('utf8').split('\n').forEach((line, index) => {
    for (const reason of shapesIn(line)) findings.push({ line: index + 1, reason });
    if (values.some((value) => line.includes(value))) findings.push({ line: index + 1, reason: 'a value from --values-from' });
  });
  return findings;
}

/**
 * Scans the files git tracks in the repository that holds cwd (with untracked, not ignored files too when asked),
 * as they are on disk. Returns { file, line, reason } findings; file is relative to the repository root.
 */
export function scanFiles(cwd, { untracked = false, values = [] } = {}) {
  const root = repositoryRoot(cwd);
  const args = ['ls-files', '-z', '--cached', ...(untracked ? ['--others', '--exclude-standard'] : [])];
  const files = git(root, args).toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  for (const file of new Set(files)) {
    let stat;
    try {
      stat = lstatSync(join(root, file));
    } catch (error) {
      if (error.code === 'ENOENT') continue; // deleted in the working tree, not yet in the index
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue; // a submodule or another special entry
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(join(root, file))) : readFileSync(join(root, file));
    for (const finding of scanBytes(bytes, values)) findings.push({ file, ...finding });
  }
  return findings;
}

/**
 * Scans every blob reachable from any ref of the repository that holds cwd. Returns { file, blob, line, reason }
 * findings, where file is the first path git names for the blob.
 */
export function scanHistory(cwd, { values = [] } = {}) {
  const root = repositoryRoot(cwd);
  const listed = git(root, ['rev-list', '--objects', '--all']).toString('utf8').split('\n').filter(Boolean);
  const names = new Map();
  for (const entry of listed) {
    const space = entry.indexOf(' ');
    const oid = space < 0 ? entry : entry.slice(0, space);
    if (!names.has(oid)) names.set(oid, space < 0 ? '' : entry.slice(space + 1));
  }
  if (!names.size) return [];
  // One `git cat-file --batch` for every object: "<oid> <type> <size>\n<content>\n" each.
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: `${[...names.keys()].join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (batch.error || batch.status !== 0) throw new Error(`secret-scan: git cat-file failed in ${root}`);
  const output = batch.stdout;
  const findings = [];
  let at = 0;
  while (at < output.length) {
    const headerEnd = output.indexOf(0x0a, at);
    if (headerEnd < 0) break;
    const [oid = '', type = '', size = ''] = output.subarray(at, headerEnd).toString('utf8').split(' ');
    if (type === 'missing' || !/^\d+$/.test(size)) {
      at = headerEnd + 1;
      continue;
    }
    const start = headerEnd + 1;
    const end = start + Number(size);
    if (type === 'blob') {
      for (const finding of scanBytes(output.subarray(start, end), values)) {
        findings.push({ file: names.get(oid) || '(unnamed)', blob: oid, ...finding });
      }
    }
    at = end + 1;
  }
  return findings;
}

function where({ file, line, blob }) {
  const at = line ? `${file}:${line}` : file;
  return blob ? `${at} (blob ${blob.slice(0, 12)} in history)` : at;
}

function parseArgs(argv) {
  const options = { untracked: false, history: false, valuesFrom: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--untracked') options.untracked = true;
    else if (arg === '--history') options.history = true;
    else if (arg === '--values-from') {
      const dir = argv[++i];
      if (!dir) throw new Error('secret-scan: --values-from needs a folder');
      options.valuesFrom.push(dir);
    } else if (arg.startsWith('--values-from=')) options.valuesFrom.push(arg.slice('--values-from='.length));
    else throw new Error(`secret-scan: unknown option ${arg}; options: --untracked, --history, --values-from DIR`);
  }
  return options;
}

/** The command: returns the exit code and writes its lines through out and err. */
export function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
    const values = options.valuesFrom.flatMap((dir) => valuesFrom(dir));
    const findings = scanFiles(cwd, { untracked: options.untracked, values });
    if (options.history) findings.push(...scanHistory(cwd, { values }));
    for (const finding of findings) err(`secret-scan: ${where(finding)}: ${finding.reason}`);
    if (findings.length) {
      err(`secret-scan: ${findings.length} finding(s); remove the value, or use a made-up value that matches no shape`);
      return 1;
    }
    out('Secret scan passed.');
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : 'secret-scan: failed');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
