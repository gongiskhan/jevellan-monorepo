// jv ui [--port 7071] [--bind 127.0.0.1] [--readonly] [--password-reset] (brief sections 4 and 7): the Jevellan web
// app and its JSON API, served until SIGTERM or SIGINT (Ctrl-C). Loopback by default; for the phone over Tailscale,
// `jv ui --bind <tailnet address>` (one address, never a wildcard).
//
// - Holds $JV_HOME/run/ui.pid while it runs: a second jv ui exits 2 naming the running pid; a stale file is taken over.
// - The sign-in password is $JV_HOME/ui-password, written at the first start; --password-reset writes a new one and
//   signs every browser out. Either way the new password is printed once, on stderr (also with --json), and never put
//   in the JSON result.
// - --readonly: no action is offered or accepted (every POST but sign-in is refused).
// - Prints the URL once (with --json: {url, port, bind, readonly, passwordFile}) and keeps running.
//
// The JSON routes that mirror control-plane tools are served from jevellan-mcp's operations table (the same table the
// MCP serves, so a route answers what the tool answers); the schedule preview from jevellan-scheduler's nextRuns. jv ui
// still warns about any route an operation is missing for (none in this build).

import { homedir } from 'node:os';
import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagInt, flagString } from '../command.js';
import { refused } from 'jevellan-core/errors';
import type { Store } from 'jevellan-core/store';
import { uiPidFile } from 'jevellan-ui/pidfile';
import {
  DEFAULT_BIND,
  DEFAULT_PORT,
  isLoopback,
  missingOperations,
  OPERATION_ROUTES,
  startUiServer,
  tailnetAddresses,
  type UiOperation,
} from 'jevellan-ui/server';
import { memory } from '../setup.js';
import { operations as mcpOperations } from 'jevellan-mcp/tools';
import { nextRuns } from 'jevellan-scheduler/cron';

/** A path for people: the home folder as ~ (display only). */
export function displayPath(file: string, home: string = homedir()): string {
  return home && file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** jv memory list --json, for GET /api/memory without a query. */
export function listMemories(store: Store, filter: { project?: string; kind?: string; status?: string; limit?: number }): Record<string, unknown> {
  const status = filter.status ?? 'active';
  if (status !== 'active' && status !== 'archived' && status !== 'all') throw refused('status is active, archived or all');
  if (filter.kind !== undefined && !(memory.MEMORY_KINDS as readonly string[]).includes(filter.kind)) {
    throw refused(`kind is one of ${memory.MEMORY_KINDS.join(', ')}`);
  }
  const project = filter.project !== undefined ? store.requireProject(filter.project).name : undefined;
  const memories = memory.list(store.db, {
    ...(project ? { scope: memory.projectScope(project) } : {}),
    ...(filter.kind ? { kind: filter.kind as memory.MemoryKind } : {}),
    status,
    limit: filter.limit ?? 200,
  });
  return { memories };
}

/** The control-plane operations the UI serves: jevellan-mcp's table. */
const operations: readonly UiOperation[] = mcpOperations;

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const port = flagInt(args, 'port') ?? DEFAULT_PORT;
  const bind = flagString(args, 'bind') ?? DEFAULT_BIND;
  const readonly = flagBool(args, 'readonly');
  const ui = await startUiServer({
    port,
    bind,
    readonly,
    operations,
    listMemories,
    nextRuns,
    pidFile: uiPidFile(),
    passwordReset: flagBool(args, 'password-reset'),
  });
  // Armed before the ready line: a signal sent as soon as the URL is read still closes the server and its pid file.
  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  if (ui.newPassword) io.warn(`UI password written to ${displayPath(ui.passwordFile)} (shown once): ${ui.newPassword}`);
  const missing = missingOperations(operations);
  if (missing.length) {
    const total = new Set(OPERATION_ROUTES.map((r) => r.operation)).size;
    io.warn(`jv ui: ${missing.length} of ${total} operations are not in this build; their routes answer "not available"`);
  }
  io.result(
    { url: ui.url, port: ui.port, bind: ui.bind, readonly: ui.readonly, passwordFile: ui.passwordFile },
    `jv ui: ${ui.url}${ui.readonly ? ' (read-only)' : ''}; Ctrl-C stops it`,
  );
  if (isLoopback(ui.bind)) {
    const tailnet = tailnetAddresses()[0];
    io.info(`Loopback only. For the phone over Tailscale: jv ui --bind ${tailnet ?? '<tailnet address>'}`);
  } else {
    io.info(`Serving on ${ui.bind}: anyone who can reach this address sees the sign-in page.`);
  }
  await stopped;
  await ui.close();
  return 0;
}
