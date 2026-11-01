// Facts about a running process by pid: its command line, its state letter and its process group. Linux reads
// /proc; macOS (and any system without /proc) asks `ps`. The lifted runtime read /proc only, so on macOS a reused pid
// kept a dead run alive and the process group was never known (M-009).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HAS_PROC = process.platform === 'linux';

function ps(pid: number, field: string): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    // ps exits 1 when the pid is gone
    return undefined;
  }
}

function procStatFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid pgrp ...; comm may hold spaces and parentheses, so read after the last ')'.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return undefined;
  }
}

/**
 * The command line of a process as its words, or undefined when it cannot be read. On Linux the words are exact
 * (/proc/<pid>/cmdline); from `ps` they are the arguments split at whitespace, which keeps every jv id intact.
 */
export function processCommandLine(pid: number): string[] | undefined {
  if (HAS_PROC) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((w) => w !== '');
    } catch {
      return undefined;
    }
  }
  const args = ps(pid, 'args');
  return args === undefined ? undefined : args.split(/\s+/).filter((w) => w !== '');
}

/** The state letter of a process (R, S, D, T, Z, ...), or undefined when it cannot be read. */
export function processStateLetter(pid: number): string | undefined {
  if (HAS_PROC) return procStatFields(pid)?.[0]?.slice(0, 1);
  return ps(pid, 'stat')?.slice(0, 1);
}

/** Whether the process is a zombie (ended, not yet reaped). */
export function processZombie(pid: number): boolean {
  return processStateLetter(pid) === 'Z';
}

/** The process group of a pid, else undefined. */
export function processGroup(pid: number): number | undefined {
  const raw = HAS_PROC ? procStatFields(pid)?.[2] : ps(pid, 'pgid');
  const pgrp = Number(raw);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined;
}
