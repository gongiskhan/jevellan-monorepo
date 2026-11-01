// The status contract (skills brief section 3, `jv status --json`): what statusView() returns and what the
// coordinator, the MCP's jv_status and the UI read. Per open task: its state and reason, the current step, the latest
// run, the last report, and, when the task waits on the owner, the question and its options (a landing ask offers
// "Land now" and "Leave it", D-042, D-049). Lost runs are marked at read time (`lost`). Done tasks are left out and
// listed apart as `recent` for 24 hours. status.ts has TypeScript types only; this schema is tested against
// statusView() of a real store.

import { z } from 'zod';
import { REPORT_STATUSES, RUNTIMES, SESSION_KINDS, SESSION_STATES, STEP_STATES, TASK_KINDS, TASK_STATES } from '../types.js';
import { IsoTimeSchema, SessionIdSchema, TaskIdSchema } from './common.js';

const OptionSchema = z.strictObject({ label: z.string().min(1), description: z.string().optional() });

export const TaskStatusSchema = z.strictObject({
  id: TaskIdSchema,
  /** The project's name. */
  project: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  state: z.enum(TASK_STATES),
  state_reason: z.string(),
  step: z.strictObject({ ordinal: z.number().int().positive(), duty: z.string().min(1), state: z.enum(STEP_STATES), of: z.number().int().positive() }).nullable(),
  run: z
    .strictObject({
      id: SessionIdSchema,
      model: z.string().min(1),
      provider: z.string().min(1),
      runtime: z.enum(RUNTIMES),
      effort: z.string(),
      state: z.enum(SESSION_STATES),
      lastEventAt: IsoTimeSchema.nullable(),
    })
    .nullable(),
  lost: z.boolean(),
  report: z.strictObject({ session: SessionIdSchema, status: z.enum(REPORT_STATUSES), summary: z.string() }).nullable(),
  question: z.string().optional(),
  options: z.array(OptionSchema).optional(),
  updatedAt: IsoTimeSchema,
});

export const SessionStatusSchema = z.strictObject({
  id: SessionIdSchema,
  project: z.string().min(1),
  kind: z.enum(SESSION_KINDS),
  task: TaskIdSchema.nullable(),
  step: z.number().int().positive().nullable(),
  runtime: z.enum(RUNTIMES),
  provider: z.string().min(1),
  model: z.string().min(1),
  state: z.enum(SESSION_STATES),
  state_reason: z.string(),
  lastEventAt: IsoTimeSchema.nullable(),
  tmuxTarget: z.string().nullable(),
});

/** `jv status --json` (status.ts StatusView). */
/** The bot's state as jv status reads it from the store's meta rows (bot-state.ts, brief sections 4 and 8). */
export const BotStateSchema = z.strictObject({
  alive: z.boolean(),
  pid: z.number().int().positive().nullable(),
  heartbeatAt: IsoTimeSchema.nullable(),
  heartbeatAgeSeconds: z.number().int().nonnegative().nullable(),
  startedAt: IsoTimeSchema.nullable(),
  tick: z.number().int().nonnegative().nullable(),
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  limits: z.strictObject({ perProject: z.number().int().positive(), total: z.number().int().positive() }),
});

export const StatusSchema = z.strictObject({
  tasks: z.array(TaskStatusSchema),
  sessions: z.array(SessionStatusSchema),
  recent: z.array(
    z.strictObject({
      id: TaskIdSchema,
      project: z.string().min(1),
      title: z.string().min(1),
      kind: z.enum(TASK_KINDS),
      endedAt: IsoTimeSchema.nullable(),
      landedCommit: z.string().nullable(),
    }),
  ),
  /** Runs marked lost by this read. */
  lost: z.array(SessionIdSchema),
  bot: BotStateSchema,
});
export type StatusContract = z.output<typeof StatusSchema>;
