// Schedules (brief section 9): rows of the store's schedules table that the bot fires every tick (section 8, step
// 4). A task schedule creates a task through jevellan-core's createTask (the same validation, placement and limits as
// `jv task create`), a job schedule queues a job row for the improver or the planner. Firing is idempotent: the
// request id is `schedule:<id>:<next_run_at>`, so a tick that runs twice creates nothing twice. A schedule missed while
// the bot was down fires once at the next tick, not once per missed slot, and says "fired late (missed HH:MM)".
// `run` fires now without moving next_run_at; pause and resume flip enabled (resume recomputes the next run from now).

import { JvError, refused, notFound } from 'jevellan-core/errors';
import type { Store } from 'jevellan-core/store';
import { createTask, type CreateTaskInput } from 'jevellan-core/tasks';
import { JOB_KINDS, TASK_KINDS, type JobKind, type ProjectRow, type ScheduleRow, type TaskKind } from 'jevellan-core/types';
import { CronError, localTimeZone, nextRun, parseCron, wallClock, isTimeZone } from './cron.js';

/** A task schedule's spec: what `jv task create` takes, minus the project (the schedule's). */
export interface TaskSpec {
  kind: TaskKind;
  duty?: string;
  title: string;
  text: string;
  visible: boolean;
}

export interface JobSpec {
  job: JobKind;
}

export interface AddScheduleInput {
  project: string;
  name: string;
  cron: string;
  tz?: string;
  kind: 'task' | 'job';
  task?: Partial<TaskSpec>;
  job?: string;
  enabled?: boolean;
}

/** The date suffix a task schedule adds to its title ("Nightly tests 2026-11-03"). */
export const TITLE_DATE_SUFFIX_LENGTH = ' YYYY-MM-DD'.length;
const TITLE_MAX = 120;
const TEXT_MAX = 32768;

function cronOrRefuse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CronError) throw refused(e.message);
    throw e;
  }
}

function checkTaskSpec(spec: Partial<TaskSpec> | undefined): TaskSpec {
  if (!spec) throw refused('a task schedule needs --task-kind, --title and --text');
  if (!spec.kind || !(TASK_KINDS as readonly string[]).includes(spec.kind)) throw refused(`--task-kind is one of ${TASK_KINDS.join(', ')}`);
  if (spec.kind === 'single' && !spec.duty) throw refused('a single task needs --duty');
  if (spec.kind !== 'single' && spec.duty) throw refused('--duty is only for --task-kind single');
  const title = (spec.title ?? '').replace(/\s+/g, ' ').trim();
  if (title === '') throw refused('a task schedule needs --title');
  if ([...title].length > TITLE_MAX - TITLE_DATE_SUFFIX_LENGTH) {
    throw refused(`the title is longer than ${TITLE_MAX - TITLE_DATE_SUFFIX_LENGTH} characters (the run date is added to it)`);
  }
  const text = spec.text ?? '';
  if (text.trim() === '') throw refused('a task schedule needs --text');
  if ([...text].length > TEXT_MAX) throw refused(`the text is longer than ${TEXT_MAX} characters`);
  return { kind: spec.kind, ...(spec.duty ? { duty: spec.duty } : {}), title, text, visible: spec.visible === true };
}

function requireProject(store: Store, name: string): ProjectRow {
  const p = store.getProjectByName(name) ?? store.getProject(name);
  if (!p) throw notFound(`no project ${name}`);
  return p;
}

/** Adds a schedule: the cron is checked and must fire within two years; tz defaults to this machine's zone. */
export function addSchedule(store: Store, input: AddScheduleInput, now: Date = new Date()): ScheduleRow {
  const project = requireProject(store, input.project);
  const tz = input.tz ?? localTimeZone();
  if (!isTimeZone(tz)) throw refused(`"${tz}" is not an IANA time zone`);
  const cron = cronOrRefuse(() => parseCron(input.cron));
  const next = cronOrRefuse(() => nextRun(cron, now, tz));
  let spec: TaskSpec | JobSpec;
  if (input.kind === 'task') spec = checkTaskSpec(input.task);
  else if (input.kind === 'job') {
    if (!input.job || !(JOB_KINDS as readonly string[]).includes(input.job)) throw refused(`--job is one of ${JOB_KINDS.join(', ')}`);
    spec = { job: input.job as JobKind };
  } else throw refused('a schedule is of kind task or job');
  return store.createSchedule({
    project_id: project.id,
    name: input.name.trim(),
    cron: cron.text,
    tz,
    kind: input.kind,
    spec_json: JSON.stringify(spec),
    next_run_at: next.toISOString(),
    enabled: input.enabled !== false,
  });
}

/** A schedule by id, or by name within a project when `project` is given. */
export function requireSchedule(store: Store, idOrName: string, project?: string): ScheduleRow {
  const byId = store.getSchedule(idOrName.trim().toUpperCase());
  if (byId) return byId;
  if (project) {
    const p = requireProject(store, project);
    const byName = store.getScheduleByName(p.id, idOrName);
    if (byName) return byName;
  }
  throw notFound(`no schedule ${idOrName}`);
}

/** Enabled schedules whose next run is due at `now`. */
export function due(store: Store, now: Date = new Date()): ScheduleRow[] {
  return store.listSchedules({ enabled: true, dueBy: now.toISOString() });
}

/** The local date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(instant: Date, tz: string): string {
  const w = wallClock(instant.getTime(), tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The local time (HH:MM) of an instant in a zone. */
export function localClock(instant: Date, tz: string): string {
  const w = wallClock(instant.getTime(), tz);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

export interface FireDeps {
  createTask: (store: Store, input: CreateTaskInput & { origin?: string }) => Promise<{ task: { id: string } }>;
}

export interface FireResult {
  schedule: ScheduleRow;
  result: string;
  task?: string;
  job?: string;
  late?: boolean;
}

/** How far past its slot a firing counts as late (the bot ticks every 15 s by default). */
export const LATE_AFTER_MS = 2 * 60_000;

async function create(store: Store, schedule: ScheduleRow, requestId: string, slot: Date, deps: FireDeps): Promise<{ task?: string; job?: string }> {
  const spec = JSON.parse(schedule.spec_json) as TaskSpec | JobSpec;
  if (schedule.kind === 'job') {
    const job = store.createJob({ project_id: schedule.project_id, kind: (spec as JobSpec).job, request_id: requestId, input_json: JSON.stringify({ schedule: schedule.id }), state_reason: `queued by schedule ${schedule.id}` });
    return { job: job.row.id };
  }
  const t = spec as TaskSpec;
  const project = store.getProject(schedule.project_id)!;
  const r = await deps.createTask(store, {
    project: project.name,
    kind: t.kind,
    ...(t.duty ? { duty: t.duty } : {}),
    title: `${t.title} ${localDate(slot, schedule.tz)}`,
    text: t.text,
    visible: t.visible,
    requestId,
    origin: `schedule:${schedule.id}`,
  });
  return { task: r.task.id };
}

/**
 * Fires a due schedule: creates its task or job with the slot's request id, then records last_run_at, the next run
 * from now and last_result. `quiet` (the bot's quiet hours) skips the slot instead. An error is recorded in
 * last_result and the schedule moves on to its next run, so a broken schedule does not refire every tick.
 */
export async function fire(store: Store, schedule: ScheduleRow, now: Date = new Date(), options: { quiet?: boolean; deps?: Partial<FireDeps> } = {}): Promise<FireResult> {
  const deps: FireDeps = { createTask: options.deps?.createTask ?? (createTask as FireDeps['createTask']) };
  const slot = new Date(schedule.next_run_at);
  const late = now.getTime() - slot.getTime() > LATE_AFTER_MS;
  let result: string;
  let made: { task?: string; job?: string } = {};
  if (options.quiet) {
    result = 'skipped: quiet hours';
  } else {
    try {
      made = await create(store, schedule, `schedule:${schedule.id}:${schedule.next_run_at}`, slot, deps);
      result = `created ${made.task ?? made.job}`;
      if (late) result += ` (fired late (missed ${localClock(slot, schedule.tz)}))`;
    } catch (e) {
      result = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    }
  }
  let next: string;
  try {
    next = nextRun(schedule.cron, now, schedule.tz).toISOString();
  } catch (e) {
    // A cron that stopped firing (it fired once on a date that never comes again): keep it, disabled.
    const row = store.updateSchedule(schedule.id, { last_run_at: now.toISOString(), last_result: `${result}; ${e instanceof Error ? e.message : String(e)}`, enabled: 0 });
    return { schedule: row, result, ...made, late };
  }
  const row = store.updateSchedule(schedule.id, { last_run_at: now.toISOString(), next_run_at: next, last_result: result });
  return { schedule: row, result, ...made, ...(late ? { late } : {}) };
}

/** Fires a schedule now without moving next_run_at (`jv schedule run`). */
/**
 * The creator of `run`: core's createTask, which starts step 1 at once when a slot is free; when Jev refuses that
 * start the task exists and stays queued with Jev's reason (the refusal names it in details.taskId), so the run
 * counts it as created (M-055). `onRefused` hears the refusal (jv schedule run prints it as a warning); `create` is
 * the creator it wraps (a test's fake placement).
 */
export function runNowCreator(
  onRefused?: (message: string) => void,
  create: FireDeps['createTask'] = createTask as FireDeps['createTask'],
): FireDeps['createTask'] {
  return async (store, input) => {
    try {
      return await create(store, input);
    } catch (error) {
      const taskId = error instanceof JvError ? error.details?.taskId : undefined;
      if (typeof taskId !== 'string') throw error;
      onRefused?.(error instanceof Error ? error.message : String(error));
      return { task: { id: taskId } };
    }
  };
}

export async function runNow(store: Store, schedule: ScheduleRow, now: Date = new Date(), deps: Partial<FireDeps> = {}): Promise<FireResult> {
  const d: FireDeps = { createTask: deps.createTask ?? runNowCreator() };
  let result: string;
  let made: { task?: string; job?: string } = {};
  try {
    made = await create(store, schedule, `schedule:${schedule.id}:run:${now.toISOString()}`, now, d);
    result = `created ${made.task ?? made.job} (run now)`;
  } catch (e) {
    result = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  }
  const row = store.updateSchedule(schedule.id, { last_run_at: now.toISOString(), last_result: result });
  return { schedule: row, result, ...made };
}

export function pause(store: Store, schedule: ScheduleRow): ScheduleRow {
  return store.updateSchedule(schedule.id, { enabled: 0 });
}

export function resume(store: Store, schedule: ScheduleRow, now: Date = new Date()): ScheduleRow {
  const next = cronOrRefuse(() => nextRun(schedule.cron, now, schedule.tz)).toISOString();
  return store.updateSchedule(schedule.id, { enabled: 1, next_run_at: next });
}

/** A schedule as `jv schedule list|show --json` prints it (the row with its spec parsed and the next three runs). */
export function scheduleView(store: Store, schedule: ScheduleRow, now: Date = new Date()): Record<string, unknown> {
  const project = store.getProject(schedule.project_id);
  let upcoming: string[] = [];
  try {
    upcoming = schedule.enabled ? [new Date(schedule.next_run_at), ...nextRunsAfter(schedule, new Date(schedule.next_run_at), 2)].map((d) => d.toISOString()) : [];
  } catch {
    upcoming = [];
  }
  return {
    id: schedule.id,
    project: project?.name ?? schedule.project_id,
    name: schedule.name,
    cron: schedule.cron,
    tz: schedule.tz,
    kind: schedule.kind,
    spec: JSON.parse(schedule.spec_json) as unknown,
    enabled: schedule.enabled === 1,
    nextRunAt: schedule.next_run_at,
    nextRuns: upcoming,
    lastRunAt: schedule.last_run_at,
    lastResult: schedule.last_result,
    createdAt: schedule.created_at,
    due: schedule.enabled === 1 && schedule.next_run_at <= now.toISOString(),
  };
}

function nextRunsAfter(schedule: ScheduleRow, after: Date, n: number): Date[] {
  const out: Date[] = [];
  let from = after;
  for (let i = 0; i < n; i++) {
    from = nextRun(schedule.cron, from, schedule.tz);
    out.push(from);
  }
  return out;
}
