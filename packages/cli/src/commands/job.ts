// jv job run|list|show|cancel (brief sections 4, 9 and 10; M-017): a job is a row of the jobs table whose work is an
// ordinary single task; the bot gives a queued job its task and, when the task ends, runs the kind's post-processor.
// The machinery is jevellan-core's (createJob, cancelJob, jobView, formatJobList); the kinds are jevellan-planner's
// (plan) and jevellan-improver's (improve-memory, improve-docs, improve-skills), and improveProject names the project
// a kind runs on (improve-skills always on jevellan-skills, refused until it is registered).
//
// jv job run creates the job now (queued) and returns. A second run of a kind the same local day (plan,
// improve-memory) or ISO week (improve-docs, improve-skills) returns that job with exit 0 and its id; --force makes a
// new one; another job of the kind queued or running for the project refuses with exit 2 "already running: J...".
// jv job cancel takes only a queued job. --json prints what the MCP's jv_job_* tools return and the UI's /api/jobs
// routes answer: run {job, created}, list {jobs}, show and cancel {job}. Nothing deletes a job.
//
//   jv job run <kind> --project N [--force]
//   jv job list [--project N]
//   jv job show|cancel J

import type { CommandIo, ParsedArgs } from '../command.js';
import { flagBool, flagString, requirePositional } from '../command.js';
import { notFound, refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { cancelJob, createJob, formatJobList, formatJobView, jobView, type JobHandler, type JobView } from 'jevellan-core/jobs';
import { openStore, type Store } from 'jevellan-core/store';
import { JOB_KINDS } from 'jevellan-core/types';
import { improveProject, improverHandlers } from 'jevellan-improver';
import { plannerHandlers } from 'jevellan-planner';

export const JOB_USAGE = `jv job run <kind> --project N [--force] | jv job list [--project N] | jv job show|cancel J  (kinds: ${JOB_KINDS.join(', ')})`;

/** Every job kind jv knows: the planner's and the improver's. */
export const JOB_HANDLERS: readonly JobHandler[] = [...plannerHandlers, ...improverHandlers];

export interface RunJobResult {
  job: JobView;
  created: boolean;
}

/**
 * jv job run: the kind checked first, then the project the kind runs on (improveProject), then core's createJob with
 * every kind's handler. The MCP's jv_job_run and the UI's POST /api/jobs do the same three calls.
 */
export function runJob(store: Store, input: { kind: string; project?: string; force?: boolean }): RunJobResult {
  if (!(JOB_KINDS as readonly string[]).includes(input.kind)) throw refused(`job kind is one of ${JOB_KINDS.join(', ')}`);
  const project = improveProject(store, input.kind, input.project);
  const r = createJob(store, JOB_HANDLERS, { project, kind: input.kind, ...(input.force ? { force: true } : {}) });
  return { job: jobView(store, r.job), created: r.created };
}

/** The text of jv job run and jv improve. */
export function formatRunJob(r: RunJobResult): string {
  const j = r.job;
  if (r.created) return `${j.id} queued: ${j.kind} for ${j.project}; the bot gives it its task at its next tick (jv job show ${j.id})`;
  return `${j.id} is the ${j.kind} job of ${j.project} for this ${j.kind === 'plan' || j.kind === 'improve-memory' ? 'day' : 'week'} (${j.state}: ${j.reason}); --force makes another`;
}

function requireJob(store: Store, raw: string) {
  const job = store.getJob(normalizeId(raw));
  if (!job) throw notFound(`no job ${raw.trim()}`);
  return job;
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== 'run' && sub !== 'list' && sub !== 'show' && sub !== 'cancel') {
    throw refused(sub === undefined ? JOB_USAGE : `unknown subcommand "job ${sub}". ${JOB_USAGE}`);
  }
  const store = openStore();
  try {
    switch (sub) {
      case 'run': {
        const kind = requirePositional(args, 1, `the job kind (${JOB_KINDS.join(', ')})`);
        const project = flagString(args, 'project');
        const r = runJob(store, { kind, ...(project ? { project } : {}), force: flagBool(args, 'force') });
        io.result(r, () => formatRunJob(r));
        return 0;
      }
      case 'list': {
        const project = flagString(args, 'project');
        const p = project ? store.requireProject(project) : undefined;
        const jobs = store.listJobs(p ? { project_id: p.id } : {}).map((j) => jobView(store, j));
        io.result({ jobs }, () => formatJobList(jobs));
        return 0;
      }
      case 'show': {
        const job = jobView(store, requireJob(store, requirePositional(args, 1, 'the job id')));
        io.result({ job }, () => formatJobView(job));
        return 0;
      }
      case 'cancel': {
        const job = jobView(store, cancelJob(store, requireJob(store, requirePositional(args, 1, 'the job id')).id));
        io.result({ job }, `${job.id} cancelled: ${job.kind} for ${job.project}`);
        return 0;
      }
    }
  } finally {
    store.close();
  }
}
