// The improver (brief section 10): the memory plan applied with source improver:<J> (merge supersedes, archive keeps
// rows, add, expire, unknown ids skipped, a refused operation skipped on its own, the 50 operation cap), the inputs
// (the tasks a plan created count, the jobs' own work tasks do not), the documentation file list, and the project
// rule of improve-skills.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-improver-test-'));
process.env.JV_HOME = home;
const memory = await import('jevellan-memory');
const { openStore, registerSchemaExtension } = await import('jevellan-core/store');
registerSchemaExtension(memory.memorySchemaExtension);
const { JvError } = await import('jevellan-core/errors');
const I = await import('../src/index.js');

after(() => rmSync(home, { recursive: true, force: true }));
const store = openStore();
after(() => store.close());
const project = store.createProject({ name: 'sandbox', path: join(home, 'repo'), default_branch: 'main' }).row;
const job = store.createJob({ project_id: project.id, kind: 'improve-memory', request_id: 'improve-memory:sandbox:test' }).row;
const P = memory.projectScope('sandbox');

describe('improve-memory', () => {
  test('two near duplicates merge: one archived with superseded_by, none deleted, the result lists the merge', () => {
    const a = memory.remember(store.db, { scope: P, kind: 'environment', text: 'run npm ci before the tests', source: 'owner' }).id;
    const b = memory.remember(store.db, { scope: P, kind: 'environment', text: 'npm ci must run before npm test', source: 'owner' }).id;
    const old = memory.remember(store.db, { scope: P, kind: 'fact', text: 'the API is on v1', source: 'owner' }).id;
    const keepFact = memory.remember(store.db, { scope: P, kind: 'fact', text: 'Node 22 is required', source: 'owner' }).id;
    const r = I.applyMemoryPlan(store, project, job, {
      merge: [{ keep: a, archive: [b], text: 'The sandbox tests need npm ci first' }],
      archive: [{ id: old, reason: 'v2 shipped' }, { id: 'MZZZZZZ', reason: 'unknown' }],
      add: [{ scope: 'project', kind: 'lesson', text: 'small commits land faster', tags: ['landing'] }],
      expire: [{ id: keepFact, expiresAt: '2027-06-01' }],
    });
    assert.deepEqual(r.merged, [{ keep: a, archived: [b] }]);
    assert.deepEqual(r.archived, [old]);
    assert.equal((r.added as string[]).length, 1);
    assert.deepEqual(r.expired, [keepFact]);
    assert.deepEqual(r.skipped, [{ op: 'archive MZZZZZZ', reason: 'MZZZZZZ is unknown or archived' }]);
    assert.equal(memory.get(store.db, b)!.superseded_by, a);
    assert.equal(memory.get(store.db, b)!.status, 'archived');
    assert.equal(memory.get(store.db, a)!.text, 'The sandbox tests need npm ci first');
    assert.equal(memory.get(store.db, (r.added as string[])[0]!)!.source, `improver:${job.id}`);
    assert.equal(memory.history(store.db, b)[0]!.by, `improver:${job.id}`);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n, 5, 'nothing deleted');
    // An operation on an archived id is skipped.
    const again = I.applyMemoryPlan(store, project, job, { archive: [{ id: b, reason: 'again' }] });
    assert.deepEqual(again.skipped, [{ op: `archive ${b}`, reason: `${b} is unknown or archived` }]);
  });

  test('a plan that does not validate is refused; more than 50 operations are cut, the rest listed as skipped', () => {
    assert.throws(() => I.applyMemoryPlan(store, project, job, { merge: 'all' }), (e: unknown) => e instanceof JvError && /does not validate/.test(e.message));
    const ids = Array.from({ length: 55 }, (_, i) => memory.remember(store.db, { scope: P, kind: 'fact', text: `fact number ${i}`, source: 'owner' }).id);
    const r = I.applyMemoryPlan(store, project, job, { archive: ids.map((id) => ({ id, reason: 'bulk' })) });
    assert.equal((r.archived as string[]).length, 50);
    assert.equal((r.skipped as Array<{ reason: string }>).filter((s) => s.reason === 'over 50 operations').length, 5);
  });

  test('a merge that names its keep id in archive, repeats an id or has nothing to merge, or an operation memory refuses, is skipped alone', () => {
    const c = memory.remember(store.db, { scope: P, kind: 'lesson', text: 'tests are faster with --test-concurrency', source: 'owner' }).id;
    const d = memory.remember(store.db, { scope: P, kind: 'lesson', text: 'run tests concurrently, they are faster', source: 'owner' }).id;
    const e = memory.remember(store.db, { scope: P, kind: 'lesson', text: 'a lesson nobody merges', source: 'owner' }).id;
    const r = I.applyMemoryPlan(store, project, job, {
      merge: [
        { keep: c, archive: [d, d, c], text: null },
        { keep: e, archive: [] },
        { keep: e, archive: [], text: 'x'.repeat(2001) },
      ],
      add: [{ scope: 'project', kind: 'fact', text: 'the sandbox has 42 unit tests', tags: [] }],
    });
    assert.deepEqual(r.merged, [{ keep: c, archived: [d] }]);
    assert.equal(memory.get(store.db, c)!.text, 'tests are faster with --test-concurrency', 'a null text keeps the wording');
    assert.deepEqual((r.skipped as Array<{ op: string }>).map((x) => x.op), [`merge ${e}`, `merge ${e}`]);
    assert.equal((r.skipped as Array<{ reason: string }>)[0]!.reason, 'nothing to merge');
    assert.match((r.skipped as Array<{ reason: string }>)[1]!.reason, /text must be 1 to 2000 characters/);
    assert.equal(memory.get(store.db, e)!.text, 'a lesson nobody merges');
    assert.equal((r.added as string[]).length, 1, 'the operations after a refused one still apply');
  });

  test('the inputs count the tasks a plan created and leave out the jobs\' own work tasks', () => {
    const done = (requestId: string, origin: string, title: string) => {
      const t = store.createTask({ project_id: project.id, request_id: requestId, kind: 'single', title, task_text: 'x', workflow_json: '{"steps":[]}', state: 'done', state_reason: 'landed', origin }).row;
      const step = store.createStep({ task_id: t.id, ordinal: 1, duty: 'implement', state: 'done' }).row;
      const run = store.createSession({ project_id: project.id, task_id: t.id, step_id: step.id, request_id: `run-${requestId}`, kind: 'step', runtime: 'llm', provider: 'p', model: 'm', effort: 'low', cwd: '/tmp' }).row;
      store.createReport({ session_id: run.id, step_id: step.id, task_id: t.id, status: 'done', summary: `${title}: done` });
      return t.id;
    };
    const planned = done('plan:J0000PL:0', 'planner:J0000PL', 'CSV upload endpoint');
    const work = done('job:J0000WK', 'improver:J0000WK', 'Tidy what sandbox remembers');
    const reports = I.memoryJobInput(store, project, job).reports.map((x) => x.task);
    assert.ok(reports.includes(planned));
    assert.ok(!reports.includes(work));
  });

  test('the work task carries the memories and the recent reports', async () => {
    const spec = await I.improveMemoryHandler.workTask(store, job, project);
    assert.match(spec.text, /^You are tidying what this project remembers\. Merge memories that say the same thing/);
    assert.match(spec.text, /"text": "The sandbox tests need npm ci first"/);
    assert.match(spec.text, /```json\n\{ "merge": \[/);
  });
});

describe('improve-docs and improve-skills', () => {
  test('documentation files: README, AGENTS, CHANGELOG and docs/** when present', () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, 'docs', 'guide'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# x\n');
    writeFileSync(join(repo, 'docs', 'guide', 'setup.md'), 'x\n');
    writeFileSync(join(repo, 'docs', 'decisions.md'), 'x\n');
    assert.deepEqual(I.documentationFiles(repo), ['README.md', 'docs/decisions.md', 'docs/guide/setup.md']);
  });

  test('finish lands the work that changed documentation; a change outside it, or no change, is not landed', async () => {
    const lands: string[] = [];
    let answer: 'land' | 'ask-owner' | 'throw' = 'land';
    const handlers = I.makeImproverHandlers({
      land: async (s, taskId, options) => {
        assert.deepEqual(options, { auto: true });
        lands.push(taskId);
        if (answer === 'throw') throw new Error('git merge failed: conflict in README.md');
        const row = s.createLanding({ task_id: taskId, route: answer, state: answer === 'land' ? 'landed' : 'asked', reason: answer === 'land' ? 'small documentation change' : 'touches a risky area' });
        return { route: answer, state: row.state, reason: row.reason, taskId };
      },
    });
    const docs = handlers.find((h) => h.kind === 'improve-docs')!;
    const skills = handlers.find((h) => h.kind === 'improve-skills')!;
    const docsJob = store.createJob({ project_id: project.id, kind: 'improve-docs', request_id: 'improve-docs:sandbox:land-test' }).row;
    const work = (files: string[], summary = 'Updated the README.') => {
      const t = store.createTask({ project_id: project.id, request_id: `job:land-${Math.random()}`, kind: 'single', title: 'Docs', task_text: 'x', workflow_json: '{"steps":[]}', state: 'done', state_reason: 'step document done', origin: `improver:${docsJob.id}` }).row;
      const step = store.createStep({ task_id: t.id, ordinal: 1, duty: 'document', state: 'done' }).row;
      const run = store.createSession({ project_id: project.id, task_id: t.id, step_id: step.id, request_id: `run-land-${t.id}`, kind: 'step', runtime: 'llm', provider: 'p', model: 'm', effort: 'low', cwd: '/tmp' }).row;
      const r = store.createReport({ session_id: run.id, step_id: step.id, task_id: t.id, status: 'done', summary, changed_files_json: JSON.stringify(files) }).row;
      return { task: t, report: { id: r.id, sessionId: run.id, taskId: t.id, stepId: step.id, status: 'done' as const, summary, changedFiles: files, screenshots: [], createdAt: r.created_at } };
    };

    const a = work(['README.md', 'docs/setup.md']);
    const ra = await docs.finish(store, docsJob, a.report, a.task);
    assert.deepEqual(lands, [a.task.id]);
    assert.deepEqual(ra.landing, { route: 'land', state: 'landed', commit: null, reason: 'small documentation change' });
    assert.equal(ra.summary, '2 documentation files changed; landing land (landed)');
    // A second finish of the same task does not land it again.
    await docs.finish(store, docsJob, a.report, a.task);
    assert.equal(lands.length, 1);

    const b = work(['README.md', 'src/app.ts']);
    const rb = await docs.finish(store, docsJob, b.report, b.task);
    assert.equal(lands.length, 1, 'a change outside the documentation is not landed');
    assert.equal(rb.notLanded, 'changed files outside the documentation: src/app.ts');

    const c = work([], 'Documentation is current');
    const rc = await docs.finish(store, docsJob, c.report, c.task);
    assert.deepEqual([rc.current, rc.landing, rc.summary, lands.length], [true, null, 'Documentation is current', 1]);

    answer = 'throw';
    const d = work(['CHANGELOG.md']);
    const rd = await docs.finish(store, docsJob, d.report, d.task);
    assert.deepEqual(rd.landing, { route: 'none', state: 'error', commit: null, reason: 'git merge failed: conflict in README.md' });

    answer = 'ask-owner';
    const e = work(['.apm/skills/jevellan-router/SKILL.md'], 'Changed the router.\n\n```json\n{"router":{"before":"held-out 8/10","after":"held-out 9/10"}}\n```');
    const re = await skills.finish(store, docsJob, e.report, e.task);
    assert.deepEqual((re.landing as { route: string; state: string }).route, 'ask-owner');
    assert.deepEqual(re.agreement, { router: { before: 'held-out 8/10', after: 'held-out 9/10' } });
    assert.equal(re.summary, '1 skill files changed; landing ask-owner (asked)');
  });

  test('improve-skills runs only on jevellan-skills, which must be registered', () => {
    assert.throws(() => I.improveProject(store, 'improve-skills', 'sandbox'), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /register jevellan-skills first/.test(e.message));
    store.createProject({ name: 'jevellan-skills', path: join(home, 'skills'), default_branch: 'main' });
    assert.equal(I.improveProject(store, 'improve-skills', undefined), 'jevellan-skills');
    assert.throws(() => I.improveSkillsHandler.check!(store, project), /runs on the project jevellan-skills/);
    assert.equal(I.improveProject(store, 'improve-docs', 'sandbox'), 'sandbox');
    assert.throws(() => I.improveProject(store, 'improve-docs', undefined), /--project is required/);
  });
});
