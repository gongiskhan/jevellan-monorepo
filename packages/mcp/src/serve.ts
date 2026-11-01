// What `jv mcp` and the jv-mcp bin do (brief sections 4 and 5), shared so both behave the same:
//
//   jv mcp [--stdio]                                   stdio until the client closes stdin. Nothing else is written to
//                                                      stdout (it is the protocol); no pid file, since every MCP client
//                                                      starts a server of its own and several run at once.
//   jv mcp --http [--port 7072] [--bind 127.0.0.1]     Streamable HTTP at /mcp. One per JV_HOME: $JV_HOME/run/mcp.pid
//                                                      (O_EXCL, "<pid>\n") refuses a second one with exit 2 and the
//                                                      running pid; a pid file whose process is gone is taken over.
//                                                      The bearer token (~/.jv/secrets/mcp.token, 32 random bytes,
//                                                      base64url, mode 600) is written at the first start and printed
//                                                      that one time, before the port is bound so a failed bind never
//                                                      loses it; a port in use is refused naming --port. The URL is
//                                                      printed, and SIGTERM or SIGINT closes the server and removes
//                                                      the pid file.
//   jv mcp [--http] --token-reset                      rotates the token (printed once the same way); alone it only
//                                                      rotates, refused while an HTTP server runs (it would keep the
//                                                      old token until restarted).
//
// With --json the start prints one object {url, port, bind, pid, tokenFile, tokenWritten} and never the token itself:
// a just-written token is then read from its file. Every call is logged to ~/.jv/logs/mcp.log by the server
// (server.ts), never with its arguments.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { ownerHome } from 'jevellan-core/env';
import { refused } from 'jevellan-core/errors';
import { isAlive } from 'jevellan-core/launcher';
import { paths } from 'jevellan-core/paths';
import { DEFAULT_MCP_BIND, DEFAULT_MCP_PORT, ensureToken, startHttp, serveStdio, tokenFile, validateMcpBind, type RunningHttp } from './server.js';

export type McpMode = 'stdio' | 'http' | 'token-reset';

export interface McpCommandOptions {
  mode: McpMode;
  port?: number;
  bind?: string;
  /** With mode http: rotate the token before serving. */
  tokenReset?: boolean;
  json?: boolean;
}

export interface McpCommandOutput {
  /** The command's result on stdout (never called in stdio mode). */
  out(text: string): void;
  /** Lines for people on stderr. */
  err(text: string): void;
}

export interface SignalSource {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** $JV_HOME/run/mcp.pid, the pid file of `jv mcp --http` (jv doctor's ports:mcp line reads it). */
export function mcpPidFile(): string {
  return join(paths.home, 'run', 'mcp.pid');
}

/** The pid in a pid file when that process is alive, else undefined. */
export function livePid(file: string = mcpPidFile()): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(file, 'utf8').trim().split(/\s+/)[0]);
  } catch {
    return undefined;
  }
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : undefined;
}

/**
 * Writes this process's pid into the pid file (O_EXCL). A file whose process is alive refuses (exit 2) with that pid;
 * one whose process is gone is taken over. Returns the release, which removes the file only while it holds our pid.
 */
export function acquirePidFile(file: string = mcpPidFile()): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const running = livePid(file);
    if (running !== undefined) throw refused(`jv mcp --http is already running (pid ${running})`);
    try {
      unlinkSync(file);
    } catch {
      // another process took it over first; try again
    }
  }
  throw refused(`could not take over ${file}`);
}

/** A path as the owner reads it: ~/... under the home folder. */
export function shownPath(file: string, home: string = ownerHome()): string {
  return file === home ? '~' : file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file;
}

/** The two lines that show a just-written token, the only time it is shown (brief section 5). */
export function tokenLines(token: string, file: string = tokenFile()): string {
  return `MCP token written to ${shownPath(file)} (shown once):\n${token}`;
}

function validPort(port: number | undefined): number {
  const p = port ?? DEFAULT_MCP_PORT;
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw refused(`--port needs a port number from 1 to 65535, not ${String(port)}`);
  return p;
}

function waitForSignal(signals: SignalSource): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      signals.off('SIGTERM', stop);
      signals.off('SIGINT', stop);
      resolve();
    };
    signals.once('SIGTERM', stop);
    signals.once('SIGINT', stop);
  });
}

/** Runs `jv mcp` with parsed options; resolves with the exit code when it stops. */
export async function runMcpCommand(
  options: McpCommandOptions,
  output: McpCommandOutput,
  hooks: { signals?: SignalSource; onListening?: (running: RunningHttp) => void } = {},
): Promise<number> {
  if (options.mode === 'stdio') {
    if (options.tokenReset) throw refused('--token-reset is for the HTTP transport: jv mcp --http --token-reset, or jv mcp --token-reset alone');
    if (options.port !== undefined || options.bind !== undefined) throw refused('--port and --bind are for jv mcp --http');
    await serveStdio();
    return 0;
  }

  if (options.mode === 'token-reset') {
    const running = livePid();
    if (running !== undefined) throw refused(`jv mcp --http is running (pid ${running}) and keeps the token it started with; stop it, then run jv mcp --http --token-reset`);
    const { token } = ensureToken({ reset: true });
    if (options.json) {
      output.out(JSON.stringify({ tokenFile: tokenFile(), tokenWritten: true }, null, 2));
      output.err(`MCP token written to ${shownPath(tokenFile())}; read it there.`);
    } else output.out(tokenLines(token));
    return 0;
  }

  const port = validPort(options.port);
  const bind = validateMcpBind(options.bind ?? DEFAULT_MCP_BIND);
  const release = acquirePidFile();
  try {
    const { token, written } = ensureToken({ reset: options.tokenReset === true });
    if (written) {
      if (options.json) output.err(`MCP token written to ${shownPath(tokenFile())}; read it there.`);
      else output.out(tokenLines(token));
    }
    const running = await startHttp({ port, bind, token });
    try {
      if (options.json) {
        output.out(JSON.stringify({ url: running.url, port: running.port, bind: running.bind, pid: process.pid, tokenFile: tokenFile(), tokenWritten: written }, null, 2));
      } else {
        output.out(`jv mcp: ${running.url} (bearer token in ${shownPath(tokenFile())}; Ctrl-C stops it)`);
      }
      output.err(`Health: GET ${running.url.replace(/\/mcp$/, '/health')}. Calls are logged to ${shownPath(join(paths.logsDir, 'mcp.log'))}.`);
      hooks.onListening?.(running);
      await waitForSignal(hooks.signals ?? process);
    } finally {
      await running.close();
    }
    return 0;
  } finally {
    release();
  }
}
