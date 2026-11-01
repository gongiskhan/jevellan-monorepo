// A project's tasks in the groups of brief section 7: waiting on you, running, queued, landing, then done and failed
// in the last 24 hours. Each line shows the id, title, kind, origin chip, the current step and duty, the model and
// provider of the live session (as the data names them), the time since the last event, and a red dot when a
// session is lost. Groups with nothing in them fold into one row of quiet chips (.pw-quiet-sections, Jevellan 0.7.14)
// instead of a heading and an empty line each.

import { OriginChip, RouteLink, StateDot } from './components.js';
import { agoText } from './time.js';
import type { TaskStatus, TaskSummary } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_RUN_STATES = ['queued', 'starting', 'running'];

export interface TaskGroup {
  id: string;
  label: string;
  tasks: TaskSummary[];
}

export function groupTasks(tasks: readonly TaskSummary[], now: number = Date.now()): TaskGroup[] {
  const recent = (t: TaskSummary) => t.endedAt !== null && now - Date.parse(t.endedAt) <= DAY_MS;
  return [
    { id: 'waiting', label: 'Waiting on you', tasks: tasks.filter((t) => t.state === 'waiting-owner') },
    { id: 'running', label: 'Running', tasks: tasks.filter((t) => t.state === 'running') },
    { id: 'queued', label: 'Queued', tasks: tasks.filter((t) => t.state === 'queued') },
    { id: 'landing', label: 'Landing', tasks: tasks.filter((t) => t.state === 'landing') },
    { id: 'done', label: 'Done, last 24 h', tasks: tasks.filter((t) => t.state === 'done' && recent(t)) },
    { id: 'failed', label: 'Failed, last 24 h', tasks: tasks.filter((t) => (t.state === 'failed' || t.state === 'stopped') && recent(t)) },
  ];
}

export function stepText(task: Pick<TaskSummary, 'step'>): string {
  return task.step ? `step ${task.step.ordinal}/${task.step.of} ${task.step.duty}` : '';
}

export function TaskLine({ task, status, now }: { task: TaskSummary; status?: TaskStatus | undefined; now: number }) {
  const live = task.run && LIVE_RUN_STATES.includes(task.run.state) ? task.run : null;
  const last = task.run?.lastEventAt ?? task.updatedAt;
  const reason = task.state === 'queued' ? (task.after ? `after ${task.after}` : task.stateReason) : task.state === 'waiting-owner' ? (status?.question ?? task.stateReason) : '';
  return (
    <RouteLink href={`/t/${encodeURIComponent(task.id)}`} className="pw-thread-row task-line" title={`${task.id} ${task.title}`}>
      <StateDot state={task.state} lost={task.lost} />
      <span className="pw-row-title">
        <span className="task-id">{task.id}</span> {task.title}
      </span>
      <span className="pw-row-end">
        {task.lost && <span className="lost-label">lost</span>}
        <span title={last}>{agoText(last, now)}</span>
      </span>
      <span className="pw-row-meta task-meta">
        <span>{task.kind}</span>
        <OriginChip origin={task.origin} />
        {stepText(task) && <span>{stepText(task)}</span>}
        {live && (
          <span className="task-model">
            {live.model} via {live.provider}
          </span>
        )}
      </span>
      {reason && <span className="pw-row-summary">{reason}</span>}
    </RouteLink>
  );
}

export function TaskGroups({ tasks, statuses, now, idPrefix }: { tasks: readonly TaskSummary[]; statuses?: readonly TaskStatus[] | undefined; now: number; idPrefix: string }) {
  const groups = groupTasks(tasks, now);
  const quiet = groups.filter((g) => g.tasks.length === 0);
  const byId = new Map((statuses ?? []).map((s) => [s.id, s]));
  return (
    <div className="task-groups">
      {groups
        .filter((g) => g.tasks.length > 0)
        .map((group) => (
          <section key={group.id} className={`pw-section task-group group-${group.id}`} aria-labelledby={`${idPrefix}-${group.id}`}>
            <div className="pw-section-heading">
              <h3 id={`${idPrefix}-${group.id}`}>{group.label}</h3>
              <span className="pw-count">{group.tasks.length}</span>
            </div>
            <div className="pw-list">
              {group.tasks.map((task) => (
                <TaskLine key={task.id} task={task} status={byId.get(task.id)} now={now} />
              ))}
            </div>
          </section>
        ))}
      {quiet.length > 0 && (
        <div className="pw-quiet-sections" aria-label="Empty groups">
          {quiet.map((group) => (
            <span key={group.id} className="pw-quiet">
              {group.label}
              <span className="pw-quiet-count">0</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
