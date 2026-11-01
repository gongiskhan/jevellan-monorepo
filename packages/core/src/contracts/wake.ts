// The wake line contract (skills brief 9.4; brief section 3): the one line jv types into a project's coordinator
// window when a task needs it, which the coordinator skill reads and the bot (reconcile) sends merged.
//
//   [jv] <T> (<title>) step <duty>: <event>. Run: jv report <R>        a step's turn ended (advance.wakeLine)
//   [jv] <T> (<title>): <event>. Run: jv task show <T>                 a task without a step in question
//   [jv] <T> (<title>) landing: <event>. Run: jv task show <T>         landing (land.ts)
//   [jv] <N> updates. Run: jv status --json                            several lines inside one window (wake.mergedLine)
//
// The title is cut to 80 characters. wake.wakeLine makes every line one line (control characters become spaces,
// whitespace collapsed), masks secrets, and cuts it to 500 characters: a cut line ends in "..." and may have lost its
// "Run:" part, so it only has to start like a task line. The 500 is wake.ts's WAKE_LINE_MAX (a test keeps them equal;
// wake.ts is not imported here because it loads the coordinator's tmux code).

import { z } from 'zod';

export const WAKE_LINE_MAX_CHARS = 500;

const ID = '[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}';
const RUN = `jv report R${ID}|jv task show T${ID}|jv status --json`;
const TASK_LINE = new RegExp(`^\\[jv\\] (T${ID}) \\((.*?)\\)(?: step ([^:]+?)| (landing))?: (.+)\\. Run: (${RUN})$`, 'u');
const MERGED_LINE = /^\[jv\] ([1-9][0-9]*) updates\. Run: jv status --json$/u;
const CUT_LINE = new RegExp(`^\\[jv\\] (T${ID}) \\(.*\\.\\.\\.$`, 'u');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

export type ParsedWakeLine =
  | { form: 'task'; task: string; title: string; duty?: string; landing: boolean; event: string; run: string }
  | { form: 'merged'; count: number }
  | { form: 'cut'; task: string };

/** The parts of a wake line, or undefined when it is not one. */
export function parseWakeLine(line: string): ParsedWakeLine | undefined {
  if ([...line].length > WAKE_LINE_MAX_CHARS || CONTROL.test(line) || line !== line.trim()) return undefined;
  const merged = MERGED_LINE.exec(line);
  if (merged) return { form: 'merged', count: Number(merged[1]) };
  const task = TASK_LINE.exec(line);
  if (task) {
    return {
      form: 'task',
      task: task[1]!,
      title: task[2]!,
      ...(task[3] !== undefined ? { duty: task[3] } : {}),
      landing: task[4] !== undefined,
      event: task[5]!,
      run: task[6]!,
    };
  }
  const cut = [...line].length === WAKE_LINE_MAX_CHARS ? CUT_LINE.exec(line) : null;
  if (cut) return { form: 'cut', task: cut[1]! };
  return undefined;
}

/** One wake line as the coordinator receives it. */
export const WakeLineSchema = z.string().refine((line) => parseWakeLine(line) !== undefined, {
  error: 'not a wake line: "[jv] <T> (<title>) [step <duty>|landing]: <event>. Run: <jv report R|jv task show T|jv status --json>" or "[jv] <N> updates. Run: jv status --json", one line, at most 500 characters',
});
