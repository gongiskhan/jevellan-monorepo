// `jv bot status` (brief section 8): the bot as the store sees it, so it works when the bot is not running ("bot not
// running; last heartbeat 2 h ago"). The JSON is the contract every surface shares, {bot, config, service}: `bot` is
// jevellan-core's readBotState (heartbeat, pid, tick, the slots in use and the queue, the limits), `config` the
// validated bot.json with its defaults filled in (the defaults when the file is missing or invalid; the text names
// the problem), `service` the service file this machine would have and whether it exists. The text adds the last
// error the bot recorded (meta bot:last_error) and the health URL.

import { ago, readBotState, type BotState } from 'jevellan-core/bot-state';
import { ownerHome } from 'jevellan-core/env';
import { botConfigFile } from 'jevellan-core/limits';
import type { Store } from 'jevellan-core/store';
import { quietText, readBotConfigOrDefaults, type BotConfig } from './config.js';
import { serviceState } from './service.js';
import { BOT_TICK_META } from './tick.js';

export interface BotStatusView {
  bot: BotState;
  config: BotConfig;
  service: { file: string | null; installed: boolean };
}

export interface BotStatusOptions {
  configFile?: string;
  platform?: NodeJS.Platform;
  ownerHome?: string;
  now?: number;
}

/** The {bot, config, service} view of jv bot status --json. Writes nothing. */
export function botStatusView(store: Store, options: BotStatusOptions = {}): BotStatusView {
  return {
    bot: readBotState(store, options.now),
    config: readBotConfigOrDefaults(options.configFile ?? botConfigFile()).config,
    service: serviceState(options.platform ?? process.platform, options.ownerHome ?? ownerHome()),
  };
}

export interface BotLastError {
  at: string;
  step: string;
  message: string;
}

/** The last error a tick recorded, or undefined. */
export function lastBotError(store: Store): BotLastError | undefined {
  try {
    const v = JSON.parse(store.getMeta(BOT_TICK_META.lastError) ?? '') as Partial<BotLastError>;
    if (typeof v.at === 'string' && typeof v.step === 'string' && typeof v.message === 'string') return { at: v.at, step: v.step, message: v.message };
  } catch {
    // none recorded
  }
  return undefined;
}

function cut(line: string, max = 100): string {
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function clock(iso: string, now: Date): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** "14 min", "3 h", "2 d" since an ISO time. */
function uptime(iso: string, now: number): string {
  return ago(iso, now).replace(/ ago$/, '');
}

/** The text of jv bot status. */
export function formatBotStatus(view: BotStatusView, extra: { configError?: string; lastError?: BotLastError; configFile?: string; now?: number } = {}): string {
  const now = extra.now ?? Date.now();
  const { bot, config, service } = view;
  const lines: string[] = [];
  if (bot.alive) {
    lines.push(`bot running (pid ${bot.pid}), last heartbeat ${ago(bot.heartbeatAt, now)}, tick ${bot.tick ?? '?'}${bot.startedAt ? `, up ${uptime(bot.startedAt, now)}` : ''}`);
  } else {
    lines.push(bot.heartbeatAt ? `bot not running; last heartbeat ${ago(bot.heartbeatAt, now)}` : 'bot not running; no heartbeat yet');
  }
  lines.push(`running ${bot.running} of ${bot.limits.total} (at most ${bot.limits.perProject} per project), queued ${bot.queued}`);
  lines.push(`tick every ${config.tickSeconds} s, quiet hours ${quietText(config.quietHours)}, log kept to ${config.logLines} lines`);
  lines.push(`health http://${config.health.bind.includes(':') ? `[${config.health.bind}]` : config.health.bind}:${config.health.port}/health`);
  if (extra.configError) lines.push(cut(`bot.json is invalid, defaults shown: ${extra.configError}`));
  if (service.file === null) lines.push(`service: none on ${process.platform} (run jv bot start in a terminal)`);
  else lines.push(service.installed ? `service: installed (${service.file})` : 'service: not installed; jv bot install-service writes it');
  if (extra.lastError) lines.push(cut(`last error ${clock(extra.lastError.at, new Date(now))} in ${extra.lastError.step}: ${extra.lastError.message}`));
  return lines.join('\n');
}
