// / Projects (brief section 7): the bot line at the top (linking to /bot), then one card per project: the
// coordinator's state (running since, or not running with a Start button) and the project's tasks in their groups
// (task-groups.tsx). Reads GET /api/status (bot, live sessions, questions), /api/projects and /api/tasks (origin and
// the last 24 hours).

import { useState } from 'react';
import { addProject, getCoordinator, getProjects, getStatus, getTasks, startCoordinator, useAction, useResource } from '../api.js';
import { ErrorLine, Loading, Modal, PageHeading, RouteLink, Stamp, useApp, useNow } from '../components.js';
import { Icon } from '../icons.js';
import { TaskGroups } from '../task-groups.js';
import { agoText } from '../time.js';
import type { BotState, ProjectRow, SessionStatus, StatusView, TaskSummary } from '../types.js';

export function botLineText(bot: BotState | undefined): string {
  if (!bot) return 'bot state unknown';
  if (!bot.alive) return bot.heartbeatAt ? `bot not running · last heartbeat ${agoText(bot.heartbeatAt)}` : 'bot not running';
  const age = bot.heartbeatAgeSeconds ?? 0;
  return `bot alive ${age} s ago${bot.pid ? ` (pid ${bot.pid})` : ''} · running ${bot.running}/${bot.limits.total} · queued ${bot.queued}`;
}

export function BotLine({ bot }: { bot: BotState | undefined }) {
  return (
    <RouteLink href="/bot" className={`bot-line ${bot?.alive ? 'alive' : 'down'}`}>
      <i className="bot-dot" aria-hidden="true" />
      <Icon name="bot" size={15} />
      <span>{botLineText(bot)}</span>
    </RouteLink>
  );
}

export function coordinatorSession(status: StatusView | undefined, project: string): SessionStatus | undefined {
  return status?.sessions.find((s) => s.kind === 'coordinator' && s.project === project && ['starting', 'running'].includes(s.state));
}

/** The coordinator's state on a project card: running since HH:MM, or not running with a Start button. */
export function CoordinatorState({ project, live }: { project: string; live: SessionStatus | undefined }) {
  const { readonly, notify } = useApp();
  const detail = useResource(live ? `coordinator:${project}:${live.id}` : null, (signal) => getCoordinator(project, signal), { live: false });
  const start = useAction();
  if (live) {
    return (
      <p className="coordinator-state running">
        <span className="activity-spinner" aria-hidden="true" />
        <span>
          coordinator running
          {detail.data?.startedAt && (
            <>
              {' '}since <Stamp at={detail.data.startedAt} />
            </>
          )}
        </span>
      </p>
    );
  }
  return (
    <div className="coordinator-state">
      <span className="muted">coordinator not running</span>
      {!readonly && (
        <button
          type="button"
          className="secondary small"
          disabled={start.busy}
          onClick={() =>
            void start.run(async () => {
              await startCoordinator(project);
              notify(`Coordinator of ${project} started.`);
            })
          }
        >
          <Icon name="play" size={13} />
          {start.busy ? 'Starting...' : 'Start'}
        </button>
      )}
      {start.error && <span className="error-text">{start.error}</span>}
    </div>
  );
}

function ProjectCard({ project, status, tasks, now }: { project: ProjectRow; status: StatusView | undefined; tasks: TaskSummary[]; now: number }) {
  return (
    <section className="card project-card" aria-labelledby={`project-${project.id}`}>
      <div className="card-heading">
        <div className="project-card-title">
          <h2 id={`project-${project.id}`}>
            <RouteLink href={`/p/${encodeURIComponent(project.name)}`}>{project.name}</RouteLink>
          </h2>
          <p className="project-path" title={project.path}>
            {project.path}
          </p>
        </div>
        <CoordinatorState project={project.name} live={coordinatorSession(status, project.name)} />
      </div>
      <TaskGroups tasks={tasks} statuses={status?.tasks} now={now} idPrefix={`p-${project.id}`} />
    </section>
  );
}

function AddProject({ close }: { close(): void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title="Add project" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run(async () => {
              await addProject(path.trim(), name.trim() || undefined);
            })
            .then((ok) => {
              if (ok) {
                notify('Project added.');
                close();
              }
            });
        }}
      >
        <label>
          Path of the git checkout
          <input required value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/you/dev/project" />
        </label>
        <label>
          Name (optional)
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy}>Add project</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectsPage() {
  const now = useNow(5000);
  const { readonly } = useApp();
  const [adding, setAdding] = useState(false);
  const status = useResource('status', (signal) => getStatus(undefined, signal));
  const projects = useResource('projects', (signal) => getProjects(signal));
  const tasks = useResource('tasks:all', (signal) => getTasks({ limit: 500 }, signal));
  const error = status.error ?? projects.error ?? tasks.error;
  return (
    <div className="projects-page">
      <BotLine bot={status.data?.bot} />
      <PageHeading title="Projects">
        {!readonly && (
          <button type="button" className="secondary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add project
          </button>
        )}
      </PageHeading>
      <ErrorLine text={error} />
      {!projects.data && projects.loading && <Loading />}
      {projects.data && projects.data.length === 0 && (
        <div className="card empty-card">
          <p>No projects yet. Add one here or with jv project add &lt;path&gt;.</p>
        </div>
      )}
      <div className="project-list">
        {(projects.data ?? []).map((project) => (
          <ProjectCard key={project.id} project={project} status={status.data} tasks={(tasks.data ?? []).filter((t) => t.project === project.name)} now={now} />
        ))}
      </div>
      {adding && <AddProject close={() => setAdding(false)} />}
    </div>
  );
}
