// The planner (brief section 9): goals, the plan task's text from the verbatim template, and finishPlan's validation,
// skips and queued, unstarted tasks with after links.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-planner-test-'));
process.env.JV_HOME = home;
const memory = await import('jevellan-memory');
const { openStore, registerSchemaExtension } = await import('jevellan-core/store');
registerSchemaExtension(memory.memorySchemaExtension);
const { JvError } = await import('jevellan-core/errors');
const P = await import('../src/index.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
const project = store.createProject({ name: 'sandbox', path: '/repos/sandbox', default_branch: 'main' }).row;
const openTask = store.createTask({ project_id: project.id, request_id: 'open-1', kind: 'feature', title: 'Customers CSV import', task_text: 'x', workflow_json: '{"steps":[]}', state: 'running', state_reason: 'test' }).row;

const fixture = readFileSync(P.PLAN_TEMPLATE_FILE, 'utf8').length;

describe('goals', () => {
  test('add, list by priority, show, done and pause', () => {
    const g1 = P.addGoal(store, { project: 'sandbox', title: 'Import contacts', text: 'Customers can import a CSV of contacts and see errors per row.', priority: 1 });
    const g2 = P.addGoal(store, { project: 'sandbox', title: 'Invoices in PDF', text: 'Invoices download as PDF.' });
    assert.match(g1.id, /^G[0-9A-Z]{6}$/);
    assert.deepEqual(P.listGoals(store, { project: 'sandbox' }).map((g) => g.id), [g1.id, g2.id]);
    assert.equal(P.goalView(store, g1).project, 'sandbox');
    assert.throws(() => P.addGoal(store, { project: 'sandbox', title: 'x', text: 'y', priority: 9 }), (e: unknown) => e instanceof JvError && e.exitCode === 2);
    assert.throws(() => P.requireGoal(store, 'GZZZZZZ'), (e: unknown) => e instanceof JvError && e.exitCode === 3);
    store.setGoalState(g2.id, 'paused');
    assert.deepEqual(P.listGoals(store, { project: 'sandbox', states: ['open'] }).map((g) => g.id), [g1.id]);
    assert.ok(fixture);
  });
});

describe('the plan task', () => {
  test('the template is filled with the open goals, recent and open tasks, the memory brief, the notes and the limit', () => {
    memory.remember(store.db, { scope: memory.projectScope('sandbox'), kind: 'environment', text: 'the tests need npm ci first', source: 'owner' });
    const text = P.planTaskText(store, project, 3, new Date());
    assert.match(text, /^You are planning the next tasks for the project "sandbox" at \/repos\/sandbox\. Read the code and docs as needed; change nothing\./);
    assert.match(text, /Goals \(highest priority first\):\n- G[0-9A-Z]{6} \(priority 1\) Import contacts\n  Customers can import a CSV/);
    assert.ok(!text.includes('Invoices in PDF'), 'a paused goal is left out');
    assert.match(text, new RegExp(`Open now \\(do not duplicate these\\):\\n- ${openTask.id} Customers CSV import \\(running\\)`));
    assert.match(text, /What the project remembers:\n- \(environment\) the tests need npm ci first/);
    assert.match(text, /Propose at most 3 tasks/);
    assert.match(text, /```json\n\{ "tasks": \[/);
  });
});

describe('finishPlan', () => {
  const made: Array<{ requestId?: string; origin?: string; after?: string; start?: boolean; visible?: boolean; title: string }> = [];
  const deps = {
    createTask: async (s: typeof store, input: { requestId?: string; origin?: string; after?: string; start?: boolean; visible?: boolean; title: string; text: string; kind: string }) => {
      made.push(input);
      return { task: s.createTask({ project_id: project.id, request_id: input.requestId!, kind: 'feature', title: input.title, task_text: input.text, workflow_json: '{"steps":[]}', origin: input.origin ?? 'owner', ...(input.after ? { after_task_id: input.after } : {}) }).row };
    },
  };
  const job = () => store.createJob({ project_id: project.id, kind: 'plan', request_id: `plan:sandbox:${Math.random()}`, input_json: '{"maxTasks":3}' }).row;
  const report = (summary: string) => ({ id: 'E1', sessionId: 'R1', taskId: null, stepId: null, status: 'done' as const, summary, changedFiles: [], screenshots: [], createdAt: '' });
  const goal = () => P.listGoals(store, { project: 'sandbox', states: ['open'] })[0]!.id;

  test('creates the proposed tasks queued and unstarted, with request ids, origin and after links; skips duplicates', async () => {
    const j = job();
    const block = { tasks: [
      { goal: goal(), kind: 'feature', title: 'CSV upload endpoint', text: 'Add the endpoint.', after: null },
      { goal: goal(), kind: 'feature', title: 'Row errors page', text: 'Show errors per row.', after: 0 },
      { goal: goal(), kind: 'bug', title: 'customers csv import', text: 'Duplicate of an open task.', after: null },
    ] };
    const r = await P.finishPlan(store, j, report(`Three tasks.\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``), deps);
    assert.equal((r.created as string[]).length, 2);
    assert.deepEqual(r.skipped, [{ title: 'customers csv import', reason: 'an open task has this title' }]);
    assert.deepEqual(made.slice(-2).map((m) => [m.requestId, m.origin, m.start, m.visible]), [
      [`plan:${j.id}:0`, `planner:${j.id}`, false, false],
      [`plan:${j.id}:1`, `planner:${j.id}`, false, false],
    ]);
    assert.equal(made.at(-1)!.after, (r.created as string[])[0], 'the after index resolves to the created task');
  });

  test('no block, invalid JSON, a closed goal or too many tasks fail the job and create nothing', async () => {
    const before = made.length;
    const fails = async (summary: string, why: RegExp) => assert.rejects(P.finishPlan(store, job(), report(summary), deps), (e: unknown) => e instanceof JvError && why.test(e.message));
    await fails('No block here.', /no fenced json block/);
    await fails('```json\n{ nope\n```', /not valid JSON/);
    await fails('```json\n{"tasks":[{"goal":"GZZZZZZ","kind":"feature","title":"t","text":"x"}]}\n```', /not an open goal/);
    const four = Array.from({ length: 4 }, (_, i) => ({ goal: goal(), kind: 'feature', title: `t${i}`, text: 'x' }));
    await fails(`\`\`\`json\n${JSON.stringify({ tasks: four })}\n\`\`\``, /does not validate/);
    await assert.rejects(P.finishPlan(store, job(), undefined, deps), /without a report/);
    assert.equal(made.length, before);
  });
});
