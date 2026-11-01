// One bot per JV_HOME (brief section 8): $JV_HOME/run/bot.lock created with O_EXCL holding the pid; a second holder
// refused with exit 2 "bot already running (pid N)"; a stale lock (a pid that is gone, a pid reused by a process that
// is not a bot, a file without a pid left for longer than the grace) taken over with the stale pid reported; a release
// that removes only this process's own lock.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    assert.equal(L.lockHolderAlive(other.pid!), false, 'sleep is not a bot');
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
