// The worker tools (brief section 3), one table for every way they are served: in-process for claude-sdk
// (createSdkMcpServer, server name jv), the stdio worker server jv-worker-mcp (alias jv-report-mcp) for claude-tmux
// and codex, and, for the report only, the fenced JSON block of the llm runtime.

import type { z } from 'zod';
import {
  RECALL_TOOL_DESCRIPTION,
  RECALL_TOOL_NAME,
  RecallArgsSchema,
  recallTool,
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_TOOL_NAME,
  RememberArgsSchema,
  rememberTool,
  toolInputJsonSchema,
  type ToolResult,
} from './memory-tools.js';
import { REPORT_SERVER_NAME, REPORT_TOOL_DESCRIPTION, REPORT_TOOL_NAME, reportInputJsonSchema, resolveReportSession, writeReport } from '../report.js';
import type { Store } from '../store.js';

export { RECALL_TOOL_NAME, REMEMBER_TOOL_NAME, RecallArgsSchema, RememberArgsSchema, recallTool, rememberTool, type ToolResult };

export interface WorkerTool {
  name: string;
  description: string;
  inputSchema: () => Record<string, unknown>;
  /** The zod schema of the input, for servers that take one (the agent SDK's tool()); the report's is its fields. */
  zod?: z.ZodType;
  run(store: Store, sessionId: string, args: unknown): ToolResult;
}

/** The report tool for a long-lived conversation: the report goes to the row of the current turn (D-006). */
export function reportTool(store: Store, sessionId: string, args: unknown): ToolResult {
  const target = resolveReportSession(store, sessionId);
  const r = writeReport(store, target.id, args ?? {});
  return { text: r.text, isError: r.outcome === 'invalid' };
}

export const workerTools: readonly WorkerTool[] = [
  { name: REPORT_TOOL_NAME, description: REPORT_TOOL_DESCRIPTION, inputSchema: reportInputJsonSchema, run: reportTool },
  { name: REMEMBER_TOOL_NAME, description: REMEMBER_TOOL_DESCRIPTION, inputSchema: () => toolInputJsonSchema(RememberArgsSchema), zod: RememberArgsSchema, run: rememberTool },
  { name: RECALL_TOOL_NAME, description: RECALL_TOOL_DESCRIPTION, inputSchema: () => toolInputJsonSchema(RecallArgsSchema), zod: RecallArgsSchema, run: recallTool },
];

/** A tool's name as Claude sees it through the jv server (mcp__jv__<tool>). */
export function qualifiedToolName(name: string): string {
  return `mcp__${REPORT_SERVER_NAME}__${name}`;
}

/** Every worker tool's qualified name: what allowedTools pre-approves in dontAsk mode (D-026). */
export const WORKER_TOOLS_QUALIFIED: readonly string[] = workerTools.map((t) => qualifiedToolName(t.name));
