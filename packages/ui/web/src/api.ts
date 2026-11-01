// Typed fetch helpers for the UI route contract (brief section 7) and the live stream that keeps every page current.
//
// Every route answers JSON; an error is {error, exitCode} with HTTP 400 (exit 2, refused), 404 (3, not found), 409
// (4, conflict) or 500, and every /api route but /api/login and /api/session answers 401 {error: 'Sign in.'} without
// the session cookie. `ApiError` carries the status and the exit code; a 401 anywhere sends the app back to /login.
// GET /api/events is Server-Sent Events: a `change` event whenever the store moved (the server checks PRAGMA
// data_version every second) and `heartbeat` every 15 s. One EventSource serves the whole app; `useResource` refetches
// what a page shows on every change, keeping the last answer on screen while it reloads, so a page never blinks and a
// form's draft is never reset by a refetch (drafts live in component state, never in fetched data).

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotPage,
  ProvidersMenu,
  CoordinatorStatus,
  CoordinatorTranscript,
  DecisionsPage,
  DoctorResult,
  EventView,
  GoalView,
  JobView,
  Memory,
  NotesView,
  ProjectRow,
  ReportView,
  ScheduleView,
  StatusView,
  TaskChanges,
  TaskSummary,
  TaskView,
  UiAction,
  UiSession,
  UsageWeek,
  WorkflowFile,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly exitCode: number | undefined;
  constructor(message: string, status: number, exitCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.exitCode = exitCode;
  }
}

export const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

type Listener = () => void;
const unauthorized = new Set<Listener>();
/** Called when any request answers 401: the app shows the sign-in page. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorized.add(listener);
  return () => unauthorized.delete(listener);
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (signal) init.signal = signal;
  if (method === 'POST') {
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let value: unknown = undefined;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
  }
  if (!response.ok) {
    const record = (value && typeof value === 'object' ? value : {}) as { error?: unknown; exitCode?: unknown };
    const message = typeof record.error === 'string' && record.error ? record.error : `${method} ${path} failed (${response.status}).`;
    if (response.status === 401 && path !== '/api/login') for (const listener of unauthorized) listener();
    throw new ApiError(message, response.status, typeof record.exitCode === 'number' ? record.exitCode : undefined);
  }
  return value as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal);
export const post = <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, signal);

const enc = encodeURIComponent;

/** A list that the contract may give bare or wrapped in an object under `key`. */
function listOf<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

// ---- session ------------------------------------------------------------------------------------------------------

export const getSession = (signal?: AbortSignal) => get<UiSession>('/api/session', signal);
export const login = (password: string) => post<{ ok: true }>('/api/login', { password });
export const logout = () => post<{ ok: true }>('/api/logout');

// ---- status and projects ------------------------------------------------------------------------------------------

export const getStatus = (project?: string, signal?: AbortSignal) => get<StatusView>(`/api/status${query({ project })}`, signal);
export const getProjects = async (signal?: AbortSignal) => listOf<ProjectRow>(await get<unknown>('/api/projects', signal), 'projects');
export const addProject = (path: string, name?: string) => post<unknown>('/api/projects', { path, ...(name ? { name } : {}) });

// ---- tasks --------------------------------------------------------------------------------------------------------

export const getTasks = async (params: { project?: string; state?: string; limit?: number }, signal?: AbortSignal) =>
  listOf<TaskSummary>(await get<unknown>(`/api/tasks${query(params)}`, signal), 'tasks');
export const getTask = (id: string, signal?: AbortSignal) => get<TaskView>(`/api/tasks/${enc(id)}`, signal);
export interface CreateTaskBody {
  project: string;
  kind: string;
  duty?: string;
  title: string;
  text: string;
  parent?: string;
  after?: string;
  visible?: boolean;
}
export const createTask = (body: CreateTaskBody) => post<{ task?: { id: string } }>('/api/tasks', body);
export const messageTask = (id: string, text: string) => post<unknown>(`/api/tasks/${enc(id)}/message`, { text });
export const answerTask = (id: string, answer: string) => post<unknown>(`/api/tasks/${enc(id)}/answer`, { answer });
export const stopTask = (id: string, discard: boolean) => post<unknown>(`/api/tasks/${enc(id)}/stop`, discard ? { discard: true } : {});
export const resumeTask = (id: string) => post<unknown>(`/api/tasks/${enc(id)}/resume`, {});
export interface OverrideBody {
  model: string;
  effort?: string;
  provider?: string;
  mode: 'undo' | 'keep';
}
export const overrideTask = (id: string, body: OverrideBody) => post<unknown>(`/api/tasks/${enc(id)}/override`, body);
export const getChanges = (id: string, stat = false, signal?: AbortSignal) => get<TaskChanges>(`/api/tasks/${enc(id)}/changes${query({ stat: stat || undefined })}`, signal);
export const landTask = (id: string, force = false) => post<unknown>(`/api/tasks/${enc(id)}/land`, force ? { force: true } : {});
export const postUiAction = (id: string, action: UiAction) => post<{ kind: 'answer' | 'message'; message: { id: string } }>(`/api/tasks/${enc(id)}/ui-action`, { action });

// ---- sessions -----------------------------------------------------------------------------------------------------

export const getReport = (session: string, signal?: AbortSignal) => get<ReportView>(`/api/sessions/${enc(session)}/report`, signal);
export const getEvents = async (session: string, params: { sinceSeq?: number; limit?: number }, signal?: AbortSignal) =>
  listOf<EventView>(await get<unknown>(`/api/sessions/${enc(session)}/events${query(params)}`, signal), 'events');

// ---- coordinator, notes, workflows ------------------------------------------------------------------------------------

export const getCoordinator = (project: string, signal?: AbortSignal) => get<CoordinatorStatus>(`/api/projects/${enc(project)}/coordinator`, signal);
export const startCoordinator = (project: string) => post<unknown>(`/api/projects/${enc(project)}/coordinator/start`, {});
export const messageCoordinator = (project: string, text: string) => post<unknown>(`/api/projects/${enc(project)}/coordinator/message`, { text });
export const getTranscript = (project: string, limit: number, signal?: AbortSignal) =>
  get<CoordinatorTranscript>(`/api/projects/${enc(project)}/coordinator/transcript${query({ limit })}`, signal);
export const getNotes = (project: string, signal?: AbortSignal) => get<NotesView>(`/api/projects/${enc(project)}/notes`, signal);
export const saveNotes = (project: string, text: string) => post<unknown>(`/api/projects/${enc(project)}/notes`, { text });
export const getWorkflows = async (project: string, signal?: AbortSignal) =>
  listOf<WorkflowFile>(await get<unknown>(`/api/projects/${enc(project)}/workflows`, signal), 'workflows');

// ---- memory -------------------------------------------------------------------------------------------------------

export const getMemories = async (params: { query?: string; project?: string; kind?: string; status?: string; limit?: number }, signal?: AbortSignal) =>
  listOf<Memory>(await get<unknown>(`/api/memory${query(params)}`, signal), 'memories');
export interface AddMemoryBody {
  kind: string;
  text: string;
  tags?: string[];
  scope: 'global' | 'project';
  project?: string;
}
export const addMemory = (body: AddMemoryBody) => post<unknown>('/api/memory', body);
export const archiveMemory = (id: string, reason: string) => post<unknown>(`/api/memory/${enc(id)}/archive`, { reason });

// ---- schedules, goals, jobs -------------------------------------------------------------------------------------------

export const getSchedules = async (project?: string, signal?: AbortSignal) => listOf<ScheduleView>(await get<unknown>(`/api/schedules${query({ project })}`, signal), 'schedules');
export interface AddScheduleBody {
  project: string;
  name: string;
  cron: string;
  tz?: string;
  kind: 'task' | 'job';
  task?: { kind: string; duty?: string; title: string; text: string; visible?: boolean };
  job?: string;
}
export const addSchedule = (body: AddScheduleBody) => post<unknown>('/api/schedules', body);
export const previewSchedule = (cron: string, tz?: string, signal?: AbortSignal) => get<{ nextRuns: string[] }>(`/api/schedules/preview${query({ cron, tz })}`, signal);
export const scheduleAction = (id: string, action: 'run' | 'pause' | 'resume') => post<unknown>(`/api/schedules/${enc(id)}/${action}`, {});

export const getGoals = async (project?: string, signal?: AbortSignal) => listOf<GoalView>(await get<unknown>(`/api/goals${query({ project })}`, signal), 'goals');
export const addGoal = (body: { project: string; title: string; text: string; priority?: number }) => post<unknown>('/api/goals', body);
export const goalAction = (id: string, action: 'done' | 'pause') => post<unknown>(`/api/goals/${enc(id)}/${action}`, {});

export const getJobs = async (project?: string, signal?: AbortSignal) => listOf<JobView>(await get<unknown>(`/api/jobs${query({ project })}`, signal), 'jobs');
export const runJob = (project: string, kind: string, force = false) => post<{ job?: JobView; created?: boolean }>('/api/jobs', { project, kind, ...(force ? { force: true } : {}) });

// ---- usage, decisions, doctor, bot ------------------------------------------------------------------------------------

export const getUsage = (week?: string, signal?: AbortSignal) => get<UsageWeek>(`/api/usage${query({ week })}`, signal);
export const getDecisions = (params: { kind?: string; from?: string; to?: string; project?: string }, signal?: AbortSignal) =>
  get<DecisionsPage>(`/api/decisions${query(params)}`, signal);
export const getDoctor = (signal?: AbortSignal) => get<DoctorResult>('/api/doctor', signal);
export const getBot = (signal?: AbortSignal) => get<BotPage>('/api/bot', signal);
export const getProviders = (signal?: AbortSignal) => get<ProvidersMenu>('/api/providers', signal);

// ---- the live stream ----------------------------------------------------------------------------------------------

const changeListeners = new Set<Listener>();
let source: EventSource | undefined;
let connected = false;
const connectionListeners = new Set<Listener>();

/** Opens the app's one EventSource on /api/events (after sign-in); every `change` notifies the subscribers. */
export function startLive(): () => void {
  if (source) return stopLive;
  source = new EventSource('/api/events');
  source.addEventListener('change', () => {
    for (const listener of changeListeners) listener();
  });
  source.addEventListener('open', () => {
    connected = true;
    for (const listener of connectionListeners) listener();
  });
  source.addEventListener('error', () => {
    connected = false;
    for (const listener of connectionListeners) listener();
  });
  return stopLive;
}

export function stopLive(): void {
  source?.close();
  source = undefined;
  connected = false;
}

export function onChange(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function liveConnected(): boolean {
  return connected;
}

export function onConnection(listener: Listener): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload(): void;
}

/**
 * Fetches `load` now, on every store change and when `key` changes. The last answer stays while a reload runs; a
 * change during a fetch queues one more fetch after it, never a parallel one. `key` null fetches nothing.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, options: { live?: boolean } = {}): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(key !== null);
  const loader = useRef(load);
  loader.current = load;
  const state = useRef<{ running: boolean; again: boolean; controller?: AbortController; key: string | null }>({ running: false, again: false, key });
  const fetchNow = useCallback(() => {
    const s = state.current;
    if (s.key === null) return;
    if (s.running) {
      s.again = true;
      return;
    }
    s.running = true;
    const controller = new AbortController();
    s.controller = controller;
    const forKey = s.key;
    loader
      .current(controller.signal)
      .then((value) => {
        if (state.current.key !== forKey) return;
        setData(value);
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (isAbort(failure) || state.current.key !== forKey) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (state.current.key !== forKey) return;
        s.running = false;
        setLoading(false);
        if (s.again) {
          s.again = false;
          fetchNow();
        }
      });
  }, []);
  useEffect(() => {
    state.current.controller?.abort();
    state.current = { running: false, again: false, key };
    setData(undefined);
    setError(undefined);
    setLoading(key !== null);
    fetchNow();
    if (key === null || options.live === false) return;
    return onChange(fetchNow);
  }, [key, fetchNow, options.live]);
  useEffect(() => () => state.current.controller?.abort(), []);
  return { data, error, loading, reload: fetchNow };
}

/** Runs one action at a time; `error` holds the last failure's message until the next run. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
