// M17 Member untouched (brief section 14): the Jevellan member on this machine kept running and nothing of it was
// written by this run. At phase 0 acceptance/baseline/ recorded `launchctl list` for dev.jevellan.daemon and
// dev.jevellan.playground.daemon and the run's start time (run-start.txt). Now:
// - both pids are unchanged;
// - no file under ~/.jevellan, ~/.jevellan-member or ~/.jevellan-playground has an mtime later than the start, except
//   what the member daemons write themselves (listed, not counted). The brief names logs/ and cache/; on this machine
//   the daemons also rewrite their own state files while they run (hub/ database and WAL, locks/, cleanup/,
//   rigging/application.json, settings-sync.json), so those top-level state locations count as the daemons' too
//   (M-036). Anything else, and anything under homes/ or projects/ (the account homes and checkouts jv only reads
//   through seeds.json), counts;
// - no jv code, test, script or journey calls the jevellan command: every text file git lists (tracked, or untracked
//   and not ignored) under packages/, bin/, scripts/ and acceptance/ is searched for a spawn, spawnSync, exec,
//   execSync, execFile, execFileSync, execCommand or run call whose first argument names jevellan, also when the call
//   is wrapped after its parenthesis. A pathspec that lists no file, or git failing, fails the check, so the search
//   can never pass by searching nothing. A call found is named by file, line and function only, never its argument,
//   so the detail RESULTS.md records is never call-shaped itself.
//
// Usage: node acceptance/m17-member-untouched.mjs
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m17.json.

import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BASELINE_DIR, check, finish, HOME, log, note, run, runJourney } from './lib.mjs';

const JOURNEY = 'm17';
const FOLDERS = ['.jevellan', '.jevellan-member', '.jevellan-playground'].map((f) => join(HOME, f));
const LABELS = ['dev.jevellan.daemon', 'dev.jevellan.playground.daemon'];

/** What a member daemon writes itself, by its path below the folder (M-036). */
const DAEMON_OWN = [/^logs\//, /^cache\//, /^hub\//, /^locks\//, /^cleanup\//, /^rigging\/application\.json$/, /^settings-sync\.json$/];
const NEVER = [/^homes\//, /^projects\//];

/** Where a call of the jevellan command would be: all jv code and its tests, the scripts and these journeys. */
const SOURCE_SPECS = [':(glob)packages/**', 'bin', 'scripts', 'acceptance'];
/**
 * A call that runs the jevellan command: one of the process functions (and doctor's execCommand, lib.mjs's run)
 * whose first argument is a string naming jevellan bare, by a path, or after a space, ;, &, | or parenthesis of a
 * shell command. \s matches line breaks too, so a call wrapped after its parenthesis is found.
 */
const JEVELLAN_CALL = /(?<![\w$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|execCommand|run)\(\s*['"`](?:[^'"`]*[\s/;&|(])?jevellan(?![\w./-])/g;

/**
 * The calls of the jevellan command in the files git lists under SOURCE_SPECS of `root`: {files, calls} with
 * "file:line (function)" calls, or {error} when git fails or a pathspec lists no file. A call is named without its
 * quoted argument: the detail goes into acceptance/RESULTS.md, which this check searches too, and a call-shaped
 * detail there would fail every later run (the M16 trap, M-037).
 */
function jevellanCalls(root) {
  const files = new Set();
  for (const spec of SOURCE_SPECS) {
    const r = run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', spec]);
    if (r.code !== 0) return { error: `git ls-files ${spec} failed (${r.code ?? r.error}): ${r.stderr.trim()}` };
    const listed = r.stdout.split('\0').filter(Boolean);
    if (listed.length === 0) return { error: `the pathspec ${spec} lists no file in ${root}` };
    for (const f of listed) files.add(f);
  }
  const calls = [];
  let searched = 0;
  for (const file of [...files].sort()) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // listed by the index but deleted in the working tree
    }
    if (text.includes('\0')) continue; // binary (screenshots, fonts)
    searched += 1;
    for (const m of text.matchAll(JEVELLAN_CALL)) {
      const line = text.slice(0, m.index).split('\n').length;
      calls.push(`${file}:${line} (${m[1]})`);
    }
  }
  return { files: searched, calls };
}

function launchdPids() {
  const out = run('launchctl', ['list']).stdout;
  const pids = {};
  for (const line of out.split('\n')) {
    const [pid, , label] = line.split('\t');
    if (LABELS.includes(label)) pids[label] = pid;
  }
  return pids;
}

async function main() {
  const started = Date.now();
  const start = readFileSync(join(BASELINE_DIR, 'run-start.txt'), 'utf8').trim();
  log(`M17 Member untouched (run start ${start})`);

  await check('the member daemons kept their pids', () => {
    const before = {};
    for (const line of readFileSync(join(BASELINE_DIR, 'launchctl-member.txt'), 'utf8').trim().split('\n')) {
      const [pid, , label] = line.split('\t');
      before[label] = pid;
    }
    const now = launchdPids();
    const same = LABELS.every((l) => before[l] && before[l] === now[l]);
    return { ok: same, detail: LABELS.map((l) => `${l} ${before[l] ?? '?'} -> ${now[l] ?? 'gone'}`).join(', ') };
  });

  await check('no file under the member folders changed since the start, except the daemons\' own writes', () => {
    const startMs = Date.parse(start);
    const changed = [];
    for (const folder of FOLDERS) {
      const r = run('find', [folder, '-type', 'f', '-newermt', new Date(startMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')], { timeoutMs: 600_000 });
      for (const file of r.stdout.split('\n').filter(Boolean)) {
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime > startMs) changed.push({ folder, rel: relative(folder, file) });
      }
    }
    const own = changed.filter((c) => !NEVER.some((re) => re.test(c.rel)) && DAEMON_OWN.some((re) => re.test(c.rel)));
    const counted = changed.filter((c) => !own.includes(c));
    for (const c of own) note(`written by the member daemon (listed, not counted): ~/${relative(HOME, join(c.folder, c.rel))}`);
    for (const c of counted) note(`COUNTED: ~/${relative(HOME, join(c.folder, c.rel))}`);
    return { ok: counted.length === 0, detail: `${changed.length} changed, ${own.length} the daemons' own, ${counted.length} counted` };
  });

  await check('the jevellan command was never run by jv (no jv code, test, script or journey calls it)', () => {
    const found = jevellanCalls(join(BASELINE_DIR, '..', '..'));
    if (found.error) return { ok: false, detail: found.error };
    return {
      ok: found.files > 0 && found.calls.length === 0,
      detail: found.calls.length ? `${found.calls.length} calls of the jevellan command: ${found.calls.join('; ')}` : `no call of the jevellan command in ${found.files} files under ${SOURCE_SPECS.join(', ')}`,
    };
  });

  return finish(JOURNEY, { startedAt: started, mode: 'this machine' });
}

runJourney(JOURNEY, main);
