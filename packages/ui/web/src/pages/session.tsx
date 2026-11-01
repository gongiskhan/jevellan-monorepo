// /s/:id, a session (brief section 7): its event stream newest last (GET /api/sessions/:id/events, jv_tail, read in
// pages of at most 200 and then only what is new on each store change), tool calls collapsed with their first line
// visible, text as Markdown, usage and rate-limit events as one small line (session-transcript.tsx), a Follow toggle
// that keeps the page scrolled to the end as events arrive, and the session's report at the end.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getEvents, getReport, getTask, onChange, useResource } from '../api.js';
import { ErrorLine, Loading, PageHeading, RouteLink, Switch, useApp } from '../components.js';
import { ReportCard } from '../report.js';
import { Transcript } from '../session-transcript.js';
import type { EventView } from '../types.js';

const PAGE = 200;
const MAX_EVENTS = 5000;

export function SessionPage({ id }: { id: string }) {
  const { readonly } = useApp();
  const [events, setEvents] = useState<EventView[]>();
  const [error, setError] = useState<string>();
  const [follow, setFollow] = useState(true);
  const last = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const fresh: EventView[] = [];
      for (;;) {
        const page = await getEvents(id, { sinceSeq: last.current, limit: PAGE });
        const newer = page.filter((e) => e.seq > last.current);
        fresh.push(...newer);
        if (newer.length) last.current = newer.at(-1)!.seq;
        if (page.length < PAGE || !newer.length || fresh.length >= MAX_EVENTS) break;
      }
      setEvents((current) => [...(current ?? []), ...fresh]);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setEvents((current) => current ?? []);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [id]);
  useEffect(() => {
    void load();
    return onChange(() => void load());
  }, [load]);
  const report = useResource(`report:${id}`, async (signal) => {
    try {
      return await getReport(id, signal);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  });
  const taskId = report.data?.taskId ?? null;
  const task = useResource(taskId ? `task:${taskId}` : null, (signal) => getTask(taskId!, signal));
  const count = events?.length ?? 0;
  useEffect(() => {
    if (follow && count) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [follow, count, report.data]);
  const start = events?.find((e) => e.kind === 'start')?.payload as Record<string, unknown> | undefined;
  return (
    <div className="session-page">
      <PageHeading title={`Session ${id}`}>
        <Switch checked={follow} change={setFollow} label="Follow" />
      </PageHeading>
      <p className="session-facts muted">
        {start && [start.runtime, start.model, start.effort, start.provider && `via ${String(start.provider)}`].filter(Boolean).join(' ')}
        {taskId && (
          <>
            {start ? ' · ' : ''}task <RouteLink href={`/t/${encodeURIComponent(taskId)}`}>{taskId}</RouteLink>
          </>
        )}
      </p>
      <ErrorLine text={error} />
      {!events ? <Loading /> : <Transcript events={events} />}
      {report.data && (
        <ReportCard report={report.data} worktree={task.data?.worktree ?? null} waitingOnOwner={!readonly && task.data?.state === 'waiting-owner'} title="Report" task={task.data} />
      )}
    </div>
  );
}
