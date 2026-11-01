// The jobs machinery (brief sections 9 and 10), M-017: a job is a row of the jobs table; its work is an ordinary task
// of kind single (placed by Jev, run on the usual runtime, reporting through jv_report, visible in the UI); when that
// task ends, the kind's post-processor turns the report into effects. The improver's kinds (improve-memory,
// improve-docs, improve-skills) and the planner's (plan) register handlers; this module, in jevellan-core because
// both packages use it and the planner does not depend on the improver, does the rest:
//
// - createJob: one job per kind and request id (the kind's id is per project and day or ISO week, so a schedule and a
//   manual run on the same day are one job; --force adds a suffix); a kind that is already queued or running for the
//   project refuses with exit 2 "already running: J...". The check and the insert are one transaction.
// - stepJobs (every bot tick): a queued job gets its work task (state running, task_id linked). The task is created
//   unstarted (start: false), so the bot's admission (reconcile) starts it under the limits and quiet hours, and a Jev
//   refusal is retried at reconcile's pace (M-026) instead of on every tick; a work task that cannot be created keeps
//   the job queued with the reason. A running job whose task is done runs the kind's finish() on the report of the
//   work step (the step of the kind's duty: a verify-then-land landing appends a verify step, D-046, whose report is
//   the task's last one and is not the work's) and is done with its result_json; one whose task failed or stopped
//   fails with the task's reason; one waiting on the owner (the task is waiting-owner) waits with it.
// - cancelJob: only a queued job (it fails with "cancelled by the owner"). Nothing deletes a job.
// - jobView, formatJobList, formatJobView: the job as jv job list|show --json prints it, and its text for people.
// No job creates further jobs (a finish() never calls createJob).

import { refused, notFound } from './errors.js';
import { lastJsonBlock } from './runtimes/llm.js';
import { reportView, type ReportView } from './report.js';
import type { Store } from './store.js';
import { createTask as coreCreateTask, localStamp, type CreateTaskInput } from './tasks.js';
import { JOB_KINDS, type JobKind, type JobRow, type ProjectRow, type TaskRow } from './types.js';
import { isoWeek } from './usage.js';

export { lastJsonBlock };

/** What a kind's handler gives the machinery to create the work task. */
export interface WorkTaskSpec {
  title: string;
  text: string;
  /** Recorded in the job's input_json (what the task was given). */
  input?: Record<string, unknown>;
}

export interface JobHandler {
  kind: JobKind;
  /** The duty of the work task. */
  duty: 'plan' | 'investigate' | 'document' | 'implement';
  /** 'improver' or 'planner': the task's origin is `<prefix>:<J>`. */
  origin: 'improver' | 'planner';
  /** The request id of the kind for a project at a time, without the --force suffix. */
  requestId(project: ProjectRow, now: Date): string;
  /** Refuses (JvError exit 2) a job the project cannot have. */
  check?(store: Store, project: ProjectRow): void;
  /** Builds the work task from the store (called when the job leaves queued). */
  workTask(store: Store, job: JobRow, project: ProjectRow): WorkTaskSpec | Promise<WorkTaskSpec>;
  /** Turns the done task's report into effects; returns result_json. Throwing fails the job with the message. */
  finish(store: Store, job: JobRow, report: ReportView | undefined, task: TaskRow): Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface JobDeps {
  createTask: (store: Store, input: CreateTaskInput) => Promise<{ task: TaskRow }>;
  now: () => Date;
}

function defaults(deps: Partial<JobDeps>): JobDeps {
  return { createTask: deps.createTask ?? (coreCreateTask as JobDeps['createTask']), now: deps.now ?? (() => new Date()) };
}

/** The local date (YYYY-MM-DD) of a time, in this machine's zone. */
export function localDay(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export { isoWeek };

function handlerOf(handlers: readonly JobHandler[], kind: string): JobHandler {
  const h = handlers.find((x) => x.kind === kind);
  if (!h) throw refused(`no handler for job kind ${kind}; jv knows ${JOB_KINDS.join(', ')}`);
  return h;
}

/** The reason of a job createJob queues: the bot's jobs step gives it its work task. */
export const JOB_QUEUED_REASON = "waiting for the bot's next tick";

export interface CreateJobInput {
  project: string;
  kind: string;
  /** Adds a suffix to the kind's request id, so a second job of the same day or week is made. */
  force?: boolean;
  input?: Record<string, unknown>;
  /** Overrides the kind's request id (schedules: schedule:<C>:<slot>). */
  requestId?: string;
}

/**
 * Creates a queued job, or returns the job that has the same request id (created false, exit 0). A kind already
 * queued or running for the project under another request id is refused: "already running: J...".
 */
export function createJob(store: Store, handlers: readonly JobHandler[], input: CreateJobInput, deps: Partial<JobDeps> = {}): { job: JobRow; created: boolean } {
  const d = defaults(deps);
  if (!(JOB_KINDS as readonly string[]).includes(input.kind)) throw refused(`job kind is one of ${JOB_KINDS.join(', ')}`);
  const h = handlerOf(handlers, input.kind);
  const project = store.getProjectByName(input.project) ?? store.getProject(input.project);
  if (!project) throw notFound(`no project ${input.project}`);
  h.check?.(store, project);
  const now = d.now();
  const base = input.requestId ?? h.requestId(project, now);
  const requestId = input.force ? `${base}:force:${now.toISOString()}` : base;
  return store.tx(() => {
    const same = store.getJobByRequestId(requestId);
    if (same) return { job: same, created: false };
    const busy = store.listJobs({ project_id: project.id, kind: h.kind, states: ['queued', 'running'] });
    if (busy.length) throw refused(`already running: ${busy.map((j) => j.id).join(', ')}`);
    const r = store.createJob({ project_id: project.id, kind: h.kind, request_id: requestId, input_json: JSON.stringify(input.input ?? {}), state_reason: JOB_QUEUED_REASON });
    return { job: r.row, created: r.created };
  });
}

/** Cancels a queued job (it fails with "cancelled by the owner"); any other state is refused. */
export function cancelJob(store: Store, id: string): JobRow {
  const job = store.getJob(id);
  if (!job) throw notFound(`no job ${id}`);
  if (job.state !== 'queued') throw refused(`job ${id} is ${job.state}; only a queued job can be cancelled`);
  return store.setJobState(id, 'failed', 'cancelled by the owner');
}

export interface StepSummary {
  started: Array<{ job: string; task: string }>;
  finished: Array<{ job: string; state: 'done' | 'failed'; reason: string }>;
  errors: Array<{ job: string; message: string }>;
}

/**
 * The newest report of the task's work step: a step of the kind's duty. A landing's verify step (D-046) has the duty
 * verify, which no kind uses, so its report never stands in for the work's.
 */
export function workReport(store: Store, taskId: string, duty: JobHandler['duty']): ReportView | undefined {
  const work = new Set(store.listSteps(taskId).filter((s) => s.duty === duty).map((s) => s.id));
  const last = store.listReports({ task_id: taskId }).filter((r) => r.step_id !== null && work.has(r.step_id)).at(-1);
  return last ? reportView(last) : undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One pass of the machinery over the jobs of the given kinds (the bot calls it every tick, once for the improver's
 * kinds and once for the planner's). Every job is its own step: one failing never stops the others.
 */
export async function stepJobs(store: Store, handlers: readonly JobHandler[], deps: Partial<JobDeps> = {}): Promise<StepSummary> {
  const d = defaults(deps);
  const kinds = handlers.map((h) => h.kind);
  const out: StepSummary = { started: [], finished: [], errors: [] };
  for (const job of store.listJobs({ states: ['queued', 'running'] }).reverse()) {
    if (!kinds.includes(job.kind)) continue;
    const h = handlerOf(handlers, job.kind);
    try {
      const project = store.getProject(job.project_id);
      if (!project) throw notFound(`no project ${job.project_id}`);
      if (job.state === 'queued') {
        let created: { task: TaskRow };
        let spec: WorkTaskSpec;
        try {
          spec = await h.workTask(store, job, project);
          created = await d.createTask(store, {
            project: project.name,
            kind: 'single',
            duty: h.duty,
            title: spec.title,
            text: spec.text,
            visible: false,
            requestId: `job:${job.id}`,
            origin: `${h.origin}:${job.id}`,
            start: false,
          });
        } catch (e) {
          // The job stays queued (the next pass tries again, the task's request id makes it the same task) and says why.
          const reason = `work task not created: ${message(e)}`.slice(0, 1000);
          if (store.getJob(job.id)?.state === 'queued') store.setJobState(job.id, 'queued', reason);
          throw e;
        }
        const input = { ...(JSON.parse(job.input_json) as Record<string, unknown>), ...(spec.input ?? {}) };
        store.setJobState(job.id, 'running', `task ${created.task.id} working`, { task_id: created.task.id, input_json: JSON.stringify(input) });
        out.started.push({ job: job.id, task: created.task.id });
        continue;
      }
      if (!job.task_id) {
        store.setJobState(job.id, 'failed', 'running without a task');
        out.finished.push({ job: job.id, state: 'failed', reason: 'running without a task' });
        continue;
      }
      const task = store.requireTask(job.task_id);
      if (task.state === 'done') {
        try {
          const result = await h.finish(store, job, workReport(store, task.id, h.duty), task);
          const reason = typeof result.summary === 'string' ? result.summary : 'done';
          store.setJobState(job.id, 'done', reason, { result_json: JSON.stringify(result) });
          out.finished.push({ job: job.id, state: 'done', reason });
        } catch (e) {
          const reason = message(e).slice(0, 1000);
          store.setJobState(job.id, 'failed', reason);
          out.finished.push({ job: job.id, state: 'failed', reason });
        }
      } else if (task.state === 'failed' || task.state === 'stopped') {
        const reason = task.state_reason || `task ${task.state}`;
        store.setJobState(job.id, 'failed', reason);
        out.finished.push({ job: job.id, state: 'failed', reason });
      }
      // queued, running, landing or waiting-owner: the job waits with its task.
    } catch (e) {
      out.errors.push({ job: job.id, message: message(e) });
    }
  }
  return out;
}

/** A job as `jv job list|show|run|cancel --json` prints it (the MCP's jv_job_* tools and the UI give the same). */
export interface JobView {
  id: string;
  project: string;
  kind: JobKind;
  state: JobRow['state'];
  /** The state's reason; for a done job the result's summary ("created 2, skipped 0"). */
  reason: string;
  requestId: string;
  task: string | null;
  taskState: TaskRow['state'] | null;
  input: unknown;
  result: Record<string, unknown> | null;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export function jobView(store: Store, job: JobRow): JobView {
  const project = store.getProject(job.project_id);
  const task = job.task_id ? store.getTask(job.task_id) : undefined;
  const result = job.result_json ? (JSON.parse(job.result_json) as Record<string, unknown>) : null;
  const end = job.ended_at ? Date.parse(job.ended_at) : undefined;
  return {
    id: job.id,
    project: project?.name ?? job.project_id,
    kind: job.kind,
    state: job.state,
    reason: job.state_reason,
    requestId: job.request_id,
    task: job.task_id,
    taskState: task?.state ?? null,
    input: JSON.parse(job.input_json) as unknown,
    result,
    createdAt: job.created_at,
    endedAt: job.ended_at,
    durationMs: end !== undefined ? end - Date.parse(job.created_at) : null,
  };
}

/** A duration for people: "42 s", "4 min 05 s", "1 h 05 min". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** No text line of jv job list is wider than this (AGENTS.md). */
export const JOB_LINE_MAX = 100;

function cutLine(line: string, max = JOB_LINE_MAX): string {
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : line;
}

/**
 * One line per job, ids first, at most 100 characters (the summary is cut): id, kind, project, state, task, created
 * (local HH:MM, with the date when not today), duration (when ended) and the reason, which is the result's summary of
 * a done job. Columns are as wide as their widest value in the list.
 */
export function formatJobList(jobs: readonly JobView[], now: number = Date.now()): string {
  if (!jobs.length) return 'No jobs.';
  const rows = jobs.map((j) => [j.id, j.kind, j.project, j.state, j.task ?? '-', localStamp(j.createdAt, now), j.durationMs !== null ? durationText(j.durationMs) : '-']);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => [...r[c]!].length)));
  return rows.map((r, i) => cutLine([...r.map((v, c) => v.padEnd(widths[c]!)), jobs[i]!.reason.replace(/\s+/g, ' ')].join('  ').trimEnd())).join('\n');
}

/** jv job show J: the job, its task and its result, for people. */
export function formatJobView(j: JobView, now: number = Date.now()): string {
  const lines = [
    `${j.id}  ${j.kind}  ${j.project}  ${j.state}: ${j.reason}`,
    `Request id ${j.requestId}.`,
    `Created ${localStamp(j.createdAt, now)}${j.endedAt ? `, ended ${localStamp(j.endedAt, now)}${j.durationMs !== null ? ` (${durationText(j.durationMs)})` : ''}` : ''}.`,
    j.task ? `Task ${j.task} (${j.taskState ?? 'unknown'}): jv task show ${j.task}` : 'No task yet: the bot creates it at its next tick.',
  ];
  if (j.input !== null && typeof j.input === 'object' && Object.keys(j.input).length) lines.push('Input:', JSON.stringify(j.input, null, 2));
  if (j.result) lines.push('Result:', JSON.stringify(j.result, null, 2));
  return lines.join('\n');
}
