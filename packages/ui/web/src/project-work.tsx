// /p/:name, a project (brief section 7), in the layout of Jevellan's project page (gongiskhan/jevellan at 8e2788ec,
// apps/web/src/project-work.tsx and project-work.css): the page is a size container; from 760 px of page width
// (about 1100 px of window beside the open sidebar) the coordinator conversation and the project's work sit side by
// side, below that they are two tabs, "Chat" and "Work".
//
// Chat: the conversation with the coordinator from GET .../coordinator/transcript (core coordinatorTranscript, M-030):
// the owner's lines right-aligned, the coordinator's text as Markdown, jv's lines (wake lines, the handoff) dimmed,
// tool calls collapsed to one line ("ran jv task create ..."), and the response time at the end of each turn. The
// composer posts .../coordinator/message; when the coordinator is not running it is replaced by "Start coordinator"
// and the last 50 lines of its previous session stay visible.
//
// Work: the task groups (task-groups.tsx), notes.md read-only with Edit saving through POST .../notes (jv notes
// write), the workflow files in use, and Memory, Schedules and Goals chips with counts linking to their pages. New task
// creates a task from the UI (POST /api/tasks, origin ui) and opens it.

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  createTask,
  getGoals,
  getMemories,
  getNotes,
  getSchedules,
  getStatus,
  getTasks,
  getTranscript,
  getWorkflows,
  messageCoordinator,
  saveNotes,
  startCoordinator,
  useAction,
  useResource,
} from './api.js';
import { ErrorLine, Loading, Markdown, Modal, RouteLink, Stamp, useApp, useNow } from './components.js';
import { Icon } from './icons.js';
import { coordinatorSession } from './pages/projects.js';
import { ResponseTime } from './response-time.js';
import { TaskGroups } from './task-groups.js';
import { DUTIES, TASK_KINDS, type CoordinatorEntry } from './types.js';

const LIVE_LIMIT = 200;
const ENDED_LIMIT = 50;

function ChatEntry({ entry }: { entry: CoordinatorEntry }) {
  switch (entry.role) {
    case 'owner':
      return (
        <article className="user-message pw-owner">
          <div className="message-heading">
            <strong>You</strong>
            <Stamp at={entry.at} />
          </div>
          <p>{entry.text}</p>
        </article>
      );
    case 'jv':
      return (
        <p className="pw-jv-line" title="A line jv typed into the coordinator">
          <span className="pw-jv-label">jv</span>
          <span>{entry.text}</span>
        </p>
      );
    case 'tool': {
      const failed = entry.tool?.ok === false;
      return (
        <details className={`pw-tool-line${failed ? ' failed' : ''}`}>
          <summary>
            <Icon name={failed ? 'cross' : 'terminal'} size={13} />
            <span className="pw-tool-text">{entry.text}</span>
          </summary>
          {entry.tool?.input && <pre><code>{entry.tool.input}</code></pre>}
          {entry.tool?.output !== undefined && <pre><code>{entry.tool.output || 'No text output.'}</code></pre>}
        </details>
      );
    }
    default:
      return (
        <div className="pw-reply">
          <Markdown>{entry.text}</Markdown>
          {entry.turnEnd && <ResponseTime at={entry.at} tookMs={entry.responseMs} />}
        </div>
      );
  }
}

function Composer({ project }: { project: string }) {
  const [text, setText] = useState('');
  const send = useAction();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight + 2, window.innerHeight / 3))}px`;
  }, [text]);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || send.busy) return;
    void send.run(() => messageCoordinator(project, value)).then((ok) => {
      if (ok) setText((current) => (current.trim() === value ? '' : current));
    });
  };
  return (
    <form className="composer pw-composer" onSubmit={submit}>
      <ErrorLine text={send.error} />
      <div className="message-input-row">
        <textarea
          ref={ref}
          rows={1}
          aria-label="Message the coordinator"
          placeholder="Message the coordinator"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="message-actions">
          <button type="submit" className="send-icon" aria-label="Send" disabled={send.busy || !text.trim()}>
            <Icon name="send" size={20} />
          </button>
        </div>
      </div>
    </form>
  );
}

function StartBar({ project }: { project: string }) {
  const start = useAction();
  const { readonly, notify } = useApp();
  return (
    <div className="composer pw-composer pw-start-bar">
      <p className="muted small-text">The coordinator is not running.</p>
      {!readonly && (
        <button
          type="button"
          disabled={start.busy}
          onClick={() => void start.run(() => startCoordinator(project)).then((ok) => ok && notify(`Coordinator of ${project} started.`))}
        >
          <Icon name="play" size={14} />
          {start.busy ? 'Starting...' : 'Start coordinator'}
        </button>
      )}
      <ErrorLine text={start.error} />
    </div>
  );
}

function Notes({ project }: { project: string }) {
  const notes = useResource(`notes:${project}`, (signal) => getNotes(project, signal));
  const [draft, setDraft] = useState<string>();
  const save = useAction();
  const { readonly, notify } = useApp();
  const text = notes.data?.text ?? '';
  return (
    <section className="pw-section notes-section" aria-labelledby="notes-heading">
      <div className="pw-section-heading">
        <h3 id="notes-heading">notes.md</h3>
        {!readonly && draft === undefined && (
          <button type="button" className="text-button small-text" onClick={() => setDraft(text)}>
            Edit
          </button>
        )}
      </div>
      {draft === undefined ? (
        notes.data ? (
          text.trim() ? (
            <div className="notes-view">
              <Markdown>{text}</Markdown>
            </div>
          ) : (
            <p className="pw-empty">No notes yet.</p>
          )
        ) : (
          <ErrorLine text={notes.error} />
        )
      ) : (
        <form
          className="notes-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void save.run(() => saveNotes(project, draft)).then((ok) => {
              if (ok) {
                setDraft(undefined);
                notify('Notes saved.');
                notes.reload();
              }
            });
          }}
        >
          <textarea aria-label="notes.md" className="pw-notebook-text" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <ErrorLine text={save.error} />
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button disabled={save.busy}>Save</button>
          </div>
        </form>
      )}
    </section>
  );
}

function Workflows({ project }: { project: string }) {
  const workflows = useResource(`workflows:${project}`, (signal) => getWorkflows(project, signal), { live: false });
  return (
    <section className="pw-section" aria-labelledby="workflows-heading">
      <div className="pw-section-heading">
        <h3 id="workflows-heading">Workflows</h3>
        <span className="pw-count">{workflows.data?.length ?? 0}</span>
      </div>
      <ErrorLine text={workflows.error} />
      {workflows.data?.length === 0 && <p className="pw-empty">No workflow files.</p>}
      <ul className="workflow-list">
        {(workflows.data ?? []).map((w) => (
          <li key={`${w.kind}:${w.file}`}>
            <div className="workflow-head">
              <strong>{w.kind}</strong>
              <span className="chip dim">{w.source}</span>
            </div>
            <span className="workflow-file" title={w.file}>
              {w.file}
            </span>
            <span className="workflow-steps">{w.steps.map((s) => (typeof s === 'string' ? s : s.duty)).join(' > ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Counts({ project }: { project: string }) {
  const memories = useResource(`memory-count:${project}`, (signal) => getMemories({ project, limit: 500 }, signal));
  const schedules = useResource(`schedule-count:${project}`, (signal) => getSchedules(project, signal));
  const goals = useResource(`goal-count:${project}`, (signal) => getGoals(project, signal));
  const q = `?project=${encodeURIComponent(project)}`;
  return (
    <div className="pw-chips" aria-label="Project records">
      <RouteLink href={`/memory${q}`} className="pw-chip-link">
        <Icon name="memory" size={14} />
        Memory <span className="pw-quiet-count">{memories.data?.length ?? '-'}</span>
      </RouteLink>
      <RouteLink href={`/schedules${q}`} className="pw-chip-link">
        <Icon name="schedule" size={14} />
        Schedules <span className="pw-quiet-count">{schedules.data?.length ?? '-'}</span>
      </RouteLink>
      <RouteLink href={`/goals${q}`} className="pw-chip-link">
        <Icon name="goal" size={14} />
        Goals <span className="pw-quiet-count">{goals.data?.filter((g) => g.state !== 'done').length ?? '-'}</span>
      </RouteLink>
    </div>
  );
}

/** A task created from the UI (POST /api/tasks, jv_task_create with origin ui); the page opens it once created. */
function NewTask({ project, close }: { project: string; close(): void }) {
  const [kind, setKind] = useState<string>('single');
  const [duty, setDuty] = useState<string>('investigate');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [after, setAfter] = useState('');
  const [visible, setVisible] = useState(false);
  const action = useAction();
  const { navigate, notify } = useApp();
  return (
    <Modal title={`New task in ${project}`} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          let created: string | undefined;
          void action
            .run(async () => {
              const r = await createTask({ project, kind, ...(kind === 'single' ? { duty } : {}), title: title.trim(), text: text.trim(), ...(after.trim() ? { after: after.trim() } : {}), visible });
              created = r?.task?.id;
            })
            .then((ok) => {
              if (!ok) return;
              notify(created ? `Created ${created}.` : 'Task created.');
              close();
              if (created) navigate(`/t/${encodeURIComponent(created)}`);
            });
        }}
      >
        <div className="form-grid">
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              {TASK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {kind === 'single' && (
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
            After task (optional)
            <input className="mono" value={after} onChange={(event) => setAfter(event.target.value)} placeholder="T..." />
          </label>
        </div>
        <label>
          Title
          <input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Text
          <textarea required rows={6} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
          Run visibly (a tmux window you can watch)
        </label>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !title.trim() || !text.trim()}>Create task</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectPage({ name }: { name: string }) {
  const now = useNow(5000);
  const tabsId = useId();
  const [tab, setTab] = useState<'chat' | 'work'>('chat');
  const status = useResource(`status:${name}`, (signal) => getStatus(name, signal));
  const live = coordinatorSession(status.data, name);
  const running = !!live;
  const transcript = useResource(`transcript:${name}:${running ? 'live' : 'ended'}`, (signal) => getTranscript(name, running ? LIVE_LIMIT : ENDED_LIMIT, signal));
  const tasks = useResource(`tasks:${name}`, (signal) => getTasks({ project: name, limit: 300 }, signal));
  const { readonly } = useApp();
  const [creating, setCreating] = useState(false);
  const entries = transcript.data?.entries ?? [];
  const shown = running ? entries : entries.slice(-ENDED_LIMIT);
  const chatEnd = useRef<HTMLDivElement>(null);
  const lastSeq = shown.at(-1)?.seq;
  // The chat follows its end like Jevellan's: on the first load, and afterwards only while the reader is near the end
  // (a reader who scrolled up to read is never pulled down by a new line).
  const pinned = useRef(true);
  useEffect(() => {
    const track = () => {
      pinned.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', track, { passive: true });
    return () => window.removeEventListener('scroll', track);
  }, []);
  useEffect(() => {
    if (lastSeq !== undefined && pinned.current) chatEnd.current?.scrollIntoView({ block: 'end' });
  }, [lastSeq]);
  useEffect(() => {
    document.title = `${name} · Jevellan`;
    return () => {
      document.title = 'Jevellan';
    };
  }, [name]);
  return (
    <div className="pw-page project-page">
      <div className="section-heading pw-heading">
        <h1>{name}</h1>
        <div className="pw-coordinator">
          <span className={`chip pw-chip ${running ? 'pw-chip-running' : 'pw-chip-offline'}`}>
            {running && <span className="activity-spinner" aria-hidden="true" />}
            {running ? 'coordinator running' : 'coordinator not running'}
          </span>
          {transcript.data?.session && <span className="pw-session">session {transcript.data.session}</span>}
        </div>
        {!readonly && (
          <button type="button" className="secondary small pw-new-task" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New task
          </button>
        )}
      </div>
      <ErrorLine text={status.error ?? tasks.error} />
      <div className="pw-tabs" role="tablist" aria-label="Project sections">
        {(['chat', 'work'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${tabsId}-${name}`}
            className="pw-tab"
            aria-selected={tab === name}
            aria-controls={`${tabsId}-${name}-panel`}
            onClick={() => setTab(name)}
          >
            {name === 'chat' ? 'Chat' : 'Work'}
          </button>
        ))}
      </div>
      <div className="pw-layout" data-tab={tab}>
        <div className="pw-chat" id={`${tabsId}-chat-panel`} aria-labelledby={`${tabsId}-chat`}>
          {!transcript.data && transcript.loading ? (
            <Loading text="Loading the conversation..." />
          ) : shown.length ? (
            <div className="timeline pw-timeline" aria-label="Coordinator conversation">
              {!running && <p className="pw-ended-note muted small-text">The last {Math.min(ENDED_LIMIT, shown.length)} lines of the previous session.</p>}
              {shown.map((entry) => (
                <ChatEntry key={entry.seq} entry={entry} />
              ))}
              <div ref={chatEnd} />
            </div>
          ) : (
            <p className="pw-chat-empty">{running ? 'The coordinator has not said anything yet.' : 'No conversation yet. Start the coordinator to talk to it.'}</p>
          )}
          <ErrorLine text={transcript.error} />
          {running ? !readonly && <Composer project={name} /> : <StartBar project={name} />}
        </div>
        <div className="pw-side" id={`${tabsId}-work-panel`} aria-labelledby={`${tabsId}-work`}>
          <Counts project={name} />
          <section className="pw-section" aria-label="Tasks">
            {tasks.data ? <TaskGroups tasks={tasks.data} statuses={status.data?.tasks} now={now} idPrefix={`pw-${name}`} /> : <Loading />}
          </section>
          <Notes project={name} />
          <Workflows project={name} />
        </div>
      </div>
      {creating && <NewTask project={name} close={() => setCreating(false)} />}
    </div>
  );
}
