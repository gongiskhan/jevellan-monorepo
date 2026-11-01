// jv schedule add|list|show|run|pause|resume (brief section 9): schedules of jevellan-scheduler, which the bot fires
// every tick (section 8, step 4). Times print as local HH:MM, with the date when not today.
//
//   jv schedule add --project N --name "Nightly tests" --cron "0 3 * * *" [--tz Europe/Lisbon]
//                   (--task-kind single --duty verify --title "Nightly tests" --text "..." [--visible] | --job plan)
//   jv schedule list [--project N]          id, name, cron, next run, enabled, last result
//   jv schedule show S [--project N]        S is an id, or a name within --project
//   jv schedule run S [--project N]         fires now without moving the next run
//   jv schedule pause S | resume S [--project N]
//
// --json: list {schedules: scheduleView[]}; add, show, pause and resume {schedule: scheduleView}; run {schedule:
// scheduleView, result, task?, job?, late?} (the scheduler's FireResult with the schedule replaced by its view).
//
// `run` creates a task schedule's task as `jv task create` does, starting step 1 at once when a slot is free. When Jev
// refuses that start the task still exists, queued with Jev's reason (the bot's admission retries it): the run then
// records "created T.." and prints the refusal as a warning, rather than an error for a task that was made. The bot's
// own firing creates its tasks queued and leaves the start to its admission (jevellan-bot's tick).

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString, requireFlag, requirePositional } from '../command.js';
import { JvError, refused } from 'jevellan-core/errors';
import type { Store } from 'jevellan-core/store';
import { openStore } from 'jevellan-core/store';
import { createTask } from 'jevellan-core/tasks';
import type { ScheduleRow } from 'jevellan-core/types';
import {
  addSchedule,
  pause,
  requireSchedule,
  resume,
  runNow,
  scheduleView,
  type AddScheduleInput,
  type FireDeps,
} from 'jevellan-scheduler';

type View = ReturnType<typeof scheduleView> & {
  id: string;
  project: string;
  name: string;
  cron: string;
  tz: string;
  kind: 'task' | 'job';
  spec: { kind?: string; duty?: string; title?: string; visible?: boolean; job?: string };
  enabled: boolean;
  nextRunAt: string;
  nextRuns: string[];
  lastRunAt: string | null;
  lastResult: string;
  createdAt: string;
};

function view(store: Store, row: ScheduleRow): View {
  return scheduleView(store, row) as View;
}

/** A time as local HH:MM, with the date when it is not today. */
function clock(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function cut(line: string, max = 100): string {
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function what(v: View): string {
  if (v.kind === 'job') return `the job ${v.spec.job}`;
  const duty = v.spec.duty ? ` ${v.spec.duty}` : '';
  return `a ${v.spec.kind}${duty} task "${v.spec.title}"${v.spec.visible ? ' (visible)' : ''}`;
}

/** One list line: id, name, cron, next run, enabled, last result. */
function listLine(v: View, widths: { name: number; cron: number }): string {
  const name = v.name.length > widths.name ? `${v.name.slice(0, widths.name - 3)}...` : v.name.padEnd(widths.name);
  const next = v.enabled ? `next ${clock(v.nextRunAt)}` : 'next -';
  const state = v.enabled ? 'enabled' : 'paused';
  return cut(`${v.id}  ${name}  ${v.cron.padEnd(widths.cron)}  ${next.padEnd(21)}  ${state.padEnd(7)}  ${v.lastResult || 'not run yet'}`);
}

function showText(v: View): string {
  return [
    cut(`${v.id} ${v.name} (${v.project})`),
    `cron ${v.cron} in ${v.tz}; ${v.enabled ? 'enabled' : 'paused'}`,
    cut(`runs ${what(v)}`),
    v.enabled ? cut(`next runs: ${v.nextRuns.map((r) => clock(r)).join(', ')}`) : 'next runs: none while paused',
    cut(`last run ${clock(v.lastRunAt)}${v.lastResult ? `: ${v.lastResult}` : ''}`),
    `created ${clock(v.createdAt)}`,
  ].join('\n');
}

function addInput(args: ParsedArgs): AddScheduleInput {
  const project = requireFlag(args, 'project');
  const name = requireFlag(args, 'name');
  const cron = requireFlag(args, 'cron');
  const tz = flagString(args, 'tz');
  const job = flagString(args, 'job');
  const taskKind = flagString(args, 'task-kind');
  if (job !== undefined && taskKind !== undefined) throw refused('a schedule runs a task (--task-kind ...) or a job (--job ...), not both');
  const base = { project, name, cron, ...(tz !== undefined ? { tz } : {}) };
  if (job !== undefined) {
    for (const f of ['duty', 'title', 'text', 'visible']) if (args.flags[f] !== undefined) throw refused(`--${f} is for task schedules; a job schedule takes --job only`);
    return { ...base, kind: 'job', job };
  }
  if (taskKind === undefined) throw refused('give --task-kind K --title T --text "..." for a task, or --job plan|improve-memory|improve-docs|improve-skills');
  const duty = flagString(args, 'duty');
  return {
    ...base,
    kind: 'task',
    task: {
      kind: taskKind as NonNullable<AddScheduleInput['task']>['kind'],
      ...(duty !== undefined ? { duty } : {}),
      title: flagString(args, 'title') ?? '',
      text: flagString(args, 'text') ?? '',
      visible: flagBool(args, 'visible'),
    },
  };
}

/** createTask as jv task create runs it; a Jev refusal of the start still returns the queued task it made. */
function runCreator(io: CommandIo): FireDeps['createTask'] {
  return async (store, input) => {
    try {
      return await createTask(store, input);
    } catch (error) {
      const taskId = error instanceof JvError ? error.details?.taskId : undefined;
      if (typeof taskId !== 'string') throw error;
      io.warn(`jv: ${error instanceof Error ? error.message : String(error)}`);
      return { task: { id: taskId } };
    }
  };
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0] ?? 'list';
  const store = openStore();
  try {
    switch (sub) {
      case 'add': {
        const v = view(store, addSchedule(store, addInput(args)));
        io.result({ schedule: v }, cut(`${v.id} ${v.name}: added, ${v.cron} in ${v.tz}, next run ${clock(v.nextRunAt)}`));
        return 0;
      }
      case 'list': {
        const project = flagString(args, 'project') ?? args.positionals[1];
        const projectId = project !== undefined ? store.requireProject(project).id : undefined;
        const views = store.listSchedules(projectId !== undefined ? { project_id: projectId } : {}).map((r) => view(store, r));
        const widths = {
          name: Math.min(24, Math.max(4, ...views.map((v) => v.name.length))),
          cron: Math.min(20, Math.max(4, ...views.map((v) => v.cron.length))),
        };
        io.result({ schedules: views }, () => (views.length ? views.map((v) => listLine(v, widths)).join('\n') : 'No schedules.'));
        return 0;
      }
      case 'show': {
        const v = view(store, requireSchedule(store, requirePositional(args, 1, 'the schedule (id, or name with --project)'), flagString(args, 'project')));
        io.result({ schedule: v }, () => showText(v));
        return 0;
      }
      case 'run': {
        const s = requireSchedule(store, requirePositional(args, 1, 'the schedule (id, or name with --project)'), flagString(args, 'project'));
        const r = await runNow(store, s, new Date(), { createTask: runCreator(io) });
        const v = view(store, r.schedule);
        const out = { schedule: v, result: r.result, ...(r.task ? { task: r.task } : {}), ...(r.job ? { job: r.job } : {}), ...(r.late ? { late: r.late } : {}) };
        io.result(out, cut(`${v.id} ${v.name}: ${r.result}`));
        return 0;
      }
      case 'pause': {
        const v = view(store, pause(store, requireSchedule(store, requirePositional(args, 1, 'the schedule (id, or name with --project)'), flagString(args, 'project'))));
        io.result({ schedule: v }, cut(`${v.id} ${v.name}: paused`));
        return 0;
      }
      case 'resume': {
        const v = view(store, resume(store, requireSchedule(store, requirePositional(args, 1, 'the schedule (id, or name with --project)'), flagString(args, 'project'))));
        io.result({ schedule: v }, cut(`${v.id} ${v.name}: resumed, next run ${clock(v.nextRunAt)}`));
        return 0;
      }
      default:
        throw refused(`unknown subcommand "jv schedule ${sub}" (add, list, show, run, pause or resume)`);
    }
  } finally {
    store.close();
  }
}
