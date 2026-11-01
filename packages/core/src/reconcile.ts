// reconcile(store, limits, options): what the bot runs every tick (brief sections 3 and 8), and what `jv status` runs
// read-only. It keeps the store true and the queue moving; it never stops a session, never lands outside landTask's
// own rules and never deletes anything.
//
// The four sub-steps run in this order; each is wrapped so a failure in one is recorded in `errors` and never stops
// the others, and each writes in its own short transactions (the store's tx per row change):
//
//   1. Lost runs. launcher.markLost marks every starting or running session whose process is gone and that has no
//      `end` event (a `starting` row that never recorded a pid within 60 s too: whoever spawned it died). Then, unless
//      read-only, tasks.recoverLostRun handles the newest lost run of each task's current step: advanced by its report
//      when it had reported; a failure of the step (on_fail, else the owner) after MAX_LOST_RESUMES lost runs in a
//      row; otherwise continued as jv task resume continues it, on the same native session with "Continue." (or the
//      step placed again when the run never had one). This is the change to D-040, which left lost runs to jv task
//      resume. Lost recovery runs before admission and is never slot-limited: the task was running when its run was
//      lost, so its resumed run takes back the slot before anything queued is admitted.
//   2. Admission (skipped with `admit: false`, the bot's quiet hours). Every task in state `queued` whose
//      after_task_id is null or done, oldest first, with no live run, starts its current step through
//      tasks.admitTask, the code path of jv task create (workflow questions, placement through route.ts, then the
//      runtime), while slotRefusal() allows it; a task that does not fit stays queued with "waiting for a slot" (the
//      next one may fit: the limit is per project and in total). When Jev refuses (no key, a timeout), the task stays
//      queued with the Jev message as its reason, meta `admit_attempt:<T>` records the refusal, and its admission is
//      retried at most once a minute. The coordinator is woken once per refusal: the wake of a retry that Jev refuses
//      for the same reason is dropped.
//   3. Delivery. Undelivered messages of a task whose live run is a running claude-tmux session are typed into its
//      window (the lifted delivery of jv task message, typeIntoConversation, "From the owner:" / "From the
//      coordinator:") and marked delivered to that run. Left out: messages the run's own prompt already carries (the
//      ids of its start `message` event; run.ts marks those delivered when the turn ends), and messages younger than
//      10 s, which jv task message may be typing itself right now.
//   4. Wake lines. Pending wake lines (wake.ts) whose flusher process is gone, or more than 30 s past its due time,
//      are taken over and typed as one merged line once the 5 s window allows it, so a jv process killed while it
//      waited to flush never strands the coordinator's queue.
//
// Every sub-step skips a task another process is starting: one with a step session in state `starting` for less
// than 60 s. options.readOnly (jv status) runs the marking of step 1 only.
//
// The summary: lost (sessions marked lost now), resumed (the runs that continue lost work), recovered (every lost
// run handled, with what was done), admitted (tasks started), refused ({task, reason}: Jev refusals of an admission
// or of a lost run's placement), delivered (message ids), woke (coordinator wake lines sent), errors ({step, message}).

import {
  liveRuns,
  readAdmitAttempt,
  waitForSlot,
  writeAdmitAttempt,
} from './advance.js';
import { liveCoordinator, realTmux, typeLine, type TmuxRunner } from './coordinator.js';
import { isAlive, isRunAlive, markLost, STARTING_GRACE_MS } from './launcher.js';
import { readLimits, slotRefusal, type Limits } from './limits.js';
import { resumeMessage } from './prompt.js';
import { redact } from './redact.js';
import type { Store } from './store.js';
import { admitTask, defaultTaskDeps, recoverLostRun, type LostRecovery, type TaskDeps } from './tasks.js';
import type { SessionRow } from './types.js';
import type { WakeInput } from './wake.js';
import { FLUSHER_STALE_MS, mergedLine, readWakeState, WAKE_META_PREFIX, WAKE_WINDOW_MS, wakeMetaKey } from './wake.js';

/** A refused admission is tried again after this long. */
export const ADMIT_RETRY_MS = 60_000;
/** Messages younger than this are left to jv task message, which types them itself. */
export const MESSAGE_GRACE_MS = 10_000;

export interface ReconcileDeps extends TaskDeps {
  /** Whether a run's process is there (launcher.isRunAlive). */
  alive: (s: SessionRow) => boolean;
  /** Whether a pid exists (the wake flusher's). */
  pidAlive: (pid: number) => boolean;
  /** tmux for the coordinator's window (the wake lines). */
  tmux: TmuxRunner;
}

export interface ReconcileOptions {
  /** jv status: mark lost runs, nothing else. */
  readOnly?: boolean;
  /** false: no admissions (quiet hours); lost runs, delivery and wake lines still run. Default true. */
  admit?: boolean;
  deps?: Partial<ReconcileDeps>;
}

export interface ReconcileSummary {
  lost: string[];
  resumed: string[];
  recovered: Array<Pick<LostRecovery, 'session' | 'task' | 'action' | 'run' | 'reason'>>;
  admitted: string[];
  refused: Array<{ task: string; reason: string }>;
  delivered: string[];
  woke: number;
  errors: Array<{ step: 'lost' | 'admit' | 'deliver' | 'wake'; message: string }>;
}

function message(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** Tasks with a step session that went `starting` less than STARTING_GRACE_MS ago: another process is starting them. */
export function tasksBeingStarted(store: Store, now: number): Set<string> {
  const since = new Date(now - STARTING_GRACE_MS).toISOString();
  const rows = store.db
    .prepare(`SELECT DISTINCT task_id FROM sessions WHERE kind = 'step' AND state = 'starting' AND task_id IS NOT NULL AND started_at > ?`)
    .all(since) as Array<{ task_id: string }>;
  return new Set(rows.map((r) => r.task_id));
}

/** Lost step runs of tasks that are neither queued nor ended (the only ones recoverLostRun may act on), oldest first. */
function lostCandidates(store: Store): Array<{ id: string; task_id: string }> {
  return store.db
    .prepare(
      `SELECT s.id AS id, s.task_id AS task_id FROM sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.kind = 'step' AND s.state = 'lost' AND t.state NOT IN ('queued','done','failed','stopped') ORDER BY s.rowid`,
    )
    .all() as Array<{ id: string; task_id: string }>;
}

/** The message ids a run's own prompt carries (run.ts records them in the run's start `message` event). */
function promptMessageIds(store: Store, sessionId: string): Set<string> {
  const ids = new Set<string>();
  const rows = store.db.prepare(`SELECT payload FROM events WHERE session_id = ? AND kind = 'message'`).all(sessionId) as Array<{ payload: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as { messages?: unknown };
      if (Array.isArray(p.messages)) for (const m of p.messages) if (typeof m === 'string') ids.add(m);
    } catch {
      // not ours
    }
  }
  return ids;
}

/**
 * Pending wake lines whose flusher is gone (or 30 s past due) are taken over and typed as one line once the 5 s
 * window since the last line allows it. Returns how many lines were typed. Lines of a project whose coordinator is
 * not live are dropped, as wake() drops them (the store has the facts; jv status shows them).
 */
export async function flushPendingWakes(
  store: Store,
  deps: { tmux?: TmuxRunner; now?: () => number; pidAlive?: (pid: number) => boolean; windowMs?: number } = {},
): Promise<number> {
  const tmux = deps.tmux ?? realTmux;
  const now = deps.now ?? Date.now;
  const pidAlive = deps.pidAlive ?? ((pid: number) => isAlive(pid));
  const windowMs = deps.windowMs ?? WAKE_WINDOW_MS;
  let typed = 0;
  for (const { key } of store.listMeta(WAKE_META_PREFIX)) {
    const projectId = key.slice(WAKE_META_PREFIX.length);
    const due = (t: number): boolean => {
      const state = readWakeState(store, projectId);
      if (state.pending.length === 0) return false;
      const f = state.flusher;
      if (f && pidAlive(f.pid) && t <= Date.parse(f.dueAt) + FLUSHER_STALE_MS) return false;
      const last = state.lastSentAt ? Date.parse(state.lastSentAt) : Number.NEGATIVE_INFINITY;
      return t - last >= windowMs;
    };
    if (!due(now())) continue;
    const lines = store.tx((): string[] | undefined => {
      const t = now();
      if (!due(t)) return undefined;
      const pending = readWakeState(store, projectId).pending;
      store.setMeta(wakeMetaKey(projectId), JSON.stringify({ lastSentAt: new Date(t).toISOString(), pending: [] }));
      return pending;
    });
    if (!lines?.length) continue;
    const live = liveCoordinator(store, projectId, tmux);
    if (live && typeLine(tmux, live.record.tmuxSession, mergedLine(lines))) typed++;
  }
  return typed;
}

/**
 * Step 1 of reconcile, alone and synchronous: marks lost every starting or running session whose process is gone and
 * that has no end event, plus a starting row without a pid older than 60 s, skipping tasks another process is
 * starting. What `jv status` runs (reconcile read-only, brief section 3). Returns the ids marked.
 */
export function markLostRuns(store: Store, options: { alive?: (s: SessionRow) => boolean; now?: number; starting?: Set<string> } = {}): string[] {
  const now = options.now ?? Date.now();
  const starting = options.starting ?? tasksBeingStarted(store, now);
  return markLost(store, {
    ...(options.alive ? { alive: options.alive } : {}),
    skip: (s) => s.task_id !== null && starting.has(s.task_id),
    orphanAfterMs: STARTING_GRACE_MS,
    now,
  }).map((s) => s.id);
}

/** One reconciliation of the store (see the header). Never throws for a failing sub-step: it is in `errors`. */
export async function reconcile(store: Store, limits: Limits = readLimits(), options: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { lost: [], resumed: [], recovered: [], admitted: [], refused: [], delivered: [], woke: 0, errors: [] };
  const base: ReconcileDeps = {
    ...defaultTaskDeps(),
    alive: isRunAlive,
    pidAlive: (pid) => isAlive(pid),
    tmux: realTmux,
    ...(options.deps ?? {}),
  };
  // Every wake reconcile causes is counted; the work limits are the ones given.
  const d: ReconcileDeps = {
    ...base,
    limits: () => limits,
    notify: async (s, input) => {
      summary.woke++;
      await base.notify(s, input);
    },
  };
  const now = () => d.now();

  // 1. Lost runs: marked, then (unless read-only) recovered.
  let starting = new Set<string>();
  try {
    starting = tasksBeingStarted(store, now());
    summary.lost.push(...markLostRuns(store, { alive: d.alive, now: now(), starting }));
  } catch (error) {
    summary.errors.push({ step: 'lost', message: message(error) });
  }
  if (options.readOnly) return summary;

  try {
    for (const c of lostCandidates(store)) {
      if (starting.has(c.task_id)) continue;
      try {
        const r = await recoverLostRun(store, c.id, d);
        if (r.action === 'skipped') continue;
        summary.recovered.push({ session: r.session, task: r.task, action: r.action, ...(r.run ? { run: r.run } : {}), ...(r.reason ? { reason: r.reason } : {}) });
        if ((r.action === 'resumed' || r.action === 'placed') && r.run) summary.resumed.push(r.run);
        if (r.action === 'refused') summary.refused.push({ task: c.task_id, reason: r.reason ?? 'refused' });
      } catch (error) {
        summary.errors.push({ step: 'lost', message: `${c.id}: ${message(error)}` });
      }
    }
  } catch (error) {
    summary.errors.push({ step: 'lost', message: message(error) });
  }

  // 2. Admission of queued tasks, oldest first, in free slots.
  if (options.admit !== false) {
    try {
      for (const task of store.listTasks({ states: ['queued'] })) {
        try {
          if (starting.has(task.id) || liveRuns(store, task.id).length) continue;
          if (task.after_task_id && store.getTask(task.after_task_id)?.state !== 'done') continue;
          const prior = readAdmitAttempt(store, task.id);
          if (prior?.reason && now() - Date.parse(prior.at) < ADMIT_RETRY_MS) continue;
          if (slotRefusal(store, task.project_id, task.id, limits)) {
            waitForSlot(store, task.id);
            continue;
          }
          // The wakes of this attempt are held until it is known whether it is a retry of the same refusal.
          const held: WakeInput[] = [];
          const r = await admitTask(store, task.id, {
            reason: 'admitted by the bot',
            deps: { ...d, notify: async (_s, input) => void held.push(input) },
          });
          const forward = async () => {
            for (const w of held) await d.notify(store, w);
          };
          switch (r.state) {
            case 'started':
              summary.admitted.push(task.id);
              await forward();
              break;
            case 'refused': {
              const reason = r.reason ?? 'refused';
              writeAdmitAttempt(store, task.id, { at: new Date(now()).toISOString(), reason });
              summary.refused.push({ task: task.id, reason });
              if (prior?.reason !== reason) await forward();
              break;
            }
            case 'failed':
              summary.errors.push({ step: 'admit', message: `${task.id}: ${redact(r.reason ?? 'the run could not start')}` });
              await forward();
              break;
            default:
              await forward();
          }
        } catch (error) {
          summary.errors.push({ step: 'admit', message: `${task.id}: ${message(error)}` });
        }
      }
    } catch (error) {
      summary.errors.push({ step: 'admit', message: message(error) });
    }
  }

  // 3. Messages for live claude-tmux runs.
  try {
    const t = now();
    for (const run of store.listSessions({ kind: 'step', runtime: 'claude-tmux', states: ['running'] })) {
      if (!run.task_id || !run.tmux_target || starting.has(run.task_id)) continue;
      if (liveRuns(store, run.task_id).at(-1)?.id !== run.id) continue;
      try {
        const carried = promptMessageIds(store, run.id);
        const waiting = store
          .listMessages({ task_id: run.task_id, undelivered: true })
          .filter((m) => !carried.has(m.id) && t - Date.parse(m.created_at) >= MESSAGE_GRACE_MS);
        for (const m of waiting) {
          if (!(await d.typeIntoLive(store, run, resumeMessage(m.direction, m.text)))) break;
          store.markMessageDelivered(m.id, run.id);
          summary.delivered.push(m.id);
        }
      } catch (error) {
        summary.errors.push({ step: 'deliver', message: `${run.id}: ${message(error)}` });
      }
    }
  } catch (error) {
    summary.errors.push({ step: 'deliver', message: message(error) });
  }

  // 4. Wake lines a dead flusher left behind.
  try {
    summary.woke += await flushPendingWakes(store, { tmux: d.tmux, now, pidAlive: d.pidAlive });
  } catch (error) {
    summary.errors.push({ step: 'wake', message: message(error) });
  }
  return summary;
}
