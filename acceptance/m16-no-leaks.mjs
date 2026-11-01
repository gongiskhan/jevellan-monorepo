// M16 No leaks (brief section 14): grep the store (with its WAL and the v1 backup), every log under ~/.jv/logs, every
// .jv-evidence/ folder (task worktrees under ~/.jv/worktrees and the sandbox checkouts) and acceptance/ for the
// contents of every file in ~/.jv/secrets/ and for the two token variable names of the brief (the Anthropic auth
// token, and the Claude Code OAuth token followed by '='); nothing matches.
// Then `npm run scan:secrets` on the repository (with --values-from ~/.jv/secrets, M-032) passes. Patterns go to grep
// on stdin and only file names come back (lib.mjs leakCheck): no secret is ever printed.
//
// Usage: node acceptance/m16-no-leaks.mjs
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m16.json.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCEPT_DIR, CHECKOUT, check, finish, HOME, leakCheck, log, NODE, note, REAL_JV_HOME, run, runJourney, SANDBOX, SANDBOX_CLONE } from './lib.mjs';

const JOURNEY = 'm16';
/** The two token variable names of the brief, built from parts so this file (inside acceptance/) never holds them. */
const TOKEN_VARIABLES = [['ANTHROPIC', 'AUTH', 'TOKEN'].join('_'), `${['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_')}=`];

function evidenceFolders() {
  const roots = [join(REAL_JV_HOME, 'worktrees'), SANDBOX, SANDBOX_CLONE].filter((p) => existsSync(p));
  const out = [];
  for (const root of roots) {
    const r = run('find', [root, '-type', 'd', '-name', '.jv-evidence', '-not', '-path', '*/node_modules/*'], { timeoutMs: 300_000 });
    out.push(...r.stdout.split('\n').filter(Boolean));
  }
  return out;
}

async function main() {
  const started = Date.now();
  log('M16 No leaks');
  const store = join(REAL_JV_HOME, 'store.sqlite');
  const targets = [store, `${store}-wal`, `${store}.v1.bak`, join(REAL_JV_HOME, 'logs'), ...evidenceFolders(), ACCEPT_DIR].filter((p) => existsSync(p));
  note(`checked: ${targets.map((t) => t.replace(HOME, '~')).join(', ')}`);

  await check('no secret file content and no token variable in the store, logs, evidence or acceptance/', () => {
    // The UI password lives next to the store, not in secrets/ (M-044): its value is searched for too.
    const uiPassword = existsSync(join(REAL_JV_HOME, 'ui-password')) ? [readFileSync(join(REAL_JV_HOME, 'ui-password'), 'utf8').trim()].filter((v) => v.length >= 6) : [];
    const r = leakCheck(targets, { secretsDir: join(REAL_JV_HOME, 'secrets'), literals: [...TOKEN_VARIABLES, ...uiPassword] });
    return {
      ok: r.secrets > 0 && r.leaks.length === 0 && r.errors.length === 0,
      detail: `${r.secrets} secret files, the UI password${uiPassword.length ? '' : ' (none yet)'} and 2 token names against ${r.checked.length} paths${r.leaks.length ? `; found: ${r.leaks.map((l) => `${l.secret} in ${l.file}`).join(', ')}` : ''}${r.errors.length ? `; errors: ${r.errors.join(', ')}` : ''}`,
    };
  });

  await check('npm run scan:secrets passes on the repository (with the values of ~/.jv/secrets)', () => {
    const r = run(NODE, [join(CHECKOUT, 'scripts', 'secret-scan.mjs'), '--values-from', join(REAL_JV_HOME, 'secrets')], { cwd: CHECKOUT, timeoutMs: 300_000 });
    return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().split('\n').slice(-2).join(' / ') };
  });

  return finish(JOURNEY, { startedAt: started, mode: 'the real ~/.jv and this checkout' });
}

runJourney(JOURNEY, main);
