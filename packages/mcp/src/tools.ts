// The tools and resources of jevellan-mcp (brief section 5): every tool of the section with exactly its name and
// input, a one-sentence description naming the jv command it mirrors, and as structured content the JSON that `jv ...
// --json` prints for that command, built by the same function the command calls (core's statusView, taskView,
// createdTaskView, landView, sessionReport, usageReport ...; the scheduler's scheduleView, the planner's goalView,
// core's jobView) or, where the command builds it inline, by views.ts. The same table is the UI's API (section 7).
//
// - Every operation opens the store for the call and closes it (the server holds no state of its own).
// - jv_task_create creates with the context's origin: 'mcp' through this server, 'ui' through the UI (M-028).
// - jv_task_stop with discard keeps the worktree, as jv task stop --discard does (D-042, D-050). No tool deletes
//   anything, and none touches providers, secrets or the owner's configuration: there is no providers, login,
//   bootstrap, gc, exec or attach tool.
// - jv_tail is a bounded page (core events.tailPage: at most 200 events, payload strings cut to 2000 characters),
//   not the line stream of jv tail --json; jv_project_list wraps the rows of jv project list --json as {projects},
//   because structured content is an object. jv_coordinator_transcript tails the coordinator's transcript first.
// - jv_job_run creates the job now (the bot's tick gives it its task, M-017): plan through jevellan-planner's
//   handlers, improve-* through jevellan-improver's (improve-skills always on the registered jevellan-skills project).
// - `mutates` marks what the UI refuses in --readonly mode: jv_status and jv_coordinator_transcript also write
//   (lost runs marked, the coordinator transcript tailed into events) but only record what already happened, so they
//   count as reads; every tool that changes a task, a memory, a schedule, a goal, a job or a project mutates.
// - Resources jv://status, jv://tasks/{id} and jv://sessions/{id}/report are read-only and return the same JSON as
//   jv_status, jv_task_show and jv_report_get.

import { z } from 'zod';
import { coordinatorStatus, formatStatus as formatCoordinatorStatus } from 'jevellan-core/coordinator';
import { coordinatorTranscript, messageCoordinator } from 'jevellan-core/coordinator-chat';
import { formatChanges, formatChangesStat, taskChanges } from 'jevellan-core/changes';
import { formatCheck } from 'jevellan-core/doctor';
import { refused } from 'jevellan-core/errors';
import { tailPage, type EventView } from 'jevellan-core/events';
import { normalizeId } from 'jevellan-core/ids';
import { createJob, formatJobList, formatJobView, jobView } from 'jevellan-core/jobs';
import { formatLandResult, landExitCode, landTask, landView } from 'jevellan-core/land';
import { markLost } from 'jevellan-core/launcher';
import { addProject, listProjectRows } from 'jevellan-core/project';
import { formatReport, sessionReport } from 'jevellan-core/report';
import { botLine } from 'jevellan-core/bot-state';
import { formatStatus, statusView } from 'jevellan-core/status';
import { withStore, type Store } from 'jevellan-core/store';
import {
  answerTask,
  createdTaskView,
  createTask,
  formatTaskList,
  formatTaskView,
  listTaskSummaries,
  localStamp,
  messageTask,
  overrideTask,
  requireTaskId,
  resumeTask,
  stopTask,
  TASK_LIST_MAX_LIMIT,
  taskView,
} from 'jevellan-core/tasks';
import { JOB_KINDS, OVERRIDE_MODES, TASK_KINDS, TASK_STATES, type ScheduleRow } from 'jevellan-core/types';
import { formatUsageWeek, usageReport } from 'jevellan-core/usage';
import { improveProject, improverHandlers } from 'jevellan-improver';
import { MEMORY_KINDS } from 'jevellan-memory';
import { addGoal, doneGoal, formatGoalList, formatGoalView, goalView, listGoals, plannerHandlers, requireGoal } from 'jevellan-planner';
import { addSchedule, pause, requireSchedule, resume, runNow, runNowCreator, scheduleView } from 'jevellan-scheduler';
import { op, type OpContext, type Operation, type OpResult, type ResourceDef } from './ops.js';
import { botStatusView, doctorView, memoryAdd, memoryArchive, memoryLine, memorySearch } from './views.js';

/** The duties of section 7.3, the only ones jevellan-core knows (brief section 11). */
export const DUTIES = ['answer', 'converse', 'investigate', 'plan', 'implement', 'document', 'verify', 'automate'] as const;

/** No text line is wider than this (AGENTS.md). */
const LINE_MAX = 100;

function fit(line: string, max = LINE_MAX): string {
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : line;
}

function lines(items: readonly string[], empty: string): string {
  return items.length ? items.map((l) => fit(l)).join('\n') : empty;
}

const now = (ctx: OpContext): Date => ctx.deps?.now?.() ?? new Date();

const result = (data: Record<string, unknown>, text: string, exitCode?: number): OpResult => ({
  text,
  data,
  ...(exitCode ? { exitCode } : {}),
});

// ---- input pieces ------------------------------------------------------------------------------------------------

const name = (what: string) => z.string().trim().min(1, `${what} is required`).describe(what);
const projectName = name('The project name, as jv project list shows it.');
const taskId = name('The task id (T + 6 characters).');
const sessionId = name('The session (run) id (R + 6 characters).');
const scheduleId = name('The schedule id (C + 6 characters).');
const goalId = name('The goal id (G + 6 characters).');

// ---- text of the results ---------------------------------------------------------------------------------------

function scheduleLine(s: Record<string, unknown>): string {
  const next = s.enabled && typeof s.nextRunAt === 'string' ? `next ${localStamp(s.nextRunAt)}` : 'paused';
  return `${String(s.id)}  ${String(s.project)}  ${String(s.name)}  ${String(s.cron)} (${String(s.tz)})  ${next}${s.lastResult ? `  last: ${String(s.lastResult)}` : ''}`;
}

function eventLine(e: EventView): string {
  const p = e.payload && typeof e.payload === 'object' ? (e.payload as Record<string, unknown>) : {};
  const body = typeof p.text === 'string' ? p.text : typeof p.summary === 'string' ? p.summary : typeof p.name === 'string' ? p.name : JSON.stringify(e.payload);
  return `${e.seq} ${localStamp(e.at)} ${e.kind} ${body.replace(/\s+/g, ' ')}`;
}

// ---- the operations ------------------------------------------------------------------------------------------------

const status = op({
  name: 'jv_status',
  description: 'What runs, waits on the owner and is queued, per project, with the bot line (jv status --json).',
  input: z.object({ project: projectName.optional() }),
  mutates: false,
  run: ({ project }) =>
    withStore((store) => {
      const opts = project ? { project } : {};
      const view = statusView(store, opts);
      return result(view as unknown as Record<string, unknown>, formatStatus(store, view, opts));
    }),
});

const projectList = op({
  name: 'jv_project_list',
  description: 'The registered projects with their paths and default branches (jv project list --json, as {projects}).',
  input: z.object({}),
  mutates: false,
  run: () => {
    const rows = listProjectRows();
    return result({ projects: rows }, lines(rows.map((p) => `${p.name}  ${p.id}  ${p.default_branch}  ${p.path}`), 'No projects; add one with jv_project_add.'));
  },
});

const projectAdd = op({
  name: 'jv_project_add',
  description: 'Registers a git checkout as a project, or confirms it is registered (jv project add <path> --name N).',
  input: z.object({ path: name('The absolute path of the git checkout.'), name: z.string().trim().min(1).optional().describe('The project name (default: the folder name).') }),
  mutates: true,
  run: ({ path, name: projectNameValue }) => {
    const r = addProject(path, projectNameValue === undefined ? {} : { name: projectNameValue });
    return result(r as unknown as Record<string, unknown>, `${r.created ? 'Registered' : 'Already registered'}: ${r.project.name} (${r.project.id}) at ${r.project.path}, default branch ${r.project.default_branch}.`);
  },
});

const taskList = op({
  name: 'jv_task_list',
  description: 'Tasks newest first with their origin, step and live run (jv task list --json).',
  input: z.object({
    project: projectName.optional(),
    state: z.enum(TASK_STATES).optional().describe('Only tasks in this state.'),
    limit: z.number().int().min(1).max(TASK_LIST_MAX_LIMIT).optional().describe('At most this many tasks (default 50).'),
  }),
  mutates: false,
  run: ({ project, state, limit }) =>
    withStore((store) => {
      const tasks = listTaskSummaries(store, { ...(project ? { project } : {}), ...(state ? { state } : {}), ...(limit !== undefined ? { limit } : {}) });
      return result({ tasks }, formatTaskList(tasks, { showProject: project === undefined }));
    }),
});

const taskShow = op({
  name: 'jv_task_show',
  description: 'One task with its steps, runs, placements, reports, landings and messages (jv task show T --json).',
  input: z.object({ task: taskId }),
  mutates: false,
  run: ({ task }) =>
    withStore((store) => {
      const view = taskView(store, requireTaskId(store, task));
      return result(view as unknown as Record<string, unknown>, formatTaskView(view));
    }),
});

const taskCreate = op({
  name: 'jv_task_create',
  description: 'Creates a task in a project and starts its first step when a slot is free (jv task create).',
  input: z.object({
    project: projectName,
    kind: z.enum(TASK_KINDS).describe('feature, bug and automation follow their workflow; single is one step of `duty`.'),
    duty: z.enum(DUTIES).optional().describe('The duty of a single task (required for kind single only).'),
    title: name('A short title (at most 120 characters).'),
    text: name('What to do, why, where, and how the owner will see the result.'),
    parent: taskId.optional().describe('A parent task: this one branches from its branch and lands into it.'),
    after: taskId.optional().describe('Start only after this task is done.'),
    visible: z.boolean().optional().describe('Run the step where the owner can watch it (a tmux window).'),
  }),
  mutates: true,
  run: (input, ctx) =>
    withStore(async (store) => {
      const r = await createTask(
        store,
        {
          project: input.project,
          kind: input.kind,
          title: input.title,
          text: input.text,
          visible: input.visible === true,
          ...(input.duty !== undefined ? { duty: input.duty } : {}),
          ...(input.parent !== undefined ? { parent: input.parent } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
          origin: ctx.origin,
        },
        ctx.deps?.task ?? {},
      );
      const started = r.start?.state === 'started' ? ` Step ${r.start.step.ordinal} (${r.start.step.duty}) started as ${r.start.session.id}.` : '';
      const text = [
        `Task ${r.task.id}: ${r.task.title} (${r.task.kind}, origin ${r.task.origin})${r.created ? '' : ' - already created by this request'}.`,
        `State ${r.task.state}: ${r.task.state_reason}.${started}`,
        ...r.warnings.map((w) => `Warning: ${w}`),
      ].join('\n');
      return result(createdTaskView(r) as unknown as Record<string, unknown>, text);
    }),
});

const taskMessage = op({
  name: 'jv_task_message',
  description: "Sends a message to a task's step: typed into a live window, or delivered with its next turn (jv task message T).",
  input: z.object({ task: taskId, text: name('The message.') }),
  mutates: true,
  run: ({ task, text }, ctx) =>
    withStore(async (store) => {
      const r = await messageTask(store, task, text, { deps: ctx.deps?.task ?? {} });
      return result(r as unknown as Record<string, unknown>, `Message ${r.message.id} stored (${r.delivery}${r.session ? `, session ${r.session}` : ''}).`);
    }),
});

const taskAnswer = op({
  name: 'jv_task_answer',
  description: 'Answers a task that waits on the owner with an option label or free text (jv task answer T).',
  input: z.object({ task: taskId, answer: name('The option label (any case) or a free-text answer.') }),
  mutates: true,
  run: ({ task, answer }, ctx) =>
    withStore(async (store) => {
      const r = await answerTask(store, task, answer, { deps: ctx.deps?.task ?? {} });
      const text = r.session
        ? `Answer "${r.answer}" sent; the session continues as ${r.session}.`
        : r.stopped
          ? `Left it: task ${r.stopped.task.id} is stopped; the worktree stays.`
          : `Land now: ${JSON.stringify(r.landing)}`;
      return result(r as unknown as Record<string, unknown>, text);
    }),
});

const taskStop = op({
  name: 'jv_task_stop',
  description: "Stops a task's live runs; discard also marks it stopped and keeps its worktree (jv task stop T [--discard]).",
  input: z.object({ task: taskId, discard: z.boolean().optional().describe('Give the task up (the worktree is kept).') }),
  mutates: true,
  run: ({ task, discard }, ctx) =>
    withStore(async (store) => {
      const r = await stopTask(store, task, { discard: discard === true, deps: ctx.deps?.task ?? {} });
      return result(r as unknown as Record<string, unknown>, `${r.stopped.length ? `Stopped ${r.stopped.join(', ')}.` : 'Nothing was running.'} Task ${r.task.id} is ${r.task.state}: ${r.task.state_reason}`);
    }),
});

const taskResume = op({
  name: 'jv_task_resume',
  description: 'Continues a stopped, lost or waiting task on the same native session, or places its step again (jv task resume T).',
  input: z.object({ task: taskId }),
  mutates: true,
  run: ({ task }, ctx) =>
    withStore(async (store) => {
      const r = await resumeTask(store, task, ctx.deps?.task ?? {});
      return result(r as unknown as Record<string, unknown>, `Task ${r.task.id} ${r.how}${r.session ? ` as ${r.session}` : ''}: ${r.task.state_reason}`);
    }),
});

const taskOverride = op({
  name: 'jv_task_override',
  description: "The owner's placement of a task's step: undo restarts it there, keep only records it (jv task override T).",
  input: z.object({
    task: taskId,
    model: name('A model id of providers.json.'),
    effort: z.string().trim().min(1).optional().describe('An effort the model offers.'),
    provider: z.string().trim().min(1).optional().describe('The provider to run it on.'),
    mode: z.enum(OVERRIDE_MODES).describe('undo: stop and restart on this placement; keep: record it, the run continues.'),
  }),
  mutates: true,
  run: (input, ctx) =>
    withStore(async (store) => {
      const r = await overrideTask(
        store,
        input.task,
        { model: input.model, mode: input.mode, ...(input.effort !== undefined ? { effort: input.effort } : {}), ...(input.provider !== undefined ? { provider: input.provider } : {}) },
        ctx.deps?.task ?? {},
      );
      const p = r.placement;
      return result(r as unknown as Record<string, unknown>, `Override (${r.mode}): ${p.model} ${p.effort} on ${p.provider}${r.session ? `, restarted as ${r.session}` : ''}.`);
    }),
});

const taskChangesOp = op({
  name: 'jv_task_changes',
  description: "A task branch's diff against its base plus the worktree's uncommitted changes (jv task changes T [--stat]).",
  input: z.object({ task: taskId, stat: z.boolean().optional().describe('Numbers of added and removed lines only, no diff.') }),
  mutates: false,
  run: ({ task, stat }) =>
    withStore(async (store) => {
      const changes = await taskChanges(store, task, { stat: stat === true });
      return result(changes as unknown as Record<string, unknown>, stat ? formatChangesStat(changes) : formatChanges(changes));
    }),
});

const land = op({
  name: 'jv_land',
  description: 'Decides how a finished task lands and lands it; force is the owner\'s "Land now" (jv land T [--force]).',
  input: z.object({ task: taskId, force: z.boolean().optional().describe('Land without asking Jev (the checks still run).') }),
  mutates: true,
  run: ({ task, force }) =>
    withStore(async (store) => {
      const r = await landTask(store, normalizeId(task), { force: force === true });
      return result(landView(store, r) as unknown as Record<string, unknown>, formatLandResult(r), landExitCode(r));
    }),
});

const reportGet = op({
  name: 'jv_report_get',
  description: "A run's report: status, summary, question and options, tests, changed files, screenshots (jv report S --json).",
  input: z.object({ session: sessionId }),
  mutates: false,
  run: ({ session }) =>
    withStore((store) => {
      const view = sessionReport(store, normalizeId(session));
      return result(view as unknown as Record<string, unknown>, formatReport(view));
    }),
});

const tail = op({
  name: 'jv_tail',
  description: "A page of a run's events, at most 200, text cut to 2000 characters (jv tail S --json, as one object).",
  input: z.object({
    session: sessionId,
    sinceSeq: z.number().int().min(0).optional().describe('Only events after this seq (default 0); pass nextSeq to page on.'),
    limit: z.number().int().min(1).optional().describe('At most this many events (default and most 200).'),
  }),
  mutates: false,
  run: ({ session, sinceSeq, limit }) =>
    withStore((store) => {
      const id = store.requireSession(normalizeId(session)).id;
      markLost(store);
      const page = tailPage(store, id, { ...(sinceSeq !== undefined ? { sinceSeq } : {}), ...(limit !== undefined ? { limit } : {}) });
      const more = page.more ? `\n(more after seq ${page.nextSeq})` : '';
      return result(page as unknown as Record<string, unknown>, `${lines(page.events.map(eventLine), 'No events.')}${more}`);
    }),
});

const coordinatorStatusOp = op({
  name: 'jv_coordinator_status',
  description: "Whether a project's coordinator runs, its session and how to attach to it (jv coordinator status --project N).",
  input: z.object({ project: projectName }),
  mutates: false,
  run: ({ project }, ctx) =>
    withStore((store) => {
      const r = coordinatorStatus(store, project, ctx.deps?.coordinator ?? {});
      return result(r as unknown as Record<string, unknown>, formatCoordinatorStatus(r));
    }),
});

const coordinatorMessage = op({
  name: 'jv_coordinator_message',
  description: "Types one owner line into a project's running coordinator (jv coordinator message --project N \"text\").",
  input: z.object({ project: projectName, text: name('The line to type.') }),
  mutates: true,
  run: ({ project, text }, ctx) =>
    withStore(async (store) => {
      const r = await messageCoordinator(store, project, text, ctx.deps?.coordinatorMessage ?? {});
      return result(r as unknown as Record<string, unknown>, `Message ${r.messageId} typed into the coordinator of ${r.project} (session ${r.session}) at ${localStamp(r.typedAt)}.`);
    }),
});

const coordinatorTranscriptOp = op({
  name: 'jv_coordinator_transcript',
  description: "The conversation with a project's coordinator, tailed from its transcript first (what jv ui's chat shows).",
  input: z.object({ project: projectName, limit: z.number().int().min(1).max(1000).optional().describe('The last N entries (default 100).') }),
  mutates: false,
  run: ({ project, limit }) =>
    withStore((store) => {
      const t = coordinatorTranscript(store, project, { ...(limit !== undefined ? { limit } : {}), refresh: true });
      const text = t.session === null ? `No coordinator session of ${t.project} yet.` : lines(t.entries.map((e) => `${localStamp(e.at)} ${e.role}: ${e.text.replace(/\s+/g, ' ')}`), 'Nothing said yet.');
      return result(t as unknown as Record<string, unknown>, text);
    }),
});

const memorySearchOp = op({
  name: 'jv_memory_search',
  description: "Searches what the agents remember, a project's scopes or every scope (jv memory search [--project N] \"query\").",
  input: z.object({ query: name('Words to look for (full-text, diacritics ignored).'), project: projectName.optional(), limit: z.number().int().min(1).max(200).optional().describe('At most this many (default 20).') }),
  mutates: false,
  run: (input) =>
    withStore((store) => {
      const v = memorySearch(store, input);
      return result(v as unknown as Record<string, unknown>, lines(v.memories.map(memoryLine), 'Nothing remembered matches.'));
    }),
});

const memoryAddOp = op({
  name: 'jv_memory_add',
  description: 'Remembers a fact, preference, lesson, environment detail or decision, globally or for a project (jv memory add).',
  input: z.object({
    kind: z.enum(MEMORY_KINDS),
    text: name('The memory, one self-contained statement (at most 2000 characters).'),
    tags: z.array(z.string().trim().min(1).max(32)).max(8).optional().describe('Up to 8 lowercase tags.'),
    scope: z.enum(['global', 'project']),
    project: projectName.optional().describe('The project, for scope project.'),
  }),
  mutates: true,
  run: (input) =>
    withStore((store) => {
      const v = memoryAdd(store, input, 'mcp');
      return result(v as unknown as Record<string, unknown>, `${v.created ? 'Remembered' : 'Already known'} (${v.id}): ${memoryLine(v.memory)}`);
    }),
});

const memoryArchiveOp = op({
  name: 'jv_memory_archive',
  description: 'Archives a memory with the reason; nothing is ever deleted (jv memory archive M --reason "...").',
  input: z.object({ id: name('The memory id (M + 6 characters).'), reason: name('Why it no longer holds.') }),
  mutates: true,
  run: ({ id, reason }) =>
    withStore((store) => {
      const v = memoryArchive(store, id, reason, 'mcp');
      return result(v as unknown as Record<string, unknown>, `Archived ${v.memory.id}: ${reason}`);
    }),
});

const scheduleView1 = (store: Store, s: ScheduleRow, ctx: OpContext) => scheduleView(store, s, now(ctx));

const scheduleList = op({
  name: 'jv_schedule_list',
  description: 'Schedules with their cron, time zone, next runs and last result (jv schedule list [--project N] --json).',
  input: z.object({ project: projectName.optional() }),
  mutates: false,
  run: ({ project }, ctx) =>
    withStore((store) => {
      const rows = store.listSchedules(project ? { project_id: store.requireProject(project).id } : {});
      const schedules = rows.map((s) => scheduleView1(store, s, ctx));
      return result({ schedules }, lines(schedules.map(scheduleLine), 'No schedules.'));
    }),
});

const scheduleAdd = op({
  name: 'jv_schedule_add',
  description: 'Adds a schedule that creates a task or queues a job at the times of a five-field cron (jv schedule add).',
  input: z.object({
    project: projectName,
    name: name('A name, unique in the project ("Nightly tests").'),
    cron: name('Five fields: minute hour day-of-month month day-of-week ("0 3 * * *").'),
    tz: z.string().trim().min(1).optional().describe('An IANA time zone (default: this machine\'s).'),
    kind: z.enum(['task', 'job']),
    task: z
      .object({
        kind: z.enum(TASK_KINDS),
        duty: z.enum(DUTIES).optional(),
        title: name('The task title; the run date is added to it.'),
        text: name('The task text.'),
        visible: z.boolean().optional(),
      })
      .optional()
      .describe('For kind task: the task each run creates.'),
    job: z.enum(JOB_KINDS).optional().describe('For kind job: the job each run queues.'),
  }),
  mutates: true,
  run: (input, ctx) =>
    withStore((store) => {
      const row = addSchedule(
        store,
        {
          project: input.project,
          name: input.name,
          cron: input.cron,
          kind: input.kind,
          ...(input.tz !== undefined ? { tz: input.tz } : {}),
          ...(input.task !== undefined ? { task: input.task } : {}),
          ...(input.job !== undefined ? { job: input.job } : {}),
        },
        now(ctx),
      );
      const schedule = scheduleView1(store, row, ctx);
      return result({ schedule }, `Added ${fit(scheduleLine(schedule))}`);
    }),
});

const scheduleRun = op({
  name: 'jv_schedule_run',
  description: "Fires a schedule now without moving its next run (jv schedule run C).",
  input: z.object({ schedule: scheduleId }),
  mutates: true,
  run: ({ schedule }, ctx) =>
    withStore(async (store) => {
      const create = ctx.deps?.task ? (s: Store, i: Parameters<typeof createTask>[1]) => createTask(s, i, ctx.deps?.task) : undefined;
      const r = await runNow(store, requireSchedule(store, schedule), now(ctx), { createTask: runNowCreator(undefined, create) });
      return result({ ...r, schedule: scheduleView1(store, r.schedule, ctx) }, `${r.schedule.id}: ${r.result}`);
    }),
});

const schedulePause = op({
  name: 'jv_schedule_pause',
  description: 'Pauses a schedule; it fires again only after jv_schedule_resume (jv schedule pause C).',
  input: z.object({ schedule: scheduleId }),
  mutates: true,
  run: ({ schedule }, ctx) =>
    withStore((store) => {
      const view = scheduleView1(store, pause(store, requireSchedule(store, schedule)), ctx);
      return result({ schedule: view }, `Paused ${String(view.id)} (${String(view.name)}).`);
    }),
});

const scheduleResume = op({
  name: 'jv_schedule_resume',
  description: 'Resumes a paused schedule from its next run after now (jv schedule resume C).',
  input: z.object({ schedule: scheduleId }),
  mutates: true,
  run: ({ schedule }, ctx) =>
    withStore((store) => {
      const view = scheduleView1(store, resume(store, requireSchedule(store, schedule), now(ctx)), ctx);
      return result({ schedule: view }, `Resumed ${fit(scheduleLine(view))}`);
    }),
});

const goalList = op({
  name: 'jv_goal_list',
  description: 'Goals by priority with their state, of one project or all (jv goal list [--project N] --json).',
  input: z.object({ project: projectName.optional() }),
  mutates: false,
  run: ({ project }) =>
    withStore((store) => {
      const goals = listGoals(store, project ? { project } : {}).map((g) => goalView(store, g));
      return result({ goals }, goals.length ? formatGoalList(goals) : 'No goals.');
    }),
});

const goalAdd = op({
  name: 'jv_goal_add',
  description: 'Adds a goal the planner turns into queued tasks (jv goal add --project N --title T --text "...").',
  input: z.object({
    project: projectName,
    title: name('The goal in a line (at most 120 characters).'),
    text: name('What done looks like (at most 8000 characters).'),
    priority: z.number().int().min(1).max(5).optional().describe('1 (highest) to 5 (default 3).'),
  }),
  mutates: true,
  run: (input) =>
    withStore((store) => {
      const goal = goalView(store, addGoal(store, input));
      return result({ goal }, `Added: ${formatGoalView(goal)}`);
    }),
});

const goalDone = op({
  name: 'jv_goal_done',
  description: 'Marks a goal done, so the planner stops planning for it (jv goal done G).',
  input: z.object({ goal: goalId }),
  mutates: true,
  run: ({ goal }) =>
    withStore((store) => {
      // The same function as jv goal done: done is final (M-042).
      const view = goalView(store, doneGoal(store, requireGoal(store, goal).id));
      return result({ goal: view }, `Done: ${formatGoalView(view)}`);
    }),
});

const jobList = op({
  name: 'jv_job_list',
  description: 'Planner and improver jobs, newest first, with their task, state and result (jv job list [--project N] --json).',
  input: z.object({ project: projectName.optional() }),
  mutates: false,
  run: ({ project }) =>
    withStore((store) => {
      const jobs = store.listJobs(project ? { project_id: store.requireProject(project).id } : {}).map((j) => jobView(store, j));
      return result({ jobs }, jobs.length ? formatJobList(jobs) : 'No jobs.');
    }),
});

const jobRun = op({
  name: 'jv_job_run',
  description: 'Creates a plan or improve job now, or returns today\'s job of that kind; the bot runs it (jv job run K --project N).',
  input: z.object({
    project: projectName,
    kind: z.enum(JOB_KINDS),
    force: z.boolean().optional().describe('Create another job even when one of the same day (or week) exists.'),
  }),
  mutates: true,
  run: ({ project, kind, force }) =>
    withStore((store) => {
      // As jv job run: every kind's handler, the project through improveProject (M-042).
      const r = createJob(store, [...plannerHandlers, ...improverHandlers], { project: improveProject(store, kind, project), kind, ...(force ? { force } : {}) });
      const job = jobView(store, r.job);
      return result({ job, created: r.created }, `${r.created ? 'Created' : 'Already there'}: ${formatJobView(job)}`);
    }),
});

const usage = op({
  name: 'jv_usage',
  description: 'Provider usage of an ISO week: quota readings and the token sums of the runs (jv usage [--week W] --json).',
  input: z.object({ week: z.string().trim().min(1).optional().describe('An ISO week (2026-W44) or a date in it; default this week.') }),
  mutates: false,
  run: ({ week }) =>
    withStore((store) => {
      const u = usageReport(store, week);
      return result(u as unknown as Record<string, unknown>, formatUsageWeek(u));
    }),
});

const doctor = op({
  name: 'jv_doctor',
  description: 'Runs the preflights: Node, git, tmux, providers, logins, Jev, store, memory, skills, ports (jv doctor --json).',
  input: z.object({}),
  mutates: false,
  run: async (_input, ctx) => {
    const { view, exitCode } = await doctorView([], ctx.deps?.doctor ?? {});
    return result(view as unknown as Record<string, unknown>, view.checks.map(formatCheck).join('\n'), exitCode);
  },
});

const botStatus = op({
  name: 'jv_bot_status',
  description: "The bot's heartbeat, pid, slots in use, queue, limits and service file (jv bot status --json).",
  input: z.object({}),
  mutates: false,
  run: (_input, ctx) =>
    withStore((store) => {
      const v = botStatusView(store, {
        now: now(ctx).getTime(),
        ...(ctx.deps?.ownerHome !== undefined ? { ownerHome: ctx.deps.ownerHome } : {}),
        ...(ctx.deps?.platform !== undefined ? { platform: ctx.deps.platform } : {}),
      });
      const service = v.service.file === null ? 'service: none for this platform' : `service: ${v.service.installed ? 'installed' : 'not installed'} (${v.service.file})`;
      return result(v as unknown as Record<string, unknown>, [botLine(v.bot, now(ctx).getTime()), service].join('\n'));
    }),
});

/** Every tool of brief section 5, in its order. */
export const operations: readonly Operation[] = [
  status,
  projectList,
  projectAdd,
  taskList,
  taskShow,
  taskCreate,
  taskMessage,
  taskAnswer,
  taskStop,
  taskResume,
  taskOverride,
  taskChangesOp,
  land,
  reportGet,
  tail,
  coordinatorStatusOp,
  coordinatorMessage,
  coordinatorTranscriptOp,
  memorySearchOp,
  memoryAddOp,
  memoryArchiveOp,
  scheduleList,
  scheduleAdd,
  scheduleRun,
  schedulePause,
  scheduleResume,
  goalList,
  goalAdd,
  goalDone,
  jobList,
  jobRun,
  usage,
  doctor,
  botStatus,
] as unknown as readonly Operation[];

/** The tool names of brief section 5, in order. */
export const TOOL_NAMES: readonly string[] = operations.map((o) => o.name);

const byName = new Map(operations.map((o) => [o.name, o]));

/** The operation of a tool name; refuses (exit 2) an unknown one. */
export function operationByName(toolName: string): Operation {
  const found = byName.get(toolName);
  if (!found) throw refused(`no operation ${toolName}`);
  return found;
}

/** Read-only resources with the JSON of jv_status, jv_task_show and jv_report_get. */
export const resources: readonly ResourceDef[] = [
  {
    name: 'status',
    uri: 'jv://status',
    description: 'What runs, waits on the owner and is queued, per project (the JSON of jv_status).',
    read: () => withStore((store) => statusView(store, {}) as unknown as Record<string, unknown>),
  },
  {
    name: 'task',
    uri: 'jv://tasks/{id}',
    description: 'One task with its steps, runs and reports (the JSON of jv_task_show).',
    read: ({ id }) => withStore((store) => taskView(store, requireTaskId(store, id ?? '')) as unknown as Record<string, unknown>),
  },
  {
    name: 'report',
    uri: 'jv://sessions/{id}/report',
    description: "A run's report (the JSON of jv_report_get).",
    read: ({ id }) => withStore((store) => sessionReport(store, normalizeId(id ?? '')) as unknown as Record<string, unknown>),
  },
];
