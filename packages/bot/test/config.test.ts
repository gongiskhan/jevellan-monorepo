// bot.json (brief section 8): the defaults written at the first start, strict validation (an unknown key at any
// depth exits 2 naming it; wrong types and values name the key), a partial file filled with the defaults, and the
// quiet-hours window in local time, also across midnight.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-config-test-');
process.env.JV_HOME = home;
const C = await import('../src/config.js');
const { JvError } = await import('jevellan-core/errors');
after(() => rmSync(home, { recursive: true, force: true }));

const file = join(home, 'bot.json');
const refusedWith = (fn: () => unknown, why: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof JvError && e.exitCode === 2 && why.test(e.message), String(why));

describe('loading', () => {
  test('a missing file is written with the defaults of section 8 at the first start (mode 600), and read back', () => {
    rmSync(file, { force: true });
    const read = C.loadBotConfig(file);
    assert.equal(read.written, false, 'reading alone writes nothing');
    const first = C.loadBotConfig(file, { writeDefaults: true });
    assert.equal(first.written, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      tickSeconds: 15,
      limits: { perProject: 2, total: 4 },
      quietHours: null,
      health: { bind: '127.0.0.1', port: 7073 },
      logLines: 20000,
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(C.loadBotConfig(file, { writeDefaults: true }).written, false);
    assert.deepEqual(first.config, C.defaultBotConfig());
  });

  test('a partial file takes the defaults for what it leaves out', () => {
    writeFileSync(file, JSON.stringify({ limits: { perProject: 1 }, quietHours: { from: '23:00', to: '07:00' } }));
    const c = C.loadBotConfig(file).config;
    assert.deepEqual(c.limits, { perProject: 1, total: 4 });
    assert.deepEqual(c.quietHours, { from: '23:00', to: '07:00' });
    assert.equal(c.tickSeconds, 15);
    assert.equal(c.health.port, 7073);
  });

  test('unknown keys are refused by name, at any depth', () => {
    writeFileSync(file, JSON.stringify({ tickSeconds: 15, tickSecs: 5 }));
    refusedWith(() => C.loadBotConfig(file), /bot\.json: unknown key "tickSecs"/);
    writeFileSync(file, JSON.stringify({ limits: { perProject: 2, perproject: 3 } }));
    refusedWith(() => C.loadBotConfig(file), /unknown key "limits\.perproject"/);
    writeFileSync(file, JSON.stringify({ health: { bind: '127.0.0.1', host: 'x' } }));
    refusedWith(() => C.loadBotConfig(file), /unknown key "health\.host"/);
    writeFileSync(file, JSON.stringify({ quietHours: { from: '23:00', to: '07:00', tz: 'UTC' } }));
    refusedWith(() => C.loadBotConfig(file), /unknown key "quietHours\.tz"/);
  });

  test('wrong types and values are refused naming the key', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ tickSeconds: '15' }, /"tickSeconds" expected number/],
      [{ tickSeconds: 0 }, /"tickSeconds"/],
      [{ tickSeconds: 1.5 }, /"tickSeconds" expected int/],
      [{ limits: { total: 0 } }, /"limits\.total"/],
      [{ quietHours: { from: '23', to: '07:00' } }, /"quietHours\.from" must be a local time HH:MM/],
      [{ quietHours: { from: '24:00', to: '07:00' } }, /"quietHours\.from"/],
      [{ quietHours: { from: '07:00', to: '07:00' } }, /"quietHours\.to" from and to are the same time/],
      [{ quietHours: '23:00-07:00' }, /"quietHours"/],
      [{ health: { bind: '0.0.0.0' } }, /"health\.bind" must be one address, not a wildcard/],
      [{ health: { bind: 'example.test' } }, /"health\.bind" must be an IP address or localhost/],
      [{ health: { port: 70000 } }, /"health\.port"/],
      [{ logLines: 10 }, /"logLines"/],
      [[], /must be a JSON object/],
    ];
    for (const [raw, why] of cases) {
      writeFileSync(file, JSON.stringify(raw));
      refusedWith(() => C.loadBotConfig(file), why);
    }
    writeFileSync(file, '{ "tickSeconds": 15,');
    refusedWith(() => C.loadBotConfig(file), /is not valid JSON/);
  });

  test('readBotConfigOrDefaults never throws: the defaults and the problem', () => {
    writeFileSync(file, JSON.stringify({ nope: 1 }));
    const r = C.readBotConfigOrDefaults(file);
    assert.deepEqual(r.config, C.defaultBotConfig());
    assert.match(r.error ?? '', /unknown key "nope"/);
    rmSync(file);
    assert.equal(C.readBotConfigOrDefaults(file).error, undefined);
  });
});

describe('quiet hours', () => {
  const at = (hh: number, mm: number) => new Date(2026, 10, 2, hh, mm, 0);
  test('null means none', () => {
    assert.equal(C.inQuietHours(at(3, 0), null), false);
    assert.equal(C.quietText(null), 'none');
  });
  test('a window across midnight: from is in, to is out', () => {
    const q = { from: '23:00', to: '07:00' };
    assert.equal(C.inQuietHours(at(22, 59), q), false);
    assert.equal(C.inQuietHours(at(23, 0), q), true);
    assert.equal(C.inQuietHours(at(0, 0), q), true);
    assert.equal(C.inQuietHours(at(6, 59), q), true);
    assert.equal(C.inQuietHours(at(7, 0), q), false);
    assert.equal(C.inQuietHours(at(12, 0), q), false);
    assert.equal(C.quietText(q), '23:00-07:00');
  });
  test('a window within a day', () => {
    const q = { from: '12:30', to: '14:00' };
    assert.equal(C.inQuietHours(at(12, 29), q), false);
    assert.equal(C.inQuietHours(at(12, 30), q), true);
    assert.equal(C.inQuietHours(at(13, 59), q), true);
    assert.equal(C.inQuietHours(at(14, 0), q), false);
  });
});
