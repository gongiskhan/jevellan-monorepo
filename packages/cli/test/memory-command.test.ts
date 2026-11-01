// jv memory add|search|list|archive|export through the CLI on a temporary home, and the stdio worker server
// (jv worker-mcp) with jevellan-memory registered: jv_remember and jv_recall end to end (brief sections 3 and 6).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FAKE_TOKEN, makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-memory-command-test-');
process.env.JV_HOME = home;
const { openStore } = await import('jevellan-core/store');
const { createRun } = await import('jevellan-core/launcher');

after(() => rmSync(home, { recursive: true, force: true }));

const entry = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
function jv(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], { env: { ...process.env, JV_HOME: home, JV_SESSION: '' }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function json<T>(...args: string[]): T {
  const r = jv(...args, '--json');
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout) as T;
}

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home, { name: 'sandbox' });

describe('jv memory', () => {
  let id = '';
  test('add to a project scope and to global; the same text again is already known; memory.md is regenerated', () => {
    const a = json<{ id: string; created: boolean }>('memory', 'add', '--scope', 'project', '--project', 'sandbox', '--kind', 'environment', '--tag', 'NPM', 'The sandbox tests need npm ci first');
    assert.equal(a.created, true);
    assert.match(a.id, /^M[0-9A-Z]{6}$/);
    id = a.id;
    const again = jv('memory', 'add', '--scope', 'project', '--project', 'sandbox', '--kind', 'environment', 'The sandbox tests need   npm ci first');
    assert.equal(again.code, 0);
    assert.match(again.stdout, new RegExp(`^Already known \\(${id}\\)`));
    assert.equal(json<{ created: boolean }>('memory', 'add', '--scope', 'global', '--kind', 'preference', 'Answers stay short').created, true);
    const file = join(home, 'projects', 'sandbox', 'memory.md');
    assert.ok(existsSync(file));
    assert.match(readFileSync(file, 'utf8'), new RegExp(`The sandbox tests need npm ci first \\[npm\\] \\(${id}\\)`));
  });

  test('refusals: a scope without a project, an unknown kind, an unknown project', () => {
    assert.equal(jv('memory', 'add', '--scope', 'project', '--kind', 'fact', 'x').code, 2);
    assert.equal(jv('memory', 'add', '--scope', 'global', '--kind', 'opinion', 'x').code, 2);
    assert.equal(jv('memory', 'add', '--scope', 'project', '--project', 'nope', '--kind', 'fact', 'x').code, 3);
    assert.equal(jv('memory', 'frobnicate').code, 2);
  });

  test('search finds it (also with diacritics folded), list and export show it', () => {
    const s = jv('memory', 'search', 'npm ci');
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`^${id} project:sandbox \\(environment\\) The sandbox tests need npm ci first \\[npm\\]$`, 'm'));
    assert.equal(json<{ memories: unknown[] }>('memory', 'search', '--project', 'sandbox', 'sandbox').memories.length, 1);
    assert.match(jv('memory', 'search', 'nothing here at all').stdout, /Nothing remembered matches/);
    const list = json<{ memories: Array<{ id: string }> }>('memory', 'list', '--project', 'sandbox');
    assert.deepEqual(list.memories.map((m) => m.id), [id]);
    assert.match(jv('memory', 'export', '--project', 'sandbox').stdout, /^# Memory: project:sandbox\n\n## Environment\n/);
  });

  test('add masks a known secret before the memory is stored or printed', () => {
    const r = jv('memory', 'add', '--scope', 'global', '--kind', 'environment', `The staging key is ${FAKE_TOKEN} for now`, '--json');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(FAKE_TOKEN));
    const out = JSON.parse(r.stdout) as { id: string; memory: { text: string } };
    assert.equal(out.memory.text, 'The staging key is [redacted] for now');
    const row = store.db.prepare('SELECT text FROM memories WHERE id = ?').get(out.id) as { text: string };
    assert.equal(row.text, 'The staging key is [redacted] for now');
  });

  test('archive needs a reason, hides the memory, and keeps it listable as archived', () => {
    assert.equal(jv('memory', 'archive', id).code, 2);
    const r = jv('memory', 'archive', id, '--reason', 'moved to the README');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^Archived ${id}: moved to the README`));
    assert.equal(json<{ memories: unknown[] }>('memory', 'list', '--project', 'sandbox').memories.length, 0);
    assert.equal(json<{ memories: unknown[] }>('memory', 'list', '--project', 'sandbox', '--status', 'archived').memories.length, 1);
    assert.equal(jv('memory', 'archive', 'MZZZZZZ', '--reason', 'x').code, 3);
  });
});

describe('jv worker-mcp', () => {
  test('serves jv_report, jv_remember and jv_recall over stdio with jevellan-memory', async () => {
    const run = createRun(store, {
      requestId: 'req-worker-mcp',
      projectId: seeded.projectId,
      taskId: seeded.taskId,
      stepId: seeded.stepIds[0]!,
      runtime: 'claude-tmux',
      provider: 'claude-main',
      model: 'model-strong',
      effort: 'high',
      cwd: seeded.repo,
    }).row;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, 'worker-mcp', '--session', run.id], { env: { ...process.env, JV_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies: Array<{ id: number; result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }> = [];
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'jv_remember', arguments: { kind: 'environment', text: 'Playwright browsers are under the Library cache' } } });
    send({ id: 4, method: 'tools/call', params: { name: 'jv_recall', arguments: { query: 'playwright' } } });
    const deadline = Date.now() + 15_000;
    while (replies.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    const by = (id: number) => replies.find((r) => r.id === id)!;
    assert.deepEqual(by(2).result.tools!.map((t) => t.name), ['jv_report', 'jv_remember', 'jv_recall']);
    assert.equal(by(3).result.isError, false);
    const remembered = /^Remembered \((M[0-9A-Z]{6})\)\.$/.exec(by(3).result.content![0]!.text);
    assert.ok(remembered, by(3).result.content![0]!.text);
    assert.equal(by(4).result.content![0]!.text, `[${remembered[1]}] (environment) Playwright browsers are under the Library cache`);
    const row = store.db.prepare('SELECT source, scope FROM memories WHERE id = ?').get(remembered[1]!) as { source: string; scope: string };
    assert.deepEqual({ ...row }, { source: `session:${run.id}`, scope: 'project:sandbox' });
  });
});
