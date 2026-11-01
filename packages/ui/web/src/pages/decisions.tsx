// /decisions (brief section 7, as the lifted viewer has it): Jev's placement, landing and workflow decisions with
// filters by kind, a date range and the project; each line names the decision, when, what was chosen and by whom,
// the task it was for, Jev's model and latency. GET /api/decisions (the viewer's decisions view, no state_json).

import { useState } from 'react';
import { getDecisions, getProjects, useResource } from '../api.js';
import { ErrorLine, Loading, PageHeading, RouteLink, Stamp } from '../components.js';

export function DecisionsPage() {
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [project, setProject] = useState('');
  const projects = useResource('projects', (signal) => getProjects(signal));
  const filter = { ...(kind ? { kind } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(project ? { project } : {}) };
  const page = useResource(`decisions:${JSON.stringify(filter)}`, (signal) => getDecisions(filter, signal));
  const kinds = page.data?.kinds?.length ? page.data.kinds : ['placement', 'landing', 'workflow'];
  return (
    <div className="list-page decisions-page">
      <PageHeading title="Decisions" intro="What Jev chose for each step, landing and workflow, and who answered." />
      <div className="filter-bar">
        <label className="compact-label">
          <span className="sr-only">Kind</span>
          <select aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-label">
          <span className="sr-only">Project</span>
          <select aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="compact-label date-field">
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="compact-label date-field">
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
      </div>
      <ErrorLine text={page.error} />
      {!page.data && page.loading && <Loading />}
      {page.data && (
        <p className="muted small-text">
          {page.data.shown} of {page.data.total} decisions
        </p>
      )}
      {page.data?.decisions.length === 0 && <p className="empty-inline">No decisions match.</p>}
      <ul className="data-list" aria-label="Decisions">
        {(page.data?.decisions ?? []).map((d) => (
          <li key={d.id} className="data-row decision-row">
            <div className="data-main">
              <div className="data-title">
                <span className="mono row-id">{d.id}</span>
                <span className="chip">{d.kind}</span>
                <span className={`chip source-${d.source}`}>{d.source}</span>
                <span className="decision-summary">{d.summary}</span>
              </div>
              <p className="data-meta">
                <Stamp at={d.createdAt} />
                {d.taskId && (
                  <RouteLink href={`/t/${encodeURIComponent(d.taskId)}`} className="mono">
                    {d.taskId}
                  </RouteLink>
                )}
                {d.sessionId && (
                  <RouteLink href={`/s/${encodeURIComponent(d.sessionId)}`} className="mono">
                    {d.sessionId}
                  </RouteLink>
                )}
                <span>{d.jevModel}</span>
                {d.latencyMs !== null && <span>{d.latencyMs} ms</span>}
                {d.overrideMode && <span>override {d.overrideMode}</span>}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
