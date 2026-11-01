// The monorepo's doctor checks (brief sections 1, 4, 6, 8 and 11): the installed skills against the jevellan-skills
// checkout install.json records, jv's ports, FTS5 in node:sqlite, the bot's service file and the Jevellan member.
// Everything outside the temporary JV_HOME is injected: lsof and launchctl through a fake exec, the platform, the
// owner's home and the FTS5 probes. No real port, launchd job or Node other than this one is ever asked.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'jv-doctor-mono-test-')));
const home = join(root, 'jvhome');
mkdirSync(join(home, 'run'), { recursive: true });
process.env.JV_HOME = home;

const D = await import('../src/doctor.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
type ExecResult = import('../src/doctor.js').ExecResult;
type ExecOptions = import('../src/doctor.js').ExecOptions;
type CheckResult = import('../src/doctor.js').CheckResult;
type DoctorDeps = import('../src/doctor.js').DoctorDeps;

after(() => rmSync(root, { recursive: true, force: true }));

const version = (JSON.parse(readFileSync(join(RUNTIME_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const SKILLS = ['jevellan-router', 'jevellan-landing', 'jevellan-duty-plan'];

/** A jevellan-skills checkout: .apm/skills/<name>/SKILL.md, the router with its scripts/ (never installed, D-010). */
const checkout = join(root, 'jevellan-skills');
function writeSkill(dir: string, name: string, body: string, v = version): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\njv-version: ${v}\n---\n\n${body}\n`);
}
const checkoutSkills = join(checkout, '.apm', 'skills');
for (const n of SKILLS) writeSkill(checkoutSkills, n, `Body of ${n}.`);
mkdirSync(join(checkoutSkills, 'jevellan-router', 'scripts', 'jv'), { recursive: true });
writeFileSync(join(checkoutSkills, 'jevellan-router', 'scripts', 'jv', 'cli.ts'), '// the skills repository runtime\n');
mkdirSync(join(checkoutSkills, 'other-skill'), { recursive: true });
writeFileSync(join(checkoutSkills, 'other-skill', 'SKILL.md'), 'not a jevellan skill\n');

/** What jv bootstrap installs: the jevellan-* folders without the router's scripts/, and install.json (null: none). */
function install(record: Record<string, unknown> | null = { skillsSource: checkout, skillsVersion: version }): void {
  rmSync(join(home, 'skills'), { recursive: true, force: true });
  for (const n of SKILLS) cpSync(join(checkoutSkills, n), join(home, 'skills', n), { recursive: true, filter: (src) => !src.includes('/scripts') });
  rmSync(join(home, 'install.json'), { force: true });
  if (record) writeFileSync(join(home, 'install.json'), JSON.stringify(record));
}

const ownerHome = join(root, 'owner');
mkdirSync(ownerHome);

interface Call {
  command: string;
  args: readonly string[];
}

/** lsof answers per port (stdout of `-Fpc`, or a whole result); launchctl list answers `launchd`. */
function fakeExec(opts: { ports?: Record<number, string | ExecResult>; launchd?: string | ExecResult; lsofMissing?: boolean; lsofOnlyAt?: string } = {}) {
  const calls: Call[] = [];
  const exec = async (command: string, args: readonly string[], _options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args });
    if (command === 'lsof' || command.endsWith('/lsof')) {
      if (opts.lsofMissing || (opts.lsofOnlyAt !== undefined && command !== opts.lsofOnlyAt)) return { code: null, stdout: '', stderr: '', error: 'not-found' };
      const port = Number(/^-iTCP:(\d+)$/.exec(args.find((a) => a.startsWith('-iTCP:')) ?? '')?.[1]);
      const answer = opts.ports?.[port];
      if (answer === undefined) return { code: 1, stdout: '', stderr: '' };
      return typeof answer === 'string' ? { code: 0, stdout: answer, stderr: '' } : answer;
    }
    if (command === 'launchctl') {
      const answer = opts.launchd ?? 'PID\tStatus\tLabel\n651\t0\tcom.apple.trustd.agent\n';
      return typeof answer === 'string' ? { code: 0, stdout: answer, stderr: '' } : answer;
    }
    return { code: null, stdout: '', stderr: '', error: 'not-found' };
  };
  return { exec, calls };
}

function deps(over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    exec: fakeExec().exec,
    platform: 'darwin',
    ownerHome,
    execPath: '/opt/node22/bin/node',
    nodeVersion: '22.22.0',
    fts5Probe: () => undefined,
    findFts5Node: async () => undefined,
    ...over,
  };
}

const byName = (rs: CheckResult[]) => new Map(rs.map((r) => [r.name, r]));

describe('skills: the installed skills, the checkout and the recorded version', () => {
  test('installed from the recorded checkout: three OK lines; the router scripts/ and other skills do not count', async () => {
    install();
    const rs = await D.runChecks(['skills'], deps());
    assert.deepEqual(rs.map((r) => [r.name, r.status]), [
      ['skills', 'OK'],
      ['skills:checkout', 'OK'],
      ['skills:version', 'OK'],
    ]);
    const m = byName(rs);
    assert.equal(m.get('skills:checkout')!.detail, `the skills in ${join(home, 'skills')} match the checkout ${checkout}`);
    assert.equal(m.get('skills:version')!.detail, `the router's jv-version ${version} is the one jv bootstrap recorded`);
    assert.equal(m.get('skills')!.detail, `3 skills in ${join(home, 'skills')} at version ${version}`);
  });

  test('without the router skill this jv does not run: FAIL with the bootstrap fix, and nothing else', async () => {
    install();
    rmSync(join(home, 'skills', 'jevellan-router'), { recursive: true });
    const rs = await D.runChecks(['skills'], deps());
    assert.equal(rs.length, 1);
    assert.equal(rs[0]!.name, 'skills');
    assert.equal(rs[0]!.status, 'FAIL');
    assert.equal(rs[0]!.detail, `no jevellan-router skill at ${join(home, 'skills', 'jevellan-router', 'SKILL.md')}: this jv does not run without the skills`);
    assert.equal(rs[0]!.fix, `jv bootstrap --skills ${checkout}`);
    // With no usable checkout recorded, the fix names what to pass.
    install(null);
    rmSync(join(home, 'skills'), { recursive: true });
    const [none] = await D.runChecks(['skills'], deps());
    assert.equal(none!.status, 'FAIL');
    assert.equal(none!.fix, 'jv bootstrap --skills <path to a jevellan-skills checkout>');
    // A FAIL anywhere is what makes jv doctor exit 2 (D-013).
    assert.ok(rs.some((r) => r.status === 'FAIL'));
  });

  test('a checkout that moved on since the install: WARN, jv update', async () => {
    install();
    const file = join(checkoutSkills, 'jevellan-landing', 'SKILL.md');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}\nA new rule.\n`);
    try {
      const m = byName(await D.runChecks(['skills'], deps()));
      assert.equal(m.get('skills:checkout')!.status, 'WARN');
      assert.equal(m.get('skills:checkout')!.detail, `the skills in ${join(home, 'skills')} differ from the checkout ${checkout}`);
      assert.equal(m.get('skills:checkout')!.fix, 'jv update');
      assert.equal(m.get('skills:version')!.status, 'OK');
    } finally {
      writeFileSync(file, original);
    }
    // A change under the router's scripts/ (the skills repository's own runtime) is not a skills change.
    writeFileSync(join(checkoutSkills, 'jevellan-router', 'scripts', 'jv', 'cli.ts'), '// changed\n');
    assert.equal(byName(await D.runChecks(['skills:checkout'], deps())).get('skills:checkout')!.status, 'OK');
  });

  test('no checkout recorded, or a recorded checkout that is gone: WARN with the bootstrap fix', async () => {
    install({ skillsVersion: version });
    let m = byName(await D.runChecks(['skills'], deps()));
    assert.equal(m.get('skills:checkout')!.status, 'WARN');
    assert.match(m.get('skills:checkout')!.detail, /^no skills checkout recorded in .*install\.json/);
    assert.equal(m.get('skills:checkout')!.fix, 'jv bootstrap --skills <path to a jevellan-skills checkout>');
    assert.equal(m.get('skills:version')!.status, 'OK');

    install({ skillsSource: join(root, 'moved-away'), skillsVersion: version });
    m = byName(await D.runChecks(['skills'], deps()));
    assert.equal(m.get('skills:checkout')!.status, 'WARN');
    assert.equal(m.get('skills:checkout')!.detail, `the recorded skills checkout ${join(root, 'moved-away')} is missing`);
    assert.equal(m.get('skills:checkout')!.fix, 'jv bootstrap --skills <path to a jevellan-skills checkout>');

    mkdirSync(join(root, 'not-skills'), { recursive: true });
    install({ skillsSource: join(root, 'not-skills'), skillsVersion: version });
    m = byName(await D.runChecks(['skills'], deps()));
    assert.match(m.get('skills:checkout')!.detail, /is not a jevellan-skills checkout any more$/);

    // No install.json at all: both comparisons warn, neither fails.
    install(null);
    m = byName(await D.runChecks(['skills'], deps()));
    assert.equal(m.get('skills')!.status, 'OK');
    assert.equal(m.get('skills:checkout')!.status, 'WARN');
    assert.equal(m.get('skills:version')!.status, 'WARN');
    assert.match(m.get('skills:version')!.detail, new RegExp(`recorded no skills version .* \\(the router's jv-version is ${version.replace(/\./g, '\\.')}\\)`));
    assert.equal(m.get('skills:version')!.fix, 'jv bootstrap --skills <path to a jevellan-skills checkout>');
  });

  test("the router's jv-version against the one jv bootstrap recorded", async () => {
    install({ skillsSource: checkout, skillsVersion: '0.0.9' });
    const m = byName(await D.runChecks(['skills'], deps()));
    assert.equal(m.get('skills:version')!.status, 'WARN');
    assert.equal(m.get('skills:version')!.detail, `the router's jv-version is ${version}, jv bootstrap recorded 0.0.9`);
    assert.equal(m.get('skills:version')!.fix, 'jv update');
    install({ skillsSource: checkout, skillsVersion: null });
    const n = byName(await D.runChecks(['skills:version'], deps()));
    assert.equal(n.get('skills:version')!.status, 'WARN');
    assert.equal(n.get('skills:version')!.fix, 'jv update');
  });

  test('the per-skill jv-version line compares every skill with the installed router (M-022)', async () => {
    install();
    writeSkill(join(home, 'skills'), 'jevellan-duty-plan', 'Body of jevellan-duty-plan.', '0.0.9');
    const m = byName(await D.runChecks(['skills'], deps()));
    assert.equal(m.get('skills')!.status, 'WARN');
    assert.equal(m.get('skills')!.detail, `the router is at ${version}, these skills differ: jevellan-duty-plan 0.0.9`);
    assert.equal(m.get('skills')!.fix, 'run jv update');
    // The installed copy now differs from the checkout too.
    assert.equal(m.get('skills:checkout')!.status, 'WARN');
    install();
  });

  test('--check skills:checkout runs that line (with the group line, as D-013 selects)', async () => {
    install();
    const rs = await D.runChecks(['skills:checkout'], deps());
    assert.deepEqual(rs.map((r) => r.name), ['skills', 'skills:checkout']);
  });
});

describe('memory: FTS5 in node:sqlite', () => {
  test('this Node has FTS5 (the real probe), and the line says so', async () => {
    assert.equal(D.probeFts5(), undefined);
    const [line] = await D.runChecks(['memory'], deps({ fts5Probe: D.probeFts5 }));
    assert.equal(line!.status, 'OK');
    assert.equal(line!.detail, 'node:sqlite of Node 22.22.0 has FTS5');
  });

  test('without FTS5: FAIL naming a Node of this machine that has it, else what to install', async () => {
    let asked = 0;
    const [withOther] = await D.runChecks(
      ['memory'],
      deps({
        fts5Probe: () => 'no such module: fts5',
        findFts5Node: async () => (asked++, { path: '/opt/node24/bin/node', version: '24.22.0' }),
      }),
    );
    assert.equal(withOther!.status, 'FAIL');
    assert.equal(withOther!.detail, 'node:sqlite of this Node (/opt/node22/bin/node, 22.22.0) cannot create an FTS5 table, which jv memory needs: no such module: fts5');
    assert.equal(withOther!.fix, 'use /opt/node24/bin/node (Node 24.22.0, FTS5 present): jv bootstrap --node /opt/node24/bin/node');
    assert.equal(asked, 1);
    const [without] = await D.runChecks(['memory'], deps({ fts5Probe: () => 'no such module: fts5' }));
    assert.equal(without!.status, 'FAIL');
    assert.equal(without!.fix, 'install a Node 22.13 or later built with FTS5 and run jv bootstrap --node <its path>');
    // Another Node is looked for only when this one has no FTS5.
    asked = 0;
    await D.runChecks(['memory'], deps({ findFts5Node: async () => (asked++, undefined) }));
    assert.equal(asked, 0);
  });

  test('findFts5Node asks each candidate with a script and picks the newest that has FTS5', async () => {
    // The real Node running this test has FTS5.
    assert.deepEqual(await D.findFts5Node([process.execPath]), { path: process.execPath, version: process.versions.node });
    assert.equal(await D.findFts5Node([join(root, 'no-such-node')]), undefined);
    const answers: Record<string, ExecResult> = {
      '/a/node': { code: 0, stdout: '22.13.1', stderr: '' },
      '/b/node': { code: 0, stdout: '24.1.0', stderr: '' },
      '/c/node': { code: 1, stdout: '', stderr: 'Error: no such module: fts5' },
      '/d/node': { code: 3, stdout: '', stderr: '' },
    };
    const seen: Array<readonly string[]> = [];
    const exec = async (command: string, args: readonly string[]): Promise<ExecResult> => (seen.push(args), answers[command]!);
    assert.deepEqual(await D.findFts5Node(['/a/node', '/b/node', '/c/node', '/d/node'], exec), { path: '/b/node', version: '24.1.0' });
    assert.equal(seen[0]![0], '-e');
    assert.match(seen[0]![1]!, /CREATE VIRTUAL TABLE fts5_probe USING fts5\(x\)/);
    assert.equal(await D.findFts5Node(['/c/node', '/d/node'], exec), undefined);
  });

  test('nodeCandidates: the owner nvm versions newest first, then PATH and system places, each real file once', () => {
    const owner = join(root, 'nvm-owner');
    const nvm = join(owner, '.nvm', 'versions', 'node');
    for (const v of ['v20.19.4', 'v22.22.0', 'v24.22.0', 'v22.9.0']) {
      mkdirSync(join(nvm, v, 'bin'), { recursive: true });
      writeFileSync(join(nvm, v, 'bin', 'node'), '');
    }
    const pathDir = join(root, 'path-bin');
    mkdirSync(pathDir);
    symlinkSync(join(nvm, 'v22.22.0', 'bin', 'node'), join(pathDir, 'node'));
    const list = D.nodeCandidates(owner, { PATH: `${pathDir}:${join(root, 'nothing-here')}` });
    assert.deepEqual(list.slice(0, 4), ['v24.22.0', 'v22.22.0', 'v22.9.0', 'v20.19.4'].map((v) => join(nvm, v, 'bin', 'node')));
    // The PATH node is a link to an nvm one already listed.
    assert.ok(!list.includes(join(pathDir, 'node')));
  });
});

describe('ports: 7071 to 7073 free or held by jv', () => {
  const uiPid = join(home, 'run', 'ui.pid');
  const mcpPid = join(home, 'run', 'mcp.pid');
  const botLock = join(home, 'run', 'bot.lock');
  const botJson = join(home, 'bot.json');
  const clean = () => {
    for (const f of [uiPid, mcpPid, botLock, botJson]) rmSync(f, { force: true });
  };

  test('nothing listens: OK free on each port, lsof asked exactly as the brief says', async () => {
    clean();
    const fx = fakeExec();
    const rs = await D.runChecks(['ports'], deps({ exec: fx.exec }));
    assert.deepEqual(rs.map((r) => [r.name, r.status, r.detail]), [
      ['ports:ui', 'OK', 'port 7071 is free'],
      ['ports:mcp', 'OK', 'port 7072 is free'],
      ['ports:bot', 'OK', 'port 7073 is free'],
    ]);
    assert.deepEqual(fx.calls.map((c) => [c.command, ...c.args]).sort(), [
      ['lsof', '-nP', '-iTCP:7071', '-sTCP:LISTEN', '-Fpc', '-w'],
      ['lsof', '-nP', '-iTCP:7072', '-sTCP:LISTEN', '-Fpc', '-w'],
      ['lsof', '-nP', '-iTCP:7073', '-sTCP:LISTEN', '-Fpc', '-w'],
    ]);
  });

  test('held by the jv process of the pid file or the bot lock: OK with the pid', async () => {
    clean();
    writeFileSync(uiPid, '4242\n');
    writeFileSync(mcpPid, JSON.stringify({ pid: 4343, port: 7072 }));
    writeFileSync(botLock, '4444\n');
    const fx = fakeExec({ ports: { 7071: 'p4242\ncnode\nf21\n', 7072: 'p4343\ncnode\nf22\nf23\n', 7073: 'p4444\ncnode\nf24\n' } });
    const m = byName(await D.runChecks(['ports'], deps({ exec: fx.exec })));
    assert.equal(m.get('ports:ui')!.detail, 'port 7071: jv ui running (pid 4242)');
    assert.equal(m.get('ports:mcp')!.detail, 'port 7072: jv mcp running (pid 4343)');
    assert.equal(m.get('ports:bot')!.detail, 'port 7073: jv bot running (pid 4444)');
    for (const r of m.values()) assert.equal(r.status, 'OK');
  });

  test('held by anything else: FAIL naming the command and pid, with the --port fix', async () => {
    clean();
    writeFileSync(uiPid, '4242\n'); // a jv ui that is gone; the port is someone else's now
    const fx = fakeExec({ ports: { 7071: 'p911\ncpython3.12\nf3\n', 7072: 'p912\ncnode\nf4\n', 7073: 'p913\ncruby\nf5\n' } });
    const m = byName(await D.runChecks(['ports'], deps({ exec: fx.exec })));
    assert.equal(m.get('ports:ui')!.status, 'FAIL');
    assert.equal(m.get('ports:ui')!.detail, 'port 7071 is in use by python3.12 (pid 911)');
    assert.equal(m.get('ports:ui')!.fix, 'jv ui --port <another free port>');
    assert.equal(m.get('ports:mcp')!.detail, 'port 7072 is in use by node (pid 912)');
    assert.equal(m.get('ports:mcp')!.fix, 'jv mcp --http --port <another free port>');
    assert.equal(m.get('ports:bot')!.detail, 'port 7073 is in use by ruby (pid 913)');
    assert.equal(m.get('ports:bot')!.fix, `set health.port in ${botJson} to another free port`);
  });

  test("the bot's health port comes from bot.json; an invalid value keeps 7073", async () => {
    clean();
    writeFileSync(botJson, JSON.stringify({ tickSeconds: 15, health: { bind: '127.0.0.1', port: 7180 } }));
    const fx = fakeExec({ ports: { 7180: 'p77\ncnode\n' } });
    const [line] = await D.runChecks(['ports:bot'], deps({ exec: fx.exec }));
    assert.equal(line!.detail, 'port 7180 is in use by node (pid 77)');
    assert.deepEqual(fx.calls.map((c) => c.args[1]), ['-iTCP:7180']);
    assert.equal(D.botHealthPort(botJson), 7180);
    writeFileSync(botJson, JSON.stringify({ health: { port: 'seven' } }));
    assert.equal(D.botHealthPort(botJson), 7073);
    writeFileSync(botJson, '{ not json');
    assert.equal(D.botHealthPort(botJson), 7073);
    assert.equal(D.botHealthPort(join(root, 'no-bot.json')), 7073);
    clean();
  });

  test('without lsof: WARN on each line; a failing lsof is WARN too, never OK', async () => {
    clean();
    const rs = await D.runChecks(['ports'], deps({ exec: fakeExec({ lsofMissing: true }).exec }));
    assert.deepEqual(rs.map((r) => [r.status, r.detail, r.fix]), [
      ['WARN', 'port 7071 not checked: lsof is not on PATH, /usr/sbin or /usr/bin', 'install lsof'],
      ['WARN', 'port 7072 not checked: lsof is not on PATH, /usr/sbin or /usr/bin', 'install lsof'],
      ['WARN', 'port 7073 not checked: lsof is not on PATH, /usr/sbin or /usr/bin', 'install lsof'],
    ]);
    // lsof exits 1 on an error as on "nothing found"; the error text tells them apart (warnings are off with -w).
    const broken = fakeExec({ ports: { 7071: { code: 1, stdout: '', stderr: 'lsof: unknown service abc for tcp in: -i TCP:abc\nlsof 4.91\n' } } });
    const [ui] = await D.runChecks(['ports:ui'], deps({ exec: broken.exec }));
    assert.equal(ui!.status, 'WARN');
    assert.equal(ui!.detail, 'port 7071 not checked: lsof failed: lsof: unknown service abc for tcp in: -i TCP:abc');
    const timeout = fakeExec({ ports: { 7071: { code: null, stdout: '', stderr: '', error: 'timeout' } } });
    assert.equal((await D.runChecks(['ports:ui'], deps({ exec: timeout.exec })))[0]!.detail, 'port 7071 not checked: lsof did not answer');
  });

  test('lsof outside PATH (macOS keeps it in /usr/sbin) is still found', async () => {
    clean();
    const fx = fakeExec({ lsofOnlyAt: '/usr/sbin/lsof', ports: { 7071: 'p5\ncnode\n' } });
    const [ui] = await D.runChecks(['ports:ui'], deps({ exec: fx.exec }));
    assert.equal(ui!.detail, 'port 7071 is in use by node (pid 5)');
    assert.deepEqual(fx.calls.map((c) => c.command), ['lsof', '/usr/sbin/lsof']);
  });

  test('--check ports:ui asks lsof about 7071 only', async () => {
    const fx = fakeExec();
    const rs = await D.runChecks(['ports:ui'], deps({ exec: fx.exec }));
    assert.deepEqual(rs.map((r) => r.name), ['ports:ui']);
    assert.equal(fx.calls.length, 1);
  });

  test('pid files and lsof field output', () => {
    const f = join(root, 'pid-file');
    for (const [text, pid] of [['123\n', 123], ['  77 extra\n', 77], ['{"pid": 9}', 9], ['{"pid": "9"}', undefined], ['-1', undefined], ['', undefined], ['{broken', undefined]] as const) {
      writeFileSync(f, text);
      assert.equal(D.readPidFile(f), pid, JSON.stringify(text));
    }
    assert.equal(D.readPidFile(join(root, 'no-pid-file')), undefined);
    // One process with two listening sockets (IPv4 and IPv6) is one listener; the command follows its p line.
    assert.deepEqual(D.parseLsofListeners('p10\ncnode\nf20\nf21\np11\ncnginx\nf3\np10\nf22\n'), [
      { pid: 10, command: 'node' },
      { pid: 11, command: 'nginx' },
    ]);
    assert.deepEqual(D.parseLsofListeners(''), []);
  });
});

describe('service: the bot service file under the owner home', () => {
  test('macOS: the LaunchAgents plist; not installed is informational (OK) until jv bot install-service writes it (M-020)', async () => {
    const plist = join(ownerHome, 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist');
    assert.equal(D.botServiceFile('darwin', ownerHome), plist);
    const [missing] = await D.runChecks(['service'], deps());
    assert.equal(missing!.status, 'OK');
    assert.equal(missing!.detail, `not installed (no ${plist}); jv bot install-service writes it`);
    mkdirSync(join(ownerHome, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, '<plist/>\n');
    try {
      const [installed] = await D.runChecks(['service'], deps());
      assert.equal(installed!.status, 'OK');
      assert.equal(installed!.detail, `installed (${plist})`);
    } finally {
      rmSync(plist);
    }
  });

  test('Linux: the systemd user unit; elsewhere skipped', async () => {
    const unit = join(ownerHome, '.config', 'systemd', 'user', 'jevellan-bot.service');
    assert.equal(D.botServiceFile('linux', ownerHome), unit);
    const [missing] = await D.runChecks(['service'], deps({ platform: 'linux' }));
    assert.equal(missing!.detail, `not installed (no ${unit}); jv bot install-service writes it`);
    mkdirSync(join(ownerHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit, '[Service]\n');
    assert.equal((await D.runChecks(['service'], deps({ platform: 'linux' })))[0]!.status, 'OK');
    const [other] = await D.runChecks(['service'], deps({ platform: 'win32' }));
    assert.equal(other!.status, 'OK');
    assert.match(other!.detail, /skipped$/);
    assert.equal(D.botServiceFile('win32', ownerHome), undefined);
  });
});

describe('member: the Jevellan member daemon, read and left alone', () => {
  const listing = (rows: string[]) => `PID\tStatus\tLabel\n${rows.join('\n')}\n`;

  test('running: the informational line with its pid, from one launchctl list and nothing else', async () => {
    const fx = fakeExec({ launchd: listing(['651\t0\tcom.apple.trustd.agent', '79678\t0\tdev.jevellan.daemon', '821\t0\tdev.jevellan.playground.daemon']) });
    const [line] = await D.runChecks(['member'], deps({ exec: fx.exec }));
    assert.equal(line!.status, 'OK');
    assert.equal(line!.detail, 'Jevellan member running (pid 79678); jv leaves it alone');
    assert.deepEqual(fx.calls, [{ command: 'launchctl', args: ['list'] }]);
  });

  test('absent, only the playground, loaded without a process, or launchctl failing: still OK', async () => {
    const detail = async (launchd: string | ExecResult) => (await D.runChecks(['member'], deps({ exec: fakeExec({ launchd }).exec })))[0]!;
    assert.equal((await detail(listing(['651\t0\tcom.apple.trustd.agent']))).detail, 'no Jevellan member on this machine');
    assert.equal((await detail(listing(['821\t0\tdev.jevellan.playground.daemon']))).detail, 'no Jevellan member on this machine');
    const loaded = await detail(listing(['-\t78\tdev.jevellan.daemon']));
    assert.equal(loaded.detail, 'Jevellan member loaded but not running (dev.jevellan.daemon); jv leaves it alone');
    const failed = await detail({ code: 1, stdout: '', stderr: 'Could not list' });
    assert.equal(failed.status, 'OK');
    assert.equal(failed.detail, 'no Jevellan member detected (launchctl list failed)');
    assert.equal(D.launchdJobPid(listing(['79678\t0\tdev.jevellan.daemon']), 'dev.jevellan.daemon'), 79678);
    assert.equal(D.launchdJobPid(listing(['-\t0\tdev.jevellan.daemon']), 'dev.jevellan.daemon'), null);
    assert.equal(D.launchdJobPid(listing([]), 'dev.jevellan.daemon'), undefined);
  });

  test('Linux: no member, and launchctl is never run', async () => {
    const fx = fakeExec();
    const [line] = await D.runChecks(['member'], deps({ platform: 'linux', exec: fx.exec }));
    assert.equal(line!.detail, 'no Jevellan member on this machine');
    assert.equal(fx.calls.length, 0);
  });
});

describe('the new groups in jv doctor', () => {
  test('they are check names in CHECKS order, and an unknown line of them is refused', async () => {
    for (const n of ['skills', 'memory', 'ports', 'service', 'member']) assert.ok(D.CHECK_NAMES.includes(n), n);
    install();
    const rs = await D.runChecks(['member', 'ports', 'memory', 'service'], deps());
    assert.deepEqual(rs.map((r) => r.name), ['memory', 'ports:ui', 'ports:mcp', 'ports:bot', 'service', 'member']);
    await assert.rejects(D.runChecks(['portz'], deps()), /unknown doctor check: portz/);
  });

  test('defaultDeps: the owner home, this platform and this Node', () => {
    const d = D.defaultDeps();
    assert.equal(d.platform, process.platform);
    assert.equal(d.execPath, process.execPath);
    assert.ok(d.ownerHome.length > 0);
    assert.equal(d.fts5Probe(), undefined);
  });
});
