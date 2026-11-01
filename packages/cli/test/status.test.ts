// jv status (status.ts): waiting-on-owner first, done tasks out (listed apart for 24 hours), failed tasks for 24
// hours, the latest run and report per task, the options of a needs-decision and of a landing ask, lost runs marked
// at read time, and the --project filter; the text block of brief section 4 with the bot line through the command,
// the `bot` key of --json, and --watch (repaints until SIGINT, exit 0; refused with --json). The block itself is
// tested line by line in core's status-format.test.ts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-status-test-');
process.env.JV_HOME = home;
const S = await import('jevellan-core/status');
const { openStore } = await import('jevellan-core/store');
const { writeReport } = await import('jevellan-core/report');
const { main } = await import('../src/cli.js');
const W = await import('../src/commands/status.js');

const store = openStore();
after(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const p1 = store.createProject({ name: 'one', path: '/tmp/jv-status-one', default_branch: 'main' }).row;
const p2 = store.createProject({ name: 'two', path: '/tmp/jv-status-two', default_branch: 'main' }).row;
let n = 0;
function task(projectId: string, title: string, state: 'queued' | 'running' | 'waiting-owner' | 'landing' | 'done' | 'failed') {
  n++;
  const t = store.createTask({ project_id: projectId, request_id: `r${n}`, kind: 'feature', title, task_text: 'x', workflow_json: '{}' }).row;
  const step = store.createStep({ task_id: t.id, ordinal: 1, duty: 'implement' }).row;
  store.createStep({ task_id: t.id, ordinal: 2, duty: 'verify' });
  const run = store.createSession({
    project_id: projectId,
    task_id: t.id,
    step_id: step.id,
    request_id: `s${n}`,
    kind: 'step',
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: '/tmp',
  }).row;
  store.setTaskState(t.id, state, `${state} for the test`, { current_step: 1 });
  return { task: store.requireTask(t.id), step, run };
}

const running = task(p1.id, 'Running one', 'running');
store.setSessionState(running.run.id, 'running', 'turn running');
const waiting = task(p1.id, 'Waiting one', 'waiting-owner');
store.setSessionState(waiting.run.id, 'running', 'x');
writeReport(store, waiting.run.id, { status: 'needs-decision', summary: 'Pick one.', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] });
store.setSessionState(waiting.run.id, 'done', 'turn ended: report needs-decision');
const asking = task(p1.id, 'Landing ask', 'waiting-owner');
store.createLanding({ task_id: asking.task.id, route: 'ask-owner', state: 'asked', reason: 'Touches stored data.' });
const lost = task(p1.id, 'Lost one', 'running');
store.setSessionState(lost.run.id, 'running', 'x', { pid: 999999, native_session_id: 'native-lost' });
const done = task(p1.id, 'Done one', 'done');
const failed = task(p2.id, 'Failed one', 'failed');
const queued = task(p2.id, 'Queued one', 'queued');
const coordinator = store.createSession({ project_id: p1.id, request_id: 'coord', kind: 'coordinator', runtime: 'claude-tmux', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: '/tmp' }).row;
store.setSessionState(coordinator.id, 'running', 'coordinator up', { tmux_target: 'jv-coord-one' });

test('status lists open work, waiting-on-owner first, and marks lost runs at read time', () => {
  const view = S.statusView(store);
  assert.deepEqual(view.lost, [lost.run.id]);
  const ids = view.tasks.map((t) => t.id);
  assert.deepEqual(ids.slice(0, 2).sort(), [waiting.task.id, asking.task.id].sort(), 'waiting-owner first');
  assert.ok(!ids.includes(done.task.id), 'done tasks are left out');
  assert.ok(ids.includes(failed.task.id), 'a task that failed in the last 24 hours is listed');
  assert.deepEqual(view.tasks.map((t) => t.state), ['waiting-owner', 'waiting-owner', 'running', 'running', 'queued', 'failed']);
  assert.deepEqual(view.recent.map((r) => r.id), [done.task.id]);

  const w = view.tasks.find((t) => t.id === waiting.task.id)!;
  assert.equal(w.question, 'A or B?');
  assert.deepEqual(w.options, [{ label: 'A' }, { label: 'B' }]);
  assert.deepEqual(w.report, { session: waiting.run.id, status: 'needs-decision', summary: 'Pick one.' });
  assert.deepEqual(w.step, { ordinal: 1, duty: 'implement', state: 'pending', of: 2 });
  assert.equal(w.run?.model, 'model-strong');
  assert.equal(w.run?.provider, 'claude-main');
  assert.equal(w.run?.runtime, 'claude-sdk');
  assert.equal(w.state_reason, 'waiting-owner for the test');

  const a = view.tasks.find((t) => t.id === asking.task.id)!;
  assert.deepEqual(a.options?.map((o) => o.label), ['Land now', 'Leave it']);
  assert.match(a.question!, /Touches stored data/);
  assert.equal(a.options?.[0]?.description, `jv land ${asking.task.id} --force`);

  const l = view.tasks.find((t) => t.id === lost.task.id)!;
  assert.equal(l.lost, true);
  assert.equal(l.run?.state, 'lost');
  assert.ok(view.sessions.some((s) => s.id === lost.run.id && s.state === 'lost'));
  assert.ok(view.sessions.some((s) => s.id === coordinator.id && s.kind === 'coordinator'));
  assert.ok(!view.sessions.some((s) => s.id === done.run.id));
  assert.equal(view.tasks.find((t) => t.id === queued.task.id)?.run?.state, 'queued');

  const text = S.formatStatus(store, view);
  const lines = text.split('\n');
  assert.equal(lines[0], 'bot: not running');
  assert.equal(lines[1], 'one (/tmp/jv-status-one)');
  assert.deepEqual(
    lines.filter((l) => /^ {2}\S/.test(l)),
    ['  waiting on you', '  running', `  landed today: ${done.task.id} (${S.clockTime(store.requireTask(done.task.id).ended_at)})   failed: none`, '  queued', `  landed today: none   failed: ${failed.task.id} (${S.clockTime(store.requireTask(failed.task.id).ended_at)})`],
  );
  assert.match(text, new RegExp(`LOST: jv task resume ${lost.task.id}`));
  assert.match(text, new RegExp(`${waiting.task.id} .*needs-decision  ${waiting.run.id}  \\d\\d:\\d\\d  options: A \\| B$`, 'm'));
  assert.match(text, new RegExp(`${asking.task.id} .*ask-owner  ${asking.run.id}  \\d\\d:\\d\\d  options: Land now \\| Leave it$`, 'm'));
  assert.match(text, new RegExp(`${running.task.id} .*Strong high via claude-main  ${running.run.id}  \\d\\d:\\d\\d$`, 'm'));
  assert.ok(lines.every((l) => [...l].length <= 100));
});

test('--project filters; failed and done tasks older than 24 hours drop out', async () => {
  const later = Date.now() + 25 * 3600 * 1000;
  const view = S.statusView(store, { project: 'two', now: later, markLost: false });
  assert.deepEqual(view.tasks.map((t) => t.id), [queued.task.id]);
  assert.deepEqual(view.recent, []);
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (c: string) => (out.push(String(c)), true);
  let code: number;
  try {
    code = await main(['status', '--project', 'one', '--json']);
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
  assert.equal(code, 0);
  const json = JSON.parse(out.join('')) as { tasks: Array<{ id: string; project: string }>; bot: { alive: boolean; running: number; queued: number; limits: object } };
  assert.ok(json.tasks.length >= 4);
  assert.ok(json.tasks.every((t) => t.project === 'one'));
  assert.deepEqual(Object.keys(json), ['tasks', 'sessions', 'recent', 'lost', 'bot']);
  assert.equal(json.bot.alive, false);
  assert.equal(json.bot.queued, 1);
  assert.deepEqual(json.bot.limits, { perProject: 2, total: 4 });
});

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (c: string) => (out.push(String(c)), true);
  try {
    const code = await fn();
    return { code, out: out.join('') };
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
}

test('jv status prints the block, bot line first, through the command', async () => {
  const { code, out } = await capture(() => main(['status', '--project', 'two']));
  assert.equal(code, 0);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], 'bot: not running');
  assert.equal(lines[1], 'two (/tmp/jv-status-two)');
  assert.equal(lines[2], '  queued');
  assert.match(lines[3]!, new RegExp(`^ {4}${queued.task.id}  Queued one  queued for the test$`));
});

test('jv status --watch with --json is refused (exit 2)', async () => {
  const { code, out } = await capture(() => main(['status', '--watch', '--json']));
  assert.equal(code, 2);
  assert.match((JSON.parse(out) as { error: string }).error, /--watch/);
});

test('watchStatus clears the screen and repaints until SIGINT, then resolves 0 and stops', async () => {
  const signals = new EventEmitter();
  const writes: string[] = [];
  let paints = 0;
  const done = W.watchStatus(() => `paint ${++paints}`, { write: (t: string) => void writes.push(t) }, { intervalMs: 15, signals });
  assert.deepEqual(writes, [`${W.CLEAR_SCREEN}paint 1\n`], 'the first paint is immediate');
  while (writes.length < 3) await new Promise((r) => setTimeout(r, 5));
  signals.emit('SIGINT');
  assert.equal(await done, 0);
  const count = writes.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(writes.length, count, 'no repaint after SIGINT');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.ok(writes.every((w, i) => w === `${W.CLEAR_SCREEN}paint ${i + 1}\n`));
  assert.equal(W.WATCH_INTERVAL_MS, 2000);
  assert.equal(W.CLEAR_SCREEN, '\x1b[H\x1b[2J');
});

test('watchStatus shows a repaint error in place and keeps going', async () => {
  const signals = new EventEmitter();
  const writes: string[] = [];
  let paints = 0;
  const done = W.watchStatus(
    () => {
      paints++;
      if (paints === 2) throw new Error('the store is busy');
      return `paint ${paints}`;
    },
    { write: (t: string) => void writes.push(t) },
    { intervalMs: 15, signals },
  );
  while (writes.length < 3) await new Promise((r) => setTimeout(r, 5));
  signals.emit('SIGINT');
  assert.equal(await done, 0);
  assert.match(writes[1]!, /^\x1b\[H\x1b\[2Jjv: the store is busy \(trying again in 0 s\)\n$/);
  assert.equal(writes[2], `${W.CLEAR_SCREEN}paint 3\n`);
});

test('jv status --watch as a process: repaints every 2 s, SIGINT ends it with exit 0', async () => {
  const cliUrl = new URL('../src/cli.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      `const { main } = await import(${JSON.stringify(cliUrl)}); process.exitCode = await main(['status', '--watch', '--project', 'two']);`,
    ],
    { env: { ...process.env, JV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no second paint: ${JSON.stringify(out)} ${err}`)), 15_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.split(W.CLEAR_SCREEN).length - 1 >= 2) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const elapsed = Date.now() - started;
  child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(code, 0, err);
  assert.ok(elapsed >= 1500, `the second paint came after ${elapsed} ms`);
  const paints = out.split(W.CLEAR_SCREEN).slice(1);
  assert.ok(paints.length >= 2);
  for (const p of paints) assert.match(p, /^bot: not running\ntwo \(\/tmp\/jv-status-two\)\n/);
});
