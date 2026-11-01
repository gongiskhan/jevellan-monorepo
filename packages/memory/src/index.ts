// jevellan-memory: what every agent of the system remembers between sessions, whatever runtime it runs on (brief
// section 6). It depends on nothing in the repository: every function takes a node:sqlite DatabaseSync handle, so
// inside Jevellan the memories live in ~/.jv/store.sqlite (the store stays the only state) and outside it anyone
// can give it a file of its own.
//
// - Scopes: 'global', 'project:<name>', 'machine:<hostname>'. A brief always includes global, the project and
//   this machine.
// - remember() normalises text (trim, whitespace collapsed) and tags (lowercase, at most 8) and returns the active
//   memory of the same scope and kind with the same normalised text instead of a duplicate (its uses go up). No
//   semantic dedupe here: that is the improver's job.
// - recall() ranks by bm25(memories_fts), plus 0.1 per 30 days of age and minus 0.05 per use (floor -0.5); lower is
//   better; only active, unexpired rows. touch counts the returned rows as used.
// - Nothing deletes a memory: archive() and supersede() are the only removals (M-014 logs their reason and author).
// - All synchronous, all in short transactions (BEGIN IMMEDIATE, or a SAVEPOINT inside a caller's transaction, so
//   the improver can apply many operations in one transaction of its own).

import { randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

export { ensureSchema, fts5Available, MEMORY_SCHEMA_SQL, memorySchemaExtension, schemaPresent } from './schema.js';

export const MEMORY_KINDS = ['fact', 'preference', 'lesson', 'environment', 'decision'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ['active', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const GLOBAL_SCOPE = 'global';
export const MAX_TAGS = 8;
export const MAX_TEXT = 2000;

/** A memories row, column names exactly. */
export interface MemoryRow {
  id: string;
  scope: string;
  kind: MemoryKind;
  text: string;
  tags_json: string;
  source: string;
  confidence: number;
  status: MemoryStatus;
  superseded_by: string | null;
  uses: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A memory as the API returns it: the row plus its tags parsed. `score` is set by recall(). */
export interface Memory extends MemoryRow {
  tags: string[];
  score?: number;
}

/** Refusals carry the jv exit codes (2 refused, 3 not found) so a command layer can map them. */
export class MemoryError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'MemoryError';
    this.exitCode = exitCode;
  }
}

// ---- scopes -----------------------------------------------------------------------------------------------

/** This machine's name as memory scopes use it (os.hostname() without a trailing ".local"). */
export function machineName(): string {
  return hostname().replace(/\.local$/i, '');
}

export function projectScope(project: string): string {
  return `project:${project}`;
}

export function machineScope(host: string = machineName()): string {
  return `machine:${host}`;
}

/** The scopes a project's agents read: global, the project and this machine. */
export function readScopes(project: string, host: string = machineName()): string[] {
  return [GLOBAL_SCOPE, projectScope(project), machineScope(host)];
}

const SCOPE = /^(global|project:[^\s]+|machine:[^\s]+)$/;
const SOURCE = /^(owner|mcp|import|session:R[0-9A-Z]{6}|improver:J[0-9A-Z]{6}|planner:J[0-9A-Z]{6}|coordinator)$/;

// ---- normalising and validation ---------------------------------------------------------------------------

/** Trimmed, with every run of whitespace collapsed to one space. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lowercase, trimmed, without empties and duplicates, at most 8. */
export function normaliseTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const v = t.trim().toLowerCase();
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_TAGS);
}

const RememberInput = z.object({
  scope: z.string().regex(SCOPE, "scope must be 'global', 'project:<name>' or 'machine:<hostname>'"),
  kind: z.enum(MEMORY_KINDS),
  text: z.string(),
  tags: z.array(z.string().max(32)).max(MAX_TAGS).optional(),
  source: z.string().regex(SOURCE, "source must be owner, mcp, import, coordinator, session:<R>, improver:<J> or planner:<J>"),
  confidence: z.number().min(0).max(1).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, 'expiresAt must be YYYY-MM-DD or an ISO time').nullable().optional(),
});
export type RememberInput = z.input<typeof RememberInput>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new MemoryError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}

// ---- plumbing ---------------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A memory id: 'M' plus 6 Crockford base32 characters. */
export function newMemoryId(): string {
  let body = '';
  for (let i = 0; i < 6; i++) body += CROCKFORD[randomInt(32)];
  return `M${body}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

let savepoints = 0;

/** Runs fn in a transaction: BEGIN IMMEDIATE, or a savepoint when the caller already holds one. */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const name = `jv_memory_${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function rows<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return (db.prepare(sql).all(...params) as object[]).map((r) => ({ ...r }) as T);
}

function row<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  const r = db.prepare(sql).get(...params) as object | undefined;
  return r === undefined ? undefined : ({ ...r } as T);
}

function toMemory(r: MemoryRow): Memory {
  let tags: string[] = [];
  try {
    const v = JSON.parse(r.tags_json) as unknown;
    if (Array.isArray(v)) tags = v.filter((t): t is string => typeof t === 'string');
  } catch {
    // a malformed tags_json reads as no tags
  }
  return { ...r, tags };
}

function activeClause(now: string): { sql: string; params: SQLInputValue[] } {
  return { sql: "status = 'active' AND (expires_at IS NULL OR expires_at > ?)", params: [now] };
}

function inList(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

// ---- writes -----------------------------------------------------------------------------------------------

/**
 * Stores a memory, or returns the active one of the same scope and kind with the same normalised text (its uses go
 * up and updated_at moves). Returns the id and whether a row was created.
 */
export function remember(db: DatabaseSync, input: RememberInput): { id: string; created: boolean } {
  const v = parse(RememberInput, input);
  const text = normaliseText(v.text);
  if (text.length < 1 || [...text].length > MAX_TEXT) throw new MemoryError(`text must be 1 to ${MAX_TEXT} characters`);
  const tags = normaliseTags(v.tags);
  return inTransaction(db, () => {
    const now = nowIso();
    const same = row<{ id: string }>(db, "SELECT id FROM memories WHERE scope = ? AND kind = ? AND text = ? AND status = 'active'", v.scope, v.kind, text);
    if (same) {
      db.prepare('UPDATE memories SET uses = uses + 1, updated_at = ? WHERE id = ?').run(now, same.id);
      return { id: same.id, created: false };
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = newMemoryId();
      if (row(db, 'SELECT id FROM memories WHERE id = ?', id)) continue;
      db.prepare(
        `INSERT INTO memories (id, scope, kind, text, tags_json, source, confidence, status, superseded_by, uses, last_used_at, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, NULL, ?, ?, ?)`,
      ).run(id, v.scope, v.kind, text, JSON.stringify(tags), v.source, v.confidence ?? 1.0, v.expiresAt ?? null, now, now);
      return { id, created: true };
    }
    throw new MemoryError('could not allocate a memory id');
  });
}

function requireActive(db: DatabaseSync, id: string): MemoryRow {
  const r = row<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', id);
  if (!r) throw new MemoryError(`no memory ${id}`, 3);
  if (r.status !== 'active') throw new MemoryError(`memory ${id} is archived`);
  return r;
}

function log(db: DatabaseSync, memoryId: string, action: 'archive' | 'supersede' | 'reword' | 'expire', reason: string, by: string, at: string): void {
  db.prepare('INSERT INTO memory_log (memory_id, at, action, reason, by) VALUES (?, ?, ?, ?, ?)').run(memoryId, at, action, reason, by);
}

/** Archives an active memory, with the reason and who did it. The row stays; nothing is deleted. */
export function archive(db: DatabaseSync, id: string, reason: string, by: string): Memory {
  if (reason.trim() === '') throw new MemoryError('archiving a memory needs a reason');
  return inTransaction(db, () => {
    requireActive(db, id);
    const now = nowIso();
    db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now, id);
    log(db, id, 'archive', reason.trim(), by, now);
    return get(db, id)!;
  });
}

export interface SupersedeInput {
  keepId: string;
  archiveIds: readonly string[];
  /** A better wording for the kept memory. */
  newText?: string;
  by: string;
  reason?: string;
}

/** Keeps one memory and archives the others with superseded_by pointing at it; optionally rewords the kept one. */
export function supersede(db: DatabaseSync, input: SupersedeInput): { kept: Memory; archived: string[] } {
  if (input.archiveIds.length === 0 && input.newText === undefined) throw new MemoryError('supersede needs ids to archive or a new text');
  return inTransaction(db, () => {
    const keep = requireActive(db, input.keepId);
    const now = nowIso();
    const archived: string[] = [];
    for (const id of input.archiveIds) {
      if (id === keep.id) throw new MemoryError(`memory ${id} cannot supersede itself`);
      requireActive(db, id);
      db.prepare("UPDATE memories SET status = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?").run(keep.id, now, id);
      log(db, id, 'supersede', input.reason ?? `superseded by ${keep.id}`, input.by, now);
      archived.push(id);
    }
    if (input.newText !== undefined) {
      const text = normaliseText(input.newText);
      if (text.length < 1 || [...text].length > MAX_TEXT) throw new MemoryError(`text must be 1 to ${MAX_TEXT} characters`);
      if (text !== keep.text) {
        db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?').run(text, now, keep.id);
        log(db, keep.id, 'reword', input.reason ?? 'reworded', input.by, now);
      }
    }
    return { kept: get(db, keep.id)!, archived };
  });
}

/** Gives an active memory an expiry date (YYYY-MM-DD or an ISO time). */
export function expire(db: DatabaseSync, id: string, expiresAt: string, by: string, reason = ''): Memory {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(expiresAt)) throw new MemoryError('expiresAt must be YYYY-MM-DD or an ISO time');
  return inTransaction(db, () => {
    requireActive(db, id);
    const now = nowIso();
    db.prepare('UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, now, id);
    log(db, id, 'expire', reason || `expires ${expiresAt}`, by, now);
    return get(db, id)!;
  });
}

// ---- reads ------------------------------------------------------------------------------------------------

export function get(db: DatabaseSync, id: string): Memory | undefined {
  const r = row<MemoryRow>(db, 'SELECT * FROM memories WHERE id = ?', id);
  return r ? toMemory(r) : undefined;
}

export interface ListOptions {
  scope?: string;
  scopes?: readonly string[];
  kind?: MemoryKind;
  /** Default 'active'; 'all' lists both. */
  status?: MemoryStatus | 'all';
  limit?: number;
}

/** Memories, newest first. */
export function list(db: DatabaseSync, options: ListOptions = {}): Memory[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const scopes = options.scopes ?? (options.scope ? [options.scope] : undefined);
  if (scopes) {
    where.push(`scope IN (${inList(scopes)})`);
    params.push(...scopes);
  }
  if (options.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  const status = options.status ?? 'active';
  if (status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
  return rows<MemoryRow>(db, `SELECT * FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`, ...params).map(toMemory);
}

/** The log of archives, supersedes, rewordings and expiries of a memory, oldest first. */
export function history(db: DatabaseSync, id: string): Array<{ at: string; action: string; reason: string; by: string }> {
  return rows(db, 'SELECT at, action, reason, by FROM memory_log WHERE memory_id = ? ORDER BY id', id);
}

/**
 * An FTS5 query from free text: every word quoted (so nothing the person typed is FTS syntax), joined with OR so
 * a memory matching some of the words still ranks. Undefined when the text has no word at all.
 */
export function ftsQuery(text: string): string | undefined {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words || words.length === 0) return undefined;
  return [...new Set(words.map((w) => w.toLowerCase()))]
    .slice(0, 32)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export interface RecallOptions {
  scopes: readonly string[];
  query: string;
  limit?: number;
  /** Count the returned memories as used (default true). */
  touch?: boolean;
  /** For tests: the time recency is measured from. */
  now?: Date;
}

const DAY = 86_400_000;

/** The adjusted rank of a memory (lower is better): bm25 plus age and use adjustments (section 6). */
export function adjustedScore(bm25: number, createdAt: string, uses: number, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(createdAt)) / DAY);
  return bm25 + 0.1 * (ageDays / 30) + Math.max(-0.5, -0.05 * uses);
}

/** Matching active memories of the scopes, best first. An empty query returns the newest active memories. */
export function recall(db: DatabaseSync, options: RecallOptions): Memory[] {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
  const now = options.now ?? new Date();
  const active = activeClause(now.toISOString());
  if (options.scopes.length === 0) return [];
  const q = ftsQuery(options.query);
  let found: Memory[];
  if (q === undefined) {
    found = rows<MemoryRow>(
      db,
      `SELECT * FROM memories WHERE scope IN (${inList(options.scopes)}) AND ${active.sql} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
      ...options.scopes,
      ...active.params,
    ).map(toMemory);
  } else {
    const candidates = rows<MemoryRow & { rank: number }>(
      db,
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.scope IN (${inList(options.scopes)}) AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
       ORDER BY rank LIMIT ${Math.max(50, limit * 5)}`,
      q,
      ...options.scopes,
      ...active.params,
    );
    found = candidates
      .map((c) => {
        const { rank, ...r } = c;
        return { ...toMemory(r as MemoryRow), score: adjustedScore(rank, c.created_at, c.uses, now) };
      })
      .sort((a, b) => a.score! - b.score! || b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  if (options.touch !== false && found.length > 0) touch(db, found.map((m) => m.id));
  return found;
}

/** Counts memories as used: uses + 1 and last_used_at now (updated_at does not move). */
export function touch(db: DatabaseSync, ids: readonly string[]): void {
  if (ids.length === 0) return;
  inTransaction(db, () => {
    db.prepare(`UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id IN (${inList(ids)})`).run(nowIso(), ...ids);
  });
}

// ---- the brief --------------------------------------------------------------------------------------------

export interface BriefOptions {
  project: string;
  /** The task title; with the first 400 characters of the task text it makes the recall query. */
  title?: string;
  taskText: string;
  duty?: string;
  maxChars?: number;
  maxItems?: number;
  host?: string;
  now?: Date;
}

/** One brief line: "- (<kind>) <text>" with " [tag, tag]" when the memory has tags. */
export function briefLine(m: Pick<Memory, 'kind' | 'text' | 'tags'>): string {
  return `- (${m.kind}) ${m.text}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`;
}

/**
 * The memory brief of a task (section 6): the environment and preference memories of global, the project and this
 * machine first (newest first), then what recall finds for the task title and the first 400 characters of its text,
 * without duplicates, one line each, at most maxItems lines and maxChars characters (cut on a line boundary). Every
 * memory in it counts as used. Returns the lines' text ('' when there is nothing) and the ids used.
 */
export function buildBrief(db: DatabaseSync, options: BriefOptions): { text: string; ids: string[] } {
  const maxChars = options.maxChars ?? 6000;
  const maxItems = options.maxItems ?? 20;
  const now = options.now ?? new Date();
  const scopes = readScopes(options.project, options.host);
  const active = activeClause(now.toISOString());
  const standing = rows<MemoryRow>(
    db,
    `SELECT * FROM memories WHERE scope IN (${inList(scopes)}) AND kind IN ('environment','preference') AND ${active.sql} ORDER BY created_at DESC, rowid DESC LIMIT ${maxItems}`,
    ...scopes,
    ...active.params,
  ).map(toMemory);
  const query = `${options.title ?? ''} ${options.taskText.slice(0, 400)}`;
  const recalled = recall(db, { scopes, query, limit: maxItems, touch: false, now });
  const chosen: Memory[] = [];
  for (const m of [...standing, ...recalled]) {
    if (chosen.length >= maxItems) break;
    if (!chosen.some((c) => c.id === m.id)) chosen.push(m);
  }
  const lines: string[] = [];
  const ids: string[] = [];
  let size = 0;
  for (const m of chosen) {
    const line = briefLine(m);
    const add = (lines.length ? 1 : 0) + line.length;
    if (size + add > maxChars) break;
    lines.push(line);
    ids.push(m.id);
    size += add;
  }
  touch(db, ids);
  return { text: lines.join('\n'), ids };
}

/** The memory brief text of a task ('' when the project remembers nothing). */
export function brief(db: DatabaseSync, options: BriefOptions): string {
  return buildBrief(db, options).text;
}

// ---- exports ----------------------------------------------------------------------------------------------

const KIND_HEADINGS: Record<MemoryKind, string> = {
  environment: 'Environment',
  preference: 'Preferences',
  fact: 'Facts',
  lesson: 'Lessons',
  decision: 'Decisions',
};

/** The active memories of a scope as Markdown: a heading per kind, one line per memory with its id. */
export function exportMarkdown(db: DatabaseSync, scope: string): string {
  const all = list(db, { scope, status: 'active', limit: 10_000 });
  const out = [`# Memory: ${scope}`, ''];
  if (all.length === 0) out.push('Nothing remembered yet.', '');
  for (const kind of ['environment', 'preference', 'fact', 'lesson', 'decision'] as const) {
    const of = all.filter((m) => m.kind === kind);
    if (of.length === 0) continue;
    out.push(`## ${KIND_HEADINGS[kind]}`, '');
    for (const m of of) out.push(`- ${m.text}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''} (${m.id})`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Regenerates a project's memory.md (~/.jv/projects/<name>/memory.md) for people and for agents that only read
 * files. Never read back by the system. Written atomically, mode 600.
 */
export function writeProjectMemoryFile(db: DatabaseSync, project: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, exportMarkdown(db, projectScope(project)), { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Counts of active memories by scope (for the UI's Memory chip). */
export function countByScope(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows<{ scope: string; n: number }>(db, "SELECT scope, count(*) AS n FROM memories WHERE status = 'active' GROUP BY scope")) out[r.scope] = r.n;
  return out;
}
