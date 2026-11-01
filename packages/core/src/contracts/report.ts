// The report contract (skills brief section 5; brief section 3): what every worker sends once per turn through
// jv_report, as the lifted src/report.ts defines it, plus the optional `ui` field of schema 2.
//
// - The lifted schemas are re-exported as they are (ReportFieldsSchema and its parts), never copied, so the contract
//   and the tool cannot drift. ReportFieldsSchema stays unrefined (report.ts: the tool input schema derives from
//   it); the needs-decision rule (a question and two to four options) is a refinement here, in ReportSchema.
// - `ui` (brief sections 3 and 7): an array of A2UI messages. Each is an object with `version` "v0.9" or "1.0" and
//   exactly one of createSurface, updateComponents, updateDataModel, deleteSurface; every one of the four names a
//   `surfaceId` (A2UI v0.9 specification). Only that envelope is checked: the components, data model and catalog
//   are the renderer's to validate (@a2ui/web_core), so a newer catalog never makes a report invalid here. The array
//   serialised is at most 65536 characters. checkReportUi gives the reason a `ui` value is refused, for the tool's
//   "ui dropped: <reason>" limitation (the report itself is still recorded).
// - ReportViewSchema is a stored report as reportView() returns it (status, task show, the UI); ReportRowSchema the
//   reports row (schema 2 adds ui_json).

import { z } from 'zod';
import {
  NEEDS_DECISION_OPTIONS,
  NEEDS_DECISION_QUESTION,
  OwnerCommandSchema,
  ReportFieldsSchema,
  ReportOptionSchema,
  ReportStatusSchema,
  ScreenshotSchema,
  SUMMARY_MAX,
  TestsRunSchema,
} from '../report.js';
import { IsoTimeSchema, ReportIdSchema, SessionIdSchema, StepIdSchema, TaskIdSchema, jsonText } from './common.js';

export {
  NEEDS_DECISION_OPTIONS,
  NEEDS_DECISION_QUESTION,
  OwnerCommandSchema,
  ReportFieldsSchema,
  ReportOptionSchema,
  ReportStatusSchema,
  ScreenshotSchema,
  SUMMARY_MAX,
  TestsRunSchema,
};

// ---- A2UI messages (the `ui` field) ---------------------------------------------------------------------------

export const A2UI_VERSIONS = ['v0.9', '1.0'] as const;
export type A2uiVersion = (typeof A2UI_VERSIONS)[number];

/** The four agent-to-renderer messages of A2UI v0.9 (the published 1.0 specification names the same four). */
export const A2UI_MESSAGE_KINDS = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'] as const;
export type A2uiMessageKind = (typeof A2UI_MESSAGE_KINDS)[number];

/** The most characters the `ui` array may take serialised (JSON.stringify). */
export const REPORT_UI_MAX_CHARS = 65536;

export const A2uiVersionSchema = z.enum(A2UI_VERSIONS);

/** The body of any of the four messages: a surfaceId, everything else is the renderer's to check. */
const SurfaceBody = z.looseObject({ surfaceId: z.string().min(1) });

export const A2uiCreateSurfaceSchema = z.strictObject({ version: A2uiVersionSchema, createSurface: SurfaceBody });
export const A2uiUpdateComponentsSchema = z.strictObject({ version: A2uiVersionSchema, updateComponents: SurfaceBody });
export const A2uiUpdateDataModelSchema = z.strictObject({ version: A2uiVersionSchema, updateDataModel: SurfaceBody });
export const A2uiDeleteSurfaceSchema = z.strictObject({ version: A2uiVersionSchema, deleteSurface: SurfaceBody });

/** One A2UI message: `version` and exactly one of the four message keys (strict objects refuse a second key). */
export const A2uiMessageSchema = z.union([
  A2uiCreateSurfaceSchema,
  A2uiUpdateComponentsSchema,
  A2uiUpdateDataModelSchema,
  A2uiDeleteSurfaceSchema,
]);
export type A2uiMessage = z.output<typeof A2uiMessageSchema>;

function uiTooLong(ui: unknown): number | undefined {
  const length = JSON.stringify(ui)?.length ?? 0;
  return length > REPORT_UI_MAX_CHARS ? length : undefined;
}

/** The `ui` field: A2UI messages, at most REPORT_UI_MAX_CHARS characters serialised. */
export const ReportUiSchema = z.array(A2uiMessageSchema).superRefine((ui, ctx) => {
  const length = uiTooLong(ui);
  if (length !== undefined) ctx.addIssue({ code: 'custom', message: `ui is ${length} characters serialised; at most ${REPORT_UI_MAX_CHARS}` });
});

/** Why one A2UI message is refused, in words a worker can act on; undefined when it is valid. */
function messageProblem(message: unknown, index: number): string | undefined {
  const at = `ui[${index}]`;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return `${at} is not an object`;
  const keys = Object.keys(message);
  const version = (message as { version?: unknown }).version;
  if (!(A2UI_VERSIONS as readonly unknown[]).includes(version)) {
    return `${at} has version ${JSON.stringify(version) ?? 'missing'}; expected ${A2UI_VERSIONS.map((v) => `"${v}"`).join(' or ')}`;
  }
  const kinds = keys.filter((k) => (A2UI_MESSAGE_KINDS as readonly string[]).includes(k));
  if (kinds.length !== 1) {
    return `${at} has ${kinds.length ? kinds.join(' and ') : 'none'} of ${A2UI_MESSAGE_KINDS.join(', ')}; expected exactly one`;
  }
  const unknown = keys.filter((k) => k !== 'version' && k !== kinds[0]);
  if (unknown.length) return `${at} has unknown key ${unknown.join(', ')}`;
  const body = (message as Record<string, unknown>)[kinds[0]!];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return `${at}.${kinds[0]} is not an object`;
  const surfaceId = (body as { surfaceId?: unknown }).surfaceId;
  if (typeof surfaceId !== 'string' || surfaceId === '') return `${at}.${kinds[0]} has no surfaceId`;
  return undefined;
}

export type CheckedReportUi = { ok: true; ui: A2uiMessage[] } | { ok: false; reason: string };

/**
 * Checks a report's `ui` value. The reason of a refusal is what follows "ui dropped: " in the report's limitations
 * (brief section 3: invalid `ui` is dropped, the report is still recorded).
 */
export function checkReportUi(value: unknown): CheckedReportUi {
  if (!Array.isArray(value)) return { ok: false, reason: 'ui is not an array of A2UI messages' };
  for (const [i, message] of value.entries()) {
    const problem = messageProblem(message, i);
    if (problem) return { ok: false, reason: problem };
  }
  const length = uiTooLong(value);
  if (length !== undefined) return { ok: false, reason: `ui is ${length} characters serialised; at most ${REPORT_UI_MAX_CHARS}` };
  const parsed = ReportUiSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'ui is not valid' };
  return { ok: true, ui: parsed.data };
}

// ---- the report a worker sends ------------------------------------------------------------------------------

/** The report fields with `ui`, unrefined (a tool input schema can derive from it, as from ReportFieldsSchema). */
export const ReportWithUiSchema = ReportFieldsSchema.extend({ ui: ReportUiSchema.optional() });

/** The whole report contract: the fields, `ui`, and the needs-decision rule parseReport applies. */
export const ReportSchema = ReportWithUiSchema.superRefine((report, ctx) => {
  if (report.status !== 'needs-decision') return;
  if (!report.question || report.question.trim() === '') ctx.addIssue({ code: 'custom', path: ['question'], message: NEEDS_DECISION_QUESTION });
  if (!report.options || report.options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: NEEDS_DECISION_OPTIONS });
});
export type ReportContract = z.output<typeof ReportSchema>;

// ---- a stored report ------------------------------------------------------------------------------------------

/** A stored report in the shape reportView() returns (JSON columns parsed), plus its ids. */
export const ReportViewSchema = z.strictObject({
  id: ReportIdSchema,
  sessionId: SessionIdSchema,
  taskId: TaskIdSchema.nullable(),
  stepId: StepIdSchema.nullable(),
  status: ReportStatusSchema,
  summary: z.string().min(1).max(SUMMARY_MAX),
  question: z.string().optional(),
  options: z.array(ReportOptionSchema).optional(),
  testsRun: TestsRunSchema.optional(),
  changedFiles: z.array(z.string()),
  screenshots: z.array(ScreenshotSchema),
  limitations: z.string().optional(),
  ownerCommands: z.array(OwnerCommandSchema).optional(),
  /** Schema 2: the A2UI messages the worker attached, when reportView carries them. */
  ui: ReportUiSchema.optional(),
  createdAt: IsoTimeSchema,
});
export type ReportViewContract = z.output<typeof ReportViewSchema>;

/** A reports row (section 4, schema 2): JSON columns as text. */
export const ReportRowSchema = z.strictObject({
  id: ReportIdSchema,
  session_id: SessionIdSchema,
  step_id: StepIdSchema.nullable(),
  task_id: TaskIdSchema.nullable(),
  status: ReportStatusSchema,
  summary: z.string().min(1).max(SUMMARY_MAX),
  question: z.string().nullable(),
  options_json: jsonText(z.array(ReportOptionSchema)).nullable(),
  tests_json: jsonText(TestsRunSchema).nullable(),
  changed_files_json: jsonText(z.array(z.string())),
  screenshots_json: jsonText(z.array(ScreenshotSchema)),
  limitations: z.string().nullable(),
  owner_commands_json: jsonText(z.array(OwnerCommandSchema)).nullable(),
  created_at: IsoTimeSchema,
  ui_json: jsonText(ReportUiSchema).nullable(),
});
