// jv ui through the CLI: prints the URL, serves the read-only viewer, stops on SIGTERM.
// Moved from the viewer's own tests (packages/ui/test/ui.test.ts), since it drives the command layer.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-ui-command-test-');
process.env.JV_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openStore } = await import('jevellan-core/store');
openStore().close();

const cliUrl = new URL('../src/cli.js', import.meta.url).href;

test('jv ui --port 0 --json prints the URL, serves, and stops on SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(['ui', '--port', '0', '--json']);`],
    { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 15_000;
  while (!/\}\s*$/.test(out.trim()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const info = JSON.parse(out) as { url: string; port: number; bind: string; readOnly: boolean };
  assert.equal(info.bind, '127.0.0.1');
  assert.equal(info.readOnly, true);
  assert.ok(info.port > 0);
  assert.equal((await fetch(`${info.url}/api/overview`)).status, 200);
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});
