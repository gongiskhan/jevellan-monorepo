// One bot per JV_HOME (brief section 8): $JV_HOME/run/bot.lock created with O_EXCL holding the pid; a second holder
// refused with exit 2 "bot already running (pid N)"; a stale lock (a pid that is gone, a pid reused by a process that
// is not a bot or that started after the lock was written, a file without a pid left for longer than the grace) taken
// over with the stale pid reported; a holder that cannot be checked kept as held; a release that removes only this
// process's own lock.

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-lock-test-');
process.env.JV_HOME = home;
const L = await import('../src/lock.js');
const { JvError } = await import('jevellan-core/errors');
const { readPidFile } = await import('jevellan-core/doctor');
after(() => rmSync(home, { recursive: true, force: true }));

const file = L.botLockFile();

/** A pid that existed and is gone now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(r.status, 0);
  return r.pid!;
}

test('the lock is $JV_HOME/run/bot.lock, holds this pid (doctor reads it), and a second taker is refused', () => {
  assert.equal(file, join(home, 'run', 'bot.lock'));
  const lock = L.acquireBotLock({ command: 'start' });
  try {
    assert.equal(lock.tookOver, undefined);
    assert.equal(readPidFile(file), process.pid);
    assert.equal(L.readBotLock(file)?.command, 'start');
    assert.throws(
      () => L.acquireBotLock({ command: 'tick' }),
      (e: unknown) => e instanceof JvError && e.exitCode === 2 && e.message === `bot already running (pid ${process.pid})`,
    );
  } finally {
    lock.release();
  }
  assert.equal(existsSync(file), false);
  lock.release(); // idempotent
});

test('a stale lock whose pid is gone is taken over, and the stale pid is reported', () => {
  const stale = deadPid();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ pid: stale, command: 'start', startedAt: '2026-11-01T00:00:00.000Z' })}\n`);
  const seen: Array<number | null> = [];
  const lock = L.acquireBotLock({ command: 'start', onTakeover: (pid) => seen.push(pid) });
  try {
    assert.deepEqual(seen, [stale]);
    assert.equal(lock.tookOver, stale);
    assert.equal(L.readBotLock(file)?.pid, process.pid);
    assert.equal(existsSync(`${file}.takeover`), false);
  } finally {
    lock.release();
  }
});

test('a live pid that is not a bot (a reused pid) counts as stale; a plain "<pid>" file is read too', async () => {
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(L.lockHolderAlive({ pid: other.pid!, command: '', startedAt: '' }), false, 'sleep is not a bot');
    writeFileSync(file, `${other.pid}\n`);
    assert.equal(L.readBotLock(file)?.pid, other.pid);
    const lock = L.acquireBotLock({ command: 'start' });
    assert.equal(lock.tookOver, other.pid);
    lock.release();
  } finally {
    other.kill('SIGKILL');
  }
});

test('a lock file without a pid is being written while young, and stale once older than the grace', () => {
  writeFileSync(file, '');
  const old = new Date(Date.now() - L.UNREADABLE_LOCK_GRACE_MS - 5000);
  utimesSync(file, old, old);
  const lock = L.acquireBotLock({ command: 'tick' });
  assert.equal(lock.tookOver, null);
  lock.release();
});

test('a release removes only this process\'s own lock', () => {
  const lock = L.acquireBotLock({ command: 'start' });
  writeFileSync(file, `${JSON.stringify({ pid: 999999, command: 'start', startedAt: '' })}\n`);
  lock.release();
  assert.equal(existsSync(file), true, 'another holder\'s lock stays');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 999999);
  rmSync(file);
});

/** A process whose command line mentions a bot but that is not jv's (the owner's own bot project). */
async function ownerBot(): Promise<ChildProcess> {
  const dir = join(home, 'owner-telegram-bot');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [join(dir, 'index.mjs')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  return child;
}

test('a bot-named process that started after the lock was written does not hold it (the pid was reused): taken over', async () => {
  const decoy = await ownerBot();
  try {
    const stale = { pid: decoy.pid!, command: 'start', startedAt: new Date(Date.now() - 3_600_000).toISOString() };
    assert.equal(L.lockHolderAlive(stale), false);
    assert.equal(L.checkLockHolder(stale).state, 'stale');
    assert.match(L.checkLockHolder(stale).why, /started after the lock was written/);
    writeFileSync(file, `${JSON.stringify(stale)}\n`);
    const lock = L.acquireBotLock({ command: 'start' });
    assert.equal(lock.tookOver, decoy.pid);
    lock.release();
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('the bot that wrote the lock holds it; one that cannot be checked counts as holding it for a taker, unverified', async () => {
  const bot = await ownerBot();
  try {
    // Written after the process started, as the bot writes its own lock.
    const own = { pid: bot.pid!, command: 'start', startedAt: new Date().toISOString() };
    assert.deepEqual(L.checkLockHolder(own).state, 'holder');
    writeFileSync(file, `${JSON.stringify(own)}\n`);
    assert.throws(() => L.acquireBotLock({ command: 'tick' }), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /bot already running/.test(e.message));

    // No start time in the lock, or none readable for the process: not stale (a taker would start a second bot), not
    // shown either (jv bot stop does not signal it).
    const plain = { pid: bot.pid!, command: '', startedAt: '' };
    assert.equal(L.checkLockHolder(plain).state, 'unverified');
    assert.equal(L.lockHolderAlive(plain), true);
    assert.equal(L.checkLockHolder(own, () => undefined).state, 'unverified');
    // ps gives whole seconds: a holder written within the same second as its start is still the holder.
    const started = L.checkLockHolder({ ...own, startedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() }, () => Math.floor(Date.now() / 1000) * 1000);
    assert.equal(started.state, 'holder');
  } finally {
    rmSync(file, { force: true });
    bot.kill('SIGKILL');
  }
});
