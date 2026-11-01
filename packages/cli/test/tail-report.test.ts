// jv tail and jv report through the CLI on a finished run (moved from the launcher tests of jevellan-core, which
// has no command layer of its own).

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-tail-report-test-');
process.env.JV_HOME = home;
const launcher = await import('jevellan-core/launcher');
const { executeRun } = await import('jevellan-core/run');
const { openStore } = await import('jevellan-core/store');

after(() => rmSync(home, { recursive: true, force: true }));

const entry = fileURLToPath(new URL('./fixtures/run-entry.js', import.meta.url));
const rules = join(home, 'worker-rules.md');
const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home, { agents: '# Sandbox rules\n' });

let n = 0;
function newRun(extra: { taskId?: string; stepId?: string } = {}) {
  n++;
  return launcher.createRun(store, {
    requestId: `req-tail-${n}`,
    projectId: seeded.projectId,
    taskId: extra.taskId ?? seeded.taskId,
    stepId: extra.stepId ?? seeded.stepIds[0]!,
    runtime: 'claude-sdk',
    provider: 'claude-main',
    model: 'model-strong',
    effort: 'high',
    cwd: seeded.repo,
  }).row;
}

test('jv tail and jv report read a finished run (text and --json)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeReport } = await import('jevellan-core/report');
  const { recordEvent } = await import('jevellan-core/events');
  const s = seedTask(store, home, { name: 'sixth' });
  const run = newRun({ taskId: s.taskId, stepId: s.stepIds[0]! });
  await executeRun(run.id, {
    store,
    handleSignals: false,
    rulesFile: rules,
    log: () => {},
    loadRuntime: async () => ({
      start: async (session) => {
        recordEvent(store, session.id, 'text', { text: 'Reading src/index.ts' });
        writeReport(store, session.id, {
          status: 'needs-decision',
          summary: 'Two entry points.',
          question: 'Which one is the app?',
          options: [{ label: 'src/index.ts' }, { label: 'src/server.ts', description: 'the HTTP server' }],
        });
        return { pid: process.pid, pgid: process.pid };
      },
      resume: async () => {},
      stop: async () => {},
      tail: async function* () {},
    }),
  });
  const cli = (...argv: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...argv], { env: { ...process.env, JV_HOME: home }, encoding: 'utf8' });
  const text = cli('tail', run.id);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^1 \S+ start claude-sdk claude-main model-strong high/m);
  assert.match(text.stdout, / text Reading src\/index\.ts$/m);
  assert.match(text.stdout, / report needs-decision: Two entry points\.$/m);
  assert.match(text.stdout, / end done \(turn ended: report needs-decision\)$/m);
  const json = cli('tail', run.id, '--json', '--follow');
  assert.equal(json.status, 0, json.stderr);
  const lines = json.stdout.trim().split('\n').map((l) => JSON.parse(l) as { seq: number; kind: string; payload: { status?: string } });
  assert.deepEqual(lines.map((l) => l.kind), ['start', 'text', 'report', 'end']);
  assert.equal(lines[2]!.payload.status, 'needs-decision');
  const rep = cli('report', run.id);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /needs-decision/);
  assert.match(rep.stdout, /Question: Which one is the app\?/);
  assert.match(rep.stdout, /2\. src\/server\.ts - the HTTP server/);
  const repJson = JSON.parse(cli('report', run.id, '--json').stdout) as { status: string; options: unknown[]; question: string };
  assert.equal(repJson.status, 'needs-decision');
  assert.equal(repJson.options.length, 2);
  const none = cli('report', newRun({ taskId: s.taskId, stepId: s.stepIds[0]! }).id);
  assert.equal(none.status, 3);
  assert.equal(cli('tail', 'RZZZZZZ').status, 3);
});
