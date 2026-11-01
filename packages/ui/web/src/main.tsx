// The jv web app's shell (brief section 7), ported from gongiskhan/jevellan at 8e2788ec (apps/web/src/main.tsx): the
// sign-in screen, the header, the collapsible sidebar (localStorage `jv.sidebar.collapsed`; collapsed, the
// .app-shell.sidebar-collapsed rule hides it with visibility: hidden and width 0, never display: none, so its
// controls keep their state), the light, system and dark theme switch (`jv.theme`), the toast and the client-side
// routes: / Projects, /p/:name, /t/:id, /s/:id, /decisions, /usage, /memory, /schedules, /goals, /jobs, /bot, /doctor
// and /login. Every page reads the UI server's JSON routes through api.ts and refetches on the live stream's change
// events. In read-only mode (`jv ui --readonly`) no action control is shown.

import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, getProjects, getSession, getStatus, login, logout, onUnauthorized, startLive, stopLive, useResource } from './api.js';
import { AppContext, type AppContextValue } from './components.js';
import { BrandFlag, Icon, type IconName } from './icons.js';
import { BotPage } from './pages/bot.js';
import { DecisionsPage } from './pages/decisions.js';
import { DoctorPage } from './pages/doctor.js';
import { GoalsPage } from './pages/goals.js';
import { JobsPage } from './pages/jobs.js';
import { MemoryPage } from './pages/memory.js';
import { ProjectsPage } from './pages/projects.js';
import { SchedulesPage } from './pages/schedules.js';
import { SessionPage } from './pages/session.js';
import { TaskPage } from './pages/task.js';
import { UsagePage } from './pages/usage.js';
import { ProjectPage } from './project-work.js';
import type { UiSession } from './types.js';
import './style.css';
import './project-work.css';
import './jv.css';

const SIDEBAR_KEY = 'jv.sidebar.collapsed';
const THEME_KEY = 'jv.theme';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A per-browser convenience only.
  }
}

export type Route =
  | { page: 'login' }
  | { page: 'projects' }
  | { page: 'project'; name: string }
  | { page: 'task'; id: string }
  | { page: 'session'; id: string }
  | { page: 'decisions' | 'usage' | 'memory' | 'schedules' | 'goals' | 'jobs' | 'bot' | 'doctor' }
  | { page: 'missing'; path: string };

export function route(path: string): Route {
  const pathname = path.split('?')[0]!.replace(/\/+$/, '') || '/';
  if (pathname === '/') return { page: 'projects' };
  if (pathname === '/login') return { page: 'login' };
  const match = /^\/(p|t|s)\/([^/]+)$/.exec(pathname);
  if (match) {
    const value = decodeURIComponent(match[2]!);
    return match[1] === 'p' ? { page: 'project', name: value } : match[1] === 't' ? { page: 'task', id: value } : { page: 'session', id: value };
  }
  const simple = pathname.slice(1);
  if (['decisions', 'usage', 'memory', 'schedules', 'goals', 'jobs', 'bot', 'doctor'].includes(simple)) return { page: simple as 'memory' };
  return { page: 'missing', path: pathname };
}

const NAV: ReadonlyArray<{ path: string; label: string; icon: IconName }> = [
  { path: '/', label: 'Projects', icon: 'projects' },
  { path: '/memory', label: 'Memory', icon: 'memory' },
  { path: '/schedules', label: 'Schedules', icon: 'schedule' },
  { path: '/goals', label: 'Goals', icon: 'goal' },
  { path: '/jobs', label: 'Jobs', icon: 'job' },
  { path: '/decisions', label: 'Decisions', icon: 'decisions' },
  { path: '/usage', label: 'Usage', icon: 'usage' },
  { path: '/bot', label: 'Bot', icon: 'bot' },
  { path: '/doctor', label: 'Doctor', icon: 'doctor' },
];

function pageTitle(r: Route): ReactNode {
  switch (r.page) {
    case 'projects':
      return 'Projects';
    case 'project':
      return (
        <>
          Projects · <b>{r.name}</b>
        </>
      );
    case 'task':
      return (
        <>
          Task · <b>{r.id}</b>
        </>
      );
    case 'session':
      return (
        <>
          Session · <b>{r.id}</b>
        </>
      );
    case 'missing':
      return 'Not found';
    case 'login':
      return '';
    default:
      return NAV.find((n) => n.path === `/${r.page}`)?.label ?? '';
  }
}

function SignIn({ done }: { done(): void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">
          <BrandFlag />
          Jevellan
        </h1>
        <p>Sign in with the password in ~/.jv/ui-password.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            login(password)
              .then(() => done())
              .catch((failure: unknown) => {
                if (failure instanceof ApiError && failure.status === 401) setError('Wrong password.');
                else if (failure instanceof ApiError && failure.status === 429) setError('Too many attempts. Wait a minute and try again.');
                else setError(failure instanceof Error ? failure.message : 'Sign-in failed.');
              })
              .finally(() => {
                setBusy(false);
                setPassword('');
              });
          }}
        >
          <label>
            Password
            <input autoFocus type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && (
            <p className="error auth-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      </div>
      <p className="auth-footer">Autonomous development, coordinated.</p>
    </main>
  );
}

function Toast({ notice, dismiss }: { notice: { text: string; error: boolean }; dismiss(): void }) {
  return (
    <div className={`toast ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button className="icon-button" aria-label="Dismiss message" onClick={dismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

function SidebarProjects({ path, navigate }: { path: string; navigate(path: string): void }) {
  const projects = useResource('sidebar:projects', (signal) => getProjects(signal));
  const status = useResource('sidebar:status', (signal) => getStatus(undefined, signal));
  const current = route(path);
  const rows = projects.data ?? [];
  return (
    <nav className="pw-sidebar" aria-label="Projects list">
      <p className="pw-sidebar-toggle sidebar-section-label">Projects</p>
      <div className="pw-sidebar-list">
        {projects.data && rows.length === 0 && <p className="pw-sidebar-empty">No projects yet.</p>}
        {rows.map((project) => {
          const tasks = (status.data?.tasks ?? []).filter((t) => t.project === project.name);
          const waiting = tasks.filter((t) => t.state === 'waiting-owner').length;
          const running = tasks.filter((t) => t.state === 'running' || t.state === 'landing').length;
          const lost = tasks.some((t) => t.lost);
          const selected = current.page === 'project' && current.name === project.name;
          const dot = lost ? 'pw-failed' : waiting ? 'pw-waiting-for-you' : running ? 'pw-running' : 'pw-idle';
          return (
            <button
              key={project.id}
              type="button"
              className={`pw-sidebar-row ${selected ? 'selected' : ''}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => navigate(`/p/${encodeURIComponent(project.name)}`)}
            >
              <i className={`pw-dot ${dot}`} aria-hidden="true" />
              <span className="pw-sidebar-name" title={project.path}>
                {project.name}
              </span>
              {(running > 0 || waiting > 0) && (
                <span className="pw-sidebar-counts">
                  {running > 0 && <span className="pw-sidebar-running">{running} running</span>}
                  {waiting > 0 && (
                    <span className="suggestion-count" title={`${waiting} waiting on you`}>
                      {waiting}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function App() {
  const [session, setSession] = useState<UiSession | undefined>();
  const [failure, setFailure] = useState<string>();
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  const [sidebar, setSidebar] = useState(false);
  const [collapsed, setCollapsedState] = useState(() => stored(SIDEBAR_KEY) === '1');
  const [theme, setTheme] = useState(() => stored(THEME_KEY) ?? 'system');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const setCollapsed = (value: boolean) => {
    setCollapsedState(value);
    store(SIDEBAR_KEY, value ? '1' : '0');
  };
  const narrow = () => window.matchMedia('(max-width: 760px)').matches;
  const toggleNavigation = () => {
    if (collapsed && !narrow()) setCollapsed(false);
    else setSidebar(!sidebar);
  };

  const navigate = useCallback((next: string, replace = false) => {
    if (replace) history.replaceState({}, '', next);
    else history.pushState({}, '', next);
    setPath(next);
    setSidebar(false);
    window.scrollTo({ top: 0 });
  }, []);

  const loadSession = useCallback(() => {
    getSession()
      .then((value) => {
        setSession(value);
        setFailure(undefined);
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => loadSession(), [loadSession]);
  useEffect(() => {
    const changed = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store(THEME_KEY, theme);
  }, [theme]);
  useEffect(
    () =>
      onUnauthorized(() => {
        stopLive();
        setSession((current) => (current ? { ...current, authenticated: false } : current));
      }),
    [],
  );
  useEffect(() => {
    if (!session?.authenticated) return;
    startLive();
    return () => stopLive();
  }, [session?.authenticated]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice((current) => (current === notice ? undefined : current)), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const current = route(path);
  // Signed in on /login goes home; signed out anywhere shows the sign-in screen at /login, keeping where to return.
  useEffect(() => {
    if (!session) return;
    if (session.authenticated && current.page === 'login') {
      const next = new URLSearchParams(window.location.search).get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', true);
    } else if (!session.authenticated && current.page !== 'login') {
      navigate(`/login?next=${encodeURIComponent(path)}`, true);
    }
  }, [session, current.page, navigate, path]);

  const context = useMemo<AppContextValue>(
    () => ({ navigate, readonly: session?.readonly ?? true, notify: (text, error = false) => setNotice({ text, error }), version: session?.version ?? '' }),
    [navigate, session?.readonly, session?.version],
  );

  if (!session) {
    return (
      <main className="loading">
        <span className="wordmark">
          <BrandFlag />
          Jevellan
        </span>
        <p>{failure ? `The UI server did not answer: ${failure}` : 'Connecting...'}</p>
        {failure && (
          <button className="secondary" onClick={loadSession}>
            Try again
          </button>
        )}
      </main>
    );
  }
  if (!session.authenticated || current.page === 'login') {
    return <SignIn done={() => loadSession()} />;
  }

  const page =
    current.page === 'projects' ? (
      <ProjectsPage />
    ) : current.page === 'project' ? (
      <ProjectPage key={current.name} name={current.name} />
    ) : current.page === 'task' ? (
      <TaskPage key={current.id} id={current.id} />
    ) : current.page === 'session' ? (
      <SessionPage key={current.id} id={current.id} />
    ) : current.page === 'decisions' ? (
      <DecisionsPage />
    ) : current.page === 'usage' ? (
      <UsagePage />
    ) : current.page === 'memory' ? (
      <MemoryPage key={path} />
    ) : current.page === 'schedules' ? (
      <SchedulesPage />
    ) : current.page === 'goals' ? (
      <GoalsPage />
    ) : current.page === 'jobs' ? (
      <JobsPage />
    ) : current.page === 'bot' ? (
      <BotPage />
    ) : current.page === 'doctor' ? (
      <DoctorPage />
    ) : (
      <div className="empty-page">
        <h1>Not found</h1>
        <p className="muted">Nothing lives at {current.page === 'missing' ? current.path : path}.</p>
        <button className="secondary" onClick={() => navigate('/')}>
          Back to projects
        </button>
      </div>
    );
  const selectedNav = current.page === 'projects' || current.page === 'project' ? '/' : `/${current.page}`;
  return (
    <AppContext.Provider value={context}>
      <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} page-${current.page}`}>
        {sidebar && <div className="sidebar-backdrop" aria-hidden="true" onClick={() => setSidebar(false)} />}
        <aside className={`sidebar ${sidebar ? 'open' : ''}`} aria-label="Navigation">
          <div className="sidebar-top">
            <button className="wordmark" onClick={() => navigate('/')}>
              <BrandFlag />
              Jevellan
            </button>
            <button className="icon-button sidebar-collapse" aria-label="Collapse navigation" title="Collapse navigation" onClick={() => setCollapsed(true)}>
              <Icon name="back" />
            </button>
            <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebar(false)}>
              <Icon name="close" />
            </button>
          </div>
          <nav className="sidebar-nav" aria-label="Pages">
            {NAV.map((item) => (
              <a
                key={item.path}
                href={item.path}
                className={`settings-link ${selectedNav === item.path ? 'selected' : ''}`}
                aria-current={selectedNav === item.path ? 'page' : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  navigate(item.path);
                }}
              >
                <Icon name={item.icon} />
                {item.label}
              </a>
            ))}
          </nav>
          <SidebarProjects path={path} navigate={navigate} />
          <div className="sidebar-footer">
            <button
              className="settings-link"
              onClick={() =>
                void logout()
                  .catch(() => undefined)
                  .finally(() => {
                    stopLive();
                    setSession({ ...session, authenticated: false });
                  })
              }
            >
              <Icon name="external" />
              Sign out
            </button>
            <div className="sidebar-footer-row">
              <small>{session.version ? `v${session.version}` : ''}</small>
              <div className="theme-switch" role="group" aria-label="Theme">
                {(
                  [
                    ['light', 'sun', 'Light theme'],
                    ['system', 'system', 'System theme'],
                    ['dark', 'moon', 'Dark theme'],
                  ] as const
                ).map(([value, icon, label]) => (
                  <button key={value} aria-label={label} title={label} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                    <Icon name={icon} size={14} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
        <div className="workspace">
          <header className="app-header">
            <div>
              <button className="menu-button icon-button" aria-label="Open navigation" aria-expanded={sidebar} onClick={toggleNavigation}>
                <Icon name="menu" />
              </button>
              <span className="breadcrumb">{pageTitle(current)}</span>
            </div>
            {session.readonly && <span className="chip readonly-chip">read-only</span>}
          </header>
          <main className="page-content">{page}</main>
        </div>
        {notice && <Toast notice={notice} dismiss={() => setNotice(undefined)} />}
      </div>
    </AppContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
