// Facts about a running process by pid: its command line, its state letter, its process group, when it started, and
// the members of a process group. Linux reads /proc; macOS (and any system without /proc) asks `ps`. The lifted
// runtime read /proc only, so on macOS a reused pid kept a dead run alive and the process group was never known
// (M-009). The start time comes from `ps -o lstart` everywhere (whole seconds, read with LC_ALL=C so the date
// parses): what tells a pid file's or a lock's own process from a later process that got the same pid.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const HAS_PROC = process.platform === 'linux';

function psRun(args: string[], env?: NodeJS.ProcessEnv): string | undefined {
  try {
    const out = execFileSync('ps', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      // the whole process table with full command lines (processGroupMembers) runs to a few hundred KB
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env } : {}),
    }).trim();
    return out === '' ? undefined : out;
  } catch {
    // ps exits 1 when the pid is gone
    return undefined;
  }
}

function ps(pid: number, field: string, env?: NodeJS.ProcessEnv): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return psRun(['-ww', '-o', `${field}=`, '-p', String(pid)], env);
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

/** When a process started, in milliseconds since the epoch (whole seconds), or undefined when it cannot be read. */
export function processStartedAt(pid: number): number | undefined {
  const text = ps(pid, 'lstart', { ...process.env, LC_ALL: 'C' });
  const at = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}

export interface GroupMember {
  pid: number;
  /** Its command line as words (processCommandLine), undefined when it cannot be read. */
  words: string[] | undefined;
}

/** The processes whose process group is `pgid` (a zombie among them too), or undefined when they cannot be listed. */
export function processGroupMembers(pgid: number): GroupMember[] | undefined {
  if (!Number.isInteger(pgid) || pgid <= 0) return undefined;
  if (HAS_PROC) {
    let names: string[];
    try {
      names = readdirSync('/proc');
    } catch {
      return undefined;
    }
    const out: GroupMember[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (Number(procStatFields(pid)?.[2]) === pgid) out.push({ pid, words: processCommandLine(pid) });
    }
    return out;
  }
  const table = psRun(['-ww', '-A', '-o', 'pid=,pgid=,args=']);
  if (table === undefined) return undefined;
  const out: GroupMember[] = [];
  for (const line of table.split('\n')) {
    const [pid, group, ...words] = line.trim().split(/\s+/);
    if (Number(group) === pgid && Number.isInteger(Number(pid))) out.push({ pid: Number(pid), words: words.filter((w) => w !== '') });
  }
  return out;
}
