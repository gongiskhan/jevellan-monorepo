// A mock of the jevellan-ui server for the web app's browser checks: it serves the built app from dist/web (index.html
// for every route that is not a file) and answers the UI route contract of brief section 7 from fixtures.mjs:
// sign-in with the cookie jv_ui (401 {error: 'Sign in.'} without it, 401 {error: 'Wrong password.'} for a wrong
// password), every POST refused with 403 {error: 'read-only'} in read-only mode, errors as {error, exitCode} with the
// contract's HTTP statuses, Server-Sent Events on /api/events, evidence images under /evidence/, and the app's files
// under a strict Content-Security-Policy (CSP below) so inline scripts or styles would fail. Every request is kept
// in `requests` so a check can assert what the page posted. Nothing here touches a store or a real ~/.jv.
//
//   node test-web/mock-server.mjs [--port 7075] [--readonly]   serves until Ctrl-C and prints the URL and password

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { PASSWORD, buildFixtures } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = join(here, '..', 'dist', 'web');
const COOKIE = 'jv_ui';
const SESSION = 'fake-session-token-for-tests';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

/** A small PNG of a placeholder screenshot (`w` by `h`, two tones), for /evidence/. */
export function placeholderPng(w = 480, h = 300, a = [225, 235, 242], b = [192, 31, 139]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inside = x > w * 0.1 && x < w * 0.9 && y > h * 0.35 && y < h * 0.5;
      const c = inside ? b : a;
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({ unparsed: text });
      }
    });
  });
}

/**
 * The Content-Security-Policy the mock serves the app under: D-064's (scripts and styles from the site only, no
 * inline ones) plus the fonts, images and the live stream the web app needs, so a check fails when the app relies on
 * anything inline. The real server should send at least this much.
 */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const statusOf = (exitCode) => (exitCode === 2 ? 400 : exitCode === 3 ? 404 : exitCode === 4 ? 409 : 500);

export async function startMockServer({ port = 0, readonly = false, dist = DIST } = {}) {
  const data = buildFixtures();
  const requests = [];
  const clients = new Set();
  const png = placeholderPng();
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };
  const fail = (res, error, exitCode) => json(res, statusOf(exitCode), { error, exitCode });
  const signedIn = (req) => (req.headers.cookie ?? '').split(/;\s*/).includes(`${COOKIE}=${SESSION}`);
  const task = (id) => data.views.get(id);

  async function api(req, res, url) {
    const path = url.pathname;
    const q = url.searchParams;
    const method = req.method ?? 'GET';
    const body = method === 'POST' ? await readBody(req) : undefined;
    requests.push({ method, path, query: Object.fromEntries(q), body });

    if (path === '/api/session') return json(res, 200, { authenticated: signedIn(req), readonly, version: '0.1.0' });
    if (path === '/api/login' && method === 'POST') {
      if (body?.password !== PASSWORD) return json(res, 401, { error: 'Wrong password.' });
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${SESSION}; HttpOnly; SameSite=Lax; Path=/` });
    }
    if (!signedIn(req)) return json(res, 401, { error: 'Sign in.' });
    if (path === '/api/logout' && method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/` });
    if (method === 'POST' && readonly) return json(res, 403, { error: 'read-only' });

    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: heartbeat\ndata: {}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/status') {
      const project = q.get('project');
      if (!project) return json(res, 200, data.status);
      return json(res, 200, { ...data.status, tasks: data.status.tasks.filter((t) => t.project === project), sessions: data.status.sessions.filter((s) => s.project === project) });
    }
    if (path === '/api/projects') return method === 'POST' ? json(res, 200, { created: true, project: { id: 'PNEW001', name: body.name ?? 'new', path: body.path } }) : json(res, 200, data.projects);
    if (path === '/api/tasks' && method === 'GET') {
      const project = q.get('project');
      const state = q.get('state');
      return json(res, 200, { tasks: data.tasks.filter((t) => (!project || t.project === project) && (!state || t.state === state)) });
    }
    if (path === '/api/tasks' && method === 'POST') return json(res, 200, { task: { id: 'TNEW001', origin: 'ui' }, steps: [], created: true, workflow: {}, warnings: [] });
    let m = /^\/api\/tasks\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const view = task(id);
      if (!view && !data.tasks.some((t) => t.id === id)) return fail(res, `no task ${id}`, 3);
      const what = m[2];
      if (!what) return view ? json(res, 200, view) : fail(res, `no task view for ${id} in the mock`, 3);
      if (what === 'changes') {
        if (id !== data.changes.task) return fail(res, `task ${id} has no branch; it runs in the project checkout and has no changes of its own`, 2);
        return json(res, 200, q.get('stat') ? { ...data.changes, diff: undefined } : data.changes);
      }
      if (what === 'ui-action') {
        const action = body?.action ?? {};
        const isAnswer = action.name === 'answer' && typeof action.context?.label === 'string';
        return json(res, 200, { kind: isAnswer ? 'answer' : 'message', message: { id: 'MUIACT1', direction: 'owner', text: isAnswer ? action.context.label : `UI action ${action.name}: ${JSON.stringify(action.context ?? {}).slice(0, 4000)}` } });
      }
      if (['message', 'answer', 'stop', 'resume', 'override', 'land'].includes(what) && method === 'POST') return json(res, 200, { task: { id, state: view?.state ?? 'running' }, message: { id: 'MMOCK01' } });
      return fail(res, `no route ${path}`, 3);
    }
    m = /^\/api\/sessions\/([^/]+)\/(report|events)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === 'report') {
        const report = data.reports.get(id);
        return report ? json(res, 200, report) : fail(res, `session ${id} has no report`, 3);
      }
      const since = Number(q.get('sinceSeq') ?? 0);
      const limit = Math.min(200, Number(q.get('limit') ?? 200));
      const events = (data.eventsBySession.get(id) ?? []).filter((e) => e.seq > since).slice(0, limit);
      return json(res, 200, { session: id, events: events.map((e) => ({ session: e.session_id, seq: e.seq, at: e.at, kind: e.kind, payload: JSON.parse(e.payload) })) });
    }
    m = /^\/api\/projects\/([^/]+)\/(coordinator|notes|workflows)(?:\/([a-z]+))?$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (!data.projects.some((p) => p.name === name)) return fail(res, `no project ${name}`, 3);
      if (m[2] === 'notes') return method === 'POST' ? ((data.notes[name] = body.text), json(res, 200, { project: name, bytes: body.text.length, unchanged: false })) : json(res, 200, { project: name, text: data.notes[name] ?? '' });
      if (m[2] === 'workflows') return json(res, 200, { workflows: data.workflows[name] ?? [] });
      const running = data.status.sessions.some((s) => s.kind === 'coordinator' && s.project === name);
      if (!m[3]) return json(res, 200, { project: name, running, screen: running ? 'ready' : 'gone', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', ...(running ? { sessionId: 'RNE8VA4', startedAt: new Date(Date.now() - 31 * 60_000).toISOString(), attach: 'tmux attach -t jv-coord-shop' } : {}) });
      if (m[3] === 'transcript') return json(res, 200, name === 'shop' ? { ...data.transcript, entries: data.transcript.entries.slice(-Number(q.get('limit') ?? 100)) } : { project: name, session: null, entries: [], turns: [] });
      if (m[3] === 'start') return json(res, 200, { started: true, project: name });
      if (m[3] === 'message') return json(res, 200, { project: name, messageId: 'MCOORD1', session: 'RNE8VA4', typedAt: new Date().toISOString(), how: 'typed', text: body.text });
    }
    if (path === '/api/memory') {
      if (method === 'POST') return json(res, 200, { id: 'MNEW001', created: true, memory: { id: 'MNEW001', ...body } });
      const status = q.get('status') ?? 'active';
      const project = q.get('project');
      const query = (q.get('query') ?? '').toLowerCase();
      let rows = data.memories.filter((mem) => (status === 'all' || mem.status === status) && (!project || mem.scope === `project:${project}` || (query && mem.scope === 'global')) && (!q.get('kind') || mem.kind === q.get('kind')));
      if (query) rows = data.memories.filter((mem) => mem.status === 'active' && mem.text.toLowerCase().includes(query));
      return json(res, 200, query ? { query, scopes: ['global'], memories: rows } : { memories: rows });
    }
    m = /^\/api\/memory\/([^/]+)\/archive$/.exec(path);
    if (m) return json(res, 200, { memory: { ...data.memories.find((x) => x.id === m[1]), status: 'archived' } });
    if (path === '/api/schedules/preview') return json(res, 200, { nextRuns: [] });
    if (path === '/api/schedules') return method === 'POST' ? json(res, 200, { schedule: { id: 'CNEW001', ...body } }) : json(res, 200, { schedules: data.schedules.filter((s) => !q.get('project') || s.project === q.get('project')) });
    m = /^\/api\/schedules\/([^/]+)\/(run|pause|resume)$/.exec(path);
    if (m) return json(res, 200, { schedule: data.schedules.find((s) => s.id === m[1]), result: 'created TNEW002', task: 'TNEW002' });
    if (path === '/api/goals') return method === 'POST' ? json(res, 200, { goal: { id: 'GNEW001', ...body } }) : json(res, 200, { goals: data.goals.filter((g) => !q.get('project') || g.project === q.get('project')) });
    m = /^\/api\/goals\/([^/]+)\/(done|pause)$/.exec(path);
    if (m) return json(res, 200, { goal: data.goals.find((g) => g.id === m[1]) });
    if (path === '/api/jobs') return method === 'POST' ? json(res, 200, { job: { ...data.jobs[0], id: 'JNEW001', kind: body.kind, project: body.project }, created: true }) : json(res, 200, { jobs: data.jobs.filter((j) => !q.get('project') || j.project === q.get('project')) });
    if (path === '/api/usage') return json(res, 200, { ...data.usage, week: q.get('week') || data.usage.week });
    if (path === '/api/decisions') {
      const kind = q.get('kind');
      const list = data.decisions.decisions.filter((d) => !kind || d.kind === kind);
      return json(res, 200, { ...data.decisions, filter: { ...data.decisions.filter, kind: kind || null }, shown: list.length, decisions: list });
    }
    if (path === '/api/doctor') return json(res, 200, data.doctor);
    if (path === '/api/bot') return json(res, 200, data.bot);
    if (path === '/api/providers') return json(res, 200, data.providers);
    return fail(res, `endpoint ${path}`, 3);
  }

  function serveFile(res, file) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((error) => json(res, 500, { error: String(error), exitCode: 1 }));
      return;
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, version: '0.1.0' });
    if (url.pathname.startsWith('/evidence/')) {
      requests.push({ method: req.method, path: url.pathname });
      if (!signedIn(req) || !url.pathname.toLowerCase().endsWith('.png')) return json(res, 404, { error: 'not found', exitCode: 3 });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png);
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(dist, rel);
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) return serveFile(res, file);
    serveFile(res, join(dist, 'index.html'));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    data,
    password: PASSWORD,
    cookie: { name: COOKIE, value: SESSION, url },
    /** Sends a `change` event to every connected page. */
    emitChange() {
      for (const client of clients) client.write('event: change\ndata: {}\n\n');
    },
    async close() {
      for (const client of clients) client.end();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const portIndex = process.argv.indexOf('--port');
  const mock = await startMockServer({ port: portIndex > 0 ? Number(process.argv[portIndex + 1]) : 7075, readonly: process.argv.includes('--readonly') });
  console.log(`mock jv ui at ${mock.url} (password ${mock.password})`);
}
