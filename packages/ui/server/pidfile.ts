// The pid file of jv ui, $JV_HOME/run/ui.pid (brief section 4: long-running commands write one and refuse a second
// instance with exit 2 and the running pid). jv doctor reads the same file to tell jv's own listener on 7071 from
// another program's (M-022), so the file is JSON with `pid` first, which doctor's readPidFile accepts.
//
// - Acquire: created with O_EXCL. An existing file whose pid is alive refuses the start (exit 2, naming the pid and
//   the URL it serves). A file whose pid is gone is stale and taken over, and so is one whose pid now belongs to a
//   process that started after the file was written (`ps -o lstart`): the pid was reused after a crash or a reboot,
//   when the file was never removed. A process whose start time cannot be read counts as the holder.
// - Release: removed when the server closes, but only while it still names this process.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runFile } from 'jevellan-core/doctor';
import { refused } from 'jevellan-core/errors';
import { isAlive } from 'jevellan-core/launcher';

export interface PidRecord {
  pid: number;
  startedAt: string;
  url?: string;
  readonly?: boolean;
}

/** $JV_HOME/run/ui.pid */
export function uiPidFile(): string {
  return runFile('ui.pid');
}

export function readPidRecord(file: string): PidRecord | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as Partial<PidRecord>;
      if (typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0) {
        return { ...value, pid: value.pid, startedAt: typeof value.startedAt === 'string' ? value.startedAt : '' };
      }
    } catch {
      // not JSON after all: read as a bare pid below
    }
  }
  // A bare "<pid>" first word, as doctor's readPidFile also reads.
  const pid = Number(text.split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: '' } : undefined;
}

/** When a process started (whole seconds, from ps), or undefined when it cannot be read. */
export function processStartedAt(pid: number): number | undefined {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the process a pid file names still holds it (see the header for the reused-pid rule). */
export function holderRunning(record: PidRecord, startedAt: (pid: number) => number | undefined = processStartedAt): boolean {
  if (record.pid === process.pid) return true;
  if (!isAlive(record.pid)) return false;
  const written = Date.parse(record.startedAt);
  const started = startedAt(record.pid);
  if (!Number.isFinite(written) || started === undefined) return true;
  // ps gives whole seconds; the holder started before it wrote the file.
  return started <= Math.floor(written / 1000) * 1000;
}

function writeRecord(file: string, record: PidRecord, flag: 'wx' | 'w'): void {
  writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag });
}

export interface PidFile {
  file: string;
  /** Adds what the server serves once it listens. */
  update(extra: Pick<PidRecord, 'url' | 'readonly'>): void;
  release(): void;
}

/** Takes the pid file for this process, or refuses (exit 2) while another jv ui runs. */
export function acquirePidFile(file: string = uiPidFile()): PidFile {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const mine: PidRecord = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    writeRecord(file, mine, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const held = readPidRecord(file);
    if (held && holderRunning(held)) {
      throw refused(`jv ui is already running (pid ${held.pid}${held.url ? `, ${held.url}` : ''}); stop it first`);
    }
    // Stale: take it over (rename, so a reader never sees half a file), then check nobody else did the same.
    const tmp = `${file}.${process.pid}.tmp`;
    writeRecord(tmp, mine, 'w');
    renameSync(tmp, file);
    const now = readPidRecord(file);
    if (now?.pid !== process.pid) throw refused(`jv ui is already running (pid ${now?.pid ?? 'unknown'}); stop it first`);
  }
  let current = mine;
  let released = false;
  return {
    file,
    update(extra) {
      if (released) return;
      current = { ...current, ...extra };
      const tmp = `${file}.${process.pid}.tmp`;
      writeRecord(tmp, current, 'w');
      renameSync(tmp, file);
    },
    release() {
      if (released) return;
      released = true;
      if (readPidRecord(file)?.pid === process.pid) rmSync(file, { force: true });
    },
  };
}
