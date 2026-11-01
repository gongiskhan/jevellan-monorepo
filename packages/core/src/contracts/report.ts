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
import { ReportUiSchema } from './a2ui.js';

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

export * from './a2ui.js';

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
