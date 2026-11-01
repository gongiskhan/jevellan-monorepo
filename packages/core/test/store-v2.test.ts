// Schema 2 (brief section 3): schema 1 is the skills repository's byte for byte, the migration from 1 to 2 (backup
// once, columns and tables only, the coordinator conversation task, extensions), refusals of newer stores, and the
// schema 2 columns through the store's writers. The migration's backup and its concurrency: a .v1.bak that is not a
// complete copy of the store is set aside and a new one taken, openers that arrive together all end at schema 2
// with one backup, and a registered extension exists after any open, whoever migrated (real child processes,
// test/fixtures/migration-opener.ts).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-store-v2-test-'));
process.env.JV_HOME = home;

const S = await import('../src/store.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { JvError } = await import('../src/errors.js');
const { Store, SCHEMA_VERSION, TABLES_V2, COORDINATOR_TASK_REQUEST_PREFIX } = S;

after(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
const file = (name: string) => join(home, `${name}-${++n}.sqlite`);

function master(db: DatabaseSync) {
  return (db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid').all() as object[]).map((r) => ({ ...r }));
}

function v1Store(f: string) {
  const s = Store.open({ file: f, schemaVersion: '1' });
  const p = s.createProject({ name: 'old', path: '/tmp/old', default_branch: 'main' }).row;
  const t = s.createTask({ project_id: p.id, request_id: 'req-old', kind: 'single', title: 'Old task', task_text: 'x', workflow_json: '{"name":"single","steps":[]}', state: 'done', state_reason: 'test' }).row;
  s.close();
  return { p, t };
}

describe('schema 1', () => {
  test('a schema 1 store has the same sqlite_master SQL as one the skills repository\'s jv created', () => {
    const expected = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'test', 'fixtures', 'schema-v1-master.json'), 'utf8')) as object[];
    const f = file('v1');
    Store.open({ file: f, schemaVersion: '1' }).close();
    const db = new DatabaseSync(f, { readOnly: true });
    try {
      assert.deepEqual(master(db), expected);
    } finally {
      db.close();
    }
  });
});

describe('migration 1 to 2', () => {
  test('a version 1 store is backed up once, gains the schema 2 columns and tables, and keeps every row', () => {
    const f = file('migrate');
    const { p, t } = v1Store(f);
    const before = master(new DatabaseSync(f, { readOnly: true }));
    const s = Store.open({ file: f });
    try {
      assert.equal(s.schemaVersion(), '2');
      assert.ok(existsSync(`${f}.v1.bak`));
      assert.equal(statSync(`${f}.v1.bak`).mode & 0o777, 0o600);
      const bak = new DatabaseSync(`${f}.v1.bak`, { readOnly: true });
      try {
        assert.deepEqual(master(bak), before, 'the backup is the version 1 store');
        assert.equal((bak.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, '1');
        assert.equal((bak.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
      } finally {
        bak.close();
      }
      const kept = s.getTask(t.id)!;
      assert.equal(kept.title, 'Old task');
      assert.equal(kept.origin, 'owner');
      const cols = (table: string) => (s.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols('tasks').includes('origin'));
      assert.ok(cols('reports').includes('ui_json'));
      assert.ok(cols('messages').includes('meta_json'));
      const tables = (s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      for (const tbl of TABLES_V2) assert.ok(tables.includes(tbl), tbl);
      // Every schema 1 statement is untouched except the three altered tables.
      const after = master(s.db) as Array<{ name: string; sql: string | null }>;
      for (const row of before as Array<{ name: string; sql: string | null }>) {
        if (['tasks', 'reports', 'messages'].includes(row.name)) continue;
        assert.deepEqual(after.find((r) => r.name === row.name), row, row.name);
      }
      // The coordinator conversation task of the existing project.
      const conv = s.getTaskByRequestId(`${COORDINATOR_TASK_REQUEST_PREFIX}${p.id}`)!;
      assert.equal(conv.kind, 'single');
      assert.equal(conv.state, 'done');
      assert.equal(conv.origin, 'coordinator');
      assert.equal(s.listSteps(conv.id).length, 0);
      assert.deepEqual(s.listTasks({ project_id: p.id }).map((x) => x.id), [t.id], 'left out of listings');
      assert.equal(s.listTasks({ project_id: p.id, include_coordinator_tasks: true }).length, 2);
    } finally {
      s.close();
    }
    // A second open changes nothing and keeps the first backup.
    const bakTime = statSync(`${f}.v1.bak`).mtimeMs;
    Store.open({ file: f }).close();
    assert.equal(statSync(`${f}.v1.bak`).mtimeMs, bakTime);
  });

  test('a store newer than this jv is refused with exit 2 and the update message', () => {
    const f = file('newer');
    Store.open({ file: f }).close();
    const db = new DatabaseSync(f);
    db.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    db.close();
    assert.throws(() => Store.open({ file: f }), (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message === `store schema 3 is newer than this jv (${SCHEMA_VERSION}); update jv`);
  });

  test('the schema 1 runtime\'s own check refuses a version 2 store (what M3 records)', () => {
    const f = file('v2-for-v1');
    Store.open({ file: f }).close();
    assert.throws(() => Store.open({ file: f, schemaVersion: '1' }), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /store schema version 2 does not match this runtime/.test(e.message));
  });

  test('a schema extension is applied in the migration, on a new store, and on an open where it is missing', () => {
    const calls: string[] = [];
    S.registerSchemaExtension({
      name: 'test-ext',
      present: (db) => db.prepare("SELECT name FROM sqlite_master WHERE name = 'ext_rows'").get() !== undefined,
      ensure: (db) => {
        calls.push('ensure');
        db.exec('CREATE TABLE IF NOT EXISTS ext_rows (id TEXT PRIMARY KEY)');
      },
    });
    const f = file('ext');
    v1Store(f);
    const s = Store.open({ file: f });
    assert.ok(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'ext_rows'").get());
    s.db.exec('DROP TABLE ext_rows');
    s.close();
    Store.open({ file: f }).close();
    const fresh = Store.open({ file: file('ext-new') });
    assert.ok(fresh.db.prepare("SELECT name FROM sqlite_master WHERE name = 'ext_rows'").get());
    fresh.close();
    assert.equal(calls.length, 3);
    S.registerSchemaExtension({ name: 'test-ext', present: () => true, ensure: () => {} });
  });
});

// ---- the backup and concurrent openers (real child processes) ------------------------------------------------

const opener = fileURLToPath(new URL('./fixtures/migration-opener.js', import.meta.url));

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** What test/fixtures/migration-opener.ts takes (JV_TEST_WORKER_ARGS). */
interface ChildArgs {
  role: 'open' | 'hold' | 'interrupt';
  file: string;
  barrier?: string;
  id?: number;
  ext?: 'table' | 'kill';
  mode?: 'create' | 'migrate';
  fileSizeLimit?: number;
}

function child(args: ChildArgs): { line(text: string): Promise<void>; done: Promise<ChildResult> } {
  const node = [process.execPath, '--disable-warning=ExperimentalWarning', opener];
  // ulimit -f: a write past the limit fails (the child ignores SIGXFSZ), the way a full disk fails it.
  const [command, ...argv] = args.fileSizeLimit === undefined ? node : ['/bin/sh', '-c', `ulimit -f ${args.fileSizeLimit} && exec "$0" "$@"`, ...node];
  const proc = spawn(command!, argv, {
    env: { ...process.env, JV_HOME: home, JV_TEST_WORKER: '1', JV_TEST_WORKER_ARGS: JSON.stringify(args) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters: Array<{ text: string; resolve: () => void }> = [];
  proc.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
    for (const w of waiters.splice(0)) {
      if (stdout.split('\n').includes(w.text)) w.resolve();
      else waiters.push(w);
    }
  });
  proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<ChildResult>((resolve) => proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return {
    line: (text) =>
      new Promise<void>((resolve, reject) => {
        if (stdout.split('\n').includes(text)) return resolve();
        waiters.push({ text, resolve });
        void done.then((r) => reject(new Error(`child ended before "${text}": ${JSON.stringify(r)}`)));
      }),
    done,
  };
}

/** The JSON line an opener child printed. */
function opened(r: ChildResult): { ok: boolean; version?: string; extPresent?: boolean; error?: string } {
  const line = r.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as { ok: boolean };
  } catch {
    return { ok: false, error: `exit ${r.code} ${r.signal ?? ''}: ${r.stdout} ${r.stderr}` };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A store file in a folder of its own, so the files next to it are only its own. */
function ownFolder(name: string): { dir: string; f: string } {
  const dir = mkdtempSync(join(home, `${name}-`));
  return { dir, f: join(dir, 'store.sqlite') };
}

/** The names next to the store that start with store.sqlite.v1.bak, sorted. */
function backupNames(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith('store.sqlite.v1.bak')).sort();
}

/** A version 1 store with one project, one task, one session and `events` events of 10 KB each. */
function bigV1Store(f: string, events: number) {
  const made = v1Store(f);
  const s = Store.open({ file: f, schemaVersion: '1' });
  const session = s.createSession({ project_id: made.p.id, request_id: 'big-session', kind: 'step', runtime: 'llm', provider: 'x', model: 'm', effort: 'low', cwd: '/tmp' }).row;
  const insert = s.db.prepare('INSERT INTO events (session_id, seq, at, kind, payload) VALUES (?, ?, ?, ?, ?)');
  const payload = JSON.stringify({ text: 'x'.repeat(10_000) });
  s.db.exec('BEGIN');
  for (let i = 1; i <= events; i++) insert.run(session.id, i, new Date().toISOString(), 'text', payload);
  s.db.exec('COMMIT');
  s.close();
  return made;
}

/** What a backup file holds, read only; throws when it cannot be read. */
function backupFacts(path: string): { version: string; tasks: number; events: number; integrity: string } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string) => Object.values(db.prepare(sql).get() as object)[0] as never;
    return {
      version: one("SELECT value FROM meta WHERE key = 'schema_version'"),
      tasks: one('SELECT count(*) FROM tasks'),
      events: one('SELECT count(*) FROM events'),
      integrity: one('PRAGMA integrity_check'),
    };
  } finally {
    db.close();
  }
}

function assertGoodBackup(f: string, expected: { tasks: number; events?: number }) {
  const bak = `${f}.v1.bak`;
  assert.ok(existsSync(bak), 'a .v1.bak exists');
  assert.equal(statSync(bak).mode & 0o777, 0o600, 'the backup is mode 600');
  for (const side of ['-journal', '-wal', '-shm']) assert.ok(!existsSync(bak + side), `no ${side} next to the backup`);
  const facts = backupFacts(bak);
  assert.equal(facts.version, '1', 'the backup is a version 1 store');
  assert.equal(facts.integrity, 'ok');
  assert.equal(facts.tasks, expected.tasks, 'the backup holds every task of the version 1 store');
  if (expected.events !== undefined) assert.equal(facts.events, expected.events);
}

describe('the migration backup', () => {
  test('a .v1.bak that is not a database (empty, random bytes) is set aside unchanged and a complete backup taken', () => {
    for (const [kind, bytes] of [
      ['empty', Buffer.alloc(0)],
      ['random', Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 37 + 11) % 256))],
    ] as const) {
      const { dir, f } = ownFolder(`bak-${kind}`);
      v1Store(f);
      writeFileSync(`${f}.v1.bak`, bytes);
      const s = Store.open({ file: f });
      assert.equal(s.schemaVersion(), '2', kind);
      s.close();
      assertGoodBackup(f, { tasks: 1 });
      const names = backupNames(dir);
      const aside = names.filter((n) => /^store\.sqlite\.v1\.bak\.invalid-[0-9TZ-]+$/.test(n));
      assert.equal(aside.length, 1, `${kind}: the old file is kept under a new name (${names.join(', ')})`);
      assert.deepEqual(readFileSync(join(dir, aside[0]!)), bytes, `${kind}: the old file is unchanged`);
      assert.deepEqual(names, ['store.sqlite.v1.bak', aside[0]], `${kind}: nothing else is left (${names.join(', ')})`);
    }
  });

  test('an interrupted backup (part of a file and its hot journal) is set aside with its journal; the new one survives a read-write open', async () => {
    const { dir, f } = ownFolder('bak-interrupted');
    v1Store(f);
    const killed = await child({ role: 'interrupt', file: `${f}.v1.bak` }).done;
    assert.equal(killed.signal, 'SIGKILL', 'the writer died half way');
    assert.ok(existsSync(`${f}.v1.bak-journal`) && statSync(`${f}.v1.bak-journal`).size > 0, 'a hot journal was left');
    const partial = readFileSync(`${f}.v1.bak`);
    const journal = readFileSync(`${f}.v1.bak-journal`);

    Store.open({ file: f }).close();
    assertGoodBackup(f, { tasks: 1 });
    const names = backupNames(dir);
    const aside = names.find((n) => /^store\.sqlite\.v1\.bak\.invalid-[0-9TZ-]+$/.test(n));
    assert.ok(aside, `the partial file is kept under a new name (${names.join(', ')})`);
    assert.deepEqual(names, ['store.sqlite.v1.bak', aside, `${aside}-journal`], 'its journal went with it, under the same name');
    assert.deepEqual(readFileSync(join(dir, aside)), partial);
    assert.deepEqual(readFileSync(join(dir, `${aside}-journal`)), journal);

    // A read-write open of the new backup (sqlite3 during a restore) finds no journal to roll back.
    const rw = new DatabaseSync(`${f}.v1.bak`);
    assert.equal((rw.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 1);
    rw.close();
    // A second open keeps it.
    const bakTime = statSync(`${f}.v1.bak`).mtimeMs;
    Store.open({ file: f }).close();
    assert.equal(statSync(`${f}.v1.bak`).mtimeMs, bakTime);
  });

  test('a complete version 1 backup that is not this store as it is now (older, or another store) is set aside and a new one taken', () => {
    for (const kind of ['older', 'other store'] as const) {
      const { dir, f } = ownFolder(`bak-${kind.replace(' ', '-')}`);
      const { p } = v1Store(f);
      if (kind === 'older') {
        const db = new DatabaseSync(f);
        db.exec(`VACUUM INTO '${f}.v1.bak'`);
        db.close();
        // The store changes at version 1 after that copy (the migration then failed, or the skills runtime wrote).
        const s1 = Store.open({ file: f, schemaVersion: '1' });
        s1.createTask({ project_id: p.id, request_id: 'req-later', kind: 'single', title: 'Later task', task_text: 'x', workflow_json: '{"name":"single","steps":[]}' });
        s1.close();
      } else {
        const { f: other } = ownFolder('bak-other-source');
        v1Store(other);
        const db = new DatabaseSync(other);
        db.exec(`VACUUM INTO '${f}.v1.bak'`);
        db.close();
      }
      chmodSync(`${f}.v1.bak`, 0o600);
      const oldTasks = backupFacts(`${f}.v1.bak`).tasks;

      Store.open({ file: f }).close();
      const tasks = kind === 'older' ? 2 : 1;
      assertGoodBackup(f, { tasks });
      const bak = new DatabaseSync(`${f}.v1.bak`, { readOnly: true });
      assert.deepEqual(
        (bak.prepare('SELECT request_id FROM tasks ORDER BY request_id').all() as Array<{ request_id: string }>).map((r) => r.request_id),
        kind === 'older' ? ['req-later', 'req-old'] : ['req-old'],
      );
      assert.equal((bak.prepare('SELECT id FROM projects').get() as { id: string }).id, p.id, 'the backup is of this store');
      bak.close();
      const names = backupNames(dir);
      const aside = names.filter((n) => /^store\.sqlite\.v1\.bak\.prev-[0-9TZ-]+$/.test(n));
      assert.equal(aside.length, 1, `${kind}: the old backup is kept under a new name (${names.join(', ')})`);
      assert.equal(backupFacts(join(dir, aside[0]!)).tasks, oldTasks, `${kind}: unchanged`);
      assert.equal(names.length, 2, names.join(', '));
    }
  });

  test('a backup that matches the store is kept as it is: a migration that failed after it reuses it on the next open', () => {
    const { dir, f } = ownFolder('bak-retry');
    v1Store(f);
    S.registerSchemaExtension({ name: 'test-fail', present: () => false, ensure: () => { throw new Error('extension failed'); } });
    try {
      assert.throws(() => Store.open({ file: f }), /extension failed/);
    } finally {
      S.registerSchemaExtension({ name: 'test-fail', present: () => true, ensure: () => {} });
    }
    assert.equal(S.readStoreSchemaVersion(f), '1', 'the failed migration left the store at version 1');
    assertGoodBackup(f, { tasks: 1 });
    const before = statSync(`${f}.v1.bak`);

    Store.open({ file: f }).close();
    assert.equal(S.readStoreSchemaVersion(f), '2');
    const after = statSync(`${f}.v1.bak`);
    assert.equal(after.ino, before.ino, 'the same file');
    assert.equal(after.mtimeMs, before.mtimeMs, 'not rewritten');
    assert.deepEqual(backupNames(dir), ['store.sqlite.v1.bak']);
  });

  test('a crash inside the migration transaction leaves the store at version 1 with its backup; the next open migrates', async () => {
    const { dir, f } = ownFolder('bak-crash');
    v1Store(f);
    const r = await child({ role: 'open', file: f, ext: 'kill' }).done;
    assert.equal(r.signal, 'SIGKILL', 'the opener died inside the migration');
    assert.equal(S.readStoreSchemaVersion(f), '1', 'nothing of the migration was committed');
    const db = new DatabaseSync(f, { readOnly: true });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schedules'").get(), undefined, 'no schema 2 table');
    db.close();
    assertGoodBackup(f, { tasks: 1 });
    const s = Store.open({ file: f });
    assert.equal(s.schemaVersion(), '2');
    s.close();
    assertGoodBackup(f, { tasks: 1 });
    assert.deepEqual(backupNames(dir), ['store.sqlite.v1.bak']);
  });

  test('a copy that fails half way (a write error, as on a full disk) is removed; the store stays at version 1 and the next open backs it up', async () => {
    const { dir, f } = ownFolder('bak-write-error');
    bigV1Store(f, 400); // about 4 MB, past the limit below
    const r = await child({ role: 'open', file: f, fileSizeLimit: 1000 }).done;
    const out = opened(r);
    assert.equal(out.ok, false, 'the open failed');
    assert.match(out.error ?? '', /^could not copy .*store\.sqlite to .*store\.sqlite\.v1\.bak before migrating it \(.+\); the store is unchanged$/);
    assert.equal(S.readStoreSchemaVersion(f), '1');
    assert.deepEqual(backupNames(dir), [], 'the partial copy is not left behind');
    Store.open({ file: f }).close();
    assertGoodBackup(f, { tasks: 1, events: 400 });
    assert.deepEqual(backupNames(dir), ['store.sqlite.v1.bak']);
  });

  test('a staged copy left by an opener that died is set aside with its journal, and a complete backup taken', async () => {
    const { dir, f } = ownFolder('bak-staged');
    v1Store(f);
    const killed = await child({ role: 'interrupt', file: `${f}.v1.bak.tmp` }).done;
    assert.equal(killed.signal, 'SIGKILL');
    Store.open({ file: f }).close();
    assertGoodBackup(f, { tasks: 1 });
    const names = backupNames(dir);
    const aside = names.find((n) => /^store\.sqlite\.v1\.bak\.partial-[0-9TZ-]+$/.test(n));
    assert.ok(aside, `the staged copy is kept under a new name (${names.join(', ')})`);
    assert.deepEqual(names, ['store.sqlite.v1.bak', aside, `${aside}-journal`]);
  });
});

describe('concurrent openers of a version 1 store', () => {
  test('6 processes open a version 1 store at once: every open succeeds, one complete backup, the store is at schema 2', async () => {
    for (let round = 1; round <= 3; round++) {
      const { dir, f } = ownFolder(`race-${round}`);
      const { p } = bigV1Store(f, 2000);
      const barrier = mkdtempSync(join(home, 'barrier-'));
      const openers = 6;
      const runs = Array.from({ length: openers }, (_, id) => child({ role: 'open', file: f, barrier, id, ext: 'table' }).done);
      while (readdirSync(barrier).length < openers) await sleep(5);
      writeFileSync(join(barrier, 'go'), '');
      const results = await Promise.all(runs);
      for (const r of results) {
        const out = opened(r);
        assert.equal(r.code, 0, r.stderr);
        assert.ok(out.ok, `round ${round}: an opener failed: ${out.error}`);
        assert.equal(out.version, '2');
        assert.equal(out.extPresent, true, 'the registered extension exists for every opener');
      }
      assertGoodBackup(f, { tasks: 1, events: 2000 });
      assert.deepEqual(backupNames(dir), ['store.sqlite.v1.bak'], `round ${round}: one backup and nothing else`);
      const s = Store.open({ file: f });
      try {
        assert.equal(s.schemaVersion(), '2');
        assert.equal(s.listProjects().length, 1);
        assert.ok(s.getTaskByRequestId(`${COORDINATOR_TASK_REQUEST_PREFIX}${p.id}`), 'migrated once: the conversation task');
        assert.equal(s.listTasks({ project_id: p.id, include_coordinator_tasks: true }).length, 2);
      } finally {
        s.close();
      }
    }
  });

  for (const mode of ['migrate', 'create'] as const) {
    test(`an extension is created when a host without it ${mode === 'migrate' ? 'migrated the version 1 store' : 'created the store'} while this one waited`, async () => {
      const { dir, f } = ownFolder(`ext-race-${mode}`);
      if (mode === 'migrate') v1Store(f);
      const holder = child({ role: 'hold', file: f, barrier: dir, mode });
      await holder.line('locked');
      const waiting = child({ role: 'open', file: f, ext: 'table' });
      await waiting.line('opening');
      await sleep(500); // the opener has read the version and waits for the write lock
      writeFileSync(join(dir, 'go'), '');
      const [h, w] = await Promise.all([holder.done, waiting.done]);
      assert.equal(h.code, 0, h.stderr);
      const out = opened(w);
      assert.ok(out.ok, out.error);
      assert.equal(out.version, '2');
      assert.equal(out.extPresent, true, 'the registered extension exists when open returns');
    });
  }
});

describe('schema 2 columns', () => {
  test('origin, ui_json and meta_json are written; a bad origin is refused', () => {
    const s = Store.open({ file: file('cols') });
    try {
      const p = s.createProject({ name: 'p', path: '/tmp/p', default_branch: 'main' }).row;
      assert.ok(s.getTaskByRequestId(`${COORDINATOR_TASK_REQUEST_PREFIX}${p.id}`), 'a new project gets its conversation task');
      const base = { project_id: p.id, kind: 'single' as const, title: 'T', task_text: 'x', workflow_json: '{"name":"single","steps":[]}' };
      assert.equal(s.createTask({ ...base, request_id: 'r1' }).row.origin, 'owner');
      assert.equal(s.createTask({ ...base, request_id: 'r2', origin: 'mcp' }).row.origin, 'mcp');
      assert.equal(s.createTask({ ...base, request_id: 'r3', origin: 'schedule:CABC123' }).row.origin, 'schedule:CABC123');
      assert.throws(() => s.createTask({ ...base, request_id: 'r4', origin: 'someone' }), (e: unknown) => e instanceof JvError && e.exitCode === 2);
      assert.deepEqual(s.listTasks({ origin: 'mcp' }).map((t) => t.request_id), ['r2']);
      const conv = s.coordinatorTask(p.id);
      assert.equal(s.coordinatorTask(p.id).id, conv.id, 'one per project');
      const m = s.createMessage({ task_id: conv.id, direction: 'owner', text: 'status', meta_json: '{"name":"x"}' });
      assert.equal(m.meta_json, '{"name":"x"}');
      const session = s.createSession({ project_id: p.id, request_id: 's1', kind: 'step', runtime: 'llm', provider: 'x', model: 'm', effort: 'low', cwd: '/tmp' }).row;
      const r = s.createReport({ session_id: session.id, status: 'done', summary: 'ok', ui_json: '[]' }).row;
      assert.equal(r.ui_json, '[]');
    } finally {
      s.close();
    }
  });
});
