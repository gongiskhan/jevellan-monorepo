// The coordinator conversation (section 3): what the coordinator says and does, read from its native transcript into
// the store (tail); what the owner says to it, typed into its window (message); and the two as one ordered
// conversation for the UI chat and the MCP (transcript). The coordinator itself is coordinator.ts (D-052 to D-057,
// D-070, D-071); this module never starts, stops or restarts it.
//
// tailCoordinator(store, options?)
// - For every project, every coordinator session row (kind coordinator; the current one is named by meta
//   coordinator:<project id>, D-055) whose tail is not closed: reads the native transcript
//   <provider home>/.claude/projects/<cwd slug>/<native id>.jsonl (the home providers.json gives the session's
//   provider, else ~/.jv/homes/<provider>) from the byte offset in meta coordinator_tail:<session id>, and records on
//   the session row, through recordEvent (redaction, trimming), in transcript order and at the transcript's
//   timestamps: assistant `text`, `tool-call` and `tool-result` (inputs and outputs trimmed to 4000 characters, as the
//   claude-tmux runtime does), one `usage` event per read with the tokens of API calls not counted before, and
//   `message` events for the user entries Claude Code recorded (below). Thinking is not recorded: the chat shows what
//   the coordinator says and does, and the brief names these four kinds.
// - Complete lines only: an incomplete last line is left for the next call. A chunk's events and its new offset are
//   written in one transaction that first checks the stored offset is still the one the chunk was read from, so the
//   bot and the UI server tailing at once never record a line twice (the later one reads on from the new offset).
// - Usage: Claude Code writes one record per content block, each with its message's id and usage. The meta row keeps
//   the tokens already counted for the last 64 message ids, so a message split across two reads (or read again after
//   a deferral) is counted once, its larger output count winning, as UsageCollector does within one read.
// - User entries. An owner line typed by messageCoordinator comes back as the user entry " [owner]  <text>" (Claude
//   Code trims it). It is not recorded a second time: it is matched to the messages row messageCoordinator wrote
//   (direction owner, session_id the coordinator's) whose text is equal (secrets masked, whitespace collapsed) and
//   that was created at most 2 hours before the entry's timestamp (a line typed while the coordinator works waits in
//   Claude Code's queue) and at most 60 s after it, the oldest unmatched row first; matched message ids stay in the
//   meta row for that window. messageCoordinator types and records under the window's typing lock, so a prefixed
//   entry with no row while that lock is held is left (with everything after it) for the next read; with the lock
//   free, its row was never written (the typing process died), and the entry is recorded from the transcript.
//   Every other user entry is recorded as a `message` event with source transcript: "[jv] ..." wake lines and the
//   restart handoff from jv, anything else (typed in the window after jv attach, or through Remote Control) from the
//   owner. Slash-command markup, meta records, interruptions and compaction summaries are left out.
// - An ended session (stopped, lost, failed, done) read to the end of its transcript, or ended more than 10 minutes
//   ago, is closed (closed: true in its meta row) and never read again; so is one whose transcript never appeared.
//   The meta row is JSON: {offset, file, updatedAt, closed?, matched: [{id, at}], usage: [[message id, tokens]]}.
//
// messageCoordinator(store, project, text, deps?)
// - Refuses (exit 2) unless the project's coordinator is ours and running (runningCoordinator: D-055's check), and
//   while its screen shows a first-run dialog (Enter would pick "No, exit", D-053).
// - The text: CRLF made LF, control characters other than newline and tab dropped (no escape sequence reaches the
//   pane), trimmed, known secrets masked (typed, stored and recorded masked), at most 20000 characters (an event's
//   text limit, so the event holds exactly what was typed); empty is refused.
// - The transcript is tailed first, so what the coordinator said before the owner's line is recorded before it.
// - Under the window's typing lock (coordinator.ts), so it never interleaves with a wake line: " [owner]  <text>"
//   typed with send-keys -l and Enter, as wake lines are, or, when the text has a newline or a tab, loaded into a tmux
//   buffer from stdin and pasted (bracketed paste) before Enter; the owner's text never needs a shell and no secret
//   is on a command line. Then, still under the lock and in one transaction: the messages row (direction owner,
//   session_id the coordinator's, task_id the project's coordinator conversation task, delivered_at set) and a
//   `message` event {from owner, role user, text, messageId, source message} at the time typing began. Returns
//   {project, messageId, session, typedAt, how}.
//
// coordinatorTranscript(store, project, options?)
// - The conversation of one coordinator session (default: the current one, else the newest) as entries ordered by
//   time, then by seq: owner lines, jv lines (wake lines, the handoff), coordinator text, and tool calls with their
//   result joined in (one entry each, `text` a one-line summary such as "ran jv status --json"; the coordinator runs
//   jv by the installed shim's path, which its prompt names, and the summary shows that path as `jv`, so the line
//   says what was run rather than where jv lives). A turn starts at an owner or jv line; its end is the time of its last coordinator text before the next line, and responseMs runs
//   from the line to that end (the entry that ends a turn carries both). The last turn is open: the coordinator may
//   still be working. Reads the store only, unless `refresh` tails first.

import { existsSync } from 'node:fs';
import {
  capturePane,
  coordinatorTmuxName,
  HANDOFF_PREFIX,
  pasteMessage,
  readCoordinatorRecord,
  realTmux,
  runningCoordinator,
  screenState,
  typeLine,
  typingLockHolder,
  withTypingLock,
  type CoordinatorDeps,
} from './coordinator.js';
import { notFound, refused } from './errors.js';
import { EVENT_TEXT_MAX, recordEvent } from './events.js';
import { isAlive } from './launcher.js';
import { paths } from './paths.js';
import { findProvider, loadProviders, type ProvidersConfig } from './providers.js';
import { redact } from './redact.js';
import type { Store } from './store.js';
import {
  fileSize,
  findClaudeTranscript,
  nativeObject,
  nativeRecords,
  readComplete,
  transcriptEvents,
  turnsFromRecords,
  type NativeRecord,
} from './transcript.js';
import type { EventKind, EventRow, ProjectRow, SessionRow, SessionState } from './types.js';

/** What every owner line typed into the coordinator starts with: a space, the tag, two spaces. */
export const OWNER_PREFIX = ' [owner]  ';
export const TAIL_META_PREFIX = 'coordinator_tail:';
/** The longest owner line: an event's text limit (events.ts), so the event holds exactly what was typed. */
export const MESSAGE_TEXT_MAX = EVENT_TEXT_MAX;
/** How long before a transcript entry its messages row may have been written (the line waited in Claude Code). */
export const MATCH_BEFORE_MS = 2 * 60 * 60_000;
/** How long after a transcript entry its messages row may have been written (typed, then recorded). */
export const MATCH_AFTER_MS = 60_000;
/** An ended session is closed after this long even with an incomplete last line. */
export const CLOSE_AFTER_MS = 10 * 60_000;
export const USAGE_IDS_KEPT = 64;
/** Chunks read per session in one call (each at most `maxBytes`, 8 MiB by default). */
export const READS_PER_CALL = 8;
export const DEFAULT_TRANSCRIPT_LIMIT = 100;
export const MAX_TRANSCRIPT_LIMIT = 1000;
export const TOOL_SUMMARY_MAX = 200;

const ENDED_STATES: readonly SessionState[] = ['done', 'failed', 'lost', 'stopped'];
const OWNER_LINE = /^\[owner\]\s*/;
const JV_LINE = /^\[jv\]/;
/** Claude Code's markup for slash commands and their output (takeover.ts leaves the same out). */
const COMMAND_MARKUP = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;
const INTERRUPTED = /^\[Request interrupted by user/;

// ---- the tail state -------------------------------------------------------------------------------------------

interface UsageCounts {
  input: number;
  output: number;
  read: number;
  write: number;
}

export interface TailState {
  /** Byte offset after the last line read. */
  offset: number;
  /** The transcript file, once found. */
  file?: string;
  updatedAt?: string;
  /** An ended session read to its end: never read again. */
  closed?: true;
  /** Owner messages already matched to their transcript entry (message id, created_at). */
  matched?: Array<{ id: string; at: string }>;
  /** Tokens counted per API message id, newest last. */
  usage?: Array<[string, UsageCounts]>;
}

export function tailMetaKey(sessionId: string): string {
  return `${TAIL_META_PREFIX}${sessionId}`;
}

export function readTailState(store: Store, sessionId: string): TailState {
  const raw = store.getMeta(tailMetaKey(sessionId));
  if (raw === undefined) return { offset: 0 };
  try {
    const v = JSON.parse(raw) as Partial<TailState> | number;
    if (typeof v === 'number') return { offset: Number.isInteger(v) && v >= 0 ? v : 0 };
    return {
      offset: typeof v.offset === 'number' && Number.isInteger(v.offset) && v.offset >= 0 ? v.offset : 0,
      ...(typeof v.file === 'string' ? { file: v.file } : {}),
      ...(typeof v.updatedAt === 'string' ? { updatedAt: v.updatedAt } : {}),
      ...(v.closed === true ? { closed: true as const } : {}),
      ...(Array.isArray(v.matched) ? { matched: v.matched.filter((m) => typeof m?.id === 'string' && typeof m.at === 'string') } : {}),
      ...(Array.isArray(v.usage) ? { usage: v.usage.filter((u) => Array.isArray(u) && typeof u[0] === 'string' && typeof u[1] === 'object') } : {}),
    };
  } catch {
    return { offset: 0 };
  }
}

function writeTailState(store: Store, sessionId: string, state: TailState): void {
  store.setMeta(tailMetaKey(sessionId), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
}

// ---- reading transcript records -------------------------------------------------------------------------------

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

function recordTime(record: NativeRecord): string | undefined {
  const t = record.value.timestamp;
  return typeof t === 'string' && Number.isFinite(Date.parse(t)) ? t : undefined;
}

function recordByte(record: NativeRecord): number {
  return Number(record.id.slice(record.id.indexOf(':') + 1));
}

/** The text of a user entry someone typed, or undefined (tool results, meta records, markup, interruptions). */
export function typedUserText(record: NativeRecord): string | undefined {
  const v = record.value;
  if (v.type !== 'user' || v.isSidechain === true || v.isMeta === true || v.isCompactSummary === true || v.isVisibleInTranscriptOnly === true) {
    return undefined;
  }
  const turn = turnsFromRecords([record], 'claude')[0];
  if (!turn || turn.role !== 'user') return undefined;
  const text = turn.blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
  if (text === '' || COMMAND_MARKUP.test(text) || INTERRUPTED.test(text)) return undefined;
  return text;
}

/** Who a typed user entry is from, and whether messageCoordinator typed it (the owner prefix). */
export function classifyUserText(text: string): { from: 'owner' | 'jv'; typed: boolean; text: string } {
  if (OWNER_LINE.test(text)) return { from: 'owner', typed: true, text: text.replace(OWNER_LINE, '').trim() };
  if (JV_LINE.test(text) || text.startsWith(HANDOFF_PREFIX)) return { from: 'jv', typed: false, text };
  return { from: 'owner', typed: false, text };
}

/** Text as the dedupe compares it: secrets masked, whitespace collapsed. */
export function comparableText(text: string): string {
  return redact(text).replace(/\s+/g, ' ').trim();
}

// ---- tail -----------------------------------------------------------------------------------------------------

export interface TailOptions {
  /** Only this project (name or id). */
  project?: string;
  /** Only this session. */
  session?: string;
  providers?: ProvidersConfig;
  /** The provider home transcripts are read under (default: providers.json's home of the session's provider). */
  home?: string;
  /** Bytes read per chunk (default 8 MiB). */
  maxBytes?: number;
  /** Whether a pid is alive (the typing lock's holder). */
  alive?: (pid: number) => boolean;
}

export interface TailedSession {
  project: string;
  session: string;
  /** Events recorded by this call. */
  events: number;
  /** The stored offset after this call. */
  offset: number;
  file?: string;
  closed?: true;
  /** An owner line was left for the next read: its messages row is being written now. */
  deferred?: true;
  error?: string;
}

export interface TailResult {
  /** One entry per coordinator session read (normally one per project: its current coordinator). */
  projects: TailedSession[];
}

/** Reads every open coordinator transcript into the store. Idempotent; see the header. */
export function tailCoordinator(store: Store, options: TailOptions = {}): TailResult {
  const projects = options.project !== undefined ? [store.requireProject(options.project)] : store.listProjects();
  let providers: ProvidersConfig | null | undefined = options.providers;
  const homeOf = (provider: string): string => {
    if (options.home !== undefined) return options.home;
    if (providers === undefined) {
      try {
        providers = loadProviders();
      } catch {
        providers = null;
      }
    }
    return (providers ? findProvider(providers, provider)?.home : undefined) ?? paths.providerHome(provider);
  };
  const out: TailedSession[] = [];
  for (const project of projects) {
    for (const session of store.listSessions({ project_id: project.id, kind: 'coordinator' })) {
      if (options.session !== undefined && session.id !== options.session) continue;
      const state = readTailState(store, session.id);
      if (state.closed) continue;
      try {
        out.push(tailSession(store, project, session, state, homeOf, options));
      } catch (error) {
        // One unreadable transcript never stops the others (the bot tails every project each tick).
        out.push({
          project: project.name,
          session: session.id,
          events: 0,
          offset: state.offset,
          error: redact(error instanceof Error ? error.message : String(error)),
        });
      }
    }
  }
  return { projects: out };
}

interface ChunkResult {
  events: number;
  state: TailState;
  deferred: boolean;
}

function tailSession(
  store: Store,
  project: ProjectRow,
  session: SessionRow,
  initial: TailState,
  homeOf: (provider: string) => string,
  options: TailOptions,
): TailedSession {
  const ended = ENDED_STATES.includes(session.state);
  const result: TailedSession = { project: project.name, session: session.id, events: 0, offset: initial.offset };
  const file =
    initial.file !== undefined && existsSync(initial.file)
      ? initial.file
      : session.native_session_id
        ? findClaudeTranscript(homeOf(session.provider), session.cwd, session.native_session_id)
        : undefined;
  if (file === undefined) {
    if (ended && close(store, session.id, initial)) result.closed = true;
    return result;
  }
  result.file = file;
  let state: TailState = initial;
  let deferred = false;
  for (let read = 0; read < READS_PER_CALL; read++) {
    const chunk = readComplete(file, state.offset, options.maxBytes);
    if (chunk.next === state.offset && chunk.start === state.offset) break;
    const from = state.offset;
    const records = chunk.start === from ? nativeRecords(chunk.text, chunk.start).filter((r) => r.value.isSidechain !== true) : [];
    const outcome = store.tx((): { raced: TailState } | ChunkResult => {
      const now = readTailState(store, session.id);
      if (now.offset !== from || now.closed) return { raced: now };
      if (chunk.start !== from) {
        // The file is shorter than what was read (it was replaced): nothing is read twice; reading goes on from its end.
        const size = fileSize(file);
        recordEvent(store, session.id, 'error', {
          source: 'coordinator-tail',
          text: `the transcript ${file} shrank to ${size} bytes from ${from}; reading on from its end`,
        });
        const next: TailState = { ...now, file, offset: size };
        writeTailState(store, session.id, next);
        return { events: 1, state: next, deferred: false };
      }
      const r = recordChunk(store, project, session, records, { ...now, file }, chunk.next, options);
      writeTailState(store, session.id, r.state);
      return r;
    });
    if ('raced' in outcome) {
      // Another process recorded this chunk; read on from where it stopped.
      if (outcome.raced.closed) break;
      state = outcome.raced;
      continue;
    }
    result.events += outcome.events;
    state = outcome.state;
    if (outcome.deferred) {
      deferred = true;
      break;
    }
  }
  result.offset = state.offset;
  if (deferred) result.deferred = true;
  const longEnded = !!session.ended_at && Date.now() - Date.parse(session.ended_at) > CLOSE_AFTER_MS;
  if (ended && !deferred && (state.offset >= fileSize(file) || longEnded) && close(store, session.id, state)) result.closed = true;
  return result;
}

/** Marks an ended session's tail closed, unless another process moved its offset since `seen` was read. */
function close(store: Store, sessionId: string, seen: TailState): boolean {
  return store.tx(() => {
    const now = readTailState(store, sessionId);
    if (now.closed) return true;
    if (now.offset !== seen.offset) return false;
    writeTailState(store, sessionId, { ...now, closed: true });
    return true;
  });
}

/**
 * Records the events of one chunk's records (inside the caller's transaction). Stops at a typed owner line whose
 * messages row is being written right now (deferred: the offset is that line's).
 */
function recordChunk(
  store: Store,
  project: ProjectRow,
  session: SessionRow,
  records: readonly NativeRecord[],
  state: TailState,
  next: number,
  options: TailOptions,
): ChunkResult {
  const nowMs = Date.now();
  const matched = new Map((state.matched ?? []).filter((m) => nowMs - Date.parse(m.at) <= MATCH_BEFORE_MS + MATCH_AFTER_MS).map((m) => [m.id, m.at]));
  const usage = new Map(state.usage ?? []);
  const delta: UsageCounts = { input: 0, output: 0, read: 0, write: 0 };
  let apiCalls = 0;
  /** The time of the last record read: the usage event's, so the session's last_event_at never steps back. */
  let lastAt: string | undefined;
  let events = 0;
  let offset = next;
  let deferred = false;
  const callNames = new Map<string, string>();
  const tmuxName = coordinatorTmuxName(project.name);
  const emit = (kind: EventKind, payload: Record<string, unknown>, at: string | undefined) => {
    recordEvent(store, session.id, kind, payload, at !== undefined ? { at } : {});
    events++;
  };

  for (const record of records) {
    const at = recordTime(record);
    const typed = typedUserText(record);
    if (typed !== undefined) {
      const line = classifyUserText(typed);
      if (line.typed) {
        const row = matchOwnerMessage(store, session.id, line.text, at, matched);
        if (row) {
          matched.set(row.id, row.created_at);
        } else if (typingLockHolder(tmuxName, options.alive ?? isAlive)) {
          offset = recordByte(record);
          deferred = true;
          break;
        } else {
          emit('message', { from: 'owner', role: 'user', text: line.text, source: 'transcript' }, at);
        }
      } else {
        emit('message', { from: line.from, role: 'user', text: line.text, source: 'transcript' }, at);
      }
    }
    for (const e of transcriptEvents(turnsFromRecords([record], 'claude'))) {
      if (e.kind === 'thinking') continue;
      if (e.kind === 'tool-call') callNames.set(e.payload.id, e.payload.name);
      const payload: Record<string, unknown> = { ...e.payload };
      if (e.kind === 'tool-result' && callNames.has(e.payload.id)) payload.name = callNames.get(e.payload.id);
      emit(e.kind, payload, at);
    }
    const v = record.value;
    if (v.type === 'assistant') {
      const message = nativeObject(v.message);
      const u = nativeObject(message.usage);
      if (Object.keys(u).length > 0) {
        const key = typeof message.id === 'string' && message.id !== '' ? message.id : record.id;
        const before = usage.get(key);
        const counted = before ?? { input: 0, output: 0, read: 0, write: 0 };
        const now: UsageCounts = {
          input: Math.max(counted.input, count(u.input_tokens)),
          output: Math.max(counted.output, count(u.output_tokens)),
          read: Math.max(counted.read, count(u.cache_read_input_tokens)),
          write: Math.max(counted.write, count(u.cache_creation_input_tokens)),
        };
        delta.input += now.input - counted.input;
        delta.output += now.output - counted.output;
        delta.read += now.read - counted.read;
        delta.write += now.write - counted.write;
        if (!before) apiCalls++;
        usage.delete(key);
        usage.set(key, now);
      }
    }
    if (at !== undefined) lastAt = at;
  }

  if (delta.input + delta.output + delta.read + delta.write > 0) {
    emit(
      'usage',
      {
        inputTokens: delta.input,
        outputTokens: delta.output,
        cacheReadTokens: delta.read,
        cacheWriteTokens: delta.write,
        apiCalls,
        source: 'transcript',
      },
      lastAt,
    );
  }
  const kept = [...usage.entries()].slice(-USAGE_IDS_KEPT);
  return {
    events,
    deferred,
    state: {
      offset,
      ...(state.file !== undefined ? { file: state.file } : {}),
      matched: [...matched.entries()].map(([id, mAt]) => ({ id, at: mAt })),
      usage: kept,
    },
  };
}

/** The oldest unmatched owner messages row of the session with this text, written in the window around `at`. */
function matchOwnerMessage(
  store: Store,
  sessionId: string,
  text: string,
  at: string | undefined,
  matched: ReadonlyMap<string, string>,
): { id: string; created_at: string } | undefined {
  const t = at !== undefined ? Date.parse(at) : Date.now();
  const want = comparableText(text);
  return store.listMessages({ session_id: sessionId, direction: 'owner' }).find((m) => {
    if (matched.has(m.id)) return false;
    const created = Date.parse(m.created_at);
    return created >= t - MATCH_BEFORE_MS && created <= t + MATCH_AFTER_MS && comparableText(m.text) === want;
  });
}

// ---- message --------------------------------------------------------------------------------------------------

export interface MessageDeps extends Pick<CoordinatorDeps, 'tmux' | 'readCmdline'> {
  /** Options of the tail that runs before typing, or false for none. */
  tail?: Omit<TailOptions, 'project' | 'session'> | false;
}

export interface CoordinatorMessageResult {
  project: string;
  /** The messages row (on the project's coordinator conversation task). */
  messageId: string;
  /** The coordinator's session row. */
  session: string;
  /** When typing began (the time of the `message` event). */
  typedAt: string;
  /** typed: send-keys; pasted: a tmux buffer (the text has a newline or a tab). */
  how: 'typed' | 'pasted';
  /** The text as typed, after the prefix. */
  text: string;
}

/** The owner's text as it is typed and stored (see the header); refuses (exit 2) when it is empty or too long. */
export function ownerMessageText(text: string): string {
  const clean = redact(
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''),
  ).trim();
  if (clean === '') throw refused('the message is empty');
  if ([...clean].length > MESSAGE_TEXT_MAX) throw refused(`the message is longer than ${MESSAGE_TEXT_MAX} characters`);
  return clean;
}

/** Types the owner's line into the project's coordinator and records it. See the header. */
export async function messageCoordinator(store: Store, projectName: string, text: string, deps: MessageDeps = {}): Promise<CoordinatorMessageResult> {
  const tmux = deps.tmux ?? realTmux;
  const project = store.requireProject(projectName);
  const clean = ownerMessageText(text);
  const live = runningCoordinator(store, project.id, { tmux, ...(deps.readCmdline ? { readCmdline: deps.readCmdline } : {}) });
  if (!live) {
    throw refused(`the coordinator of ${project.name} is not running; start it with jv coordinator start --project ${project.name}`);
  }
  // Enter on a first-run dialog picks its default, "No, exit" (D-053): the line would end the coordinator.
  if (screenState(capturePane(tmux, live.record.tmuxSession)) === 'dialog') {
    throw refused(
      `a dialog is waiting on the coordinator screen of ${project.name}; answer it first (tmux attach -t '=${live.record.tmuxSession}')`,
    );
  }
  if (deps.tail !== false) {
    // What the coordinator said before this line is recorded before it; a failed read only delays that.
    try {
      tailCoordinator(store, { ...(deps.tail ?? {}), project: project.id, session: live.session.id });
    } catch {
      // the next tail records it
    }
  }
  const conversation = store.coordinatorTask(project.id);
  const name = live.record.tmuxSession;
  const how: CoordinatorMessageResult['how'] = /[\n\t]/.test(clean) ? 'pasted' : 'typed';
  return withTypingLock(name, () => {
    const typedAt = new Date().toISOString();
    const line = `${OWNER_PREFIX}${clean}`;
    const ok = how === 'pasted' ? pasteMessage(tmux, name, '', line) : typeLine(tmux, name, line);
    if (!ok) throw refused(`tmux did not take the message for ${name}; nothing was recorded`);
    const message = store.tx(() => {
      const row = store.createMessage({ task_id: conversation.id, session_id: live.session.id, direction: 'owner', text: clean });
      const delivered = store.markMessageDelivered(row.id, live.session.id);
      recordEvent(store, live.session.id, 'message', { from: 'owner', role: 'user', text: clean, messageId: row.id, source: 'message' }, { at: typedAt });
      return delivered;
    });
    return { project: project.name, messageId: message.id, session: live.session.id, typedAt, how, text: clean };
  });
}

// ---- transcript -----------------------------------------------------------------------------------------------

export type CoordinatorRole = 'owner' | 'jv' | 'coordinator' | 'tool';

export interface CoordinatorEntry {
  at: string;
  role: CoordinatorRole;
  text: string;
  /** The event's seq (the store order). */
  seq: number;
  /** Owner and jv lines: `message` (typed through jv) or `transcript` (read from the transcript). */
  source?: string;
  /** Owner lines typed through jv: their messages row. */
  messageId?: string;
  tool?: { id: string; name: string; input: string; output?: string; ok?: boolean };
  /** On the coordinator text that ends a turn. */
  turnEnd?: true;
  /** On the coordinator text that ends a turn: milliseconds from the turn's line to it. */
  responseMs?: number;
}

export interface CoordinatorTurn {
  /** Who started the turn (null: the coordinator spoke before any line). */
  from: 'owner' | 'jv' | null;
  promptAt: string | null;
  /** The time of the turn's last coordinator text, or null when it has none (yet). */
  endAt: string | null;
  responseMs: number | null;
  /** The last turn: no line came after it, so the coordinator may still be working. */
  open: boolean;
}

export interface CoordinatorTranscript {
  project: string;
  session: string | null;
  sessionState?: SessionState;
  entries: CoordinatorEntry[];
  turns: CoordinatorTurn[];
}

export interface TranscriptOptions {
  /** The last N entries (default 100, at most 1000). */
  limit?: number;
  /** A coordinator session of the project (default: the current one, else the newest). */
  session?: string;
  /** Tail the transcript first (options of that tail, or true). */
  refresh?: boolean | Omit<TailOptions, 'project' | 'session'>;
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`;
}

/** `command` with every word that is exactly the path `jv` (the installed shim) written as `jv`. */
function shortenJv(command: string, jv: string): string {
  if (jv === '' || !command.includes(jv)) return command;
  const escaped = jv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`(^|[\\s;&|(\`'"])${escaped}(?=$|[\\s;&|)\`'"])`, 'g'), '$1jv');
}

/**
 * One line for a tool call: "ran <command>" for Bash, else "<tool> <main argument>". The coordinator runs jv by the
 * path its prompt gives (`jv`, default the installed shim), which the line shows as `jv`.
 */
export function toolSummary(name: string, input: string, jv: string = paths.shim): string {
  let arg = input;
  try {
    const v = JSON.parse(input) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const main = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'].map((k) => o[k]).find((x) => typeof x === 'string');
      arg = typeof main === 'string' ? main : input;
    }
  } catch {
    // not JSON: the input as it is
  }
  const lines = arg.trim().split('\n');
  const first = `${lines[0]!.trim()}${lines.length > 1 ? ' ...' : ''}`;
  return cut(name === 'Bash' ? `ran ${shortenJv(first, jv)}` : `${name} ${first}`.trim(), TOOL_SUMMARY_MAX);
}

function payloadOf(row: EventRow): Record<string, unknown> {
  try {
    return nativeObject(JSON.parse(row.payload));
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function chooseSession(store: Store, project: ProjectRow, wanted: string | undefined): SessionRow | undefined {
  if (wanted !== undefined) {
    const s = store.getSession(wanted);
    if (!s || s.kind !== 'coordinator' || s.project_id !== project.id) throw notFound(`no coordinator session ${wanted} in ${project.name}`);
    return s;
  }
  const record = readCoordinatorRecord(store, project.id);
  const current = record ? store.getSession(record.sessionId) : undefined;
  return current ?? store.listSessions({ project_id: project.id, kind: 'coordinator' }).at(-1);
}

/** The conversation with a project's coordinator, ordered, with turn ends. See the header. */
export function coordinatorTranscript(store: Store, projectName: string, options: TranscriptOptions = {}): CoordinatorTranscript {
  const project = store.requireProject(projectName);
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(options.limit ?? DEFAULT_TRANSCRIPT_LIMIT)));
  let session = chooseSession(store, project, options.session);
  if (!session) return { project: project.name, session: null, entries: [], turns: [] };
  if (options.refresh) {
    tailCoordinator(store, { ...(typeof options.refresh === 'object' ? options.refresh : {}), project: project.id, session: session.id });
    session = store.getSession(session.id) ?? session;
  }

  // The newest events first, a margin beyond the limit so the turn of the first entry shown has its line.
  const rows = (
    store.db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND kind IN ('message', 'text', 'tool-call', 'tool-result') ORDER BY seq DESC LIMIT ?",
      )
      .all(session.id, limit * 4 + 100) as unknown as EventRow[]
  )
    .reverse()
    .map((row) => ({ row, payload: payloadOf(row), t: Date.parse(row.at) }))
    .sort((a, b) => a.t - b.t || a.row.seq - b.row.seq);

  const entries: CoordinatorEntry[] = [];
  const calls = new Map<string, CoordinatorEntry>();
  for (const { row, payload } of rows) {
    const base = { at: row.at, seq: row.seq };
    if (row.kind === 'message') {
      const from = str(payload.from);
      if (from !== 'owner' && from !== 'jv') continue;
      entries.push({
        ...base,
        role: from,
        text: str(payload.text),
        ...(payload.source !== undefined ? { source: str(payload.source) } : {}),
        ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
      });
    } else if (row.kind === 'text') {
      entries.push({ ...base, role: 'coordinator', text: str(payload.text) });
    } else if (row.kind === 'tool-call') {
      const entry: CoordinatorEntry = {
        ...base,
        role: 'tool',
        text: toolSummary(str(payload.name), str(payload.input)),
        tool: { id: str(payload.id), name: str(payload.name), input: str(payload.input) },
      };
      calls.set(entry.tool!.id, entry);
      entries.push(entry);
    } else if (row.kind === 'tool-result') {
      const call = calls.get(str(payload.id));
      if (call?.tool) {
        call.tool.output = str(payload.output);
        call.tool.ok = payload.ok !== false;
      } else {
        const name = str(payload.name) || 'Tool';
        entries.push({
          ...base,
          role: 'tool',
          text: `${name} result`,
          tool: { id: str(payload.id), name, input: '', output: str(payload.output), ok: payload.ok !== false },
        });
      }
    }
  }

  const turns: CoordinatorTurn[] = [];
  let turn: CoordinatorTurn | undefined;
  let lastText: CoordinatorEntry | undefined;
  const closeTurn = () => {
    if (!turn) return;
    if (lastText) {
      turn.endAt = lastText.at;
      lastText.turnEnd = true;
      if (turn.promptAt !== null) {
        turn.responseMs = Math.max(0, Date.parse(lastText.at) - Date.parse(turn.promptAt));
        lastText.responseMs = turn.responseMs;
      }
    }
    turns.push(turn);
  };
  for (const entry of entries) {
    if (entry.role === 'owner' || entry.role === 'jv') {
      closeTurn();
      turn = { from: entry.role, promptAt: entry.at, endAt: null, responseMs: null, open: false };
      lastText = undefined;
    } else if (entry.role === 'coordinator') {
      turn ??= { from: null, promptAt: null, endAt: null, responseMs: null, open: false };
      lastText = entry;
    }
  }
  closeTurn();
  if (turns.length > 0) turns[turns.length - 1]!.open = true;

  const shown = entries.slice(-limit);
  const since = shown.length > 0 ? Date.parse(shown[0]!.at) : Number.POSITIVE_INFINITY;
  return {
    project: project.name,
    session: session.id,
    sessionState: session.state,
    entries: shown,
    turns: turns.filter((t) => Date.parse(t.endAt ?? t.promptAt ?? '') >= since || (t.open && shown.length > 0)),
  };
}

/** The coordinator conversation as the brief names it (section 3): coordinator.tail and coordinator.message. */
export const coordinatorChat = {
  tail: tailCoordinator,
  message: messageCoordinator,
  transcript: coordinatorTranscript,
} as const;
