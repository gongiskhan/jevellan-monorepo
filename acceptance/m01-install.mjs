#!/usr/bin/env node
// M1 Install (brief section 14): npm ci && npm run build at the checkout; jv bootstrap --skills
// ~/dev/jevellan-skills; jv --version prints the three versions; jv doctor is all OK or WARN (WARN only for
// providers without key files, Ollama without models, Codex if "needs login"); the shim runs the 22.22.0 binary.
//
// By default the bootstrap goes into a temporary JV_HOME under ~/.jv-test/<run id>/ (removed at the end; --keep
// leaves it): no secret is copied there, so the doctor lines that need one (the Jev key, the logins and model lists
// of providers whose token is a secret) cannot pass and are listed as "not judged without secrets". With --real the
// journey bootstraps and checks the owner's ~/.jv (idempotent: M-007's bootstrap copies nothing that is unchanged)
// and judges every doctor line strictly; that is the run for the record. --no-build skips npm ci and npm run build
// (the dist folders must exist).
//
// Usage: node acceptance/m01-install.mjs [--real] [--no-build] [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m01.json.

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BIN_JV,
  CHECKOUT,
  check,
  cleanup,
  CLI_ENTRY,
  finish,
  jv,
  jvJson,
  log,
  NODE,
  NODE_VERSION,
  note,
  npm,
  packageVersion,
  parseFlags,
  REAL_JV_HOME,
  run,
  runDir,
  runId,
  runJourney,
  skillsOf,
  SKILLS_REPO,
  tail,
  tempHome,
} from './lib.mjs';

const JOURNEY = 'm01';
const USAGE = 'Usage: node acceptance/m01-install.mjs [--real] [--no-build] [--keep]';

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The program and CLI entry of the shim's exec line: exec '<node>' --disable-warning=... '<entry>' "$@". */
function parseShim(text) {
  const line = text.split('\n').find((l) => l.startsWith('exec '));
  if (!line) return undefined;
  const words = [...line.slice(5).matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : (m[2] ?? m[3])));
  return { line, node: words[0], flags: words.filter((w) => w.startsWith('--')), entry: words.find((w, i) => i > 0 && !w.startsWith('--') && w !== '$@') };
}

/** providers.json of a home as {name: {kind, secret, hasSecret}}; secret is the key or token file path. */
function providerKinds(home) {
  const file = join(home, 'providers.json');
  const out = {};
  if (!existsSync(file)) return out;
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const expand = (p) => (p.startsWith('~/.jv/') ? join(home, p.slice('~/.jv/'.length)) : p);
  for (const p of cfg.providers ?? []) {
    const secret = p.tokenFile ?? p.keyFile;
    const hasHomeLogin = p.home ? existsSync(join(expand(p.home), '.claude', '.credentials.json')) : false;
    out[p.name] = { kind: p.kind, secret, hasSecret: (secret ? existsSync(expand(secret)) : false) || hasHomeLogin };
  }
  return out;
}

/**
 * Sorts the doctor lines: ok, allowed (the three WARN kinds the brief allows), no-secrets (temporary home only:
 * a line that needs a secret this home does not have), bad (anything else).
 */
function classifyDoctor(checks, providers, { realHome }) {
  return checks.map((c) => {
    const [prefix, provider] = c.name.includes(':') ? c.name.split(/:(.*)/s) : [c.name, undefined];
    const p = provider ? providers[provider] : undefined;
    const d = c.detail ?? '';
    if (c.status === 'OK') return { ...c, verdict: 'ok' };
    if (c.status === 'WARN') {
      if (prefix === 'key' && /^key file (missing|empty)/.test(d)) return { ...c, verdict: 'allowed', why: 'provider without key file' };
      if ((prefix === 'login' || prefix === 'models') && /key file missing/.test(d)) return { ...c, verdict: 'allowed', why: 'provider without key file' };
      if (prefix === 'login' && /^needs login: no token file and no login/.test(d)) return { ...c, verdict: 'allowed', why: 'provider without key file (no token file)' };
      if (prefix === 'login' && p?.kind === 'codex-subscription' && /^needs login/.test(d)) return { ...c, verdict: 'allowed', why: 'Codex needs login' };
      if ((/ollama/i.test(c.name) || /ollama/i.test(d)) && /no models?\b|not installed|not pulled/i.test(d)) return { ...c, verdict: 'allowed', why: 'Ollama without models' };
    }
    if (!realHome) {
      if (c.name === 'jev' && /no key configured/.test(d)) return { ...c, verdict: 'no-secrets', why: 'the Jev key is a secret' };
      if ((prefix === 'login' || prefix === 'models') && p && !p.hasSecret) return { ...c, verdict: 'no-secrets', why: `${provider} has no token or login in this home` };
    }
    return { ...c, verdict: 'bad' };
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: USAGE });
  const started = Date.now();
  const id = runId(JOURNEY);
  const dir = runDir(id);
  const realHome = !!flags.real;
  const home = realHome ? REAL_JV_HOME : tempHome(id);
  const mode = realHome ? `real home ${REAL_JV_HOME}` : 'temporary JV_HOME (no secrets)';
  const skills = skillsOf(SKILLS_REPO);
  const version = packageVersion();
  log(`M1 Install ${id}\ncheckout ${CHECKOUT}\nJV_HOME ${home}${realHome ? ' (real, --real)' : ' (temporary)'}\nskills ${SKILLS_REPO}\n`);
  note(`mode: ${mode}`);

  try {
    await check(`Node ${NODE_VERSION} at ${NODE}`, () => {
      const r = run(NODE, ['--version']);
      return { ok: r.code === 0 && r.stdout.trim() === `v${NODE_VERSION}`, detail: r.stdout.trim() || r.stderr.trim() };
    });

    if (flags['no-build']) note('npm ci and npm run build skipped (--no-build)');
    else {
      if (!(await check('npm ci at the checkout', () => {
        const r = npm(CHECKOUT, ['ci', '--no-audit', '--no-fund']);
        return { ok: r.code === 0, detail: r.code === 0 ? `${Math.round(r.ms / 1000)} s` : `exit ${r.code}\n${tail(r.stdout + r.stderr)}` };
      }))) return finish(JOURNEY, { startedAt: started, mode });
      await check('npm run build at the checkout', () => {
        const r = npm(CHECKOUT, ['run', 'build']);
        return { ok: r.code === 0, detail: r.code === 0 ? `${Math.round(r.ms / 1000)} s` : `exit ${r.code}\n${tail(r.stdout + r.stderr)}` };
      });
    }
    if (!(await check('build output present', () => {
      const missing = [CLI_ENTRY, join(CHECKOUT, 'packages', 'core', 'dist', 'store.js'), join(CHECKOUT, 'packages', 'core', 'dist', 'report-guard.mjs')].filter((f) => !existsSync(f));
      return { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : CLI_ENTRY };
    }))) return finish(JOURNEY, { startedAt: started, mode });

    // --real must not re-point the owner's install at another checkout (a worktree, say): the bootstrap rewrites
    // ~/.jv/bin/jv, ~/.jv/runtime and install.json to the checkout this script runs from.
    if (realHome) {
      const recorded = existsSync(join(home, 'install.json')) ? JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')).checkout : undefined;
      if (recorded && real(recorded) !== real(CHECKOUT)) {
        return finish(JOURNEY, { startedAt: started, mode, blocked: `--real would re-point ${home} from ${recorded} to ${CHECKOUT}; run it from ${recorded}` });
      }
    }

    // jv bootstrap --skills ~/dev/jevellan-skills into the home.
    const booted = await check(`jv bootstrap --skills ${SKILLS_REPO}`, () => {
      const boot = jvJson(['bootstrap', '--skills', SKILLS_REPO], { home, real: realHome, timeoutMs: 10 * 60_000, cwd: dir });
      const summary = boot.json;
      if (boot.code !== 0 || !summary?.install) return { ok: false, detail: `exit ${boot.code}: ${tail(boot.stderr || boot.stdout, 6)}` };
      const problems = [];
      if (real(summary.install.checkout) !== real(CHECKOUT)) problems.push(`checkout ${summary.install.checkout}`);
      if (real(summary.install.nodePath) !== real(NODE)) problems.push(`node ${summary.install.nodePath}`);
      if (real(summary.install.cliEntry) !== real(CLI_ENTRY)) problems.push(`cliEntry ${summary.install.cliEntry}`);
      const names = [...(summary.skillNames ?? [])].sort();
      if (names.join(',') !== skills.names.join(',')) problems.push(`skills ${names.join(',')} (expected ${skills.names.join(',')})`);
      return {
        ok: problems.length === 0 && skills.names.length === 14,
        detail: problems.length ? problems.join('; ') : `${names.length} skills ${summary.skillsCopied ? 'copied' : 'unchanged'}, skills ${summary.install.skillsVersion} at ${summary.install.skillsCommit?.slice(0, 7) ?? '?'}, node ${summary.install.nodePath}`,
      };
    });
    if (!booted) return finish(JOURNEY, { startedAt: started, mode });

    await check('runtime link points at the checkout (M-007)', () => {
      const link = join(home, 'runtime');
      if (!lstatSync(link).isSymbolicLink()) return { ok: false, detail: `${link} is not a symlink` };
      return { ok: real(link) === real(join(CHECKOUT, 'packages', 'core')), detail: `${link} -> ${readlinkSync(link)}` };
    });

    // jv --version prints the three versions, through bin/jv.mjs and through the shim.
    const expected = `jevellan ${version} (store schema 2, skills ${skills.version})`;
    await check('jv --version prints the three versions', () => {
      const viaBin = jv(['--version'], { home, real: realHome, cwd: dir });
      const viaShim = jv(['--version'], { home, real: realHome, shim: true, cwd: dir });
      const a = viaBin.stdout.trim();
      const b = viaShim.stdout.trim();
      return {
        ok: viaBin.code === 0 && viaShim.code === 0 && a === expected && b === expected,
        detail: a === b ? a : `bin/jv.mjs "${a}", shim "${b}" (expected "${expected}")`,
      };
    });
    if (version !== '0.1.0' || skills.version !== '0.1.0') note(`the brief expects "jevellan 0.1.0 (store schema 2, skills 0.1.0)"; this checkout is ${version} and the skills ${skills.version}`);

    // The shim runs the 22.22.0 binary: its exec line, and the Node version the doctor reports through it.
    const shimFile = join(home, 'bin', 'jv');
    await check('the shim execs Node 22.22.0 on the checkout CLI (D-001, D-024)', () => {
      if (!existsSync(shimFile)) return { ok: false, detail: `no ${shimFile}` };
      const text = readFileSync(shimFile, 'utf8');
      const shim = parseShim(text);
      if (!shim) return { ok: false, detail: 'no exec line' };
      const v = run(shim.node, ['--version']).stdout.trim();
      const problems = [];
      if (real(shim.node) !== real(NODE)) problems.push(`program ${shim.node}`);
      if (v !== `v${NODE_VERSION}`) problems.push(`version ${v}`);
      if (!shim.flags.includes('--disable-warning=ExperimentalWarning')) problems.push('no --disable-warning=ExperimentalWarning');
      if (real(shim.entry ?? '') !== real(CLI_ENTRY)) problems.push(`entry ${shim.entry}`);
      if (!text.includes('JV_HOME="${JV_HOME:-}"')) problems.push('does not keep a caller JV_HOME (D-024)');
      if ((statSync(shimFile).mode & 0o111) === 0) problems.push('not executable');
      return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `exec ${shim.node} ${shim.flags.join(' ')} ${shim.entry}` };
    });

    // jv doctor through the shim.
    let lines;
    if (!(await check('jv doctor --json answers (through the shim)', () => {
      const doc = jvJson(['doctor'], { home, real: realHome, shim: true, timeoutMs: 10 * 60_000, cwd: dir });
      lines = doc.json?.checks;
      return {
        ok: Array.isArray(lines) && lines.length > 0 && (doc.code === 0 || doc.code === 2),
        detail: Array.isArray(lines) ? `${lines.length} lines, exit ${doc.code}` : `exit ${doc.code}: ${tail(doc.stderr || doc.stdout, 6)}`,
      };
    }))) return finish(JOURNEY, { startedAt: started, mode });
    for (const c of lines) log(`  ${c.status.padEnd(4)} ${c.name}: ${c.detail}${c.fix && c.status !== 'OK' ? ` - fix: ${c.fix}` : ''}`);

    await check('the shim runs Node 22.22.0 (doctor node line)', () => {
      const node = lines.find((c) => c.name === 'node');
      return { ok: node?.status === 'OK' && node.detail === `Node ${NODE_VERSION}`, detail: node ? `${node.status} ${node.detail}` : 'no node line' };
    });

    const sorted = classifyDoctor(lines, providerKinds(home), { realHome });
    const bad = sorted.filter((c) => c.verdict === 'bad');
    const allowed = sorted.filter((c) => c.verdict === 'allowed');
    const unjudged = sorted.filter((c) => c.verdict === 'no-secrets');
    await check(`jv doctor: every line OK or an allowed WARN${realHome ? '' : ' (lines that need a secret are not judged in a temporary home)'}`, () => ({
      ok: bad.length === 0,
      detail: [
        `${sorted.filter((c) => c.verdict === 'ok').length} OK`,
        `${allowed.length} allowed WARN${allowed.length ? ` (${allowed.map((c) => `${c.name}: ${c.why}`).join('; ')})` : ''}`,
        ...(unjudged.length ? [`${unjudged.length} not judged without secrets (${unjudged.map((c) => `${c.status} ${c.name}`).join(', ')})`] : []),
        ...(bad.length ? [`not allowed: ${bad.map((c) => `${c.status} ${c.name}: ${c.detail}`).join(' | ')}`] : []),
      ].join('; '),
    }));
    if (unjudged.length) note(`doctor lines not judged in a temporary home (no secrets copied; judged by --real): ${unjudged.map((c) => `${c.status} ${c.name}: ${c.detail}`).join(' | ')}`);
    if (!realHome) note(`bin/jv.mjs ${BIN_JV}; run with --real for the record (bootstraps and checks ~/.jv)`);

    return finish(JOURNEY, { startedAt: started, mode });
  } finally {
    if (flags.keep) log(`kept ${dir}`);
    else cleanup(id);
  }
}

runJourney(JOURNEY, main);
