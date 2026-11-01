// The bot's log, $JV_HOME/logs/bot.log (brief section 8): one line per notable thing (a start, a stop, a lock taken
// over, a lost run, an admission, a schedule fired, a job started or ended, the hourly housekeeping, an error), each
// `<ISO time> <text>`, every line passed through the redactor (D-014) and stripped of control characters, so a secret
// or a terminal escape in an error message never reaches the file. Routine ticks that did nothing write nothing, and
// an error or a refused admission that repeats every tick is written once per ten minutes (the store has every one).
// Housekeeping trims the file to bot.json's logLines lines (the newest), atomically, by a rename. Only the process
// holding the bot lock writes the file, and it trims synchronously between its own appends, so no line is lost.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from 'jevellan-core/paths';
import { redact } from 'jevellan-core/redact';

/** $JV_HOME/logs/bot.log */
export function botLogFile(): string {
  return join(paths.logsDir, 'bot.log');
}

/** A line as it is written: redacted, one line, no control characters, at most 2000 characters. */
export function cleanLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = redact(text).replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  return flat.length > 2000 ? `${flat.slice(0, 1997)}...` : flat;
}

export interface BotLog {
  readonly file: string;
  /**
   * Appends one line with the ISO time; never throws. With `repeat`, a line of the same key is written at most once
   * per `repeat.everyMs` (an error or a refusal that repeats every tick is logged every ten minutes, not every 15 s).
   */
  line(text: string, at?: Date, repeat?: { key: string; everyMs: number }): void;
}

/** How often a repeating error or refusal is logged again. */
export const REPEAT_LOG_MS = 10 * 60_000;

/** The log at `file` (default $JV_HOME/logs/bot.log); `echo` also receives every line (tests, a foreground run). */
export function openBotLog(file: string = botLogFile(), echo?: (line: string) => void): BotLog {
  let dirReady = false;
  const written = new Map<string, number>();
  return {
    file,
    line(text: string, at: Date = new Date(), repeat?: { key: string; everyMs: number }): void {
      if (repeat) {
        const last = written.get(repeat.key);
        if (last !== undefined && at.getTime() - last < repeat.everyMs) return;
        written.set(repeat.key, at.getTime());
        if (written.size > 1000) written.delete(written.keys().next().value!);
      }
      const line = `${at.toISOString()} ${cleanLine(text)}`;
      try {
        if (!dirReady) {
          mkdirSync(dirname(file), { recursive: true });
          dirReady = true;
        }
        appendFileSync(file, `${line}\n`, { mode: 0o600 });
      } catch {
        // a full disk or a removed folder must not stop the bot
      }
      echo?.(line);
    },
  };
}

/** Keeps the newest `maxLines` lines of a log file. Returns {before, after} line counts (0, 0 when there is no file). */
export function trimLog(file: string, maxLines: number): { before: number; after: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { before: 0, after: 0 };
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length <= maxLines) return { before: lines.length, after: lines.length };
  const kept = lines.slice(lines.length - maxLines);
  const tmp = `${file}.jv-${process.pid}.tmp`;
  writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { before: lines.length, after: kept.length };
}

/** The last `n` lines of a log file (the UI's /bot page shows 100), oldest first. */
export function lastLogLines(file: string = botLogFile(), n = 100): string[] {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(Math.max(0, lines.length - n));
  } catch {
    return [];
  }
}
