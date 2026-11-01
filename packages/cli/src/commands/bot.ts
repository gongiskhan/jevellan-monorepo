// jv bot start|stop|status|tick|install-service (brief sections 4 and 8): the always-on loop of jevellan-bot.
//
//   jv bot start             the bot in the foreground (what the service file runs) until SIGTERM or Ctrl-C; prints
//                            one start line (with --json, {bot: the start facts}) before the first tick
//   jv bot stop              SIGTERM to the pid in $JV_HOME/run/bot.lock, then waits up to 10 s for it to go; "bot
//                            not running" (exit 0) when no live bot holds the lock; exit 2 when it did not stop
//   jv bot status            from the store, so it works when the bot is not running; --json is {bot, config,
//                            service} (jevellan-bot's botStatusView), the contract the MCP tool and the UI share
//   jv bot tick              exactly one tick under the bot lock, then exit; prints the tick's summary
//   jv bot install-service   writes the launchd plist (macOS) or systemd user unit (Linux) and prints the command
//                            that loads it; jv never loads it. --owner-home DIR (internal, not in --help) writes
//                            under another home instead of the owner's: the tests and M14 use it.

import { resolve } from 'node:path';
import type { CommandIo, ParsedArgs } from '../command.js';
import { flagString } from '../command.js';
import {
  botStatusView,
  formatBotStatus,
  formatInstallService,
  formatTick,
  installService,
  lastBotError,
  lockHolderAlive,
  readBotConfigOrDefaults,
  readBotLock,
  runBot,
  serviceState,
  tickOnce,
  type BotStarted,
} from 'jevellan-bot';
import { refused } from 'jevellan-core/errors';
import { isAlive } from 'jevellan-core/launcher';
import { openStore } from 'jevellan-core/store';

/** How long jv bot stop waits for the bot to exit (section 8). */
export const STOP_WAIT_MS = 10_000;

function startText(info: BotStarted): string {
  const c = info.config;
  return [
    `jv bot started (pid ${info.pid}), tick every ${c.tickSeconds} s; Ctrl-C or jv bot stop stops it`,
    `health ${info.health.url}`,
    `log ${info.log}`,
    ...(info.configWritten ? [`wrote the defaults to ${info.configFile}`] : []),
    ...(info.tookOver !== undefined ? [`took over a stale lock (pid ${info.tookOver ?? 'unknown'})`] : []),
  ].join('\n');
}

async function stop(io: CommandIo): Promise<number> {
  const holder = readBotLock();
  if (!holder || !lockHolderAlive(holder.pid)) {
    io.result({ stopped: false, pid: holder?.pid ?? null, reason: 'bot not running' }, 'bot not running');
    return 0;
  }
  const pid = holder.pid;
  process.kill(pid, 'SIGTERM');
  const t0 = Date.now();
  while (Date.now() - t0 < STOP_WAIT_MS) {
    if (!isAlive(pid) || readBotLock()?.pid !== pid) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (isAlive(pid) && readBotLock()?.pid === pid) throw refused(`the bot (pid ${pid}) did not stop within ${STOP_WAIT_MS / 1000} s`);
  const waitedMs = Date.now() - t0;
  io.result({ stopped: true, pid, reason: 'SIGTERM', waitedMs }, `bot stopped (pid ${pid}, ${(waitedMs / 1000).toFixed(1)} s)`);
  const service = serviceState();
  if (service.installed && process.platform === 'darwin') {
    io.info(`If launchd runs the bot (${service.file}), KeepAlive starts it again: launchctl bootout gui/$(id -u)/dev.jevellan.bot stops it for good.`);
  }
  return 0;
}

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = args.positionals[0] ?? 'status';
  switch (sub) {
    case 'start': {
      const result = await runBot({ onStarted: (info) => io.result({ bot: info }, startText(info)) });
      io.info(`jv bot stopped (${result.reason}) after ${result.ticks} tick${result.ticks === 1 ? '' : 's'}`);
      return 0;
    }
    case 'stop':
      return stop(io);
    case 'status': {
      const store = openStore();
      try {
        const view = botStatusView(store);
        const { error } = readBotConfigOrDefaults();
        if (error && io.json) io.warn(`jv: ${error}`);
        io.result(view, () => formatBotStatus(view, { ...(error ? { configError: error } : {}), ...(lastBotError(store) ? { lastError: lastBotError(store)! } : {}) }));
        return 0;
      } finally {
        store.close();
      }
    }
    case 'tick': {
      const summary = await tickOnce();
      io.result(summary, () => formatTick(summary));
      return 0;
    }
    case 'install-service': {
      const home = flagString(args, 'owner-home');
      const r = installService(process.platform, home ? { ownerHome: resolve(home) } : {});
      io.result(r, () => formatInstallService(r));
      return 0;
    }
    default:
      throw refused(`unknown subcommand "jv bot ${sub}" (start, stop, status, tick or install-service)`);
  }
}
