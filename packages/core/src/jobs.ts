// The jobs machinery (brief sections 9 and 10), M-017: a job is a row of the jobs table; its work is an ordinary task
// of kind single (placed by Jev, run on the usual runtime, reporting through jv_report, visible in the UI); when that
// task ends, the kind's post-processor turns the report into effects. The improver's kinds (improve-memory,
// improve-docs, improve-skills) and the planner's (plan) register handlers; this module, in jevellan-core because
// both packages use it and the planner does not depend on the improver, does the rest:
//
// - createJob: one job per kind and request id (the kind's id is per project and day or ISO week, so a schedule and a
//   manual run on the same day are one job; --force adds a suffix); a kind that is already queued or running for the
//   project refuses with exit 2 "already running: J...".
// - stepJobs (every bot tick): a queued job gets its work task (state running, task_id linked); a running job whose
//   task is done runs the kind's finish() and is done with its result_json; one whose task failed or stopped fails
//   with the task's reason; one waiting on the owner (the task is waiting-owner) waits with it.
// - cancelJob: only a queued job (it fails with "cancelled by the owner"). Nothing deletes a job.
// No job creates further jobs (a finish() never calls createJob).

import { refused, notFound } from './errors.js';
import { lastJsonBlock } from './runtimes/llm.js';
import { reportView, type ReportView } from './report.js';
import type { Store } from './store.js';
import { createTask as coreCreateTask, type CreateTaskInput } from './tasks.js';
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
  createTask: (store: Store, input: CreateTaskInput & { origin?: string }) => Promise<{ task: TaskRow }>;
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
  const same = store.getJobByRequestId(requestId);
  if (same) return { job: same, created: false };
  const busy = store.listJobs({ project_id: project.id, kind: h.kind, states: ['queued', 'running'] });
  if (busy.length) throw refused(`already running: ${busy.map((j) => j.id).join(', ')}`);
  const r = store.createJob({ project_id: project.id, kind: h.kind, request_id: requestId, input_json: JSON.stringify(input.input ?? {}) });
  return { job: r.row, created: r.created };
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

function latestReport(store: Store, taskId: string): ReportView | undefined {
  const reports = store.listReports({ task_id: taskId });
  const last = reports.at(-1);
  return last ? reportView(last) : undefined;
}

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
        const spec = await h.workTask(store, job, project);
        const created = await d.createTask(store, {
          project: project.name,
          kind: 'single',
          duty: h.duty,
          title: spec.title,
          text: spec.text,
          visible: false,
          requestId: `job:${job.id}`,
          origin: `${h.origin}:${job.id}`,
        });
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
          const result = await h.finish(store, job, latestReport(store, task.id), task);
          const reason = typeof result.summary === 'string' ? result.summary : 'done';
          store.setJobState(job.id, 'done', reason, { result_json: JSON.stringify(result) });
          out.finished.push({ job: job.id, state: 'done', reason });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          store.setJobState(job.id, 'failed', reason.slice(0, 1000));
          out.finished.push({ job: job.id, state: 'failed', reason });
        }
      } else if (task.state === 'failed' || task.state === 'stopped') {
        const reason = task.state_reason || `task ${task.state}`;
        store.setJobState(job.id, 'failed', reason);
        out.finished.push({ job: job.id, state: 'failed', reason });
      }
      // queued, running, landing or waiting-owner: the job waits with its task.
    } catch (e) {
      out.errors.push({ job: job.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** A job as `jv job list|show --json` prints it. */
export function jobView(store: Store, job: JobRow): Record<string, unknown> {
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
