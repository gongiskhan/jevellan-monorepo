// The bot as the store sees it (brief sections 4 and 8): the heartbeat the bot leaves every tick and the one line
// `jv status` prints first.
//
// Tick step 1 of the bot writes four meta rows: `bot:heartbeat` (ISO time of the tick), `bot:pid`, `bot:started_at`
// (ISO time the bot started) and `bot:tick` (a counter). The bot counts as alive when that pid is a live process
// (launcher.isAlive) and the heartbeat is younger than max(60, 3 x tickSeconds) seconds, tickSeconds read from
// bot.json (default 15): a bot that hangs, or one that died and left its pid to another process, reads "not running"
// within a minute or three ticks, whichever is longer. bot.json is read leniently here, as limits.ts reads it (the
// bot package validates it strictly), so a half-written file never breaks `jv status`.
//
// The counts are the machine's, whatever project a caller filters on: `running` is the tasks holding a slot
// (limits.ts slotUse, M-013), `queued` the tasks in state queued (the coordinator conversation tasks are done and
// never counted), `limits` what readLimits() gives. Reading writes nothing; writeBotHeartbeat is the writer the bot
// uses, so both sides name the rows the same way.

import { readFileSync } from 'node:fs';
import { isAlive } from './launcher.js';
import { botConfigFile, readLimits, slotUse, type Limits } from './limits.js';
import type { Store } from './store.js';

/** The meta keys of the heartbeat (section 8, tick step 1). */
export const BOT_META = {
  heartbeat: 'bot:heartbeat',
  pid: 'bot:pid',
  startedAt: 'bot:started_at',
  tick: 'bot:tick',
} as const;

/** bot.json `tickSeconds` when the file does not set it (section 8). */
export const DEFAULT_TICK_SECONDS = 15;

/** A heartbeat younger than this is never stale, however short the tick. */
export const MIN_STALE_SECONDS = 60;

export interface BotState {
  /** The pid in `bot:pid` is a live process and the heartbeat is fresh. */
  alive: boolean;
  pid: number | null;
  /** ISO time of the last heartbeat, or null when the bot never ran on this store. */
  heartbeatAt: string | null;
  /** Whole seconds since the last heartbeat, or null without one. */
  heartbeatAgeSeconds: number | null;
  startedAt: string | null;
  tick: number | null;
  /** Tasks holding a slot on this machine (limits.ts slotUse). */
  running: number;
  /** Tasks in state queued on this machine. */
  queued: number;
  limits: Limits;
}

/** `tickSeconds` of bot.json, or the default when the file, the key or its value is missing or invalid. */
export function readTickSeconds(file: string = botConfigFile()): number {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { tickSeconds?: unknown };
    const v = raw?.tickSeconds;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_TICK_SECONDS;
  } catch {
    return DEFAULT_TICK_SECONDS;
  }
}

/** How old a heartbeat may be while the bot still counts as alive: max(60, 3 x tickSeconds) seconds. */
export function heartbeatStaleSeconds(tickSeconds: number = readTickSeconds()): number {
  return Math.max(MIN_STALE_SECONDS, 3 * tickSeconds);
}

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function isoOrNull(raw: string | undefined): string | null {
  return raw !== undefined && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function ageSeconds(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
}

/** The bot's state from its heartbeat rows, the slots in use and the queue. Writes nothing. */
export function readBotState(store: Store, now: number = Date.now()): BotState {
  const heartbeatAt = isoOrNull(store.getMeta(BOT_META.heartbeat));
  const pid = positiveInt(store.getMeta(BOT_META.pid));
  const heartbeatAgeSeconds = heartbeatAt === null ? null : ageSeconds(heartbeatAt, now);
  const alive = pid !== null && heartbeatAgeSeconds !== null && heartbeatAgeSeconds < heartbeatStaleSeconds() && isAlive(pid);
  return {
    alive,
    pid,
    heartbeatAt,
    heartbeatAgeSeconds,
    startedAt: isoOrNull(store.getMeta(BOT_META.startedAt)),
    tick: nonNegativeInt(store.getMeta(BOT_META.tick)),
    running: slotUse(store).total,
    queued: store.listTasks({ states: ['queued'] }).length,
    limits: readLimits(),
  };
}

/** "4 s ago", "3 min ago", "2 h ago", "5 d ago". */
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'never';
  const s = ageSeconds(iso, now);
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * The first line of `jv status`, exactly "bot: alive 4 s ago (pid 48211) · running 2/4 · queued 1" (running n of
 * the machine's total limit; the separator is U+00B7) or "bot: not running".
 */
export function botLine(state: BotState, now: number = Date.now()): string {
  if (!state.alive || state.heartbeatAt === null || state.pid === null) return 'bot: not running';
  return `bot: alive ${ago(state.heartbeatAt, now)} (pid ${state.pid}) · running ${state.running}/${state.limits.total} · queued ${state.queued}`;
}

export interface BotHeartbeat {
  pid: number;
  /** ISO time the bot started. */
  startedAt: string;
  /** The tick counter. */
  tick: number;
  /** ISO time of this heartbeat; default now. */
  at?: string;
}

/** Writes the four heartbeat rows in one transaction (the bot's tick step 1). */
export function writeBotHeartbeat(store: Store, beat: BotHeartbeat): void {
  const at = beat.at ?? new Date().toISOString();
  store.tx(() => {
    store.setMeta(BOT_META.heartbeat, at);
    store.setMeta(BOT_META.pid, String(beat.pid));
    store.setMeta(BOT_META.startedAt, beat.startedAt);
    store.setMeta(BOT_META.tick, String(beat.tick));
  });
}
