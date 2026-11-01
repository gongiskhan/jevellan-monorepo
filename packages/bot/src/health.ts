// The bot's health endpoint (brief section 8): GET http://<health.bind>:<health.port>/health (default
// 127.0.0.1:7073) answers exactly {"ok":true,"heartbeatAgeSeconds":3,"running":2,"queued":1,"version":"0.1.0"}, in
// that key order, read from the store on each request (jevellan-core's readBotState, the same reading as jv status).
// `ok` is true while the heartbeat is fresh (younger than max(60 s, 3 ticks), the alive rule of M-023) and the status
// is 200; a bot whose tick loop hangs answers ok false with 503, so a probe can tell. HEAD /health is the same without
// a body. Nothing else is served: every other method or path is 404 with an empty body. A taken port refuses the
// start (exit 2) with the fix doctor names.

import { createServer, type Server } from 'node:http';
import { refused } from 'jevellan-core/errors';
import { botConfigFile } from 'jevellan-core/limits';
import { heartbeatStaleSeconds, readBotState } from 'jevellan-core/bot-state';
import type { Store } from 'jevellan-core/store';
import { packageVersion } from 'jevellan-core/version';

export interface HealthBody {
  ok: boolean;
  heartbeatAgeSeconds: number | null;
  running: number;
  queued: number;
  version: string;
}

/** The health answer from the store, in the contract's key order. */
export function healthBody(store: Store, tickSeconds: number, now: number = Date.now()): HealthBody {
  const s = readBotState(store, now);
  const age = s.heartbeatAgeSeconds;
  return {
    ok: age !== null && age < heartbeatStaleSeconds(tickSeconds),
    heartbeatAgeSeconds: age,
    running: s.running,
    queued: s.queued,
    version: packageVersion(),
  };
}

export interface HealthServer {
  url: string;
  bind: string;
  port: number;
  close(): Promise<void>;
}

function hostForUrl(bind: string): string {
  return bind.includes(':') ? `[${bind}]` : bind;
}

/** Starts the health endpoint on bind:port (port 0 picks a free one, for tests). */
export function startHealthServer(store: Store, options: { bind: string; port: number; tickSeconds: number }): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/health' || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-length': '0' });
      res.end();
      return;
    }
    let status = 200;
    let text: string;
    try {
      const body = healthBody(store, options.tickSeconds);
      status = body.ok ? 200 : 503;
      text = JSON.stringify(body);
    } catch {
      // The store is busy or closing: the bot cannot say how it is.
      status = 503;
      text = JSON.stringify({ ok: false, heartbeatAgeSeconds: null, running: 0, queued: 0, version: packageVersion() } satisfies HealthBody);
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(req.method === 'HEAD' ? undefined : text);
  });
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.close();
      if (error.code === 'EADDRINUSE') {
        reject(refused(`port ${options.port} on ${options.bind} is in use: set health.port in ${botConfigFile()} to another free port`));
      } else if (error.code === 'EADDRNOTAVAIL') {
        reject(refused(`${options.bind} is not an address of this machine: set health.bind in ${botConfigFile()}`));
      } else reject(error);
    };
    server.once('error', onError);
    server.listen(options.port, options.bind, () => {
      server.off('error', onError);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url: `http://${hostForUrl(options.bind)}:${port}/health`,
        bind: options.bind,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
