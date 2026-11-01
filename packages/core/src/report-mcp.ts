// jv-worker-mcp (alias jv-report-mcp): the stdio MCP server of the worker tools for claude-tmux and Codex sessions
// (skills brief section 5, monorepo brief section 3): jv_report, jv_remember and jv_recall (tools/index.ts).
//
// Started by the session's MCP config as "<bootstrap node> <jv entry> worker-mcp --session R" (reportMcpServerSpec,
// M-015): the jv CLI registers jevellan-memory before it serves, so the memory tools work; this file run directly
// (the package's jv-worker-mcp and jv-report-mcp bins) serves the same tools, with memory answering that it is not
// available. Hand-rolled JSON-RPC 2.0 over newline-delimited stdio, no dependency: initialize,
// notifications/initialized, ping, tools/list and tools/call; inputSchemas are zod's toJSONSchema.
//
// A claude-tmux or Codex conversation keeps one MCP process across turns while every turn is its own session row
// (D-006), so each call writes to the newest row sharing the given row's native_session_id that has no report yet
// (report.resolveReportSession). stdout carries only JSON-RPC messages; diagnostics go to stderr, redacted.

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { paths, RUNTIME_ROOT } from './paths.js';
import { redact } from './redact.js';
import { bootstrapNode, jvEntry } from './env.js';
import { openStore, type Store } from './store.js';
import { workerTools } from './tools/index.js';

export const SERVER_NAME = 'jv-worker-mcp';
export const SERVER_VERSION = '0.1.0';
/** Protocol version answered when the client asks for none. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/**
 * The MCP config entry of the stdio worker server for one session: `<node> <jv entry> worker-mcp --session R`
 * (M-015). `script` runs this file directly instead (the bins; tests).
 */
export function reportMcpServerSpec(sessionId: string, options: { node?: string; script?: string } = {}): {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const target = options.script !== undefined ? [options.script] : [jvEntry(), 'worker-mcp'];
  return {
    type: 'stdio',
    command: options.node ?? bootstrapNode(),
    args: ['--disable-warning=ExperimentalWarning', ...target, '--session', sessionId],
    env: { JV_HOME: paths.home },
  };
}

/** The compiled file of this server in jevellan-core (what the jv-worker-mcp and jv-report-mcp bins run). */
export const WORKER_MCP_SCRIPT = join(RUNTIME_ROOT, 'dist', 'report-mcp.js');

type Id = string | number | null;

interface Request {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

export interface ServerOptions {
  sessionId: string;
  /** Opens the store for one call (default openStore()). */
  openStore?: () => Store;
  write?: (line: string) => void;
  log?: (text: string) => void;
}

function result(id: Id, value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

function error(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** Answers one JSON-RPC message; undefined for a notification (no id) or nothing to say. */
export function handleMessage(line: string, options: ServerOptions): string | undefined {
  let msg: Request;
  try {
    msg = JSON.parse(line) as Request;
  } catch {
    return error(null, -32700, 'Parse error');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return error(null, -32600, 'Invalid Request');
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
  const id: Id = hasId ? (msg.id as Id) : null;
  const method = typeof msg.method === 'string' ? msg.method : undefined;
  if (method === undefined) return hasId ? error(id, -32600, 'Invalid Request') : undefined;
  if (!hasId) return undefined; // notifications/initialized, notifications/cancelled, ...
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: asked,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: workerTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema() })),
      });
    case 'tools/call': {
      const name = params.name;
      const tool = workerTools.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);
      const args = params.arguments ?? {};
      let store: Store | undefined;
      try {
        store = (options.openStore ?? (() => openStore()))();
        const r = tool.run(store, options.sessionId, args);
        return result(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
      } catch (e) {
        const message = redact(e instanceof Error ? e.message : String(e));
        options.log?.(`${tool.name} failed: ${message}`);
        return result(id, { content: [{ type: 'text', text: `${tool.name} failed: ${message}` }], isError: true });
      } finally {
        store?.close();
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

/** Serves stdin until it closes. */
export function serve(options: ServerOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const reply = handleMessage(line, options);
    if (reply !== undefined) write(reply);
  });
  return new Promise((resolve) => rl.on('close', () => resolve()));
}

export function argSession(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--session');
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--session='));
  return eq?.slice('--session='.length);
}

function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const sessionId = argSession(process.argv.slice(2));
  const log = (text: string) => process.stderr.write(`${SERVER_NAME}: ${text}\n`);
  if (!sessionId) {
    log('--session R is required');
    process.exit(2);
  }
  void serve({ sessionId, log }).then(() => process.exit(0));
}
