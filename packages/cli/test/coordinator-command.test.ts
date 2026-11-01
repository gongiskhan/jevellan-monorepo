// jv coordinator message through the CLI, against a temporary JV_HOME: the usage line, the text taken from the words
// after the subcommand, and the refusals (no text, no running coordinator, an unknown subcommand) with their exit codes
// in text and --json. No coordinator runs here, so tmux is never asked (core's coordinator-chat tests type into a fake
// tmux).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-coordinator-command-test-'));
process.env.JV_HOME = home;
const { COMMANDS } = await import('../src/cli.js');
const { openStore } = await import('jevellan-core/store');

after(() => rmSync(home, { recursive: true, force: true }));

const repo = join(home, 'repos', 'chat');
mkdirSync(repo, { recursive: true });
const store = openStore();
store.createProject({ name: 'chat', path: repo, default_branch: 'main' });
store.close();

const cliUrl = new URL('../src/cli.js', import.meta.url).href;

function jv(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(${JSON.stringify(argv)});`,
    ],
    { env: { ...process.env, JV_HOME: home }, encoding: 'utf8' },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('the usage line names the message subcommand next to start, stop, restart and status', () => {
  assert.equal(
    COMMANDS.coordinator!.usage,
    'jv coordinator start|stop|restart|status --project N | jv coordinator message --project N "text"',
  );
  const help = jv('coordinator', '--help');
  assert.equal(help.code, 0);
  assert.equal(help.stdout.trim(), COMMANDS.coordinator!.usage);
});

test('message refuses (exit 2) without text and when the coordinator is not running, in text and --json', () => {
  const empty = jv('coordinator', 'message', '--project', 'chat');
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /the message text is required/);

  const text = jv('coordinator', 'message', '--project', 'chat', 'what', 'is', 'running?');
  assert.equal(text.code, 2);
  assert.match(text.stderr, /^jv: the coordinator of chat is not running; start it with jv coordinator start --project chat\n$/);

  const json = jv('coordinator', 'message', '--project', 'chat', 'status', '--json');
  assert.equal(json.code, 2);
  assert.deepEqual(JSON.parse(json.stdout), {
    error: 'the coordinator of chat is not running; start it with jv coordinator start --project chat',
    exitCode: 2,
  });

  const unknown = jv('coordinator', 'message', '--project', 'nope', 'status');
  assert.equal(unknown.code, 3, 'an unknown project is not found');

  const store2 = openStore();
  try {
    assert.equal(store2.listMessages({}).length, 0, 'a refused line leaves no messages row');
  } finally {
    store2.close();
  }
});

test('an unknown subcommand names message among the ones there are', () => {
  const r = jv('coordinator', 'chat', '--project', 'chat');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown subcommand "jv coordinator chat" \(start, stop, restart, status or message\)/);
});
