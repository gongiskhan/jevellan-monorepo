// M14 Service file (brief section 14): jv bot install-service writes the launchd plist; plutil -lint passes; the
// plist's program is the Node 22.22.0 binary and the checkout's packages/cli/dist/bin.js with `bot start`; launchctl
// list does not show dev.jevellan.bot (the run never loads it). macOS only.
//
// By default everything is temporary: a JV_HOME under ~/.jv-test/<run id>/ bootstrapped from this checkout (so
// install.json records the Node binary, D-001), and an owner home next to it that the plist goes into
// (`--owner-home`, the command's internal flag); the journey also checks that a second run changes nothing and that a
// different file already there is archived under $JV_HOME/archive/service/ first. With --real it writes the owner's
// real ~/Library/LaunchAgents/dev.jevellan.bot.plist for the real ~/.jv (bootstrapped by M1) and still loads nothing:
// loading it is the owner's `launchctl bootstrap` (printed). No provider, no Jev, no network.
//
// Usage: node acceptance/m14-service-file.mjs [--real] [--keep]
// Exit 0 when every check passes, 1 otherwise, 2 when blocked (not macOS). Writes acceptance/results/m14.json.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLI_ENTRY,
  check,
  cleanup,
  finish,
  jvJson,
  log,
  NODE,
  NODE_VERSION,
  note,
  parseFlags,
  REAL_JV_HOME,
  run,
  runDir,
  runId,
  runJourney,
  SKILLS_REPO,
  tempHome,
} from './lib.mjs';

const JOURNEY = 'm14';
const USAGE = 'node acceptance/m14-service-file.mjs [--real] [--keep]';
const LABEL = 'dev.jevellan.bot';

/** A path as jv prints it: under the owner's home with ~/. */
function shown(file) {
  const home = homedir();
  return file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

function same(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function plistJson(file) {
  const r = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  return r.code === 0 ? JSON.parse(r.stdout) : undefined;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: USAGE });
  const real = flags.real === true;
  const started = Date.now();
  const mode = real ? 'the owner\'s real ~/Library/LaunchAgents and ~/.jv (written, not loaded)' : 'a temporary JV_HOME and owner home';
  if (process.platform !== 'darwin') {
    note(`blocked: launchd plists are macOS only (this is ${process.platform})`);
    return finish(JOURNEY, { startedAt: started, mode, blocked: `not macOS (${process.platform})` });
  }
  const id = runId(JOURNEY);
  log(`M14 Service file ${id} (${real ? 'real' : 'temporary'})`);
  try {
    const home = real ? REAL_JV_HOME : tempHome(id);
    const owner = real ? homedir() : join(runDir(id), 'owner');
    const file = join(owner, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const opts = { home, real };
    const ownerArgs = real ? [] : ['--owner-home', owner];

    if (!real) {
      await check(`jv bootstrap --skills ${SKILLS_REPO} into the temporary home records the Node binary`, () => {
        const b = jvJson(['bootstrap', '--skills', SKILLS_REPO], { home, timeoutMs: 10 * 60_000 });
        const install = existsSync(join(home, 'install.json')) ? JSON.parse(readFileSync(join(home, 'install.json'), 'utf8')) : {};
        return { ok: b.code === 0 && same(install.nodePath, NODE), detail: b.code === 0 ? `nodePath ${install.nodePath}; cliEntry ${install.cliEntry}` : b.stderr || b.stdout };
      });
    }

    let out;
    await check('jv bot install-service writes the plist and prints the launchctl commands, loading nothing', () => {
      const r = jvJson(['bot', 'install-service', ...ownerArgs], opts);
      out = r.json;
      const ok =
        r.code === 0 &&
        out?.file === file &&
        existsSync(file) &&
        out.load?.[0] === `launchctl bootstrap gui/$(id -u) ${shown(file)}` &&
        out.unload?.[0] === `launchctl bootout gui/$(id -u)/${LABEL}`;
      return { ok, detail: r.code === 0 ? `${out.file} (${out.written ? 'written' : 'unchanged'}${out.archived ? `, the old one archived at ${out.archived}` : ''}); load: ${out.load?.join(' ; ')}; warnings: ${(out.warnings ?? []).join('; ') || 'none'}` : r.stderr || r.stdout };
    });

    await check('plutil -lint passes', () => {
      const r = run('/usr/bin/plutil', ['-lint', file]);
      return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim() };
    });

    await check(`the program is the Node ${NODE_VERSION} binary and the checkout's bin.js with bot start; the label, environment and keep-alive`, () => {
      const p = plistJson(file);
      if (!p) return { ok: false, detail: 'plutil -convert json failed' };
      const args = p.ProgramArguments ?? [];
      const env = p.EnvironmentVariables ?? {};
      const node22 = same(args[0], NODE) && args[0].includes(`/v${NODE_VERSION}/`);
      const entry = same(args[2], CLI_ENTRY);
      const rest = args[1] === '--disable-warning=ExperimentalWarning' && args[3] === 'bot' && args[4] === 'start' && args.length === 5;
      const environment = env.HOME === owner && env.JV_HOME === home && String(env.PATH ?? '').split(':').includes(dirname(NODE)) && String(env.PATH).includes('/usr/bin');
      const keep = p.Label === LABEL && p.RunAtLoad === true && p.KeepAlive === true && p.StandardOutPath === join(home, 'logs', 'bot.launchd.log') && p.StandardErrorPath === p.StandardOutPath;
      return {
        ok: node22 && entry && rest && environment && keep,
        detail: `program ${args.join(' ')}; PATH ${env.PATH}; HOME ${env.HOME}; JV_HOME ${env.JV_HOME}; RunAtLoad ${p.RunAtLoad}; KeepAlive ${p.KeepAlive}; log ${p.StandardOutPath}`,
      };
    });

    await check('a second run changes nothing', () => {
      const r = jvJson(['bot', 'install-service', ...ownerArgs], opts);
      return { ok: r.code === 0 && r.json?.written === false && !r.json?.archived, detail: r.code === 0 ? `written ${r.json.written}` : r.stderr || r.stdout };
    });

    if (!real) {
      await check('a different file already there is archived under $JV_HOME/archive/service/ before the new one is written', () => {
        const older = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>dev.jevellan.bot</string></dict></plist>\n';
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, older);
        const r = jvJson(['bot', 'install-service', ...ownerArgs], opts);
        const archived = r.json?.archived;
        const ok = r.code === 0 && r.json.written === true && typeof archived === 'string' && archived.startsWith(join(home, 'archive', 'service') + '/') && readFileSync(archived, 'utf8') === older && readFileSync(file, 'utf8') !== older;
        return { ok, detail: r.code === 0 ? `archived at ${archived}` : r.stderr || r.stdout };
      });
    }

    await check(`launchctl list does not show ${LABEL} (not loaded by the run)`, () => {
      const r = run('launchctl', ['list']);
      const loaded = r.stdout.split('\n').some((line) => line.split('\t')[2] === LABEL);
      return { ok: r.code === 0 && !loaded, detail: r.code === 0 ? `${r.stdout.trim().split('\n').length - 1} jobs listed; ${LABEL} ${loaded ? 'is loaded' : 'is not among them'}` : r.stderr };
    });
    note(real ? `the plist stays at ${file} for the owner to load` : `temporary owner home ${owner}`);
  } finally {
    if (!flags.keep && !real) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode });
}

runJourney(JOURNEY, main);
