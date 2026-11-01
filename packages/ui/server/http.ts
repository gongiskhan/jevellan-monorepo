// The HTTP plumbing of the jv ui server (brief section 7): responses, the error shape, JSON bodies and the headers
// every response carries. node:http only, no framework.
//
// - An error is {error, exitCode} as `jv ... --json` prints it, with the HTTP status the exit code maps to: 400 for 2
//   (refused), 404 for 3 (not found), 409 for 4 (conflict), 500 otherwise (the message of an unexpected error is
//   redacted and its stack goes to stderr, never to the client).
// - Every JSON body passes through the redactor once more (D-063: writers redact, the server redacts again).
// - A POST body must be JSON sent as application/json, at most 1 MB, and an object. Requiring the JSON content type is
//   what stops a cross-site or same-site page from posting a simple form or text request with the owner's cookie
//   (such a page cannot send application/json without a CORS preflight, and the server answers none).
// - Headers (D-064, amended for the web app): nosniff, no referrer, no framing, same-origin resource and opener
//   policies; the page's content security policy is in static.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { JvError } from 'jevellan-core/errors';
import { defaultRedactor } from 'jevellan-core/redact';

export const BODY_MAX_BYTES = 1024 * 1024;

/** A refusal of the HTTP layer itself (bad JSON, too large), carried like a JvError. */
export class HttpError extends Error {
  readonly status: number;
  readonly exitCode: number;
  /** The body is {error} alone (the contract's 403 {error: 'read-only'}). */
  readonly bare: boolean;
  constructor(status: number, message: string, exitCode = 2, bare = false) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.exitCode = exitCode;
    this.bare = bare;
  }
}

/** The HTTP status of an exit code (the route contract). */
export function statusOf(exitCode: number): number {
  if (exitCode === 2) return 400;
  if (exitCode === 3) return 404;
  if (exitCode === 4) return 409;
  return 500;
}

export function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

export function send(res: ServerResponse, status: number, type: string, body: string | Buffer, head: boolean, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': String(buf.length), ...extra });
  res.end(head ? undefined : buf);
}

export function sendText(res: ServerResponse, status: number, text: string, head: boolean, extra: Record<string, string> = {}): void {
  send(res, status, 'text/plain; charset=utf-8', text.endsWith('\n') ? text : `${text}\n`, head, extra);
}

/** JSON through the redactor, never cached. */
export function sendJson(res: ServerResponse, status: number, data: unknown, head: boolean, extra: Record<string, string> = {}): void {
  const safe = defaultRedactor().redactValue(data);
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(safe), head, { 'Cache-Control': 'no-store', ...extra });
}

/** {error, exitCode} with the status of the exit code. */
export function sendError(res: ServerResponse, exitCode: number, message: string, head: boolean): void {
  sendJson(res, statusOf(exitCode), { error: message, exitCode }, head);
}

/** Maps anything a handler threw to the error response (JvError and HttpError keep their code). */
export function sendThrown(res: ServerResponse, error: unknown, head: boolean): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, error.bare ? { error: error.message } : { error: error.message, exitCode: error.exitCode }, head);
    return;
  }
  if (error instanceof JvError) {
    sendError(res, error.exitCode, defaultRedactor().redact(error.message), head);
    return;
  }
  // Errors of the other packages that carry jv's exit codes (CronError, MemoryError) are refusals like JvError.
  const code = (error as { exitCode?: unknown } | null)?.exitCode;
  if (typeof code === 'number' && code >= 2 && code <= 4 && error instanceof Error) {
    sendError(res, code, defaultRedactor().redact(error.message), head);
    return;
  }
  process.stderr.write(`jv ui: ${defaultRedactor().redact(String((error as Error)?.stack ?? error))}\n`);
  sendError(res, 1, 'internal error', head);
}

/** Whether the request's Content-Type is JSON. */
export function isJsonRequest(req: IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'application/json';
}

/** Reads the whole body (at most `max` bytes); a larger body is a 413. */
export function readBody(req: IncomingMessage, max: number = BODY_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > max) {
      reject(new HttpError(413, `the body is larger than ${max} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        reject(new HttpError(413, `the body is larger than ${max} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

/** The JSON object a POST carries ({} for an empty body). Refuses another content type, bad JSON and non-objects. */
export async function readJsonObject(req: IncomingMessage, max: number = BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  if (!isJsonRequest(req)) throw new HttpError(400, 'send the request as JSON (Content-Type: application/json)');
  const raw = (await readBody(req, max)).toString('utf8');
  if (raw.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'the body must be a JSON object');
  return value as Record<string, unknown>;
}

/** decodeURIComponent, or undefined for a malformed escape. */
export function decoded(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** A query value, trimmed; undefined when absent or empty. */
export function queryValue(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null || v.trim() === '' ? undefined : v.trim();
}

/** The path with every query value dropped (keys kept): what the request log may hold. */
export function loggablePath(url: URL): string {
  const keys = [...new Set([...url.searchParams.keys()])];
  return keys.length ? `${url.pathname}?${keys.map((k) => encodeURIComponent(k)).join('&')}` : url.pathname;
}
