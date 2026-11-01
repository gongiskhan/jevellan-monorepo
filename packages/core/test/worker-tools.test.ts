// The worker tools of brief section 3 and the memory port (M-015): jv_remember and jv_recall through a registered
// memory implementation (a fake here: jevellan-core may not import jevellan-memory), the stdio server's tool table,
// the report's optional A2UI ui field, and the memory block in the prompt and in a run's start event.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { makeHome, seedTask } from './fixtures/run-fixture.js';

const home = makeHome('jv-worker-tools-test-');
process.env.JV_HOME = home;
const { openStore } = await import('../src/store.js');
const port = await import('../src/memory-port.js');
const tools = await import('../src/tools/index.js');
const { handleMessage } = await import('../src/report-mcp.js');
const { writeReport, reportView } = await import('../src/report.js');
const { checkReportUi: checkUi } = await import('../src/contracts/a2ui.js');
const prompt = await import('../src/prompt.js');
const { executeRun } = await import('../src/run.js');
const launcher = await import('../src/launcher.js');
const { paths } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

type Fake = { id: string; scope: string; kind: string; text: string; tags: string[]; source: string };
const remembered: Fake[] = [];
const fakeMemory = {
  remember(_db: unknown, input: { scope: string; kind: string; text: string; tags?: string[]; source: string }) {
    const same = remembered.find((m) => m.scope === input.scope && m.kind === input.kind && m.text === input.text);
    if (same) return { id: same.id, created: false };
    const id = `M${String(remembered.length + 1).padStart(6, '0')}`;
    remembered.push({ id, scope: input.scope, kind: input.kind, text: input.text, tags: input.tags ?? [], source: input.source });
    return { id, created: true };
  },
  recall(_db: unknown, o: { scopes: readonly string[]; query: string }) {
    return remembered
      .filter((m) => o.scopes.includes(m.scope) && m.text.includes(o.query))
      .map((m) => ({ ...m, kind: m.kind as 'fact', status: 'active', uses: 0, created_at: '' }));
  },
  buildBrief(_db: unknown, o: { project: string }) {
    const lines = remembered.filter((m) => m.scope === `project:${o.project}` || m.scope === 'global').map((m) => `- (${m.kind}) ${m.text}`);
    return { text: lines.join('\n'), ids: remembered.map((m) => m.id) };
  },
  writeProjectMemoryFile(_db: unknown, project: string, path: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `# Memory: project:${project}\n`);
  },
  projectScope: (p: string) => `project:${p}`,
  readScopes: (p: string) => ['global', `project:${p}`],
};

const store = openStore();
after(() => store.close());
const seeded = seedTask(store, home, { name: 'sandbox', agents: '# Rules\n' });
const run = launcher.createRun(store, {
  requestId: 'req-tools-1',
  projectId: seeded.projectId,
  taskId: seeded.taskId,
  stepId: seeded.stepIds[0]!,
  runtime: 'claude-sdk',
  provider: 'claude-main',
  model: 'model-strong',
  effort: 'high',
  cwd: seeded.repo,
}).row;

describe('memory tools', () => {
  test('without a registered memory the tools answer that memory is not available and change nothing', () => {
    const r = tools.rememberTool(store, run.id, { kind: 'fact', text: 'x' });
    assert.deepEqual(r, { text: 'Memory is not available in this process.', isError: true });
    assert.equal(tools.recallTool(store, run.id, { query: 'x' }).isError, true);
  });

  test('jv_remember writes the project scope with source session:<R>, answers with the id, and regenerates memory.md', () => {
    port.registerMemory(fakeMemory as unknown as import('../src/memory-port.js').MemoryApi);
    const r = tools.rememberTool(store, run.id, { kind: 'environment', text: 'the sandbox tests need npm ci first', tags: ['NPM'] });
    assert.deepEqual(r, { text: 'Remembered (M000001).', isError: false });
    assert.deepEqual(remembered[0], { id: 'M000001', scope: 'project:sandbox', kind: 'environment', text: 'the sandbox tests need npm ci first', tags: ['npm'], source: `session:${run.id}` });
    assert.ok(existsSync(join(paths.projectDir('sandbox'), 'memory.md')));
    assert.equal(tools.rememberTool(store, run.id, { kind: 'environment', text: 'the sandbox tests need npm ci first' }).text, 'Already known (M000001).');
    assert.equal(tools.rememberTool(store, run.id, { kind: 'preference', text: 'short answers', scope: 'global' }).text, 'Remembered (M000002).');
    assert.equal(remembered[1]!.scope, 'global');
  });

  test('invalid input is an error result naming the field', () => {
    assert.match(tools.rememberTool(store, run.id, { kind: 'opinion', text: 'x' }).text, /^The memory is not valid: kind/);
    assert.match(tools.rememberTool(store, run.id, { kind: 'fact', text: '' }).text, /text/);
    assert.match(tools.rememberTool(store, run.id, { kind: 'fact', text: 'x', tags: Array.from({ length: 9 }, () => 'a') }).text, /tags/);
    assert.match(tools.recallTool(store, run.id, { query: 'x'.repeat(201) }).text, /^The query is not valid/);
  });

  test('jv_recall answers one memory per line from the project and global scopes', () => {
    assert.equal(tools.recallTool(store, run.id, { query: 'npm ci' }).text, '[M000001] (environment) the sandbox tests need npm ci first');
    assert.equal(tools.recallTool(store, run.id, { query: 'nothing like this' }).text, 'Nothing remembered matches.');
  });

  test('the stdio server lists the three tools and calls jv_remember', () => {
    const list = JSON.parse(handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { sessionId: run.id })!) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    };
    assert.deepEqual(list.result.tools.map((t) => t.name), ['jv_report', 'jv_remember', 'jv_recall']);
    assert.ok(list.result.tools[1]!.inputSchema.properties.kind);
    const call = JSON.parse(
      handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jv_remember', arguments: { kind: 'lesson', text: 'small commits land faster' } } }), {
        sessionId: run.id,
      })!,
    ) as { result: { content: Array<{ text: string }>; isError: boolean } };
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0]!.text, /^Remembered \(M\d{6}\)\.$/);
    assert.deepEqual(tools.WORKER_TOOLS_QUALIFIED, ['mcp__jv__jv_report', 'mcp__jv__jv_remember', 'mcp__jv__jv_recall']);
  });
});

describe('the report ui field', () => {
  const surface = [
    { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
    { version: 'v0.9', updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Button' }] } },
  ];

  test('checkUi accepts v0.9 and 1.0 messages with exactly one body and refuses the rest', () => {
    assert.equal(checkUi(surface).ok, true);
    assert.equal(checkUi([{ version: '1.0', deleteSurface: { surfaceId: 's1' } }]).ok, true);
    const bad = (ui: unknown, why: RegExp) => {
      const r = checkUi(ui);
      assert.equal(r.ok, false);
      assert.match((r as { reason: string }).reason, why);
    };
    bad({}, /not an array/);
    bad([{ version: 'v0.9', createSurface: { catalogId: 'basic' } }], /no surfaceId/);
    
    bad([{ version: 'v0.8', createSurface: {} }], /ui\[0\] has version/);
    bad([{ version: 'v0.9', createSurface: {}, deleteSurface: {} }], /exactly one/);
    bad([{ version: 'v0.9' }], /exactly one/);
    bad([{ version: 'v0.9', createSurface: { surfaceId: 's', blob: 'x'.repeat(70_000) } }], /at most 65536/);
  });

  test('a valid ui is stored and read back; an invalid one is dropped with a limitation and the report still recorded', () => {
    const a = launcher.createRun(store, { requestId: 'req-tools-ui-a', projectId: seeded.projectId, taskId: seeded.taskId, stepId: seeded.stepIds[0]!, runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: seeded.repo }).row;
    const ok = writeReport(store, a.id, { status: 'done', summary: 'Pick one below.', ui: surface });
    assert.equal(ok.outcome, 'recorded');
    assert.deepEqual(reportView(store.getReportBySession(a.id)!).ui, surface);
    const b = launcher.createRun(store, { requestId: 'req-tools-ui-b', projectId: seeded.projectId, taskId: seeded.taskId, stepId: seeded.stepIds[0]!, runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: seeded.repo }).row;
    const dropped = writeReport(store, b.id, { status: 'done', summary: 'Done.', limitations: 'none known', ui: [{ version: 'v0.9' }] });
    assert.equal(dropped.outcome, 'recorded');
    const row = store.getReportBySession(b.id)!;
    assert.equal(row.ui_json, null);
    assert.match(row.limitations!, /^none known ui dropped: ui\[0\] has none of /);
  });
});

describe('the memory block', () => {
  test('buildSystemAppend puts it after the project instructions and before the task block; nothing when empty', () => {
    const base = {
      project: store.requireProject(seeded.projectId),
      task: store.requireTask(seeded.taskId),
      step: store.requireStep(seeded.stepIds[0]!),
      steps: store.listSteps(seeded.taskId),
      reports: new Map(),
      cwd: seeded.repo,
      base: 'main',
      rulesFile: join(home, 'worker-rules.md'),
    };
    const out = prompt.buildSystemAppend({ ...base, memory: '- (environment) the sandbox tests need npm ci first' }).systemAppend;
    const at = (s: string) => out.indexOf(s);
    assert.ok(at('What this project remembers:\n- (environment) the sandbox tests need npm ci first') > at('# Rules'));
    assert.ok(at(`Task ${seeded.taskId}`) > at('What this project remembers:'));
    assert.ok(!prompt.buildSystemAppend({ ...base, memory: '  ' }).systemAppend.includes('What this project remembers'));
    assert.equal(port.memoryBlock(undefined), undefined);
  });

  test('a run records the memory block and its memory ids in the start event', async () => {
    const r = launcher.createRun(store, { requestId: 'req-tools-run', projectId: seeded.projectId, taskId: seeded.taskId, stepId: seeded.stepIds[0]!, runtime: 'claude-sdk', provider: 'claude-main', model: 'model-strong', effort: 'high', cwd: seeded.repo }).row;
    let seenAppend = '';
    await executeRun(r.id, {
      store,
      handleSignals: false,
      rulesFile: join(home, 'worker-rules.md'),
      log: () => {},
      afterRun: async () => {},
      loadRuntime: async () => ({
        start: async (session, input) => {
          seenAppend = input.systemAppend;
          writeReport(store, session.id, { status: 'done', summary: 'ok' });
          return { pid: process.pid, pgid: process.pid };
        },
        resume: async () => {},
        stop: async () => {},
        tail: async function* () {},
      }),
    });
    const start = store.listEvents(r.id).find((e) => e.kind === 'start')!;
    const payload = JSON.parse(start.payload) as { memory?: { block: string; ids: string[] } };
    assert.match(payload.memory!.block, /^What this project remembers:\n- \(environment\) the sandbox tests need npm ci first/);
    assert.ok(payload.memory!.ids.includes('M000001'));
    assert.ok(seenAppend.includes('What this project remembers:'));
    assert.ok(readFileSync(join(paths.projectDir('sandbox'), 'memory.md'), 'utf8').startsWith('# Memory'));
  });
});
