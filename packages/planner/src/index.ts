// jevellan-planner (brief section 9): goals are directions the owner writes once; a `plan` job reads a project's open
// goals, what it did in the last 14 days, what is open, what it remembers and the coordinator's notes, and asks one
// planning task (kind single, duty plan, placed by Jev like any work) for the next few tasks. It never starts them:
// finish() creates them queued, with after links, and the bot admits them under its limits.
//
// Goals: addGoal (title and text masked for known secrets before they are stored), listGoals, requireGoal, doneGoal
// and pauseGoal (open or paused to done, open to paused; done is final), goalView and the text of jv goal list|show.
// The plan job's request id is plan:<project>:<YYYY-MM-DD> (local day), so a schedule and a manual run on the same
// day are one job; --force adds a suffix (jobs.ts, M-017). The template is templates/plan.md, verbatim from the brief,
// a candidate to become a duty skill later (M-018). The plan task's lists leave out the jobs' own work tasks (request
// id job:<J>): a planning or tidying task is not project work.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { notFound, refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { lastJsonBlock, localDay, type JobHandler } from 'jevellan-core/jobs';
import { paths } from 'jevellan-core/paths';
import { redact } from 'jevellan-core/redact';
import type { ReportView } from 'jevellan-core/report';
import type { Store } from 'jevellan-core/store';
import { createTask, localStamp, type CreateTaskInput } from 'jevellan-core/tasks';
import { TASK_KINDS, type GoalRow, type JobRow, type ProjectRow, type TaskRow } from 'jevellan-core/types';
import * as memory from 'jevellan-memory';

/** The jevellan-planner package folder (its templates/), from dist/ or dist-test/src/. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'templates')) && existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}
const PACKAGE_ROOT = packageRoot();

export const PLAN_TEMPLATE_FILE = join(PACKAGE_ROOT, 'templates', 'plan.md');
export const DEFAULT_MAX_TASKS = 3;
const DAY = 86_400_000;

// ---- goals ------------------------------------------------------------------------------------------------

function requireProject(store: Store, name: string): ProjectRow {
  const p = store.getProjectByName(name) ?? store.getProject(name);
  if (!p) throw notFound(`no project ${name}`);
  return p;
}

export function addGoal(store: Store, input: { project: string; title: string; text: string; priority?: number }): GoalRow {
  const project = requireProject(store, input.project);
  // A title is one line, as a task's is (jv goal list prints one line per goal). Title and text are masked for known
  // secrets before they are stored, as a task's are.
  const title = redact(input.title).replace(/\s+/g, ' ').trim();
  return store.createGoal({ project_id: project.id, title, text: redact(input.text), ...(input.priority !== undefined ? { priority: input.priority } : {}) });
}

export function requireGoal(store: Store, id: string): GoalRow {
  const g = store.getGoal(normalizeId(id));
  if (!g) throw notFound(`no goal ${id.trim()}`);
  return g;
}

export function listGoals(store: Store, filter: { project?: string; states?: Array<GoalRow['state']> } = {}): GoalRow[] {
  const project = filter.project ? requireProject(store, filter.project) : undefined;
  return store.listGoals({ ...(project ? { project_id: project.id } : {}), ...(filter.states ? { states: filter.states } : {}) });
}

/** Marks a goal done (from open or paused; a done goal is returned as it is). The planner no longer plans for it. */
export function doneGoal(store: Store, id: string): GoalRow {
  const g = requireGoal(store, id);
  return g.state === 'done' ? g : store.setGoalState(g.id, 'done');
}

/** Pauses an open goal (a paused goal is returned as it is); a done goal is refused (exit 2): done is final. */
export function pauseGoal(store: Store, id: string): GoalRow {
  const g = requireGoal(store, id);
  if (g.state === 'done') throw refused(`goal ${g.id} is done; a done goal is not paused`);
  return g.state === 'paused' ? g : store.setGoalState(g.id, 'paused');
}

/** A goal as `jv goal add|list|show|done|pause --json` prints it (the MCP's jv_goal_* tools and the UI give the same). */
export interface GoalView {
  id: string;
  project: string;
  title: string;
  text: string;
  priority: number;
  state: GoalRow['state'];
  createdAt: string;
  updatedAt: string;
}

export function goalView(store: Store, g: GoalRow): GoalView {
  return { id: g.id, project: store.getProject(g.project_id)?.name ?? g.project_id, title: g.title, text: g.text, priority: g.priority, state: g.state, createdAt: g.created_at, updatedAt: g.updated_at };
}

/** No text line of jv goal list is wider than this (AGENTS.md). */
export const GOAL_LINE_MAX = 100;

function cutLine(line: string, max = GOAL_LINE_MAX): string {
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : line;
}

/**
 * One line per goal, ids first, at most 100 characters (the title is cut): id, priority (p1 is the highest), state,
 * project, created (local HH:MM, with the date when not today) and title.
 */
export function formatGoalList(goals: readonly GoalView[], now: number = Date.now()): string {
  if (!goals.length) return 'No goals.';
  const rows = goals.map((g) => [g.id, `p${g.priority}`, g.state, g.project, localStamp(g.createdAt, now)]);
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => [...r[c]!].length)));
  return rows.map((r, i) => cutLine([...r.map((v, c) => v.padEnd(widths[c]!)), goals[i]!.title].join('  '))).join('\n');
}

/** jv goal show G: the goal for people, its text in full. */
export function formatGoalView(g: GoalView, now: number = Date.now()): string {
  return [
    `${g.id}  ${g.title}`,
    `Project ${g.project}, priority ${g.priority}, ${g.state}. Created ${localStamp(g.createdAt, now)}, updated ${localStamp(g.updatedAt, now)}.`,
    '',
    g.text,
  ].join('\n');
}

// ---- the plan job -------------------------------------------------------------------------------------------

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/<(project|path|goals|recent|open|memory|notes|maxTasks)>/g, (m, k: string) => values[k] ?? m);
}

function cut(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

function lastSummary(store: Store, taskId: string): string {
  return store.listReports({ task_id: taskId }).at(-1)?.summary ?? '';
}

function readNotes(project: string): string {
  try {
    return readFileSync(paths.projectNotes(project), 'utf8').trim();
  } catch {
    return '';
  }
}

function maxTasksOf(job: JobRow): number {
  const v = (JSON.parse(job.input_json) as { maxTasks?: unknown }).maxTasks;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10 ? v : DEFAULT_MAX_TASKS;
}

const OPEN_STATES = ['queued', 'running', 'waiting-owner', 'landing'] as const;

/** A job's own work task (request id job:<J>), which the plan lists leave out. */
const isJobTask = (t: TaskRow) => t.request_id.startsWith('job:');

/** The plan task's text, from templates/plan.md (exported for tests and for jv job show). */
export function planTaskText(store: Store, project: ProjectRow, maxTasks: number, now: Date = new Date()): string {
  const goals = store.listGoals({ project_id: project.id, states: ['open'] });
  const tasks = store.listTasks({ project_id: project.id }).filter((t) => !isJobTask(t));
  const since = now.getTime() - 14 * DAY;
  const recent = tasks.filter((t) => Date.parse(t.created_at) >= since && !(OPEN_STATES as readonly string[]).includes(t.state));
  const open = tasks.filter((t) => (OPEN_STATES as readonly string[]).includes(t.state));
  const brief = memory.buildBrief(store.db, { project: project.name, title: 'goals plan next steps', taskText: 'goals plan next steps', duty: 'plan' }).text;
  return fill(readFileSync(PLAN_TEMPLATE_FILE, 'utf8'), {
    project: project.name,
    path: project.path,
    goals: goals.length ? goals.map((g) => `- ${g.id} (priority ${g.priority}) ${g.title}\n  ${g.text.replace(/\n/g, '\n  ')}`).join('\n') : '(no open goals)',
    recent: recent.length ? recent.map((t) => `- ${t.id} ${t.title} (${t.kind}, ${t.state})${lastSummary(store, t.id) ? `: ${cut(lastSummary(store, t.id), 300)}` : ''}`).join('\n') : '(nothing)',
    open: open.length ? open.map((t) => `- ${t.id} ${t.title} (${t.state})`).join('\n') : '(nothing)',
    memory: brief || '(nothing)',
    notes: readNotes(project.name) || '(none)',
    maxTasks: String(maxTasks),
  }).trimEnd();
}

const ProposedTask = z.strictObject({
  goal: z.string().regex(/^G[0-9A-Z]{6}$/),
  kind: z.enum(TASK_KINDS),
  // The template says "<only for single>": a planner that writes null for the other kinds means none.
  duty: z.string().nullable().optional(),
  title: z.string().min(1).max(120),
  text: z.string().min(1).max(32768),
  after: z.union([z.number().int().min(0), z.string().regex(/^\d+$/), z.null()]).optional(),
});

export interface PlanDeps {
  createTask: (store: Store, input: CreateTaskInput & { origin?: string; start?: boolean }) => Promise<{ task: TaskRow }>;
}

/**
 * The plan job's post-processor: the last fenced json block of the report summary, validated (0 to maxTasks tasks,
 * every goal an open goal of the project); each task is created queued with request id plan:<J>:<index>, origin
 * planner:<J>, its after link resolved from the index, not visible and not started. A proposal whose title repeats an
 * earlier one or an open task's title (case-insensitive) is skipped with the reason, as is one whose after task was
 * skipped. No block, or a block that fails validation, fails the job with the reason and creates nothing.
 */
export async function finishPlan(store: Store, job: JobRow, report: ReportView | undefined, deps: Partial<PlanDeps> = {}): Promise<Record<string, unknown>> {
  const make = deps.createTask ?? (createTask as PlanDeps['createTask']);
  if (!report) throw refused('the plan task ended without a report');
  const block = lastJsonBlock(report.summary);
  if (block === undefined) throw refused('the plan report has no fenced json block');
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    throw refused('the plan report\'s json block is not valid JSON');
  }
  const maxTasks = maxTasksOf(job);
  const parsed = z.strictObject({ tasks: z.array(ProposedTask).max(maxTasks) }).safeParse(raw);
  if (!parsed.success) throw refused(`the plan does not validate: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`).join('; ')}`);
  const project = store.getProject(job.project_id)!;
  const openGoals = new Set(store.listGoals({ project_id: project.id, states: ['open'] }).map((g) => g.id));
  for (const t of parsed.data.tasks) if (!openGoals.has(t.goal)) throw refused(`the plan names ${t.goal}, which is not an open goal of ${project.name}`);
  const titleKey = (title: string) => title.replace(/\s+/g, ' ').trim().toLowerCase();
  const openTitles = new Set(store.listTasks({ project_id: project.id, states: [...OPEN_STATES] }).map((t) => titleKey(t.title)));
  const seen = new Set<string>();
  const created: string[] = [];
  const byIndex = new Map<number, string>();
  const skipped: Array<{ title: string; reason: string }> = [];
  for (const [index, t] of parsed.data.tasks.entries()) {
    const key = titleKey(t.title);
    if (seen.has(key)) {
      skipped.push({ title: t.title, reason: 'the same title as an earlier task of this plan' });
      continue;
    }
    seen.add(key);
    if (openTitles.has(key)) {
      skipped.push({ title: t.title, reason: 'an open task has this title' });
      continue;
    }
    const afterIndex = t.after === null || t.after === undefined ? undefined : Number(t.after);
    if (afterIndex !== undefined && afterIndex >= index) {
      skipped.push({ title: t.title, reason: `after ${afterIndex} is not an earlier task of this plan` });
      continue;
    }
    const after = afterIndex !== undefined ? byIndex.get(afterIndex) : undefined;
    if (afterIndex !== undefined && after === undefined) {
      skipped.push({ title: t.title, reason: 'the task it waits for was skipped' });
      continue;
    }
    try {
      const r = await make(store, {
        project: project.name,
        kind: t.kind,
        ...(t.kind === 'single' && t.duty ? { duty: t.duty } : {}),
        title: t.title,
        text: t.text,
        ...(after ? { after } : {}),
        visible: false,
        requestId: `plan:${job.id}:${index}`,
        origin: `planner:${job.id}`,
        start: false,
      });
      created.push(r.task.id);
      byIndex.set(index, r.task.id);
    } catch (e) {
      skipped.push({ title: t.title, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created, skipped, summary: `created ${created.length}, skipped ${skipped.length}` };
}

/** The handler of the plan job kind (jobs.ts). */
export const planHandler: JobHandler = {
  kind: 'plan',
  duty: 'plan',
  origin: 'planner',
  requestId: (project, now) => `plan:${project.name}:${localDay(now)}`,
  workTask: (store, job, project) => {
    const maxTasks = maxTasksOf(job);
    return {
      title: `Plan the next tasks (${localDay(new Date())})`,
      text: planTaskText(store, project, maxTasks),
      input: { maxTasks, goals: store.listGoals({ project_id: project.id, states: ['open'] }).map((g) => g.id) },
    };
  },
  finish: (store, job, report) => finishPlan(store, job, report),
};

export const plannerHandlers: readonly JobHandler[] = [planHandler];
