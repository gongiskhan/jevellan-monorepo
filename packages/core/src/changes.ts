// jv task changes T [--stat] (brief sections 4 and 7): what a task changed, for people (the UI's Changes modal, the MCP
// jv_task_changes tool, the command).
//
// - Committed: `git diff <base_commit>...<branch>` in the project checkout, where the task branch and its fork point
//   live (the worktree may have been archived by gc, D-051; refs stay in the repository, and gc never touches a
//   branch). Renames are detected (-M), so a file's status is one of A, M, D or R (a type change counts as M).
// - Uncommitted: in the task worktree, when it still exists on disk: tracked files changed against HEAD, staged or
//   not (`git diff HEAD`), plus untracked files that are not ignored (`git ls-files --others --exclude-standard`, so
//   .jv-evidence/ and plan.md, which project add puts in info/exclude, never count), each marked `uncommitted`. An
//   untracked file is A with its line count; a binary one has `binary` and no counts. A file changed in both shows
//   twice: once committed, once uncommitted. No worktree on disk: no uncommitted part, and `worktree` is null.
// - `stat`: the file list only; otherwise `diff` holds the committed diff, then the uncommitted one, then a diff of
//   each untracked file against /dev/null (at most 200 untracked files), cut at 4,000,000 characters (`truncated`),
//   with every known secret masked by the redactor (D-014).
//
// Refusals: an unknown task is exit 3; a task with no branch or no base commit (an answer or converse task runs in
// the project checkout and never lands) is exit 2, and so is a branch git does not know. git runs without a shell,
// with GIT_OPTIONAL_LOCKS=0 so reading never takes the index lock under a worker that is committing, and never with
// an external diff or colours. Nothing is written anywhere.

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refused } from './errors.js';
import { normalizeId } from './ids.js';
import { redact } from './redact.js';
import type { Store } from './store.js';

export const MAX_DIFF_CHARS = 4_000_000;
export const MAX_UNTRACKED = 200;
const GIT_TIMEOUT_MS = 60_000;

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface ChangedFileView {
  path: string;
  /** The path before a rename (status R). */
  oldPath?: string;
  status: ChangeStatus;
  /** Lines added and removed (0 and 0 for a binary file, which has `binary`). */
  added: number;
  removed: number;
  binary?: boolean;
  /** True for a change in the worktree that is not committed on the branch. */
  uncommitted: boolean;
}

export interface TaskChanges {
  task: string;
  branch: string;
  /** The base commit the branch forked from (tasks.base_commit). */
  base: string;
  /** The worktree the uncommitted part was read from, or null when it is not on disk any more. */
  worktree: string | null;
  files: ChangedFileView[];
  /** Present unless `stat`: the unified diff, committed first. */
  diff?: string;
  /** The diff was cut, or there were more untracked files than were diffed. */
  truncated?: boolean;
}

interface GitOut {
  code: number;
  stdout: string;
}

function runGit(cwd: string, args: readonly string[], permitted: readonly number[] = [0]): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.quotepath=false', ...args],
      {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        if (code === -1 || !permitted.includes(code)) {
          const why = String(stderr).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? (error ? error.message : `exit ${code}`);
          reject(refused(`git ${args[0] ?? ''} failed in ${cwd}: ${redact(why)}`));
          return;
        }
        resolve({ code, stdout: String(stdout) });
      },
    );
  });
}

/** `git diff --name-status -z -M`: status letter, the path, and the old path of a rename (copies read as added). */
export function parseNameStatus(output: string): Array<{ status: ChangeStatus; path: string; oldPath?: string }> {
  const fields = output.split('\0');
  const out: Array<{ status: ChangeStatus; path: string; oldPath?: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (code === '') continue;
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const from = fields[++i] ?? '';
      const to = fields[++i] ?? '';
      if (to === '') continue;
      out.push(letter === 'R' ? { status: 'R', path: to, oldPath: from } : { status: 'A', path: to });
      continue;
    }
    const path = fields[++i] ?? '';
    if (path === '') continue;
    out.push({ status: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M', path });
  }
  return out;
}

/**
 * `git diff --numstat -z -M`: "<added>\t<removed>\t<path>\0", or for a rename "<added>\t<removed>\t\0<old>\0<new>\0";
 * "-" counts are a binary file. Keyed by the (new) path.
 */
export function parseNumstatZ(output: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const fields = output.split('\0');
  const out = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i]!;
    if (row === '') continue;
    const [a = '', r = '', ...rest] = row.split('\t');
    let path = rest.join('\t');
    if (path === '') {
      i++; // the old path of a rename
      path = fields[++i] ?? '';
    }
    if (path === '') continue;
    const binary = a === '-' || r === '-';
    out.set(path, { added: binary ? 0 : Number(a) || 0, removed: binary ? 0 : Number(r) || 0, binary });
  }
  return out;
}

async function diffFiles(cwd: string, range: readonly string[], uncommitted: boolean): Promise<ChangedFileView[]> {
  const [names, counts] = await Promise.all([
    runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--name-status', '-z', '-M', ...range]),
    runGit(cwd, ['diff', '--no-color', '--no-ext-diff', '--numstat', '-z', '-M', ...range]),
  ]);
  const stats = parseNumstatZ(counts.stdout);
  return parseNameStatus(names.stdout).map((f) => {
    const n = stats.get(f.path);
    return {
      path: f.path,
      ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
      status: f.status,
      added: n?.added ?? 0,
      removed: n?.removed ?? 0,
      ...(n?.binary ? { binary: true } : {}),
      uncommitted,
    };
  });
}

/** An untracked file as an added one: its line count, or binary (a NUL byte in its first 8000 bytes). */
function untrackedFile(worktree: string, path: string): ChangedFileView {
  const file = join(worktree, path);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) return { path, status: 'A', added: 1, removed: 0, uncommitted: true };
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) return { path, status: 'A', added: 0, removed: 0, binary: true, uncommitted: true };
    const text = bytes.toString('utf8');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { path, status: 'A', added: lines, removed: 0, uncommitted: true };
  } catch {
    return { path, status: 'A', added: 0, removed: 0, uncommitted: true };
  }
}

/**
 * The changes of task `taskId`: its branch against its base commit, plus the worktree's uncommitted changes (see
 * the header). `stat` leaves the diff text out.
 */
export async function taskChanges(store: Store, taskId: string, options: { stat?: boolean } = {}): Promise<TaskChanges> {
  const task = store.requireTask(normalizeId(taskId));
  if (!task.branch || !task.base_commit) {
    throw refused(`task ${task.id} has no ${task.branch ? 'base commit' : 'branch'}; it runs in the project checkout and has no changes of its own`);
  }
  const project = store.getProject(task.project_id);
  if (!project) throw refused(`task ${task.id} has no project`);
  const branch = task.branch;
  const base = task.base_commit;
  const known = await runGit(project.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branch}^{commit}`], [0, 1, 128]);
  if (known.code !== 0) throw refused(`the branch ${branch} of task ${task.id} does not exist in ${project.path}`);
  const range = [`${base}...refs/heads/${branch}`];

  const files = await diffFiles(project.path, range, false);
  const worktree = task.worktree_path && existsSync(join(task.worktree_path, '.git')) ? task.worktree_path : null;
  let untracked: string[] = [];
  if (worktree) {
    files.push(...(await diffFiles(worktree, ['HEAD'], true)));
    const others = await runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
    untracked = others.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/'));
    files.push(...untracked.map((p) => untrackedFile(worktree, p)));
  }
  const result: TaskChanges = { task: task.id, branch, base, worktree, files };
  if (options.stat) {
    if (untracked.length > MAX_UNTRACKED) result.truncated = true;
    return result;
  }

  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '-M'];
  let text = (await runGit(project.path, [...diffArgs, ...range])).stdout;
  if (worktree) {
    text += (await runGit(worktree, [...diffArgs, 'HEAD'])).stdout;
    for (const p of untracked.slice(0, MAX_UNTRACKED)) {
      if (text.length > MAX_DIFF_CHARS) break;
      text += (await runGit(worktree, [...diffArgs, '--no-index', '--', '/dev/null', p], [0, 1])).stdout;
    }
  }
  const truncated = text.length > MAX_DIFF_CHARS || untracked.length > MAX_UNTRACKED;
  // Every known secret is masked (D-014): a worker may have written one into a file of the worktree.
  result.diff = redact(text.slice(0, MAX_DIFF_CHARS));
  if (truncated) result.truncated = true;
  return result;
}

/** --stat text: numstat lines ("<added>\t<removed>\t<path>", "-" for binary), uncommitted ones marked. */
export function formatChangesStat(changes: TaskChanges): string {
  return changes.files
    .map((f) => {
      const counts = f.binary ? '-\t-' : `${f.added}\t${f.removed}`;
      const path = f.oldPath !== undefined ? `${f.oldPath} => ${f.path}` : f.path;
      return `${counts}\t${path}${f.uncommitted ? '\t(uncommitted)' : ''}`;
    })
    .join('\n');
}

/** The command's text: one line about the range, one per file (status, +added/-removed, path), then the diff. */
export function formatChanges(changes: TaskChanges): string {
  const uncommitted = changes.files.filter((f) => f.uncommitted).length;
  const lines = [
    `Task ${changes.task}: ${changes.branch} against ${changes.base.slice(0, 12)}, ${changes.files.length} changed file${changes.files.length === 1 ? '' : 's'}${uncommitted ? ` (${uncommitted} uncommitted)` : ''}${changes.worktree ? '' : '; the worktree is not on disk, so nothing uncommitted is shown'}${changes.truncated ? '; truncated' : ''}`,
  ];
  for (const f of changes.files) {
    const counts = f.binary ? 'binary' : `+${f.added}/-${f.removed}`;
    lines.push(`  ${f.status} ${counts.padEnd(11)} ${f.oldPath !== undefined ? `${f.oldPath} => ` : ''}${f.path}${f.uncommitted ? ' (uncommitted)' : ''}`);
  }
  if (changes.diff) lines.push('', changes.diff.replace(/\n$/, ''));
  return lines.join('\n');
}
