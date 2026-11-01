// Shared pieces of the jv pages, ported from gongiskhan/jevellan at 8e2788ec (apps/web/src/components.tsx): Modal
// and Confirm on <dialog>, Markdown (loaded with the app; as a lazy chunk it showed "Rendering..." on every page),
// chips, the in-app link, the copy button, and the page primitives. The app context carries navigation, the read-only
// flag of `jv ui --readonly` (every action control is hidden then) and the toast. Copy is sentence case with no
// exclamation marks; no label names a model (labels come from the data).

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { copyText, selectText } from './clipboard.js';
import { Icon } from './icons.js';
import { fullTime, localTime } from './time.js';
import type { TaskState } from './types.js';

export interface AppContextValue {
  navigate(path: string, replace?: boolean): void;
  readonly: boolean;
  notify(text: string, error?: boolean): void;
  version: string;
}

export const AppContext = createContext<AppContextValue>({
  navigate: () => undefined,
  readonly: true,
  notify: () => undefined,
  version: '',
});
export const useApp = () => useContext(AppContext);

export { default as Markdown } from './markdown.js';

export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close(): void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'wide-dialog' : undefined}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" type="button" onClick={close} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/**
 * A small confirmation. The dialog focuses the action, or Cancel when the action is destructive, so Enter never
 * destroys by accident. `busy` disables the action while its request runs.
 */
export function Confirm({ title, children, action, danger = false, busy = false, error, confirm, close }: {
  title: string;
  children: ReactNode;
  action: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | undefined;
  confirm(): void;
  close(): void;
}) {
  const initial = (element: HTMLButtonElement | null) => element?.setAttribute('autofocus', '');
  return (
    <Modal title={title} close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) confirm();
        }}
      >
        {children}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={close} ref={danger ? initial : undefined}>
            Cancel
          </button>
          <button className={danger ? 'danger' : ''} disabled={busy} ref={danger ? undefined : initial}>
            {action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** An in-app link: a plain click navigates without a reload; modified and middle clicks keep the browser's behaviour. */
export function RouteLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  const { navigate } = useApp();
  return (
    <a
      className={className}
      href={href}
      title={title}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

/** A local HH:MM time (date when not today) with the full time as its title. */
export function Stamp({ at, className }: { at: string | null | undefined; className?: string }) {
  if (!at) return null;
  return (
    <time className={className} dateTime={at} title={fullTime(at)}>
      {localTime(at)}
    </time>
  );
}

export function useNow(interval = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** The copy button of a command line; a refused copy selects the text instead so the owner can copy it by hand. */
export function CopyButton({ text, label = 'Copy', target }: { text: string; label?: string; target?: () => Element | null }) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="icon-button copy-button"
      aria-label={state === 'copied' ? 'Copied' : label}
      title={state === 'copied' ? 'Copied' : state === 'select' ? 'Selected, copy it with the keyboard' : label}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (ok) setState('copied');
          else {
            const element = target?.();
            if (element) selectText(element);
            setState('select');
          }
        })
      }
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
    </button>
  );
}

/** A command shown with its copy button. */
export function CommandLine({ command, note }: { command: string; note?: string | undefined }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="command-line">
      <code ref={ref}>{command}</code>
      <CopyButton text={command} label={`Copy ${command}`} target={() => ref.current} />
      {note && <span className="command-note">{note}</span>}
    </div>
  );
}

export function PageHeading({ title, children, intro }: { title: string; children?: ReactNode; intro?: ReactNode }) {
  return (
    <>
      <div className="section-heading">
        <h1>{title}</h1>
        {children && <div className="actions heading-actions">{children}</div>}
      </div>
      {intro && <p className="intro">{intro}</p>}
    </>
  );
}

export function Loading({ text = 'Loading...' }: { text?: string }) {
  return (
    <p className="page-loading" role="status">
      <span className="activity-spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

export function ErrorLine({ text }: { text: string | undefined }) {
  return text ? (
    <p className="error" role="alert">
      {text}
    </p>
  ) : null;
}

const STATE_LABELS: Record<string, string> = {
  'waiting-owner': 'waiting on you',
  running: 'running',
  queued: 'queued',
  landing: 'landing',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** The tone of a task, step or session state, for chips and dots. */
export function stateTone(state: string): string {
  switch (state) {
    case 'waiting-owner':
    case 'needs-decision':
    case 'asked':
      return 'waiting';
    case 'running':
    case 'starting':
    case 'retrying':
    case 'checking':
      return 'running';
    case 'landing':
      return 'landing';
    case 'done':
    case 'landed':
      return 'done';
    case 'failed':
    case 'lost':
      return 'failed';
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'queued';
    default:
      return 'muted';
  }
}

export function StateChip({ state, label }: { state: TaskState | string; label?: string }) {
  return <span className={`chip state-chip tone-${stateTone(state)}`}>{label ?? STATE_LABELS[state] ?? state}</span>;
}

export function StateDot({ state, lost = false }: { state: string; lost?: boolean }) {
  return <i className={`jv-dot tone-${lost ? 'lost' : stateTone(state)}`} aria-hidden="true" />;
}

/** The origin chip of a task: owner, coordinator, ui, mcp, schedule, planner or improver (the full origin as title). */
export function OriginChip({ origin }: { origin: string }) {
  const kind = origin.split(':')[0] || 'owner';
  return (
    <span className={`chip origin-chip origin-${kind}`} title={`origin ${origin}`}>
      {kind}
    </span>
  );
}

/** A labelled value of a facts list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? '-'}</dd>
    </>
  );
}

/** A toggle switch (role switch) with its label. */
export function Switch({ checked, change, label }: { checked: boolean; change(value: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => change(!checked)}>
      <span className="switch-track" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** Lines of text with ids first, cut at 100 characters with the rest in the title (brief section 4 text rule). */
export function cutText(text: string, max = 100): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : text;
}
