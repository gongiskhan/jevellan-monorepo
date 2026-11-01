// The bot's process (brief section 8): runBot is `jv bot start` (foreground; what the service file runs), tickOnce is
// `jv bot tick` (exactly one tick, then exit; the tests and journeys use it so they do not depend on timing).
//
// runBot, in order: bot.json is read and validated (written with the defaults when missing; invalid refuses, exit 2,
// before anything else happens); the lock $JV_HOME/run/bot.lock is taken (a live bot refuses with exit 2 "bot
// already running (pid N)"; a stale lock is taken over with a log line); the store is opened and a first heartbeat
// written (tick 0), so the health endpoint never answers without one; the health endpoint starts on health.bind and
// health.port (a taken port refuses, exit 2); then `onStarted` (the command prints its start line here) and the loop:
// one tick, then a wait until tickSeconds after that tick's start. bot.json is read again when its modification time
// changes: new limits, quiet hours, tick and log sizes apply from the next tick; an invalid edit is logged and the
// running configuration kept; a new health bind or port needs a restart (logged).
//
// SIGTERM (and SIGINT): the running sub-step finishes, the rest of the tick is skipped, the lock is released, the
// health endpoint closed, the store closed, and runBot resolves (the command exits 0). If the sub-step has not finished
// 9 s after the signal (a slow Jev call during an admission), the lock is released and the endpoint closed anyway and
// `exit(0)` is called, so the bot is gone within 10 s; the abandoned sub-step loses nothing (each write is its own
// transaction, and reconcile recovers a run whose spawner died, M-024).
//
// tickOnce takes the same lock (as command "tick"), so a tick never runs beside a running bot and never overwrites
// its heartbeat; it writes the defaults of a missing bot.json as a first start does.
//
// Both clear meta bot:pid when they end (while it still holds their own pid), keeping the heartbeat's time: the store
// then says at once that no bot runs ("bot not running; last heartbeat 4 s ago"), also when the process that ran the
// bot goes on living (a test, a host that runs ticks), and a pid reused later never reads as the bot.

import { statSync } from 'node:fs';
import { BOT_META, writeBotHeartbeat } from 'jevellan-core/bot-state';
import { botConfigFile } from 'jevellan-core/limits';
import { openStore, type Store } from 'jevellan-core/store';
import { loadBotConfig, quietText, type BotConfig } from './config.js';
import { startHealthServer, type HealthServer } from './health.js';
import { acquireBotLock, type BotLock } from './lock.js';
import { openBotLog, type BotLog } from './log.js';
import { ensureMemory } from './memory.js';
import { BOT_TICK_META, tick, type TickDeps, type TickSummary } from './tick.js';

/** How long a stop waits for the running sub-step before the bot exits anyway (the brief allows 10 s in total). */
export const STOP_DEADLINE_MS = 9_000;

export interface BotStarted {
  pid: number;
  startedAt: string;
  configFile: string;
  /** bot.json did not exist and was written with the defaults. */
  configWritten: boolean;
  config: BotConfig;
  health: { url: string; bind: string; port: number };
  log: string;
  /** The pid of a stale lock this start took over (null when the stale file named none). */
  tookOver?: number | null;
}

export interface BotRunResult {
  pid: number;
  startedAt: string;
  ticks: number;
  /** What stopped it: "SIGTERM", "SIGINT", "stopped" (the caller's signal) or "max ticks". */
  reason: string;
  /** The stop deadline passed and the bot exited without waiting for the sub-step. */
  forced: boolean;
}

export interface RunBotOptions {
  configFile?: string;
  /** Stop on SIGTERM and SIGINT (default true). */
  handleSignals?: boolean;
  /** A caller's stop. */
  signal?: AbortSignal;
  /** Stop after this many ticks (tests). */
  maxTicks?: number;
  /** Called once the lock, the store and the health endpoint are up, before the first tick. */
  onStarted?: (info: BotStarted) => void;
  /** Called after every tick. */
  onTick?: (summary: TickSummary) => void;
  /** What each tick uses instead of the real sub-steps (tests). */
  deps?: Partial<Omit<TickDeps, 'run' | 'stopping' | 'log'>>;
  log?: BotLog;
  /** Default STOP_DEADLINE_MS. */
  stopDeadlineMs?: number;
  /** What a stop past its deadline calls once the lock is released (default process.exit). */
  exit?: (code: number) => void;
  /** Health port override (0 picks a free one; tests). */
  healthPort?: number;
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Clears bot:pid when it still names this process (the bot or the tick ended). */
function clearBotPid(store: Store): void {
  try {
    if (store.getMeta(BOT_META.pid) === String(process.pid)) store.setMeta(BOT_META.pid, '');
  } catch {
    // the store is busy or closed: the dead pid reads as not running anyway
  }
}

function startLine(info: BotStarted): string {
  const c = info.config;
  return (
    `started (pid ${info.pid}): tick every ${c.tickSeconds} s, limits ${c.limits.perProject} per project and ${c.limits.total} in total, ` +
    `quiet hours ${quietText(c.quietHours)}, health ${info.health.url}`
  );
}

/** Runs the bot in the foreground until a stop (see the header). */
export async function runBot(options: RunBotOptions = {}): Promise<BotRunResult> {
  const configFile = options.configFile ?? botConfigFile();
  const log = options.log ?? openBotLog();
  const loaded = loadBotConfig(configFile, { writeDefaults: true });
  let config = loaded.config;
  let configMtime = mtimeOf(configFile);
  const lock = acquireBotLock({
    command: 'start',
    onTakeover: (pid) => log.line(`took over the bot lock of pid ${pid ?? 'unknown'}, which is not running`),
  });
  const pid = process.pid;
  const startedAt = new Date().toISOString();
  let store: Store | undefined;
  let health: HealthServer | undefined;
  let stopReason: string | undefined;
  let forced = false;
  let finished = false;
  let ticks = 0;
  let wake: (() => void) | undefined;
  let deadline: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    if (store) clearBotPid(store);
    lock.release();
    void health?.close();
    health = undefined;
  };
  const requestStop = (reason: string): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    log.line(`stopping (${reason}): finishing the current sub-step`);
    wake?.();
    deadline = setTimeout(() => {
      if (finished) return;
      forced = true;
      log.line(`stopped (${reason}) after ${ticks} ticks: the current sub-step did not finish within ${Math.round((options.stopDeadlineMs ?? STOP_DEADLINE_MS) / 1000)} s`);
      cleanup();
      (options.exit ?? ((code: number) => process.exit(code)))(0);
    }, options.stopDeadlineMs ?? STOP_DEADLINE_MS);
    deadline.unref();
  };
  const onSigterm = (): void => requestStop('SIGTERM');
  const onSigint = (): void => requestStop('SIGINT');
  const onAbort = (): void => requestStop('stopped');
  if (options.handleSignals !== false) {
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
  }
  options.signal?.addEventListener('abort', onAbort);

  try {
    ensureMemory();
    store = openStore();
    writeBotHeartbeat(store, { pid, startedAt, tick: 0 });
    health = await startHealthServer(store, { bind: config.health.bind, port: options.healthPort ?? config.health.port, tickSeconds: config.tickSeconds });
    const info: BotStarted = {
      pid,
      startedAt,
      configFile,
      configWritten: loaded.written,
      config,
      health: { url: health.url, bind: health.bind, port: health.port },
      log: log.file,
      ...(lock.tookOver !== undefined ? { tookOver: lock.tookOver } : {}),
    };
    log.line(startLine(info));
    if (loaded.written) log.line(`wrote the defaults to ${configFile}`);
    options.onStarted?.(info);
    if (options.signal?.aborted) requestStop('stopped');

    while (stopReason === undefined) {
      const mtime = mtimeOf(configFile);
      if (mtime !== configMtime) {
        configMtime = mtime;
        try {
          const next = loadBotConfig(configFile).config;
          if (next.health.bind !== config.health.bind || next.health.port !== config.health.port) {
            log.line('bot.json changed health.bind or health.port: restart the bot (jv bot stop, jv bot start) to move the endpoint');
          }
          config = next;
          log.line(`bot.json changed: tick every ${config.tickSeconds} s, limits ${config.limits.perProject} and ${config.limits.total}, quiet hours ${quietText(config.quietHours)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.line(`error in config: ${message}; keeping the configuration the bot started with`);
          try {
            store.setMeta(BOT_TICK_META.lastError, JSON.stringify({ at: new Date().toISOString(), step: 'config', message }));
          } catch {
            // the store is busy: the log line has it
          }
        }
      }
      ticks++;
      const t0 = Date.now();
      const summary = await tick(store, config, {
        ...options.deps,
        log,
        run: { pid, startedAt, tick: ticks },
        stopping: () => stopReason !== undefined,
      });
      options.onTick?.(summary);
      if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
        if (stopReason === undefined) stopReason = 'max ticks';
        break;
      }
      const wait = Math.max(0, config.tickSeconds * 1000 - (Date.now() - t0));
      if (stopReason !== undefined || wait === 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
    return { pid, startedAt, ticks, reason: stopReason ?? 'stopped', forced };
  } catch (error) {
    stopReason ??= `could not run: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    finished = true;
    if (deadline) clearTimeout(deadline);
    if (options.handleSignals !== false) {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    }
    options.signal?.removeEventListener('abort', onAbort);
    const closing = health?.close();
    health = undefined;
    await closing;
    if (store) clearBotPid(store);
    try {
      store?.close();
    } catch {
      // closed already
    }
    lock.release();
    if (!forced) log.line(`stopped (${stopReason ?? 'stopped'}) after ${ticks} tick${ticks === 1 ? '' : 's'}`);
  }
}

export interface TickOnceOptions {
  configFile?: string;
  deps?: Partial<Omit<TickDeps, 'run' | 'stopping' | 'log'>>;
  log?: BotLog;
}

/** One tick under the bot lock (jv bot tick): refuses while a bot runs; writes bot.json's defaults when missing. */
export async function tickOnce(options: TickOnceOptions = {}): Promise<TickSummary> {
  const configFile = options.configFile ?? botConfigFile();
  const log = options.log ?? openBotLog();
  const loaded = loadBotConfig(configFile, { writeDefaults: true });
  const lock: BotLock = acquireBotLock({
    command: 'tick',
    onTakeover: (pid) => log.line(`took over the bot lock of pid ${pid ?? 'unknown'}, which is not running`),
  });
  try {
    if (loaded.written) log.line(`wrote the defaults to ${configFile}`);
    ensureMemory();
    const store = openStore();
    try {
      const startedAt = new Date().toISOString();
      return await tick(store, loaded.config, { ...options.deps, log, run: { pid: process.pid, startedAt, tick: 1 }, stopping: () => false });
    } finally {
      clearBotPid(store);
      store.close();
    }
  } finally {
    lock.release();
  }
}
