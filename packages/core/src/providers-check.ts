// The probes of `jv providers check` (sections 3 and 6.6) as a library: what the command runs, and what the bot's
// hourly housekeeping runs (monorepo brief section 8, tick step 6). Moved here from the command module unchanged, so
// both call the same code and the command's text and --json output stay what they were.
//
// Per enabled provider, a login and usage probe, and the result is stored for placement:
// - claude-subscription: the ported header probe (a one-token Messages call with the provider's OAuth token: the
//   tokenFile, else the home's own login), whose anthropic-ratelimit-unified-* headers give the five-hour and weekly
//   windows; then supportedModels() under the provider's environment fills its model list.
// - claude-endpoint: a one-token Messages call on the provider's base URL with its key (login only; no windows).
// - codex-subscription: account/read and account/rateLimits/read over `codex app-server` (probeCodex, the refresh
//   never forced, D-022), then model/list fills its model list.
// - openai-compatible: GET <baseUrl>/models with its key (login only), and the provider's `local` usage row for the
//   week from its sessions' token sums.
// Results go to meta provider_auth:<name> (D-012) and, with windows, to provider_usage rows with source `probe`
// (D-017, D-061). Model lists: each model of providers.json is matched to an offered model by id, else by its label
// (the family, e.g. "Opus", in the offered id or name); a match keeps the label, efforts and maxTokens of
// providers.json and takes the offered id; a model with no match is dropped (unless nothing matched at all). Offered
// models that match no entry are listed, not added: every menu model needs a line in the router policy (section 7.8).
// A "same as <name>" list is left as it is. providers.json is rewritten only when something changed, atomically,
// mode 600. Then Jev: the key file, GET /v1/models, the configured model listed.
//
// probeProviders is the bot's part: only the providers it names (the bot names the ones whose last probe was ready),
// the login and usage probes only. It reads no model list, asks Jev nothing and never writes providers.json:
// changing the menu stays the owner's `jv providers check`.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listClaudeModels, probeClaude, type ClaudeProbe, type ClaudeUsage, type OfferedModel } from './claude-control.js';
import { listCodexModels, probeCodex, type CodexOfferedModel, type CodexProbe } from './codex-control.js';
import { probeEnvironment } from './doctor.js';
import { jevClient } from './jev/client.js';
import { JevError } from './jev/contract.js';
import { paths } from './paths.js';
import {
  cheapestModel,
  keyFileStatus,
  loadProviderAuthRecords,
  loadProviders,
  parseProviders,
  readSecretFile,
  recordProviderAuth,
  type Provider,
  type ProviderAuthState,
  type ProviderModel,
  type ProvidersConfig,
} from './providers.js';
import { redact } from './redact.js';
import type { Store } from './store.js';
import { isoWeek, recordLocalUsage } from './usage.js';

// ---- model lists --------------------------------------------------------------------------------------------

export interface Offered {
  id: string;
  label: string;
}

export interface ModelFill {
  models: ProviderModel[];
  changed: boolean;
  renamed: Array<{ from: string; to: string }>;
  removed: string[];
  /** Offered models that no providers.json entry matches (not added: they have no policy description). */
  alsoOffered: string[];
}

function family(label: string): string {
  return label.trim().toLowerCase().split(/\s+/)[0] ?? '';
}

/** Matches providers.json models to offered ones (see the header); pure. */
export function fillModels(configured: readonly ProviderModel[], offered: readonly Offered[]): ModelFill {
  const used = new Set<string>();
  const out: ProviderModel[] = [];
  const renamed: ModelFill['renamed'] = [];
  const removed: string[] = [];
  for (const m of configured) {
    let match = offered.find((o) => o.id === m.id && !used.has(o.id));
    if (!match) {
      const f = family(m.label);
      if (f.length >= 2) {
        match = offered.find((o) => !used.has(o.id) && !configured.some((c) => c.id === o.id) && (o.id.toLowerCase().includes(f) || o.label.toLowerCase().includes(f)));
      }
    }
    if (!match) {
      removed.push(m.id);
      continue;
    }
    used.add(match.id);
    if (match.id !== m.id) renamed.push({ from: m.id, to: match.id });
    out.push({ ...m, id: match.id, efforts: [...m.efforts] });
  }
  const alsoOffered = offered.filter((o) => !used.has(o.id)).map((o) => o.id);
  if (out.length === 0) return { models: configured.map((m) => ({ ...m, efforts: [...m.efforts] })), changed: false, renamed: [], removed: [], alsoOffered };
  return { models: out, changed: renamed.length > 0 || removed.length > 0, renamed, removed, alsoOffered };
}

/** Writes new model lists into providers.json (raw, other keys untouched), only when they differ; mode 600. */
export function writeModelLists(file: string, lists: ReadonlyMap<string, ProviderModel[]>): boolean {
  if (lists.size === 0) return false;
  const text = readFileSync(file, 'utf8');
  const raw = JSON.parse(text) as { providers?: Array<Record<string, unknown>> };
  let changed = false;
  for (const entry of raw.providers ?? []) {
    const list = typeof entry.name === 'string' ? lists.get(entry.name) : undefined;
    if (!list || !Array.isArray(entry.models)) continue;
    if (JSON.stringify(entry.models) === JSON.stringify(list)) continue;
    entry.models = list;
    changed = true;
  }
  if (!changed) return false;
  parseProviders(raw, file);
  const tmp = `${file}.jv-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

// ---- probes -------------------------------------------------------------------------------------------------

export interface ProvidersCheckDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  claudeModels: (env: Record<string, string>, cwd: string) => Promise<OfferedModel[]>;
  codexProbe: (env: Record<string, string>, cwd: string) => Promise<CodexProbe>;
  codexModels: (env: Record<string, string>, cwd: string) => Promise<CodexOfferedModel[]>;
  providersFile: string;
}

export function defaultCheckDeps(): ProvidersCheckDeps {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    claudeModels: (env, cwd) => listClaudeModels({ env, cwd }),
    codexProbe: (env, cwd) => probeCodex({ env, cwd }),
    codexModels: (env, cwd) => listCodexModels({ env, cwd }),
    providersFile: paths.providersFile,
  };
}

export interface UsageView {
  weeklyPct?: number;
  fiveHourPct?: number;
  weeklyResetsAt?: string;
  fiveHourResetsAt?: string;
}

export interface ProviderCheck {
  name: string;
  kind: Provider['kind'];
  auth: ProviderAuthState | 'disabled';
  detail: string;
  /** What the owner runs or writes when the provider is not ready. */
  fix?: string;
  usage?: UsageView;
  models?: { ids: string[]; renamed: ModelFill['renamed']; removed: string[]; alsoOffered: string[]; error?: string };
  local?: { week: string; inputTokens: number; outputTokens: number; costUsd: number | null };
}

export interface JevCheck {
  reachable: boolean;
  model: string;
  listed: boolean;
  detail: string;
  fix?: string;
}

export interface ProvidersCheckResult {
  providers: ProviderCheck[];
  jev: JevCheck;
  providersFile: { file: string; changed: boolean };
}

/** The OAuth access token of a Claude home's own login (.claude/.credentials.json), if present and not expired. */
export function homeAccessToken(home: string, now = Date.now()): { token?: string; state: 'none' | 'expired' | 'ok' } {
  const file = join(home, '.claude', '.credentials.json');
  if (!existsSync(file)) return { state: 'none' };
  try {
    const oauth = (JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken === '') return { state: 'none' };
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= now) return { state: 'expired' };
    return { token: oauth.accessToken, state: 'ok' };
  } catch {
    return { state: 'none' };
  }
}

/** What the owner runs or writes when a provider is not ready (also jv providers login's refusal text). */
export function loginFix(p: Provider, auth: ProviderAuthState): string {
  if (p.kind === 'claude-subscription' && p.tokenFile) return `write a new token to ${p.tokenFile} (claude setup-token prints one), mode 600`;
  if (p.kind === 'claude-endpoint' || p.kind === 'openai-compatible') {
    // An endpoint that could not be reached is not fixed by writing a key.
    if (auth === 'unknown') return `make sure ${p.baseUrl ?? 'the endpoint'} is reachable from this machine, or set "enabled": false for ${p.name} in providers.json`;
    if (p.keyFile === undefined) return `name a keyFile for ${p.name} in providers.json and write the key to it (mode 600)`;
    return `write the key to ${p.keyFile} (mode 600)`;
  }
  return `jv providers login ${p.name}`;
}

function usageView(u: ClaudeUsage | CodexProbe['usage'] | undefined): UsageView | undefined {
  if (!u) return undefined;
  const out: UsageView = {
    ...(u.weeklyPct !== undefined ? { weeklyPct: u.weeklyPct } : {}),
    ...(u.fiveHourPct !== undefined ? { fiveHourPct: u.fiveHourPct } : {}),
    ...(u.weeklyResetsAt ? { weeklyResetsAt: u.weeklyResetsAt } : {}),
    ...(u.fiveHourResetsAt ? { fiveHourResetsAt: u.fiveHourResetsAt } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function short(text: string, max = 200): string {
  const t = redact(text.replace(/\s+/g, ' ').trim());
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

async function probeOpenAi(p: Provider, deps: ProvidersCheckDeps): Promise<{ auth: ProviderAuthState; detail: string }> {
  let key: string | undefined;
  if (p.keyFile !== undefined) {
    key = readSecretFile(p.keyFile);
    if (key === undefined) return { auth: 'needs-login', detail: `key file missing (${p.keyFile})` };
  }
  try {
    const response = await deps.fetch(`${p.baseUrl}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return { auth: 'needs-login', detail: 'the provider refused the key' };
    if (response.ok || response.status === 429) return { auth: 'ready', detail: `${p.baseUrl} answered` };
    return { auth: 'unknown', detail: `${p.baseUrl}/models returned HTTP ${response.status}` };
  } catch {
    return { auth: 'unknown', detail: `${p.baseUrl} could not be reached` };
  }
}

/** One provider's probe. `models: false` (the bot) skips reading the offered model lists. */
async function checkOne(
  store: Store,
  p: Provider,
  deps: ProvidersCheckDeps,
  fills: Map<string, ProviderModel[]>,
  sameAs: Set<string>,
  options: { models: boolean } = { models: true },
): Promise<ProviderCheck> {
  const base: Pick<ProviderCheck, 'name' | 'kind'> = { name: p.name, kind: p.kind };
  if (!p.enabled) return { ...base, auth: 'disabled', detail: 'disabled in providers.json; not probed' };
  let auth: ProviderAuthState = 'unknown';
  let detail = '';
  let usage: UsageView | undefined;
  let models: ProviderCheck['models'];
  let local: ProviderCheck['local'];
  const fill = async (offered: () => Promise<Offered[]>) => {
    if (!options.models || sameAs.has(p.name)) return;
    try {
      const f = fillModels(p.models, await offered());
      if (f.changed) fills.set(p.name, f.models);
      models = { ids: f.models.map((m) => m.id), renamed: f.renamed, removed: f.removed, alsoOffered: f.alsoOffered };
    } catch (error) {
      models = { ids: p.models.map((m) => m.id), renamed: [], removed: [], alsoOffered: [], error: short(error instanceof Error ? error.message : String(error)) };
    }
  };

  if (p.kind === 'claude-subscription' || p.kind === 'claude-endpoint') {
    const { env, missing } = probeEnvironment(p, deps.env);
    let probe: ClaudeProbe | undefined;
    if (p.kind === 'claude-endpoint') {
      const key = p.keyFile ? readSecretFile(p.keyFile) : undefined;
      if (!key) {
        auth = 'needs-login';
        detail = `key file missing (${p.keyFile ?? 'none named'})`;
      } else probe = await probeClaude({ kind: 'endpoint', token: key, baseUrl: p.baseUrl!, model: p.models[0]!.id, fetch: deps.fetch });
    } else if (missing) {
      auth = 'needs-login';
      detail = `token file missing (${missing})`;
    } else {
      const token = p.tokenFile ? readSecretFile(p.tokenFile) : homeAccessToken(p.home!).token;
      if (token) probe = await probeClaude({ kind: 'subscription', token, model: cheapestModel(p).id, fetch: deps.fetch });
      else {
        const state = homeAccessToken(p.home!).state;
        if (state === 'expired') {
          auth = 'ready';
          detail = 'login stored in the home (its access token expired; Claude Code refreshes it on next use); usage not probed';
        } else {
          auth = 'needs-login';
          detail = `no token file and no login in ${p.home}`;
        }
      }
    }
    if (probe) {
      auth = probe.auth;
      usage = usageView(probe.usage);
      detail = probe.auth === 'ready' ? 'the probe answered' : (probe.error ?? 'the probe did not complete');
      if (probe.usage) {
        store.recordProviderUsage({
          provider: p.name,
          observed_at: probe.usage.observedAt,
          source: 'probe',
          five_hour_pct: probe.usage.fiveHourPct ?? null,
          weekly_pct: probe.usage.weeklyPct ?? null,
          five_hour_resets_at: probe.usage.fiveHourResetsAt ?? null,
          weekly_resets_at: probe.usage.weeklyResetsAt ?? null,
        });
      }
    }
    if (auth === 'ready' && p.kind === 'claude-subscription' && !missing) await fill(() => deps.claudeModels(env, p.home!));
  } else if (p.kind === 'codex-subscription') {
    const { env } = probeEnvironment(p, deps.env);
    if (!existsSync(join(p.home!, '.codex'))) {
      auth = 'unknown';
      detail = `provider home ${p.home} is not set up (run jv update)`;
    } else {
      const r = await deps.codexProbe(env, p.home!);
      auth = r.auth;
      detail = r.auth === 'ready' ? `ChatGPT ${r.plan ?? 'login'} answered account/rateLimits/read` : (r.error ?? 'the probe did not complete');
      usage = usageView(r.usage);
      if (r.usage) {
        store.recordProviderUsage({
          provider: p.name,
          observed_at: r.usage.observedAt,
          source: 'probe',
          five_hour_pct: r.usage.fiveHourPct ?? null,
          weekly_pct: r.usage.weeklyPct ?? null,
          five_hour_resets_at: r.usage.fiveHourResetsAt ?? null,
          weekly_resets_at: r.usage.weeklyResetsAt ?? null,
        });
      }
      if (auth === 'ready') await fill(() => deps.codexModels(env, p.home!));
    }
  } else {
    const r = await probeOpenAi(p, deps);
    auth = r.auth;
    detail = r.detail;
    const week = isoWeek();
    const row = recordLocalUsage(store, p.name, week);
    local = { week, inputTokens: row.local_input_tokens ?? 0, outputTokens: row.local_output_tokens ?? 0, costUsd: row.local_cost_usd };
  }

  recordProviderAuth(store, p.name, { auth, observedAt: new Date().toISOString(), detail: detail.slice(0, 300) });
  return {
    ...base,
    auth,
    detail,
    ...(auth !== 'ready' ? { fix: loginFix(p, auth) } : {}),
    ...(usage ? { usage } : {}),
    ...(models ? { models } : {}),
    ...(local ? { local } : {}),
  };
}

async function checkJev(config: ProvidersConfig, deps: ProvidersCheckDeps): Promise<JevCheck> {
  const file = config.jev.keyFile;
  const st = keyFileStatus(file);
  const fix = `write the Jev key to ${file} and run chmod 600 ${file}`;
  const model = config.jev.model;
  if (st.state === 'missing' || st.state === 'empty') return { reachable: false, model, listed: false, detail: 'no key configured', fix };
  if (st.state !== 'ok') return { reachable: false, model, listed: false, detail: `the key file ${file} has mode ${st.mode ?? '?'}, not 600`, fix: `chmod 600 ${file}` };
  try {
    const names = (await jevClient(config.jev, { fetch: deps.fetch }).models()).models.map((m) => m.name);
    const listed = names.includes(model);
    return {
      reachable: true,
      model,
      listed,
      detail: listed ? `reachable, model ${model} listed` : `reachable, but ${model} is not listed (listed: ${names.join(', ') || 'none'})`,
      ...(listed ? {} : { fix: `set jev.model in ${config.file} to a listed model` }),
    };
  } catch (error) {
    const message = error instanceof JevError ? error.message : short(error instanceof Error ? error.message : String(error));
    return { reachable: false, model, listed: false, detail: `GET /v1/models: ${message}`, fix: error instanceof JevError && (error.kind === 'auth' || error.kind === 'no-key') ? fix : 'check the network and run jv providers check again' };
  }
}

/** Every probe of `jv providers check`; results are recorded in the store and providers.json is updated. */
export async function checkProviders(store: Store, overrides: Partial<ProvidersCheckDeps> = {}): Promise<ProvidersCheckResult> {
  const deps = { ...defaultCheckDeps(), ...overrides };
  const config = loadProviders(deps.providersFile);
  const fills = new Map<string, ProviderModel[]>();
  const sameAs = new Set(config.providers.filter((p) => p.modelsFrom !== undefined).map((p) => p.name));
  const [providers, jev] = await Promise.all([
    Promise.all(config.providers.map((p) => checkOne(store, p, deps, fills, sameAs))),
    checkJev(config, deps),
  ]);
  const changed = writeModelLists(config.file, fills);
  return { providers, jev, providersFile: { file: config.file, changed } };
}

/** The enabled providers of providers.json whose last recorded login probe (meta provider_auth:<name>) was ready. */
export function readyProviders(store: Store, config: ProvidersConfig = loadProviders()): string[] {
  const auth = loadProviderAuthRecords(store);
  return config.providers.filter((p) => p.enabled && auth[p.name]?.auth === 'ready').map((p) => p.name);
}

export interface ProbeOptions {
  /** Only these providers (by name); default every enabled one. */
  only?: readonly string[];
}

/**
 * The login and usage probes of `jv providers check` for some providers, recorded as the command records them
 * (provider_auth meta, probe usage rows, local usage rows), without the model lists, without Jev and without writing
 * providers.json: the bot's hourly housekeeping (section 8, tick step 6).
 */
export async function probeProviders(store: Store, options: ProbeOptions = {}, overrides: Partial<ProvidersCheckDeps> = {}): Promise<ProviderCheck[]> {
  const deps = { ...defaultCheckDeps(), ...overrides };
  const config = loadProviders(deps.providersFile);
  const wanted = options.only === undefined ? undefined : new Set(options.only);
  const chosen = config.providers.filter((p) => p.enabled && (wanted === undefined || wanted.has(p.name)));
  const unused = new Map<string, ProviderModel[]>();
  return Promise.all(chosen.map((p) => checkOne(store, p, deps, unused, new Set(), { models: false })));
}

function pct(v: number | undefined): string {
  return v === undefined ? 'unknown' : `${v}%`;
}

export function formatCheckResult(r: ProvidersCheckResult): string {
  const lines: string[] = [];
  for (const p of r.providers) {
    const state = p.auth === 'ready' ? 'ready' : p.auth === 'needs-login' ? 'needs login' : p.auth === 'disabled' ? 'disabled' : 'unknown';
    const parts = [p.detail];
    if (p.usage) {
      parts.push(
        `week ${pct(p.usage.weeklyPct)}${p.usage.weeklyResetsAt ? ` (resets ${p.usage.weeklyResetsAt})` : ''}, five hours ${pct(p.usage.fiveHourPct)}`,
      );
    }
    if (p.local) parts.push(`week ${p.local.week}: ${p.local.inputTokens} in, ${p.local.outputTokens} out${p.local.costUsd !== null ? `, $${p.local.costUsd}` : ''}`);
    if (p.models) {
      parts.push(`models: ${p.models.ids.join(', ')}`);
      if (p.models.renamed.length) parts.push(`renamed ${p.models.renamed.map((x) => `${x.from} -> ${x.to}`).join(', ')}`);
      if (p.models.removed.length) parts.push(`not offered, removed: ${p.models.removed.join(', ')}`);
      if (p.models.error) parts.push(`model list not read: ${p.models.error}`);
    }
    if (p.fix) parts.push(`fix: ${p.fix}`);
    lines.push(`${p.name.padEnd(16)} ${state.padEnd(12)} ${parts.join('; ')}`);
  }
  lines.push(`${'jev'.padEnd(16)} ${(r.jev.reachable && r.jev.listed ? 'ready' : 'not ready').padEnd(12)} ${r.jev.detail}${r.jev.fix ? `; fix: ${r.jev.fix}` : ''}`);
  if (r.providersFile.changed) lines.push(`updated the model lists in ${r.providersFile.file}`);
  return lines.join('\n');
}

