// The JSON objects of the jv commands whose `--json` output is built in the command module rather than in a core or
// package function, replicated here exactly so a tool's structured content equals what the command prints (brief
// section 5). Each names the command module it copies; a change to one of those outputs changes this file in the same
// change (the tests compare both on one store):
//
// - jv doctor (packages/cli/src/commands/doctor.ts): {ok, checks}, exit 2 when a check FAILs; an unknown check name
//   is a refusal.
// - jv project list (packages/cli/src/commands/project.ts) prints the rows as a JSON array; MCP structured content
//   must be an object, so the tool wraps them as {projects}.
// - jv memory search|add|archive|list (packages/cli/src/commands/memory.ts): {query, scopes, memories}, {id, created,
//   memory}, {memory}, {memories}. Writes through MCP have source 'mcp' (section 6); a write to a project's scope
//   regenerates ~/.jv/projects/<name>/memory.md.
// - jv bot status (the bot's command, brief section 8): {bot: readBotState, config: bot.json read leniently over the
//   defaults of section 8, service: {file, installed}}; the bot's command builds the same object.

import { existsSync, readFileSync } from 'node:fs';
import { runChecks, botServiceFile, type CheckResult, type DoctorDeps } from 'jevellan-core/doctor';
import { readBotState, type BotState } from 'jevellan-core/bot-state';
import { ownerHome } from 'jevellan-core/env';
import { JvError, notFound, refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { botConfigFile } from 'jevellan-core/limits';
import { paths } from 'jevellan-core/paths';
import type { Store } from 'jevellan-core/store';
import * as memory from 'jevellan-memory';

// ---- jv doctor -------------------------------------------------------------------------------------------------

export interface DoctorView {
  ok: boolean;
  checks: CheckResult[];
}

/** `jv doctor --json` and its exit code (2 when any check is FAIL). */
export async function doctorView(names: readonly string[] = [], deps: Partial<DoctorDeps> = {}): Promise<{ view: DoctorView; exitCode: number }> {
  let checks: CheckResult[];
  try {
    checks = await runChecks(names, deps);
  } catch (error) {
    throw refused(error instanceof Error ? error.message : String(error));
  }
  const failed = checks.some((c) => c.status === 'FAIL');
  return { view: { ok: !failed, checks }, exitCode: failed ? 2 : 0 };
}

// ---- jv memory ---------------------------------------------------------------------------------------------------

export type Memory = memory.Memory;

/** jevellan-memory refusals carry jv's exit codes; they become JvErrors (3 stays 3, anything else 2). */
function asJv<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof memory.MemoryError) throw new JvError(e.message, e.exitCode === 3 ? 3 : 2);
    throw e;
  }
}

function memoryProject(store: Store, name: string): string {
  const p = store.getProjectByName(name);
  if (!p) throw notFound(`no project ${name}`);
  return p.name;
}

function allScopes(store: Store): string[] {
  return (store.db.prepare("SELECT DISTINCT scope FROM memories WHERE status = 'active' ORDER BY scope").all() as Array<{ scope: string }>).map((r) => r.scope);
}

function writeMemoryFile(store: Store, scope: string): void {
  if (!scope.startsWith('project:')) return;
  const project = scope.slice('project:'.length);
  memory.writeProjectMemoryFile(store.db, project, `${paths.projectDir(project)}/memory.md`);
}

export interface MemorySearchView {
  query: string;
  scopes: string[];
  memories: Memory[];
}

/** `jv memory search [--project N] [--limit N] "query"`: the project's read scopes, or every active scope. */
export function memorySearch(store: Store, input: { query: string; project?: string; limit?: number }): MemorySearchView {
  if (input.query.trim() === '') throw refused('the query is required');
  const scopes = input.project ? memory.readScopes(memoryProject(store, input.project)) : allScopes(store);
  const found = memory.recall(store.db, { scopes, query: input.query, limit: input.limit ?? 20, touch: false });
  return { query: input.query, scopes, memories: found };
}

export interface MemoryAddInput {
  kind: memory.MemoryKind;
  text: string;
  tags?: string[];
  scope: 'global' | 'project';
  project?: string;
}

export interface MemoryAddView {
  id: string;
  created: boolean;
  memory: Memory;
}

/** `jv memory add --scope global|project [--project N] --kind K [--tag t]... "text"` with the given source. */
export function memoryAdd(store: Store, input: MemoryAddInput, source: string): MemoryAddView {
  if (input.text.trim() === '') throw refused('the text is required');
  let project: string | undefined;
  if (input.scope === 'project') {
    if (!input.project) throw refused('project is required for scope project');
    project = memoryProject(store, input.project);
  }
  const scope = project ? memory.projectScope(project) : memory.GLOBAL_SCOPE;
  const r = asJv(() => memory.remember(store.db, { scope, kind: input.kind, text: input.text, tags: input.tags ?? [], source }));
  writeMemoryFile(store, scope);
  return { ...r, memory: memory.get(store.db, r.id)! };
}

/** `jv memory archive M --reason "..."` by `by`. */
export function memoryArchive(store: Store, id: string, reason: string, by: string): { memory: Memory } {
  if (reason.trim() === '') throw refused('the reason is required');
  const m = asJv(() => memory.archive(store.db, normalizeId(id), reason, by));
  writeMemoryFile(store, m.scope);
  return { memory: m };
}

/** `jv memory list [--project N] [--kind K] [--status active|archived|all] [--limit N]`. */
export function memoryList(store: Store, input: { project?: string; kind?: memory.MemoryKind; status?: 'active' | 'archived' | 'all'; limit?: number } = {}): { memories: Memory[] } {
  const rows = memory.list(store.db, {
    ...(input.project ? { scope: memory.projectScope(memoryProject(store, input.project)) } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    status: input.status ?? 'active',
    limit: input.limit ?? 200,
  });
  return { memories: rows };
}

/** One memory as a line: id, scope, kind, text, tags and the archive state (jv memory's own line). */
export function memoryLine(m: Memory): string {
  const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
  const state = m.status === 'archived' ? ` (archived${m.superseded_by ? `, superseded by ${m.superseded_by}` : ''})` : '';
  return `${m.id} ${m.scope} (${m.kind}) ${m.text}${tags}${state}`;
}

// ---- jv bot status ---------------------------------------------------------------------------------------------

/** bot.json's defaults (brief section 8). */
export const BOT_CONFIG_DEFAULTS = Object.freeze({
  tickSeconds: 15,
  limits: Object.freeze({ perProject: 2, total: 4 }),
  quietHours: null,
  health: Object.freeze({ bind: '127.0.0.1', port: 7073 }),
  logLines: 20000,
});

export type BotConfig = Record<string, unknown> & {
  tickSeconds: unknown;
  limits: Record<string, unknown>;
  quietHours: unknown;
  health: Record<string, unknown>;
  logLines: unknown;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** bot.json over the defaults, read leniently (the bot validates it strictly at its start): the defaults when absent. */
export function readBotConfig(file: string = botConfigFile()): BotConfig {
  let raw: unknown;
  try {
    raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  } catch {
    raw = undefined;
  }
  const f = isObject(raw) ? raw : {};
  return {
    ...BOT_CONFIG_DEFAULTS,
    ...f,
    limits: { ...BOT_CONFIG_DEFAULTS.limits, ...(isObject(f.limits) ? f.limits : {}) },
    health: { ...BOT_CONFIG_DEFAULTS.health, ...(isObject(f.health) ? f.health : {}) },
  };
}

export interface BotStatusView {
  bot: BotState;
  config: BotConfig;
  service: { file: string | null; installed: boolean };
}

/** `jv bot status --json`: the heartbeat as the store has it (it works when the bot is not running). */
export function botStatusView(store: Store, now: number = Date.now(), options: { platform?: NodeJS.Platform; home?: string } = {}): BotStatusView {
  const file = botServiceFile(options.platform ?? process.platform, options.home ?? ownerHome()) ?? null;
  return {
    bot: readBotState(store, now),
    config: readBotConfig(),
    service: { file, installed: file !== null && existsSync(file) },
  };
}
