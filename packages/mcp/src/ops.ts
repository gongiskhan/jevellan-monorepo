// The operations of the control plane (brief section 5): one table that the MCP server serves as tools and the UI
// server serves as JSON routes (section 7: "one route per MCP tool of section 5 with the same input and output").
// Every operation is a thin call into jevellan-core, -memory, -scheduler, -planner or -improver; it holds no state,
// opens the store for the call and closes it, returns text for humans and the JSON object `jv ... --json` prints for
// the same command, and refuses with JvError (exit 2 refused, 3 not found, 4 conflict). No operation deletes anything
// or touches providers, secrets or the owner's configuration.
//
// `exitCode` of a result is the code the matching jv command exits with while it still prints its JSON (jv land: 2
// for a refused or failed landing; jv doctor: 2 when a check FAILs); the MCP returns such a result as an error result
// whose structured content is still the data, and the UI may answer it with the matching HTTP status. `deps` of the
// context are the test seams of jevellan-core (fake placement, spawn, doctor probes, tmux); nothing in production
// sets them.

import type { z } from 'zod';
import type { CoordinatorDeps } from 'jevellan-core/coordinator';
import type { MessageDeps } from 'jevellan-core/coordinator-chat';
import type { DoctorDeps } from 'jevellan-core/doctor';
import type { TaskDeps } from 'jevellan-core/tasks';

/** Who called: tasks created through the MCP get origin 'mcp', through the UI origin 'ui'. */
export type Origin = 'mcp' | 'ui';

/** Replaced effects, for tests only. */
export interface OpDeps {
  task?: Partial<TaskDeps>;
  doctor?: Partial<DoctorDeps>;
  coordinator?: CoordinatorDeps;
  coordinatorMessage?: MessageDeps;
  /** The clock of views that depend on it (schedules' due flag, the bot's heartbeat age). */
  now?: () => Date;
  /** Where the bot's service file is looked for (default env.ownerHome() and process.platform). */
  ownerHome?: string;
  platform?: NodeJS.Platform;
}

export interface OpContext {
  origin: Origin;
  deps?: OpDeps;
}

export interface OpResult {
  /** For humans (the MCP text content). */
  text: string;
  /** The JSON object of the matching `jv ... --json` (the MCP structuredContent, the UI route's body). */
  data: Record<string, unknown>;
  /** The exit code of the matching jv command when it is not 0 although it printed `data` (jv land, jv doctor). */
  exitCode?: number;
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

/** A read-only resource: a URI (or template) whose JSON is an operation's output. */
export interface ResourceDef {
  name: string;
  /** A fixed URI (jv://status) or a template (jv://tasks/{id}). */
  uri: string;
  description: string;
  read(params: Record<string, string>): Promise<Record<string, unknown>> | Record<string, unknown>;
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
