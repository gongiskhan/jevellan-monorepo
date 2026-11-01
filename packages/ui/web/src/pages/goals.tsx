// /goals (brief sections 7 and 9): the goals by project with priority and state, Add (project, title, text,
// priority 1 to 5), Done and Pause per goal, and "Plan now" per project, which queues a plan job (POST /api/jobs
// {kind: 'plan'}, jv job run plan; one per project and local day unless forced, so a second press returns the same
// job).

import { useState } from 'react';
import { addGoal, getGoals, getProjects, goalAction, runJob, useAction, useResource } from '../api.js';
import { ErrorLine, Loading, Modal, PageHeading, RouteLink, useApp } from '../components.js';
import { Icon } from '../icons.js';
import { shortTime } from '../time.js';
import type { GoalView } from '../types.js';

function AddGoal({ projects, initialProject, close }: { projects: string[]; initialProject: string; close(): void }) {
  const [project, setProject] = useState(initialProject || projects[0] || '');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [priority, setPriority] = useState(3);
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title="Add a goal" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => addGoal({ project, title: title.trim(), text: text.trim(), priority })).then((ok) => {
            if (ok) {
              notify('Goal added.');
              close();
            }
          });
        }}
      >
        <div className="form-grid">
          <label>
            Project
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority (1 highest)
            <select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Title
          <input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          What it means when it is reached
          <textarea required maxLength={8000} rows={5} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !title.trim() || !text.trim()}>Add goal</button>
        </div>
      </form>
    </Modal>
  );
}

function GoalRow({ goal }: { goal: GoalView }) {
  const action = useAction();
  const { readonly, notify } = useApp();
  return (
    <li className={`data-row goal-row state-${goal.state}`}>
      <div className="data-main">
        <div className="data-title">
          <span className="mono row-id">{goal.id}</span>
          <span className="chip priority-chip" title="Priority, 1 is highest">
            P{goal.priority}
          </span>
          <strong>{goal.title}</strong>
          <span className={`chip ${goal.state === 'open' ? 'tone-running' : goal.state === 'done' ? 'tone-done' : 'dim'}`}>{goal.state}</span>
        </div>
        <p className="data-text">{goal.text}</p>
        <p className="data-meta">
          <span>updated {shortTime(goal.updatedAt)}</span>
        </p>
        <ErrorLine text={action.error} />
      </div>
      {!readonly && goal.state !== 'done' && (
        <div className="row-actions">
          <button type="button" className="secondary small" disabled={action.busy} onClick={() => void action.run(() => goalAction(goal.id, 'done')).then((ok) => ok && notify(`${goal.id} done.`))}>
            <Icon name="check" size={13} />
            Done
          </button>
          {goal.state === 'open' && (
            <button type="button" className="secondary small" disabled={action.busy} onClick={() => void action.run(() => goalAction(goal.id, 'pause')).then((ok) => ok && notify(`${goal.id} paused.`))}>
              <Icon name="pause" size={13} />
              Pause
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PlanNow({ project }: { project: string }) {
  const action = useAction();
  const { notify } = useApp();
  return (
    <>
      <button
        type="button"
        className="secondary small"
        disabled={action.busy}
        onClick={() =>
          void action
            .run(async () => {
              const r = await runJob(project, 'plan');
              notify(r?.created === false ? `A plan job for ${project} exists today: ${r.job?.id ?? ''}.` : `Plan job queued for ${project}${r?.job?.id ? `: ${r.job.id}` : ''}.`);
            })
        }
      >
        <Icon name="goal" size={13} />
        Plan now
      </button>
      {action.error && <span className="error-text">{action.error}</span>}
    </>
  );
}

export function GoalsPage() {
  const initialProject = new URLSearchParams(window.location.search).get('project') ?? '';
  const [adding, setAdding] = useState(false);
  const { readonly } = useApp();
  const projects = useResource('projects', (signal) => getProjects(signal));
  const goals = useResource(`goals:${initialProject}`, (signal) => getGoals(initialProject || undefined, signal));
  const names = (projects.data ?? []).map((p) => p.name).filter((n) => !initialProject || n === initialProject);
  const byProject = new Map<string, GoalView[]>();
  for (const g of goals.data ?? []) byProject.set(g.project, [...(byProject.get(g.project) ?? []), g]);
  const shown = [...new Set([...names, ...byProject.keys()])];
  return (
    <div className="list-page goals-page">
      <PageHeading title="Goals" intro="Directions written once; the planner turns the open ones into queued tasks.">
        {!readonly && (
          <button type="button" disabled={!names.length} onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add
          </button>
        )}
      </PageHeading>
      <ErrorLine text={goals.error} />
      {!goals.data && goals.loading && <Loading />}
      {goals.data && shown.length === 0 && <p className="empty-inline">No projects yet.</p>}
      {shown.map((project) => {
        const list = (byProject.get(project) ?? []).sort((a, b) => (a.state === 'done' ? 1 : 0) - (b.state === 'done' ? 1 : 0) || a.priority - b.priority);
        return (
          <section key={project} className="card group-card" aria-labelledby={`goals-${project}`}>
            <div className="card-heading">
              <h2 id={`goals-${project}`}>
                <RouteLink href={`/p/${encodeURIComponent(project)}`}>{project}</RouteLink>
              </h2>
              {!readonly && <div className="actions">{<PlanNow project={project} />}</div>}
            </div>
            {list.length === 0 ? (
              <p className="empty-inline">No goals.</p>
            ) : (
              <ul className="data-list" aria-label={`Goals of ${project}`}>
                {list.map((g) => (
                  <GoalRow key={g.id} goal={g} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {adding && <AddGoal projects={names} initialProject={initialProject} close={() => setAdding(false)} />}
    </div>
  );
}
