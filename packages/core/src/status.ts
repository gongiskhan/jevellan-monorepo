// jv status [--project N] (section 3 of the skills brief, section 4 of the monorepo brief): the tasks and sessions
// that are not done, waiting-on-owner first. Lost runs are marked at read time (launcher.markLost); they are not
// advanced: jv task resume continues them.
//
// --json is what the coordinator reads: per task its id, title, kind, state, state_reason, current step (ordinal and
// duty), the latest run's model, provider, runtime and state, the last report's status and summary, and, when the
// task waits on the owner, the question and its options (a landing ask offers "Land now" and "Leave it").
// Tasks that are done are left out; failed and stopped tasks are listed for 24 hours after they ended, and tasks
// done in the last 24 hours are listed apart as `recent` (what landed today). Those keys are the lifted ones, kept
// exactly (M2 compares them with the skills runtime); the one key added is `bot`, the heartbeat state of
// bot-state.ts (brief section 8).
//
// The text is the brief's block (section 4): the bot line, then per project "name (path)" and the groups "waiting
// on you", "running" (tasks that are landing included) and "queued", four-space task lines, and one "landed today:
// ...   failed: ..." line. Task lines are id, title, "step c/n duty", then what the group needs: the waiting kind
// (report status, the landing ask "ask-owner", or the state reason), its session and time and the options; the
// model's providers.json label, effort, provider, session and start time; "after T..." or the queue reason.
// Columns are aligned within each group. No line passes 100 characters: the group's title column narrows first
// (titles cut with "...", never below 10 characters), and only then is the end of a line cut. Times are local
// HH:MM, with the date when not today. A lost run keeps the lifted marker "LOST: jv task resume T".

import { botLine, readBotState, type BotState } from './bot-state.js';
import { markLost } from './launcher.js';
import { findProvider, loadProviders, type ProvidersConfig } from './providers.js';
import { reportView } from './report.js';
import type { Store } from './store.js';
import type { ProjectRow, SessionRow, StepRow, TaskRow, TaskState } from './types.js';

export const RECENT_MS = 24 * 60 * 60 * 1000;
const ORDER: readonly TaskState[] = ['waiting-owner', 'running', 'landing', 'queued', 'failed', 'stopped', 'done'];
export const LANDING_OPTIONS = [
  { label: 'Land now', description: 'jv land T --force' },
  { label: 'Leave it', description: 'jv task stop T --discard' },
];

export interface TaskStatus {
  id: string;
  project: string;
  title: string;
  kind: string;
  state: TaskState;
  state_reason: string;
  step: { ordinal: number; duty: string; state: string; of: number } | null;
  run: { id: string; model: string; provider: string; runtime: string; effort: string; state: string; lastEventAt: string | null } | null;
  lost: boolean;
  report: { session: string; status: string; summary: string } | null;
  question?: string;
  options?: Array<{ label: string; description?: string }>;
  updatedAt: string;
}

export interface SessionStatus {
  id: string;
  project: string;
  kind: string;
  task: string | null;
  step: number | null;
  runtime: string;
  provider: string;
  model: string;
  state: string;
  state_reason: string;
  lastEventAt: string | null;
  tmuxTarget: string | null;
}

export interface StatusView {
  tasks: TaskStatus[];
  sessions: SessionStatus[];
  recent: Array<{ id: string; project: string; title: string; kind: string; endedAt: string | null; landedCommit: string | null }>;
  lost: string[];
  /** The bot's heartbeat, the slots in use and the queue, machine-wide (bot-state.ts). */
  bot: BotState;
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : text;
}

function statusStep(store: Store, task: TaskRow, steps: StepRow[]): StepRow | undefined {
  const byOrdinal = task.current_step > 0 ? steps.find((s) => s.ordinal === task.current_step) : undefined;
  return byOrdinal ?? steps.find((s) => s.state !== 'done' && s.state !== 'skipped') ?? steps.at(-1);
}

export function taskStatus(store: Store, task: TaskRow, projectName: string): TaskStatus {
  const steps = store.listSteps(task.id);
  const step = statusStep(store, task, steps);
  const run = store.listSessions({ task_id: task.id, kind: 'step' }).at(-1);
  const report = store.listReports({ task_id: task.id }).at(-1);
  const view = report ? reportView(report) : undefined;
  const landing = store.listLandings({ task_id: task.id }).at(-1);
  const status: TaskStatus = {
    id: task.id,
    project: projectName,
    title: task.title,
    kind: task.kind,
    state: task.state,
    state_reason: task.state_reason,
    step: step ? { ordinal: step.ordinal, duty: step.duty, state: step.state, of: steps.length } : null,
    run: run
      ? { id: run.id, model: run.model, provider: run.provider, runtime: run.runtime, effort: run.effort, state: run.state, lastEventAt: run.last_event_at }
      : null,
    lost: run?.state === 'lost',
    report: view ? { session: view.sessionId, status: view.status, summary: cut(view.summary, 600) } : null,
    updatedAt: run?.last_event_at ?? task.ended_at ?? task.started_at ?? task.created_at,
  };
  if (task.state === 'waiting-owner') {
    if (landing?.state === 'asked') {
      status.question = `Land ${task.id}? ${landing.reason}`;
      status.options = LANDING_OPTIONS.map((o) => ({ label: o.label, description: o.description.replace(' T ', ` ${task.id} `) }));
    } else if (view && (view.status === 'needs-decision' || view.status === 'blocked') && run && view.sessionId === run.id) {
      if (view.question) status.question = view.question;
      if (view.options?.length) status.options = view.options;
    }
  }
  return status;
}

function sessionStatus(s: SessionRow, projectName: string, step: number | null): SessionStatus {
  return {
    id: s.id,
    project: projectName,
    kind: s.kind,
    task: s.task_id,
    step,
    runtime: s.runtime,
    provider: s.provider,
    model: s.model,
    state: s.state,
    state_reason: s.state_reason,
    lastEventAt: s.last_event_at,
    tmuxTarget: s.tmux_target,
  };
}

/** The status of every project (or one). Marks lost runs first. */
export function statusView(store: Store, options: { project?: string; now?: number; markLost?: boolean } = {}): StatusView {
  const lost = options.markLost === false ? [] : markLost(store).map((s) => s.id);
  const now = options.now ?? Date.now();
  const project = options.project ? store.requireProject(options.project) : undefined;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const tasks = store.listTasks(project ? { project_id: project.id } : {});
  const recentCut = new Date(now - RECENT_MS).toISOString();

  const listed = tasks.filter((t) => {
    if (t.state === 'done') return false;
    if (t.state === 'failed' || t.state === 'stopped') return (t.ended_at ?? t.created_at) >= recentCut;
    return true;
  });
  const statuses = listed
    .map((t) => taskStatus(store, t, names.get(t.project_id) ?? t.project_id))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.updatedAt.localeCompare(b.updatedAt));

  const openTasks = new Set(tasks.filter((t) => !['done', 'stopped'].includes(t.state)).map((t) => t.id));
  const sessions: SessionStatus[] = [];
  for (const s of store.listSessions(project ? { project_id: project.id } : {})) {
    if (['done', 'failed', 'stopped'].includes(s.state)) continue;
    if (s.kind === 'step') {
      if (!s.task_id || !openTasks.has(s.task_id)) continue;
      // A lost run that a later run of its step continued is history, not open work.
      if (s.state === 'lost' && store.listSessions({ step_id: s.step_id ?? '' }).at(-1)?.id !== s.id) continue;
    }
    const step = s.step_id ? (store.getStep(s.step_id)?.ordinal ?? null) : null;
    sessions.push(sessionStatus(s, names.get(s.project_id) ?? s.project_id, step));
  }

  const recent = tasks
    .filter((t) => t.state === 'done' && (t.ended_at ?? '') >= recentCut)
    .map((t) => ({ id: t.id, project: names.get(t.project_id) ?? t.project_id, title: t.title, kind: t.kind, endedAt: t.ended_at, landedCommit: t.landed_commit }));
  return { tasks: statuses, sessions, recent, lost, bot: readBotState(store, now) };
}

// ---- text ------------------------------------------------------------------------------------------------------

/** No line of the text is longer (section 4: one line per item, nothing wider than 100 characters). */
export const STATUS_LINE_MAX = 100;
/** The title column, at most; narrower when every title of the group is shorter, or a line would pass the cap. */
const TITLE_WIDTH = 27;
/** Titles are never cut shorter than this to make a line fit; then the end of the line is cut. */
const TITLE_MIN = 10;
/** A state reason in a task line is cut here, so a long reason does not squeeze the title. */
const REASON_MAX = 50;
const GROUPS: ReadonlyArray<{ header: string; states: readonly TaskState[] }> = [
  { header: 'waiting on you', states: ['waiting-owner'] },
  { header: 'running', states: ['running', 'landing'] },
  { header: 'queued', states: ['queued'] },
];
const LIVE_RUN_STATES: readonly string[] = ['queued', 'starting', 'running', 'waiting'];

export interface FormatStatusOptions {
  /** Default Date.now(); "today" and the bot's heartbeat age are measured from it. */
  now?: number;
  /** The project statusView was filtered on; without it every project is printed. */
  project?: string;
  /** providers.json for the model labels; undefined reads it, null uses none (the model id is printed). */
  providers?: ProvidersConfig | null;
}

function width(text: string): number {
  return [...text].length;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `text` in at most `max` characters, "..." marking a cut. */
function fit(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 3) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 3).join('').trimEnd()}...`;
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - width(text)));
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(iso: string | null | undefined, now: number): boolean {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && sameLocalDay(new Date(t), new Date(now));
}

/** Local "HH:MM" of an ISO time, with the local date in front ("2026-10-31 22:30") when it is not today. */
export function clockTime(iso: string | null | undefined, now: number = Date.now()): string | undefined {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  const two = (v: number): string => String(v).padStart(2, '0');
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return sameLocalDay(d, new Date(now)) ? hm : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/**
 * A model's label in providers.json ("Opus"): the session's provider's entry first, then any provider that lists
 * the id. Without one (no providers.json, a renamed provider) the model id the store holds is printed.
 */
export function modelLabel(config: ProvidersConfig | null, provider: string, model: string): string {
  if (config) {
    const own = findProvider(config, provider)?.models.find((m) => m.id === model);
    const any = own ?? config.providers.flatMap((p) => p.models).find((m) => m.id === model);
    if (any) return any.label;
  }
  return model;
}

function readProvidersOrNull(): ProvidersConfig | null {
  try {
    return loadProviders();
  } catch {
    // jv status works without providers.json; the model id stands in for its label.
    return null;
  }
}

interface TaskLine {
  id: string;
  title: string;
  /** "step c/n duty"; null on queued lines, whose reason takes the step column (the brief's block). */
  step: string | null;
  tail: string[];
}

function stepText(t: TaskStatus): string {
  return t.step ? `step ${t.step.ordinal}/${t.step.of} ${t.step.duty}` : 'no step';
}

function reasonText(reason: string, fallback: string): string {
  const text = oneLine(reason);
  return fit(text === '' ? fallback : text, REASON_MAX);
}

function present(values: Array<string | undefined>): string[] {
  return values.filter((v): v is string => v !== undefined && v !== '');
}

/** waiting on you: the waiting kind, its session, since when, and the options to answer with. */
function waitingTail(store: Store, t: TaskStatus, now: number): string[] {
  const landing = store.listLandings({ task_id: t.id }).at(-1);
  const options = t.options?.length ? `options: ${t.options.map((o) => oneLine(o.label)).join(' | ')}` : undefined;
  if (landing?.state === 'asked') {
    return present(['ask-owner', t.run?.id, clockTime(landing.created_at, now), options]);
  }
  if (t.report && t.run && t.report.session === t.run.id && (t.report.status === 'needs-decision' || t.report.status === 'blocked')) {
    const at = store.getReportBySession(t.report.session)?.created_at ?? t.updatedAt;
    return present([t.report.status, t.report.session, clockTime(at, now), options]);
  }
  return present([reasonText(t.state_reason, 'waiting on you'), t.run?.id, clockTime(t.updatedAt, now), options]);
}

/** running: the live run's model label, effort and provider, its id and start; LOST with the resume hint. */
function runningTail(store: Store, t: TaskStatus, config: ProvidersConfig | null, now: number): string[] {
  const run = t.run;
  if (run && t.lost) return present([`LOST: jv task resume ${t.id}`, run.id, clockTime(run.lastEventAt, now)]);
  if (run && LIVE_RUN_STATES.includes(run.state)) {
    const model = `${modelLabel(config, run.provider, run.model)}${run.effort ? ` ${run.effort}` : ''} via ${run.provider}`;
    const started = store.getSession(run.id)?.started_at ?? run.lastEventAt;
    return present([model, run.state === 'running' ? undefined : run.state, run.id, clockTime(started, now)]);
  }
  const reason = reasonText(t.state_reason, t.state);
  return [t.state === 'landing' && !/land/i.test(reason) ? fit(`landing: ${reason}`, REASON_MAX) : reason];
}

/** queued: "after T..." while the task it waits for is not done, else why it waits (a slot, Jev). */
function queuedTail(store: Store, t: TaskStatus): string[] {
  const afterId = store.getTask(t.id)?.after_task_id;
  const after = afterId ? store.getTask(afterId) : undefined;
  if (after && after.state !== 'done') return [`after ${after.id}`];
  return [reasonText(t.state_reason, 'queued')];
}

function taskLineText(line: TaskLine, titleWidth: number, stepWidth: number): string {
  const rest = [...(line.step !== null ? [pad(line.step, stepWidth)] : []), ...line.tail].join('  ');
  return `    ${line.id}  ${pad(fit(line.title, titleWidth), titleWidth)}  ${rest}`.trimEnd();
}

/**
 * The task lines of one group, aligned: the step column as wide as the group's widest step, the title column as
 * wide as its widest title up to TITLE_WIDTH, and narrower when a line would pass STATUS_LINE_MAX, so the titles
 * are what gives way first (never below TITLE_MIN). A line still too wide is then cut at the end.
 */
function groupLines(lines: TaskLine[]): string[] {
  const stepWidth = Math.max(0, ...lines.map((l) => (l.step === null ? 0 : width(l.step))));
  const widest = Math.max(0, ...lines.map((l) => width(l.title)));
  let titleWidth = Math.min(TITLE_WIDTH, widest);
  for (const l of lines) titleWidth = Math.min(titleWidth, STATUS_LINE_MAX - width(taskLineText(l, 0, stepWidth)));
  titleWidth = Math.max(titleWidth, Math.min(TITLE_MIN, widest));
  return lines.map((l) => fit(taskLineText(l, titleWidth, stepWidth), STATUS_LINE_MAX));
}

/**
 * "  landed today: T1 (12:02), T2 (09:40)   failed: none". When that is too wide, landed ids give way first (failed
 * ones need the owner more), each list ending in "+N more".
 */
function landedLine(landed: string[], failed: string[]): string {
  const list = (items: string[], shown: number): string =>
    items.length === 0 ? 'none' : [...items.slice(0, shown), ...(shown < items.length ? [`+${items.length - shown} more`] : [])].join(', ');
  let shownLanded = landed.length;
  let shownFailed = failed.length;
  const build = (): string => `  landed today: ${list(landed, shownLanded)}   failed: ${list(failed, shownFailed)}`;
  let text = build();
  while (width(text) > STATUS_LINE_MAX && shownLanded + shownFailed > 0) {
    if (shownLanded > 0) shownLanded--;
    else shownFailed--;
    text = build();
  }
  return fit(text, STATUS_LINE_MAX);
}

/** Newest first: "T1AAB2C (12:02)". */
function timedIds(items: Array<{ id: string; at: string | null }>, now: number): string[] {
  return [...items]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .map((i) => {
      const at = clockTime(i.at, now);
      return at ? `${i.id} (${at})` : i.id;
    });
}

/**
 * `jv status` as text, the brief's block (section 4), for example:
 *
 *   bot: alive 4 s ago (pid 48211) · running 2/4 · queued 1
 *   ekoa-code (/Users/ggomes/dev/ekoa-code)
 *     running
 *       T7FDA1A  README how-to-run  step 1/2 implement  Opus high via claude-main  R9Q1XXA  12:39
 *     queued
 *       T2PP0MA  Unit test for slugify  after T7FDA1A
 *     landed today: T1AAB2A (12:02)   failed: none
 *
 * `view` is statusView's (with the same `project` filter); the store gives the project paths and the facts the JSON
 * does not carry (report and run times, the task a queued task waits for, an open landing ask).
 */
export function formatStatus(store: Store, view: StatusView, options: FormatStatusOptions = {}): string {
  const now = options.now ?? Date.now();
  const config = options.providers !== undefined ? options.providers : readProvidersOrNull();
  const projects: ProjectRow[] = options.project ? [store.requireProject(options.project)] : store.listProjects();
  const lines: string[] = [botLine(view.bot, now)];
  if (!projects.length) {
    lines.push('No projects yet: jv project add <path>');
    return lines.join('\n');
  }

  const sections = projects.map((p) => {
    const tasks = view.tasks.filter((t) => t.project === p.name);
    const groups = GROUPS.map((g) => ({
      header: g.header,
      lines: tasks
        .filter((t) => g.states.includes(t.state))
        .map((t): TaskLine => {
          const title = oneLine(t.title);
          if (g.header === 'queued') return { id: t.id, title, step: null, tail: queuedTail(store, t) };
          const tail = g.header === 'running' ? runningTail(store, t, config, now) : waitingTail(store, t, now);
          return { id: t.id, title, step: stepText(t), tail };
        }),
    })).filter((g) => g.lines.length > 0);
    const landed = timedIds(
      view.recent.filter((r) => r.project === p.name && isToday(r.endedAt, now)).map((r) => ({ id: r.id, at: r.endedAt })),
      now,
    );
    const failed = timedIds(
      tasks.filter((t) => t.state === 'failed' || t.state === 'stopped').map((t) => ({ id: t.id, at: store.getTask(t.id)?.ended_at ?? null })),
      now,
    );
    return { project: p, groups, landed, failed };
  });

  for (const s of sections) {
    lines.push(fit(`${s.project.name} (${s.project.path})`, STATUS_LINE_MAX));
    for (const g of s.groups) {
      lines.push(`  ${g.header}`);
      lines.push(...groupLines(g.lines));
    }
    lines.push(landedLine(s.landed, s.failed));
  }
  return lines.join('\n');
}
