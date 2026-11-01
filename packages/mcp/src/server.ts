// The jevellan-mcp server (brief section 5): one McpServer over the operations table (ops.ts), served over stdio (what
// `claude mcp add jv -- ~/.jv/bin/jv mcp` starts) or Streamable HTTP in stateless mode (a new transport per request)
// on 127.0.0.1:7072 at /mcp, with `Authorization: Bearer <token>` required on every request (401 and no body
// otherwise) and GET /health open. Nothing else is served. HTTPS is the owner's `tailscale serve`, not this package's.
//
// Each tool returns the operation's text and its JSON as structuredContent; a refusal is an error result with
// {error, exitCode}, the shape `jv ... --json` prints. One line per call goes to ~/.jv/logs/mcp.log: time, tool, the
// project and task ids, duration and exit code; never arguments, never results.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JvError, refused } from 'jevellan-core/errors';
import { paths } from 'jevellan-core/paths';
import { redact } from 'jevellan-core/redact';
import { packageVersion } from 'jevellan-core/version';
import { loggedIds, type Operation, type OpContext } from './ops.js';

export const SERVER_NAME = 'jevellan';
export const DEFAULT_MCP_PORT = 7072;
export const DEFAULT_MCP_BIND = '127.0.0.1';

/** A read-only resource: a URI (or template) whose JSON is an operation's output. */
export interface ResourceDef {
  name: string;
  /** A fixed URI (jv://status) or a template (jv://tasks/{id}). */
  uri: string;
  description: string;
  read(params: Record<string, string>): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ServerOptions {
  operations: readonly Operation[];
  resources?: readonly ResourceDef[];
  instructions?: string;
  /** Where the call log goes (default ~/.jv/logs/mcp.log). */
  logFile?: string;
  context?: OpContext;
}

export function mcpLogFile(): string {
  return join(paths.logsDir, 'mcp.log');
}

function logCall(file: string, tool: string, input: unknown, ms: number, exitCode: number): void {
  const ids = loggedIds(input);
  const line = [
    new Date().toISOString(),
    tool,
    ...(ids.project ? [`project=${ids.project}`] : []),
    ...(ids.task ? [`task=${ids.task}`] : []),
    `${ms}ms`,
    `exit=${exitCode}`,
  ].join(' ');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // the log is best effort; a call never fails because of it
  }
}

/** An McpServer with every operation as a tool and the resources, ready to connect to a transport. */
export function createMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {}, resources: {} }, ...(options.instructions ? { instructions: options.instructions } : {}) },
  );
  const logFile = options.logFile ?? mcpLogFile();
  const ctx: OpContext = options.context ?? { origin: 'mcp' };
  for (const op of options.operations) {
    server.registerTool(op.name, { description: op.description, inputSchema: op.input }, (async (args: unknown) => {
      const started = Date.now();
      let exitCode = 0;
      try {
        const r = await op.run(op.input.parse(args ?? {}), ctx);
        return { content: [{ type: 'text' as const, text: r.text }], structuredContent: r.data };
      } catch (error) {
        exitCode = error instanceof JvError ? error.exitCode : 1;
        const message = redact(error instanceof Error ? error.message : String(error));
        return { isError: true, content: [{ type: 'text' as const, text: message }], structuredContent: { error: message, exitCode } };
      } finally {
        logCall(logFile, op.name, args, Date.now() - started, exitCode);
      }
    }) as never);
  }
  for (const r of options.resources ?? []) {
    const read = async (uri: URL, params: Record<string, string>) => {
      const data = await r.read(params);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    };
    if (r.uri.includes('{')) {
      server.registerResource(r.name, new ResourceTemplate(r.uri, { list: undefined }), { description: r.description, mimeType: 'application/json' }, (uri, vars) =>
        read(uri, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]))),
      );
    } else {
      server.registerResource(r.name, r.uri, { description: r.description, mimeType: 'application/json' }, (uri) => read(uri, {}));
    }
  }
  return server;
}

/** Serves stdio until the client closes it. */
export async function serveStdio(options: ServerOptions): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}

// ---- the token -------------------------------------------------------------------------------------------

export function tokenFile(): string {
  return join(paths.secretsDir, 'mcp.token');
}

/**
 * The bearer token of the HTTP transport: 32 random bytes, base64url, in ~/.jv/secrets/mcp.token (mode 600), written
 * once at first start; `reset` writes a new one (the old one stops working). Returns whether it was written now,
 * so the command prints it that one time.
 */
export function ensureToken(options: { reset?: boolean; file?: string } = {}): { token: string; written: boolean } {
  const file = options.file ?? tokenFile();
  if (!options.reset && existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token !== '') return { token, written: false };
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { token, written: true };
}

function sameToken(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- HTTP ---------------------------------------------------------------------------------------------------

/** --bind takes 127.0.0.1, localhost or exactly one IP address of this machine (the tailnet address), as jv ui does (D-064). */
export function validateMcpBind(bind: string): string {
  const b = bind === 'localhost' ? '127.0.0.1' : bind;
  if (!isIP(b)) throw refused(`--bind needs an IP address of this machine, not ${JSON.stringify(bind)}`);
  if (b === '0.0.0.0' || b === '::') throw refused('--bind refuses every-interface addresses; give the one address to listen on');
  const local = Object.values(networkInterfaces())
    .flat()
    .map((i) => i?.address)
    .filter((a): a is string => typeof a === 'string');
  if (!local.includes(b)) throw refused(`${b} is not an address of this machine`);
  return b;
}

export interface HttpOptions extends ServerOptions {
  port?: number;
  bind?: string;
  token: string;
}

export interface RunningHttp {
  url: string;
  port: number;
  bind: string;
  server: Server;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function empty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

/** Listens on bind:port; /health without a token, /mcp with it, nothing else. */
export async function startHttp(options: HttpOptions): Promise<RunningHttp> {
  const bind = validateMcpBind(options.bind ?? DEFAULT_MCP_BIND);
  const version = packageVersion();
  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      const body = JSON.stringify({ ok: true, version });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (path !== '/mcp') return empty(res, 404);
    if (!sameToken(req.headers.authorization, options.token)) return empty(res, 401);
    void (async () => {
      const server = createMcpServer(options);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await server.connect(transport);
        await transport.handleRequest(req as IncomingMessage & { auth?: never }, res, body);
      } catch {
        if (!res.headersSent) empty(res, 400);
        else res.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? DEFAULT_MCP_PORT, bind, () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_MCP_PORT);
  return {
    url: `http://${bind}:${port}/mcp`,
    port,
    bind,
    server: http,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
