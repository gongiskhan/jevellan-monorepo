// bot.json (brief section 8): the bot's configuration at $JV_HOME/bot.json, written with the defaults at the bot's
// first start and validated strictly with zod: an unknown key, at any depth, exits 2 naming it (the rule every jv
// config file follows, D-011); a wrong type or value exits 2 naming the key and what it must be. A key left out takes
// its default, so a file that sets only `limits` (what jevellan-core's limits.ts reads leniently) is valid.
//
//   { "tickSeconds": 15, "limits": { "perProject": 2, "total": 4 }, "quietHours": null,
//     "health": { "bind": "127.0.0.1", "port": 7073 }, "logLines": 20000 }
//
// quietHours `{ "from": "23:00", "to": "07:00" }` is a window of local wall-clock time (the bot's process zone) in
// which the bot admits no task and fires no schedule; lost runs are still recovered and messages still delivered. A
// window whose `from` is later than its `to` runs past midnight; `from` equal to `to` is refused (it would mean either
// nothing or the whole day). health.bind is one IP address (or localhost), never a wildcard: the health endpoint is
// for this machine or one tailnet address, as the viewer's bind rule (D-064) has it.

//
// Moved here from jevellan-bot (M-057) so `jv bot status`, the MCP's jv_bot_status and the UI's /api/bot build the same
// {bot, config, service} view: jevellan-mcp and jevellan-ui may not import jevellan-bot.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { refused } from './errors.js';
import { botConfigFile, DEFAULT_LIMITS } from './limits.js';
import { z } from 'zod';
import { readBotState, type BotState } from './bot-state.js';
import { botServiceFile } from './doctor.js';
import { ownerHome } from './env.js';
import type { Store } from './store.js';

/** The defaults of section 8, written at the first start. */
export const DEFAULT_BOT_CONFIG = Object.freeze({
  tickSeconds: 15,
  limits: Object.freeze({ perProject: DEFAULT_LIMITS.perProject, total: DEFAULT_LIMITS.total }),
  quietHours: null,
  health: Object.freeze({ bind: '127.0.0.1', port: 7073 }),
  logLines: 20000,
});

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const WILDCARDS = new Set(['0.0.0.0', '::', '[::]', '*']);

const quietHoursSchema = z
  .strictObject({
    from: z.string().regex(CLOCK, 'must be a local time HH:MM (00:00 to 23:59)'),
    to: z.string().regex(CLOCK, 'must be a local time HH:MM (00:00 to 23:59)'),
  })
  .refine((q) => q.from !== q.to, { message: 'from and to are the same time; set quietHours to null for none', path: ['to'] });

export const botConfigSchema = z.strictObject({
  tickSeconds: z.number().int().min(1).max(3600).default(DEFAULT_BOT_CONFIG.tickSeconds),
  limits: z
    .strictObject({
      perProject: z.number().int().min(1).max(100).default(DEFAULT_BOT_CONFIG.limits.perProject),
      total: z.number().int().min(1).max(100).default(DEFAULT_BOT_CONFIG.limits.total),
    })
    .default({ ...DEFAULT_BOT_CONFIG.limits }),
  quietHours: quietHoursSchema.nullable().default(null),
  health: z
    .strictObject({
      bind: z
        .string()
        .refine((b) => !WILDCARDS.has(b), 'must be one address, not a wildcard')
        .refine((b) => b === 'localhost' || isIP(b) !== 0, 'must be an IP address or localhost')
        .default(DEFAULT_BOT_CONFIG.health.bind),
      port: z.number().int().min(1).max(65535).default(DEFAULT_BOT_CONFIG.health.port),
    })
    .default({ ...DEFAULT_BOT_CONFIG.health }),
  logLines: z.number().int().min(100).max(10_000_000).default(DEFAULT_BOT_CONFIG.logLines),
});

export type BotConfig = z.infer<typeof botConfigSchema>;
export type QuietHours = NonNullable<BotConfig['quietHours']>;

/** A fresh copy of the defaults. */
export function defaultBotConfig(): BotConfig {
  return {
    tickSeconds: DEFAULT_BOT_CONFIG.tickSeconds,
    limits: { ...DEFAULT_BOT_CONFIG.limits },
    quietHours: null,
    health: { ...DEFAULT_BOT_CONFIG.health },
    logLines: DEFAULT_BOT_CONFIG.logLines,
  };
}

function keyPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/** Validates parsed bot.json content; refuses (exit 2) naming the file and the first offending key. */
export function parseBotConfig(raw: unknown, file: string = botConfigFile()): BotConfig {
  const r = botConfigSchema.safeParse(raw);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  if (issue.code === 'unrecognized_keys') {
    const names = issue.keys.map((k) => keyPath([...issue.path, k]));
    throw refused(`${file}: unknown key${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')}`);
  }
  if (issue.path.length === 0) throw refused(`${file}: must be a JSON object (${issue.message})`);
  throw refused(`${file}: "${keyPath(issue.path)}" ${issue.message.replace(/^Invalid input: /, '')}`);
}

export interface LoadedBotConfig {
  config: BotConfig;
  file: string;
  /** The file did not exist and the defaults were written to it now. */
  written: boolean;
}

/**
 * Reads and validates bot.json. A missing file is written with the defaults when `writeDefaults` is set (the bot's
 * first start; mode 600, atomically) and otherwise read as the defaults. Unreadable JSON or an invalid file refuses.
 */
export function loadBotConfig(file: string = botConfigFile(), options: { writeDefaults?: boolean } = {}): LoadedBotConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw refused(`${file} cannot be read: ${(error as Error).message}`);
    const config = defaultBotConfig();
    if (!options.writeDefaults) return { config, file, written: false };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.jv-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return { config, file, written: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw refused(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return { config: parseBotConfig(raw, file), file, written: false };
}

/** bot.json validated, or the defaults when the file is missing or invalid (jv bot status, which must never fail). */
export function readBotConfigOrDefaults(file: string = botConfigFile()): { config: BotConfig; error?: string } {
  try {
    return { config: loadBotConfig(file).config };
  } catch (error) {
    return { config: defaultBotConfig(), error: error instanceof Error ? error.message : String(error) };
  }
}

function minutesOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/** Whether `now` (local wall-clock time of this process) falls in the quiet window; `from` is in, `to` is out. */
export function inQuietHours(now: Date, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** "23:00-07:00" or "none". */
export function quietText(quiet: QuietHours | null): string {
  return quiet ? `${quiet.from}-${quiet.to}` : 'none';
}

// ---- the service file and the status view (jv bot status, jv_bot_status, /api/bot) ---------------------------

/** The bot's service file on this machine and whether it exists. */
export function serviceState(platform: NodeJS.Platform = process.platform, home: string = ownerHome()): { file: string | null; installed: boolean } {
  const file = botServiceFile(platform, home) ?? null;
  return { file, installed: file !== null && existsSync(file) };
}

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
