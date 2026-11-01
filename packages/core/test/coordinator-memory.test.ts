// The coordinator prompt carries the memory block (brief section 3) after the project block and before the handoff,
// at start and at restart (restart goes through start), and none when the project remembers nothing.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-coordinator-memory-test-');
process.env.JV_HOME = home;
const c = await import('../src/coordinator.js');
const port = await import('../src/memory-port.js');
const { openStore } = await import('../src/store.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');

after(() => rmSync(home, { recursive: true, force: true }));

test('the memory block sits between the project instructions and the handoff, and is absent when empty', () => {
  const skills = join(RUNTIME_ROOT, 'test', 'fixtures', 'skills');
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), '# Sandbox rules\n');
  const project = { name: 'sandbox', path: repo, default_branch: 'main' };
  const text = c.coordinatorPromptText({ project, handoff: 'Nothing open.', skillsDir: skills, memory: '- (preference) the owner wants short replies' });
  const at = (s: string) => text.indexOf(s);
  assert.ok(at('What this project remembers:\n- (preference) the owner wants short replies') > at('# Sandbox rules'));
  assert.ok(at('Nothing open.') > at('What this project remembers:'));
  assert.ok(!c.coordinatorPromptText({ project, handoff: 'x', skillsDir: skills, memory: '' }).includes('What this project remembers'));

  const store = openStore();
  try {
    assert.deepEqual(c.coordinatorMemory(store, 'sandbox'), {}, 'no memory registered: no block');
    port.registerMemory({
      buildBrief: () => ({ text: '- (environment) the dev server is npm start', ids: ['M000001'] }),
    } as unknown as import('../src/memory-port.js').MemoryApi);
    assert.deepEqual(c.coordinatorMemory(store, 'sandbox'), { memory: '- (environment) the dev server is npm start' });
  } finally {
    store.close();
  }
});
