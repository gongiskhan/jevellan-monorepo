// The placement contracts (skills brief 7.2, 7.5 and 8; brief section 3): the state JSON Jev reads, and the decisions
// row every Jev decision writes.
//
// - The lifted route.ts has the placement and workflow states as TypeScript interfaces only (PlacementState,
//   WorkflowState), so their schemas are written here and tested against the states placementContext() and
//   askWorkflowQuestions() build. The landing state already has a schema in land.ts (LandingRouteStateSchema, ported
//   from Jevellan); it is re-exported, not copied.
// - A decisions row (section 4) keeps its JSON in text columns. DecisionRowSchema checks the columns and that each
//   JSON column holds JSON; DecisionSchema also checks what the JSON says for the row's kind:
//     placement  state PlacementState (or "{}" for an owner placement with no earlier one), chosen the Jev form
//                (PlacementChosen, D-030, D-036) or the owner's (jv task override --undo, D-033: jev_model "none");
//     landing    state LandingRouteState, chosen {route, jevRoute, probabilities, rulesApplied, ruleReason?, source}
//                (D-047);
//     workflow   state WorkflowState, chosen {answers, skip} (section 7.5).
//   questions_json and answers_json are Jev's own question and answer schemas (jev/contract.ts); a placement with
//   nothing to ask writes "{}" for both and one GET /v1/models call in usage_json (D-036). override_json is the
//   owner's placement recorded on Jev's row (undo or keep); outcome_json is advance.recordOutcome's.

import { z } from 'zod';
import { JevAnswerSchema, JevQuestionSchema } from '../jev/contract.js';
import { LandingRouteStateSchema } from '../land.js';
import { PROVIDER_KINDS } from '../providers.js';
import { EFFORTS } from '../route.js';
import { DECISION_KINDS, LANDING_ROUTES, OVERRIDE_MODES, RUNTIMES, TASK_KINDS } from '../types.js';
import {
  CountSchema,
  DecisionIdSchema,
  IsoTimeSchema,
  ProbabilitySchema,
  ProjectIdSchema,
  SessionIdSchema,
  StepIdSchema,
  TaskIdSchema,
  jsonText,
} from './common.js';

export { LandingRouteStateSchema };

export const EffortSchema = z.enum(EFFORTS);
export const RuntimeSchema = z.enum(RUNTIMES);

const nullablePct = z.number().nullable();
const probabilities = z.record(z.string().min(1), ProbabilitySchema);

// ---- states ---------------------------------------------------------------------------------------------------

const StateProjectSchema = z.strictObject({ name: z.string().min(1), guidance: z.string() });

const StateTaskSchema = z.strictObject({
  id: TaskIdSchema,
  kind: z.enum(TASK_KINDS),
  title: z.string().min(1).max(120),
  /** The task text; the last thing shortened ("[Task shortened.]") to keep the state under 60 000 characters. */
  text: z.string(),
  parent: TaskIdSchema.nullable(),
  visible: z.boolean(),
});

const MenuModelSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: z.string().min(1),
  runtime: RuntimeSchema,
  efforts: z.array(z.string().min(1)).min(1),
  description: z.string(),
});

const MenuProviderSchema = z.strictObject({
  name: z.string().min(1),
  weeklyPct: nullablePct,
  fiveHourPct: nullablePct,
  ceilingPct: z.number(),
  observedAt: IsoTimeSchema.nullable(),
});

/** The state of a placement question (section 7.2 step 3; route.ts PlacementState). */
export const PlacementStateSchema = z.strictObject({
  project: StateProjectSchema,
  task: StateTaskSchema,
  step: z.strictObject({
    ordinal: z.number().int().positive(),
    duty: z.string().min(1),
    instructions: z.string(),
    attempt: z.number().int().positive(),
    previous: z.array(z.strictObject({ duty: z.string().min(1), status: z.string().min(1), summary: z.string() })),
    failure: z.string().optional(),
  }),
  duty: z.strictObject({ needs: z.array(z.string().min(1)), runtimes: z.array(RuntimeSchema).min(1) }),
  menu: z.strictObject({ models: z.array(MenuModelSchema).min(1), providers: z.array(MenuProviderSchema).min(1) }),
  history: z.strictObject({
    recent: z.array(
      z.strictObject({
        duty: z.string().min(1),
        model: z.string().min(1),
        effort: z.string(),
        outcome: z.string().min(1),
        attempts: z.number().int().positive().nullable(),
      }),
    ),
  }),
  rules: z.string(),
});
export type PlacementStateContract = z.output<typeof PlacementStateSchema>;

/** The state of the workflow questions (section 7.5; route.ts WorkflowState): the task, no step. */
export const WorkflowStateSchema = z.strictObject({ project: StateProjectSchema, task: StateTaskSchema, rules: z.string() });

// ---- what a decision chose ------------------------------------------------------------------------------------

const ChoiceRecordSchema = z.strictObject({
  source: z.enum(['jev', 'only-option']),
  option: z.string().min(1),
  probabilities: probabilities.optional(),
});

/** chosen_json of a placement Jev made (route.ts PlacementChosen). */
export const PlacementChosenSchema = z.strictObject({
  source: z.literal('jev'),
  duty: z.string().min(1),
  visible: z.boolean(),
  runtime: RuntimeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  label: z.string().min(1),
  effort: EffortSchema,
  effortRequested: EffortSchema,
  effortAfterRules: EffortSchema,
  choices: z.strictObject({ model: ChoiceRecordSchema, effort: ChoiceRecordSchema, provider: ChoiceRecordSchema }),
  candidates: z.array(
    z.strictObject({
      name: z.string().min(1),
      kind: z.enum(PROVIDER_KINDS),
      eligible: z.boolean(),
      reason: z.string().min(1),
      ceilingPct: z.number(),
      weeklyPct: nullablePct,
      fiveHourPct: nullablePct,
    }),
  ),
  rules: z.strictObject({
    applied: z.array(z.string()),
    ignored: z.array(z.string()),
    minimum: EffortSchema,
    maximum: EffortSchema,
    reason: z.string(),
  }),
});

/** chosen_json of the owner's placement (jv task override --undo, route.ownerPlacement; D-033). */
export const OwnerPlacementChosenSchema = z.strictObject({
  source: z.literal('owner'),
  duty: z.string().min(1),
  visible: z.boolean(),
  runtime: RuntimeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema,
  label: z.string().min(1),
  effortRequested: z.string().min(1).optional(),
  /** The Jev decision this placement replaced, when there was one. */
  overrides: DecisionIdSchema.nullable(),
  providerReason: z.string().min(1),
});

/** chosen_json of a landing decision (land.ts, D-047). */
export const LandingChosenSchema = z.strictObject({
  route: z.enum(LANDING_ROUTES),
  jevRoute: z.enum(LANDING_ROUTES),
  probabilities,
  rulesApplied: z.array(z.string()),
  ruleReason: z.string().optional(),
  source: z.literal('jev'),
});

/** chosen_json of the workflow questions (section 7.5): every jev: answer, and the steps they skip. */
export const WorkflowChosenSchema = z.strictObject({
  answers: z.record(z.string().min(1), z.strictObject({ value: z.boolean(), probability: ProbabilitySchema })),
  skip: z.array(
    z.strictObject({ stepId: StepIdSchema, ordinal: z.number().int().positive(), duty: z.string().min(1), question: z.string().min(1) }),
  ),
});

/** override_json: the owner's placement recorded on the step's latest Jev placement (jv task override). */
export const PlacementOverrideSchema = z.strictObject({
  source: z.literal('owner'),
  runtime: RuntimeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema,
  effortRequested: z.string().min(1).optional(),
  at: IsoTimeSchema,
});

/** outcome_json of a placement (advance.recordOutcome). */
export const PlacementOutcomeSchema = z.strictObject({
  status: z.enum(['done', 'failed', 'blocked']),
  attempts: z.number().int().positive(),
  durationMs: CountSchema,
  costUsd: z.number().nonnegative().nullable(),
});

/** One Jev call of a decision (route.ts JevCallRecord); `check` marks the GET /v1/models call of D-036. */
const JevCallSchema = z.strictObject({
  questions: z.array(z.string().min(1)),
  model: z.string().min(1),
  latencyMs: CountSchema,
  usage: z.strictObject({ input_tokens: CountSchema, output_tokens: CountSchema }),
  check: z.literal('GET /v1/models').optional(),
});

/** usage_json: token sums and every call. */
export const DecisionUsageSchema = z.strictObject({ input_tokens: CountSchema, output_tokens: CountSchema, calls: z.array(JevCallSchema) });

const questionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
/** questions_json: Jev's questions by id; "{}" when nothing was asked. */
export const DecisionQuestionsSchema = z.record(questionId, JevQuestionSchema);
/** answers_json: Jev's answers by question id; "{}" when nothing was asked. */
export const DecisionAnswersSchema = z.record(questionId, JevAnswerSchema);

// ---- the decisions row ----------------------------------------------------------------------------------------

/** A decisions row (section 4): every column, JSON columns as JSON text. */
export const DecisionRowSchema = z.strictObject({
  id: DecisionIdSchema,
  kind: z.enum(DECISION_KINDS),
  project_id: ProjectIdSchema,
  task_id: TaskIdSchema.nullable(),
  step_id: StepIdSchema.nullable(),
  session_id: SessionIdSchema.nullable(),
  skill_name: z.string().min(1),
  skill_hash: z.string(),
  /** The model Jev reports as having answered (D-033), or "none" for the owner's placement. */
  jev_model: z.string().min(1),
  state_json: jsonText(),
  questions_json: jsonText(DecisionQuestionsSchema),
  answers_json: jsonText(DecisionAnswersSchema),
  chosen_json: jsonText(),
  override_json: jsonText(PlacementOverrideSchema).nullable(),
  override_mode: z.enum(OVERRIDE_MODES).nullable(),
  outcome_json: jsonText(PlacementOutcomeSchema).nullable(),
  latency_ms: CountSchema,
  usage_json: jsonText(DecisionUsageSchema),
  created_at: IsoTimeSchema,
});
export type DecisionRowContract = z.output<typeof DecisionRowSchema>;

function issuesOf(schema: z.ZodType, value: unknown, column: string, ctx: z.RefinementCtx): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues.slice(0, 6)) {
    ctx.addIssue({ code: 'custom', path: [column], message: `${issue.path.length ? issue.path.join('.') : '(json)'}: ${issue.message}` });
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // DecisionRowSchema reported it
  }
}

/** A decisions row whose JSON columns say what its kind says (see the header). */
export const DecisionSchema = DecisionRowSchema.superRefine((row, ctx) => {
  const state = parsed(row.state_json);
  const chosen = parsed(row.chosen_json);
  if (row.kind === 'placement') {
    const owner = (chosen as { source?: unknown } | undefined)?.source === 'owner';
    issuesOf(owner ? OwnerPlacementChosenSchema : PlacementChosenSchema, chosen, 'chosen_json', ctx);
    const emptyState = typeof state === 'object' && state !== null && Object.keys(state).length === 0;
    if (!(owner && emptyState)) issuesOf(PlacementStateSchema, state, 'state_json', ctx);
    if (owner && row.jev_model !== 'none') ctx.addIssue({ code: 'custom', path: ['jev_model'], message: 'the owner placement is written with jev_model "none" (D-033)' });
  } else if (row.kind === 'landing') {
    issuesOf(LandingChosenSchema, chosen, 'chosen_json', ctx);
    issuesOf(LandingRouteStateSchema, state, 'state_json', ctx);
  } else {
    issuesOf(WorkflowChosenSchema, chosen, 'chosen_json', ctx);
    issuesOf(WorkflowStateSchema, state, 'state_json', ctx);
  }
  if ((row.override_json === null) !== (row.override_mode === null)) {
    ctx.addIssue({ code: 'custom', path: ['override_mode'], message: 'override_json and override_mode are set together' });
  }
});
