// Advancing a task (section 7.6): what happens when a run ends, and how a step starts. The launcher advances steps;
// the coordinator does not.
//
// startStep(store, taskId, {reason, stepId?}) places a step (route.placeStep, one Jev call; or the owner's placement
// of jv task override --undo), creates its run row in the step's cwd (answer and converse: the project checkout;
// every other duty: the task worktree, section 7.3), links the decision to the run, marks the step running (a step
// being retried stays `retrying`), the task running, and spawns `jv run`. A Jev refusal (any exit 2 from the router)
// starts nothing: the step stays pending with the message as state_reason, the task is queued, the coordinator is
// woken. A run that cannot be spawned fails the step and the task.
//
// afterRun(store, sessionId), called by `jv run` when a run ended:
// - stopped and lost runs are left alone: whoever stopped a run owns the task's state, and a lost run continues by
//   `jv task resume` or by reconcile(), the bot's tick (jv status marks it lost at read time; see "Lost runs");
// - a run that is no longer the step's newest run, or of a task that ended, changes nothing;
// - messages for the task that are still undelivered are delivered at this turn boundary first (D-006): the same
//   native session is resumed with them, as a new run row, before anything advances;
// - report done: the step is done and its placement decision gets outcome_json {status, attempts, durationMs,
//   costUsd}; the next pending step (skipped ones are skipped) is placed and started; after the last step a single
//   task is done, any other task goes to landing and landTask(store, id, {auto: true}) runs;
// - report progress: the same native session continues with "Continue." as a new run row, up to 20 times per
//   placement of the step, then the task waits on the owner with "too many progress reports";
// - report needs-decision or blocked (or a turn that ended without any report): the task waits on the owner and the
//   coordinator is woken;
// - run failed, or a verify step reporting done with testsRun.passed false: the step's on_fail applies: goto the
//   named step (it becomes `retrying` with attempts + 1, every later step that is not skipped goes back to pending,
//   and the new placement's state carries the attempt and the failure summary), up to maxLoops; after that the step
//   and the task fail with the last summary as reason. A step without on_fail stops the task waiting on the owner
//   with the failure (the extra verify step of verify-then-land reads it that way, section 8).
// The extra verify step a verify-then-land landing appends (land.isLandingVerifyStep) goes back to landTask when it
// ends, passed or failed: landing lands it or puts the task in waiting-owner with the failure.
// When a task becomes done, every queued task whose after_task_id is it starts (releaseDependents).
//
// Slots (brief sections 3 and 8, limits.ts): a step started for a task in state `queued` (jv task create, a
// released --after dependent, jv task resume of a queued task, reconcile's admission) starts only while
// slotRefusal() allows it, checked before the Jev call and again in the transaction that creates the run (two
// admitters can both pass the first check; the queued run row is what holds the slot). Otherwise nothing is placed
// and the task stays queued with the reason exactly "waiting for a slot". A task that already runs (the next step,
// an on_fail retry, a continue, a message or an answer) and an owner placement (jv task override --undo) are never
// held back.
//
// Admission refusals: a Jev refusal of a step start records meta `admit_attempt:<T>` = {at, reason}; a start
// clears its reason. reconcile() retries a refused task at most once a minute and wakes the coordinator only when
// the reason is new (once per refusal, not per retry).
//
// Lost runs (the change to D-040 recorded with reconcile): a lost run that had reported is advanced by its report
// as afterRun would advance a finished one (advanceLostRun), and a run lost more than MAX_LOST_RESUMES times in a
// row counts as a failure of its step (failRun: on_fail, else the task waits on the owner). tasks.recoverLostRun
// decides which applies and otherwise resumes the conversation.
//
// Everything that needs no Jev call (the step's state, the outcome, the task's state) is written before the first
// await, so a caller that does not wait still leaves the store consistent.

import { conflict, isJvError, refused } from './errors.js';
import { createRun, spawnRun } from './launcher.js';
import { isLandingVerifyStep, landTask, type LandOptions, type LandResult } from './land.js';
import { readLimits, slotRefusal, WAITING_FOR_A_SLOT, type Limits } from './limits.js';
import { CONTINUE_PROMPT } from './prompt.js';
import { reportView } from './report.js';
import { LLM_DUTIES, placeStep, type Placement, type PlaceStepInput } from './route.js';
import type { Store } from './store.js';
import type { DecisionRow, ReportRow, SessionRow, StepRow, TaskRow } from './types.js';
import { notifyCoordinator, type WakeInput } from './wake.js';
import { parseOnFail, stepVisible } from './workflows.js';

/** Continue runs after progress reports, per placement of a step. */
export const MAX_PROGRESS = 20;
export const TOO_MANY_PROGRESS = 'too many progress reports';
/** Lost runs of one step in a row that are resumed; one more counts as a failure of the step. */
export const MAX_LOST_RESUMES = 3;
export const ADMIT_ATTEMPT_META_PREFIX = 'admit_attempt:';

const LIVE_RUN_STATES = ['queued', 'starting', 'running'] as const;
const ENDED_TASK_STATES = ['done', 'failed', 'stopped'] as const;

export interface AdvanceDeps {
  placeStep: (input: PlaceStepInput) => Promise<Placement & { decision: DecisionRow }>;
  /** Starts `jv run <R>` for a queued run (launcher.spawnRun). */
  spawn: (store: Store, sessionId: string) => void;
  notify: (store: Store, input: WakeInput) => Promise<void>;
  land: (store: Store, taskId: string, options: LandOptions) => Promise<LandResult>;
  /** Closes the tmux windows of finished claude-tmux conversations (runtimes/claude-tmux closeFinishedWindows). */
  closeWindows: (store: Store, scope: { taskId: string; stepId?: string }) => Promise<string[]>;
  /** The work limits a step started from `queued` must fit in (limits.readLimits: bot.json). */
  limits: () => Limits;
  /** Milliseconds since the epoch. */
  now: () => number;
}

export function defaultAdvanceDeps(): AdvanceDeps {
  return {
    placeStep,
    spawn: (store, id) => {
      spawnRun(store, id);
    },
    notify: notifyCoordinator,
    land: landTask,
    closeWindows: async (store, scope) => {
      const { closeFinishedWindows } = await import('./runtimes/claude-tmux.js');
      return closeFinishedWindows(store, scope);
    },
    limits: () => readLimits(),
    now: () => Date.now(),
  };
}

function withDefaults(deps: Partial<AdvanceDeps> | undefined): AdvanceDeps {
  return { ...defaultAdvanceDeps(), ...(deps ?? {}) };
}

// ---- small helpers ----------------------------------------------------------------------------------------------

function oneLine(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : t;
}

/** A wake line of section 9.4. `event` is "needs-decision", "failed", ...; the command names what to read. */
export function wakeLine(task: Pick<TaskRow, 'id' | 'title'>, duty: string | undefined, event: string, run: string): string {
  return `[jv] ${task.id} (${oneLine(task.title, 80)})${duty ? ` step ${duty}` : ''}: ${oneLine(event, 200)}. Run: ${run}`;
}

/** Wakes the coordinator; a wake that fails never stops the task from advancing. */
export async function wake(store: Store, deps: Pick<AdvanceDeps, 'notify'>, task: TaskRow, line: string): Promise<void> {
  try {
    await deps.notify(store, { projectId: task.project_id, taskId: task.id, line });
  } catch {
    // the event waits for jv status
  }
}

/** The step a task works on now: the first step (by ordinal) that is neither done nor skipped. */
export function currentStep(store: Store, taskId: string): StepRow | undefined {
  return store.listSteps(taskId).find((s) => s.state !== 'done' && s.state !== 'skipped');
}

/** The step startStep picks by default: the first pending or retrying step by ordinal. */
export function nextStartable(store: Store, taskId: string, afterOrdinal = 0): StepRow | undefined {
  const steps = store.listSteps(taskId).filter((s) => s.state === 'pending' || s.state === 'retrying');
  return steps.find((s) => s.ordinal > afterOrdinal) ?? steps[0];
}

/** Runs of a task that are queued or live. */
export function liveRuns(store: Store, taskId: string): SessionRow[] {
  return store.listSessions({ task_id: taskId, kind: 'step', states: LIVE_RUN_STATES });
}

/** The newest run of a step (or of the task when no step is given). */
export function latestRun(store: Store, taskId: string, stepId?: string): SessionRow | undefined {
  return store.listSessions({ task_id: taskId, kind: 'step', ...(stepId ? { step_id: stepId } : {}) }).at(-1);
}

/** The cwd of a duty (7.3): the project checkout for answer and converse, the task worktree for every other duty. */
export function dutyCwd(store: Store, task: TaskRow, duty: string): string {
  if (LLM_DUTIES.includes(duty)) return store.getProject(task.project_id)!.path;
  if (!task.worktree_path) throw refused(`task ${task.id} has no worktree; the duty ${duty} runs in one`);
  return task.worktree_path;
}

/**
 * outcome_json of the step's latest placement decision: {status, attempts, durationMs, costUsd} over the runs of
 * that placement (the runs of the step started since the decision was written).
 */
export function recordOutcome(store: Store, step: StepRow, status: 'done' | 'failed' | 'blocked'): DecisionRow | undefined {
  const decision = store.latestDecision({ kind: 'placement', step_id: step.id });
  if (!decision) return undefined;
  const runs = store.listSessions({ step_id: step.id }).filter((s) => s.started_at !== null && s.started_at >= decision.created_at);
  let durationMs = 0;
  let cost: number | null = null;
  for (const r of runs) {
    if (r.started_at && r.ended_at) durationMs += Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at));
    if (r.cost_usd !== null) cost = (cost ?? 0) + r.cost_usd;
  }
  const outcome = { status, attempts: Math.max(1, step.attempts), durationMs, costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6 };
  return store.updateDecision(decision.id, { outcome_json: JSON.stringify(outcome) });
}

// ---- admission refusals -----------------------------------------------------------------------------------------

/** meta admit_attempt:<T>: when the task's start was last refused, and why (reason null: the last start went through). */
export interface AdmitAttempt {
  at: string;
  reason: string | null;
}

export function admitAttemptKey(taskId: string): string {
  return `${ADMIT_ATTEMPT_META_PREFIX}${taskId}`;
}

export function readAdmitAttempt(store: Store, taskId: string): AdmitAttempt | undefined {
  const raw = store.getMeta(admitAttemptKey(taskId));
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<AdmitAttempt>;
    if (typeof v.at !== 'string') return undefined;
    return { at: v.at, reason: typeof v.reason === 'string' ? v.reason : null };
  } catch {
    return undefined;
  }
}

export function writeAdmitAttempt(store: Store, taskId: string, attempt: AdmitAttempt): void {
  store.setMeta(admitAttemptKey(taskId), JSON.stringify(attempt));
}

/** A start went through: a refusal recorded for the task is over (the next one is new and wakes the coordinator). */
function clearAdmitRefusal(store: Store, taskId: string, at: number): void {
  if (readAdmitAttempt(store, taskId)?.reason) writeAdmitAttempt(store, taskId, { at: new Date(at).toISOString(), reason: null });
}

/** The task stays queued with the reason exactly "waiting for a slot" (written only when it is not that already). */
export function waitForSlot(store: Store, taskId: string): { state: 'waiting'; reason: string } {
  const task = store.requireTask(taskId);
  if (task.state !== 'queued' || task.state_reason !== WAITING_FOR_A_SLOT) store.setTaskState(task.id, 'queued', WAITING_FOR_A_SLOT);
  return { state: 'waiting', reason: WAITING_FOR_A_SLOT };
}

// ---- starting a step --------------------------------------------------------------------------------------------

export interface StartStepOptions {
  /** Why the step starts (goes into the state reasons). */
  reason: string;
  /** Default: the first pending or retrying step. */
  stepId?: string;
  /** The placement's attempt (default: the step's attempts, at least 1). */
  attempt?: number;
  /** The failure summary a retry carries into the placement state. */
  failure?: string;
  /** The owner's placement (jv task override --undo): no Jev call. */
  owner?: { runtime: Placement['runtime']; provider: string; model: string; effort: string; decisionId: string };
  deps?: Partial<AdvanceDeps>;
}

export type StartStepResult =
  | { state: 'started'; step: StepRow; session: SessionRow; placement: Omit<Placement, 'decisionId'> & { decisionId: string } }
  | { state: 'refused'; step: StepRow; reason: string }
  | { state: 'failed'; step: StepRow; reason: string }
  | { state: 'waiting'; reason: string }
  | { state: 'none'; reason: string };

/**
 * Places and starts one step of a task (section 7.2 placement, 7.3 cwd). Refuses (exit 4) when the task already has
 * a live run, and (exit 2) when the task ended. Returns what happened; a Jev refusal is a result, not a throw. A task
 * in state `queued` starts only when a slot is free (see the header); otherwise the result is `waiting` with the
 * reason "waiting for a slot".
 */
export async function startStep(store: Store, taskId: string, options: StartStepOptions): Promise<StartStepResult> {
  const deps = withDefaults(options.deps);
  let task = store.requireTask(taskId);
  if ((ENDED_TASK_STATES as readonly string[]).includes(task.state)) throw refused(`task ${task.id} is ${task.state}; it does not start steps`);
  const live = liveRuns(store, task.id);
  if (live.length) throw conflict(`task ${task.id} already has a live run ${live.map((s) => s.id).join(', ')}`);
  if (task.after_task_id) {
    const before = store.getTask(task.after_task_id);
    if (before && before.state !== 'done') {
      const reason = `waiting for ${before.id} (${oneLine(before.title, 80)}) to finish`;
      store.setTaskState(task.id, 'queued', reason);
      return { state: 'waiting', reason };
    }
  }
  const step = options.stepId ? store.requireStep(options.stepId) : nextStartable(store, task.id);
  if (!step) return { state: 'none', reason: 'no step left to start' };
  if (step.task_id !== task.id) throw refused(`step ${step.id} belongs to task ${step.task_id}, not ${task.id}`);
  const attempt = options.attempt ?? Math.max(1, step.attempts);
  // A queued task starts only in a free slot; the owner's own placement is never held back.
  const limits = task.state === 'queued' && !options.owner ? deps.limits() : undefined;
  if (limits && slotRefusal(store, task.project_id, task.id, limits)) return waitForSlot(store, task.id);

  let placement: Omit<Placement, 'decisionId'> & { decisionId: string };
  if (options.owner) {
    placement = { ...options.owner, effort: options.owner.effort as Placement['effort'] };
  } else {
    try {
      const visible = task.visible === 1 || stepVisible(task.workflow_json, step.ordinal);
      const placed = await deps.placeStep({
        store,
        taskId: task.id,
        stepId: step.id,
        attempt,
        visible,
        ...(options.failure ? { failure: options.failure } : {}),
      });
      placement = { runtime: placed.runtime, provider: placed.provider, model: placed.model, effort: placed.effort, decisionId: placed.decisionId };
    } catch (error) {
      if (!isJvError(error) || error.exitCode !== 2) throw error;
      const reason = error.message;
      const current = store.requireStep(step.id);
      const pendingState = current.state === 'retrying' ? 'retrying' : 'pending';
      const refusedStep = store.tx(() => {
        const s = store.setStepState(step.id, pendingState, reason);
        store.setTaskState(task.id, 'queued', `step ${step.ordinal} (${step.duty}) not placed: ${reason}`);
        writeAdmitAttempt(store, task.id, { at: new Date(deps.now()).toISOString(), reason });
        return s;
      });
      task = store.requireTask(task.id);
      await wake(store, deps, task, wakeLine(task, step.duty, `not placed (${reason})`, `jv task show ${task.id}`));
      return { state: 'refused', step: refusedStep, reason };
    }
  }

  task = store.requireTask(task.id);
  const total = store.listSteps(task.id).length;
  const cwd = dutyCwd(store, task, step.duty);
  const where = `${placement.model} ${placement.effort} on ${placement.provider} (${placement.runtime})`;
  const started = store.tx(() => {
    // Again inside the transaction: another process (or another await of this one) may have started the task, or
    // taken the last slot, while Jev answered. The placement decision stays as it is, without a run.
    if (liveRuns(store, task.id).length) throw conflict(`task ${task.id} was started by another process while its step was placed`);
    if (limits && slotRefusal(store, task.project_id, task.id, limits)) return undefined;
    const run = createRun(store, {
      requestId: `run:${placement.decisionId}`,
      projectId: task.project_id,
      taskId: task.id,
      stepId: step.id,
      runtime: placement.runtime,
      provider: placement.provider,
      model: placement.model,
      effort: placement.effort,
      cwd,
      stateReason: `queued: step ${step.ordinal} (${step.duty}), decision ${placement.decisionId}`,
    }).row;
    store.updateDecision(placement.decisionId, { session_id: run.id });
    const fresh = store.requireStep(step.id);
    const state = fresh.state === 'retrying' ? 'retrying' : 'running';
    const s = store.setStepState(step.id, state, `${state === 'retrying' ? `attempt ${attempt}` : 'running'} on ${where} (${options.reason})`, {
      attempts: Math.max(1, fresh.attempts),
    });
    store.setTaskState(task.id, 'running', `step ${step.ordinal} of ${total} (${step.duty}) on ${where}`, { current_step: step.ordinal });
    clearAdmitRefusal(store, task.id, deps.now());
    return { session: run, startedStep: s };
  });
  if (!started) return waitForSlot(store, task.id);
  const { session, startedStep } = started;
  try {
    deps.spawn(store, session.id);
  } catch (error) {
    const reason = `could not start the run ${session.id}: ${error instanceof Error ? error.message : String(error)}`;
    const failedStep = store.tx(() => {
      const now = store.requireSession(session.id);
      if (now.state === 'queued' || now.state === 'starting') store.setSessionState(session.id, 'failed', reason);
      const s = store.setStepState(step.id, 'failed', reason);
      store.setTaskState(task.id, 'failed', reason);
      return s;
    });
    task = store.requireTask(task.id);
    await wake(store, deps, task, wakeLine(task, step.duty, 'failed (the run could not start)', `jv task show ${task.id}`));
    return { state: 'failed', step: failedStep, reason };
  }
  return { state: 'started', step: startedStep, session: store.requireSession(session.id), placement };
}

/**
 * A new run that continues `from`'s native session (same runtime, provider, model, effort and cwd), spawned at once:
 * "Continue." after a progress report, messages at a turn boundary, an answer, a resume. Without a native session
 * the run starts the conversation again (llm runs keep no native id).
 */
export function continueRun(
  store: Store,
  from: SessionRow,
  options: { requestId: string; message?: string; reason: string; taskReason: string; deps?: Partial<AdvanceDeps> },
): SessionRow {
  const deps = withDefaults(options.deps);
  const run = store.tx(() => {
    const created = createRun(store, {
      requestId: options.requestId,
      projectId: from.project_id,
      taskId: from.task_id,
      stepId: from.step_id,
      runtime: from.runtime,
      provider: from.provider,
      model: from.model,
      effort: from.effort,
      cwd: from.cwd,
      ...(from.native_session_id ? { nativeSessionId: from.native_session_id } : {}),
      ...(options.message ? { message: options.message } : {}),
      stateReason: options.reason,
    }).row;
    if (from.task_id) {
      const step = from.step_id ? store.getStep(from.step_id) : undefined;
      if (step && step.state !== 'running' && step.state !== 'retrying') store.setStepState(step.id, 'running', options.reason);
      store.setTaskState(from.task_id, 'running', options.taskReason);
    }
    return created;
  });
  if (run.state !== 'queued') throw conflict(`run ${run.id} for ${options.requestId} was already started (${run.state})`);
  try {
    deps.spawn(store, run.id);
  } catch (error) {
    const reason = `could not start the run ${run.id}: ${error instanceof Error ? error.message : String(error)}`;
    store.tx(() => {
      if (store.requireSession(run.id).state === 'queued') store.setSessionState(run.id, 'failed', reason);
      if (from.task_id) store.setTaskState(from.task_id, 'waiting-owner', reason);
    });
    throw refused(reason);
  }
  return store.requireSession(run.id);
}

// ---- finishing ------------------------------------------------------------------------------------------------

/** Starts every queued task that waited for `taskId` (after_task_id) and has not started yet. */
export async function releaseDependents(store: Store, taskId: string, deps?: Partial<AdvanceDeps>): Promise<string[]> {
  const task = store.getTask(taskId);
  if (!task || task.state !== 'done') return [];
  const started: string[] = [];
  const waiting = store.listTasks({ project_id: task.project_id, states: ['queued'] }).filter((t) => t.after_task_id === taskId);
  for (const t of waiting) {
    if (liveRuns(store, t.id).length) continue;
    try {
      const r = await startStep(store, t.id, { reason: `${taskId} finished`, ...(deps ? { deps } : {}) });
      if (r.state === 'started') started.push(t.id);
    } catch {
      // that task stays queued with its reason; jv task resume starts it
    }
  }
  return started;
}

/** Every step is done or skipped: a single task is done; any other task goes to landing (jv land, automatic). */
export async function finishSteps(store: Store, taskId: string, deps?: Partial<AdvanceDeps>): Promise<TaskRow> {
  const d = withDefaults(deps);
  const task = store.requireTask(taskId);
  if (task.kind === 'single') {
    const last = store.listSteps(task.id).filter((s) => s.state === 'done').at(-1);
    store.setTaskState(task.id, 'done', last ? `step ${last.duty} done` : 'every step done');
    await releaseDependents(store, task.id, deps);
    return store.requireTask(task.id);
  }
  store.setTaskState(task.id, 'landing', 'every step is done; landing');
  try {
    await d.land(store, task.id, { auto: true });
  } catch (error) {
    const reason = `landing could not run: ${error instanceof Error ? error.message : String(error)}`;
    const now = store.requireTask(task.id);
    if (now.state === 'landing') store.setTaskState(task.id, 'landing', reason);
    await wake(store, d, now, wakeLine(now, undefined, `landing could not run (${error instanceof Error ? error.message : String(error)})`, `jv task show ${task.id}`));
  }
  const after = store.requireTask(task.id);
  if (after.state === 'done') await releaseDependents(store, task.id, deps);
  return after;
}

// ---- after a run ------------------------------------------------------------------------------------------------

function testsFailed(report: ReportRow): boolean {
  const view = reportView(report);
  return view.testsRun?.passed === false;
}

function progressCount(store: Store, step: StepRow): number {
  const decision = store.latestDecision({ kind: 'placement', step_id: step.id });
  const since = decision?.created_at ?? '';
  return store.listReports({ step_id: step.id }).filter((r) => r.status === 'progress' && r.created_at >= since).length;
}

/** What jv run calls when a run ended (section 7.6). See the header for every case. */
export async function afterRun(store: Store, sessionId: string, deps?: Partial<AdvanceDeps>): Promise<void> {
  const d = withDefaults(deps);
  await advanceAfterRun(store, sessionId, d, false);
  await closeAfter(store, sessionId, d);
}

/**
 * A lost run that had reported (its process died after jv_report, before its end event): the report is the turn's
 * outcome, so the task advances by it exactly as afterRun advances a finished run (done: the next step or landing;
 * progress: Continue.; needs-decision or blocked: the owner; a verify report with failing tests: on_fail). A lost
 * run without a report changes nothing here (tasks.recoverLostRun resumes it).
 */
export async function advanceLostRun(store: Store, sessionId: string, deps?: Partial<AdvanceDeps>): Promise<void> {
  const d = withDefaults(deps);
  const session = store.getSession(sessionId);
  if (!session || session.state !== 'lost' || !store.getReportBySession(sessionId)) return;
  await advanceAfterRun(store, sessionId, d, true);
  await closeAfter(store, sessionId, d);
}

/** Trailing runs of a step that were lost, newest first, counted until the first run that was not. */
export function lostStreak(store: Store, stepId: string): number {
  let n = 0;
  for (const r of store.listSessions({ step_id: stepId, kind: 'step' }).reverse()) {
    if (r.state !== 'lost') break;
    n++;
  }
  return n;
}

/**
 * Applies the step's failure rule to a run that counts as a failed one (a run lost more than MAX_LOST_RESUMES times
 * in a row): on_fail goto up to maxLoops, else the task waits on the owner with `summary`.
 */
export async function failRun(store: Store, sessionId: string, summary: string, deps?: Partial<AdvanceDeps>): Promise<void> {
  const d = withDefaults(deps);
  const session = store.requireSession(sessionId);
  if (!session.task_id || !session.step_id) return;
  const task = store.requireTask(session.task_id);
  if ((ENDED_TASK_STATES as readonly string[]).includes(task.state)) return;
  await handleFailure(store, task, store.requireStep(session.step_id), session, summary, d);
  await closeAfter(store, sessionId, d);
}

/** A step that finished, or a task that ended, keeps no claude-tmux window open (a later resume opens it again). */
async function closeAfter(store: Store, sessionId: string, d: AdvanceDeps): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session?.task_id || !session.step_id || session.kind !== 'step') return;
  const task = store.getTask(session.task_id);
  const step = store.getStep(session.step_id);
  if (!task || !step) return;
  const ended = (ENDED_TASK_STATES as readonly string[]).includes(task.state);
  if (!ended && step.state !== 'done') return;
  try {
    await d.closeWindows(store, ended ? { taskId: task.id } : { taskId: task.id, stepId: step.id });
  } catch {
    // a window that cannot be closed is left to the owner; the task has advanced
  }
}

async function advanceAfterRun(store: Store, sessionId: string, d: AdvanceDeps, lost: boolean): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.kind !== 'step' || !session.task_id || !session.step_id) return;
  if (session.state !== 'done' && session.state !== 'failed' && !(lost && session.state === 'lost')) return;
  const task = store.getTask(session.task_id);
  const step = store.getStep(session.step_id);
  if (!task || !step) return;
  if ((ENDED_TASK_STATES as readonly string[]).includes(task.state)) return;
  // Only the step's newest run advances it: a message or an answer may already have started the next turn.
  if (latestRun(store, task.id, step.id)?.id !== session.id) return;
  const report = store.getReportBySession(session.id);

  // Messages that arrived during the turn go to the same session before anything advances.
  const undelivered = store.listMessages({ task_id: task.id, undelivered: true });
  if (undelivered.length && session.state !== 'failed' && session.native_session_id && report?.status !== 'progress') {
    continueRun(store, session, {
      requestId: `messages:${session.id}`,
      reason: `delivering ${undelivered.length} message${undelivered.length === 1 ? '' : 's'} at the turn boundary`,
      taskReason: `step ${step.ordinal} (${step.duty}): delivering messages to the session`,
      deps: d,
    });
    return;
  }

  if (session.state === 'failed') {
    await handleFailure(store, task, step, session, `run ${session.id} failed: ${session.state_reason}`, d);
    return;
  }
  if (!report) {
    store.setTaskState(task.id, 'waiting-owner', `step ${step.ordinal} (${step.duty}): the turn ended without a report`);
    await wake(store, d, task, wakeLine(task, step.duty, 'blocked (no report)', `jv task show ${task.id}`));
    return;
  }
  switch (report.status) {
    case 'done': {
      if (step.duty === 'verify' && testsFailed(report)) {
        await handleFailure(store, task, step, session, report.summary, d);
        return;
      }
      store.tx(() => {
        store.setStepState(step.id, 'done', `report done (${session.id})`);
        recordOutcome(store, store.requireStep(step.id), 'done');
      });
      const next = nextStartable(store, task.id, step.ordinal);
      if (next) {
        await startStep(store, task.id, { stepId: next.id, reason: `step ${step.duty} done`, deps: d });
        return;
      }
      await finishSteps(store, task.id, d);
      return;
    }
    case 'progress': {
      const count = progressCount(store, step);
      if (count > MAX_PROGRESS) {
        store.tx(() => {
          recordOutcome(store, step, 'blocked');
          store.setTaskState(task.id, 'waiting-owner', `step ${step.ordinal} (${step.duty}): ${TOO_MANY_PROGRESS}`);
        });
        await wake(store, d, task, wakeLine(task, step.duty, `blocked (${TOO_MANY_PROGRESS})`, `jv report ${session.id}`));
        return;
      }
      continueRun(store, session, {
        requestId: `continue:${session.id}`,
        message: CONTINUE_PROMPT,
        reason: `continue after progress report ${count} of ${MAX_PROGRESS}`,
        taskReason: `step ${step.ordinal} (${step.duty}): progress ${count}, continuing`,
        deps: d,
      });
      return;
    }
    case 'needs-decision':
    case 'blocked': {
      const what = report.status === 'needs-decision' ? (report.question ?? report.summary) : report.summary;
      store.setTaskState(task.id, 'waiting-owner', `step ${step.ordinal} (${step.duty}): ${report.status}: ${oneLine(what)}`);
      await wake(store, d, task, wakeLine(task, step.duty, report.status, `jv report ${session.id}`));
      return;
    }
  }
}

/**
 * A failed run, or a verify step whose tests failed: on_fail goto (up to maxLoops), else the task waits on the owner
 * (no on_fail) or fails (loops exhausted).
 */
async function handleFailure(store: Store, task: TaskRow, step: StepRow, session: SessionRow, summary: string, deps: AdvanceDeps): Promise<void> {
  const short = oneLine(summary, 600);
  const onFail = parseOnFail(step.on_fail_json);
  const steps = store.listSteps(task.id);
  const target = onFail ? steps.filter((s) => s.duty === onFail.goto && s.ordinal <= step.ordinal).at(-1) : undefined;
  const readCommand = store.getReportBySession(session.id) ? `jv report ${session.id}` : `jv task show ${task.id}`;

  // The extra verify step of a verify-then-land landing: landing reads its outcome (section 8: waiting-owner with the
  // failure), so the failure goes back to landTask instead of on_fail.
  if (isLandingVerifyStep(store, step.id)) {
    store.tx(() => {
      recordOutcome(store, step, 'failed');
      store.setStepState(step.id, 'failed', short);
    });
    try {
      await deps.land(store, task.id, { auto: true });
      return;
    } catch {
      // landing could not take it: the task waits on the owner as below
    }
  }
  if (!onFail || !target) {
    store.tx(() => {
      recordOutcome(store, step, 'failed');
      store.setStepState(step.id, 'failed', short);
      store.setTaskState(task.id, 'waiting-owner', `step ${step.ordinal} (${step.duty}) failed: ${oneLine(summary)}`);
    });
    await wake(store, deps, task, wakeLine(task, step.duty, 'failed', readCommand));
    return;
  }
  const loops = Math.max(0, target.attempts - 1);
  if (loops >= onFail.maxLoops) {
    store.tx(() => {
      recordOutcome(store, step, 'failed');
      store.setStepState(step.id, 'failed', short);
      store.setTaskState(task.id, 'failed', `step ${step.ordinal} (${step.duty}) failed after ${loops} ${loops === 1 ? 'retry' : 'retries'}: ${oneLine(summary)}`);
    });
    await wake(store, deps, task, wakeLine(task, step.duty, 'failed', readCommand));
    return;
  }
  const attempt = Math.max(1, target.attempts) + 1;
  const reason = `retry ${loops + 1} of ${onFail.maxLoops} after ${step.duty} failed`;
  store.tx(() => {
    recordOutcome(store, step, 'failed');
    store.setStepState(target.id, 'retrying', `${reason}: ${short}`, { attempts: attempt });
    for (const s of steps) {
      if (s.ordinal <= target.ordinal || s.state === 'skipped') continue;
      store.setStepState(s.id, 'pending', `reset: ${target.duty} is retried`);
    }
    store.setTaskState(task.id, 'running', `${reason}; ${target.duty} again`);
  });
  await startStep(store, task.id, { stepId: target.id, reason, attempt, failure: short, deps });
}
