// The bot's service files (brief section 8), written by `jv bot install-service` and never loaded: loading a launchd
// job or a systemd unit is the owner's action, so the command prints the command that does it and the one that undoes
// it, and runs neither.
//
// - macOS: ~/Library/LaunchAgents/dev.jevellan.bot.plist (doctor's botServiceFile and BOT_SERVICE_LABEL, distinct from
//   Jevellan's dev.jevellan.daemon): ProgramArguments the Node binary recorded at bootstrap (install.json nodePath,
//   D-001), --disable-warning=ExperimentalWarning, <checkout>/packages/cli/dist/bin.js (install.json cliEntry,
//   M-007), bot, start; EnvironmentVariables PATH, HOME and JV_HOME; RunAtLoad and KeepAlive true; stdout and stderr to
//   $JV_HOME/logs/bot.launchd.log. Printed: `launchctl bootstrap gui/$(id -u) <plist>` and the matching
//   `launchctl bootout gui/$(id -u)/dev.jevellan.bot`.
// - Linux: ~/.config/systemd/user/jevellan-bot.service with the same command and environment, Restart=always,
//   RestartSec=5; printed: `systemctl --user daemon-reload` and `systemctl --user enable --now jevellan-bot`, and the
//   `disable --now` that undoes it.
//
// PATH is the folders of node (the recorded binary), git, tmux, claude and codex as found on this process's PATH at
// install time, in that order, then the system folders /usr/bin, /bin, /usr/sbin, /sbin (launchd's own default,
// where ps, lsof and sh live); a tool that is not found is named in `warnings`. HOME is the owner's own home
// (env.ownerHome: the user database, never a provider home's HOME). The files go under the owner's home; tests and
// the M14 journey give another one.
//
// An existing file with the same content is left as it is (written false). A different one is moved to
// $JV_HOME/archive/service/<name>-<UTC stamp><ext> first (archive, never delete; never overwritten silently).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { checkoutCliEntry, readInstall } from 'jevellan-core/bootstrap';
import { BOT_SERVICE_LABEL, botServiceFile } from 'jevellan-core/doctor';
import { bootstrapNode, ownerHome } from 'jevellan-core/env';
import { refused } from 'jevellan-core/errors';
import { paths } from 'jevellan-core/paths';
import { executableOnPath } from 'jevellan-core/runtimes/claude-tmux';

/** The systemd unit name (section 8). */
export const SYSTEMD_UNIT = 'jevellan-bot';
/** launchd's default PATH, appended after the tools' folders. */
export const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;
export const SERVICE_TOOLS = ['node', 'git', 'tmux', 'claude', 'codex'] as const;
export type ServiceTool = (typeof SERVICE_TOOLS)[number];

export interface InstallServiceOptions {
  /** The owner's home the file goes under (default env.ownerHome()). */
  ownerHome?: string;
  /** JV_HOME of the service (default this process's). */
  jvHome?: string;
  /** The Node binary (default install.json nodePath, else this process's). */
  nodePath?: string;
  /** The jv entry (default install.json cliEntry, else this checkout's packages/cli/dist/bin.js). */
  cliEntry?: string;
  /** The PATH the tools are looked up on (default this process's). */
  searchPath?: string;
  now?: Date;
}

export interface InstallServiceResult {
  platform: NodeJS.Platform;
  label: string;
  file: string;
  /** False when the file already had exactly this content. */
  written: boolean;
  /** Where a different file that was there went. */
  archived?: string;
  programArguments: string[];
  environment: { PATH: string; HOME: string; JV_HOME: string };
  log: string | null;
  tools: Record<ServiceTool, string | null>;
  /** The commands the owner runs to load the service, and to unload it. jv runs neither. */
  load: string[];
  unload: string[];
  warnings: string[];
}

/** XML text with &, <, > and quotes escaped. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** The launchd property list of the bot. */
export function plistText(input: { label: string; programArguments: readonly string[]; environment: Record<string, string>; log: string }): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by jv bot install-service (Jevellan bot). Load it with launchctl bootstrap; jv never loads it. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(input.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...input.programArguments.map((a) => `    ${s(a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(input.environment).flatMap(([k, v]) => [`    <key>${xmlEscape(k)}</key>`, `    ${s(v)}`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  ${s(input.log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${s(input.log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** One systemd word, double-quoted: backslash and quote escaped, `%` and `$` doubled (no specifier, no variable). */
export function systemdQuote(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** The systemd user unit of the bot. */
export function systemdUnitText(input: { programArguments: readonly string[]; environment: Record<string, string> }): string {
  return [
    '# Written by jv bot install-service (Jevellan bot). Enable it with systemctl --user; jv never loads it.',
    '[Unit]',
    'Description=Jevellan bot (jv bot start)',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${input.programArguments.map(systemdQuote).join(' ')}`,
    ...Object.entries(input.environment).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    'Restart=always',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Moves a file, across volumes too (a copy and an unlink only when rename cannot). */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** A path under the real owner's home written with ~/, as the owner types it. */
function tilde(file: string): string {
  const home = ownerHome();
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** Writes the bot's service file for `platform` (darwin or linux; anything else refuses). See the header. */
export function installService(platform: NodeJS.Platform = process.platform, options: InstallServiceOptions = {}): InstallServiceResult {
  const home = options.ownerHome ?? ownerHome();
  const file = botServiceFile(platform, home);
  if (file === undefined) throw refused(`the bot has service files for macOS and Linux only, not ${platform}; run jv bot start in a terminal instead`);
  const jvHome = options.jvHome ?? paths.home;
  const install = readInstall();
  const node = options.nodePath ?? bootstrapNode();
  const cliEntry = options.cliEntry ?? (install?.cliEntry && existsSync(install.cliEntry) ? install.cliEntry : checkoutCliEntry());
  const searchPath = options.searchPath ?? process.env.PATH ?? '';
  const warnings: string[] = [];

  const tools = {} as Record<ServiceTool, string | null>;
  for (const tool of SERVICE_TOOLS) {
    const found = tool === 'node' ? node : executableOnPath(tool, searchPath);
    tools[tool] = found.includes('/') ? found : null;
    if (tools[tool] === null) warnings.push(`${tool} was not found on PATH; the bot's PATH leaves its folder out`);
  }
  if (!existsSync(cliEntry)) warnings.push(`${cliEntry} does not exist yet: run npm run build in the checkout before loading the service`);
  const folders: string[] = [];
  for (const dir of [...SERVICE_TOOLS.map((t) => (tools[t] ? dirname(tools[t]!) : undefined)), ...SYSTEM_PATH]) {
    if (dir && !folders.includes(dir)) folders.push(dir);
  }
  const environment = { PATH: folders.join(':'), HOME: home, JV_HOME: jvHome };
  const programArguments = [node, '--disable-warning=ExperimentalWarning', cliEntry, 'bot', 'start'];
  const log = platform === 'darwin' ? join(jvHome, 'logs', 'bot.launchd.log') : null;
  const text =
    platform === 'darwin'
      ? plistText({ label: BOT_SERVICE_LABEL, programArguments, environment, log: log! })
      : systemdUnitText({ programArguments, environment });

  let written = false;
  let archived: string | undefined;
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (current !== text) {
    if (current !== undefined) {
      const ext = extname(file);
      archived = join(paths.archiveDir, 'service', `${basename(file, ext)}-${stamp(options.now ?? new Date())}${ext}`);
      moveFile(file, archived);
    }
    mkdirSync(dirname(file), { recursive: true });
    if (log) mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    const tmp = `${file}.jv-${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, file);
    written = true;
  }

  const shown = tilde(file);
  const load =
    platform === 'darwin'
      ? [`launchctl bootstrap gui/$(id -u) ${shown}`]
      : ['systemctl --user daemon-reload', `systemctl --user enable --now ${SYSTEMD_UNIT}`];
  const unload = platform === 'darwin' ? [`launchctl bootout gui/$(id -u)/${BOT_SERVICE_LABEL}`] : [`systemctl --user disable --now ${SYSTEMD_UNIT}`];
  return {
    platform,
    label: platform === 'darwin' ? BOT_SERVICE_LABEL : SYSTEMD_UNIT,
    file,
    written,
    ...(archived ? { archived } : {}),
    programArguments,
    environment,
    log,
    tools,
    load,
    unload,
    warnings,
  };
}

/** The service file this machine would have and whether it exists (jv bot status, the UI's /bot page). */
export function serviceState(platform: NodeJS.Platform = process.platform, home: string = ownerHome()): { file: string | null; installed: boolean } {
  const file = botServiceFile(platform, home) ?? null;
  return { file, installed: file !== null && existsSync(file) };
}

/** The text of `jv bot install-service`. */
export function formatInstallService(r: InstallServiceResult): string {
  const lines = [
    r.written ? `Wrote ${tilde(r.file)}` : `${tilde(r.file)} is up to date (unchanged)`,
    ...(r.archived ? [`The file that was there is archived at ${tilde(r.archived)}`] : []),
    `Node: ${tilde(r.programArguments[0]!)}`,
    `Runs: ${tilde(r.programArguments[2]!)} ${r.programArguments.slice(3).join(' ')}`,
    ...r.warnings.map((w) => `warning: ${w}`),
    'jv does not load it. To start the bot as a service:',
    ...r.load.map((c) => `  ${c}`),
    'To stop and unload it:',
    ...r.unload.map((c) => `  ${c}`),
  ];
  return lines.join('\n');
}
