// The worker memory tools (brief section 3), served next to jv_report by the in-process SDK server (claude-sdk) and
// the stdio worker server (claude-tmux, codex):
//
// - jv_remember { kind, text (1..2000), tags? (at most 8, each 1..32, lowercased), scope? 'project' | 'global' }
//   writes through jevellan-memory with source session:<R> and answers "Remembered (<id>)." or "Already known (<id>).";
//   a project memory regenerates ~/.jv/projects/<name>/memory.md.
// - jv_recall { query (1..200), limit? 1..20 } answers the matching memories of the task's project and the global
//   scope, one per line: "[<id>] (<kind>) <text>".
//
// Both go through the memory port (memory-port.ts); without a registered implementation they answer that memory is
// not available in this process, as an error result, and change nothing.

import { z } from 'zod';
import { memoryApi, type MemoryKind } from '../memory-port.js';
import { paths } from '../paths.js';
import { redact } from '../redact.js';
import { resolveReportSession } from '../report.js';
import type { Store } from '../store.js';

export const REMEMBER_TOOL_NAME = 'jv_remember';
export const RECALL_TOOL_NAME = 'jv_recall';

export const REMEMBER_TOOL_DESCRIPTION =
  'Remember a durable fact, preference, lesson, environment detail or decision about this project for every later ' +
  'session, on any runtime. Use it for what a future worker would otherwise have to rediscover (how to run or test the ' +
  'project, a quirk of its setup, a choice the owner made). Not for what the task text or the code already says. ' +
  "scope 'project' (default) or 'global' for what holds across every project.";

export const RECALL_TOOL_DESCRIPTION =
  'Search what this project (and the global scope) remembers. Returns one memory per line: [id] (kind) text.';

export const RememberArgsSchema = z.strictObject({
  kind: z.enum(['fact', 'preference', 'lesson', 'environment', 'decision']),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(32)).max(8).optional(),
  scope: z.enum(['project', 'global']).default('project'),
});

export const RecallArgsSchema = z.strictObject({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});

export interface ToolResult {
  text: string;
  isError: boolean;
}

const UNAVAILABLE: ToolResult = { text: 'Memory is not available in this process.', isError: true };

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

function projectOf(store: Store, sessionId: string): { name: string; session: string } {
  const session = resolveReportSession(store, sessionId);
  const project = store.getProject(session.project_id);
  if (!project) throw new Error(`no project ${session.project_id}`);
  return { name: project.name, session: session.id };
}

/** jv_remember for the conversation of session row `sessionId`. */
export function rememberTool(store: Store, sessionId: string, args: unknown): ToolResult {
  const memory = memoryApi();
  if (!memory) return UNAVAILABLE;
  const parsed = RememberArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return { text: `The memory is not valid: ${issues(parsed.error)}`, isError: true };
  try {
    const { name, session } = projectOf(store, sessionId);
    const scope = parsed.data.scope === 'global' ? 'global' : memory.projectScope(name);
    const r = memory.remember(store.db, {
      scope,
      kind: parsed.data.kind as MemoryKind,
      text: redact(parsed.data.text),
      ...(parsed.data.tags ? { tags: parsed.data.tags.map((t) => t.toLowerCase()) } : {}),
      source: `session:${session}`,
    });
    if (scope !== 'global') memory.writeProjectMemoryFile(store.db, name, `${paths.projectDir(name)}/memory.md`);
    return { text: r.created ? `Remembered (${r.id}).` : `Already known (${r.id}).`, isError: false };
  } catch (e) {
    return { text: `The memory could not be recorded: ${redact(e instanceof Error ? e.message : String(e))}`, isError: true };
  }
}

/** jv_recall for the conversation of session row `sessionId`. */
export function recallTool(store: Store, sessionId: string, args: unknown): ToolResult {
  const memory = memoryApi();
  if (!memory) return UNAVAILABLE;
  const parsed = RecallArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return { text: `The query is not valid: ${issues(parsed.error)}`, isError: true };
  try {
    const { name } = projectOf(store, sessionId);
    const found = memory.recall(store.db, {
      scopes: ['global', memory.projectScope(name)],
      query: parsed.data.query,
      limit: parsed.data.limit ?? 10,
    });
    if (found.length === 0) return { text: 'Nothing remembered matches.', isError: false };
    return { text: found.map((m) => `[${m.id}] (${m.kind}) ${m.text}`).join('\n'), isError: false };
  } catch (e) {
    return { text: `The memory could not be searched: ${redact(e instanceof Error ? e.message : String(e))}`, isError: true };
  }
}

/** The JSON Schema of a tool's input (MCP tools/list), from zod's toJSONSchema. */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
