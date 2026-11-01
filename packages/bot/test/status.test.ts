// jv bot status from the store (brief section 8): the {bot, config, service} view works when the bot is not running
// ("bot not running; last heartbeat 2 h ago"), reads alive for a live pid with a fresh heartbeat, shows the defaults
// and names the problem of an invalid bot.json, and shows the last error a tick recorded. And the hourly provider
// probe of housekeeping: only the providers whose last probe was ready, no model lists, no Jev, providers.json
// untouched (jevellan-core's probeProviders through the bot's default).

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-status-test-');
process.env.JV_HOME = home;
const St = await import('../src/status.js');
const { defaultBotConfig } = await import('../src/config.js');
const { BOT_TICK_META } = await import('../src/tick.js');
const { openStore } = await import('jevellan-core/store');
const { writeBotHeartbeat } = await import('jevellan-core/bot-state');
const { recordProviderAuth, loadProviderAuthRecords } = await import('jevellan-core/providers');
const PC = await import('jevellan-core/providers-check');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});
const owner = join(home, 'owner');
const opts = { platform: 'darwin' as const, ownerHome: owner };

describe('the view and its text', () => {
  test('never run: not running, no heartbeat, the defaults, no service', () => {
    const v = St.botStatusView(store, opts);
    assert.deepEqual(Object.keys(v), ['bot', 'config', 'service']);
    assert.equal(v.bot.alive, false);
    assert.equal(v.bot.heartbeatAt, null);
    assert.deepEqual(v.config, defaultBotConfig());
    assert.deepEqual(v.service, { file: join(owner, 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist'), installed: false });
    const text = St.formatBotStatus(v);
    assert.equal(text.split('\n')[0], 'bot not running; no heartbeat yet');
    assert.match(text, /service: not installed; jv bot install-service writes it/);
  });

  test('a dead bot two hours ago: "bot not running; last heartbeat 2 h ago"', () => {
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    writeBotHeartbeat(store, { pid: 999_999, startedAt: at, tick: 40, at });
    const v = St.botStatusView(store, opts);
    assert.equal(v.bot.alive, false);
    assert.equal(St.formatBotStatus(v).split('\n')[0], 'bot not running; last heartbeat 2 h ago');
  });

  test('a live pid with a fresh heartbeat is running; the last error shows', () => {
    const now = Date.now();
    writeBotHeartbeat(store, { pid: process.pid, startedAt: new Date(now - 14 * 60_000).toISOString(), tick: 57, at: new Date(now - 4000).toISOString() });
    store.setMeta(BOT_TICK_META.lastError, JSON.stringify({ at: new Date(now).toISOString(), step: 'jobs:J0000AA', message: 'no duty skill' }));
    const v = St.botStatusView(store, opts);
    assert.equal(v.bot.alive, true);
    assert.equal(v.bot.tick, 57);
    const text = St.formatBotStatus(v, { lastError: St.lastBotError(store)!, now });
    assert.equal(text.split('\n')[0], `bot running (pid ${process.pid}), last heartbeat 4 s ago, tick 57, up 14 min`);
    assert.match(text, /^last error \d\d:\d\d in jobs:J0000AA: no duty skill$/m);
    for (const line of text.split('\n')) assert.ok(line.length <= 100 || line.startsWith('service: '), line);
  });

  test('an invalid bot.json: the defaults in the view, the problem in the text', () => {
    writeFileSync(join(home, 'bot.json'), JSON.stringify({ tickSeconds: 5, extra: 1 }));
    const v = St.botStatusView(store, opts);
    assert.deepEqual(v.config, defaultBotConfig());
    writeFileSync(join(home, 'bot.json'), JSON.stringify({ tickSeconds: 5, quietHours: { from: '23:00', to: '07:00' } }));
    const w = St.botStatusView(store, opts);
    assert.equal(w.config.tickSeconds, 5);
    assert.match(St.formatBotStatus(w), /tick every 5 s, quiet hours 23:00-07:00/);
    rmSync(join(home, 'bot.json'));
  });
});

describe('the hourly provider probe', () => {
  test('probes only the ready providers, records what jv providers check records, asks no model list, no Jev, writes nothing else', async () => {
    const providersFile = join(home, 'providers.json');
    const before = readFileSync(providersFile, 'utf8');
    recordProviderAuth(store, 'glm', { auth: 'ready', observedAt: new Date(Date.now() - 3600_000).toISOString() });
    recordProviderAuth(store, 'claude-main', { auth: 'needs-login', observedAt: new Date().toISOString() });
    assert.deepEqual(PC.readyProviders(store), ['glm']);
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: 'msg', content: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const checks = await PC.probeProviders(store, { only: PC.readyProviders(store) }, { fetch: fakeFetch, claudeModels: async () => assert.fail('no model list'), codexModels: async () => assert.fail('no model list') });
    assert.deepEqual(checks.map((c) => [c.name, c.auth]), [['glm', 'ready']]);
    assert.equal(checks[0]!.models, undefined);
    assert.ok(urls.length === 1 && urls[0]!.startsWith('https://endpoint.example.test/api/anthropic'), urls.join(', '));
    assert.equal(loadProviderAuthRecords(store).glm?.auth, 'ready');
    assert.ok(Date.now() - Date.parse(loadProviderAuthRecords(store).glm!.observedAt) < 60_000, 'the probe time is recorded');
    assert.equal(loadProviderAuthRecords(store)['claude-main']?.auth, 'needs-login', 'a provider that was not ready is not probed');
    assert.equal(readFileSync(providersFile, 'utf8'), before, 'providers.json is not written');
  });
});
