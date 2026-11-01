// POST /api/tasks/:id/ui-action (brief section 7, A2UI): a Button of a report's A2UI surface produces the renderer's
// action ({name, surfaceId, sourceComponentId, timestamp, context?, userMessage?}, bindings resolved), and the page
// posts it here as {action}. The mapping:
//
// - name "answer" with a string context.label is `jv task answer T "<label>"` (core answerTask);
// - anything else is `jv task message T "UI action <name>: <context as JSON, at most 4000 characters>"` (core
//   messageTask);
// - either way the action (JSON, at most 65536 characters) goes into the message row's meta_json.
//
// Known secrets are masked before anything is stored (as core's messageTask and answerTask mask their text): the
// context is masked before it is cut to 4000 characters (cutting first could leave part of a secret), and meta_json
// is the action with every string masked; an action with no secret in it is kept as it was posted.
//
// messageTask and answerTask take no meta_json, so the row they return is updated right after (one UPDATE on the
// store's own connection). An answer to a landing ask ("Land now" or "Leave it") writes no message row, so it has no
// meta_json. Both run with an empty environment for the caller, so a UI action is always the owner's (or an answer),
// even when the server itself was started from inside a coordinator session (JV_SESSION).

import { refused } from 'jevellan-core/errors';
import { normalizeId } from 'jevellan-core/ids';
import { redactValue } from 'jevellan-core/redact';
import type { Store } from 'jevellan-core/store';
import { answerTask, messageTask, type TaskDeps } from 'jevellan-core/tasks';
import type { MessageRow } from 'jevellan-core/types';

export const UI_ACTION_CONTEXT_MAX = 4000;
export const UI_ACTION_JSON_MAX = 65536;
export const UI_ACTION_NAME_MAX = 200;

export interface UiActionResult {
  kind: 'answer' | 'message';
  /** The messages row written, with meta_json; null for a landing answer, which writes none. */
  message: MessageRow | null;
  /** answer: the answer as recorded (an option's own label when it matched one). */
  answer?: string;
  /** message: how it was delivered (typed, next-turn, resumed, next-run). */
  delivery?: string;
  /** The run that got it, when one did. */
  session?: string;
}

export interface UiAction {
  name: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Checks the posted action: an object with a name, an object context when there is one, at most 65536 characters. */
export function parseUiAction(value: unknown): { action: UiAction; json: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw refused('action must be an A2UI action object');
  const action = value as Record<string, unknown>;
  if (typeof action.name !== 'string' || action.name.trim() === '') throw refused('action.name is required');
  if (action.name.length > UI_ACTION_NAME_MAX) throw refused(`action.name is longer than ${UI_ACTION_NAME_MAX} characters`);
  if (action.context !== undefined && (action.context === null || typeof action.context !== 'object' || Array.isArray(action.context))) {
    throw refused('action.context must be an object');
  }
  const json = JSON.stringify(action);
  if (json.length > UI_ACTION_JSON_MAX) throw refused(`the action is longer than ${UI_ACTION_JSON_MAX} characters as JSON`);
  return { action: action as UiAction, json };
}

/** The text of a non-answer action's message. */
export function actionMessageText(action: UiAction): string {
  let context = JSON.stringify(redactValue(action.context ?? {}));
  if (context.length > UI_ACTION_CONTEXT_MAX) context = `${context.slice(0, UI_ACTION_CONTEXT_MAX - 3)}...`;
  return `UI action ${action.name}: ${context}`;
}

/** The label of an answer action, when it is one. */
export function answerLabel(action: UiAction): string | undefined {
  if (action.name !== 'answer') return undefined;
  const label = action.context?.label;
  return typeof label === 'string' ? label : undefined;
}

function withMeta(store: Store, message: MessageRow, json: string): MessageRow {
  store.db.prepare('UPDATE messages SET meta_json = ? WHERE id = ?').run(json, message.id);
  return store.getMessage(message.id) ?? { ...message, meta_json: json };
}

/** Applies a posted A2UI action to a task (see the header). */
export async function applyUiAction(store: Store, taskId: string, posted: unknown, deps: Partial<TaskDeps> = {}): Promise<UiActionResult> {
  const { action } = parseUiAction(posted);
  const json = JSON.stringify(redactValue(action));
  const id = normalizeId(taskId);
  const label = answerLabel(action);
  if (label !== undefined) {
    const r = await answerTask(store, id, label, { env: {}, deps });
    return {
      kind: 'answer',
      message: r.message ? withMeta(store, r.message, json) : null,
      answer: r.answer,
      ...(r.session ? { session: r.session } : {}),
    };
  }
  const r = await messageTask(store, id, actionMessageText(action), { env: {}, deps });
  return {
    kind: 'message',
    message: withMeta(store, r.message, json),
    delivery: r.delivery,
    ...(r.session ? { session: r.session } : {}),
  };
}
