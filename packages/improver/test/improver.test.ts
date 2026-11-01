// The improver (brief section 10): the memory plan applied with source improver:<J> (merge supersedes, archive keeps
// rows, add, expire, unknown ids skipped, the 50 operation cap), the documentation file list, and the project rule of
// improve-skills.

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

  test('improve-skills runs only on jevellan-skills, which must be registered', () => {
    assert.throws(() => I.improveProject(store, 'improve-skills', 'sandbox'), (e: unknown) => e instanceof JvError && e.exitCode === 2 && /register jevellan-skills first/.test(e.message));
    store.createProject({ name: 'jevellan-skills', path: join(home, 'skills'), default_branch: 'main' });
    assert.equal(I.improveProject(store, 'improve-skills', undefined), 'jevellan-skills');
    assert.throws(() => I.improveSkillsHandler.check!(store, project), /runs on the project jevellan-skills/);
    assert.equal(I.improveProject(store, 'improve-docs', 'sandbox'), 'sandbox');
    assert.throws(() => I.improveProject(store, 'improve-docs', undefined), /--project is required/);
  });
});
