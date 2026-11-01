// jv ui (brief section 7): the server of the Jevellan web app. node:http, no framework. Everything it shows comes
// from the store and everything it does is a call the CLI could also make.
//
// - Routes (the UI route contract): the JSON routes that mirror a control-plane tool call the injected operations by
//   name (operations.ts); the routes only the UI has (sign-in, the event stream, A2UI actions, the coordinator start,
//   notes, workflows, the schedule preview, pausing a goal, decisions, the memory list, the bot extras, evidence) call
//   jevellan-core here, or a helper the caller injects (nextRuns, listMemories: this package depends on jevellan-core
//   only, so scheduler and memory code comes in through the options, as the operations do). A route whose operation
//   or helper was not given answers {error, exitCode: 2} "... is not available in this build".
// - Sign-in (auth.ts): every /api route but /api/login and /api/session needs the jv_ui cookie (401 "Sign in."),
//   and so does /evidence/. The page files and /health do not.
// - --readonly is the lifted viewer's guarantee: no action is offered or accepted. Every POST is 403 {error:
//   'read-only'}, except /api/login and /api/logout (signing in is not an action on Jevellan, and the pages need it),
//   ui_tokens is the only table a read-only server writes, and it never tails the coordinators (tailing writes).
// - Two connections: the lifted ReadOnlyStore (db.ts) for the views, evidence and the change stamp (D-063), and a
//   read-write Store for sign-in tokens, A2UI messages, notes and coordinator calls. Operations open their own.
// - Loopback by default; --bind takes exactly one address of this machine (0.0.0.0 and :: refused), and the Host
//   header must be an IP literal, localhost, this machine's name or a *.ts.net name (DNS rebinding, D-064).
// - One line per request goes to $JV_HOME/logs/ui.log: time, method, path without query values, status, duration.
//   Never bodies, cookies or query values.
// - The pid file ($JV_HOME/run/ui.pid, pidfile.ts) is held while the server runs, when the caller asks for it.

import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCoordinator, type CoordinatorDeps } from 'jevellan-core/coordinator';
import { tailCoordinator } from 'jevellan-core/coordinator-chat';
import { notFound, refused } from 'jevellan-core/errors';
import { readNotes } from 'jevellan-core/handoff';
import { normalizeId } from 'jevellan-core/ids';
import { writeNotes } from 'jevellan-core/notes';
import { paths } from 'jevellan-core/paths';
import { loadProviders } from 'jevellan-core/providers';
import { openStore, type Store } from 'jevellan-core/store';
import { listTaskSummaries, type TaskDeps } from 'jevellan-core/tasks';
import { TASK_KINDS, type GoalRow, type SessionRow } from 'jevellan-core/types';
import { packageVersion } from 'jevellan-core/version';
import { defaultWorkflowFile, resolveWorkflow } from 'jevellan-core/workflows';
import { applyUiAction } from './actions.js';
import {
  checkToken,
  clearedCookie,
  ensurePassword,
  issueToken,
  LoginLimiter,
  overTls,
  passwordMatches,
  requestToken,
  resetPassword,
  sessionCookie,
  signOut,
  uiPasswordFile,
} from './auth.js';
import { checkReadable, ReadOnlyStore } from './db.js';
import { resolveEvidence } from './evidence.js';
import { eventHub, HEARTBEAT_MS, POLL_MS } from './events.js';
import { decoded, HttpError, isJsonRequest, loggablePath, queryValue, readJsonObject, securityHeaders, send, sendJson, sendText, sendThrown } from './http.js';
import { compilePath, OPERATION_ROUTES, routeInput, schemaProblem, type OperationRoute, type UiOperation } from './operations.js';
import { acquirePidFile, type PidFile } from './pidfile.js';
import { NONE_CSP, PAGE_CSP, staticFiles } from './static.js';
import { decisions, lostCandidates } from './views.js';

export { HEARTBEAT_MS, POLL_MS } from './events.js';
export { missingOperations, OPERATION_ROUTES, type OperationRoute, type UiOperation } from './operations.js';

function findUiRoot(): string {
  // dist/server/server.js and dist-test/server/server.js sit below the jevellan-ui package folder.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && /"name"\s*:\s*"jevellan-ui"/.test(readFileSync(pkg, 'utf8'))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The folder of the jevellan-ui package (its package.json, viewer/ and dist/). */
export const UI_ROOT: string = findUiRoot();
/** Where Vite puts the web app. */
export const WEB_DIR: string = join(UI_ROOT, 'dist', 'web');

export const DEFAULT_PORT = 7071;
export const DEFAULT_BIND = '127.0.0.1';
export const LOGIN_BODY_MAX = 16 * 1024;
export const BOT_LOG_LINES = 100;
export const PREVIEW_RUNS = 3;

/** The memory list of GET /api/memory without a query (jv memory list --json: {memories}). */
export type ListMemories = (
  store: Store,
  filter: { project?: string; kind?: string; status?: string; limit?: number },
) => Record<string, unknown>;

/** jevellan-scheduler's nextRuns, for the cron helper of the schedules page. */
export type NextRuns = (cron: string, after: Date, tz: string, count: number) => Date[];

export interface UiServerOptions {
  /** Default 7071; 0 picks a free port. */
  port?: number;
  /** One IP address, default 127.0.0.1. */
  bind?: string;
  /** No action offered or accepted (see the header). */
  readonly?: boolean;
  /** The control-plane operations (jevellan-mcp's operations table), served by name. */
  operations?: readonly UiOperation[];
  /** Store file, default $JV_HOME/store.sqlite. */
  storeFile?: string;
  /** The built web app, default packages/ui/dist/web. */
  staticDir?: string;
  /** Default $JV_HOME/ui-password. */
  passwordFile?: string;
  /** Write a new password (and sign every browser out) before serving. */
  passwordReset?: boolean;
  /** The request log, default $JV_HOME/logs/ui.log; false for none. */
  logFile?: string | false;
  /** Hold this pid file while serving (jv ui passes $JV_HOME/run/ui.pid). */
  pidFile?: string;
  listMemories?: ListMemories;
  nextRuns?: NextRuns;
  pollMs?: number;
  heartbeatMs?: number;
  /** Whether a run's process is alive (tests pass a fake). */
  alive?: (s: SessionRow) => boolean;
  /** The clock of sign-in (token age, the wrong-password limit) and the schedule preview. */
  now?: () => number;
  /** Tails the coordinators while a page listens (default core tailCoordinator). */
  tail?: (store: Store) => void;
  /** Dependencies of the A2UI actions (core messageTask and answerTask); tests replace them. */
  taskDeps?: Partial<TaskDeps>;
  /** Dependencies of the coordinator start; tests replace them. */
  coordinatorDeps?: CoordinatorDeps;
}

export interface UiServer {
  url: string;
  port: number;
  bind: string;
  readonly: boolean;
  passwordFile: string;
  /** The password, only when this start created or reset it (jv ui shows it once). */
  newPassword?: string;
  server: Server;
  close(): Promise<void>;
}

/** Checks a --bind value: one IP address or localhost, never a wildcard. Returns the address to listen on. */
export function validateBind(value: string): string {
  const v = value.trim().replace(/^\[(.*)\]$/, '$1');
  if (v === 'localhost') return '127.0.0.1';
  if (isIP(v) === 0) throw refused(`--bind needs an IP address (for the tailnet: jv ui --bind 100.x.y.z), not "${value}"`);
  if (v === '0.0.0.0' || v === '::' || v === '::0') {
    throw refused('jv ui serves one address, never every interface; pass the tailnet address (jv ui --bind 100.x.y.z)');
  }
  return v;
}

export function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

/** This machine's Tailscale addresses (100.64.0.0/10), for the hint jv ui prints. */
export function tailnetAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4') continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y !== undefined && y >= 64 && y <= 127) out.push(a.address);
    }
  }
  return out;
}

/** Whether a Host header names this server (see the header: DNS rebinding). */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  let name = host.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(name);
  if (v6) return isIP(v6[1]!) === 6;
  name = name.replace(/:\d+$/, '');
  if (name === '') return false;
  if (isIP(name) !== 0) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const me = hostname().toLowerCase();
  if (name === me || name.startsWith(`${me}.`)) return true;
  return name.endsWith('.ts.net');
}

/** A goal as jv goal show --json prints it (jevellan-planner's goalView, replicated: this package depends on core only). */
export function goalView(store: Store, g: GoalRow): Record<string, unknown> {
  return {
    id: g.id,
    project: store.getProject(g.project_id)?.name ?? g.project_id,
    title: g.title,
    text: g.text,
    priority: g.priority,
    state: g.state,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

/** The last `n` lines of a text file (reads at most the last 256 KB), or [] when there is none. */
export function lastLines(file: string, n: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (length < size) lines.shift(); // a partial first line
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

/** The workflow files a project's tasks would use, kind by kind (GET /api/projects/:name/workflows). */
export function projectWorkflows(project: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const kind of TASK_KINDS) {
    if (kind === 'single') continue;
    const override = paths.projectWorkflow(project, kind);
    const own = existsSync(override);
    const entry: Record<string, unknown> = { kind, source: own ? 'project' : 'default', file: own ? override : defaultWorkflowFile(kind) };
    try {
      entry.steps = resolveWorkflow({ project, kind }).workflow.steps;
    } catch (error) {
      entry.steps = [];
      entry.error = error instanceof Error ? error.message : String(error);
    }
    out.push(entry);
  }
  return out;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  head: boolean;
  body: Record<string, unknown> | undefined;
}

interface ApiRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  names: string[];
  handle(ctx: RouteContext): Promise<void> | void;
}

/**
 * The providers.json menu the Override dialog offers (M-068): per enabled provider its name, kind and models (id,
 * label, efforts). Never a key file, token file, home or URL.
 */
export function providersMenu(file?: string): { providers: Array<{ name: string; kind: string; models: Array<{ id: string; label: string; efforts: string[] }> }> } {
  const config = loadProviders(file);
  return {
    providers: config.providers
      .filter((p) => p.enabled)
      .map((p) => ({ name: p.name, kind: p.kind, models: p.models.map((m) => ({ id: m.id, label: m.label, efforts: [...m.efforts] })) })),
  };
}

export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const bind = validateBind(options.bind ?? DEFAULT_BIND);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw refused(`--port needs a port number, not ${port}`);
  const readonly = options.readonly === true;
  const now = options.now ?? Date.now;
  const passwordFile = options.passwordFile ?? uiPasswordFile();
  const logFile = options.logFile === undefined ? join(paths.logsDir, 'ui.log') : options.logFile;
  const files = staticFiles(options.staticDir ?? WEB_DIR);
  const operations = new Map((options.operations ?? []).map((o) => [o.name, o]));
  const version = packageVersion();

  const pid: PidFile | undefined = options.pidFile ? acquirePidFile(options.pidFile) : undefined;
  let store: Store | undefined;
  let db: ReadOnlyStore | undefined;
  let newPassword: string | undefined;
  try {
    store = openStore(options.storeFile ? { file: options.storeFile } : {});
    db = new ReadOnlyStore(store.file);
    checkReadable(db);
    newPassword = options.passwordReset ? resetPassword(store.db, passwordFile).created : ensurePassword(passwordFile).created;
  } catch (error) {
    db?.close();
    store?.close();
    pid?.release();
    throw error;
  }
  const rw: Store = store;
  const ro: ReadOnlyStore = db;
  const limiter = new LoginLimiter(now);
  const alive = options.alive;

  const tail = options.tail ?? ((s: Store) => void tailCoordinator(s));
  const hub = eventHub({
    stamp: () => {
      let lost = '';
      try {
        lost = lostCandidates(ro, alive).join(',');
      } catch {
        lost = '';
      }
      return `${ro.dataVersion()}|${lost}`;
    },
    ...(readonly ? {} : { tail: () => tail(rw) }),
    pollMs: options.pollMs ?? POLL_MS,
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
  });

  // ---- request log --------------------------------------------------------------------------------------------
  let logReady = false;
  function logRequest(method: string, path: string, status: number, ms: number): void {
    if (!logFile) return;
    try {
      if (!logReady) {
        mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
        logReady = true;
      }
      appendFileSync(logFile, `${new Date().toISOString()} ${method} ${path} ${status} ${ms}ms\n`, { mode: 0o600 });
    } catch {
      // the log is best effort; a request never fails because of it
    }
  }

  // ---- sign-in ----------------------------------------------------------------------------------------------------
  /** Whether the request carries a live token; a refreshed token's cookie is sent again. */
  function signedIn(req: IncomingMessage, res: ServerResponse): boolean {
    const check = checkToken(rw.db, requestToken(req), now());
    if (check.refreshed) res.setHeader('Set-Cookie', sessionCookie(requestToken(req)!, overTls(req)));
    return check.valid;
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? 'unknown';
    const wait = limiter.retryAfter(address);
    if (wait > 0) {
      sendJson(res, 429, { error: 'Too many wrong passwords. Try again in a minute.' }, false, { 'Retry-After': String(Math.ceil(wait / 1000)) });
      return;
    }
    const body = await readJsonObject(req, LOGIN_BODY_MAX);
    if (!passwordMatches(body.password, passwordFile)) {
      limiter.fail(address);
      sendJson(res, 401, { error: 'Wrong password.' }, false);
      return;
    }
    limiter.succeed(address);
    const token = issueToken(rw.db, String(req.headers['user-agent'] ?? ''), now());
    sendJson(res, 200, { ok: true }, false, { 'Set-Cookie': sessionCookie(token, overTls(req)) });
  }

  function logout(req: IncomingMessage, res: ServerResponse): void {
    signOut(rw.db, requestToken(req));
    sendJson(res, 200, { ok: true }, false, { 'Set-Cookie': clearedCookie(overTls(req)) });
  }

  // ---- routes -----------------------------------------------------------------------------------------------------
  function operation(name: string): UiOperation {
    const op = operations.get(name);
    if (!op) throw refused(`${name} is not available in this build of jv ui`);
    return op;
  }

  async function runOperation(route: OperationRoute, ctx: RouteContext): Promise<Record<string, unknown>> {
    const op = operation(route.operation);
    if (readonly && op.mutates) throw new HttpError(403, 'read-only', 2, true);
    const parsed = op.input.safeParse(routeInput(route, ctx.params, ctx.url, ctx.body));
    if (!parsed.success) throw new HttpError(400, schemaProblem(parsed.error.issues));
    return (await op.run(parsed.data, { origin: 'ui' })).data;
  }

  function projectName(raw: string | undefined): string {
    return rw.requireProject(raw ?? '').name;
  }

  const special: Record<string, (route: OperationRoute, ctx: RouteContext) => Promise<void>> = {
    // GET /api/memory: the search with a query, jv memory list's JSON without one.
    jv_memory_search: async (route, ctx) => {
      if (queryValue(ctx.url, 'query') !== undefined) return sendJson(ctx.res, 200, await runOperation(route, ctx), ctx.head);
      if (!options.listMemories) throw refused('the memory list is not available in this build of jv ui');
      const filter: { project?: string; kind?: string; status?: string; limit?: number } = {};
      for (const key of ['project', 'kind', 'status'] as const) {
        const v = queryValue(ctx.url, key);
        if (v !== undefined) filter[key] = v;
      }
      const limit = queryValue(ctx.url, 'limit');
      if (limit !== undefined) {
        if (!/^\d+$/.test(limit)) throw refused('limit must be a whole number');
        filter.limit = Number(limit);
      }
      sendJson(ctx.res, 200, options.listMemories(rw, filter), ctx.head);
    },
    // GET /api/bot: jv_bot_status plus the bot log and the queue.
    jv_bot_status: async (route, ctx) => {
      const data = await runOperation(route, ctx);
      const queue = listTaskSummaries(rw, { state: 'queued', limit: 1000 }).reverse();
      sendJson(ctx.res, 200, { ...data, log: lastLines(join(paths.logsDir, 'bot.log'), BOT_LOG_LINES), queue }, ctx.head);
    },
  };

  const routes: ApiRoute[] = [];
  const add = (method: 'GET' | 'POST', path: string, handle: (ctx: RouteContext) => Promise<void> | void): void => {
    routes.push({ method, ...compilePath(path), handle });
  };

  add('GET', '/api/events', (ctx) => {
    if (ctx.head) return send(ctx.res, 200, 'text/event-stream; charset=utf-8', '', true, { 'Cache-Control': 'no-store' });
    hub.connect(ctx.req, ctx.res);
  });
  add('GET', '/api/schedules/preview', (ctx) => {
    const cron = queryValue(ctx.url, 'cron');
    if (cron === undefined) throw refused('cron is required');
    if (!options.nextRuns) throw refused('the schedule preview is not available in this build of jv ui');
    const tz = queryValue(ctx.url, 'tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const runs = options.nextRuns(cron, new Date(now()), tz, PREVIEW_RUNS);
    sendJson(ctx.res, 200, { nextRuns: runs.map((d) => d.toISOString()) }, ctx.head);
  });
  add('POST', '/api/tasks/:id/ui-action', async (ctx) => {
    const result = await applyUiAction(rw, ctx.params.id!, ctx.body?.action, options.taskDeps ?? {});
    sendJson(ctx.res, 200, result, false);
  });
  add('POST', '/api/projects/:name/coordinator/start', async (ctx) => {
    const name = projectName(ctx.params.name);
    sendJson(ctx.res, 200, await startCoordinator(rw, name, options.coordinatorDeps ?? {}), false);
  });
  add('GET', '/api/projects/:name/notes', (ctx) => {
    const name = projectName(ctx.params.name);
    sendJson(ctx.res, 200, { project: name, text: readNotes(name) }, ctx.head);
  });
  add('POST', '/api/projects/:name/notes', (ctx) => {
    const name = projectName(ctx.params.name);
    const text = ctx.body?.text;
    if (typeof text !== 'string') throw refused('text is required');
    const r = writeNotes(name, text);
    sendJson(ctx.res, 200, { project: name, file: r.file, bytes: r.bytes, unchanged: r.unchanged, ...(r.archived ? { archived: r.archived } : {}) }, false);
  });
  add('GET', '/api/projects/:name/workflows', (ctx) => {
    sendJson(ctx.res, 200, { workflows: projectWorkflows(projectName(ctx.params.name)) }, ctx.head);
  });
  add('GET', '/api/providers', (ctx) => {
    sendJson(ctx.res, 200, providersMenu(), ctx.head);
  });
  add('POST', '/api/goals/:id/pause', (ctx) => {
    const id = normalizeId(ctx.params.id ?? '');
    const goal = rw.getGoal(id);
    if (!goal) throw notFound(`no goal ${id}`);
    if (goal.state === 'done') throw refused(`goal ${id} is done; a done goal is not paused`);
    sendJson(ctx.res, 200, { goal: goalView(rw, rw.setGoalState(id, 'paused')) }, false);
  });
  add('GET', '/api/decisions', (ctx) => {
    const filter: Parameters<typeof decisions>[1] = {};
    for (const k of ['kind', 'from', 'to', 'project', 'task'] as const) {
      const v = queryValue(ctx.url, k);
      if (v !== undefined) filter[k] = k === 'task' ? normalizeId(v) : v;
    }
    const limit = queryValue(ctx.url, 'limit');
    if (limit !== undefined && /^\d+$/.test(limit)) filter.limit = Number(limit);
    sendJson(ctx.res, 200, decisions(ro, filter), ctx.head);
  });
  for (const route of OPERATION_ROUTES) {
    const custom = route.method === 'GET' ? special[route.operation] : undefined;
    add(route.method, route.path, async (ctx) => {
      if (custom) return custom(route, ctx);
      sendJson(ctx.res, 200, await runOperation(route, ctx), ctx.head);
    });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, method: string, head: boolean): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const post = method === 'POST';
    if (post && readonly && path !== '/api/login' && path !== '/api/logout') return sendJson(res, 403, { error: 'read-only' }, false);
    if (post && !isJsonRequest(req)) throw new HttpError(400, 'send the request as JSON (Content-Type: application/json)');
    if (path === '/api/login') {
      if (!post) return methodNotAllowed(res, 'POST', head);
      return login(req, res);
    }
    if (path === '/api/session') {
      if (post) return methodNotAllowed(res, 'GET, HEAD', head);
      return sendJson(res, 200, { authenticated: signedIn(req, res), readonly, version }, head);
    }
    if (!signedIn(req, res)) return sendJson(res, 401, { error: 'Sign in.' }, head);
    if (path === '/api/logout') {
      if (!post) return methodNotAllowed(res, 'POST', head);
      return logout(req, res);
    }
    const matching = routes.map((r) => ({ r, m: r.pattern.exec(path) })).filter((x) => x.m !== null);
    if (matching.length === 0) return sendJson(res, 404, { error: `no endpoint ${path}`, exitCode: 3 }, head);
    const wanted = post ? 'POST' : 'GET';
    const hit = matching.find((x) => x.r.method === wanted);
    if (!hit) return methodNotAllowed(res, [...new Set(matching.map((x) => x.r.method))].join(', '), head);
    const params: Record<string, string> = {};
    for (const [i, name] of hit.r.names.entries()) {
      const v = decoded(hit.m![i + 1]!);
      if (v === undefined) throw new HttpError(400, `the ${name} in the path is not valid`);
      params[name] = v;
    }
    const body = post ? await readJsonObject(req) : undefined;
    await hit.r.handle({ req, res, url, params, head, body });
  }

  function methodNotAllowed(res: ServerResponse, allow: string, head: boolean): void {
    sendJson(res, 405, { error: 'method not allowed', exitCode: 2 }, head, { Allow: allow });
  }

  function evidence(req: IncomingMessage, res: ServerResponse, taskRaw: string, rawPath: string, head: boolean): void {
    if (!signedIn(req, res)) return sendText(res, 401, 'Sign in.', head);
    const taskId = decoded(taskRaw);
    const found = taskId === undefined ? undefined : resolveEvidence(ro, normalizeId(taskId), rawPath);
    if (!found) return sendText(res, 404, 'Not found', head);
    res.writeHead(200, {
      'Content-Type': found.contentType,
      'Content-Length': String(found.size),
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': NONE_CSP,
    });
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(found.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method ?? 'GET';
    let logged = '<bad url>';
    res.once('close', () => logRequest(method, logged, res.statusCode, Date.now() - started));
    securityHeaders(res);
    res.setHeader('Content-Security-Policy', NONE_CSP);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://ui.invalid');
    } catch {
      return sendText(res, 400, 'Bad request', false);
    }
    logged = loggablePath(url);
    if (!hostAllowed(req.headers.host)) return sendText(res, 403, 'Unknown host.', false);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      return sendText(res, 405, 'Method not allowed', false);
    }
    const head = method === 'HEAD';
    const path = url.pathname;
    try {
      if (path === '/health') return sendJson(res, 200, { ok: true, version }, head);
      if (path === '/api' || path.startsWith('/api/')) return await api(req, res, url, method, head);
      if (method === 'POST') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendText(res, 405, 'Method not allowed', false);
      }
      const m = /^\/evidence\/([^/]+)\/(.+)$/.exec(path);
      if (m) return evidence(req, res, m[1]!, m[2]!, head);
      if (path.startsWith('/evidence/')) return sendText(res, 404, 'Not found', head);
      return files.serve(req, res, path, head);
    } catch (error) {
      sendThrown(res, error, head);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => sendThrown(res, error, req.method === 'HEAD'));
  });
  server.keepAliveTimeout = 5000;
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  const cleanup = (): void => {
    hub.close();
    ro.close();
    rw.close();
    pid?.release();
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(refused(`port ${port} on ${bind} is in use; pass another --port`));
      else if (error.code === 'EADDRNOTAVAIL') reject(refused(`${bind} is not an address of this machine`));
      else if (error.code === 'EACCES') reject(refused(`not allowed to listen on ${bind}:${port}`));
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bind);
  }).catch((error: unknown) => {
    cleanup();
    throw error;
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const host = bind.includes(':') ? `[${bind}]` : bind;
  const url = `http://${host}:${actualPort}`;
  pid?.update({ url, readonly });
  let closed = false;
  return {
    url,
    port: actualPort,
    bind,
    readonly,
    passwordFile,
    ...(newPassword ? { newPassword } : {}),
    server,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const s of sockets) s.destroy();
      });
      cleanup();
    },
  };
}

/** The content security policies (static.ts), for the tests and the web app's own checks. */
export { NONE_CSP, PAGE_CSP };
