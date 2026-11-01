// /memory (brief section 7, jevellan-memory section 6): a search box (FTS through GET /api/memory?query=, jv memory
// search), scope and kind filters, the list (id, kind, text, tags, uses, source, age), Add (scope, kind, tags, text;
// POST /api/memory, source owner) and Archive with a reason (POST /api/memory/:id/archive; nothing is ever deleted),
// and a toggle that shows the archived ones (status archived). /memory?project=N opens with that project's scope.

import { useState } from 'react';
import { addMemory, archiveMemory, getMemories, getProjects, useAction, useResource } from '../api.js';
import { ErrorLine, Loading, Modal, PageHeading, Switch, useApp, useNow } from '../components.js';
import { Icon } from '../icons.js';
import { shortTime } from '../time.js';
import { MEMORY_KINDS, type Memory } from '../types.js';

function AddMemory({ projects, initialProject, close }: { projects: string[]; initialProject: string; close(): void }) {
  const [scope, setScope] = useState<'global' | 'project'>(initialProject ? 'project' : 'global');
  const [project, setProject] = useState(initialProject || projects[0] || '');
  const [kind, setKind] = useState<string>('fact');
  const [tags, setTags] = useState('');
  const [text, setText] = useState('');
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title="Add a memory" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const tagList = tags
            .split(/[\s,]+/)
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8);
          void action
            .run(() => addMemory({ kind, text: text.trim(), scope, ...(tagList.length ? { tags: tagList } : {}), ...(scope === 'project' ? { project } : {}) }))
            .then((ok) => {
              if (ok) {
                notify('Remembered.');
                close();
              }
            });
        }}
      >
        <div className="form-grid">
          <label>
            Scope
            <select value={scope} onChange={(event) => setScope(event.target.value as 'global' | 'project')}>
              <option value="global">Global</option>
              <option value="project" disabled={!projects.length}>
                Project
              </option>
            </select>
          </label>
          {scope === 'project' && (
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
          )}
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tags
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="tests, setup" />
          </label>
        </div>
        <label>
          Text
          <textarea required maxLength={2000} rows={4} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button disabled={action.busy || !text.trim()}>Remember</button>
        </div>
      </form>
    </Modal>
  );
}

function ArchiveMemory({ memory, close }: { memory: Memory; close(): void }) {
  const [reason, setReason] = useState('');
  const action = useAction();
  const { notify } = useApp();
  return (
    <Modal title={`Archive ${memory.id}`} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => archiveMemory(memory.id, reason.trim())).then((ok) => {
            if (ok) {
              notify(`Archived ${memory.id}.`);
              close();
            }
          });
        }}
      >
        <p className="quoted">{memory.text}</p>
        <label>
          Reason
          <input autoFocus required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why it no longer holds" />
        </label>
        <p className="muted small-text">Archived memories are kept and listed under Show archived; nothing is deleted.</p>
        <ErrorLine text={action.error} />
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="danger" disabled={action.busy || !reason.trim()}>
            Archive
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MemoryPage() {
  const params = new URLSearchParams(window.location.search);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [scope, setScope] = useState(params.get('project') ? `project:${params.get('project')}` : 'all');
  const [kind, setKind] = useState('');
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [archiving, setArchiving] = useState<Memory>();
  const now = useNow(60_000);
  const { readonly } = useApp();
  const projects = useResource('projects', (signal) => getProjects(signal));
  const project = scope.startsWith('project:') ? scope.slice('project:'.length) : undefined;
  const key = JSON.stringify({ submitted, project, kind, archived });
  const memories = useResource(`memories:${key}`, (signal) =>
    getMemories({ ...(submitted ? { query: submitted } : {}), ...(project ? { project } : {}), ...(kind ? { kind } : {}), status: archived ? 'archived' : 'active', limit: 200 }, signal),
  );
  const rows = (memories.data ?? []).filter(
    (m) => (scope !== 'global' || m.scope === 'global') && (!kind || m.kind === kind) && (submitted ? true : archived ? m.status === 'archived' : m.status !== 'archived'),
  );
  return (
    <div className="list-page memory-page">
      <PageHeading title="Memory" intro="What every agent remembers between sessions: facts, preferences, lessons, environment details and decisions.">
        {!readonly && (
          <button type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} />
            Add
          </button>
        )}
      </PageHeading>
      <form
        className="filter-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query.trim());
        }}
      >
        <label className="search-field">
          <span className="sr-only">Search memories</span>
          <Icon name="search" size={15} />
          <input type="search" value={query} placeholder="Search memories" onChange={(event) => {
            setQuery(event.target.value);
            if (!event.target.value) setSubmitted('');
          }} />
        </label>
        <label className="compact-label">
          <span className="sr-only">Scope</span>
          <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Scope">
            <option value="all">All scopes</option>
            <option value="global">Global</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={`project:${p.name}`}>
                Project {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-label">
          <span className="sr-only">Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind">
            <option value="">All kinds</option>
            {MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <Switch checked={archived} change={setArchived} label="Show archived" />
      </form>
      <ErrorLine text={memories.error} />
      {!memories.data && memories.loading && <Loading />}
      {memories.data && rows.length === 0 && <p className="empty-inline">{submitted ? 'Nothing remembered matches.' : archived ? 'No archived memories.' : 'Nothing remembered yet.'}</p>}
      <ul className="data-list" aria-label="Memories">
        {rows.map((m) => (
          <li key={m.id} className={`data-row memory-row ${m.status === 'archived' ? 'archived' : ''}`}>
            <div className="data-main">
              <div className="data-title">
                <span className="mono row-id">{m.id}</span>
                <span className={`chip kind-${m.kind}`}>{m.kind}</span>
                <span className="chip dim">{m.scope}</span>
                {m.status === 'archived' && <span className="chip">archived</span>}
              </div>
              <p className="data-text">{m.text}</p>
              <p className="data-meta">
                {m.tags.length > 0 && <span className="tags">{m.tags.map((t) => `#${t}`).join(' ')}</span>}
                <span>{m.uses} uses</span>
                <span>{m.source}</span>
                <span title={m.created_at}>{shortTime(m.created_at, now)}</span>
              </p>
            </div>
            {!readonly && m.status !== 'archived' && (
              <button type="button" className="secondary small" onClick={() => setArchiving(m)}>
                Archive
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && <AddMemory projects={(projects.data ?? []).map((p) => p.name)} initialProject={project ?? ''} close={() => setAdding(false)} />}
      {archiving && <ArchiveMemory memory={archiving} close={() => setArchiving(undefined)} />}
    </div>
  );
}
