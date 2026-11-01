// The planner (brief section 9): goals and their transitions (done is final, pause takes an open goal), the text of
// jv goal list|show, the plan task's text from the verbatim template (without the jobs' own work tasks), and
// finishPlan's validation, skips and queued, unstarted tasks with after links.

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

describe('goal transitions and text', () => {
  test('done from open or paused is final; pause takes an open goal; a done goal is not paused', () => {
    const g = P.addGoal(store, { project: 'sandbox', title: 'Archive old invoices', text: 'Invoices older than a year move to the archive.', priority: 4 });
    assert.equal(P.pauseGoal(store, g.id).state, 'paused');
    assert.equal(P.pauseGoal(store, g.id.toLowerCase()).state, 'paused', 'pausing again changes nothing; ids are case-insensitive');
    assert.equal(P.doneGoal(store, g.id).state, 'done');
    const at = P.requireGoal(store, g.id).updated_at;
    assert.equal(P.doneGoal(store, g.id).updated_at, at, 'done again changes nothing');
    assert.throws(() => P.pauseGoal(store, g.id), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /is done; a done goal is not paused/.test(e.message));
    assert.throws(() => P.doneGoal(store, 'GZZZZZZ'), (e: unknown) => e instanceof JvError && e.exitCode === 3);
    const multiline = P.addGoal(store, { project: 'sandbox', title: '  Faster\n  imports ', text: 'x' });
    assert.equal(multiline.title, 'Faster imports', 'a title is one line');
    store.setGoalState(multiline.id, 'done');
  });

  test('jv goal list text: ids first, priority, state, project, local time, title cut at 100 characters', () => {
    const long = P.addGoal(store, { project: 'sandbox', title: 'A goal with a long title '.repeat(4).trim(), text: 'x' });
    const views = P.listGoals(store, { project: 'sandbox' }).map((g) => P.goalView(store, g));
    const lines = P.formatGoalList(views).split('\n');
    assert.equal(lines.length, views.length);
    for (const [i, line] of lines.entries()) {
      assert.ok([...line].length <= 100, line);
      assert.match(line, new RegExp(`^${views[i]!.id}  p${views[i]!.priority}  ${views[i]!.state} +sandbox  \\d{2}:\\d{2}  `));
    }
    assert.ok(lines.find((l) => l.startsWith(long.id))!.endsWith('...'));
    assert.equal(P.formatGoalList([]), 'No goals.');
    assert.match(P.formatGoalView(P.goalView(store, long)), new RegExp(`^${long.id}  A goal with a long title.*\nProject sandbox, priority 3, open\\. Created \\d{2}:\\d{2}, updated \\d{2}:\\d{2}\\.\n\nx$`));
    store.setGoalState(long.id, 'done');
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

  test('the jobs\' own work tasks (request id job:<J>) are neither recent nor open work', () => {
    store.createTask({ project_id: project.id, request_id: 'job:J0000AA', kind: 'single', title: 'Tidy what sandbox remembers', task_text: 'x', workflow_json: '{"steps":[]}', state: 'running', state_reason: 'test', origin: 'improver:J0000AA' });
    store.createTask({ project_id: project.id, request_id: 'plan:J0000AB:0', kind: 'feature', title: 'Planned earlier', task_text: 'x', workflow_json: '{"steps":[]}', state: 'queued', state_reason: 'test', origin: 'planner:J0000AB' });
    const text = P.planTaskText(store, project, 3, new Date());
    assert.ok(!text.includes('Tidy what sandbox remembers'));
    assert.match(text, /- T[0-9A-Z]{6} Planned earlier \(queued\)/, 'a task a plan created is open work');
  });
});

describe('finishPlan', () => {
  const made: Array<{ requestId?: string; origin?: string; after?: string; start?: boolean; visible?: boolean; duty?: string; title: string }> = [];
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

  test('a duty of null (the template says "<only for single>") is no duty; a single task keeps its duty', async () => {
    const j = job();
    const block = { tasks: [
      { goal: goal(), kind: 'bug', duty: null, title: 'Fix the CSV header parsing', text: 'Headers with spaces fail.', after: null },
      { goal: goal(), kind: 'single', duty: 'investigate', title: 'Find where rows are validated', text: 'Name the files.', after: '0' },
    ] };
    const r = await P.finishPlan(store, j, report(`Two.\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``), deps);
    assert.equal((r.created as string[]).length, 2);
    const [bug, single] = made.slice(-2);
    assert.equal(bug!.duty, undefined);
    assert.equal(single!.duty, 'investigate');
    assert.equal(single!.after, (r.created as string[])[0]);
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
