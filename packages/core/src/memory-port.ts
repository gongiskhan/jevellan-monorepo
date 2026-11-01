// The memory port of jevellan-core (M-015). Every agent's prompt carries the memory brief and every worker can
// remember and recall (brief sections 3 and 6), but jevellan-core depends on no package of the repository, so the
// implementation (jevellan-memory) is registered at process start by whoever owns the process: the jv CLI's entry
// registers it before any command runs, so `jv run`, the worker MCP server, the bot, the UI and the MCP server all
// have it. A process that registered nothing gets no memory block and the memory tools answer that memory is not
// available; nothing else changes.

import type { DatabaseSync } from 'node:sqlite';

export type MemoryKind = 'fact' | 'preference' | 'lesson' | 'environment' | 'decision';

export interface MemoryRecord {
  id: string;
  scope: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  source: string;
  status: string;
  uses: number;
  created_at: string;
}

/** The part of jevellan-memory jevellan-core calls; jevellan-memory's module namespace satisfies it. */
export interface MemoryApi {
  remember(
    db: DatabaseSync,
    input: { scope: string; kind: MemoryKind; text: string; tags?: string[]; source: string; confidence?: number; expiresAt?: string | null },
  ): { id: string; created: boolean };
  recall(db: DatabaseSync, options: { scopes: readonly string[]; query: string; limit?: number; touch?: boolean }): MemoryRecord[];
  buildBrief(
    db: DatabaseSync,
    options: { project: string; title?: string; taskText: string; duty?: string; maxChars?: number; maxItems?: number },
  ): { text: string; ids: string[] };
  writeProjectMemoryFile(db: DatabaseSync, project: string, path: string): void;
  projectScope(project: string): string;
  readScopes(project: string): string[];
}

let registered: MemoryApi | undefined;

/** Registers the memory implementation for this process (the last registration wins). */
export function registerMemory(api: MemoryApi): void {
  registered = api;
}

/** The registered memory implementation, if any. */
export function memoryApi(): MemoryApi | undefined {
  return registered;
}

/** The heading of the memory block in worker and coordinator prompts (brief section 3). */
export const MEMORY_BLOCK_HEADING = 'What this project remembers:';

/** The memory block of a prompt: the heading and the brief, or undefined when there is nothing to say. */
export function memoryBlock(briefText: string | undefined): string | undefined {
  if (briefText === undefined || briefText.trim() === '') return undefined;
  return `${MEMORY_BLOCK_HEADING}\n${briefText.trim()}`;
}
