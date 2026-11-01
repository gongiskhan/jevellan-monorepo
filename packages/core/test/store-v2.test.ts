// Schema 2 (brief section 3): schema 1 is the skills repository's byte for byte, the migration from 1 to 2 (backup
// once, columns and tables only, the coordinator conversation task, extensions), refusals of newer stores, and the
// schema 2 columns through the store's writers.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

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
    const expected = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'test', 'fixtures', 'schema-v1.sqlite-master.json'), 'utf8')) as object[];
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
