// Tasks (sections 3, 4, 7.1, 7.5, 7.6): jv task create, show, message, answer, stop, resume and override. The
// command module (src/commands/task.ts) parses arguments and prints; everything else is here.
//
// jv task create, in this order:
//   1. resolve the workflow (workflows.ts) and the request id: --request-id, or "auto:" + sha256 of the normalized
//      input (project id, kind, duty, title, text, parent, after, visible), so the same command run twice is one task;
//   2. preflight, only for a new request id: at least one logged-in eligible provider for every duty of the workflow
//      (the login state of meta provider_auth; providers whose state is missing or older than 12 hours are probed
//      first with the doctor's login check), else exit 2 with the doctor's lines, before anything is created. Jev is
//      not preflighted: a Jev refusal leaves the task queued (J9);
//   3. the task row and its steps, in one transaction (the request id rule makes a repeat return them);
//   4. the worktree (git.ts): branch jv/<slug>-<id6> at ~/.jv/worktrees/<project>/<slug>-<id6>, from the default
//      branch or the parent task's branch. Tasks whose every duty runs on llm (answer, converse) get none: they run
//      in the project checkout and never land;
//   5. task.md at ~/.jv/projects/<name>/tasks/<id>/task.md: the task text the first step receives;
//   6. the workflow questions (route.askWorkflowQuestions, 7.5), once per task: skipped steps get "Jev: not needed";
//   7. step 1 starts (advance.startStep) unless --after names a task that is not done.
// Everything from the worktree on is idempotent on the request id. A Jev refusal (any exit 2 from the router) leaves
// the task queued and its step pending with the message as state_reason, wakes the coordinator, and exits 2 with
// the message; jv task resume asks the workflow questions again if they were never answered and places the step.
// Steps 6 and 7 are admitTask(), which reconcile's admission (the bot) runs for queued tasks too. Step 1 starts only
// when a slot is free (limits.ts; advance.startStep checks it); otherwise the task stays queued with the reason
// "waiting for a slot", exit 0, and the bot (or jv task resume) starts it later. `start: false` (the planner) leaves
// the start to the bot from the beginning.
//
// Origin (schema 2): who created the task, `owner` by default, `coordinator` when JV_SESSION names a coordinator
// session (the D-042 rule); the UI, MCP, scheduler, planner and improver pass their own (jv task create --origin,
// internal). Checked against the store's TASK_ORIGIN_PATTERN before anything is written.
//
// Lost runs (the change to D-040 recorded with reconcile): recoverLostRun() is what the bot does with a lost run of
// a task's current step: advanced by its report when it had one, a failure of the step after MAX_LOST_RESUMES lost
// runs in a row, else continued the way jv task resume continues it (the same native session with "Continue.", or
// the step placed again when the run never got a native session).
//
// jv task list: listTaskSummaries() and formatTaskList(), newest first, with origin; text times are local.
//
// JSON shared by the command and the control MCP (brief section 5: a tool's structured content equals `jv ...
// --json`): createdTaskView() is what jv task create prints, taskView() what jv task show prints.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  advanceLostRun,
  continueRun,
  currentStep,
  defaultAdvanceDeps,
  failRun,
  finishSteps,
  latestRun,
  liveRuns,
  lostStreak,
  MAX_LOST_RESUMES,
  startStep,
  waitForSlot,
  wake,
  wakeLine,
  writeAdmitAttempt,
  type AdvanceDeps,
  type StartStepResult,
} from './advance.js';
import { conflict, isJvError, notFound, refused } from './errors.js';
import { slotRefusal } from './limits.js';
import { createWorktree, type CreatedWorktree } from './git.js';
import { ANSWERED_LEAVE_IT, askedLanding, closeAskedLandings, openVerifyLanding } from './land.js';
import { normalizeId } from './ids.js';
import { markLost, stopRun } from './launcher.js';
import { branchSlug, paths, slugify, taskBranch } from './paths.js';
import { CONTINUE_PROMPT, resumeMessage } from './prompt.js';
import {
  loadProviderAuthRecords,
  loadProviders,
  rankProviders,
  type ProviderAuthRecord,
  type ProvidersConfig,
} from './providers.js';
import { reportView, type ReportView } from './report.js';
import { ATTACHED_REASON, importTakeover } from './takeover.js';
import {
  askWorkflowQuestions,
  dutyRuntimes,
  kindsForRuntimes,
  LLM_DUTIES,
  loadDutyNeeds,
  ownerPlacement,
  SKIP_REASON,
  whenQuestion,
  type OwnerPlacementInput,
  type OwnerPlacementResult,
  type WorkflowAnswers,
  type WorkflowQuestionsInput,
} from './route.js';
import { TASK_ORIGIN_PATTERN, type Store } from './store.js';
import { TASK_STATES, type MessageDirection, type MessageRow, type OverrideMode, type SessionRow, type StepRow, type TaskKind, type TaskRow, type TaskState } from './types.js';
import { resolveWorkflow, stepVisible, workflowSteps, type ResolvedWorkflow } from './workflows.js';

/** A login state recorded this recently is used as it is; an older one (or none) is probed first. */
export const AUTH_FRESH_MS = 12 * 60 * 60 * 1000;
export const AUTO_REQUEST_PREFIX = 'auto:';

/** Everything jv task needs from the outside world; tests replace any of it. */
export interface TaskDeps extends AdvanceDeps {
  askWorkflowQuestions: (input: WorkflowQuestionsInput) => Promise<WorkflowAnswers>;
  ownerPlacement: (input: OwnerPlacementInput) => OwnerPlacementResult;
  /** The doctor's login check for these providers; it records each result in meta provider_auth (D-012). */
  probeLogins: (providers: string[]) => Promise<Array<{ name: string; status: string; line: string }>>;
  stopRun: (store: Store, sessionId: string, reason: string) => Promise<unknown>;
  /** Types a message into the live window of a claude-tmux conversation; false when no window is alive. */
  typeIntoLive: (store: Store, session: SessionRow, message: string) => Promise<boolean>;
  /** Whether a tmux session of exactly this name exists (the owner's takeover window of jv attach). */
  tmuxSessionAlive: (name: string) => Promise<boolean>;
  loadProviders: () => ProvidersConfig;
  now: () => number;
}

export function defaultTaskDeps(): TaskDeps {
  return {
    ...defaultAdvanceDeps(),
    askWorkflowQuestions,
    ownerPlacement,
    probeLogins: async (names) => {
      const { runChecks, formatCheck } = await import('./doctor.js');
      const results = await runChecks(names.map((n) => `login:${n}`));
      return results.map((r) => ({ name: r.name, status: r.status, line: formatCheck(r) }));
    },
    stopRun: (store, id, reason) => stopRun(store, id, reason),
    typeIntoLive: async (store, session, message) => {
      try {
        const { typeIntoConversation } = await import('./runtimes/claude-tmux.js');
        return (await typeIntoConversation(store, session.id, message)) !== undefined;
      } catch {
        return false;
      }
    },
    tmuxSessionAlive: async (name) => {
      const { hasSession, runTmux } = await import('./runtimes/claude-tmux.js');
      return hasSession(runTmux, name.replace(/^=/, '').replace(/:$/, ''));
    },
    loadProviders: () => loadProviders(),
    now: () => Date.now(),
  };
}

function withDefaults(deps: Partial<TaskDeps> | undefined): TaskDeps {
  return { ...defaultTaskDeps(), ...(deps ?? {}) };
}

function advanceDeps(d: TaskDeps): Partial<AdvanceDeps> {
  return { placeStep: d.placeStep, spawn: d.spawn, notify: d.notify, land: d.land, closeWindows: d.closeWindows, limits: d.limits, now: d.now };
}

function oneLine(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : t;
}

/** A task id typed by a person, resolved to the row (exit 3 when there is none). */
export function requireTaskId(store: Store, raw: string): TaskRow {
  return store.requireTask(normalizeId(raw));
}

// ---- jv task create ---------------------------------------------------------------------------------------------

export interface CreateTaskInput {
  project: string;
  kind: string;
  duty?: string;
  title: string;
  text: string;
  parent?: string;
  after?: string;
  visible?: boolean;
  requestId?: string;
  /**
   * Who creates the task (schema 2): owner, coordinator, ui, mcp, schedule:<C>, planner:<J> or improver:<J>.
   * Default: coordinator when JV_SESSION (of `env`) names a coordinator session, else owner. Not part of the
   * request id: a repeat from another origin returns the task the first one created.
   */
  origin?: string;
  /** The environment the caller runs in, for the default origin (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** false: create the task queued and leave its start to the bot's admission (reconcile). Default true. */
  start?: boolean;
}

/** The reason of a task created with `start: false`. */
export const QUEUED_FOR_THE_BOT = 'queued; the bot starts it when a slot is free';

/** The origin a task gets: the given one (checked), else coordinator or owner by the caller's JV_SESSION. */
export function taskOrigin(store: Store, origin: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (origin === undefined) return callerIsCoordinator(store, env) ? 'coordinator' : 'owner';
  const value = origin.trim();
  if (!TASK_ORIGIN_PATTERN.test(value)) {
    throw refused(`--origin ${JSON.stringify(origin)} is not one of owner, coordinator, ui, mcp, schedule:<C id>, planner:<J id>, improver:<J id>`);
  }
  return value;
}

/** Text as stored: line endings normalized, trailing whitespace of the whole text removed. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
}

/** "auto:" + sha256 of the normalized input (project id, kind, duty, title, text, parent, after, visible). */
export function autoRequestId(input: {
  projectId: string;
  kind: string;
  duty: string | null;
  title: string;
  text: string;
  parent: string | null;
  after: string | null;
  visible: boolean;
}): string {
  const canonical = JSON.stringify([input.projectId, input.kind, input.duty, input.title, input.text, input.parent, input.after, input.visible]);
  return `${AUTO_REQUEST_PREFIX}${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface PreflightResult {
  /** Providers probed because their login state was missing or stale. */
  probed: string[];
}

/**
 * At least one logged-in, eligible provider for every duty of the workflow (section 11: jv task create runs the
 * provider checks it needs). The login state comes from meta provider_auth; providers with no state, or one older
 * than AUTH_FRESH_MS, are probed first with the doctor's login check. Exit 2 with the doctor's lines otherwise.
 */
export async function preflightProviders(store: Store, duties: readonly string[], deps: Partial<TaskDeps> = {}): Promise<PreflightResult> {
  const d = withDefaults(deps);
  const providers = d.loadProviders();
  const usage = providers.providers.flatMap((p) => {
    const row = store.latestProviderUsage(p.name);
    return row ? [row] : [];
  });
  const needs = [...new Set(duties)].map((duty) => ({ duty, kinds: kindsForRuntimes(dutyRuntimes(duty, loadDutyNeeds(duty))) }));
  const authMap = (records: Record<string, ProviderAuthRecord>) => Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.auth]));
  const evaluate = (records: Record<string, ProviderAuthRecord>) =>
    needs.map((n) => ({ ...n, ranking: rankProviders({ providers: providers.providers, usage, kinds: n.kinds, auth: authMap(records), now: d.now() }) }));

  let records = loadProviderAuthRecords(store);
  let results = evaluate(records);
  const missing = () => results.filter((r) => !r.ranking.some((x) => x.eligible));
  const probed: string[] = [];
  let lines: string[] = [];
  if (missing().length) {
    const now = d.now();
    const stale = new Set<string>();
    for (const r of missing()) {
      for (const x of r.ranking) {
        if (x.reason !== 'needs-login' || x.provider.kind === 'openai-compatible') continue;
        const rec = records[x.provider.name];
        if (!rec || now - Date.parse(rec.observedAt) > AUTH_FRESH_MS || Number.isNaN(Date.parse(rec.observedAt))) stale.add(x.provider.name);
      }
    }
    if (stale.size) {
      probed.push(...stale);
      const checks = await d.probeLogins([...stale]);
      lines = checks.filter((c) => c.status !== 'OK').map((c) => c.line);
      records = loadProviderAuthRecords(store);
      results = evaluate(records);
    }
  }
  const still = missing();
  if (still.length) {
    const why = still
      .map((r) => `${r.duty}: ${r.ranking.filter((x) => x.reason !== 'unsupported').map((x) => `${x.provider.name} ${x.reason}`).join(', ') || 'no provider of a kind that can run it'}`)
      .join('; ');
    const doctor = lines.length ? lines : [`FAIL logins: no logged-in provider can run ${still.map((r) => r.duty).join(', ')} (${why}) - fix: jv doctor --check logins`];
    throw refused(`no logged-in provider can run this task (${why}); nothing was created.\n${doctor.join('\n')}`);
  }
  return { probed };
}

export interface CreateTaskResult {
  task: TaskRow;
  steps: StepRow[];
  /** False when the request id named an existing, identical task. */
  created: boolean;
  workflow: { source: string; name: string };
  worktree?: CreatedWorktree;
  questions?: { decisionId?: string; skipped: number[] };
  start?: StartStepResult;
  warnings: string[];
}

/** Writes task.md (the task text the first step receives) when it is missing or different. */
export function writeTaskFile(projectName: string, task: TaskRow): string {
  const file = paths.taskFile(projectName, task.id);
  const content = `${task.task_text}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return file;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** The task's workflow questions, once per task (no workflow decision yet). Skipped steps get "Jev: not needed". */
export async function ensureWorkflowAnswers(
  store: Store,
  taskId: string,
  deps: Partial<TaskDeps> = {},
): Promise<{ asked: boolean; decisionId?: string; skipped: number[] }> {
  const d = withDefaults(deps);
  const task = store.requireTask(taskId);
  const steps = store.listSteps(task.id);
  if (!steps.some((s) => whenQuestion(s.when_rule) !== undefined)) return { asked: false, skipped: [] };
  const existing = store.latestDecision({ kind: 'workflow', task_id: task.id });
  if (existing) return { asked: false, decisionId: existing.id, skipped: steps.filter((s) => s.state === 'skipped').map((s) => s.ordinal) };
  const answers = await d.askWorkflowQuestions({ store, taskId: task.id });
  store.tx(() => {
    for (const s of answers.skip) {
      const step = store.requireStep(s.stepId);
      if (step.state === 'pending') store.setStepState(step.id, 'skipped', s.reason || SKIP_REASON);
    }
  });
  return { asked: true, ...(answers.decision ? { decisionId: answers.decision.id } : {}), skipped: answers.skip.map((s) => s.ordinal) };
}

/**
 * A Jev refusal before a step could start: the task stays queued, the step pending with the message, the refusal in
 * meta admit_attempt:<T> (advance.ts: the bot retries it once a minute and does not wake again for it), a wake line.
 */
async function markJevRefused(store: Store, task: TaskRow, message: string, d: TaskDeps): Promise<void> {
  const step = currentStep(store, task.id);
  store.tx(() => {
    if (step && (step.state === 'pending' || step.state === 'retrying')) store.setStepState(step.id, step.state, message);
    store.setTaskState(task.id, 'queued', message);
    writeAdmitAttempt(store, task.id, { at: new Date(d.now()).toISOString(), reason: message });
  });
  const now = store.requireTask(task.id);
  await wake(store, d, now, wakeLine(now, step?.duty, `not placed (${message})`, `jv task show ${task.id}`));
}

function queuedRefusal(taskId: string, reason: string) {
  return refused(`${reason} (task ${taskId} is queued; jv task resume ${taskId} starts it once Jev answers)`, { taskId });
}

/** Whether the task's workflow needs a worktree (any duty that does not run on llm). */
function needsWorktree(store: Store, taskId: string): boolean {
  return store.listSteps(taskId).some((s) => !LLM_DUTIES.includes(s.duty));
}

export interface AdmitResult {
  /**
   * started: step 1 (or the current step) runs; waiting: --after names a task that is not done, or no slot is free
   * (reason "waiting for a slot"); refused: Jev refused the workflow questions or the placement (the task stays
   * queued with the message); failed: the run could not be spawned; finished: no step was left to run;
   * skipped: the task cannot be started from here (not queued, or no worktree yet).
   */
  state: 'started' | 'waiting' | 'refused' | 'failed' | 'finished' | 'skipped';
  reason?: string;
  questions?: { decisionId?: string; skipped: number[] };
  start?: StartStepResult;
}

/**
 * Starts a queued task the way jv task create starts it (steps 6 and 7 of the header): the workflow questions once,
 * the --after wait, then its current step, placed through route.ts and started through the runtime, in a free slot
 * only. What reconcile's admission runs for every queued task, and createTask for a new one.
 */
export async function admitTask(store: Store, taskId: string, options: { reason: string; deps?: Partial<TaskDeps> }): Promise<AdmitResult> {
  const d = withDefaults(options.deps);
  const task = store.requireTask(taskId);
  if (task.state !== 'queued') return { state: 'skipped', reason: `task ${task.id} is ${task.state}, not queued` };
  // A worktree that could not be created is made by jv task create (the same request id); placing first would cost
  // a Jev call that cannot start anything.
  if (needsWorktree(store, task.id) && (!task.worktree_path || !task.base_commit)) {
    return { state: 'skipped', reason: `task ${task.id} has no worktree yet; jv task create with its request id makes it` };
  }
  let questions: AdmitResult['questions'];
  try {
    const answered = await ensureWorkflowAnswers(store, task.id, d);
    questions = { ...(answered.decisionId ? { decisionId: answered.decisionId } : {}), skipped: answered.skipped };
  } catch (error) {
    if (!isJvError(error) || error.exitCode !== 2) throw error;
    await markJevRefused(store, store.requireTask(task.id), error.message, d);
    return { state: 'refused', reason: error.message };
  }
  const withQuestions = (r: AdmitResult): AdmitResult => ({ ...r, ...(questions ? { questions } : {}) });
  const after = task.after_task_id ? store.getTask(task.after_task_id) : undefined;
  if (after && after.state !== 'done') {
    const reason = `waiting for ${after.id} (${oneLine(after.title, 80)}) to finish`;
    store.setTaskState(task.id, 'queued', reason);
    return withQuestions({ state: 'waiting', reason });
  }
  if (!store.listSteps(task.id).some((s) => s.state === 'pending' || s.state === 'retrying')) {
    await finishSteps(store, task.id, advanceDeps(d));
    return withQuestions({ state: 'finished' });
  }
  const start = await startStep(store, task.id, { reason: options.reason, deps: advanceDeps(d) });
  switch (start.state) {
    case 'started':
      return withQuestions({ state: 'started', start });
    case 'refused':
      return withQuestions({ state: 'refused', reason: start.reason, start });
    case 'failed':
      return withQuestions({ state: 'failed', reason: start.reason, start });
    case 'waiting':
      return withQuestions({ state: 'waiting', reason: start.reason, start });
    case 'none':
      return withQuestions({ state: 'finished', reason: start.reason, start });
  }
}

export async function createTask(store: Store, input: CreateTaskInput, deps: Partial<TaskDeps> = {}): Promise<CreateTaskResult> {
  const d = withDefaults(deps);
  const project = store.requireProject(input.project);
  const title = input.title.replace(/\s+/g, ' ').trim();
  const text = normalizeText(input.text);
  if (title === '') throw refused('--title is required');
  if (text.trim() === '') throw refused('the task text is empty (--text "..." or --file F)');
  const parent = input.parent ? requireTaskId(store, input.parent) : undefined;
  const after = input.after ? requireTaskId(store, input.after) : undefined;
  if (parent && parent.project_id !== project.id) throw refused(`the parent ${parent.id} belongs to another project`);
  if (after && after.project_id !== project.id) throw refused(`the task ${after.id} (--after) belongs to another project`);
  if (parent && !parent.branch) throw refused(`the parent ${parent.id} has no branch to start from`);
  const origin = taskOrigin(store, input.origin, input.env);

  const resolved: ResolvedWorkflow = resolveWorkflow({ project: project.name, kind: input.kind, ...(input.duty !== undefined ? { duty: input.duty } : {}) });
  const kind = input.kind as TaskKind;
  const visible = input.visible === true;
  const requestId =
    input.requestId?.trim() ||
    autoRequestId({
      projectId: project.id,
      kind,
      duty: kind === 'single' ? (input.duty ?? null) : null,
      title,
      text,
      parent: parent?.id ?? null,
      after: after?.id ?? null,
      visible,
    });
  const workflowJson = JSON.stringify({ ...resolved.workflow, source: resolved.source });
  const warnings: string[] = [];

  const existing = store.getTaskByRequestId(requestId);
  if (!existing) await preflightProviders(store, resolved.workflow.steps.map((s) => s.duty), d);

  const { task: created, isNew } = store.tx(() => {
    const t = store.createTask({
      project_id: project.id,
      parent_task_id: parent?.id ?? null,
      after_task_id: after?.id ?? null,
      request_id: requestId,
      kind,
      title,
      task_text: text,
      workflow_json: workflowJson,
      visible,
      state: 'queued',
      state_reason:
        input.start !== false ? 'created' : after && after.state !== 'done' ? `waiting for ${after.id} (${oneLine(after.title, 80)}) to finish` : QUEUED_FOR_THE_BOT,
      origin,
    });
    for (const s of workflowSteps(t.row.id, resolved.workflow)) store.createStep(s);
    return { task: t.row, isNew: t.created };
  });
  let task = created;

  // The worktree (none for tasks whose every duty runs on llm).
  let worktree: CreatedWorktree | undefined;
  const needsWorktree = resolved.workflow.steps.some((s) => !LLM_DUTIES.includes(s.duty));
  if (needsWorktree && (!task.worktree_path || !task.base_commit)) {
    const branch = task.branch ?? taskBranch(slugify(title), task.id);
    const path = task.worktree_path ?? paths.worktree(project.name, branchSlug(branch));
    task = store.updateTask(task.id, { branch, worktree_path: path });
    try {
      worktree = createWorktree({ repo: project.path, path, branch, base: parent?.branch ?? project.default_branch });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setTaskState(task.id, 'queued', `worktree not created: ${message}`);
      if (isJvError(error)) throw error;
      throw refused(`worktree not created: ${message}`);
    }
    warnings.push(...worktree.warnings);
    task = store.updateTask(task.id, { base_commit: worktree.baseCommit });
  }
  writeTaskFile(project.name, task);

  const result = (start?: StartStepResult, questions?: CreateTaskResult['questions']): CreateTaskResult => ({
    task: store.requireTask(task.id),
    steps: store.listSteps(task.id),
    created: isNew,
    workflow: { source: resolved.source, name: resolved.workflow.name },
    ...(worktree ? { worktree } : {}),
    ...(questions ? { questions } : {}),
    ...(start ? { start } : {}),
    warnings,
  });

  // A repeat of a task that already started (or ended) does nothing more; nor does a task left to the bot.
  if (store.listSessions({ task_id: task.id, kind: 'step' }).length || !['queued'].includes(task.state)) return result();
  if (input.start === false) return result();

  const admitted = await admitTask(store, task.id, { reason: 'task created', deps: d });
  if (admitted.state === 'refused') throw queuedRefusal(task.id, admitted.reason ?? 'Jev refused');
  return result(admitted.start, admitted.questions);
}

/** What `jv task create --json` prints and the jv_task_create tool returns (the result without the worktree). */
export interface CreatedTaskView {
  task: TaskRow;
  steps: StepRow[];
  created: boolean;
  workflow: { source: string; name: string };
  questions?: CreateTaskResult['questions'];
  start?: StartStepResult;
  warnings: string[];
}

export function createdTaskView(r: CreateTaskResult): CreatedTaskView {
  return {
    task: r.task,
    steps: r.steps,
    created: r.created,
    workflow: r.workflow,
    ...(r.questions ? { questions: r.questions } : {}),
    ...(r.start ? { start: r.start } : {}),
    warnings: r.warnings,
  };
}

// ---- jv task show -----------------------------------------------------------------------------------------------

export interface RunView {
  id: string;
  runtime: string;
  provider: string;
  model: string;
  effort: string;
  state: string;
  stateReason: string;
  nativeSessionId: string | null;
  tmuxTarget: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  report?: ReportView;
}

export interface StepView {
  id: string;
  ordinal: number;
  duty: string;
  when: string;
  state: string;
  stateReason: string;
  attempts: number;
  onFail: unknown;
  instructions: string;
  runs: RunView[];
  placements: Array<{ id: string; chosen: unknown; override: unknown; overrideMode: string | null; outcome: unknown; createdAt: string }>;
}

export interface TaskView {
  id: string;
  project: string;
  kind: string;
  title: string;
  text: string;
  state: string;
  stateReason: string;
  /** Who created the task (schema 2). */
  origin: string;
  currentStep: number;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  landedCommit: string | null;
  visible: boolean;
  parent: string | null;
  after: string | null;
  children: Array<{ id: string; title: string; state: string }>;
  workflow: { name?: string; source?: string };
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  steps: StepView[];
  /**
   * `meta` is the message's meta_json (store schema 2) when it holds an object: the raw A2UI action of a UI action
   * (packages/ui server/actions.ts), from which the task page shows a surface as already sent. Absent otherwise.
   */
  messages: Array<{ id: string; direction: string; text: string; createdAt: string; deliveredAt: string | null; session: string | null; meta?: Record<string, unknown> }>;
  landings: Array<{ id: string; route: string; state: string; reason: string; commit: string | null; createdAt: string; checks: LandingCheckView[] }>;
  workflowDecision?: { id: string; chosen: unknown };
}

/** A check a landing ran, as `jv task show --json` gives it (M-069): what ran, whether it passed, and a line saying so. */
export interface LandingCheckView {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** "passed in 3.2 s", "failed (exit 1) in 3.2 s", "timed out after 120 s". */
  outcome: string;
}

/** The checks of a landing row's checks_json; entries that are not check results are left out. */
export function landingChecksView(checksJson: string): LandingCheckView[] {
  const raw = parse(checksJson);
  if (!Array.isArray(raw)) return [];
  const out: LandingCheckView[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    if (c === null || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.passed !== 'boolean') continue;
    const durationMs = typeof c.durationMs === 'number' && Number.isFinite(c.durationMs) ? Math.max(0, Math.round(c.durationMs)) : 0;
    const exitCode = typeof c.exitCode === 'number' ? c.exitCode : null;
    const timedOut = c.timedOut === true;
    const secs = `${(durationMs / 1000).toFixed(1)} s`;
    const outcome = timedOut ? `timed out after ${secs}` : c.passed ? `passed in ${secs}` : `failed${exitCode !== null ? ` (exit ${exitCode})` : ''} in ${secs}`;
    out.push({ name: c.name, command: typeof c.command === 'string' ? c.command : '', passed: c.passed, exitCode, timedOut, durationMs, outcome });
  }
  return out;
}

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function runView(store: Store, s: SessionRow): RunView {
  const report = store.getReportBySession(s.id);
  return {
    id: s.id,
    runtime: s.runtime,
    provider: s.provider,
    model: s.model,
    effort: s.effort,
    state: s.state,
    stateReason: s.state_reason,
    nativeSessionId: s.native_session_id,
    tmuxTarget: s.tmux_target,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    lastEventAt: s.last_event_at,
    tokens: { input: s.input_tokens, output: s.output_tokens, cacheRead: s.cache_read_tokens, cacheWrite: s.cache_write_tokens },
    costUsd: s.cost_usd,
    ...(report ? { report: reportView(report) } : {}),
  };
}

export function taskView(store: Store, task: TaskRow): TaskView {
  const project = store.getProject(task.project_id);
  const wf = parse(task.workflow_json) as { name?: string; source?: string } | null;
  const workflowDecision = store.latestDecision({ kind: 'workflow', task_id: task.id });
  return {
    id: task.id,
    project: project?.name ?? task.project_id,
    kind: task.kind,
    title: task.title,
    text: task.task_text,
    state: task.state,
    stateReason: task.state_reason,
    origin: task.origin ?? 'owner',
    currentStep: task.current_step,
    branch: task.branch,
    worktree: task.worktree_path,
    baseCommit: task.base_commit,
    landedCommit: task.landed_commit,
    visible: task.visible === 1,
    parent: task.parent_task_id,
    after: task.after_task_id,
    children: store.listTasks({ parent_task_id: task.id }).map((c) => ({ id: c.id, title: c.title, state: c.state })),
    workflow: { ...(wf?.name ? { name: wf.name } : {}), ...(wf?.source ? { source: wf.source } : {}) },
    createdAt: task.created_at,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    steps: store.listSteps(task.id).map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      duty: s.duty,
      when: s.when_rule,
      state: s.state,
      stateReason: s.state_reason,
      attempts: s.attempts,
      onFail: parse(s.on_fail_json),
      instructions: s.instructions,
      runs: store.listSessions({ step_id: s.id }).map((r) => runView(store, r)),
      placements: store.listDecisions({ kind: 'placement', step_id: s.id }).map((dec) => ({
        id: dec.id,
        chosen: parse(dec.chosen_json),
        override: parse(dec.override_json),
        overrideMode: dec.override_mode,
        outcome: parse(dec.outcome_json),
        createdAt: dec.created_at,
      })),
    })),
    messages: store.listMessages({ task_id: task.id }).map((m) => {
      const meta = m.meta_json ? parse(m.meta_json) : null;
      return {
        id: m.id,
        direction: m.direction,
        text: m.text,
        createdAt: m.created_at,
        deliveredAt: m.delivered_at,
        session: m.session_id,
        ...(meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? { meta: meta as Record<string, unknown> } : {}),
      };
    }),
    landings: store.listLandings({ task_id: task.id }).map((l) => ({
      id: l.id,
      route: l.route,
      state: l.state,
      reason: l.reason,
      commit: l.commit_sha,
      createdAt: l.created_at,
      checks: landingChecksView(l.checks_json),
    })),
    ...(workflowDecision ? { workflowDecision: { id: workflowDecision.id, chosen: parse(workflowDecision.chosen_json) } } : {}),
  };
}

export function formatTaskView(v: TaskView): string {
  const lines = [
    `Task ${v.id}: ${v.title}`,
    `Project ${v.project}. Kind ${v.kind}${v.workflow.source && v.workflow.source !== 'single' ? ` (workflow ${v.workflow.source})` : ''}. ${v.origin !== 'owner' ? `Origin ${v.origin}. ` : ''}${v.visible ? 'Visible. ' : ''}State ${v.state}: ${v.stateReason}`,
  ];
  if (v.branch) lines.push(`Branch ${v.branch}${v.worktree ? ` in ${v.worktree}` : ''}${v.landedCommit ? `, landed as ${v.landedCommit.slice(0, 12)}` : ''}`);
  if (v.parent) lines.push(`Parent ${v.parent}`);
  if (v.after) lines.push(`After ${v.after}`);
  lines.push('', 'Steps:');
  for (const s of v.steps) {
    lines.push(`  ${s.ordinal}. ${s.duty} - ${s.state}${s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}: ${s.stateReason}`);
    for (const r of s.runs) {
      const rep = r.report ? ` - report ${r.report.status}: ${oneLine(r.report.summary, 160)}` : '';
      lines.push(`     ${r.id} ${r.runtime} ${r.provider} ${r.model} ${r.effort} ${r.state}${rep}`);
    }
  }
  const waiting = v.steps.flatMap((s) => s.runs).at(-1)?.report;
  if (v.state === 'waiting-owner' && waiting?.question) {
    lines.push('', `Question: ${waiting.question}`);
    for (const [i, o] of (waiting.options ?? []).entries()) lines.push(`  ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ''}`);
  }
  if (v.landings.length) {
    lines.push('', 'Landings:');
    for (const l of v.landings) lines.push(`  ${l.id} ${l.route} ${l.state}: ${l.reason}`);
  }
  if (v.children.length) {
    lines.push('', 'Child tasks:');
    for (const c of v.children) lines.push(`  ${c.id} ${c.state}: ${c.title}`);
  }
  if (v.messages.length) {
    lines.push('', 'Messages:');
    for (const m of v.messages) lines.push(`  ${m.id} ${m.direction}${m.deliveredAt ? ` (delivered to ${m.session ?? '?'})` : ' (waiting)'}: ${oneLine(m.text, 160)}`);
  }
  lines.push('', v.text);
  return lines.join('\n');
}

// ---- who is talking ---------------------------------------------------------------------------------------------

/** True when JV_SESSION names a coordinator session (the coordinator runs jv with it set). */
export function callerIsCoordinator(store: Store, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = env.JV_SESSION?.trim();
  if (!id) return false;
  return store.getSession(normalizeId(id))?.kind === 'coordinator';
}

/** The refusal for a task whose every step is done: only landing is left. */
function noStepLeft(task: TaskRow): string {
  return `every step of task ${task.id} is done; only landing is left: jv land ${task.id} (or jv land ${task.id} --force to land without asking Jev)`;
}

// ---- jv task message --------------------------------------------------------------------------------------------

export interface MessageResult {
  message: MessageRow;
  delivery: 'typed' | 'next-turn' | 'resumed' | 'next-run';
  session?: string;
}

/**
 * Stores a message for the task (direction owner, or coordinator when JV_SESSION is the coordinator's) and delivers
 * it: typed at once into a live claude-tmux window; otherwise at the next turn boundary of the live run; a task
 * waiting on the owner is resumed with it; a task with no live run gets it with its next run.
 */
export async function messageTask(
  store: Store,
  id: string,
  text: string,
  options: { env?: NodeJS.ProcessEnv; deps?: Partial<TaskDeps> } = {},
): Promise<MessageResult> {
  const d = withDefaults(options.deps);
  const task = requireTaskId(store, id);
  if (text.trim() === '') throw refused('the message is empty');
  if (task.state === 'done' || task.state === 'stopped') throw refused(`task ${task.id} is ${task.state}; it takes no messages`);
  const direction: MessageDirection = callerIsCoordinator(store, options.env) ? 'coordinator' : 'owner';
  markLost(store);
  const live = liveRuns(store, task.id).at(-1);
  if (!live && !currentStep(store, task.id)) throw refused(noStepLeft(task));
  const message = store.createMessage({ task_id: task.id, direction, text: text.trim() });
  if (live) {
    if (live.runtime === 'claude-tmux' && live.tmux_target && live.state === 'running') {
      const typed = await d.typeIntoLive(store, live, resumeMessage(direction, message.text));
      if (typed) return { message: store.markMessageDelivered(message.id, live.id), delivery: 'typed', session: live.id };
    }
    return { message, delivery: 'next-turn', session: live.id };
  }
  if (task.state === 'waiting-owner') {
    const step = currentStep(store, task.id);
    const last = step ? latestRun(store, task.id, step.id) : undefined;
    if (last && !askedLanding(store, task.id)) {
      const run = continueRun(store, last, {
        requestId: `message:${message.id}`,
        reason: `resumed with message ${message.id}`,
        taskReason: `step ${step!.ordinal} (${step!.duty}): resumed with a message from the ${direction}`,
        deps: advanceDeps(d),
      });
      return { message, delivery: 'resumed', session: run.id };
    }
  }
  return { message, delivery: 'next-run' };
}

// ---- jv task answer ---------------------------------------------------------------------------------------------

export interface AnswerResult {
  answer: string;
  message?: MessageRow;
  session?: string;
  landing?: unknown;
  stopped?: StopResult;
}

/**
 * Answers a task that waits on the owner. A landing ask takes "Land now" (landTask force) or "Leave it" (stop with
 * discard). Otherwise the answer (an option label, matched without case, or free text) is stored as a message
 * (direction answer, or coordinator when the coordinator answers) and the waiting session is resumed with it.
 */
export async function answerTask(
  store: Store,
  id: string,
  text: string,
  options: { env?: NodeJS.ProcessEnv; deps?: Partial<TaskDeps> } = {},
): Promise<AnswerResult> {
  const d = withDefaults(options.deps);
  const task = requireTaskId(store, id);
  const given = text.trim();
  if (given === '') throw refused('the answer is empty');
  if (task.state !== 'waiting-owner') throw refused(`task ${task.id} is ${task.state}, not waiting on an answer; use jv task message to tell it something`);

  const asked = askedLanding(store, task.id);
  if (asked) {
    if (/^land now$/i.test(given)) {
      const landing = await d.land(store, task.id, { force: true });
      return { answer: 'Land now', landing };
    }
    if (/^leave it$/i.test(given)) {
      const stopped = await stopTask(store, task.id, { discard: true, deps: d });
      return { answer: 'Leave it', stopped };
    }
    throw refused(`task ${task.id} waits on a landing decision: answer "Land now" or "Leave it"`);
  }

  const step = currentStep(store, task.id);
  if (!step) throw refused(noStepLeft(task));
  const last = latestRun(store, task.id, step.id);
  if (!last) throw refused(`task ${task.id} has no session to answer; jv task resume ${task.id} starts it`);
  const report = store.getReportBySession(last.id);
  const view = report ? reportView(report) : undefined;
  const option = view?.options?.find((o) => o.label.trim().toLowerCase() === given.toLowerCase());
  const answer = option ? option.label : given;
  const direction: MessageDirection = callerIsCoordinator(store, options.env) ? 'coordinator' : 'answer';
  const message = store.createMessage({ task_id: task.id, direction, text: answer });
  const run = continueRun(store, last, {
    requestId: `answer:${message.id}`,
    reason: `resumed with the answer ${message.id}`,
    taskReason: `step ${step.ordinal} (${step.duty}): answered, continuing`,
    deps: advanceDeps(d),
  });
  return { answer, message, session: run.id };
}

// ---- jv task stop -----------------------------------------------------------------------------------------------

export interface StopResult {
  task: TaskRow;
  stopped: string[];
  discarded: boolean;
}

/**
 * Stops the task's live runs (launcher.stopRun). Without --discard the task keeps its state, its reason says it was
 * stopped and jv task resume continues it; --discard also marks the task stopped and keeps the worktree.
 */
export async function stopTask(store: Store, id: string, options: { discard?: boolean; deps?: Partial<TaskDeps> } = {}): Promise<StopResult> {
  const d = withDefaults(options.deps);
  const task = requireTaskId(store, id);
  if (task.state === 'done') throw refused(`task ${task.id} is done; there is nothing to stop`);
  const runs = store.listSessions({ task_id: task.id, kind: 'step', states: ['queued', 'starting', 'running', 'waiting'] });
  const reason = options.discard ? 'discarded by the owner' : 'stopped by the owner';
  for (const r of runs) await d.stopRun(store, r.id, reason);
  try {
    // Windows of claude-tmux conversations whose runs had already ended (a waiting task's) close with the stop too.
    await d.closeWindows(store, { taskId: task.id });
  } catch {
    // left to the owner
  }
  const stoppedList = runs.map((r) => r.id).join(', ');
  let row: TaskRow;
  if (options.discard) {
    // An open verify-then-land landing ends with the task, or it would read as checking forever.
    const open = openVerifyLanding(store, task.id);
    if (open) store.setLandingState(open.id, 'failed', 'discarded by the owner');
    // So does an ask-owner question: "Leave it" is its answer.
    closeAskedLandings(store, task.id, ANSWERED_LEAVE_IT);
    // A step that was running ends with the task, or it reads as running under a stopped task forever. Its
    // placement's outcome is left unset: a discard says nothing about how the placement did (evals skip it).
    for (const st of store.listSteps(task.id)) {
      if (st.state === 'running' || st.state === 'retrying') store.setStepState(st.id, 'failed', 'discarded by the owner');
    }
    row = store.setTaskState(
      task.id,
      'stopped',
      `discarded by the owner${task.worktree_path ? `; the worktree stays at ${task.worktree_path}` : ''}`,
    );
  } else if (task.state === 'stopped') {
    row = task;
  } else {
    row = store.setTaskState(
      task.id,
      task.state,
      runs.length ? `${stoppedList} stopped by the owner; jv task resume ${task.id} continues` : `nothing was running; ${task.state_reason}`,
    );
  }
  return { task: row, stopped: runs.map((r) => r.id), discarded: options.discard === true };
}

// ---- jv task resume ---------------------------------------------------------------------------------------------

export interface ResumeResult {
  task: TaskRow;
  how: 'native' | 'placed' | 'landing' | 'done' | 'waiting' | 'refused';
  session?: string;
  reason?: string;
  start?: StartStepResult;
}

const RESUMABLE_RUN_STATES = ['lost', 'stopped', 'failed', 'waiting', 'done'];

/**
 * The end of the owner's takeover of a waiting run (jv attach): for claude-sdk, the transcript entries the owner
 * added become events of the run first (takeover.ts; refused with exit 4 while the takeover window is open). Returns
 * the reason the run is marked done with.
 */
async function endTakeover(store: Store, run: SessionRow, d: TaskDeps): Promise<string> {
  const fallback = 'the owner ended the takeover; jv task resume continues';
  if (run.runtime !== 'claude-sdk' || !run.state_reason.startsWith(ATTACHED_REASON)) return fallback;
  const home = d.loadProviders().providers.find((p) => p.name === run.provider)?.home;
  if (home === undefined) return `${fallback} (no home for ${run.provider}; the takeover was not imported)`;
  const window = run.tmux_target ?? `jv-${run.id}`;
  const imported = importTakeover(store, run, { home, windowOpen: await d.tmuxSessionAlive(window) });
  return `${imported.reason}; jv task resume continues`;
}

/**
 * Continues a task: asks the workflow questions when they were never answered, then resumes the current step's
 * latest run natively when it has a native session (a new run row with the same native_session_id: J7, J6), else
 * places and starts the step (J9). A task whose steps are all done goes to landing. A queued task starts only in a
 * free slot (it stays queued with "waiting for a slot" otherwise).
 */
export async function resumeTask(store: Store, id: string, deps: Partial<TaskDeps> = {}): Promise<ResumeResult> {
  const d = withDefaults(deps);
  markLost(store);
  let task = requireTaskId(store, id);
  if (task.state === 'done') throw refused(`task ${task.id} is done`);
  if (task.state === 'stopped') throw refused(`task ${task.id} was discarded; create a new task to continue the work`);
  const live = liveRuns(store, task.id);
  if (live.length) throw conflict(`task ${task.id} is already running (${live.map((s) => s.id).join(', ')})`);

  try {
    await ensureWorkflowAnswers(store, task.id, d);
  } catch (error) {
    if (isJvError(error) && error.exitCode === 2) {
      await markJevRefused(store, task, error.message, d);
      throw queuedRefusal(task.id, error.message);
    }
    throw error;
  }
  task = store.requireTask(task.id);
  if (task.after_task_id) {
    const before = store.getTask(task.after_task_id);
    if (before && before.state !== 'done') {
      const reason = `waiting for ${before.id} (${oneLine(before.title, 80)}) to finish`;
      return { task: store.setTaskState(task.id, 'queued', reason), how: 'waiting', reason };
    }
  }

  const step = currentStep(store, task.id);
  if (!step) {
    const after = await finishSteps(store, task.id, advanceDeps(d));
    return { task: after, how: after.state === 'done' ? 'done' : 'landing' };
  }
  // Started from queued (a native resume included): only in a free slot.
  if (task.state === 'queued' && slotRefusal(store, task.project_id, task.id, d.limits())) {
    const { reason } = waitForSlot(store, task.id);
    return { task: store.requireTask(task.id), how: 'waiting', reason };
  }
  const r = await continueStep(store, task, step, d, 'the owner');
  if (r.start?.state === 'refused') throw queuedRefusal(task.id, r.start.reason);
  return r;
}

/**
 * The current step's latest run continued natively (resumable state and a native session: a new run with
 * "Continue."), else the step placed and started again. `by` names who resumes it in the state reasons.
 */
async function continueStep(store: Store, task: TaskRow, step: StepRow, d: TaskDeps, by: string): Promise<ResumeResult> {
  const last = latestRun(store, task.id, step.id);
  if (last?.native_session_id && RESUMABLE_RUN_STATES.includes(last.state)) {
    if (last.state === 'waiting') store.setSessionState(last.id, 'done', await endTakeover(store, last, d));
    if (step.state === 'failed' || step.state === 'pending') store.setStepState(step.id, 'running', `resumed by ${by} (${last.id})`);
    const run = continueRun(store, store.requireSession(last.id), {
      requestId: `resume:${last.id}`,
      message: CONTINUE_PROMPT,
      reason: `resumes ${last.id} (${last.state})`,
      taskReason: `step ${step.ordinal} (${step.duty}) resumed by ${by}`,
      deps: advanceDeps(d),
    });
    return { task: store.requireTask(task.id), how: 'native', session: run.id };
  }
  if (step.state === 'failed' || step.state === 'running') store.setStepState(step.id, 'pending', `resumed by ${by}; placing it again`);
  const start = await startStep(store, task.id, { stepId: step.id, reason: `resumed by ${by}`, deps: advanceDeps(d) });
  return {
    task: store.requireTask(task.id),
    how: start.state === 'started' ? 'placed' : start.state === 'waiting' ? 'waiting' : 'refused',
    ...(start.state === 'started' ? { session: start.session.id } : {}),
    ...('reason' in start ? { reason: start.reason } : {}),
    start,
  };
}

// ---- lost runs (reconcile) ----------------------------------------------------------------------------------------

export interface LostRecovery {
  /** The lost run. */
  session: string;
  task: string | null;
  /**
   * advanced: it had reported, and the task advanced by the report; resumed: a new run continues its native
   * session; placed: the step was placed and started again (the run had no native session); refused: Jev refused
   * that placement (the task is queued with the message; reconcile's admission retries it); failed: lost too often
   * in a row, the step's failure rule applied; skipped: nothing to do (see reason).
   */
  action: 'advanced' | 'resumed' | 'placed' | 'refused' | 'failed' | 'skipped';
  /** The run that continues the work (resumed, placed). */
  run?: string;
  reason?: string;
}

/**
 * What the bot does with a lost run (reconcile step 1; amends D-040, under which only jv task resume continued
 * one). Only the newest run of a task's current step is looked at, and only while the task is neither queued nor
 * ended and has no live run. Never slot-limited: the task was running when its run was lost.
 */
export async function recoverLostRun(store: Store, sessionId: string, deps: Partial<TaskDeps> = {}): Promise<LostRecovery> {
  const d = withDefaults(deps);
  const run = store.requireSession(sessionId);
  const skip = (reason: string): LostRecovery => ({ session: run.id, task: run.task_id, action: 'skipped', reason });
  if (run.kind !== 'step' || !run.task_id || !run.step_id) return skip('not a step run');
  if (run.state !== 'lost') return skip(`the run is ${run.state}`);
  const task = store.requireTask(run.task_id);
  if (['queued', 'done', 'failed', 'stopped'].includes(task.state)) return skip(`task ${task.id} is ${task.state}`);
  const step = store.requireStep(run.step_id);
  if (currentStep(store, task.id)?.id !== step.id) return skip(`step ${step.ordinal} is not the task's current step`);
  if (latestRun(store, task.id, step.id)?.id !== run.id) return skip('a later run of the step continued it');
  const live = liveRuns(store, task.id);
  if (live.length) return skip(`task ${task.id} has a live run (${live.map((s) => s.id).join(', ')})`);

  const base = { session: run.id, task: task.id };
  if (store.getReportBySession(run.id)) {
    await advanceLostRun(store, run.id, advanceDeps(d));
    return { ...base, action: 'advanced', reason: `the run had reported ${store.getReportBySession(run.id)!.status}` };
  }
  const streak = lostStreak(store, step.id);
  if (streak > MAX_LOST_RESUMES) {
    const reason = `run ${run.id} was lost ${streak} times in a row (${run.state_reason})`;
    await failRun(store, run.id, reason, advanceDeps(d));
    return { ...base, action: 'failed', reason };
  }
  const r = await continueStep(store, task, step, d, `the bot after ${run.id} was lost`);
  if (r.how === 'native') return { ...base, action: 'resumed', ...(r.session ? { run: r.session } : {}) };
  if (r.how === 'placed') return { ...base, action: 'placed', ...(r.session ? { run: r.session } : {}) };
  return { ...base, action: r.start?.state === 'refused' ? 'refused' : 'skipped', ...(r.reason ? { reason: r.reason } : {}) };
}

// ---- jv task override -------------------------------------------------------------------------------------------

export interface OverrideInput {
  model: string;
  effort?: string;
  provider?: string;
  mode: OverrideMode;
}

export interface OverrideResult {
  mode: OverrideMode;
  placement: OwnerPlacementResult['placement'];
  overridden?: string;
  decision?: string;
  stopped?: string;
  session?: string;
  start?: StartStepResult;
}

/**
 * The owner's placement (7.6). --keep records the override on the step's latest placement decision only; the
 * running session continues. --undo also stops the running session, marks the step retrying and starts it again on
 * the owner's placement (a new decision row with source owner; no Jev call).
 */
export async function overrideTask(store: Store, id: string, input: OverrideInput, deps: Partial<TaskDeps> = {}): Promise<OverrideResult> {
  const d = withDefaults(deps);
  markLost(store);
  const task = requireTaskId(store, id);
  if (['done', 'stopped', 'failed'].includes(task.state)) throw refused(`task ${task.id} is ${task.state}; there is no step to override`);
  const live = liveRuns(store, task.id).at(-1);
  const step = live?.step_id ? store.requireStep(live.step_id) : currentStep(store, task.id);
  if (!step) throw notFound(`task ${task.id} has no step to override`);
  const visibleStep = task.visible === 1 || stepVisible(task.workflow_json, step.ordinal);
  const result = d.ownerPlacement({
    store,
    taskId: task.id,
    stepId: step.id,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    mode: input.mode,
    ...(live ? { sessionId: live.id } : {}),
    visible: visibleStep,
  });
  const base: OverrideResult = {
    mode: result.mode,
    placement: result.placement,
    ...(result.overridden ? { overridden: result.overridden.id } : {}),
    ...(result.decision ? { decision: result.decision.id } : {}),
  };
  if (input.mode === 'keep') return base;
  if (!result.decision) throw refused('the owner placement wrote no decision');
  if (live) await d.stopRun(store, live.id, `overridden by the owner: ${input.model}${input.effort ? ` ${input.effort}` : ''}`);
  const placement = result.placement;
  store.setStepState(step.id, 'retrying', `owner override: ${placement.model} ${placement.effort} on ${placement.provider}`);
  const start = await startStep(store, task.id, {
    stepId: step.id,
    reason: 'owner override',
    owner: { ...placement, decisionId: result.decision.id },
    deps: advanceDeps(d),
  });
  return { ...base, ...(live ? { stopped: live.id } : {}), ...(start.state === 'started' ? { session: start.session.id } : {}), start };
}

// ---- jv task list -----------------------------------------------------------------------------------------------

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 1000;
/** No text line of jv task list is wider than this (AGENTS.md: no tables wider than 100 characters). */
export const LIST_LINE_MAX = 100;

export interface TaskListFilter {
  /** A project name or id. */
  project?: string;
  state?: string;
  origin?: string;
  /** At most this many tasks, newest first (default 50, at most 1000). */
  limit?: number;
}

export interface TaskSummary {
  id: string;
  project: string;
  title: string;
  kind: string;
  state: TaskState;
  stateReason: string;
  origin: string;
  /** The step the task works on now (or the last one), as jv status picks it. */
  step: { ordinal: number; duty: string; state: string; of: number } | null;
  /** The task's newest step run. */
  run: { id: string; runtime: string; provider: string; model: string; effort: string; state: string; lastEventAt: string | null } | null;
  lost: boolean;
  parent: string | null;
  after: string | null;
  branch: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** The newest of the run's last event, the task's end, start and creation. */
  updatedAt: string;
}

/** The tasks of every project (or one), newest first, with origin. Exit 2 for an unknown state or a bad limit. */
export function listTaskSummaries(store: Store, filter: TaskListFilter = {}): TaskSummary[] {
  if (filter.state !== undefined && !(TASK_STATES as readonly string[]).includes(filter.state)) {
    throw refused(`--state ${JSON.stringify(filter.state)} is not one of ${TASK_STATES.join(', ')}`);
  }
  const limit = filter.limit ?? TASK_LIST_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIST_MAX_LIMIT) throw refused(`--limit must be a whole number from 1 to ${TASK_LIST_MAX_LIMIT}`);
  const project = filter.project !== undefined ? store.requireProject(filter.project) : undefined;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const rows = store
    .listTasks({
      ...(project ? { project_id: project.id } : {}),
      ...(filter.state !== undefined ? { states: [filter.state as TaskState] } : {}),
      ...(filter.origin !== undefined ? { origin: filter.origin } : {}),
    })
    .reverse()
    .slice(0, limit);
  return rows.map((t) => taskSummary(store, t, names.get(t.project_id) ?? t.project_id));
}

function taskSummary(store: Store, task: TaskRow, projectName: string): TaskSummary {
  const steps = store.listSteps(task.id);
  const step =
    (task.current_step > 0 ? steps.find((s) => s.ordinal === task.current_step) : undefined) ??
    steps.find((s) => s.state !== 'done' && s.state !== 'skipped') ??
    steps.at(-1);
  const run = store.listSessions({ task_id: task.id, kind: 'step' }).at(-1);
  const times = [run?.last_event_at, task.ended_at, task.started_at, task.created_at].filter((t): t is string => typeof t === 'string');
  return {
    id: task.id,
    project: projectName,
    title: task.title,
    kind: task.kind,
    state: task.state,
    stateReason: task.state_reason,
    origin: task.origin ?? 'owner',
    step: step ? { ordinal: step.ordinal, duty: step.duty, state: step.state, of: steps.length } : null,
    run: run
      ? { id: run.id, runtime: run.runtime, provider: run.provider, model: run.model, effort: run.effort, state: run.state, lastEventAt: run.last_event_at }
      : null,
    lost: run?.state === 'lost',
    parent: task.parent_task_id,
    after: task.after_task_id,
    branch: task.branch,
    createdAt: task.created_at,
    startedAt: task.started_at,
    endedAt: task.ended_at,
    updatedAt: times.reduce((a, b) => (b > a ? b : a)),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A time for people: local HH:MM, with the local date (YYYY-MM-DD) in front when it is not today. */
export function localStamp(iso: string, now: number = Date.now()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const today = new Date(now);
  const clock = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const sameDay = t.getFullYear() === today.getFullYear() && t.getMonth() === today.getMonth() && t.getDate() === today.getDate();
  return sameDay ? clock : `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${clock}`;
}

function cutLine(line: string, max = LIST_LINE_MAX): string {
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : line;
}

/**
 * One line per task, ids first, at most 100 characters (a longer title is cut): id, state, origin, created (local
 * time), step, project (left out when the list is of one project) and title. Columns are as wide as their widest
 * value in the list.
 */
export function formatTaskList(tasks: readonly TaskSummary[], options: { now?: number; showProject?: boolean } = {}): string {
  if (!tasks.length) return 'No tasks.';
  const now = options.now ?? Date.now();
  const showProject = options.showProject ?? true;
  const rows = tasks.map((t) => [
    t.id,
    t.state,
    t.origin,
    localStamp(t.createdAt, now),
    `${t.step ? `${t.step.ordinal}/${t.step.of} ${t.step.duty}` : '-'}${t.lost ? ' LOST' : ''}`,
    ...(showProject ? [t.project] : []),
  ]);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => [...r[c]!].length)));
  return rows
    .map((r, i) => cutLine([...r.map((v, c) => v.padEnd(widths[c]!)), oneLine(tasks[i]!.title, 120)].join('  ')))
    .join('\n');
}
