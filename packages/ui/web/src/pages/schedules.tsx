// /schedules (brief sections 7 and 9): the list (name, project, cron, time zone, next run in local time, last run and
// its result, enabled) with Run now, Pause and Resume, and Add (project, name, cron, time zone, kind task or job and
// the spec fields) with a helper that prints the next three runs as the owner types. The helper runs
// jevellan-scheduler's own cron module in the browser (jevellan-scheduler/cron has no Node import, M-016), so the
// preview is exactly what the bot will fire; the server checks the cron again on Add.

import { localTimeZone, nextRuns } from 'jevellan-scheduler/cron';
import { useMemo, useState } from 'react';
import { addSchedule, getProjects, getSchedules, scheduleAction, useAction, useResource } from '../api.js';
import { ErrorLine, Loading, Modal, PageHeading, RouteLink, Stamp, useApp } from '../components.js';
import { Icon } from '../icons.js';
import { localTime } from '../time.js';
import { DUTIES, JOB_KINDS, TASK_KINDS, type ScheduleView } from '../types.js';

/** The next three runs of `cron` in `tz` as local times, or the parser's reason. */
export function cronPreview(cron: string, tz: string, now: Date = new Date()): { runs: string[] } | { error: string } {
  try {
    return { runs: nextRuns(cron.trim(), now, tz || localTimeZone(), 3).map((d) => d.toISOString()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function AddSchedule({ projects, initialProject, close }: { projects: string[]; initialProject: string; close(): void }) {
  const [project, setProject] = useState(initialProject || projects[0] || '');
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 3 * * *');
  const [tz, setTz] = useState(() => localTimeZone());
  const [kind, setKind] = useState<'task' | 'job'>('task');
  const [taskKind, setTaskKind] = useState('single');
  const [duty, setDuty] = useState('verify');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [visible, setVisible] = useState(false);
  const [job, setJob] = useState<string>('plan');
  const action = useAction();
  const { notify } = useApp();
  const preview = useMemo(() => cronPreview(cron, tz), [cron, tz]);
  return (
    <Modal title="Add a schedule" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run(() =>
              addSchedule({
                project,
                name: name.trim(),
                cron: cron.trim(),
                ...(tz ? { tz } : {}),
                kind,
                ...(kind === 'task'
                  ? { task: { kind: taskKind, ...(taskKind === 'single' ? { duty } : {}), title: title.trim() || name.trim(), text: text.trim(), visible } }
                  : { job }),
              }),
            )
            .then((ok) => {
              if (ok) {
                notify('Schedule added.');
                close();
              }
            });
        }}
      >
        <div className="form-grid">
          <label>
            Project
            <select required value={project} onChange={(event) => setProject(event.target.value)}>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Nightly tests" />
          </label>
          <label>
            Cron (minute hour day month weekday)
            <input required className="mono" value={cron} onChange={(event) => setCron(event.target.value)} aria-describedby="cron-preview" />
          </label>
          <label>
            Time zone
            <input value={tz} onChange={(event) => setTz(event.target.value)} placeholder="Europe/Lisbon" />
          </label>
        </div>
        <div id="cron-preview" className="cron-preview" aria-live="polite">
          {'runs' in preview ? (
            <>
              <span className="muted small-text">Next runs</span>
              <ol>
                {preview.runs.map((run) => (
                  <li key={run}>
                    <Stamp at={run} />
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <span className="error-text">{preview.error}</span>
          )}
        </div>
        <fieldset className="pw-override-modes">
          <legend>Kind</legend>
          <label>
            <input type="radio" name="schedule-kind" checked={kind === 'task'} onChange={() => setKind('task')} />
            Task: create a task each time
          </label>
          <label>
            <input type="radio" name="schedule-kind" checked={kind === 'job'} onChange={() => setKind('job')} />
            Job: queue a planner or improver job
          </label>
        </fieldset>
        {kind === 'task' ? (
          <>
            <div className="form-grid">
              <label>
                Task kind
                <select value={taskKind} onChange={(event) => setTaskKind(event.target.value)}>
                  {TASK_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              {taskKind === 'single' && (
                <label>
                  Duty
                  <select value={duty} onChange={(event) => setDuty(event.target.value)}>
                    {DUTIES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Title
                <input maxLength={109} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="The name when empty" />
              </label>
            </div>
            <label>
              Text
              <textarea required rows={4} value={text} onChange={(event) => setText(event.target.value)} />
            </label>
            <label className="toggle">
              <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
              Run visibly (a tmux window the owner can watch)
            </label>
          </>
        ) : (
          <label>
            Job
            <select value={job} onChange={(event) => setJob(event.target.value)}>
              {JOB_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !project || !name.trim() || 'error' in preview || (kind === 'task' && !text.trim())}>Add schedule</button>
        </div>
      </form>
    </Modal>
  );
}

function ScheduleRow({ schedule }: { schedule: ScheduleView }) {
  const action = useAction();
  const { readonly, notify } = useApp();
  const act = (what: 'run' | 'pause' | 'resume') =>
    void action.run(() => scheduleAction(schedule.id, what)).then((ok) => ok && notify(what === 'run' ? `Ran ${schedule.name}.` : what === 'pause' ? `Paused ${schedule.name}.` : `Resumed ${schedule.name}.`));
  const what = schedule.kind === 'job' ? `job ${schedule.spec?.job ?? ''}` : `${schedule.spec?.kind ?? 'task'}${schedule.spec?.duty ? ` ${schedule.spec.duty}` : ''}: ${schedule.spec?.title ?? ''}`;
  return (
    <li className={`data-row schedule-row ${schedule.enabled ? '' : 'paused'}`}>
      <div className="data-main">
        <div className="data-title">
          <span className="mono row-id">{schedule.id}</span>
          <strong>{schedule.name}</strong>
          <RouteLink href={`/p/${encodeURIComponent(schedule.project)}`} className="chip">
            {schedule.project}
          </RouteLink>
          <span className={`chip ${schedule.enabled ? 'tone-done' : 'dim'}`}>{schedule.enabled ? 'enabled' : 'paused'}</span>
        </div>
        <p className="data-meta">
          <code>{schedule.cron}</code>
          <span>{schedule.tz}</span>
          <span>{what}</span>
        </p>
        <p className="data-meta">
          <span>next {schedule.enabled ? localTime(schedule.nextRunAt) : '-'}</span>
          <span>
            last {schedule.lastRunAt ? localTime(schedule.lastRunAt) : 'never'}
            {schedule.lastResult ? `: ${schedule.lastResult}` : ''}
          </span>
        </p>
        <ErrorLine text={action.error} />
      </div>
      {!readonly && (
        <div className="row-actions">
          <button type="button" className="secondary small" disabled={action.busy} onClick={() => act('run')}>
            <Icon name="play" size={13} />
            Run now
          </button>
          {schedule.enabled ? (
            <button type="button" className="secondary small" disabled={action.busy} onClick={() => act('pause')}>
              <Icon name="pause" size={13} />
              Pause
            </button>
          ) : (
            <button type="button" className="secondary small" disabled={action.busy} onClick={() => act('resume')}>
              <Icon name="play" size={13} />
              Resume
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function SchedulesPage() {
  const initialProject = new URLSearchParams(window.location.search).get('project') ?? '';
  const [project, setProject] = useState(initialProject);
  const [adding, setAdding] = useState(false);
  const { readonly } = useApp();
  const projects = useResource('projects', (signal) => getProjects(signal));
  const schedules = useResource(`schedules:${project}`, (signal) => getSchedules(project || undefined, signal));
  const names = (projects.data ?? []).map((p) => p.name);
  return (
    <div className="list-page schedules-page">
      <PageHeading title="Schedules" intro="Tasks and jobs the bot fires at set times, in each schedule's time zone.">
        {!readonly && (
          <button type="button" disabled={!names.length} onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add
          </button>
        )}
      </PageHeading>
      <div className="filter-bar">
        <label className="compact-label">
          <span className="sr-only">Project</span>
          <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">All projects</option>
            {names.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorLine text={schedules.error} />
      {!schedules.data && schedules.loading && <Loading />}
      {schedules.data?.length === 0 && <p className="empty-inline">No schedules.</p>}
      <ul className="data-list" aria-label="Schedules">
        {(schedules.data ?? []).map((s) => (
          <ScheduleRow key={s.id} schedule={s} />
        ))}
      </ul>
      {adding && <AddSchedule projects={names} initialProject={project} close={() => setAdding(false)} />}
    </div>
  );
}
