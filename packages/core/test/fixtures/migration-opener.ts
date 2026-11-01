// A child process of the migration tests in store-v2.test.ts. It does nothing unless JV_TEST_WORKER=1, so the test
// runner, which loads only *.test.js files, never runs it by itself. JV_TEST_WORKER_ARGS says what to do:
//
// - role 'open': Store.open the file (after an optional file barrier: write <barrier>/ready.<id>, spin until
//   <barrier>/go exists) with an optional schema extension registered, then print one JSON line
//   {ok, version, extPresent} or {ok: false, error}. ext 'table' keeps a table ext_rows; ext 'kill' SIGKILLs this
//   process from inside the migration transaction, as a crash half way through the migration would. fileSizeLimit
//   (set by the test through ulimit -f) makes this process ignore SIGXFSZ, so a write past the limit fails with an
//   I/O error, as on a full disk.
// - role 'hold': take the write lock of the file with a plain connection, print "locked", wait for <barrier>/go,
//   then bring the store to schema 2 the way a host without any extension does (create: a new store; migrate: a
//   version 1 store) and commit.
// - role 'interrupt': write a new database at the file in one transaction and SIGKILL this process half way, so the
//   file is left with part of its pages and a hot -journal, as an interrupted VACUUM INTO leaves its target.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerSchemaExtension, SCHEMA_SQL, SCHEMA_V2_SQL, Store } from '../../src/store.js';

interface OpenerArgs {
  role: 'open' | 'hold' | 'interrupt';
  file: string;
  barrier?: string;
  id?: number;
  ext?: 'table' | 'kill';
  mode?: 'create' | 'migrate';
  fileSizeLimit?: number;
}

const EXT_TABLE = 'ext_rows';
const extPresent = (db: DatabaseSync) =>
  db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(EXT_TABLE) !== undefined;

function waitFor(path: string): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) Atomics.wait(cell, 0, 0, 2);
}

function open(args: OpenerArgs): void {
  if (args.fileSizeLimit !== undefined) process.on('SIGXFSZ', () => {});
  if (args.ext === 'table') {
    registerSchemaExtension({
      name: 'test-ext',
      present: extPresent,
      ensure: (db) => db.exec(`CREATE TABLE IF NOT EXISTS ${EXT_TABLE} (id TEXT PRIMARY KEY)`),
    });
  } else if (args.ext === 'kill') {
    registerSchemaExtension({
      name: 'test-kill',
      present: () => false,
      ensure: () => {
        process.kill(process.pid, 'SIGKILL');
      },
    });
  }
  if (args.barrier) {
    writeFileSync(join(args.barrier, `ready.${args.id ?? 0}`), '');
    while (!existsSync(join(args.barrier, 'go'))) {
      // spin: every opener leaves the barrier within the same few microseconds
    }
  }
  process.stdout.write('opening\n');
  try {
    const store = Store.open({ file: args.file });
    try {
      process.stdout.write(`${JSON.stringify({ ok: true, version: store.schemaVersion(), extPresent: extPresent(store.db) })}\n`);
    } finally {
      store.close();
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String((error as Error).message ?? error) })}\n`);
  }
}

function hold(args: OpenerArgs): void {
  const db = new DatabaseSync(args.file);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('locked\n');
  waitFor(join(args.barrier!, 'go'));
  if (args.mode === 'create') {
    db.exec(SCHEMA_SQL);
    db.exec(SCHEMA_V2_SQL);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2');
  } else {
    db.exec(SCHEMA_V2_SQL);
    db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  }
  db.exec('COMMIT');
  db.close();
  process.stdout.write('committed\n');
}

function interrupt(args: OpenerArgs): void {
  const db = new DatabaseSync(args.file);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA cache_size = 4'); // a small page cache spills to the file before the commit
  db.exec('BEGIN');
  db.exec(SCHEMA_SQL);
  const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (let i = 0; i < 400; i++) insert.run(`k${i}`, 'x'.repeat(1000));
  process.kill(process.pid, 'SIGKILL');
}

if (process.env.JV_TEST_WORKER === '1') {
  const args = JSON.parse(process.env.JV_TEST_WORKER_ARGS ?? '{}') as OpenerArgs;
  if (args.role === 'hold') hold(args);
  else if (args.role === 'interrupt') interrupt(args);
  else open(args);
}
