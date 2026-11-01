#!/usr/bin/env node
// Runs the acceptance journeys of brief section 14 in order (m01 to m17, the ones written so far), each in its own
// Node 22.22.0 process, collects acceptance/results/<journey>.json and writes acceptance/RESULTS.md: a table of
// journey, status, elapsed time and when it ran, then one section per journey with its checks and notes. A journey
// with no script yet is listed as "not written yet"; one that ran but recorded nothing (a dry run, such as m03
// without --real, or a crash) as "no result" with its exit code. Each journey's output also goes to
// acceptance/results/<journey>.log.
//
// --real, --keep and --no-build are passed to every journey (lib.mjs SHARED_BOOLEANS; a journey ignores the ones it
// has no use for). --only m01,m03 runs those journeys and keeps the earlier results of the others in the report;
// --report-only runs nothing and rewrites the report from the results on disk; --out FILE writes the report
// elsewhere.
//
// Usage: node acceptance/run-all.mjs [--only m01,m02] [--real] [--keep] [--no-build] [--report-only] [--out FILE]
// Exit 0 when every journey that ran passed, 1 otherwise.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { ACCEPT_DIR, CHECKOUT, duration, git, JOURNEYS, log, NODE, parseFlags, RESULTS_DIR, RESULTS_FILE, SHARED_BOOLEANS } from './lib.mjs';

const USAGE = 'Usage: node acceptance/run-all.mjs [--only m01,m02] [--real] [--keep] [--no-build] [--report-only] [--out FILE]';

function scriptOf(id) {
  return readdirSync(ACCEPT_DIR).find((f) => f.startsWith(`${id}-`) && f.endsWith('.mjs'));
}

function readResult(id) {
  const file = join(RESULTS_DIR, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Runs one journey script, its output to the console and to results/<id>.log. Resolves {code, ms}. */
function runScript(id, script, args) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = createWriteStream(join(RESULTS_DIR, `${id}.log`));
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(NODE, ['--disable-warning=ExperimentalWarning', join(ACCEPT_DIR, script), ...args], { cwd: CHECKOUT, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => {
      process.stdout.write(c);
      out.write(c);
    });
    child.stderr.on('data', (c) => {
      process.stderr.write(c);
      out.write(c);
    });
    child.on('close', (code, signal) => {
      out.end();
      done({ code: code ?? (signal ? `signal ${signal}` : null), ms: Date.now() - started });
    });
  });
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function when(iso) {
  return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC') : '';
}

function bullet(text) {
  const t = String(text);
  if (!t.includes('\n')) return `- ${t}`;
  const [first, ...rest] = t.split('\n');
  return [`- ${first}`, '', '  ```', ...rest.map((l) => `  ${l}`), '  ```'].join('\n');
}

/** The report text: one table, then a section per journey. */
function renderReport(entries, meta) {
  const lines = [
    '# Acceptance results',
    '',
    `Written by \`acceptance/run-all.mjs\` at ${when(meta.at)} on ${meta.host}, checkout \`${meta.checkout}\` at ${meta.commit}. Journeys are the ones of brief section 14; each section below lists the journey's own checks (PASS or FAIL, with the time each took) and notes, from \`acceptance/results/<journey>.json\`.`,
    '',
    '| Journey | Title | Status | Elapsed | Ran at | Mode |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const e of entries) {
    lines.push(`| ${e.name} | ${cell(e.title)} | ${cell(e.status)} | ${duration(e.elapsedMs)} | ${when(e.result?.finishedAt)} | ${cell(e.result?.mode ?? '')} |`);
  }
  const counts = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  lines.push('', `Totals: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
  for (const e of entries) {
    lines.push('', `## ${e.name} ${e.title}`, '');
    if (!e.result) {
      lines.push(`Status: ${e.status}.${e.detail ? ` ${e.detail}` : ''}`);
      continue;
    }
    const r = e.result;
    const passed = r.checks.filter((c) => c.ok).length;
    lines.push(
      `Status: ${r.status}${e.status !== r.status ? ` (${e.status})` : ''}. ${passed} of ${r.checks.length} checks passed in ${duration(r.elapsedMs)}; ran ${when(r.startedAt)} to ${when(r.finishedAt)} on ${r.host}, commit ${r.commit}${r.mode ? `, mode: ${r.mode}` : ''}.${e.detail ? ` ${e.detail}` : ''}`,
      '',
      'Checks:',
      '',
    );
    for (const c of r.checks) lines.push(bullet(`${c.ok ? 'PASS' : 'FAIL'} ${c.name} (${(c.ms / 1000).toFixed(1)} s)${c.detail ? `: ${c.detail}` : ''}`));
    if (r.notes?.length) {
      lines.push('', 'Notes:', '');
      for (const n of r.notes) lines.push(bullet(n));
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { booleans: ['report-only'], values: ['only', 'out'], usage: USAGE });
  const only = flags.only ? new Set(String(flags.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : undefined;
  if (only) {
    const unknown = [...only].filter((id) => !JOURNEYS.some((j) => j.id === id));
    if (unknown.length) {
      process.stderr.write(`unknown journeys: ${unknown.join(', ')} (known: ${JOURNEYS.map((j) => j.id).join(', ')})\n`);
      return 2;
    }
  }
  const passOn = SHARED_BOOLEANS.filter((f) => f !== 'help' && flags[f]).map((f) => `--${f}`);
  const startedIso = new Date().toISOString();
  if (!flags.real && !flags['report-only']) log('without --real: m01 bootstraps a temporary home only and m03 prints its plan; pass --real for the record runs');
  const entries = [];
  let ranFailed = false;

  for (const j of JOURNEYS) {
    const script = scriptOf(j.id);
    if (!script) {
      entries.push({ ...j, status: 'not written yet' });
      continue;
    }
    const selected = !flags['report-only'] && (!only || only.has(j.id));
    if (!selected) {
      const earlier = readResult(j.id);
      entries.push(earlier ? { ...j, status: earlier.status, elapsedMs: earlier.elapsedMs, result: earlier, detail: 'From an earlier run (not run this time).' } : { ...j, status: 'not run' });
      continue;
    }
    log(`\n==== ${j.name} ${j.title}: node acceptance/${script} ${passOn.join(' ')}`.trimEnd());
    const ran = await runScript(j.id, script, passOn);
    const result = readResult(j.id);
    if (result && result.finishedAt >= startedIso) {
      entries.push({ ...j, status: result.status, elapsedMs: result.elapsedMs ?? ran.ms, result });
      if (result.status !== 'pass') ranFailed = true;
    } else {
      entries.push({ ...j, status: 'no result', elapsedMs: ran.ms, detail: `The script exited ${ran.code} and recorded nothing (a dry run, or it crashed); its output is in acceptance/results/${j.id}.log.` });
      if (ran.code !== 0) ranFailed = true;
    }
  }

  const out = flags.out ? resolve(String(flags.out)) : RESULTS_FILE;
  const report = renderReport(entries, { at: new Date().toISOString(), host: hostname(), checkout: CHECKOUT, commit: git(CHECKOUT, ['rev-parse', '--short', 'HEAD']) });
  writeFileSync(out, report);
  log(`\n${entries.map((e) => `${e.name.padEnd(4)} ${e.status}`).join('\n')}\n\nwrote ${out}`);
  return ranFailed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`run-all crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
