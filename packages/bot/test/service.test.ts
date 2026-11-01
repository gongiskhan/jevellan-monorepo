// The bot's service files (brief section 8, M14): the launchd plist under the given owner home with the label,
// program, environment, RunAtLoad, KeepAlive and the log paths (plutil -lint and plutil -convert when this machine has
// plutil); the systemd user unit with Restart=always and RestartSec=5; PATH from the tools' folders; an unchanged file
// left alone; a different one archived under $JV_HOME/archive/service/ before the new one is written; the printed load
// and unload commands; other platforms refused. Nothing is loaded.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { makeHome } from './fixtures/home.js';

const home = makeHome('jv-bot-service-test-');
process.env.JV_HOME = home;
const V = await import('../src/service.js');
const { JvError } = await import('jevellan-core/errors');
after(() => rmSync(home, { recursive: true, force: true }));

const owner = join(home, 'owner & co');
const bin = join(home, 'tools', 'bin');
const brew = join(home, 'tools', 'brew');
for (const [dir, names] of [[bin, ['claude']], [brew, ['git', 'tmux']]] as const) {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    writeFileSync(join(dir, n), '#!/bin/sh\n');
    chmodSync(join(dir, n), 0o755);
  }
}
const node = join(home, 'node', 'v22.22.0', 'bin', 'node');
const entry = join(home, 'checkout', 'packages', 'cli', 'dist', 'bin.js');
mkdirSync(join(home, 'checkout', 'packages', 'cli', 'dist'), { recursive: true });
writeFileSync(entry, '// jv\n');
const options = { ownerHome: owner, nodePath: node, cliEntry: entry, searchPath: `${brew}:${bin}:/nonexistent` };
const plutil = existsSync('/usr/bin/plutil') ? '/usr/bin/plutil' : undefined;

describe('macOS', () => {
  const file = join(owner, 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist');

  test('the plist: label, program, environment, keep-alive, logs; plutil -lint passes', () => {
    const r = V.installService('darwin', options);
    assert.equal(r.file, file);
    assert.equal(r.label, 'dev.jevellan.bot');
    assert.equal(r.written, true);
    assert.deepEqual(r.programArguments, [node, '--disable-warning=ExperimentalWarning', entry, 'bot', 'start']);
    assert.equal(r.environment.PATH, [join(home, 'node', 'v22.22.0', 'bin'), brew, bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'));
    assert.equal(r.environment.HOME, owner);
    assert.equal(r.environment.JV_HOME, home);
    assert.equal(r.log, join(home, 'logs', 'bot.launchd.log'));
    assert.equal(r.tools.codex, null);
    assert.ok(r.warnings.some((w) => /^codex was not found on PATH/.test(w)));
    assert.deepEqual(r.load, [`launchctl bootstrap gui/$(id -u) ${file}`]);
    assert.deepEqual(r.unload, ['launchctl bootout gui/$(id -u)/dev.jevellan.bot']);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
    assert.match(text, /<key>KeepAlive<\/key>\n {2}<true\/>/);
    assert.match(text, /owner &amp; co/, 'XML special characters are escaped');
    assert.ok(existsSync(join(home, 'logs')), 'the log folder exists before launchd opens the log');
    if (plutil) {
      const lint = spawnSync(plutil, ['-lint', file], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
      const json = spawnSync(plutil, ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
      assert.equal(json.status, 0, json.stderr);
      const parsed = JSON.parse(json.stdout) as Record<string, any>;
      assert.equal(parsed.Label, 'dev.jevellan.bot');
      assert.deepEqual(parsed.ProgramArguments, r.programArguments);
      assert.deepEqual(parsed.EnvironmentVariables, r.environment);
      assert.equal(parsed.RunAtLoad, true);
      assert.equal(parsed.KeepAlive, true);
      assert.equal(parsed.StandardOutPath, r.log);
      assert.equal(parsed.StandardErrorPath, r.log);
    }
    assert.match(V.formatInstallService(r), /jv does not load it\. To start the bot as a service:\n {2}launchctl bootstrap gui\/\$\(id -u\) /);
  });

  test('the same content is left alone; a different file is archived first, never overwritten silently', () => {
    const again = V.installService('darwin', options);
    assert.equal(again.written, false);
    assert.equal(again.archived, undefined);
    assert.match(V.formatInstallService(again), /is up to date \(unchanged\)/);
    writeFileSync(file, '<plist>an older one</plist>\n');
    const replaced = V.installService('darwin', { ...options, now: new Date('2026-11-02T03:04:05.000Z') });
    assert.equal(replaced.written, true);
    assert.equal(replaced.archived, join(home, 'archive', 'service', 'dev.jevellan.bot-20261102T030405Z.plist'));
    assert.equal(readFileSync(replaced.archived!, 'utf8'), '<plist>an older one</plist>\n');
    assert.match(readFileSync(file, 'utf8'), /<string>dev\.jevellan\.bot<\/string>/);
    assert.deepEqual(readdirSync(join(home, 'archive', 'service')), ['dev.jevellan.bot-20261102T030405Z.plist']);
  });

  test('serviceState names the file and whether it exists', () => {
    assert.deepEqual(V.serviceState('darwin', owner), { file, installed: true });
    assert.deepEqual(V.serviceState('darwin', join(home, 'nobody')), { file: join(home, 'nobody', 'Library', 'LaunchAgents', 'dev.jevellan.bot.plist'), installed: false });
    assert.deepEqual(V.serviceState('win32', owner), { file: null, installed: false });
  });
});

describe('Linux', () => {
  test('the systemd user unit: the command, the environment, Restart=always, RestartSec=5', () => {
    const r = V.installService('linux', options);
    const file = join(owner, '.config', 'systemd', 'user', 'jevellan-bot.service');
    assert.equal(r.file, file);
    assert.equal(r.label, 'jevellan-bot');
    assert.equal(r.log, null);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^ExecStart=".*\/node" "--disable-warning=ExperimentalWarning" ".*\/bin\.js" "bot" "start"$/m);
    assert.match(text, /^Environment="PATH=.*:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m);
    assert.ok(text.includes(`Environment="HOME=${owner}"`));
    assert.ok(text.includes(`Environment="JV_HOME=${home}"`));
    assert.match(text, /^Restart=always$/m);
    assert.match(text, /^RestartSec=5$/m);
    assert.match(text, /^WantedBy=default\.target$/m);
    assert.deepEqual(r.load, ['systemctl --user daemon-reload', 'systemctl --user enable --now jevellan-bot']);
    assert.deepEqual(r.unload, ['systemctl --user disable --now jevellan-bot']);
  });

  test('systemd words are quoted: quotes and backslashes escaped, % and $ doubled', () => {
    assert.equal(V.systemdQuote('a "b" \\c 50% $HOME'), '"a \\"b\\" \\\\c 50%% $$HOME"');
  });
});

test('another platform is refused (exit 2)', () => {
  assert.throws(() => V.installService('win32', options), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /macOS and Linux only, not win32/.test(e.message));
});
