// The task show contract (skills brief section 3, `jv task show T --json`): what taskView() returns and what the
// coordinator, the MCP's jv_task_show and the UI's task page read: the task, its steps with every run (and each
// run's report, ReportViewSchema) and every placement decision of the step (chosen, override and outcome as the
// decisions row holds them, contracts/placement.ts), the messages, the landings and the workflow decision.
// tasks.ts has TypeScript types only; this schema is tested against taskView() of a real store.

import { z } from 'zod';
import {
  LANDING_ROUTES,
  LANDING_STATES,
  MESSAGE_DIRECTIONS,
  OVERRIDE_MODES,
  RUNTIMES,
  SESSION_STATES,
  STEP_STATES,
  TASK_KINDS,
  TASK_STATES,
} from '../types.js';
import {
  CountSchema,
  DecisionIdSchema,
  IsoTimeSchema,
  LandingIdSchema,
  MessageIdSchema,
  SessionIdSchema,
  StepIdSchema,
  TaskIdSchema,
} from './common.js';
import {
  OwnerPlacementChosenSchema,
  PlacementChosenSchema,
  PlacementOutcomeSchema,
  PlacementOverrideSchema,
  WorkflowChosenSchema,
} from './placement.js';
import { ReportViewSchema } from './report.js';

/** One run (one turn, D-006) of a step (tasks.ts RunView). */
export const RunViewSchema = z.strictObject({
  id: SessionIdSchema,
  runtime: z.enum(RUNTIMES),
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string(),
  state: z.enum(SESSION_STATES),
  stateReason: z.string(),
  nativeSessionId: z.string().min(1).nullable(),
  tmuxTarget: z.string().min(1).nullable(),
  startedAt: IsoTimeSchema.nullable(),
  endedAt: IsoTimeSchema.nullable(),
  lastEventAt: IsoTimeSchema.nullable(),
  tokens: z.strictObject({ input: CountSchema, output: CountSchema, cacheRead: CountSchema, cacheWrite: CountSchema }),
  costUsd: z.number().nonnegative().nullable(),
  report: ReportViewSchema.optional(),
});

/** One step (tasks.ts StepView). */
export const StepViewSchema = z.strictObject({
  id: StepIdSchema,
  ordinal: z.number().int().positive(),
  duty: z.string().min(1),
  /** The step's when rule: "always" or "jev:<question id>" (section 7.5). */
  when: z.string().min(1),
  state: z.enum(STEP_STATES),
  stateReason: z.string(),
  attempts: CountSchema,
  onFail: z.strictObject({ goto: z.string().min(1), maxLoops: CountSchema }).nullable(),
  instructions: z.string(),
  runs: z.array(RunViewSchema),
  placements: z.array(
    z.strictObject({
      id: DecisionIdSchema,
      chosen: z.union([PlacementChosenSchema, OwnerPlacementChosenSchema]),
      override: PlacementOverrideSchema.nullable(),
      overrideMode: z.enum(OVERRIDE_MODES).nullable(),
      outcome: PlacementOutcomeSchema.nullable(),
      createdAt: IsoTimeSchema,
    }),
  ),
});

/** `jv task show T --json` (tasks.ts TaskView). */
export const TaskShowSchema = z.strictObject({
  id: TaskIdSchema,
  /** The project's name. */
  project: z.string().min(1),
  kind: z.enum(TASK_KINDS),
  title: z.string().min(1).max(120),
  text: z.string(),
  state: z.enum(TASK_STATES),
  stateReason: z.string(),
  /** Who created the task (schema 2): owner, coordinator, ui, mcp, schedule:<C>, planner:<J>, improver:<J>. */
  origin: z.string().regex(/^(owner|coordinator|ui|mcp|schedule:C[0-9A-Z]{6}|planner:J[0-9A-Z]{6}|improver:J[0-9A-Z]{6})$/),
  currentStep: CountSchema,
  branch: z.string().min(1).nullable(),
  worktree: z.string().min(1).nullable(),
  baseCommit: z.string().min(1).nullable(),
  landedCommit: z.string().min(1).nullable(),
  visible: z.boolean(),
  parent: TaskIdSchema.nullable(),
  after: TaskIdSchema.nullable(),
  children: z.array(z.strictObject({ id: TaskIdSchema, title: z.string().min(1), state: z.enum(TASK_STATES) })),
  workflow: z.strictObject({ name: z.string().min(1).optional(), source: z.string().min(1).optional() }),
  createdAt: IsoTimeSchema,
  startedAt: IsoTimeSchema.nullable(),
  endedAt: IsoTimeSchema.nullable(),
  steps: z.array(StepViewSchema),
  messages: z.array(
    z.strictObject({
      id: MessageIdSchema,
      direction: z.enum(MESSAGE_DIRECTIONS),
      text: z.string().min(1),
      createdAt: IsoTimeSchema,
      deliveredAt: IsoTimeSchema.nullable(),
      session: SessionIdSchema.nullable(),
    }),
  ),
  landings: z.array(
    z.strictObject({
      id: LandingIdSchema,
      route: z.enum(LANDING_ROUTES),
      state: z.enum(LANDING_STATES),
      reason: z.string(),
      commit: z.string().min(1).nullable(),
      createdAt: IsoTimeSchema,
    }),
  ),
  workflowDecision: z.strictObject({ id: DecisionIdSchema, chosen: WorkflowChosenSchema }).optional(),
});
export type TaskShowContract = z.output<typeof TaskShowSchema>;
