// M17 Member untouched (brief section 14): the Jevellan member on this machine kept running and nothing of it was
// written by this run. At phase 0 acceptance/baseline/ recorded `launchctl list` for dev.jevellan.daemon and
// dev.jevellan.playground.daemon and the run's start time (run-start.txt). Now:
// - both pids are unchanged;
// - no file under ~/.jevellan, ~/.jevellan-member or ~/.jevellan-playground has an mtime later than the start, except
//   what the member daemons write themselves (listed, not counted). The brief names logs/ and cache/; on this machine
//   the daemons also rewrite their own state files while they run (hub/ database and WAL, locks/, cleanup/,
//   rigging/application.json, settings-sync.json), so those top-level state locations count as the daemons' too
//   (M-036). Anything else, and anything under homes/ or projects/ (the account homes and checkouts jv only reads
//   through seeds.json), counts.
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

  await check('the jevellan command was never run by jv (no jv code names it)', () => {
    const r = run('git', ['-C', join(BASELINE_DIR, '..', '..'), 'grep', '-n', '-E', "spawn\\(['\"]jevellan['\"]|execFile(Sync)?\\(['\"]jevellan['\"]", '--', 'packages/*/src', 'packages/ui/server']);
    return { ok: r.stdout.trim() === '', detail: r.stdout.trim() || 'no call of the jevellan command in the sources' };
  });

  return finish(JOURNEY, { startedAt: started, mode: 'this machine' });
}

runJourney(JOURNEY, main);
