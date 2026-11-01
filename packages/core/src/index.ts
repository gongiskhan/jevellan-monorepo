// The public API of jevellan-core (brief section 3): what the cli, ui, mcp, bot, scheduler, planner and improver
// packages use, from one import. Every module stays importable by subpath too (`jevellan-core/store`, M-008), which is
// what the command layer does so `jv status` loads only what it needs; importing this index loads the whole engine
// (not the runtime modules, which runtimes/index.ts loads on demand).
//
// - Names are the lifted modules' own. The brief's names that the lifted code spells differently are aliases of the
//   same functions: land = landTask, override = overrideTask, doctor = runChecks, assemblePrompt = buildSystemAppend.
//   The brief's startSession, resumeSession, stopSession and retry have no single lifted function: a step starts
//   through startStep (placement, then the run row and the detached `jv run`, which runs executeRun), a task resumes
//   through resumeTask (also what retries a failed or lost step, D-040), a run stops through stopRun, and on_fail
//   retries happen in afterRun. migrate(db) is not exported: the store migrates inside openStore (Store.open), and
//   the migration is a private method of Store that works on its own connection.
// - Modules whose names clash, or that are read as a whole, are namespaces: advance (its wake and wakeLine are not
//   wake.ts's), coordinator, providers, wake, workflows.
// - Nothing here prints or exits: core returns values and throws JvError with exit code 2, 3 or 4 (errors.ts).
// - The contracts (zod schemas of every public JSON shape) are exported flat, from contracts/index.ts.

// ---- the store and its rows -------------------------------------------------------------------------------------

export {
  COORDINATOR_TASK_REQUEST_PREFIX,
  COORDINATOR_TASK_TITLE,
  SCHEMA_V1_VERSION,
  SCHEMA_VERSION,
  Store,
  TABLES,
  TABLES_V2,
  TASK_ORIGIN_PATTERN,
  isBusyError,
  listSchemaExtensions,
  nowIso,
  openStore,
  readStoreSchemaVersion,
  registerSchemaExtension,
  withStore,
  type Created,
  type DecisionFilter,
  type DecisionPatch,
  type LandingFilter,
  type LandingPatch,
  type MessageFilter,
  type NewDecision,
  type NewLanding,
  type NewMessage,
  type NewProject,
  type NewProviderUsage,
  type NewReport,
  type NewSession,
  type NewStep,
  type NewTask,
  type OpenStoreOptions,
  type ProviderUsageFilter,
  type ReportFilter,
  type SchemaExtension,
  type SessionFilter,
  type SessionPatch,
  type StepPatch,
  type TaskFilter,
  type TaskPatch,
  type UsageDelta,
} from './store.js';
export * from './types.js';
export { CROCKFORD, ID_PREFIXES, isId, newId, normalizeId, type IdKind, type IdPrefix } from './ids.js';
export { EXIT, JvError, conflict, isJvError, notFound, refused, type JvExitCode } from './errors.js';
export { JV_HOME, RUNTIME_ROOT, paths } from './paths.js';
export { packageVersion } from './version.js';
export { defaultRedactor, redact, redactValue, type Redactor } from './redact.js';

// ---- projects and tasks -----------------------------------------------------------------------------------------

export { PROJECT_NAME, addProject, listProjectRows, type AddProjectResult } from './project.js';
export {
  AUTH_FRESH_MS,
  answerTask,
  autoRequestId,
  callerIsCoordinator,
  createTask,
  formatTaskView,
  messageTask,
  normalizeText,
  overrideTask,
  overrideTask as override,
  preflightProviders,
  requireTaskId,
  resumeTask,
  runView,
  stopTask,
  taskView,
  type AnswerResult,
  type CreateTaskInput,
  type CreateTaskResult,
  type MessageResult,
  type OverrideInput,
  type OverrideResult,
  type PreflightResult,
  type ResumeResult,
  type RunView,
  type StepView,
  type StopResult,
  type TaskDeps,
  type TaskView,
} from './tasks.js';
export * as workflows from './workflows.js';

// ---- advancing, placement and landing ---------------------------------------------------------------------------

export * as advance from './advance.js';
export {
  MAX_PROGRESS,
  afterRun,
  continueRun,
  currentStep,
  finishSteps,
  recordOutcome,
  releaseDependents,
  startStep,
  type AdvanceDeps,
  type StartStepOptions,
  type StartStepResult,
} from './advance.js';
export {
  EFFORTS,
  askWorkflowQuestions,
  buildMenu,
  dutyRuntimes,
  isEffort,
  mapEffort,
  ownerPlacement,
  placeStep,
  placementContext,
  stateJson,
  type ChoiceRecord,
  type Effort,
  type JevCallRecord,
  type JevDecider,
  type Menu,
  type OwnerPlacementInput,
  type OwnerPlacementResult,
  type Placement,
  type PlacementChosen,
  type PlacementState,
  type PlaceStepInput,
  type WorkflowAnswers,
  type WorkflowQuestionsInput,
  type WorkflowState,
} from './route.js';
export {
  formatLandResult,
  landTask,
  landTask as land,
  loadLandingConfig,
  type LandOptions,
  type LandResult,
  type LandingConfig,
  type LandingRouteState,
} from './land.js';
export { formatGc, gc, gcCandidates, type GcAction, type GcOptions } from './gc.js';

// ---- runs and runtimes ------------------------------------------------------------------------------------------

export {
  createRun,
  isAlive,
  isRunAlive,
  markLost,
  spawnRun,
  stopRun,
  type CreateRunInput,
  type SpawnRunOptions,
  type SpawnedRun,
  type StopRunResult,
} from './launcher.js';
export { executeRun, prepareRun, type PreparedRun, type RunDeps, type RunOutcome } from './run.js';
export { loadRuntime } from './runtimes/index.js';
export { RunFailure, RunStopped, type McpServerSpec, type RuntimeModule, type StartInput, type TurnInput } from './runtimes/types.js';

// ---- events, reports, status --------------------------------------------------------------------------------------

export { EVENT_TEXT_MAX, eventRecorder, recordEvent, tailEvents, type RecordEventOptions, type TailOptions } from './events.js';
export {
  REPORT_ALREADY_SENT,
  REPORT_RECORDED,
  REPORT_TOOL_NAME,
  formatReport,
  parseReport,
  reportView,
  resolveReportSession,
  synthesizeReport,
  writeReport,
  type ParsedReport,
  type Report,
  type ReportInput,
  type ReportView,
  type WriteReportResult,
} from './report.js';
export { formatStatus, statusView, taskStatus, type SessionStatus, type StatusView, type TaskStatus } from './status.js';
export { formatUsageWeek, isoWeek, usageForWeek, type UsageWeek } from './usage.js';

// ---- the worker prompt ----------------------------------------------------------------------------------------------

export {
  CONTINUE_PROMPT,
  NO_REPORT_PROMPT,
  START_PROMPT,
  buildSystemAppend,
  buildSystemAppend as assemblePrompt,
  resumeMessage,
  workerRules,
  type SystemAppendInput,
  type WorkerPrompt,
} from './prompt.js';

// ---- the coordinator, wake lines, handoff and notes -------------------------------------------------------------

import * as coordinatorModule from './coordinator.js';
import { coordinatorTranscript, messageCoordinator, tailCoordinator } from './coordinator-chat.js';
/** The coordinator module, with the conversation as the brief names it: coordinator.tail, .message, .transcript. */
export const coordinator = { ...coordinatorModule, tail: tailCoordinator, message: messageCoordinator, transcript: coordinatorTranscript };
export * as coordinatorChat from './coordinator-chat.js';
export * as wake from './wake.js';
export { notifyCoordinator } from './wake.js';
export { buildHandoff, formatHandoff, type Handoff } from './handoff.js';
export { NOTES_MAX_BYTES, writeNotes, type WriteNotesResult } from './notes.js';

// ---- providers, doctor, limits, install -------------------------------------------------------------------------

export * as providers from './providers.js';
export { CHECK_NAMES, formatCheck, runChecks, runChecks as doctor, type CheckResult, type CheckStatus, type DoctorDeps } from './doctor.js';
export { DEFAULT_LIMITS, WAITING_FOR_A_SLOT, botConfigFile, readLimits, slotRefusal, slotUse, type Limits, type SlotUse } from './limits.js';
export { bootstrap, readInstall, type BootstrapOptions, type BootstrapSummary, type InstallRecord } from './bootstrap.js';

// ---- contracts ----------------------------------------------------------------------------------------------------

export * from './contracts/index.js';

// ---- monorepo additions: reconcile, changes, the bot's state, jobs, memory, worker tools ----------------------------

export { flushPendingWakes, markLostRuns, reconcile, tasksBeingStarted, type ReconcileOptions, type ReconcileSummary } from './reconcile.js';
export { formatChanges, formatChangesStat, taskChanges, type TaskChanges } from './changes.js';
export { admitTask, listTaskSummaries, recoverLostRun, taskOrigin, type TaskSummary } from './tasks.js';
export { BOT_META, botLine, readBotState, writeBotHeartbeat, type BotState } from './bot-state.js';
export { cancelJob, createJob, jobView, localDay, stepJobs, type JobHandler, type StepSummary, type WorkTaskSpec } from './jobs.js';
export { MEMORY_BLOCK_HEADING, memoryApi, memoryBlock, registerMemory, type MemoryApi } from './memory-port.js';
export { qualifiedToolName, WORKER_TOOLS_QUALIFIED, workerTools, type WorkerTool } from './tools/index.js';

// The brief's names for the session functions (section 3), aliases of the lifted ones: a step's session starts through
// startStep, a stopped, lost or waiting one is resumed (and an owner retry made) through resumeTask, a run stops through
// stopRun.
export { startStep as startSession } from './advance.js';
export { resumeTask as resumeSession, resumeTask as retry } from './tasks.js';
export { stopRun as stopSession } from './launcher.js';
