// jevellan-memory on temporary databases: schema and triggers, dedupe, FTS ranking with diacritics, recency and use
// adjustments, scopes, the brief's caps, archive and supersede visibility, expiry, export, nested transactions.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as M from '../src/index.js';

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'jv-memory-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function db(): DatabaseSync {
  const d = new DatabaseSync(join(dir, `m-${++n}.sqlite`));
  d.exec('PRAGMA journal_mode = WAL');
  M.ensureSchema(d);
  return d;
}

const P = M.projectScope('sandbox');

describe('schema', () => {
  test('ensureSchema is idempotent and schemaPresent sees it; FTS5 is available in this Node', () => {
    const d = new DatabaseSync(':memory:');
    assert.equal(M.schemaPresent(d), false);
    M.ensureSchema(d);
    M.ensureSchema(d);
    assert.equal(M.schemaPresent(d), true);
    assert.equal(M.fts5Available(), true);
    assert.equal(M.memorySchemaExtension.name, 'jevellan-memory');
    d.close();
  });

  test('the triggers keep the index in step after an update of text and tags', () => {
    const d = db();
    const { id } = M.remember(d, { scope: P, kind: 'fact', text: 'The dev server is npm start on port 4173', tags: ['web'], source: 'owner' });
    assert.equal(M.recall(d, { scopes: [P], query: '4173' }).length, 1);
    d.prepare("UPDATE memories SET text = 'The dev server listens on port 5000', tags_json = '[\"server\"]' WHERE id = ?").run(id);
    assert.equal(M.recall(d, { scopes: [P], query: '4173' }).length, 0, 'the old text is gone from the index');
    assert.equal(M.recall(d, { scopes: [P], query: '5000' })[0]!.id, id);
    assert.equal(M.recall(d, { scopes: [P], query: 'server' })[0]!.id, id, 'tags are indexed');
    assert.equal(M.recall(d, { scopes: [P], query: 'web' }).length, 0, 'the old tag is gone');
    d.close();
  });
});

describe('remember', () => {
  test('normalises text and tags; the same scope, kind and text is one memory whose uses go up', () => {
    const d = db();
    const a = M.remember(d, { scope: P, kind: 'environment', text: '  tests need   npm ci\nfirst ', tags: ['NPM', 'npm', ' Setup '], source: 'session:RABC123' });
    assert.equal(a.created, true);
    const m = M.get(d, a.id)!;
    assert.equal(m.text, 'tests need npm ci first');
    assert.deepEqual(m.tags, ['npm', 'setup']);
    assert.match(m.id, /^M[0-9A-Z]{6}$/);
    const b = M.remember(d, { scope: P, kind: 'environment', text: 'tests need npm ci first', source: 'owner' });
    assert.deepEqual(b, { id: a.id, created: false });
    assert.equal(M.get(d, a.id)!.uses, 1);
    assert.equal(M.remember(d, { scope: P, kind: 'fact', text: 'tests need npm ci first', source: 'owner' }).created, true, 'another kind is another memory');
    assert.equal(M.remember(d, { scope: 'global', kind: 'environment', text: 'tests need npm ci first', source: 'owner' }).created, true, 'another scope is another memory');
    d.close();
  });

  test('refuses bad input with exit 2', () => {
    const d = db();
    const refused = (input: object) => assert.throws(() => M.remember(d, input as M.RememberInput), (e: unknown) => e instanceof M.MemoryError && e.exitCode === 2);
    refused({ scope: 'nowhere', kind: 'fact', text: 'x', source: 'owner' });
    refused({ scope: P, kind: 'opinion', text: 'x', source: 'owner' });
    refused({ scope: P, kind: 'fact', text: '   ', source: 'owner' });
    refused({ scope: P, kind: 'fact', text: 'x'.repeat(2001), source: 'owner' });
    refused({ scope: P, kind: 'fact', text: 'x', source: 'someone' });
    refused({ scope: P, kind: 'fact', text: 'x', source: 'owner', tags: Array.from({ length: 9 }, (_, i) => `t${i}`) });
    d.close();
  });
});

describe('recall', () => {
  test('diacritics: automação matches automacao and the other way round', () => {
    const d = db();
    const { id } = M.remember(d, { scope: P, kind: 'fact', text: 'A automação de faturas corre às 03:00', source: 'owner' });
    assert.equal(M.recall(d, { scopes: [P], query: 'automacao' })[0]?.id, id);
    const plain = M.remember(d, { scope: P, kind: 'fact', text: 'the automacao folder holds the scripts', source: 'owner' }).id;
    assert.ok(M.recall(d, { scopes: [P], query: 'automação' }).some((m) => m.id === plain));
    d.close();
  });

  test('ranks by bm25 with recency and use adjustments; scopes, archived and expired rows are left out', () => {
    const d = db();
    const now = new Date('2026-11-01T12:00:00Z');
    const old = M.remember(d, { scope: P, kind: 'fact', text: 'deploy checklist lives in docs', source: 'owner' }).id;
    const fresh = M.remember(d, { scope: P, kind: 'fact', text: 'deploy checklist is in the wiki now', source: 'owner' }).id;
    d.prepare("UPDATE memories SET created_at = '2025-11-01T12:00:00Z' WHERE id = ?").run(old);
    let got = M.recall(d, { scopes: [P], query: 'deploy checklist', now, touch: false });
    assert.equal(got[0]!.id, fresh, 'a year of age costs 1.2');
    assert.ok(got[1]!.score! > got[0]!.score!);
    d.prepare('UPDATE memories SET uses = 100 WHERE id = ?').run(old);
    got = M.recall(d, { scopes: [P], query: 'deploy checklist', now, touch: false });
    assert.equal(M.adjustedScore(0, '2026-11-01T12:00:00Z', 100, now), -0.5, 'the use bonus floors at -0.5');
    M.remember(d, { scope: M.projectScope('other'), kind: 'fact', text: 'deploy checklist elsewhere', source: 'owner' });
    assert.equal(M.recall(d, { scopes: [P], query: 'deploy' }).length, 2, 'another project is not read');
    M.archive(d, fresh, 'moved', 'owner');
    assert.deepEqual(M.recall(d, { scopes: [P], query: 'deploy' }).map((m) => m.id), [old]);
    M.expire(d, old, '2026-10-01', 'owner');
    assert.deepEqual(M.recall(d, { scopes: [P], query: 'deploy' }), [], 'an expired memory is not recalled');
    d.close();
  });

  test('touch counts returned rows as used; an empty query returns the newest; FTS syntax in a query is harmless', () => {
    const d = db();
    const a = M.remember(d, { scope: P, kind: 'fact', text: 'first fact', source: 'owner' }).id;
    const b = M.remember(d, { scope: P, kind: 'fact', text: 'second fact', source: 'owner' }).id;
    d.prepare("UPDATE memories SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(a);
    assert.deepEqual(M.recall(d, { scopes: [P], query: '', limit: 1 }).map((m) => m.id), [b]);
    assert.equal(M.get(d, b)!.uses, 1);
    assert.ok(M.get(d, b)!.last_used_at);
    assert.equal(M.get(d, a)!.uses, 0);
    assert.doesNotThrow(() => M.recall(d, { scopes: [P], query: 'fact" OR NEAR(x AND -y) *' }));
    assert.equal(M.ftsQuery('  ,,  '), undefined);
    d.close();
  });
});

describe('brief', () => {
  test('environment and preference memories first, then what recall finds; every line formatted; used ones counted', () => {
    const d = db();
    const env = M.remember(d, { scope: P, kind: 'environment', text: 'tests need SANDBOX_DATA_DIR set', source: 'owner' }).id;
    const pref = M.remember(d, { scope: 'global', kind: 'preference', text: 'the owner reads reports on a phone', tags: ['owner'], source: 'owner' }).id;
    const host = M.remember(d, { scope: M.machineScope('box'), kind: 'environment', text: 'browsers live under the cache folder', source: 'owner' }).id;
    const fact = M.remember(d, { scope: P, kind: 'fact', text: 'invoices totals are rounded half up', source: 'owner' }).id;
    M.remember(d, { scope: P, kind: 'lesson', text: 'nothing about this task at all', source: 'owner' });
    const out = M.buildBrief(d, { project: 'sandbox', title: 'Invoice rounding', taskText: 'Fix the rounding of invoices totals', host: 'box' });
    const lines = out.text.split('\n');
    assert.deepEqual(new Set(out.ids.slice(0, 3)), new Set([env, pref, host]), 'standing memories first');
    assert.ok(out.ids.includes(fact));
    assert.ok(lines.includes('- (preference) the owner reads reports on a phone [owner]'));
    assert.ok(lines.includes('- (fact) invoices totals are rounded half up'));
    assert.equal(M.get(d, fact)!.uses, 1, 'a memory in a brief counts as used');
    assert.equal(M.brief(d, { project: 'nothing-here', taskText: 'x', host: 'nowhere' }).length > 0, true, 'global still applies');
    const empty = new DatabaseSync(':memory:');
    M.ensureSchema(empty);
    assert.equal(M.brief(empty, { project: 'p', taskText: 'x' }), '');
    empty.close();
    d.close();
  });

  test('at most maxItems lines and maxChars characters, cut on a line boundary', () => {
    const d = db();
    for (let i = 0; i < 40; i++) M.remember(d, { scope: P, kind: 'environment', text: `setting number ${i} ${'x'.repeat(200)}`, source: 'owner' });
    const capped = M.brief(d, { project: 'sandbox', taskText: 'setting', host: 'none' });
    assert.equal(capped.split('\n').length, 20, 'default maxItems 20');
    const small = M.brief(d, { project: 'sandbox', taskText: 'setting', maxChars: 700, host: 'none' });
    assert.ok(small.length <= 700);
    assert.ok(small.split('\n').every((l) => l.startsWith('- (environment) setting number ')), 'only whole lines');
    const big = M.brief(d, { project: 'sandbox', taskText: 'setting', maxItems: 40, host: 'none' });
    assert.ok(big.length <= 6000, 'default maxChars 6000');
    d.close();
  });
});

describe('archive, supersede, expire', () => {
  test('archived memories stay in the table, listed only on request, with their reason in the log', () => {
    const d = db();
    const { id } = M.remember(d, { scope: P, kind: 'fact', text: 'the API is on v1', source: 'owner' });
    const a = M.archive(d, id, 'v2 shipped', 'owner');
    assert.equal(a.status, 'archived');
    assert.deepEqual(M.list(d, { scope: P }).map((m) => m.id), []);
    assert.deepEqual(M.list(d, { scope: P, status: 'archived' }).map((m) => m.id), [id]);
    assert.equal((d.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n, 1, 'nothing deleted');
    assert.deepEqual(M.history(d, id).map((h) => [h.action, h.reason, h.by]), [['archive', 'v2 shipped', 'owner']]);
    assert.throws(() => M.archive(d, id, 'again', 'owner'), (e: unknown) => e instanceof M.MemoryError && e.exitCode === 2);
    assert.throws(() => M.archive(d, 'MZZZZZZ', 'x', 'owner'), (e: unknown) => e instanceof M.MemoryError && e.exitCode === 3);
    assert.throws(() => M.archive(d, id, ' ', 'owner'), (e: unknown) => e instanceof M.MemoryError);
    d.close();
  });

  test('supersede archives with superseded_by, rewords the kept memory, and the new wording is searchable', () => {
    const d = db();
    const keep = M.remember(d, { scope: P, kind: 'environment', text: 'run npm ci before the tests', source: 'owner' }).id;
    const dup = M.remember(d, { scope: P, kind: 'environment', text: 'npm ci has to run before npm test', source: 'session:RABC123' }).id;
    const r = M.supersede(d, { keepId: keep, archiveIds: [dup], newText: 'The sandbox tests need npm ci first', by: 'improver:JABC123' });
    assert.deepEqual(r.archived, [dup]);
    assert.equal(r.kept.text, 'The sandbox tests need npm ci first');
    assert.equal(M.get(d, dup)!.superseded_by, keep);
    assert.equal(M.get(d, dup)!.status, 'archived');
    assert.equal(M.recall(d, { scopes: [P], query: 'sandbox' })[0]!.id, keep);
    assert.throws(() => M.supersede(d, { keepId: keep, archiveIds: [keep], by: 'owner' }), M.MemoryError);
    assert.throws(() => M.supersede(d, { keepId: keep, archiveIds: [dup], by: 'owner' }), M.MemoryError, 'an archived id is refused');
    d.close();
  });

  test('operations nest inside a caller transaction (savepoints) and roll back with it', () => {
    const d = db();
    d.exec('BEGIN IMMEDIATE');
    const a = M.remember(d, { scope: P, kind: 'fact', text: 'inside one', source: 'owner' }).id;
    M.remember(d, { scope: P, kind: 'fact', text: 'inside two', source: 'owner' });
    M.archive(d, a, 'test', 'owner');
    d.exec('ROLLBACK');
    assert.equal(M.list(d, { scope: P, status: 'all' }).length, 0);
    d.close();
  });
});

describe('export', () => {
  test('exportMarkdown has a heading per kind and the ids; the project memory file is written atomically, mode 600', () => {
    const d = db();
    const e = M.remember(d, { scope: P, kind: 'environment', text: 'node 22 is required', tags: ['node'], source: 'owner' }).id;
    const f = M.remember(d, { scope: P, kind: 'fact', text: 'invoices are in euros', source: 'owner' }).id;
    const md = M.exportMarkdown(d, P);
    assert.match(md, /^# Memory: project:sandbox\n/);
    assert.ok(md.includes(`## Environment\n\n- node 22 is required [node] (${e})`));
    assert.ok(md.includes(`## Facts\n\n- invoices are in euros (${f})`));
    assert.ok(md.indexOf('## Environment') < md.indexOf('## Facts'));
    const file = join(dir, 'projects', 'sandbox', 'memory.md');
    M.writeProjectMemoryFile(d, 'sandbox', file);
    assert.equal(readFileSync(file, 'utf8'), md);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(M.countByScope(d), { [P]: 2 });
    assert.match(M.exportMarkdown(d, 'global'), /Nothing remembered yet/);
    d.close();
  });
});
