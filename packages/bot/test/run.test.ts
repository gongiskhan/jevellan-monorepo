// The bot's process (brief section 8): runBot writes bot.json's defaults at the first start, takes the lock, writes a
// first heartbeat before the health endpoint answers, ticks every tickSeconds and stops on its signal, releasing the
// lock; a second start is refused while it runs (so is jv bot tick's tickOnce); an invalid bot.json refuses before
// any lock is taken; bot.json edits apply from the next tick. In a child process: SIGTERM ends the bot with exit 0
// within 10 s, also when a sub-step hangs (the stop deadline), and the lock is gone afterwards.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-run-test-');
process.env.JV_HOME = home;
const R = await import('../src/run.js');
const { botLockFile, readBotLock } = await import('../src/lock.js');
const { openBotLog } = await import('../src/log.js');
const { openStore } = await import('jevellan-core/store');
const { BOT_META } = await import('jevellan-core/bot-state');
const { JvError } = await import('jevellan-core/errors');
type TickDeps = import('../src/tick.js').TickDeps;
after(() => rmSync(home, { recursive: true, force: true }));

const configFile = join(home, 'bot.json');
const log = openBotLog(join(home, 'logs', 'bot.log'));
const quietDeps: Partial<TickDeps> = {
  reconcile: async () => ({ lost: [], resumed: [], recovered: [], admitted: [], refused: [], delivered: [], woke: 0, errors: [] }),
  tailCoordinator: () => ({ projects: [] }),
  due: () => [],
  stepJobs: async () => ({ started: [], finished: [], errors: [] }),
  probeProviders: async () => [],
  gc: async () => [],
};
const refusedWith = (why: RegExp) => (e: unknown) => e instanceof JvError && e.exitCode === 2 && why.test(e.message);

test('the first start writes bot.json, takes the lock, answers health with a heartbeat, ticks and releases the lock', async () => {
  rmSync(configFile, { force: true });
  const order: string[] = [];
  let healthAtStart: unknown;
  const result = await R.runBot({
    handleSignals: false,
    healthPort: 0,
    maxTicks: 2,
    log,
    deps: quietDeps,
    onStarted: async (info) => {
      order.push('started');
      assert.equal(info.configWritten, true);
      assert.equal(info.pid, process.pid);
      assert.equal(readBotLock(botLockFile())?.pid, process.pid);
      healthAtStart = info.health.url;
    },
    onTick: (s) => order.push(`tick ${s.tick}`),
  });
  assert.deepEqual(order, ['started', 'tick 1', 'tick 2']);
  assert.equal(result.ticks, 2);
  assert.equal(result.reason, 'max ticks');
  assert.equal(existsSync(configFile), true);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).tickSeconds, 15);
  assert.equal(existsSync(botLockFile()), false, 'the lock is released');
  assert.match(String(healthAtStart), /^http:\/\/127\.0\.0\.1:\d+\/health$/);
  const store = openStore();
  try {
    assert.equal(store.getMeta(BOT_META.tick), '2');
    assert.equal(store.getMeta(BOT_META.pid), '', 'the pid is cleared when the bot ends; the heartbeat stays');
    assert.ok(store.getMeta(BOT_META.heartbeat));
  } finally {
    store.close();
  }
  const text = readFileSync(log.file, 'utf8');
  assert.match(text, /started \(pid \d+\): tick every 15 s, limits 2 per project and 4 in total, quiet hours none, health http/);
  assert.match(text, /stopped \(max ticks\) after 2 ticks/);
});

test('the health endpoint answers from the first heartbeat on; a second start and a tick are refused while it runs', async () => {
  writeFileSync(configFile, JSON.stringify({ tickSeconds: 1 }));
  const stop = new AbortController();
  let url = '';
  const running = R.runBot({
    handleSignals: false,
    healthPort: 0,
    signal: stop.signal,
    log,
    deps: quietDeps,
    onStarted: (info) => {
      url = info.health.url;
    },
  });
  while (!url) await new Promise((r) => setTimeout(r, 10));
  const body = (await (await fetch(url)).json()) as { ok: boolean; heartbeatAgeSeconds: number };
  assert.equal(body.ok, true);
  assert.equal(typeof body.heartbeatAgeSeconds, 'number');
  await assert.rejects(R.runBot({ handleSignals: false, healthPort: 0, log, deps: quietDeps }), refusedWith(new RegExp(`^bot already running \\(pid ${process.pid}\\)$`)));
  await assert.rejects(R.tickOnce({ log, deps: quietDeps }), refusedWith(/^bot already running/));
  // An edit of bot.json applies from the next tick; an invalid one is logged and the running configuration kept.
  await new Promise((r) => setTimeout(r, 1200));
  writeFileSync(configFile, JSON.stringify({ tickSeconds: 1, limits: { perProject: 1, total: 3 } }));
  await new Promise((r) => setTimeout(r, 1500));
  writeFileSync(configFile, JSON.stringify({ tickSeconds: 1, bogus: true }));
  await new Promise((r) => setTimeout(r, 1500));
  stop.abort();
  const result = await running;
  assert.equal(result.reason, 'stopped');
  assert.ok(result.ticks >= 3, `ticks ${result.ticks}`);
  const text = readFileSync(log.file, 'utf8');
  assert.match(text, /bot\.json changed: tick every 1 s, limits 1 and 3/);
  assert.match(text, /error in config: .*unknown key "bogus"; keeping the configuration/);
  assert.equal(existsSync(botLockFile()), false);
});

test('an invalid bot.json refuses before the lock is taken; tickOnce writes the defaults of a missing file', async () => {
  writeFileSync(configFile, JSON.stringify({ limits: { perProject: 2, extra: 1 } }));
  await assert.rejects(R.runBot({ handleSignals: false, healthPort: 0, log, deps: quietDeps }), refusedWith(/unknown key "limits\.extra"/));
  assert.equal(existsSync(botLockFile()), false);
  rmSync(configFile);
  const s = await R.tickOnce({ log, deps: quietDeps });
  assert.equal(s.tick, 1);
  assert.equal(existsSync(configFile), true);
  assert.equal(existsSync(botLockFile()), false);
});

test('a start over a stale lock takes it over with a log line', async () => {
  const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(botLockFile(), `${JSON.stringify({ pid: gone, command: 'start', startedAt: '2026-11-01T00:00:00.000Z' })}\n`);
  let tookOver: number | null | undefined;
  await R.runBot({ handleSignals: false, healthPort: 0, maxTicks: 1, log, deps: quietDeps, onStarted: (info) => (tookOver = info.tookOver) });
  assert.equal(tookOver, gone);
  assert.match(readFileSync(log.file, 'utf8'), new RegExp(`took over the bot lock of pid ${gone}, which is not running`));
  assert.equal(existsSync(botLockFile()), false);
});

const driver =fileURLToPath(new URL('./fixtures/bot-driver.js', import.meta.url));

/** Starts the driver; resolves with the child once it printed its start line. */
function startDriver(env: Record<string, string> = {}): Promise<{ child: ReturnType<typeof spawn>; out: () => string; exit: Promise<{ code: number | null; signal: string | null }> }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', driver], { env: { ...process.env, JV_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.on('data', (c) => (out += String(c)));
  child.stderr!.on('data', (c) => (err += String(c)));
  const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (/started \d+ http/.test(out) && /tick 1/.test(out)) {
        clearInterval(poll);
        resolve({ child, out: () => out, exit });
      } else if (child.exitCode !== null || Date.now() - t0 > 20_000) {
        clearInterval(poll);
        reject(new Error(`the driver did not start: ${out} ${err}`));
      }
    }, 20);
  });
}

test('SIGTERM in a child process: exit 0 within 10 s, the lock released', { timeout: 30_000 }, async () => {
  writeFileSync(configFile, JSON.stringify({ tickSeconds: 1 }));
  const bot = await startDriver();
  assert.equal(readBotLock(botLockFile())?.pid, bot.child.pid);
  const t0 = Date.now();
  bot.child.kill('SIGTERM');
  const end = await bot.exit;
  const ms = Date.now() - t0;
  assert.deepEqual(end, { code: 0, signal: null }, bot.out());
  assert.ok(ms < 10_000, `${ms} ms`);
  assert.match(bot.out(), /stopped SIGTERM \d+/);
  assert.equal(existsSync(botLockFile()), false);
});

test('SIGTERM while a sub-step hangs: the deadline releases the lock and exits 0 in time', { timeout: 30_000 }, async () => {
  assert.ok(R.STOP_DEADLINE_MS < 10_000);
  writeFileSync(configFile, JSON.stringify({ tickSeconds: 1 }));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', driver], {
    env: { ...process.env, JV_HOME: home, BOT_DRIVER_HANG: '1', BOT_DRIVER_DEADLINE_MS: '1500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += String(c)));
  const exit = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const t0 = Date.now();
  while (!/started \d+/.test(out)) {
    assert.ok(Date.now() - t0 < 20_000, 'the driver did not start');
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 200));
  const t1 = Date.now();
  child.kill('SIGTERM');
  const end = await exit;
  const ms = Date.now() - t1;
  assert.deepEqual(end, { code: 0, signal: null });
  assert.ok(ms >= 1400 && ms < 10_000, `${ms} ms`);
  assert.doesNotMatch(out, /stopped SIGTERM/, 'runBot never returned: the deadline exited');
  assert.equal(existsSync(botLockFile()), false);
  assert.match(readFileSync(join(home, 'logs', 'bot.log'), 'utf8'), /the current sub-step did not finish within 2 s/);
});
