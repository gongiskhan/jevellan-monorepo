// Shared helpers of the jv ui server suites: an HTTP client that keeps the jv_ui cookie, raw requests (to set Host or
// send a request line fetch would normalise), an SSE reader, and fake operations that record every call, with a tiny
// schema of their own (required keys and their types), so the suites need neither jevellan-mcp nor zod.
// Every value here is made up.

import { request } from 'node:http';
import type { UiOperation } from '../../server/operations.js';

export interface Call {
  name: string;
  input: Record<string, unknown>;
  origin: string;
}

export interface FakeSchemaKey {
  type: 'string' | 'number' | 'boolean' | 'object';
  required?: boolean;
}

/** A schema that checks the keys it names, rejects keys it does not name, and passes the rest through. */
export function fakeSchema(keys: Readonly<Record<string, FakeSchemaKey>>): UiOperation['input'] {
  return {
    safeParse(value: unknown) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { success: false, error: { issues: [{ path: [], message: 'expected an object' }] } };
      }
      const v = value as Record<string, unknown>;
      for (const [key, spec] of Object.entries(keys)) {
        if (v[key] === undefined) {
          if (spec.required) return { success: false, error: { issues: [{ path: [key], message: 'Required' }] } };
          continue;
        }
        if (typeof v[key] !== spec.type) return { success: false, error: { issues: [{ path: [key], message: `expected ${spec.type}` }] } };
      }
      for (const key of Object.keys(v)) {
        if (!(key in keys)) return { success: false, error: { issues: [{ path: [key], message: 'Unrecognized key' }] } };
      }
      return { success: true, data: { ...v } };
    },
  };
}

export interface FakeOps {
  operations: UiOperation[];
  calls: Call[];
  /** Makes the named operation throw this error on its next calls. */
  fail(name: string, error: Error | undefined): void;
}

/** One fake operation per name; each returns {op: name, input} as its data. */
export function fakeOperations(specs: Readonly<Record<string, { mutates: boolean; keys: Readonly<Record<string, FakeSchemaKey>> }>>): FakeOps {
  const calls: Call[] = [];
  const failures = new Map<string, Error>();
  const operations: UiOperation[] = Object.entries(specs).map(([name, spec]) => ({
    name,
    mutates: spec.mutates,
    input: fakeSchema(spec.keys),
    run(input: unknown, ctx: { origin: string }) {
      calls.push({ name, input: input as Record<string, unknown>, origin: ctx.origin });
      const failure = failures.get(name);
      if (failure) throw failure;
      return { text: `${name} ok`, data: { op: name, input: input as Record<string, unknown> } };
    },
  }));
  return {
    operations,
    calls,
    fail(name, error) {
      if (error) failures.set(name, error);
      else failures.delete(name);
    },
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
  json(): any;
}

export interface RawOptions {
  method?: string;
  host?: string;
  headers?: Record<string, string>;
  body?: string;
  cookie?: string;
}

/** One request with node:http (the path goes on the request line as given). */
export function raw(base: string, path: string, options: RawOptions = {}): Promise<RawResponse> {
  const u = new URL(base);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.host) headers.Host = options.host;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(options.body));
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: options.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A client of one server that signs in once and sends JSON. */
export class Client {
  cookie = '';
  constructor(readonly base: string) {}

  async login(password: string): Promise<RawResponse> {
    const r = await this.post('/api/login', { password });
    const set = r.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (r.status === 200 && first) this.cookie = first.split(';')[0]!;
    return r;
  }

  get(path: string, options: RawOptions = {}): Promise<RawResponse> {
    return raw(this.base, path, { ...options, ...(this.cookie ? { cookie: this.cookie } : {}) });
  }

  post(path: string, body: unknown = {}, options: RawOptions = {}): Promise<RawResponse> {
    return raw(this.base, path, {
      method: 'POST',
      body: JSON.stringify(body),
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
      ...(this.cookie ? { cookie: this.cookie } : {}),
    });
  }
}

/** Reads a Server-Sent Events stream until a pattern shows up. */
export class EventReader {
  text = '';
  private readonly controller = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private readonly decoder = new TextDecoder();

  constructor(
    readonly url: string,
    readonly cookie: string,
  ) {}

  async open(): Promise<Response> {
    const r = await fetch(this.url, { headers: { Cookie: this.cookie }, signal: this.controller.signal });
    if (r.body) this.reader = r.body.getReader();
    return r;
  }

  async until(pattern: RegExp, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pattern.test(this.text)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${pattern} in ${JSON.stringify(this.text)}`);
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        this.reader!.read(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`no ${pattern} in ${JSON.stringify(this.text)}`)), left);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error('stream ended');
      this.text += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  count(pattern: RegExp): number {
    return (this.text.match(new RegExp(pattern.source, 'g')) ?? []).length;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reader?.cancel().catch(() => undefined);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
