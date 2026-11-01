// jevellan-bot (brief section 8): the always-on loop. runBot is `jv bot start` (foreground; what the service file
// runs), tickOnce and tick are `jv bot tick`, installService writes the launchd or systemd file `jv bot install-service`
// prints the load command for, and botStatusView is the {bot, config, service} of `jv bot status`. The bot runs no
// model itself; every piece of work it starts is a step of a task, placed by Jev and run by jevellan-core's runtimes.

export {
  botConfigSchema,
  DEFAULT_BOT_CONFIG,
  defaultBotConfig,
  inQuietHours,
  loadBotConfig,
  parseBotConfig,
  quietText,
  readBotConfigOrDefaults,
  type BotConfig,
  type LoadedBotConfig,
  type QuietHours,
} from './config.js';
export { healthBody, startHealthServer, type HealthBody, type HealthServer } from './health.js';
export { acquireBotLock, botLockFile, checkLockHolder, lockHolderAlive, readBotLock, type BotLock, type LockContent, type LockHolderCheck } from './lock.js';
export { botLogFile, cleanLine, lastLogLines, openBotLog, REPEAT_LOG_MS, trimLog, type BotLog } from './log.js';
export { ensureMemory } from './memory.js';
export { runBot, STOP_DEADLINE_MS, tickOnce, type BotRunResult, type BotStarted, type RunBotOptions, type TickOnceOptions } from './run.js';
export {
  formatInstallService,
  installService,
  plistText,
  serviceState,
  SYSTEMD_UNIT,
  systemdQuote,
  systemdUnitText,
  xmlEscape,
  type InstallServiceOptions,
  type InstallServiceResult,
} from './service.js';
export { botStatusView, formatBotStatus, lastBotError, type BotLastError, type BotStatusOptions, type BotStatusView } from './status.js';
export {
  BOT_TICK_META,
  createQueuedTask,
  defaultTickDeps,
  formatTick,
  HOUSEKEEPING_EVERY_MS,
  probeReadyProviders,
  tick,
  TICK_STEPS,
  type HousekeepingSummary,
  type TickDeps,
  type TickError,
  type TickStep,
  type TickStepResult,
  type TickSummary,
} from './tick.js';
