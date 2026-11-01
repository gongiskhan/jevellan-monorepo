// GET /api/events (brief section 7): one Server-Sent Events stream per open page.
//
// - `change` whenever the store moved: PRAGMA data_version of the server's own read-only connection (it moves when
//   any other connection commits, the server's own read-write connection included), plus the set of starting or
//   running sessions whose process is gone (D-063: a run that died writes nothing, yet its page must show the lost
//   dot). Checked every second; the page then fetches what it shows again.
// - `heartbeat` every 15 seconds, so proxies and phones keep the connection and the page knows it is live.
// - `hello` once at connect, with the current version, so a client knows the stream is open.
// - While at least one page is connected the server tails the coordinator transcripts every second (core
//   tailCoordinator, idempotent, the same call the bot makes every tick), so the chat follows the coordinator within
//   a second or two even without the bot. A --readonly server never tails: tailing writes events.
// - One poller and one heartbeat timer per server, both idle without clients; a failing tail never stops the poller.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultRedactor } from 'jevellan-core/redact';

export const POLL_MS = 1000;
export const HEARTBEAT_MS = 15_000;

export interface EventHubOptions {
  /** The current store stamp (data_version and lost sessions). */
  stamp: () => string;
  /** Tails the coordinators; undefined in --readonly mode. */
  tail?: () => void;
  pollMs?: number;
  heartbeatMs?: number;
}

export interface EventHub {
  connect(req: IncomingMessage, res: ServerResponse): void;
  clients(): number;
  close(): void;
}

export function eventHub(options: EventHubOptions): EventHub {
  const clients = new Set<ServerResponse>();
  let version = 0;
  let token = '';
  let tailFailure = '';

  const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const broadcast = (event: string, data: unknown): void => {
    const text = frame(event, data);
    for (const c of clients) c.write(text);
  };

  const poll = (): void => {
    if (clients.size === 0) return;
    if (options.tail) {
      try {
        options.tail();
        tailFailure = '';
      } catch (error) {
        const message = defaultRedactor().redact(error instanceof Error ? error.message : String(error));
        if (message !== tailFailure) process.stderr.write(`jv ui: coordinator tail failed: ${message}\n`);
        tailFailure = message;
      }
    }
    const next = options.stamp();
    if (next === token) return;
    token = next;
    version++;
    broadcast('change', { version, at: new Date().toISOString() });
  };

  const pollTimer = setInterval(poll, options.pollMs ?? POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (clients.size > 0) broadcast('heartbeat', { at: new Date().toISOString() });
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  pollTimer.unref();
  heartbeatTimer.unref();

  return {
    connect(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (clients.size === 0) token = options.stamp();
      clients.add(res);
      res.write(`retry: 2000\n\n${frame('hello', { version, at: new Date().toISOString() })}`);
      const drop = (): void => {
        clients.delete(res);
      };
      req.on('close', drop);
      res.on('close', drop);
    },
    clients: () => clients.size,
    close() {
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}
