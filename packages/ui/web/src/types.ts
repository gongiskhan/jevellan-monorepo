// The shapes the web app reads from the UI server (brief section 7, the UI route contract). Each route answers the
// JSON of the matching `jv ... --json` command or MCP tool, so these types follow jevellan-core's views (status.ts
// StatusView, tasks.ts TaskView and TaskSummary, report.ts ReportView, changes.ts TaskChanges, coordinator.ts
// CoordinatorStatus, coordinator-chat.ts CoordinatorTranscript, usage.ts UsageWeek, bot-state.ts BotState) and the
// views of jevellan-scheduler, -planner and the jobs machinery (M-017), checked against the contract fixtures under
// packages/core/test/fixtures/contracts/. The web app imports no jevellan-core code (it is a browser bundle), so the
// types are written out here; a key that may be absent is optional, and the readers in api.ts accept both a bare list
// and an object wrapping it where the contract leaves that open.

export const TASK_STATES = ['queued', 'running', 'waiting-owner', 'landing', 'done', 'failed', 'stopped'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TASK_KINDS = ['feature', 'bug', 'automation', 'single'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const DUTIES = ['answer', 'converse', 'investigate', 'plan', 'implement', 'document', 'verify', 'automate'] as const;
export const MEMORY_KINDS = ['fact', 'preference', 'lesson', 'environment', 'decision'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const JOB_KINDS = ['plan', 'improve-memory', 'improve-docs', 'improve-skills'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface UiSession {
  authenticated: boolean;
  readonly: boolean;
  version: string;
}

export interface BotState {
  alive: boolean;
  pid: number | null;
  heartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  startedAt: string | null;
  tick: number | null;
  running: number;
  queued: number;
  limits: { perProject: number; total: number };
}

export interface StepRef {
  ordinal: number;
  duty: string;
  state: string;
  of: number;
}

export interface Option {
  label: string;
  description?: string;
}

/** One task of `jv status --json`. */
export interface TaskStatus {
  id: string;
  project: string;
  title: string;
  kind: string;
  state: TaskState;
  state_reason: string;
  step: StepRef | null;
  run: { id: string; model: string; provider: string; runtime: string; effort: string; state: string; lastEventAt: string | null } | null;
  lost: boolean;
  report: { session: string; status: string; summary: string } | null;
  question?: string;
  options?: Option[];
  updatedAt: string;
}

export interface SessionStatus {
  id: string;
  project: string;
  kind: string;
  task: string | null;
  step: number | null;
  runtime: string;
  provider: string;
  model: string;
  state: string;
  state_reason: string;
  lastEventAt: string | null;
  tmuxTarget: string | null;
}

export interface StatusView {
  tasks: TaskStatus[];
  sessions: SessionStatus[];
  recent: Array<{ id: string; project: string; title: string; kind: string; endedAt: string | null; landedCommit: string | null }>;
  lost: string[];
  bot: BotState;
}

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  default_branch: string;
  created_at?: string;
}

/** One task of `jv task list --json`. */
export interface TaskSummary {
  id: string;
  project: string;
  title: string;
  kind: string;
  state: TaskState;
  stateReason: string;
  origin: string;
  step: StepRef | null;
  run: { id: string; runtime: string; provider: string; model: string; effort: string; state: string; lastEventAt: string | null } | null;
  lost: boolean;
  parent: string | null;
  after: string | null;
  branch: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface ReportView {
  id: string;
  sessionId: string;
  taskId: string | null;
  stepId: string | null;
  status: 'progress' | 'done' | 'blocked' | 'needs-decision' | string;
  summary: string;
  question?: string;
  options?: Option[];
  testsRun?: { command: string; passed: boolean; summary: string };
  changedFiles: string[];
  screenshots: Array<{ path: string; caption: string; url?: string | null }>;
  limitations?: string;
  ownerCommands?: Array<{ command: string; cwd: string; why: string }>;
  ui?: unknown[];
  createdAt: string;
}

export interface RunView {
  id: string;
  runtime: string;
  provider: string;
  model: string;
  effort: string;
  state: string;
  stateReason: string;
  nativeSessionId: string | null;
  tmuxTarget: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  report?: ReportView;
}

/** What a placement decision chose (the decisions row's chosen JSON, D-033); read loosely, every key may be absent. */
export interface PlacementChosen {
  source?: string;
  duty?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  label?: string;
  effort?: string;
  choices?: Record<string, { source?: string; option?: string; probabilities?: Record<string, number> } | undefined>;
  candidates?: Array<{ name: string; kind?: string; eligible?: boolean; reason?: string }>;
}

export interface Placement {
  id: string;
  chosen: PlacementChosen | null;
  override: { model?: string; effort?: string; provider?: string; label?: string } | null;
  overrideMode: string | null;
  outcome: unknown;
  createdAt: string;
}

export interface StepView {
  id: string;
  ordinal: number;
  duty: string;
  when: string;
  state: string;
  stateReason: string;
  attempts: number;
  onFail: unknown;
  instructions: string;
  runs: RunView[];
  placements: Placement[];
}

export interface TaskMessage {
  id: string;
  direction: string;
  text: string;
  createdAt: string;
  deliveredAt: string | null;
  session: string | null;
}

export interface LandingView {
  id: string;
  route: string;
  state: string;
  reason: string;
  commit: string | null;
  createdAt: string;
  /** The checks the landing ran (M-069). */
  checks: LandingCheck[];
}

export interface LandingCheck {
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** "passed in 3.2 s", "failed (exit 1) in 3.2 s", "timed out after 120 s". */
  outcome: string;
}

/** `jv task show --json`. */
export interface TaskView {
  id: string;
  project: string;
  kind: string;
  title: string;
  text: string;
  state: TaskState;
  stateReason: string;
  origin: string;
  currentStep: number;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  landedCommit: string | null;
  visible: boolean;
  parent: string | null;
  after: string | null;
  children: Array<{ id: string; title: string; state: string }>;
  workflow: { name?: string; source?: string };
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  steps: StepView[];
  messages: TaskMessage[];
  landings: LandingView[];
}

export interface ChangedFileView {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | string;
  added: number;
  removed: number;
  binary?: boolean;
  uncommitted: boolean;
}

/** `jv task changes T --json` (M-029). */
export interface TaskChanges {
  task: string;
  branch: string;
  base: string;
  worktree: string | null;
  files: ChangedFileView[];
  diff?: string;
  truncated?: boolean;
}

/** `jv coordinator status --project N --json`. */
export interface CoordinatorStatus {
  project: string;
  tmuxSession?: string;
  running: boolean;
  screen?: string;
  sessionId?: string;
  nativeSessionId?: string;
  sessionState?: string;
  sessionReason?: string;
  provider?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  attach?: string;
}

export type CoordinatorRole = 'owner' | 'jv' | 'coordinator' | 'tool';

export interface CoordinatorEntry {
  at: string;
  role: CoordinatorRole;
  text: string;
  seq: number;
  source?: string;
  messageId?: string;
  tool?: { id: string; name: string; input: string; output?: string; ok?: boolean };
  turnEnd?: true;
  responseMs?: number;
}

export interface CoordinatorTranscript {
  project: string;
  session: string | null;
  sessionState?: string;
  entries: CoordinatorEntry[];
  turns: Array<{ from: 'owner' | 'jv' | null; promptAt: string | null; endAt: string | null; responseMs: number | null; open: boolean }>;
}

/** One event as `jv tail S --json` prints it. */
export interface EventView {
  session?: string;
  seq: number;
  at: string;
  kind: string;
  payload: unknown;
}

export interface Memory {
  id: string;
  scope: string;
  kind: MemoryKind | string;
  text: string;
  tags: string[];
  source: string;
  confidence?: number;
  status: 'active' | 'archived' | string;
  superseded_by?: string | null;
  uses: number;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  updated_at?: string;
}

/** jevellan-scheduler's scheduleView. */
export interface ScheduleView {
  id: string;
  project: string;
  name: string;
  cron: string;
  tz: string;
  kind: 'task' | 'job' | string;
  spec: { kind?: string; duty?: string; title?: string; text?: string; visible?: boolean; job?: string } | null;
  enabled: boolean;
  nextRunAt: string;
  nextRuns?: string[];
  lastRunAt: string | null;
  lastResult: string;
  createdAt: string;
  due?: boolean;
}

/** jevellan-planner's goalView. */
export interface GoalView {
  id: string;
  project: string;
  title: string;
  text: string;
  priority: number;
  state: 'open' | 'paused' | 'done' | string;
  createdAt: string;
  updatedAt: string;
}

/** jevellan-core's jobView (M-017). */
export interface JobView {
  id: string;
  project: string;
  kind: JobKind | string;
  state: 'queued' | 'running' | 'done' | 'failed' | string;
  reason: string;
  requestId?: string;
  task: string | null;
  taskState: string | null;
  input?: unknown;
  result: Record<string, unknown> | null;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface ProviderUsageRow {
  provider: string;
  observed_at: string;
  source: string;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
  local_week?: string | null;
  local_input_tokens?: number | null;
  local_output_tokens?: number | null;
  local_cost_usd?: number | null;
}

/** `jv usage --json` (core usage.ts usageForWeek). */
export interface UsageWeek {
  week: string;
  from: string;
  to: string;
  providers: Array<{
    provider: string;
    probe: ProviderUsageRow | null;
    stream: ProviderUsageRow | null;
    local: ProviderUsageRow | null;
    rows: number;
    sessions: { sessions: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null } | null;
  }>;
}

/** The lifted viewer's decisions page (packages/ui/server/views.ts). */
export interface DecisionView {
  id: string;
  kind: string;
  projectId: string | null;
  taskId: string | null;
  stepId: string | null;
  sessionId: string | null;
  createdAt: string;
  skillName?: string;
  jevModel: string;
  latencyMs: number | null;
  source: string;
  summary: string;
  answers?: Array<{ question: string; choice?: string; source?: string; probabilities?: Record<string, number> }>;
  outcome?: unknown;
  overrideMode?: string | null;
}

export interface DecisionsPage {
  filter: { kind: string | null; from: string | null; to: string | null; project: string | null; task?: string | null };
  kinds: string[];
  total: number;
  shown: number;
  decisions: DecisionView[];
}

export interface CheckResult {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL' | string;
  detail: string;
  fix?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: CheckResult[];
}

export interface BotPage {
  bot: BotState;
  config: { tickSeconds?: number; limits?: { perProject?: number; total?: number }; quietHours?: { from: string; to: string } | null; health?: { bind?: string; port?: number }; logLines?: number } & Record<string, unknown>;
  service: { file: string; installed: boolean };
  log: string[];
  queue: Array<{ id: string; project: string; title: string; reason?: string; stateReason?: string; state_reason?: string; createdAt?: string; after?: string | null }>;
}

export interface WorkflowFile {
  kind: string;
  source: string;
  file: string;
  steps: Array<{ duty: string; when?: string } | string>;
}

export interface NotesView {
  project: string;
  text: string;
}

/** The A2UI action the renderer produces (web_core ActionPayload), posted as {action}. */
export interface UiAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
  userMessage?: string;
  [key: string]: unknown;
}

/** `GET /api/providers`: the providers.json menu of the Override dialog (M-068). */
export interface ProvidersMenu {
  providers: Array<{ name: string; kind: string; models: Array<{ id: string; label: string; efforts: string[] }> }>;
}
