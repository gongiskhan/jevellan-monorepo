// One tick of the bot (brief section 8): what `jv bot start` runs every tickSeconds and `jv bot tick` runs once. The
// bot runs no model itself: every piece of work it starts is a step of a task, placed by Jev and run by jevellan-core's
// runtimes. In this order, each sub-step wrapped so a failure never stops the tick (the error becomes a log line and
// the meta row bot:last_error, no event), each writing in its own short transactions:
//
//   1. heartbeat: meta bot:heartbeat, bot:pid, bot:started_at, bot:tick (jevellan-core's writeBotHeartbeat).
//   2. reconcile(store, limits, {admit: not in quiet hours}): lost runs marked and resumed (M-024), queued tasks
//      admitted in free slots (M-025, M-026), messages delivered to live claude-tmux runs (M-027), stranded wake lines.
//   3. tailCoordinator(store): every project's coordinator transcript into the store (M-030).
//   4. schedules: due(store, now), then fire(store, schedule, now, {quiet}) for each; last_result says "created T..",
//      "skipped: quiet hours" or the error.
//   5. jobs: stepJobs with the improver's handlers, then with the planner's (M-017).
//   6. housekeeping, once an hour (meta bot:housekeeping_at; due at once when it was never done): the login and
//      usage probe of every provider whose last probe was ready (jevellan-core/providers-check, what `jv providers
//      check` records, without the model lists or Jev), `jv gc` with each project's retention (D-051: archive, never
//      delete), and bot.log trimmed to logLines lines.
//
// The tasks the bot creates (a schedule's task, a job's work task) are created queued, never started on the spot:
// their start is reconcile's admission at the next tick, the one path that holds the slot limits, the quiet hours,
// the once-a-minute Jev retry and the one wake per refusal (M-025, M-026). A Jev refusal therefore never turns a
// created task into a schedule error, and quiet hours hold for job work too.
//
// Quiet hours (bot.json quietHours, local time) stop admissions and schedules; lost runs are still recovered and
// messages still delivered, and jobs still create and finish their (queued) work. Entering and leaving them is logged
// once (meta bot:quiet). A stop requested during a tick (SIGTERM) lets the running sub-step finish and skips the rest.
// The bot never stops a session, never lands outside landTask's own rules and never deletes anything.

import { existsSync } from 'node:fs';
import { writeBotHeartbeat, type BotHeartbeat } from 'jevellan-core/bot-state';
import { tailCoordinator as coreTail, type TailResult } from 'jevellan-core/coordinator-chat';
import { gc as coreGc, type GcAction } from 'jevellan-core/gc';
import { stepJobs as coreStepJobs, type JobDeps, type JobHandler, type StepSummary } from 'jevellan-core/jobs';
import type { Limits } from 'jevellan-core/limits';
import { paths } from 'jevellan-core/paths';
import { probeProviders, readyProviders, type ProviderCheck } from 'jevellan-core/providers-check';
import { reconcile as coreReconcile, type ReconcileSummary } from 'jevellan-core/reconcile';
import { redact } from 'jevellan-core/redact';
import type { Store } from 'jevellan-core/store';
import { createTask as coreCreateTask } from 'jevellan-core/tasks';
import type { ScheduleRow } from 'jevellan-core/types';
import { improverHandlers } from 'jevellan-improver';
import { plannerHandlers } from 'jevellan-planner';
import { due as schedulerDue, fire as schedulerFire, type FireDeps, type FireResult } from 'jevellan-scheduler';
import { inQuietHours, quietText, type BotConfig } from './config.js';
import { openBotLog, REPEAT_LOG_MS, trimLog, type BotLog } from './log.js';

/** The meta rows the bot writes besides the heartbeat (jevellan-core's BOT_META). */
export const BOT_TICK_META = {
  lastError: 'bot:last_error',
  housekeepingAt: 'bot:housekeeping_at',
  quiet: 'bot:quiet',
} as const;

export const HOUSEKEEPING_EVERY_MS = 60 * 60_000;

export const TICK_STEPS = ['heartbeat', 'reconcile', 'coordinator', 'schedules', 'jobs', 'housekeeping'] as const;
export type TickStep = (typeof TICK_STEPS)[number];

/** The task creator of everything the bot creates: queued, its start left to reconcile's admission. */
export const createQueuedTask: FireDeps['createTask'] & JobDeps['createTask'] = (store, input) => coreCreateTask(store, { ...input, start: false });

export interface TickDeps {
  now: () => Date;
  log: BotLog;
  /** The bot run this tick belongs to: its pid, start and the tick's number (written by the heartbeat). */
  run: { pid: number; startedAt: string; tick: number };
  /** Asked before each sub-step: once true, the sub-steps left are skipped (a stop was requested). */
  stopping: () => boolean;
  heartbeat: (store: Store, beat: BotHeartbeat) => void;
  reconcile: (store: Store, limits: Limits, options: { admit: boolean }) => Promise<ReconcileSummary>;
  tailCoordinator: (store: Store) => TailResult;
  due: (store: Store, now: Date) => ScheduleRow[];
  fire: (store: Store, schedule: ScheduleRow, now: Date, options: { quiet: boolean; deps: Partial<FireDeps> }) => Promise<FireResult>;
  /** How the bot creates a schedule's task and a job's work task (default createQueuedTask). */
  createTask: FireDeps['createTask'] & JobDeps['createTask'];
  stepJobs: (store: Store, handlers: readonly JobHandler[], deps: Partial<JobDeps>) => Promise<StepSummary>;
  jobHandlers: { improver: readonly JobHandler[]; planner: readonly JobHandler[] };
  /** The hourly provider probe (default: the providers whose last probe was ready). */
  probeProviders: (store: Store) => Promise<ProviderCheck[]>;
  gc: (store: Store, now: Date) => Promise<GcAction[]>;
  trimLog: (file: string, maxLines: number) => { before: number; after: number };
  housekeepingEveryMs: number;
}

/** The default hourly probe: every enabled provider whose last recorded probe was ready; none without providers.json. */
export async function probeReadyProviders(store: Store): Promise<ProviderCheck[]> {
  if (!existsSync(paths.providersFile)) return [];
  const only = readyProviders(store);
  return only.length ? probeProviders(store, { only }) : [];
}

export function defaultTickDeps(): TickDeps {
  return {
    now: () => new Date(),
    log: openBotLog(),
    run: { pid: process.pid, startedAt: new Date().toISOString(), tick: 1 },
    stopping: () => false,
    heartbeat: writeBotHeartbeat,
    reconcile: (store, limits, options) => coreReconcile(store, limits, options),
    tailCoordinator: (store) => coreTail(store),
    due: schedulerDue,
    fire: (store, schedule, now, options) => schedulerFire(store, schedule, now, options),
    createTask: createQueuedTask,
    stepJobs: (store, handlers, deps) => coreStepJobs(store, handlers, deps),
    jobHandlers: { improver: improverHandlers, planner: plannerHandlers },
    probeProviders: probeReadyProviders,
    gc: (store, now) => coreGc(store, { now }),
    trimLog,
    housekeepingEveryMs: HOUSEKEEPING_EVERY_MS,
  };
}

export interface TickStepResult {
  step: TickStep;
  ok: boolean;
  ms: number;
  /** Why the sub-step did not run: "stopping", "not due". */
  skipped?: string;
  error?: string;
}

export interface TickError {
  /** The sub-step, or the sub-step and its part ("reconcile:admit", "housekeeping:gc", "schedules:C1A2B3C"). */
  step: string;
  message: string;
}

export interface HousekeepingSummary {
  at: string;
  providers: Array<{ name: string; auth: string; detail: string }>;
  gc: Array<Pick<GcAction, 'taskId' | 'project' | 'action' | 'reason'>>;
  log: { before: number; after: number } | null;
}

export interface TickSummary {
  tick: number;
  at: string;
  pid: number;
  quiet: boolean;
  steps: TickStepResult[];
  reconcile: ReconcileSummary | null;
  /** Coordinator sessions this tick read something from (or failed to). */
  coordinator: Array<{ project: string; session: string; events: number; error?: string }>;
  schedules: Array<{ schedule: string; name: string; result: string; task?: string; job?: string; late?: boolean }>;
  jobs: StepSummary;
  /** null when housekeeping was not due this tick. */
  housekeeping: HousekeepingSummary | null;
  errors: TickError[];
  /** A stop was requested during this tick and the sub-steps after it were skipped. */
  stopped: boolean;
}

function messageOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** Records an error of the tick: the summary, a log line and meta bot:last_error (never an event). */
function recordError(store: Store, d: Pick<TickDeps, 'log' | 'now'>, summary: TickSummary, step: string, message: string): void {
  const clean = redact(message).slice(0, 1000);
  summary.errors.push({ step, message: clean });
  d.log.line(`error in ${step}: ${clean}`, d.now(), { key: `error:${step}:${clean}`, everyMs: REPEAT_LOG_MS });
  try {
    store.setMeta(BOT_TICK_META.lastError, JSON.stringify({ at: d.now().toISOString(), step, message: clean }));
  } catch {
    // the store is busy: the log line has it
  }
}

/** One tick (see the header). Never throws: every failure is in the summary's errors. */
export async function tick(store: Store, config: BotConfig, deps: Partial<TickDeps> = {}): Promise<TickSummary> {
  const d: TickDeps = { ...defaultTickDeps(), ...deps };
  const now = d.now();
  const quiet = inQuietHours(now, config.quietHours);
  const summary: TickSummary = {
    tick: d.run.tick,
    at: now.toISOString(),
    pid: d.run.pid,
    quiet,
    steps: [],
    reconcile: null,
    coordinator: [],
    schedules: [],
    jobs: { started: [], finished: [], errors: [] },
    housekeeping: null,
    errors: [],
    stopped: false,
  };

  const step = async (name: TickStep, fn: () => Promise<string | void> | string | void): Promise<void> => {
    if (d.stopping()) {
      summary.stopped = true;
      summary.steps.push({ step: name, ok: false, ms: 0, skipped: 'stopping' });
      return;
    }
    const t0 = Date.now();
    try {
      const skipped = await fn();
      summary.steps.push({ step: name, ok: true, ms: Date.now() - t0, ...(typeof skipped === 'string' ? { skipped } : {}) });
    } catch (error) {
      const message = messageOf(error);
      summary.steps.push({ step: name, ok: false, ms: Date.now() - t0, error: message });
      recordError(store, d, summary, name, message);
    }
  };

  // 1. Heartbeat.
  await step('heartbeat', () => {
    d.heartbeat(store, { pid: d.run.pid, startedAt: d.run.startedAt, tick: d.run.tick, at: now.toISOString() });
    const was = store.getMeta(BOT_TICK_META.quiet) === '1';
    if (was !== quiet) {
      store.setMeta(BOT_TICK_META.quiet, quiet ? '1' : '0');
      d.log.line(quiet ? `quiet hours ${quietText(config.quietHours)} began: no admissions and no schedules` : 'quiet hours ended');
    }
  });

  // 2. Reconcile.
  await step('reconcile', async () => {
    const r = await d.reconcile(store, config.limits, { admit: !quiet });
    summary.reconcile = r;
    for (const x of r.recovered) {
      if (x.action === 'resumed' || x.action === 'placed') d.log.line(`lost run ${x.session} of ${x.task}: ${x.action} as ${x.run ?? '?'}`);
      else d.log.line(`lost run ${x.session} of ${x.task}: ${x.action}${x.reason ? ` (${x.reason})` : ''}`);
    }
    const unhandled = r.lost.filter((id) => !r.recovered.some((x) => x.session === id));
    if (unhandled.length) d.log.line(`marked lost: ${unhandled.join(', ')}`);
    for (const t of r.admitted) d.log.line(`admitted ${t}`);
    for (const x of r.refused) d.log.line(`not admitted ${x.task}: ${x.reason}`, now, { key: `refused:${x.task}:${x.reason}`, everyMs: REPEAT_LOG_MS });
    if (r.delivered.length) d.log.line(`delivered ${r.delivered.length} message${r.delivered.length > 1 ? 's' : ''}: ${r.delivered.join(', ')}`);
    if (r.woke) d.log.line(`woke the coordinator ${r.woke} time${r.woke > 1 ? 's' : ''}`);
    for (const e of r.errors) recordError(store, d, summary, `reconcile:${e.step}`, e.message);
  });

  // 3. The coordinators' transcripts.
  await step('coordinator', () => {
    const r = d.tailCoordinator(store);
    for (const s of r.projects) {
      if (s.events > 0 || s.error) summary.coordinator.push({ project: s.project, session: s.session, events: s.events, ...(s.error ? { error: s.error } : {}) });
      if (s.error) recordError(store, d, summary, `coordinator:${s.project}`, s.error);
    }
  });

  // 4. Schedules.
  await step('schedules', async () => {
    for (const schedule of d.due(store, now)) {
      try {
        const r = await d.fire(store, schedule, now, { quiet, deps: { createTask: d.createTask } });
        summary.schedules.push({
          schedule: schedule.id,
          name: schedule.name,
          result: r.result,
          ...(r.task ? { task: r.task } : {}),
          ...(r.job ? { job: r.job } : {}),
          ...(r.late ? { late: true } : {}),
        });
        if (r.result.startsWith('error:')) recordError(store, d, summary, `schedules:${schedule.id}`, `${schedule.name}: ${r.result.slice('error:'.length).trim()}`);
        else d.log.line(`schedule ${schedule.id} "${schedule.name}": ${r.result}`);
      } catch (error) {
        recordError(store, d, summary, `schedules:${schedule.id}`, `${schedule.name}: ${messageOf(error)}`);
      }
    }
  });

  // 5. Jobs: the improver's kinds, then the planner's.
  await step('jobs', async () => {
    for (const [name, handlers] of [['improver', d.jobHandlers.improver], ['planner', d.jobHandlers.planner]] as const) {
      try {
        const r = await d.stepJobs(store, handlers, { createTask: d.createTask });
        summary.jobs.started.push(...r.started);
        summary.jobs.finished.push(...r.finished);
        summary.jobs.errors.push(...r.errors);
        for (const s of r.started) d.log.line(`job ${s.job} started its task ${s.task}`);
        for (const f of r.finished) d.log.line(`job ${f.job} ${f.state}: ${f.reason}`);
        for (const e of r.errors) recordError(store, d, summary, `jobs:${e.job}`, e.message);
      } catch (error) {
        recordError(store, d, summary, `jobs:${name}`, messageOf(error));
      }
    }
  });

  // 6. Housekeeping, once an hour.
  await step('housekeeping', async () => {
    const last = Date.parse(store.getMeta(BOT_TICK_META.housekeepingAt) ?? '');
    if (Number.isFinite(last) && now.getTime() - last < d.housekeepingEveryMs) return 'not due';
    // Recorded first: a housekeeping that fails is tried again in an hour, not every tick.
    store.setMeta(BOT_TICK_META.housekeepingAt, now.toISOString());
    const h: HousekeepingSummary = { at: now.toISOString(), providers: [], gc: [], log: null };
    summary.housekeeping = h;
    try {
      h.providers = (await d.probeProviders(store)).map((p) => ({ name: p.name, auth: p.auth, detail: p.detail }));
    } catch (error) {
      recordError(store, d, summary, 'housekeeping:providers', messageOf(error));
    }
    try {
      h.gc = (await d.gc(store, now)).map((a) => ({ taskId: a.taskId, project: a.project, action: a.action, reason: a.reason }));
    } catch (error) {
      recordError(store, d, summary, 'housekeeping:gc', messageOf(error));
    }
    try {
      h.log = d.trimLog(d.log.file, config.logLines);
    } catch (error) {
      recordError(store, d, summary, 'housekeeping:log', messageOf(error));
    }
    const probed = h.providers.length ? h.providers.map((p) => `${p.name} ${p.auth}`).join(', ') : 'none ready';
    const gcText = h.gc.length ? h.gc.map((a) => `${a.taskId} ${a.action}`).join(', ') : 'nothing';
    const logText = h.log && h.log.before > h.log.after ? `; bot.log trimmed from ${h.log.before} to ${h.log.after} lines` : '';
    d.log.line(`housekeeping: providers probed: ${probed}; gc: ${gcText}${logText}`);
  });

  return summary;
}

/** "HH:MM" local. */
function clock(iso: string): string {
  const t = new Date(iso);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function cut(line: string, max = 100): string {
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** The text of `jv bot tick`: one line per sub-step and per notable thing, at most 100 characters each. */
export function formatTick(s: TickSummary): string {
  const lines: string[] = [`tick ${s.tick} at ${clock(s.at)} (pid ${s.pid})${s.quiet ? ', quiet hours' : ''}${s.stopped ? ', stopped early' : ''}`];
  for (const st of s.steps) {
    const state = st.skipped ? `skipped (${st.skipped})` : st.ok ? `ok (${st.ms} ms)` : `failed: ${st.error ?? ''}`;
    lines.push(cut(`  ${st.step.padEnd(12)} ${state}`));
  }
  const r = s.reconcile;
  if (r) {
    for (const x of r.recovered) lines.push(cut(`  lost ${x.session} (${x.task}): ${x.action}${x.run ? ` as ${x.run}` : ''}${x.reason ? `, ${x.reason}` : ''}`));
    if (r.admitted.length) lines.push(cut(`  admitted ${r.admitted.join(', ')}`));
    for (const x of r.refused) lines.push(cut(`  not admitted ${x.task}: ${x.reason}`));
    if (r.delivered.length) lines.push(cut(`  delivered ${r.delivered.join(', ')}`));
    if (r.woke) lines.push(`  woke the coordinator ${r.woke} time${r.woke > 1 ? 's' : ''}`);
  }
  for (const c of s.coordinator) lines.push(cut(`  coordinator ${c.project}: ${c.events} events${c.error ? `, ${c.error}` : ''}`));
  for (const x of s.schedules) lines.push(cut(`  ${x.schedule} ${x.name}: ${x.result}`));
  for (const x of s.jobs.started) lines.push(cut(`  ${x.job} started ${x.task}`));
  for (const x of s.jobs.finished) lines.push(cut(`  ${x.job} ${x.state}: ${x.reason}`));
  const h = s.housekeeping;
  if (h) {
    lines.push(cut(`  providers probed: ${h.providers.length ? h.providers.map((p) => `${p.name} ${p.auth}`).join(', ') : 'none ready'}`));
    lines.push(cut(`  gc: ${h.gc.length ? h.gc.map((a) => `${a.taskId} ${a.action}`).join(', ') : 'nothing to archive'}`));
    if (h.log) lines.push(`  bot.log: ${h.log.after} line${h.log.after === 1 ? '' : 's'}${h.log.before > h.log.after ? ` (trimmed from ${h.log.before})` : ''}`);
  }
  for (const e of s.errors) lines.push(cut(`  error ${e.step}: ${e.message}`));
  return lines.join('\n');
}
