// jv providers check | jv providers login <name> (sections 3 and 6.6).
//
// check: per enabled provider, a login and usage probe whose result is stored for placement (meta provider_auth:<name>,
// D-012; provider_usage rows), the model lists of providers.json filled from what each login offers, then Jev. The
// probes and their text live in jevellan-core/providers-check, which the bot's hourly housekeeping calls too (monorepo
// brief section 8); this module re-exports them under the names it always had, so its output is unchanged.
//
// login <name>: `jv exec --provider <name> -- claude` (Claude subscriptions without a tokenFile) or `-- codex login`
// (Codex) in the tmux session jv-login-<name>, in the provider home, for the owner to sign in once; in a terminal
// jv attaches to it, otherwise it prints the attach command. The coordinator's provider (claude-main) may have a
// tokenFile and still take a login of its own: `jv exec --provider claude-main --home-login -- claude auth login`
// writes <home>/.claude/.credentials.json, which the coordinator then runs on, with Remote Control (D-054); its
// workers keep the token (D-003). Any other provider that logs in with a key or token file is refused with the file
// to write.

import { spawnSync } from 'node:child_process';
import type { CommandIo, ParsedArgs } from '../command.js';
import { requirePositional } from '../command.js';
import { COORDINATOR_PROVIDER } from 'jevellan-core/coordinator';
import { notFound, refused } from 'jevellan-core/errors';
import { checkProviders, formatCheckResult, loginFix } from 'jevellan-core/providers-check';
import { loadProviders, type ProvidersConfig } from 'jevellan-core/providers';
import { codexExecutable } from 'jevellan-core/runtimes/codex';
import { executableOnPath, hasSession, jvExecArgv, runTmux, tmuxEnvArgs, type TmuxRunner } from 'jevellan-core/runtimes/claude-tmux';
import { openStore } from 'jevellan-core/store';

export {
  checkProviders,
  defaultCheckDeps,
  fillModels,
  formatCheckResult,
  homeAccessToken,
  writeModelLists,
  type JevCheck,
  type ModelFill,
  type Offered,
  type ProviderCheck,
  type ProvidersCheckDeps,
  type ProvidersCheckResult,
  type UsageView,
} from 'jevellan-core/providers-check';

// ---- login --------------------------------------------------------------------------------------------------

export interface LoginDeps {
  tmux?: TmuxRunner;
  providers?: () => ProvidersConfig;
  tty?: boolean;
  insideTmux?: boolean;
  interactive?: (args: string[]) => number;
  claude?: string;
  codex?: string;
}

export interface LoginResult {
  provider: string;
  tmuxTarget: string;
  command: string[];
  created: boolean;
  attached: boolean;
  /** What the login is for when it is not the provider's worker login (the coordinator's own login). */
  note?: string;
}

export function loginSessionName(provider: string): string {
  return `jv-login-${provider}`;
}

/** Starts (or finds) the tmux login session of a provider, and attaches in a terminal. */
export function loginProvider(name: string, deps: LoginDeps = {}): LoginResult {
  const tmux = deps.tmux ?? runTmux;
  const config = (deps.providers ?? (() => loadProviders()))();
  const p = config.providers.find((x) => x.name === name);
  if (!p) throw notFound(`no provider ${name} in ${config.file}`);
  let command: string[];
  let homeLogin = false;
  if (p.kind === 'claude-subscription') {
    if (p.tokenFile && p.name !== COORDINATOR_PROVIDER) {
      throw refused(`${name} logs in with its token file (${p.tokenFile}), not an interactive login: ${loginFix(p, 'needs-login')}`);
    }
    // With a tokenFile, the token must stay out of the login's environment: Claude Code would use it and never ask.
    homeLogin = p.tokenFile !== undefined;
    command = homeLogin ? [deps.claude ?? executableOnPath('claude'), 'auth', 'login'] : [deps.claude ?? executableOnPath('claude')];
  } else if (p.kind === 'codex-subscription') {
    command = [deps.codex ?? codexExecutable(), 'login'];
  } else {
    throw refused(`${name} (${p.kind}) logs in with a key file, not an interactive login: ${loginFix(p, 'needs-login')}`);
  }
  const target = loginSessionName(name);
  let created = false;
  if (!hasSession(tmux, target)) {
    const r = tmux(['new-session', '-d', '-s', target, '-c', p.home!, ...tmuxEnvArgs(), ...jvExecArgv({ provider: name }, command, { homeLogin })]);
    if (r.status !== 0) throw refused(`tmux could not start ${target}: ${r.stderr.trim().split('\n')[0] ?? ''}`);
    created = true;
  }
  const tty = deps.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const inside = deps.insideTmux ?? (process.env.TMUX !== undefined && process.env.TMUX !== '');
  const attach = inside ? ['tmux', 'switch-client', '-t', `=${target}`] : ['tmux', 'attach', '-t', `=${target}`];
  let attached = false;
  if (tty) {
    const interactive = deps.interactive ?? ((a: string[]) => spawnSync('tmux', a, { stdio: 'inherit' }).status ?? 1);
    attached = interactive(attach.slice(1)) === 0;
  }
  return {
    provider: name,
    tmuxTarget: target,
    command: attach,
    created,
    attached,
    ...(homeLogin
      ? {
          note:
            `This login is the coordinator's own (Remote Control needs it); ${name}'s workers keep signing in with ${p.tokenFile}. ` +
            'Once signed in, jv coordinator restart --project N starts the coordinator on it with Remote Control.',
        }
      : {}),
  };
}

// ---- the command --------------------------------------------------------------------------------------------

export async function run(args: ParsedArgs, io: CommandIo): Promise<number> {
  const sub = requirePositional(args, 0, 'a subcommand (jv providers check | jv providers login <name>)');
  if (sub === 'check') {
    const store = openStore();
    try {
      const result = await checkProviders(store);
      io.result(result, () => formatCheckResult(result));
      return 0;
    } finally {
      store.close();
    }
  }
  if (sub === 'login') {
    const name = requirePositional(args, 1, 'the provider name (jv providers login <name>)');
    const result = loginProvider(name, io.json ? { tty: false } : {});
    io.result(result, () => {
      const text = result.attached
        ? `Left ${result.tmuxTarget}. Run jv providers check to record the login.`
        : `${result.created ? 'Started' : 'Found'} ${result.tmuxTarget}: sign in there, then run jv providers check.\nAttach with: ${result.command.join(' ')}`;
      return result.note ? `${text}\n${result.note}` : text;
    });
    return 0;
  }
  throw refused(`unknown subcommand "${sub}" (jv providers check | jv providers login <name>)`);
}
