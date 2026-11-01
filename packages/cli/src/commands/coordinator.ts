// jv coordinator start|stop|restart|status --project N (section 9.1, 9.5) and jv coordinator message --project N
// "text" (the monorepo brief's section 4: one owner line typed into the running coordinator, recorded on the project's
// coordinator conversation). See core's coordinator.ts and coordinator-chat.ts.

import type { CommandIo, ParsedArgs } from '../command.js';
import { requireFlag } from '../command.js';
import {
  coordinatorStatus,
  formatStatus,
  restartCoordinator,
  startCoordinator,
  stopCoordinator,
} from 'jevellan-core/coordinator';
import { messageCoordinator } from 'jevellan-core/coordinator-chat';
import { refused } from 'jevellan-core/errors';
import { openStore } from 'jevellan-core/store';

/** A time as local HH:MM, with the date when it is not today. */
function clock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  const project = requireFlag(args, 'project');
  const store = openStore();
  try {
    switch (sub) {
      case 'start': {
        io.info(`Starting the coordinator of ${project} (waits up to 60 s for its prompt).`);
        const r = await startCoordinator(store, project);
        io.result(r, () => `${r.started ? 'Started.' : 'Already running.'}\n${formatStatus(r)}`);
        return 0;
      }
      case 'stop': {
        const r = await stopCoordinator(store, project);
        io.result(r, r.stopped ? `Coordinator of ${r.project} ${r.reason}.` : `Coordinator of ${r.project}: ${r.reason}.`);
        return 0;
      }
      case 'restart': {
        io.info(`Restarting the coordinator of ${project}.`);
        const r = await restartCoordinator(store, project);
        io.result(r, () =>
          [
            `Restarted (${r.stop.reason}).`,
            formatStatus(r),
            r.handoffTyped ? 'Handoff typed as the first message.' : `Handoff not typed: ${r.handoffReason}.`,
          ].join('\n'),
        );
        return 0;
      }
      case 'message': {
        const text = args.positionals.slice(1).join(' ').trim();
        if (text === '') throw refused('the message text is required (jv coordinator message --project N "text")');
        const r = await messageCoordinator(store, project, text);
        io.result(r, `Message ${r.messageId} typed into the coordinator of ${r.project} (session ${r.session}) at ${clock(r.typedAt)}.`);
        return 0;
      }
      case 'status':
      case undefined: {
        const r = coordinatorStatus(store, project);
        io.result(r, () => formatStatus(r));
        return 0;
      }
      default:
        throw refused(`unknown subcommand "jv coordinator ${sub}" (start, stop, restart, status or message)`);
    }
  } finally {
    store.close();
  }
}
