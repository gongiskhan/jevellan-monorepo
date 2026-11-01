// The operations of the control plane (brief section 5): one table that the MCP server serves as tools and the UI
// server serves as JSON routes (section 7: "one route per MCP tool of section 5 with the same input and output").
// Every operation is a thin call into jevellan-core, -memory, -scheduler, -planner or -improver; it holds no state,
// returns text for humans and the JSON object `jv ... --json` prints for the same command, and refuses with JvError
// (exit 2 refused, 3 not found, 4 conflict). No operation deletes anything or touches providers, secrets or the owner's
// configuration.

import type { z } from 'zod';

/** Who called: tasks created through the MCP get origin 'mcp', through the UI origin 'ui'. */
export type Origin = 'mcp' | 'ui';

export interface OpContext {
  origin: Origin;
}

export interface OpResult {
  /** For humans (the MCP text content). */
  text: string;
  /** The JSON object of the matching `jv ... --json` (the MCP structuredContent, the UI route's body). */
  data: Record<string, unknown>;
}

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** jv_status, jv_task_create, ... */
  name: string;
  /** One sentence that names the jv command the tool mirrors. */
  description: string;
  input: S;
  /** Changes something (refused by the UI in --readonly mode). */
  mutates: boolean;
  run(input: z.output<S>, ctx: OpContext): OpResult | Promise<OpResult>;
}

/** Defines an operation with its input type inferred from the schema. */
export function op<S extends z.ZodObject>(definition: Operation<S>): Operation<S> {
  return definition;
}

/** The ids an operation's input names, for the one-line call log (never the arguments themselves). */
export function loggedIds(input: unknown): { project?: string; task?: string } {
  if (input === null || typeof input !== 'object') return {};
  const i = input as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : undefined);
  const project = s(i.project);
  const task = s(i.task) ?? s(i.after) ?? s(i.parent);
  return { ...(project ? { project } : {}), ...(task ? { task } : {}) };
}
