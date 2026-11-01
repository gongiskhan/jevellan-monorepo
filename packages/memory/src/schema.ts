// The tables of jevellan-memory (brief section 6): `memories`, its FTS5 index `memories_fts` (an external-content
// table over memories, tokenizer unicode61 with remove_diacritics 2, so "automação" matches "automacao") and the
// triggers that keep the index in step. `tags` in the index is tags_json joined by spaces. `memory_log` (M-014)
// keeps the reason and author of every archive and supersede, which the memories row has no column for.
//
// ensureSchema(db) is idempotent and takes any DatabaseSync handle: inside Jevellan the store file (the store calls it
// as a registered schema extension), outside it a file of its own.

import { DatabaseSync } from 'node:sqlite';

export const MEMORY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','lesson','environment','decision')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  superseded_by TEXT REFERENCES memories(id),
  uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags_json)));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags_json)));
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, tags_json ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(old.tags_json)));
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, (SELECT coalesce(group_concat(value, ' '), '') FROM json_each(new.tags_json)));
END;
CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, status, kind);
CREATE TABLE IF NOT EXISTS memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('archive','supersede','reword','expire')),
  reason TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL
);`;

/** Creates the memory tables, index, triggers and log when they are missing. */
export function ensureSchema(db: DatabaseSync): void {
  db.exec(MEMORY_SCHEMA_SQL);
}

/** Whether the memory tables exist in this database (a read only). */
export function schemaPresent(db: DatabaseSync): boolean {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memories','memories_fts','memory_log')").all() as Array<{ name: string }>).map((r) => r.name);
  return names.length === 3;
}

/** The schema extension the jv store applies (jevellan-core's registerSchemaExtension takes this shape). */
export const memorySchemaExtension = {
  name: 'jevellan-memory',
  present: schemaPresent,
  ensure: ensureSchema,
};

/** Whether this Node's node:sqlite can create an FTS5 table (jv doctor checks it). */
export function fts5Available(): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
