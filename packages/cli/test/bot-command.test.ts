// jv bot start|stop|status|tick|install-service (brief sections 4 and 8) through the command line, on a temporary
// JV_HOME: status before any bot ({bot, config, service}, "bot not running"), one tick (its summary, bot.json written,
// the heartbeat left behind), install-service into a temporary owner home (plutil -lint on macOS), stop with no bot,
// and the real `jv bot start` in a child process: alive in jv bot status, a second start and a tick refused with
// exit 2, jv bot stop ending it with exit 0 and the lock gone. No provider is ready in this home, so nothing reaches
// a provider, Jev or the network.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-bot-command-test-');
process.env.JV_HOME = home;
const { main, COMMANDS } = await import('../src/cli.js');
after(() => rmSync(home, { recursive: true, force: true }));

/** Runs jv with its stdout and stderr captured (strings only; the test runner's own writes go through). */
async function jv(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: process.stdout.write, err: process.stderr.write };
  const capture = (into: string[], stream: NodeJS.WriteStream, original: typeof process.stdout.write) =>
    ((chunk: unknown, ...rest: unknown[]) =>
      typeof chunk === 'string' ? (into.push(chunk), true) : (original as (...a: unknown[]) => boolean).call(stream, chunk, ...rest)) as typeof process.stdout.write;
  process.stdout.write = capture(out, process.stdout, write.out);
  process.stderr.write = capture(err, process.stderr, write.err);
  try {
    return { code: await main(argv), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('jv bot is in the command table and jv --help', () => {
  assert.equal(COMMANDS.bot!.module, './commands/bot.js');
  assert.equal(COMMANDS.bot!.usage, 'jv bot start|stop|status|tick|install-service');
  assert.doesNotMatch(COMMANDS.bot!.usage, /owner-home/, '--owner-home is internal');
});

test('jv bot status before any bot: the contract keys, "bot not running; no heartbeat yet"', async () => {
  const r = await jv('bot', 'status', '--json');
  assert.equal(r.code, 0, r.err);
  const v = JSON.parse(r.out) as { bot: { alive: boolean; heartbeatAt: string | null }; config: { tickSeconds: number }; service: { file: string | null; installed: boolean } };
  assert.deepEqual(Object.keys(v), ['bot', 'config', 'service']);
  assert.equal(v.bot.alive, false);
  assert.equal(v.config.tickSeconds, 15);
  assert.equal(typeof v.service.installed, 'boolean');
  const text = await jv('bot', 'status');
  assert.equal(text.out.split('\n')[0], 'bot not running; no heartbeat yet');
  assert.equal(existsSync(join(home, 'bot.json')), false, 'status writes nothing');
});

test('jv bot tick: one tick, its summary, bot.json written, the heartbeat left behind, the lock released', async () => {
  const r = await jv('bot', 'tick', '--json');
  assert.equal(r.code, 0, r.err);
  const s = JSON.parse(r.out) as { tick: number; steps: Array<{ step: string; ok: boolean }>; errors: unknown[]; housekeeping: unknown };
  assert.equal(s.tick, 1);
  assert.deepEqual(s.steps.map((x) => x.step), ['heartbeat', 'reconcile', 'coordinator', 'schedules', 'jobs', 'housekeeping']);
  assert.ok(s.steps.every((x) => x.ok), JSON.stringify(s.steps));
  assert.deepEqual(s.errors, []);
  assert.ok(s.housekeeping, 'the first tick of a home does the housekeeping');
  assert.equal(JSON.parse(readFileSync(join(home, 'bot.json'), 'utf8')).logLines, 20000);
  assert.equal(existsSync(join(home, 'run', 'bot.lock')), false);
  const text = await jv('bot', 'tick');
  assert.match(text.out, /^tick 1 at \d\d:\d\d \(pid \d+\)\n {2}heartbeat {4}ok/);
  assert.match(text.out, /housekeeping skipped \(not due\)/);
  for (const line of text.out.trim().split('\n')) assert.ok(line.length <= 100, line);
  const status = await jv('bot', 'status');
  assert.match(status.out.split('\n')[0]!, /^bot not running; last heartbeat \d+ s ago$/);
});

test('jv bot install-service writes the service file under the given owner home and loads nothing', async () => {
  const owner = join(home, 'owner');
  const r = await jv('bot', 'install-service', '--owner-home', owner, '--json');
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    assert.equal(r.code, 2);
    return;
  }
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out) as { file: string; written: boolean; programArguments: string[]; load: string[]; environment: Record<string, string> };
  assert.equal(out.written, true);
  assert.ok(out.file.startsWith(owner));
  assert.ok(existsSync(out.file));
  assert.deepEqual(out.programArguments.slice(1), ['--disable-warning=ExperimentalWarning', out.programArguments[2], 'bot', 'start']);
  assert.match(out.programArguments[2]!, /packages\/cli\/dist\/bin\.js$/);
  assert.equal(out.environment.JV_HOME, home);
  assert.equal(out.environment.HOME, owner);
  if (process.platform === 'darwin') {
    assert.equal(out.file, join(owner, 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist'));
    assert.match(out.load[0]!, /^launchctl bootstrap gui\/\$\(id -u\) /);
    if (existsSync('/usr/bin/plutil')) {
      const lint = spawnSync('/usr/bin/plutil', ['-lint', out.file], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    }
  }
  const again = await jv('bot', 'install-service', '--owner-home', owner);
  assert.equal(again.code, 0);
  assert.match(again.out, /is up to date \(unchanged\)/);
  assert.match(again.out, /jv does not load it/);
});

test('jv bot stop with no bot: "bot not running", exit 0; an unknown subcommand: exit 2', async () => {
  const r = await jv('bot', 'stop', '--json');
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { stopped: false, pid: null, reason: 'bot not running' });
  assert.equal((await jv('bot', 'nap')).code, 2);
});

test('jv bot start in a child: alive, a second start and a tick refused, jv bot stop ends it with exit 0', { timeout: 60_000 }, async () => {
  writeFileSync(join(home, 'bot.json'), JSON.stringify({ tickSeconds: 1, health: { bind: '127.0.0.1', port: await freePort() } }));
  const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bin, 'bot', 'start'], { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 20_000;
    while (!/health http/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, new RegExp(`^jv bot started \\(pid ${child.pid}\\), tick every 1 s; Ctrl-C or jv bot stop stops it\\nhealth http://127\\.0\\.0\\.1:\\d+/health\\n`), out + err);
    const url = /health (http\S+)/.exec(out)![1]!;
    await new Promise((r) => setTimeout(r, 1500));
    const health = (await (await fetch(url)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(health), ['ok', 'heartbeatAgeSeconds', 'running', 'queued', 'version']);
    assert.equal(health.ok, true);

    const status = JSON.parse((await jv('bot', 'status', '--json')).out) as { bot: { alive: boolean; pid: number; tick: number } };
    assert.equal(status.bot.alive, true);
    assert.equal(status.bot.pid, child.pid);
    assert.ok(status.bot.tick >= 1);
    const second = await jv('bot', 'start');
    assert.equal(second.code, 2);
    assert.match(second.err, new RegExp(`bot already running \\(pid ${child.pid}\\)`));
    const tick = await jv('bot', 'tick', '--json');
    assert.equal(tick.code, 2);
    assert.deepEqual(JSON.parse(tick.out), { error: `bot already running (pid ${child.pid})`, exitCode: 2 });

    const stop = await jv('bot', 'stop', '--json');
    assert.equal(stop.code, 0, stop.err);
    const stopped = JSON.parse(stop.out) as { stopped: boolean; pid: number; waitedMs: number };
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.pid, child.pid);
    assert.ok(stopped.waitedMs < 10_000);
    assert.equal(await exited, 0);
    assert.equal(existsSync(join(home, 'run', 'bot.lock')), false);
    assert.match(err, /jv bot stopped \(SIGTERM\) after \d+ ticks?/);
    assert.match((await jv('bot', 'status')).out.split('\n')[0]!, /^bot not running; last heartbeat \d+ s ago$/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
