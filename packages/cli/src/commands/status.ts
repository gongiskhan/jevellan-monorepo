// jv status [--project N] [--watch]: tasks and sessions that are not done, waiting-on-owner first, with the bot line
// on top (jevellan-core/status and bot-state, brief sections 4 and 8). Lost runs are marked at read time. --json is
// the shape the coordinator reads, plus the `bot` key.
//
// --watch repaints the text every 2 seconds (clear screen, cursor home, then the block) until SIGINT, which ends it
// with exit 0. It is for people only: with --json it is refused (exit 2), since a stream of repainted JSON is not
// something a script can read; scripts call jv status --json when they need it. An error on a repaint (a busy store)
// is shown in place of the block and the next repaint tries again; an error before the first paint (an unknown
// project) ends the command with its exit code as without --watch.

import type { EventEmitter } from 'node:events';
import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString } from '../command.js';
import { refused } from 'jevellan-core/errors';
import { redact } from 'jevellan-core/redact';
import { formatStatus, statusView } from 'jevellan-core/status';
import { openStore, type Store } from 'jevellan-core/store';

/** How often --watch repaints (brief section 4). */
export const WATCH_INTERVAL_MS = 2000;
/** Cursor home, then clear the screen: what `clear` does. */
export const CLEAR_SCREEN = '\x1b[H\x1b[2J';

function statusText(store: Store, project: string | undefined): string {
  const view = statusView(store, project ? { project } : {});
  return formatStatus(store, view, project ? { project } : {});
}

export interface WatchOptions {
  intervalMs?: number;
  /** Where SIGINT comes from; the process unless a test gives its own emitter. */
  signals?: Pick<EventEmitter, 'once' | 'off'>;
}

/**
 * Paints `render()` now and every intervalMs after, each time after clearing the screen, until SIGINT; resolves 0.
 * The first paint runs outside the loop, so its error is the command's error.
 */
export function watchStatus(render: () => string, io: Pick<CommandIo, 'write'>, options: WatchOptions = {}): Promise<number> {
  const signals = options.signals ?? process;
  io.write(`${CLEAR_SCREEN}${render()}\n`);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      let text: string;
      try {
        text = render();
      } catch (error) {
        text = `jv: ${redact(error instanceof Error ? error.message : String(error))} (trying again in ${Math.round((options.intervalMs ?? WATCH_INTERVAL_MS) / 1000)} s)`;
      }
      io.write(`${CLEAR_SCREEN}${text}\n`);
    }, options.intervalMs ?? WATCH_INTERVAL_MS);
    const stop = (): void => {
      clearInterval(timer);
      signals.off('SIGINT', stop);
      resolve(0);
    };
    signals.once('SIGINT', stop);
  });
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const project = flagString(args, 'project') ?? args.positionals[0];
  const watch = flagBool(args, 'watch');
  if (watch && io.json) throw refused('jv status --watch repaints text for people and has no --json form; run jv status --json for one reading');
  const store = openStore();
  try {
    if (watch) return await watchStatus(() => statusText(store, project), io);
    const view = statusView(store, project ? { project } : {});
    io.result(view, () => formatStatus(store, view, project ? { project } : {}));
    return 0;
  } finally {
    store.close();
  }
}
