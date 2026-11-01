// The request id rule (skills brief section 4, D-019, D-038; brief sections 3 and 9): every creating write carries a
// request id; the same id with the same input returns the existing row, the same id with different input exits 4
// naming the columns that differ. Nothing about an id's text is checked by the store beyond "not empty", so any
// caller may choose one (jv task create --request-id); the forms below are the ones jv itself writes.
//
// - A task created without --request-id gets "auto:" plus the sha256 (hex) of the JSON array [project id, kind,
//   duty, title, text, parent, after, visible] after normalising title and text (D-038; tasks.autoRequestId), so the
//   same command typed twice is one task.
// - The per-project coordinator conversation task is "coordinator-conversation:<P>" (store.coordinatorTask).
// - Schedules fire tasks as "schedule:<C>:<next_run_at>" and the planner creates "plan:<J>:<index>" (brief section 9),
//   so a tick that runs twice creates nothing twice.
// - Session (run) rows: "run:<D>" for a placed step, "continue:<R>" and "messages:<R>" for the turns after a run,
//   "message:<M>", "answer:<M>" and "resume:<R>" for the owner's commands, "coordinator:<P>:<uuid>" (D-055).

import { z } from 'zod';

const ID = '[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}';
const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The prefix of a task request id jv derives from the task's input (tasks.AUTO_REQUEST_PREFIX). */
export const AUTO_REQUEST_PREFIX = 'auto:';

/** Any request id: not empty and without surrounding whitespace (jv trims what it is given). */
export const RequestIdSchema = z
  .string()
  .min(1, 'a request id is not empty')
  .refine((id) => id.trim() === id, 'a request id has no surrounding whitespace');

/** The request id jv task create derives when none is given (D-038). */
export const AutoRequestIdSchema = z.string().regex(/^auto:[0-9a-f]{64}$/, 'auto: and the 64 hex characters of a sha256');

/** The task request ids jv itself writes; anything else is an id a caller chose. */
export const TASK_REQUEST_ID_FORMS = {
  auto: /^auto:[0-9a-f]{64}$/,
  coordinatorConversation: new RegExp(`^coordinator-conversation:P${ID}$`),
  schedule: new RegExp(`^schedule:C${ID}:${ISO}$`),
  plan: new RegExp(`^plan:J${ID}:\\d+$`),
} as const;
export type TaskRequestIdForm = keyof typeof TASK_REQUEST_ID_FORMS | 'given';

/** The session (run) request ids jv writes (advance.ts, tasks.ts, coordinator.ts). */
export const SESSION_REQUEST_ID_FORMS = {
  run: new RegExp(`^run:D${ID}$`),
  continue: new RegExp(`^continue:R${ID}$`),
  messages: new RegExp(`^messages:R${ID}$`),
  message: new RegExp(`^message:M${ID}$`),
  answer: new RegExp(`^answer:M${ID}$`),
  resume: new RegExp(`^resume:R${ID}$`),
  coordinator: new RegExp(`^coordinator:P${ID}:${UUID}$`),
} as const;

/** A task request id: any request id. */
export const TaskRequestIdSchema = RequestIdSchema;

/** Which of jv's forms a task request id has ("given" when a caller chose it). */
export function taskRequestIdForm(id: string): TaskRequestIdForm {
  for (const [form, pattern] of Object.entries(TASK_REQUEST_ID_FORMS)) if (pattern.test(id)) return form as TaskRequestIdForm;
  return 'given';
}
