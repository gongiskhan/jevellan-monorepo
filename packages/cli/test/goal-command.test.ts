// jv goal add|list|show|done|pause through the command line on a temporary home (brief sections 4 and 9): the JSON
// contract ({goal} and {goals}, the shape the MCP's jv_goal_* tools and the UI give), the text lines (ids first, at
// most 100 characters, local HH:MM), the transitions (done is final, pause takes an open goal) and the exit codes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome } from './fixtures/run-fixture.js';

const home = makeHome('jv-goal-command-test-');
process.env.JV_HOME = home;
await import('../src/setup.js');
const { openStore } = await import('jevellan-core/store');

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
function refusal(code: number, ...args: string[]): string {
  const r = jv(...args, '--json');
  assert.equal(r.code, code, r.stdout || r.stderr);
  const body = JSON.parse(r.stdout) as { error: string; exitCode: number };
  assert.equal(body.exitCode, code);
  return body.error;
}

interface Goal {
  id: string;
  project: string;
  title: string;
  text: string;
  priority: number;
  state: string;
  createdAt: string;
  updatedAt: string;
}

const store = openStore();
after(() => store.close());
store.createProject({ name: 'sandbox', path: '/repos/sandbox', default_branch: 'main' });
store.createProject({ name: 'other', path: '/repos/other', default_branch: 'main' });

describe('jv goal', () => {
  let first = '';
  let second = '';
  test('add: {goal} with the view\'s keys; the default priority is 3; the text names id, project and priority', () => {
    const a = json<{ goal: Goal }>('goal', 'add', '--project', 'sandbox', '--title', 'Import contacts', '--text', 'Customers can import a CSV of contacts and see errors per row.', '--priority', '1');
    assert.deepEqual(Object.keys(a), ['goal']);
    assert.deepEqual(Object.keys(a.goal), ['id', 'project', 'title', 'text', 'priority', 'state', 'createdAt', 'updatedAt']);
    assert.match(a.goal.id, /^G[0-9A-Z]{6}$/);
    assert.deepEqual([a.goal.project, a.goal.priority, a.goal.state], ['sandbox', 1, 'open']);
    first = a.goal.id;
    const text = jv('goal', 'add', '--project', 'sandbox', '--title', 'Invoices in PDF', '--text', 'Invoices download as PDF.');
    assert.equal(text.code, 0, text.stderr);
    const m = /^(G[0-9A-Z]{6}) added to sandbox \(priority 3\): Invoices in PDF\n$/.exec(text.stdout);
    assert.ok(m, text.stdout);
    second = m[1]!;
    json('goal', 'add', '--project', 'other', '--title', 'Elsewhere', '--text', 'A goal of another project.', '--priority', '5');
  });

  test('add refuses a missing title or text and a priority outside 1 to 5 (exit 2), an unknown project (exit 3)', () => {
    assert.match(refusal(2, 'goal', 'add', '--project', 'sandbox', '--text', 'x'), /--title is required/);
    assert.match(refusal(2, 'goal', 'add', '--project', 'sandbox', '--title', 'x'), /--text is required/);
    assert.match(refusal(2, 'goal', 'add', '--project', 'sandbox', '--title', 'x', '--text', 'y', '--priority', '9'), /priority is 1 to 5/);
    assert.match(refusal(2, 'goal', 'add', '--project', 'sandbox', '--title', 'x', '--text', 'y', '--priority', 'high'), /--priority needs a whole number/);
    assert.match(refusal(3, 'goal', 'add', '--project', 'nope', '--title', 'x', '--text', 'y'), /no project nope/);
    assert.match(refusal(2, 'goal'), /^jv goal add --project N/);
    assert.match(refusal(2, 'goal', 'frobnicate'), /unknown subcommand "goal frobnicate"/);
  });

  test('list: {goals} by priority, filtered by project and state; text one line per goal', () => {
    const all = json<{ goals: Goal[] }>('goal', 'list');
    assert.deepEqual(Object.keys(all), ['goals']);
    assert.deepEqual(all.goals.map((g) => g.priority), [1, 3, 5]);
    assert.deepEqual(json<{ goals: Goal[] }>('goal', 'list', '--project', 'sandbox').goals.map((g) => g.id), [first, second]);
    assert.deepEqual(json<{ goals: Goal[] }>('goal', 'list', '--state', 'done').goals, []);
    assert.match(refusal(2, 'goal', 'list', '--state', 'sleeping'), /--state is one of open, paused, done/);
    assert.match(refusal(3, 'goal', 'list', '--project', 'nope'), /no project nope/);
    const text = jv('goal', 'list', '--project', 'sandbox');
    assert.equal(text.code, 0, text.stderr);
    const lines = text.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, new RegExp(`^${first}  p1  open  sandbox  \\d{2}:\\d{2}  Import contacts$`));
    assert.ok(lines.every((l) => [...l].length <= 100));
  });

  test('show: {goal} with the full text; ids are case-insensitive; an unknown goal is exit 3', () => {
    const s = json<{ goal: Goal }>('goal', 'show', first.toLowerCase());
    assert.equal(s.goal.id, first);
    assert.equal(s.goal.text, 'Customers can import a CSV of contacts and see errors per row.');
    const text = jv('goal', 'show', first);
    assert.match(text.stdout, new RegExp(`^${first}  Import contacts\\nProject sandbox, priority 1, open\\. Created \\d{2}:\\d{2}, updated \\d{2}:\\d{2}\\.\\n\\nCustomers can import`));
    assert.match(refusal(3, 'goal', 'show', 'GZZZZZZ'), /no goal GZZZZZZ/);
    assert.match(refusal(2, 'goal', 'show'), /the goal id is required/);
  });

  test('pause and done: {goal}; done is final, so a done goal is not paused (exit 2); done again changes nothing', () => {
    const p = json<{ goal: Goal }>('goal', 'pause', second);
    assert.equal(p.goal.state, 'paused');
    assert.match(jv('goal', 'pause', second).stdout, new RegExp(`^${second} paused: Invoices in PDF`));
    assert.deepEqual(json<{ goals: Goal[] }>('goal', 'list', '--project', 'sandbox', '--state', 'open').goals.map((g) => g.id), [first]);
    const d = json<{ goal: Goal }>('goal', 'done', second);
    assert.equal(d.goal.state, 'done');
    assert.equal(json<{ goal: Goal }>('goal', 'done', second).goal.updatedAt, d.goal.updatedAt);
    assert.match(refusal(2, 'goal', 'pause', second), /is done; a done goal is not paused/);
    assert.match(jv('goal', 'done', first).stdout, new RegExp(`^${first} done: Import contacts`));
    assert.deepEqual(json<{ goals: Goal[] }>('goal', 'list', '--state', 'done').goals.map((g) => g.id).sort(), [first, second].sort());
    assert.equal(store.getGoal(first)!.state, 'done', 'the store holds what the command printed');
  });
});
