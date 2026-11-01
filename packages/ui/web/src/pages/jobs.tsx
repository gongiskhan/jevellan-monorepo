// /jobs (brief sections 7 and 10, M-017): the planner's and the improver's jobs with kind, project, the task that does
// the work (a link), state, a summary of the result and the duration, and Run buttons per kind and project (POST
// /api/jobs, jv job run; a kind already queued or running for the project is refused with the job's id, and a plan
// or improve job of the same day or week returns the existing job).

import { useState } from 'react';
import { getJobs, getProjects, runJob, useAction, useResource } from '../api.js';
import { ErrorLine, Loading, PageHeading, RouteLink, StateChip, useApp, useNow } from '../components.js';
import { Icon } from '../icons.js';
import { localTime, msText } from '../time.js';
import { JOB_KINDS, type JobView } from '../types.js';

/** One line about what a finished job did, from its result_json. */
export function resultSummary(job: JobView): string {
  const r = job.result;
  if (!r) return job.reason || '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(r)) {
    if (Array.isArray(value)) parts.push(`${key} ${value.length}`);
    else if (typeof value === 'number') parts.push(`${key} ${value}`);
    else if (typeof value === 'string' && value.length <= 60) parts.push(`${key} ${value}`);
  }
  return parts.join(', ') || job.reason || '';
}

function JobRow({ job, now }: { job: JobView; now: number }) {
  const running = job.state === 'queued' || job.state === 'running';
  return (
    <li className="data-row job-row">
      <div className="data-main">
        <div className="data-title">
          <span className="mono row-id">{job.id}</span>
          <strong>{job.kind}</strong>
          <RouteLink href={`/p/${encodeURIComponent(job.project)}`} className="chip">
            {job.project}
          </RouteLink>
          <StateChip state={job.state} />
          {job.task && (
            <RouteLink href={`/t/${encodeURIComponent(job.task)}`} className="chip mono">
              {job.task}
              {job.taskState ? ` ${job.taskState}` : ''}
            </RouteLink>
          )}
        </div>
        <p className="data-meta">
          <span>created {localTime(job.createdAt)}</span>
          <span>
            {job.durationMs !== null
              ? `took ${msText(job.durationMs)}`
              : running
                ? `${job.state === 'queued' ? 'waiting' : 'running'} ${msText(now - Date.parse(job.createdAt))}`
                : ''}
          </span>
          {resultSummary(job) && resultSummary(job) !== job.state && <span>{resultSummary(job)}</span>}
        </p>
      </div>
    </li>
  );
}

function RunJobs({ projects }: { projects: string[] }) {
  const [project, setProject] = useState(projects[0] ?? '');
  const action = useAction();
  const { notify } = useApp();
  const chosen = project || projects[0] || '';
  return (
    <section className="card run-jobs" aria-labelledby="run-jobs">
      <h2 id="run-jobs">Run a job</h2>
      <div className="filter-bar">
        <label className="compact-label">
          <span className="sr-only">Project</span>
          <select aria-label="Project" value={chosen} onChange={(event) => setProject(event.target.value)}>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {JOB_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="secondary small"
            disabled={action.busy || !chosen}
            onClick={() =>
              void action.run(async () => {
                const r = await runJob(chosen, kind);
                notify(r?.created === false ? `${kind} for ${chosen} exists already: ${r.job?.id ?? ''}.` : `${kind} queued for ${chosen}${r?.job?.id ? `: ${r.job.id}` : ''}.`);
              })
            }
          >
            <Icon name="play" size={13} />
            {kind}
          </button>
        ))}
      </div>
      <ErrorLine text={action.error} />
    </section>
  );
}

export function JobsPage() {
  const now = useNow(5000);
  const { readonly } = useApp();
  const projects = useResource('projects', (signal) => getProjects(signal));
  const jobs = useResource('jobs', (signal) => getJobs(undefined, signal));
  const names = (projects.data ?? []).map((p) => p.name);
  const list = [...(jobs.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="list-page jobs-page">
      <PageHeading title="Jobs" intro="Planning and improving work: each job runs as an ordinary task and its result is applied when the task ends." />
      {!readonly && names.length > 0 && <RunJobs projects={names} />}
      <ErrorLine text={jobs.error} />
      {!jobs.data && jobs.loading && <Loading />}
      {jobs.data?.length === 0 && <p className="empty-inline">No jobs yet.</p>}
      <ul className="data-list" aria-label="Jobs">
        {list.map((job) => (
          <JobRow key={job.id} job={job} now={now} />
        ))}
      </ul>
    </div>
  );
}
