// The launcher: creates run rows, starts each run as a detached `jv run <R>` process, tells live runs from lost ones,
// and stops runs.
//
// - createRun inserts a sessions row (one run = one turn, D-006) under a request id; a repeat with the same input
//   returns the row (store request_id rule). A run that continues a conversation carries its native_session_id; the
//   message it delivers besides the task's undelivered messages (for example "Continue.") is kept in meta
//   `run_message:<R>`, read by `jv run`.
// - spawnRun starts "<node> --disable-warning=ExperimentalWarning <JV_HOME>/runtime/bin/jv.mjs run <R>" detached
//   (its own session and process group: pgid = pid), stdout and stderr appended to ~/.jv/logs/<R>.log, and records
//   pid and pgid. The child gets this process's environment without JV_SESSION (a coordinator's id must not leak into
//   the run); the worker's own environment is built from scratch inside the run (env.ts).
// - markLost flips starting/running rows whose process is gone and that have no `end` event to `lost` (jv status and
//   jv tail call it at read time; reconcile every bot tick). Reconcile also passes `skip` (a task another process is
//   starting) and `orphanAfterMs`: a `starting` row that never got a pid within 60 s is lost too, since the process
//   that was spawning it died and the row would otherwise hold a slot forever (M-number of reconcile).
// - stopRun marks the row stopped, sends SIGTERM to its process group, and SIGKILL after the grace period (10 s),
//   only to a group it can show is the run's (runGroupToSignal): the row is starting or running (a waiting row from
//   jv attach or a takeover keeps the pid of a jv run that has ended), the recorded pid leads the recorded group, and
//   the leader's command line names the run, or, when the leader is gone, a process left in the group does. A pid
//   handed out again to another process (macOS wraps pids within hours) is never signalled, and neither is a group
//   jv cannot read: no signal on a guess.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { refused } from './errors.js';
import { bootstrapNode, jvEntry } from './env.js';
import { processCommandLine, processGroup as procGroup, processGroupMembers, processZombie } from './proc.js';
import { recordEvent } from './events.js';
import { paths } from './paths.js';
import type { Created, Store } from './store.js';
import type { Runtime, SessionKind, SessionRow, SessionState } from './types.js';

export const STOP_GRACE_MS = 10_000;
export const RUN_MESSAGE_META_PREFIX = 'run_message:';

export interface CreateRunInput {
  requestId: string;
  projectId: string;
  taskId?: string | null;
  stepId?: string | null;
  kind?: SessionKind;
  runtime: Runtime;
  provider: string;
  model: string;
  effort: string;
  cwd: string;
  /** The conversation this run continues (resume); absent for a first turn. */
  nativeSessionId?: string | null;
  /** A message this run delivers besides the task's undelivered messages (e.g. "Continue."). */
  message?: string;
  stateReason?: string;
}

/** Inserts the run's sessions row (state queued). */
export function createRun(store: Store, input: CreateRunInput): Created<SessionRow> {
  return store.tx(() => {
    const created = store.createSession({
      request_id: input.requestId,
      project_id: input.projectId,
      task_id: input.taskId ?? null,
      step_id: input.stepId ?? null,
      kind: input.kind ?? 'step',
      runtime: input.runtime,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      cwd: input.cwd,
      ...(input.nativeSessionId ? { native_session_id: input.nativeSessionId } : {}),
      state: 'queued',
      state_reason: input.stateReason ?? (input.nativeSessionId ? 'queued to continue the conversation' : 'queued'),
    });
    if (created.created && input.message !== undefined && input.message.trim() !== '') {
      store.setMeta(`${RUN_MESSAGE_META_PREFIX}${created.row.id}`, input.message);
    }
    return created;
  });
}

/** The extra message createRun stored for a run, if any. */
export function runMessage(store: Store, sessionId: string): string | undefined {
  return store.getMeta(`${RUN_MESSAGE_META_PREFIX}${sessionId}`);
}

export interface SpawnRunOptions {
  /** Node binary (default: the bootstrap Node of install.json, else this process's). */
  node?: string;
  /** The jv entry script (default: jvEntry(), M-007). */
  entry?: string;
  /** Environment of the run process (default: process.env without JV_SESSION). JV_HOME is always set. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedRun {
  pid: number;
  pgid: number;
  log: string;
}

/** Starts `jv run <R>` detached. Only a queued row can be started. */
export function spawnRun(store: Store, sessionId: string, options: SpawnRunOptions = {}): SpawnedRun {
  const session = store.requireSession(sessionId);
  if (session.state !== 'queued') throw refused(`session ${sessionId} is ${session.state}; only a queued run can be started`);
  const node = options.node ?? bootstrapNode();
  const entry = options.entry ?? jvEntry();
  const log = paths.sessionLog(sessionId);
  mkdirSync(paths.logsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), JV_HOME: paths.home };
  delete env.JV_SESSION;
  store.setSessionState(sessionId, 'starting', 'launching jv run');
  const fd = openSync(log, 'a', 0o600);
  try {
    const child = spawn(node, ['--disable-warning=ExperimentalWarning', entry, 'run', sessionId], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
      cwd: paths.home,
    });
    const pid = child.pid;
    if (pid === undefined) {
      store.setSessionState(sessionId, 'failed', `could not start jv run (${node})`);
      throw refused(`could not start jv run for ${sessionId}`);
    }
    child.on('error', () => {
      // reported through the row: markLost sees the process gone without an end event
    });
    child.unref();
    store.updateSession(sessionId, { pid, pgid: pid });
    return { pid, pgid: pid, log };
  } finally {
    closeSync(fd);
  }
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function isAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process group of a pid (proc.ts: /proc on Linux, ps elsewhere), else undefined. */
export function processGroup(pid: number): number | undefined {
  return procGroup(pid);
}

/**
 * Whether the run's process is still there: the pid exists, is not a zombie, and (where /proc can tell) its command
 * line names this session, so a reused pid does not keep a dead run alive (proc.ts, M-009).
 */
export function isRunAlive(session: Pick<SessionRow, 'id' | 'pid'>): boolean {
  if (!isAlive(session.pid)) return false;
  const pid = session.pid!;
  if (processZombie(pid)) return false;
  const cmdline = processCommandLine(pid);
  if (cmdline === undefined) return true;
  return cmdline.includes(session.id);
}

const LIVE_STATES: readonly SessionState[] = ['starting', 'running'];

/** A run another process is starting is left alone this long (brief section 3, reconcile). */
export const STARTING_GRACE_MS = 60_000;

export interface MarkLostOptions {
  alive?: (s: SessionRow) => boolean;
  /** Rows this returns true for are not looked at (reconcile: a task another process is starting). */
  skip?: (s: SessionRow) => boolean;
  /**
   * A `starting` row with no pid whose start is older than this is lost too: the process that was spawning it died
   * between moving it to starting and recording the pid, and nothing else would ever end it (reconcile passes
   * STARTING_GRACE_MS; the default leaves such rows alone, as the lifted markLost did).
   */
  orphanAfterMs?: number;
  /** Milliseconds since the epoch (tests). */
  now?: number;
}

/** Marks starting/running rows lost when their process is gone and no `end` event arrived. Returns them. */
export function markLost(store: Store, options: MarkLostOptions = {}): SessionRow[] {
  const alive = options.alive ?? isRunAlive;
  const now = options.now ?? Date.now();
  const lost: SessionRow[] = [];
  for (const s of store.listSessions({ states: LIVE_STATES })) {
    if (options.skip?.(s)) continue;
    let reason: string;
    if (s.pid === null) {
      const since = s.started_at ? Date.parse(s.started_at) : Number.NaN;
      if (options.orphanAfterMs === undefined || s.state !== 'starting' || !(now - since > options.orphanAfterMs)) continue;
      reason = `no process was recorded within ${Math.round(options.orphanAfterMs / 1000)} s of starting`;
    } else {
      if (alive(s)) continue;
      reason = `process ${s.pid} ended without an end event`;
    }
    const row = store.tx(() => {
      const current = store.getSession(s.id);
      if (!current || !LIVE_STATES.includes(current.state) || current.pid !== s.pid) return undefined;
      if (store.lastEvent(s.id, 'end')) return undefined;
      return store.setSessionState(s.id, 'lost', reason);
    });
    if (row) lost.push(row);
  }
  return lost;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface StopRunResult {
  session: SessionRow;
  signalled: boolean;
  killed: boolean;
  /** Why no signal was sent, when none was (runGroupToSignal). */
  notSignalled?: string;
}

/**
 * The process group stopRun may signal for a run, or why it signals none. A signal goes only to a group jv can show
 * is still the run's:
 * - only a starting or running row has a process of its own: a queued row has none yet, and a waiting row (jv attach,
 *   a takeover) keeps the pid of a `jv run` that has ended, a number that may belong to anyone by now;
 * - the recorded pid leads the recorded group (jv starts every run in its own group: `jv run`, a tmux pane);
 * - while the leader lives: it is not a zombie, ps puts it at the head of the group, and its command line names the
 *   run (`jv run <R>`, `jv exec --session <R>`); a pid handed out again runs something else (M-009);
 * - when the leader is gone and the group lives on: the number was not handed out again while the group had
 *   members, but the members may be the leftovers of a later holder of the number, so the group is the run's only when
 *   one of them names the run (its worker or report server, `--session <R>`).
 * Whatever cannot be read (a command line, the group's members) counts as not shown.
 */
export function runGroupToSignal(session: Pick<SessionRow, 'id' | 'state' | 'pid' | 'pgid'>): { pgid: number } | { none: string } {
  if (!LIVE_STATES.includes(session.state)) return { none: `a ${session.state} run has no process of its own` };
  const pid = session.pid;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return { none: 'no process was recorded' };
  const pgid = session.pgid ?? pid;
  if (pgid !== pid) return { none: `process ${pid} does not lead the recorded process group ${pgid}` };
  if (!groupAlive(pgid)) return { none: `process group ${pgid} is gone` };
  if (isAlive(pid) && !processZombie(pid)) {
    const words = processCommandLine(pid);
    if (words === undefined) return { none: `the command line of process ${pid} cannot be read` };
    if (!words.includes(session.id)) return { none: `process ${pid} runs something else now (its command line does not name ${session.id})` };
    if (procGroup(pid) !== pgid) return { none: `process ${pid} does not lead process group ${pgid} any more` };
    return { pgid };
  }
  const members = processGroupMembers(pgid);
  if (members === undefined) return { none: `the processes of group ${pgid} cannot be listed` };
  if (members.some((m) => m.words?.includes(session.id))) return { pgid };
  return { none: `the leader ${pid} of process group ${pgid} is gone and no process left in it names ${session.id}` };
}

/**
 * Before the SIGKILL, whether the group the SIGTERM went to is still the run's: unless its leader is alive and runs
 * something else, yes. Its number cannot be handed out again while the group has members, and the grace period is
 * far shorter than the time pids take to wrap, so a group still there is the same group.
 */
function stillTheRunsGroup(session: Pick<SessionRow, 'id'>, pgid: number): boolean {
  if (!isAlive(pgid) || processZombie(pgid)) return true;
  return processCommandLine(pgid)?.includes(session.id) === true;
}

/**
 * Stops a run: state stopped with `reason`, SIGTERM to its process group, SIGKILL when the group is still there
 * after `graceMs` (default 10 s); the group is signalled only when runGroupToSignal shows it is the run's. The run
 * process writes its own `end` event on SIGTERM; when it had to be killed, or no signal was sent, the `end` event is
 * written here. A row that already ended is returned unchanged.
 */
export async function stopRun(store: Store, sessionId: string, reason: string, options: { graceMs?: number } = {}): Promise<StopRunResult> {
  const session = store.requireSession(sessionId);
  if (['done', 'failed', 'lost', 'stopped'].includes(session.state)) return { session, signalled: false, killed: false };
  const stopped = store.setSessionState(sessionId, 'stopped', reason);
  const target = runGroupToSignal(session);
  if ('none' in target) {
    if (!store.lastEvent(sessionId, 'end')) recordEvent(store, sessionId, 'end', { status: 'stopped', reason });
    return { session: store.requireSession(sessionId), signalled: false, killed: false, notSignalled: target.none };
  }
  const { pgid } = target;
  const signalled = signalGroup(pgid, 'SIGTERM');
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pgid)) await new Promise((r) => setTimeout(r, 100));
  let killed = false;
  if (groupAlive(pgid) && stillTheRunsGroup(session, pgid)) killed = signalGroup(pgid, 'SIGKILL');
  if (!store.lastEvent(sessionId, 'end')) recordEvent(store, sessionId, 'end', { status: 'stopped', reason });
  return { session: store.getSession(sessionId) ?? stopped, signalled, killed };
}
