// The A2UI surface of a report (brief section 7, "From the step"): the report's `ui` messages fed to a
// MessageProcessor of @a2ui/web_core 0.14.0 created with the v0.9 basic catalog, its surfaces rendered with
// A2uiSurface of @a2ui/react 0.14.0. Messages are passed as they are, one at a time, so one the renderer refuses never
// hides the others; a refused message whose version is not "v0.9" shows "UI not rendered: unsupported version" (with
// 0.14.0 that is every `version: "1.0"` message: the processor reads them as v1.0 and its schema wants the literal
// "v1.0"), any other refusal shows "UI not rendered: <reason>". The rest of the report renders normally either way.
//
// The processor is made once per report (keyed by the report id and its messages), never per render: the page
// refetches on every store change, and a new processor would drop what the owner picked or typed. Inputs keep their
// values in the processor's data model until a Button's action sends them inside `context` (bindings resolved by the
// renderer). The action (name, surfaceId, sourceComponentId, timestamp, userMessage, context) is posted as {action}
// to POST /api/tasks/:id/ui-action; afterwards the surface is dimmed with "Sent to the step at HH:MM". The page knows
// a surface was sent from the store as well (`sentAt`, the time of the message whose meta is its action), so it stays
// dimmed after a reload and on another device, showing the values that action sent (restoreSent). A surface of a
// done or stopped task (`closed`) is inert, as in read-only mode: core takes neither an answer nor a message there.
//
// Styling: the v0.9 basic catalog renders custom elements in light DOM and adopts each element's styles into the
// document as constructable stylesheets with selectors scoped to its tag (no inline <style>, so the server's CSP
// holds); a2ui-theme.css maps the renderer's --a2ui-* properties and class names onto the app's tokens. 0.14.0 ships no
// structural.css: the package export `@a2ui/react/styles/structural.css` names a file the package does not contain,
// and its `styles` entry is the v0.8 renderer's (`.a2ui-surface` rules the v0.9 surface never renders), so none is
// imported.

import { A2uiSurface } from '@a2ui/react/v0_9';
import { MessageProcessor, type SurfaceModel } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { postUiAction } from './api.js';
import { localTime } from './time.js';
import type { UiAction } from './types.js';
import './a2ui-theme.css';

export const SUPPORTED_VERSION = 'v0.9';
export const UNSUPPORTED_TEXT = 'UI not rendered: unsupported version';

interface Built {
  processor: MessageProcessor;
  problems: string[];
}

function versionOf(message: unknown): string {
  return message && typeof message === 'object' && typeof (message as { version?: unknown }).version === 'string' ? (message as { version: string }).version : '';
}

/** Feeds the messages one by one; returns the processor and the notices for the ones it refused. */
export function buildSurfaces(messages: readonly unknown[], onAction: (action: UiAction) => void): Built {
  const processor = new MessageProcessor([basicCatalog], (action) => onAction(action as UiAction));
  const problems = new Set<string>();
  for (const message of messages) {
    try {
      processor.processMessages(message as Parameters<MessageProcessor['processMessages']>[0]);
    } catch (error) {
      if (versionOf(message) !== SUPPORTED_VERSION) problems.add(UNSUPPORTED_TEXT);
      else problems.add(`UI not rendered: ${error instanceof Error ? error.message.split('\n')[0]!.slice(0, 200) : String(error)}`);
    }
  }
  return { processor, problems: [...problems] };
}

/**
 * Puts what a stored action sent back into its surface's data model, so a surface shown as sent after a reload shows
 * the values that went to the step rather than the step's first ones: each context entry of the source Button's action
 * that is bound to an absolute data model path gets the value the action carried. Anything else is left as it is.
 */
export function restoreSent(processor: MessageProcessor, action: Record<string, unknown>): void {
  const { surfaceId, sourceComponentId, context } = action;
  if (typeof surfaceId !== 'string' || typeof sourceComponentId !== 'string' || !context || typeof context !== 'object') return;
  const surface = processor.getSurfaces().get(surfaceId);
  const props = surface?.componentsModel.get(sourceComponentId)?.properties as { action?: { event?: { context?: unknown } } } | undefined;
  const bound = props?.action?.event?.context;
  if (!surface || !bound || typeof bound !== 'object') return;
  for (const [key, binding] of Object.entries(bound as Record<string, unknown>)) {
    const path = binding && typeof binding === 'object' ? (binding as { path?: unknown }).path : undefined;
    if (typeof path === 'string' && path.startsWith('/') && Object.hasOwn(context, key)) surface.dataModel.set(path, (context as Record<string, unknown>)[key]);
  }
}

export function A2uiBlock({
  taskId,
  reportId,
  messages,
  readonly,
  sentAt,
  sentAction,
  closed,
}: {
  taskId: string | null;
  reportId: string;
  messages: readonly unknown[];
  readonly: boolean;
  /** When the store already holds an action of this surface (the message's time). */
  sentAt?: string | undefined;
  /** That stored action (the message's meta), whose sent values the surface shows again. */
  sentAction?: Record<string, unknown> | undefined;
  /** The task's state when it takes no input any more (done or stopped). */
  closed?: string | undefined;
}) {
  const [posted, setPosted] = useState<{ at: string } | undefined>();
  const sent = posted ?? (sentAt ? { at: sentAt } : undefined);
  const [failure, setFailure] = useState<string>();
  const posting = useRef(false);
  const send = useRef<(action: UiAction) => void>(() => undefined);
  const inert = !!sent || readonly || !!closed;
  send.current = (action: UiAction) => {
    if (!taskId || inert || posting.current) return;
    posting.current = true;
    setFailure(undefined);
    postUiAction(taskId, action)
      .then(() => setPosted({ at: new Date().toISOString() }))
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        posting.current = false;
      });
  };
  const key = `${reportId}:${JSON.stringify(messages)}`;
  // One processor per report and message list (see the header): `key` is the dependency, not `messages` itself.
  const built = useMemo(() => buildSurfaces(messages, (action) => send.current(action)), [key]);
  const [surfaces, setSurfaces] = useState<SurfaceModel[]>(() => [...built.processor.getSurfaces().values()] as SurfaceModel[]);
  useEffect(() => {
    const sync = () => setSurfaces([...built.processor.getSurfaces().values()] as SurfaceModel[]);
    sync();
    const created = built.processor.onSurfaceCreated(sync);
    const deleted = built.processor.onSurfaceDeleted(sync);
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
    };
  }, [built]);
  const sentKey = sentAction ? JSON.stringify(sentAction) : '';
  useEffect(() => {
    if (!posted && sentAction) restoreSent(built.processor, sentAction);
    // sentKey stands for sentAction, whose identity changes with every refetch.
  }, [built, sentKey, posted]);
  return (
    <section className="report-ui" aria-label="From the step">
      <h3>From the step</h3>
      {built.problems.map((problem) => (
        <p key={problem} className="notice ui-notice" role="status">
          {problem}
        </p>
      ))}
      {surfaces.length > 0 && (
        <div className={`jv-a2ui${sent ? ' sent' : ''}${readonly ? ' readonly' : ''}${closed && !sent ? ' closed' : ''}`} aria-disabled={inert ? true : undefined} inert={inert ? true : undefined}>
          {surfaces.map((surface) => (
            <A2uiSurface key={surface.id} surface={surface as never} />
          ))}
        </div>
      )}
      {readonly && !sent && surfaces.length > 0 && <p className="muted small-text">Read-only: the surface takes no input here.</p>}
      {closed && !readonly && !sent && surfaces.length > 0 && <p className="muted small-text">Task {closed}: the surface takes no input.</p>}
      {sent && (
        <p className="ui-sent" role="status">
          Sent to the step at {localTime(sent.at)}
        </p>
      )}
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
