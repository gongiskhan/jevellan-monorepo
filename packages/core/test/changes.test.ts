// taskChanges (changes.ts, brief sections 4 and 7): on a real temporary git repository, the task branch against its
// base commit (added, modified, deleted, renamed and binary files; the default branch moving on after the fork does not
// count), the worktree's uncommitted changes marked (tracked edits, untracked files, info/exclude respected), --stat
// without the diff text, the redactor over the diff, a worktree no longer on disk, and the refusals (exit 2 and 3).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FAKE_TOKEN, makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-changes-test-');
process.env.JV_HOME = home;
const C = await import('../src/changes.js');
const { openStore } = await import('../src/store.js');
const { JvError } = await import('../src/errors.js');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const repo = join(home, 'repos', 'sandbox');
const wt = join(home, 'worktrees', 'sandbox', 'empty-state-abc123');
mkdirSync(repo, { recursive: true });
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
const git = (...args: string[]) => gitIn(repo, ...args);

git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
writeFileSync(join(repo, 'b.txt'), 'to be deleted\n');
writeFileSync(join(repo, 'c.txt'), 'a file that moves\nwith two lines\n');
git('add', '.');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
appendFileSync(join(repo, '.git', 'info', 'exclude'), '/.jv-evidence/\n/plan.md\n');

// The task branch, in its own worktree, with committed work of every kind.
git('worktree', 'add', '-q', '-b', 'jv/empty-state-abc123', wt, 'main');
writeFileSync(join(wt, 'a.txt'), 'one\n2\nthree\n');
unlinkSync(join(wt, 'b.txt'));
renameSync(join(wt, 'c.txt'), join(wt, 'd.txt'));
writeFileSync(join(wt, 'new.txt'), 'n1\nn2\nn3\n');
writeFileSync(join(wt, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
writeFileSync(join(wt, 'config.txt'), `token=${FAKE_TOKEN}\n`);
gitIn(wt, 'add', '-A');
gitIn(wt, 'commit', '-q', '-m', 'task work');

// The default branch moves on after the fork: not the task's change.
writeFileSync(join(repo, 'main-only.txt'), 'landed elsewhere\n');
git('add', '.');
git('commit', '-q', '-m', 'other work on main');

// Uncommitted in the worktree: an edit of a committed file, an untracked file, and excluded evidence.
writeFileSync(join(wt, 'a.txt'), 'one\n2\nthree\nfour\n');
writeFileSync(join(wt, 'notes.md'), 'line 1\nline 2\n');
mkdirSync(join(wt, '.jv-evidence'), { recursive: true });
writeFileSync(join(wt, '.jv-evidence', 'shot.png'), 'not listed');
writeFileSync(join(wt, 'plan.md'), 'not listed either\n');

const project = store.createProject({ name: 'sandbox', path: repo, default_branch: 'main' }).row;
let n = 0;
function task(extra: { branch?: string | null; base?: string | null; worktree?: string | null } = {}) {
  const t = store.createTask({
    project_id: project.id,
    request_id: `req-changes-${++n}`,
    kind: 'feature',
    title: 'Customers empty state',
    task_text: 'Show a message when there are no customers.',
    workflow_json: '{"steps":[]}',
  }).row;
  return store.updateTask(t.id, {
    branch: extra.branch === undefined ? 'jv/empty-state-abc123' : extra.branch,
    base_commit: extra.base === undefined ? base : extra.base,
    worktree_path: extra.worktree === undefined ? wt : extra.worktree,
  });
}

test('the branch against its base plus the uncommitted changes of the worktree, marked', async () => {
  const t = task();
  const r = await C.taskChanges(store, t.id);
  assert.equal(r.task, t.id);
  assert.equal(r.branch, 'jv/empty-state-abc123');
  assert.equal(r.base, base);
  assert.equal(r.worktree, wt);
  const committed = r.files.filter((f) => !f.uncommitted);
  const byPath = new Map(committed.map((f) => [f.path, f]));
  assert.deepEqual(byPath.get('a.txt'), { path: 'a.txt', status: 'M', added: 1, removed: 1, uncommitted: false });
  assert.deepEqual(byPath.get('b.txt'), { path: 'b.txt', status: 'D', added: 0, removed: 1, uncommitted: false });
  assert.deepEqual(byPath.get('d.txt'), { path: 'd.txt', oldPath: 'c.txt', status: 'R', added: 0, removed: 0, uncommitted: false });
  assert.deepEqual(byPath.get('new.txt'), { path: 'new.txt', status: 'A', added: 3, removed: 0, uncommitted: false });
  assert.deepEqual(byPath.get('logo.png'), { path: 'logo.png', status: 'A', added: 0, removed: 0, binary: true, uncommitted: false });
  assert.ok(byPath.has('config.txt'));
  assert.equal(byPath.has('main-only.txt'), false, 'what main did after the fork is not the task\'s');
  assert.equal(committed.length, 6);

  const uncommitted = r.files.filter((f) => f.uncommitted);
  assert.deepEqual(uncommitted, [
    { path: 'a.txt', status: 'M', added: 1, removed: 0, uncommitted: true },
    { path: 'notes.md', status: 'A', added: 2, removed: 0, uncommitted: true },
  ]);

  assert.ok(r.diff);
  assert.match(r.diff!, /diff --git a\/a\.txt b\/a\.txt[\s\S]*-two\n\+2\n/);
  assert.match(r.diff!, /rename from c\.txt\nrename to d\.txt/);
  assert.match(r.diff!, /\+four\n/, 'the uncommitted edit is in the diff');
  assert.match(r.diff!, /\+\+\+ b\/notes\.md\n@@ -0,0 \+1,2 @@\n\+line 1\n\+line 2/, 'the untracked file is diffed as added');
  assert.doesNotMatch(r.diff!, /shot\.png|not listed/);
  assert.doesNotMatch(r.diff!, new RegExp(FAKE_TOKEN), 'secrets are masked');
  assert.match(r.diff!, /\+token=\[redacted\]/);
  assert.equal(r.truncated, undefined);

  const text = C.formatChanges(r);
  assert.match(text.split('\n')[0]!, new RegExp(`^Task ${t.id}: jv/empty-state-abc123 against ${base.slice(0, 12)}, 8 changed files \\(2 uncommitted\\)$`));
  assert.match(text, /\n {2}R \+0\/-0 {7}c\.txt => d\.txt\n/);
  assert.match(text, /\n {2}A \+2\/-0 {7}notes\.md \(uncommitted\)\n/);
});

test('--stat: the file list without the diff text, as numstat lines', async () => {
  const r = await C.taskChanges(store, task().id, { stat: true });
  assert.equal('diff' in r, false);
  assert.equal(r.files.length, 8);
  const lines = C.formatChangesStat(r).split('\n');
  assert.ok(lines.includes('1\t1\ta.txt'));
  assert.ok(lines.includes('-\t-\tlogo.png'));
  assert.ok(lines.includes('0\t0\tc.txt => d.txt'));
  assert.ok(lines.includes('1\t0\ta.txt\t(uncommitted)'));
  assert.ok(lines.includes('2\t0\tnotes.md\t(uncommitted)'));
});

test('a worktree that is not on disk any more: the committed part only', async () => {
  const r = await C.taskChanges(store, task({ worktree: join(home, 'archive', 'gone') }).id);
  assert.equal(r.worktree, null);
  assert.equal(r.files.length, 6);
  assert.ok(r.files.every((f) => !f.uncommitted));
  assert.match(C.formatChanges(r), /the worktree is not on disk, so nothing uncommitted is shown/);
});

test('refusals: an unknown task is exit 3; no branch, no base or a branch git does not know is exit 2', async () => {
  const code = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof JvError ? e.exitCode : -1));
  assert.equal(await code(C.taskChanges(store, 'TZZZZZZ')), 3);
  assert.equal(await code(C.taskChanges(store, task({ branch: null, base: null, worktree: null }).id)), 2);
  assert.equal(await code(C.taskChanges(store, task({ base: null }).id)), 2);
  await assert.rejects(C.taskChanges(store, task({ branch: 'jv/never-made' }).id), /the branch jv\/never-made of task T\w+ does not exist/);
  // A lower-case id typed by a person resolves.
  const t = task();
  assert.equal((await C.taskChanges(store, t.id.toLowerCase(), { stat: true })).task, t.id);
});

test('the parsers pair renames and binary counts', () => {
  assert.deepEqual(C.parseNameStatus('M\0a.txt\0R087\0old name.txt\0new name.txt\0D\0gone.txt\0T\0link\0'), [
    { status: 'M', path: 'a.txt' },
    { status: 'R', path: 'new name.txt', oldPath: 'old name.txt' },
    { status: 'D', path: 'gone.txt' },
    { status: 'M', path: 'link' },
  ]);
  const counts = C.parseNumstatZ('1\t2\ta.txt\0' + '3\t0\t\0old name.txt\0new name.txt\0' + '-\t-\tlogo.png\0');
  assert.deepEqual(counts.get('a.txt'), { added: 1, removed: 2, binary: false });
  assert.deepEqual(counts.get('new name.txt'), { added: 3, removed: 0, binary: false });
  assert.deepEqual(counts.get('logo.png'), { added: 0, removed: 0, binary: true });
  assert.equal(counts.has('old name.txt'), false);
});
