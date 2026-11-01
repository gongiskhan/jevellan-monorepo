// One bot per JV_HOME (brief section 8): $JV_HOME/run/bot.lock, created with O_EXCL (open flag 'wx') and holding
// JSON {pid, command, startedAt} (doctor.readPidFile reads the pid from it). `jv bot start` holds it for its whole
// run and `jv bot tick` for its one tick, so a tick never runs beside a running bot and never overwrites its
// heartbeat. A second holder is refused with exit 2 "bot already running (pid N)".
//
// A lock whose pid is gone is stale (the bot was killed, the machine rebooted) and is taken over with a log line.
// "Gone" means: no such process, a zombie, or a live process whose command line does not mention the bot (the pid
// was reused by something else). A lock file with no readable pid is a holder still writing it when younger than
// 10 s, and stale after that. Two processes taking over one stale lock at once are serialised by a second O_EXCL
// file, bot.lock.takeover, held for the moment of the takeover only (stale itself after 10 s): whoever gets it
// rechecks that the lock is still the stale one, removes it and creates its own with O_EXCL; the other retries.
// The lock is released by its holder only: a release removes the file only while it still holds this pid.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { runFile } from 'jevellan-core/doctor';
import { refused } from 'jevellan-core/errors';
import { isAlive } from 'jevellan-core/launcher';
import { processCommandLine, processZombie } from 'jevellan-core/proc';

/** $JV_HOME/run/bot.lock */
export function botLockFile(): string {
  return runFile('bot.lock');
}

/** A lock (or takeover file) without a readable pid younger than this is being written; older, it is stale. */
export const UNREADABLE_LOCK_GRACE_MS = 10_000;

export interface LockContent {
  pid: number;
  command: string;
  startedAt: string;
}

export interface BotLock {
  file: string;
  pid: number;
  /** The pid of the stale lock this one took over, when it did. */
  tookOver?: number | null;
  /** Removes the lock file if it still holds this pid. Idempotent. */
  release(): void;
}

/** The lock's content, or undefined when the file is missing or holds no pid. */
export function readBotLock(file: string = botLockFile()): LockContent | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as Partial<LockContent>;
      if (typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0) {
        return { pid: v.pid, command: typeof v.command === 'string' ? v.command : '', startedAt: typeof v.startedAt === 'string' ? v.startedAt : '' };
      }
    } catch {
      // half written
    }
    return undefined;
  }
  // The plain form doctor also reads: "<pid>" on the first line.
  const pid = Number(text.split(/\s+/)[0]);
  return text !== '' && Number.isInteger(pid) && pid > 0 ? { pid, command: '', startedAt: '' } : undefined;
}

/** Whether `pid` is a live bot: alive, not a zombie, and (when its command line can be read) a bot command. */
export function lockHolderAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!isAlive(pid) || processZombie(pid)) return false;
  const words = processCommandLine(pid);
  if (words === undefined) return true;
  return words.some((w) => /\bbot\b/.test(w));
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function createExclusive(file: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function removeIfExists(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Removes the stale lock under the takeover guard; false when another process holds the guard right now. */
function takeOver(file: string, stale: LockContent | undefined): boolean {
  const guard = `${file}.takeover`;
  if (!createExclusive(guard, `${JSON.stringify({ pid: process.pid })}\n`)) {
    if (ageMs(guard) > UNREADABLE_LOCK_GRACE_MS) removeIfExists(guard);
    return false;
  }
  try {
    const now = readBotLock(file);
    if (now) {
      // Someone else took it over and holds it now: leave it.
      if (now.pid !== stale?.pid || lockHolderAlive(now.pid)) return true;
    } else if (ageMs(file) <= UNREADABLE_LOCK_GRACE_MS) {
      // Gone (another takeover just removed it) or being written by a new holder: retry from the start.
      return true;
    }
    removeIfExists(file);
    return true;
  } finally {
    removeIfExists(guard);
  }
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/**
 * Takes the bot lock for this process. Refuses (exit 2) "bot already running (pid N)" while a live bot holds it;
 * takes over a stale one, calling `onTakeover` with the stale pid (null when the file held none).
 */
export function acquireBotLock(options: { file?: string; command: string; onTakeover?: (pid: number | null) => void }): BotLock {
  const file = options.file ?? botLockFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify({ pid: process.pid, command: options.command, startedAt: new Date().toISOString() })}\n`;
  let tookOver: number | null | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (createExclusive(file, content)) {
      let released = false;
      return {
        file,
        pid: process.pid,
        ...(tookOver !== undefined ? { tookOver } : {}),
        release(): void {
          if (released) return;
          released = true;
          if (readBotLock(file)?.pid === process.pid) removeIfExists(file);
        },
      };
    }
    const holder = readBotLock(file);
    if (holder && lockHolderAlive(holder.pid)) throw refused(`bot already running (pid ${holder.pid})`);
    if (!holder && ageMs(file) <= UNREADABLE_LOCK_GRACE_MS) {
      pause(100);
      continue;
    }
    if (takeOver(file, holder)) {
      if (tookOver === undefined) {
        tookOver = holder?.pid ?? null;
        options.onTakeover?.(tookOver);
      }
    } else pause(50);
  }
  const holder = readBotLock(file);
  throw refused(holder ? `bot already running (pid ${holder.pid})` : `could not take ${file}; remove it if no bot runs`);
}
