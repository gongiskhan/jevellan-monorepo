// The data the mock UI server answers with: the contract fixtures of jevellan-core (packages/core/test/fixtures/
// contracts: status.json, task-show.json, report.json, events.json, decisions.json), moved in time so they read as
// recent, plus made-up rows for the routes those fixtures do not cover (coordinator transcript, memory, schedules,
// goals, jobs, usage, doctor, bot). Two reports carry A2UI: report.json's v0.9 surface (a ChoicePicker of three
// options and a Button named answer) and the same messages as version "1.0". No value here is a secret or has a
// secret's shape.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, '..', '..', 'core', 'test', 'fixtures', 'contracts');
const read = (name) => JSON.parse(readFileSync(join(contracts, name), 'utf8'));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** Every ISO time in `value` moved by `delta` milliseconds. */
export function shift(value, delta) {
  if (typeof value === 'string') return ISO.test(value) ? new Date(Date.parse(value) + delta).toISOString() : value;
  if (Array.isArray(value)) return value.map((v) => shift(v, delta));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v, delta)]));
  return value;
}

export const PASSWORD = 'fake-ui-password-for-tests';

export function buildFixtures(now = Date.now()) {
  const base = Date.parse('2026-11-01T18:16:00.000Z');
  const delta = now - 6 * 60_000 - base;
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const status = shift(read('status.json'), delta);
  const taskShow = shift(read('task-show.json'), delta);
  const report = read('report.json');
  const events = shift(read('events.json'), delta);
  const rawDecisions = shift(read('decisions.json'), delta);

  const projects = [
    { id: 'PK6NREG', name: 'shop', path: '/Users/owner/dev/shop', default_branch: 'main', created_at: ago(9000) },
    { id: 'PDOCS01', name: 'docs-site', path: '/Users/owner/dev/docs-site-with-a-rather-long-folder-name', default_branch: 'main', created_at: ago(8000) },
  ];

  status.bot = { alive: true, pid: 48211, heartbeatAt: ago(0.07), heartbeatAgeSeconds: 4, startedAt: ago(190), tick: 761, running: 2, queued: 1, limits: { perProject: 2, total: 4 } };
  status.tasks.push(
    { id: 'TA2UI01', project: 'shop', title: 'Customers empty state, pick a design', kind: 'single', state: 'waiting-owner', state_reason: 'step 1 implement: needs-decision', step: { ordinal: 1, duty: 'implement', state: 'running', of: 1 }, run: { id: 'RA2UI01', model: 'claude-opus-5-5', provider: 'claude-main', runtime: 'claude-tmux', effort: 'high', state: 'done', lastEventAt: ago(3) }, lost: false, report: { session: 'RA2UI01', status: 'needs-decision', summary: report.summary }, updatedAt: ago(3), question: report.question, options: report.options },
    { id: 'T7FDA1R', project: 'shop', title: 'README how-to-run section', kind: 'feature', state: 'running', state_reason: 'step 2 implement running', step: { ordinal: 2, duty: 'implement', state: 'running', of: 3 }, run: { id: 'R9Q1XXA', model: 'claude-opus-5-5', provider: 'claude-main', runtime: 'claude-sdk', effort: 'high', state: 'running', lastEventAt: ago(1) }, lost: false, report: null, updatedAt: ago(1) },
  );

  const summary = (over) => ({ parent: null, after: null, branch: null, startedAt: null, endedAt: null, lost: false, run: null, step: null, origin: 'owner', ...over });
  const tasks = [
    summary({ id: 'TX7ZNQX', project: 'shop', title: 'Customers empty state', kind: 'single', state: 'waiting-owner', stateReason: 'step 1 investigate: needs-decision', step: { ordinal: 1, duty: 'investigate', state: 'running', of: 1 }, run: { id: 'RJ79PMG', runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', state: 'done', lastEventAt: ago(6) }, createdAt: ago(7), startedAt: ago(7), updatedAt: ago(6) }),
    summary({ id: 'TA2UI01', project: 'shop', title: 'Customers empty state, pick a design', kind: 'single', state: 'waiting-owner', stateReason: 'step 1 implement: needs-decision', origin: 'coordinator', step: { ordinal: 1, duty: 'implement', state: 'running', of: 1 }, run: { id: 'RA2UI01', runtime: 'claude-tmux', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', state: 'done', lastEventAt: ago(3) }, branch: 'jv/TA2UI01-customers-empty-state', createdAt: ago(40), startedAt: ago(39), updatedAt: ago(3) }),
    summary({ id: 'TV10UI1', project: 'shop', title: 'Import preview with a version 1.0 surface', kind: 'single', state: 'waiting-owner', stateReason: 'step 1 investigate: needs-decision', origin: 'mcp', step: { ordinal: 1, duty: 'investigate', state: 'running', of: 1 }, run: { id: 'RV10UI1', runtime: 'codex', provider: 'codex', model: 'gpt-5.6-codex', effort: 'medium', state: 'done', lastEventAt: ago(12) }, createdAt: ago(30), startedAt: ago(29), updatedAt: ago(12) }),
    summary({ id: 'T7FDA1R', project: 'shop', title: 'README how-to-run section', kind: 'feature', state: 'running', stateReason: 'step 2 implement running', origin: 'ui', step: { ordinal: 2, duty: 'implement', state: 'running', of: 3 }, run: { id: 'R9Q1XXA', runtime: 'claude-sdk', provider: 'claude-main', model: 'claude-opus-5-5', effort: 'high', state: 'running', lastEventAt: ago(1) }, branch: 'jv/T7FDA1R-readme', createdAt: ago(25), startedAt: ago(24), updatedAt: ago(1) }),
    summary({ id: 'TLOST01', project: 'shop', title: 'Billing export keeps timing out on the second page', kind: 'bug', state: 'running', stateReason: 'step 1 investigate: session lost', origin: 'owner', step: { ordinal: 1, duty: 'investigate', state: 'running', of: 4 }, run: { id: 'RLOST01', runtime: 'claude-tmux', provider: 'claude-second', model: 'claude-opus-5-5', effort: 'xhigh', state: 'lost', lastEventAt: ago(14) }, lost: true, createdAt: ago(60), startedAt: ago(58), updatedAt: ago(14) }),
    summary({ id: 'TSJ13Y1', project: 'shop', title: 'Import customers from CSV', kind: 'feature', state: 'queued', stateReason: 'waiting for a slot', origin: 'planner:J7Q2W9X', step: { ordinal: 1, duty: 'plan', state: 'pending', of: 3 }, createdAt: ago(5), updatedAt: ago(5) }),
    summary({ id: 'TQAFTER', project: 'shop', title: 'Unit test for slugify', kind: 'single', state: 'queued', stateReason: 'after T7FDA1R', origin: 'coordinator', after: 'T7FDA1R', step: { ordinal: 1, duty: 'implement', state: 'pending', of: 1 }, createdAt: ago(4), updatedAt: ago(4) }),
    summary({ id: 'TLAND01', project: 'shop', title: 'Pricing page copy', kind: 'feature', state: 'waiting-owner', stateReason: 'landing: ask-owner, touches a risky area (src/billing)', origin: 'owner', step: { ordinal: 3, duty: 'verify', state: 'done', of: 3 }, branch: 'jv/TLAND01-pricing', createdAt: ago(120), startedAt: ago(119), updatedAt: ago(20) }),
    summary({ id: 'TMJPV8D', project: 'shop', title: 'README how-to-run', kind: 'single', state: 'done', stateReason: 'landed 4e1d2c3b', origin: 'schedule:C3M8K2Q', step: { ordinal: 1, duty: 'document', state: 'done', of: 1 }, createdAt: ago(200), startedAt: ago(199), endedAt: ago(150), updatedAt: ago(150) }),
    summary({ id: 'TFAIL01', project: 'shop', title: 'Upgrade the date library', kind: 'automation', state: 'failed', stateReason: 'step 2 verify failed: tests failed twice', origin: 'improver:J8IMP01', step: { ordinal: 2, duty: 'verify', state: 'failed', of: 2 }, createdAt: ago(300), startedAt: ago(299), endedAt: ago(240), updatedAt: ago(240) }),
    summary({ id: 'TOLD001', project: 'shop', title: 'An old task from last week', kind: 'single', state: 'done', stateReason: 'done', step: { ordinal: 1, duty: 'answer', state: 'done', of: 1 }, createdAt: ago(9000), endedAt: ago(8990), updatedAt: ago(8990) }),
    summary({ id: 'TDOCS01', project: 'docs-site', title: 'Fix the broken links in the getting started guide', kind: 'bug', state: 'running', stateReason: 'step 1 investigate running', origin: 'owner', step: { ordinal: 1, duty: 'investigate', state: 'running', of: 3 }, run: { id: 'RDOCS01', runtime: 'claude-sdk', provider: 'claude-second', model: 'claude-haiku-5-5', effort: 'medium', state: 'running', lastEventAt: ago(0.5) }, createdAt: ago(10), startedAt: ago(10), updatedAt: ago(0.5) }),
  ];

  // Task views: TX7ZNQX is the contract fixture as it is; the others are made from it.
  const views = new Map();
  views.set('TX7ZNQX', taskShow);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const stepOf = clone(taskShow.steps[0]);

  const a2ui = clone(taskShow);
  a2ui.id = 'TA2UI01';
  a2ui.title = 'Customers empty state, pick a design';
  a2ui.text = Array.from({ length: 18 }, (_, i) =>
    i === 0 ? 'Build both empty states for the customers page behind a setting and ask which one ships.' : `Line ${i + 1} of the task text: keep the copy short, use the existing Button component, and add a test for each state.`,
  ).join('\n');
  a2ui.origin = 'coordinator';
  a2ui.branch = 'jv/TA2UI01-customers-empty-state';
  a2ui.worktree = '/Users/owner/.jv/worktrees/shop/TA2UI01';
  a2ui.baseCommit = '9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c';
  a2ui.stateReason = 'step 1 implement: needs-decision';
  const a2uiStep = clone(stepOf);
  a2uiStep.id = 'SA2UI01';
  a2uiStep.duty = 'implement';
  a2uiStep.stateReason = 'placed: Opus high via claude-main';
  a2uiStep.runs = [
    {
      ...clone(stepOf.runs[0]),
      id: 'RA2UI01',
      runtime: 'claude-tmux',
      tmuxTarget: '=jv-shop-TA2UI01:',
      startedAt: ago(39),
      endedAt: ago(3),
      lastEventAt: ago(3),
      report: { ...clone(report), id: 'EA2UI01', sessionId: 'RA2UI01', taskId: 'TA2UI01', stepId: 'SA2UI01', createdAt: ago(3) },
    },
  ];
  a2ui.steps = [a2uiStep];
  a2ui.messages = [];
  views.set('TA2UI01', a2ui);

  const v10 = clone(a2ui);
  v10.id = 'TV10UI1';
  v10.title = 'Import preview with a version 1.0 surface';
  v10.text = 'Show the import preview and ask which columns map where.';
  v10.origin = 'mcp';
  v10.branch = null;
  v10.worktree = null;
  v10.baseCommit = null;
  v10.steps[0].runs[0] = {
    ...v10.steps[0].runs[0],
    id: 'RV10UI1',
    runtime: 'codex',
    provider: 'codex',
    model: 'gpt-5.6-codex',
    effort: 'medium',
    report: {
      ...v10.steps[0].runs[0].report,
      id: 'EV10UI1',
      sessionId: 'RV10UI1',
      taskId: 'TV10UI1',
      summary: 'The import preview reads the first 20 rows. The surface below uses the version 1.0 messages.',
      question: 'Which column holds the email address?',
      options: [{ label: 'Column B' }, { label: 'Column C' }],
      screenshots: [],
      testsRun: { command: 'npm test -- import', passed: false, summary: '2 failing: the preview test expects 20 rows, got 0.' },
      ui: report.ui.map((m) => ({ ...m, version: '1.0' })),
    },
  };
  views.set('TV10UI1', v10);

  const running = clone(taskShow);
  running.id = 'T7FDA1R';
  running.kind = 'feature';
  running.title = 'README how-to-run section';
  running.text = 'Add a How to run section to the README: install, the dev server, the tests.';
  running.state = 'running';
  running.stateReason = 'step 2 implement running';
  running.origin = 'ui';
  running.currentStep = 2;
  running.branch = 'jv/T7FDA1R-readme';
  running.worktree = '/Users/owner/.jv/worktrees/shop/T7FDA1R';
  running.baseCommit = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
  running.workflow = { name: 'feature', source: 'jevellan-workflow-feature' };
  const planStep = { ...clone(stepOf), id: 'SPLAN01', ordinal: 1, duty: 'plan', state: 'done', stateReason: 'done: plan written', runs: [{ ...clone(stepOf.runs[0]), id: 'RPLAN01', state: 'done', stateReason: 'turn ended: done', startedAt: ago(24), endedAt: ago(20), report: { ...clone(stepOf.runs[0].report), id: 'EPLAN01', sessionId: 'RPLAN01', taskId: 'T7FDA1R', status: 'done', summary: 'Plan: add a **How to run** section after Install with three commands.', question: undefined, options: undefined, testsRun: undefined, limitations: undefined, createdAt: ago(20) } }] };
  delete planStep.runs[0].report.question;
  delete planStep.runs[0].report.options;
  const implStep = { ...clone(stepOf), id: 'SIMPL01', ordinal: 2, duty: 'implement', state: 'running', stateReason: 'placed: Opus high via claude-main', attempts: 1, runs: [{ ...clone(stepOf.runs[0]), id: 'R9Q1XXA', state: 'running', stateReason: 'turn running', startedAt: ago(19), endedAt: null, lastEventAt: ago(1), report: undefined }] };
  delete implStep.runs[0].report;
  const verifyStep = { ...clone(stepOf), id: 'SVERI01', ordinal: 3, duty: 'verify', state: 'pending', stateReason: '', attempts: 0, runs: [], placements: [] };
  running.steps = [planStep, implStep, verifyStep];
  running.children = [{ id: 'TQAFTER', title: 'Unit test for slugify', state: 'queued' }];
  views.set('T7FDA1R', running);

  const landing = clone(running);
  landing.id = 'TLAND01';
  landing.title = 'Pricing page copy';
  landing.state = 'waiting-owner';
  landing.stateReason = 'landing: ask-owner, touches a risky area (src/billing)';
  landing.origin = 'owner';
  landing.currentStep = 3;
  landing.branch = 'jv/TLAND01-pricing';
  landing.steps = running.steps.map((s) => ({ ...clone(s), state: 'done', runs: s.runs.map((r) => ({ ...r, state: 'done', endedAt: r.endedAt ?? ago(21) })) }));
  landing.children = [];
  landing.landings = [{ id: 'LPRICE1', route: 'ask-owner', state: 'asked', reason: 'Touches a risky area (src/billing); the owner decides.', commit: null, createdAt: ago(20), checks: [{ name: 'test', command: 'TZ=UTC npm test', passed: true, exitCode: 0, timedOut: false, durationMs: 8400, outcome: 'passed in 8.4 s' }, { name: 'lint', command: 'npm run lint', passed: false, exitCode: 1, timedOut: false, durationMs: 2100, outcome: 'failed (exit 1) in 2.1 s' }] }];
  views.set('TLAND01', landing);

  const changes = {
    task: 'TA2UI01',
    branch: 'jv/TA2UI01-customers-empty-state',
    base: '9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c',
    worktree: '/Users/owner/.jv/worktrees/shop/TA2UI01',
    files: [
      { path: 'src/pages/customers.tsx', status: 'M', added: 4, removed: 1, uncommitted: false },
      { path: 'src/pages/customers-empty.tsx', status: 'A', added: 6, removed: 0, uncommitted: false },
      { path: 'test/customers-empty.test.tsx', status: 'M', added: 2, removed: 0, uncommitted: true },
      { path: 'notes/empty-state-ideas-with-a-long-file-name-that-does-not-fit.md', status: 'A', added: 3, removed: 0, uncommitted: true },
    ],
    diff: [
      'diff --git a/src/pages/customers.tsx b/src/pages/customers.tsx',
      'index 1111111..2222222 100644',
      '--- a/src/pages/customers.tsx',
      '+++ b/src/pages/customers.tsx',
      '@@ -10,7 +10,10 @@ export function Customers({ rows }: Props) {',
      '   const settings = useSettings();',
      '-  return <CustomersTable rows={rows} />;',
      '+  if (rows.length === 0) {',
      '+    return <CustomersEmpty variant={settings.customersEmptyState} />;',
      '+  }',
      '+  return <CustomersTable rows={rows} />;',
      ' }',
      'diff --git a/src/pages/customers-empty.tsx b/src/pages/customers-empty.tsx',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/pages/customers-empty.tsx',
      '@@ -0,0 +1,6 @@',
      "+import { Button } from '../ui/button';",
      '+',
      "+export function CustomersEmpty({ variant }: { variant: 'short' | 'guided' }) {",
      "+  if (variant === 'short') return <p>No customers yet. <Button>Add customer</Button></p>;",
      '+  return <Checklist items={["Import a CSV", "Add a customer"]} />;',
      '+}',
      'diff --git a/test/customers-empty.test.tsx b/test/customers-empty.test.tsx',
      'index 4444444..5555555 100644',
      '--- a/test/customers-empty.test.tsx',
      '+++ b/test/customers-empty.test.tsx',
      '@@ -1,3 +1,5 @@',
      " import { render } from '../test-utils';",
      "+import { CustomersEmpty } from '../src/pages/customers-empty';",
      "+test('short message', () => render(<CustomersEmpty variant=\"short\" />));",
      ' ',
      'diff --git a/notes/empty-state-ideas-with-a-long-file-name-that-does-not-fit.md b/notes/empty-state-ideas-with-a-long-file-name-that-does-not-fit.md',
      'new file mode 100644',
      'index 0000000..6666666',
      '--- /dev/null',
      '+++ b/notes/empty-state-ideas-with-a-long-file-name-that-does-not-fit.md',
      '@@ -0,0 +1,3 @@',
      '+# Ideas',
      '+- A short line with an Add customer button, and a much longer line that would scroll sideways inside the diff rather than the page.',
      '+- A guided start',
      '',
    ].join('\n'),
  };

  const transcript = {
    project: 'shop',
    session: 'RNE8VA4',
    sessionState: 'running',
    entries: [
      { at: ago(30), role: 'jv', text: '[jv] Coordinator started. Read notes.md and jv status, then report.', seq: 1, source: 'message' },
      { at: ago(29.5), role: 'tool', text: 'ran jv status --json', seq: 2, tool: { id: 'c1', name: 'Bash', input: '{"command":"jv status --json"}', output: '{"tasks":[]}', ok: true } },
      { at: ago(29), role: 'coordinator', text: 'Status: **two tasks** need you (TX7ZNQX and TA2UI01), one is running, one is queued behind a slot.', seq: 3, turnEnd: true, responseMs: 61_000 },
      { at: ago(12), role: 'owner', text: 'Start the README task, and keep the copy short.', seq: 4, source: 'message', messageId: 'M2V52B8' },
      { at: ago(11.8), role: 'tool', text: 'ran jv task create --project shop --kind feature --title "README how-to-run section" --text "Add a How to run section to the README: install, the dev server and the tests, with one command each"', seq: 5, tool: { id: 'c2', name: 'Bash', input: '{"command":"jv task create --project shop --kind feature --title \\"README how-to-run section\\""}', output: 'created T7FDA1R', ok: true } },
      { at: ago(11.5), role: 'tool', text: 'Read notes.md', seq: 6, tool: { id: 'c3', name: 'Read', input: '{"file_path":"notes.md"}', output: 'File does not exist.', ok: false } },
      { at: ago(11), role: 'coordinator', text: 'Created **T7FDA1R** (feature). It is placed and running; I will tell you when it lands.', seq: 7, turnEnd: true, responseMs: 60_000 },
      { at: ago(2), role: 'jv', text: '[jv] T7FDA1R (README how-to-run section) step plan: done. Run: jv report RPLAN01', seq: 8, source: 'message' },
      { at: ago(1.8), role: 'coordinator', text: 'The plan step of T7FDA1R is done; implementation started.', seq: 9, turnEnd: true, responseMs: 12_000 },
    ],
    turns: [],
  };

  const memories = [
    { id: 'M4V8C2D', scope: 'project:shop', kind: 'environment', text: 'The sandbox tests need npm ci first, then TZ=UTC npm test.', tags: ['tests', 'setup'], source: 'session:RJ79PMG', confidence: 1, status: 'active', superseded_by: null, uses: 7, last_used_at: ago(10), expires_at: null, created_at: ago(3000), updated_at: ago(10) },
    { id: 'M9K2PQR', scope: 'global', kind: 'preference', text: 'Copy in English, sentence case, no exclamation marks.', tags: ['copy'], source: 'owner', confidence: 1, status: 'active', superseded_by: null, uses: 22, last_used_at: ago(2), expires_at: null, created_at: ago(9000), updated_at: ago(2) },
    { id: 'M1LESSN', scope: 'project:shop', kind: 'lesson', text: 'The customers table is rendered in src/pages/customers.tsx; the empty state belongs next to it.', tags: [], source: 'improver:J8IMP01', confidence: 0.9, status: 'active', superseded_by: null, uses: 2, last_used_at: ago(100), expires_at: null, created_at: ago(400), updated_at: ago(100) },
    { id: 'M0ARCHV', scope: 'project:shop', kind: 'fact', text: 'The dev server runs on port 3000.', tags: ['dev'], source: 'owner', confidence: 1, status: 'archived', superseded_by: 'M4V8C2D', uses: 1, last_used_at: null, expires_at: null, created_at: ago(9500), updated_at: ago(500) },
  ];

  const schedules = [
    { id: 'C3M8K2Q', project: 'shop', name: 'Nightly tests', cron: '0 3 * * *', tz: 'Europe/Lisbon', kind: 'task', spec: { kind: 'single', duty: 'verify', title: 'Nightly tests', text: "Run the project's test command and the browser journeys. Report testsRun.", visible: false }, enabled: true, nextRunAt: new Date(now + 7 * 3600_000).toISOString(), nextRuns: [], lastRunAt: ago(1300), lastResult: 'created TMJPV8D', createdAt: ago(9000), due: false },
    { id: 'C7PLAN1', project: 'shop', name: 'Plan', cron: '30 3 * * *', tz: 'Europe/Lisbon', kind: 'job', spec: { job: 'plan' }, enabled: false, nextRunAt: new Date(now + 7.5 * 3600_000).toISOString(), nextRuns: [], lastRunAt: null, lastResult: '', createdAt: ago(8000), due: false },
  ];
  const goals = [
    { id: 'G2CSV01', project: 'shop', title: 'Customers can import a CSV of contacts and see errors per row', text: 'An import page with a preview of the first rows, the errors per row and an import button that skips the bad rows.', priority: 1, state: 'open', createdAt: ago(5000), updatedAt: ago(300) },
    { id: 'G3DOCS1', project: 'shop', title: 'The README explains how to run everything', text: 'Install, dev server, tests and browser journeys, one command each.', priority: 3, state: 'paused', createdAt: ago(6000), updatedAt: ago(900) },
    { id: 'G4DONE1', project: 'docs-site', title: 'No broken links', text: 'Every link of the site resolves.', priority: 2, state: 'done', createdAt: ago(9000), updatedAt: ago(2000) },
  ];
  const jobs = [
    { id: 'J7Q2W9X', project: 'shop', kind: 'plan', state: 'done', reason: 'done', requestId: 'plan:shop:2026-11-01', task: 'TPLAN01', taskState: 'done', input: { maxTasks: 3 }, result: { created: ['TSJ13Y1', 'TQAFTER'], skipped: [] }, createdAt: ago(400), endedAt: ago(380), durationMs: 20 * 60_000 },
    { id: 'J8IMP01', project: 'shop', kind: 'improve-memory', state: 'running', reason: 'task TIMPR01 running', requestId: 'improve-memory:shop:2026-11-01', task: 'TIMPR01', taskState: 'running', input: {}, result: null, createdAt: ago(9), endedAt: null, durationMs: null },
    { id: 'J9DOCS1', project: 'docs-site', kind: 'improve-docs', state: 'queued', reason: 'queued', requestId: 'improve-docs:docs-site:2026-W44', task: null, taskState: null, input: {}, result: null, createdAt: ago(1), endedAt: null, durationMs: null },
  ];

  const week = isoWeek(new Date(now));
  const usage = {
    week,
    from: new Date(now - 3 * 86_400_000).toISOString(),
    to: new Date(now + 4 * 86_400_000).toISOString(),
    providers: [
      { provider: 'claude-main', probe: { provider: 'claude-main', observed_at: ago(30), source: 'probe', five_hour_pct: 18, weekly_pct: 41, five_hour_resets_at: null, weekly_resets_at: null }, stream: null, local: null, rows: 12, sessions: { sessions: 31, inputTokens: 1_840_000, outputTokens: 96_000, cacheReadTokens: 12_000_000, cacheWriteTokens: 400_000, costUsd: 48.12 } },
      { provider: 'claude-second', probe: null, stream: { provider: 'claude-second', observed_at: ago(14), source: 'stream', five_hour_pct: 5, weekly_pct: 12, five_hour_resets_at: null, weekly_resets_at: null }, local: null, rows: 4, sessions: { sessions: 6, inputTokens: 210_000, outputTokens: 18_000, cacheReadTokens: 900_000, cacheWriteTokens: 30_000, costUsd: 6.4 } },
      { provider: 'codex', probe: null, stream: null, local: null, rows: 0, sessions: { sessions: 2, inputTokens: 40_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } },
    ],
  };

  const decisions = {
    filter: { kind: null, from: null, to: null, project: null, task: null },
    kinds: ['placement', 'landing', 'workflow'],
    total: rawDecisions.length,
    shown: rawDecisions.length,
    decisions: rawDecisions.map((d) => {
      const chosen = d.chosen_json ? JSON.parse(d.chosen_json) : null;
      const summary = chosen?.label ? `${chosen.label} ${chosen.effort ?? ''} via ${chosen.provider ?? ''}`.trim() : chosen?.route ?? chosen?.workflow ?? d.kind;
      return { id: d.id, kind: d.kind, projectId: d.project_id, taskId: d.task_id, stepId: d.step_id, sessionId: d.session_id, createdAt: d.created_at, skillName: d.skill_name, jevModel: d.jev_model, latencyMs: d.latency_ms, source: chosen?.source ?? 'jev', summary, answers: [], overrideMode: d.override_mode };
    }),
  };

  const doctor = {
    ok: false,
    checks: [
      { name: 'node', status: 'OK', detail: 'v22.22.0 at /Users/owner/.nvm/versions/node/v22.22.0/bin/node' },
      { name: 'store', status: 'OK', detail: 'schema 2 at /Users/owner/.jv/store.sqlite' },
      { name: 'skills', status: 'OK', detail: '14 skills installed, jv-version 0.4.0' },
      { name: 'provider:claude-main', status: 'OK', detail: 'ready, token file present' },
      { name: 'provider:codex', status: 'WARN', detail: 'needs login', fix: 'jv providers login codex' },
      { name: 'models:ollama', status: 'WARN', detail: 'no models', fix: 'ollama pull <model>' },
      { name: 'ports:ui', status: 'FAIL', detail: '7071 is taken by another process (pid 1234, node)', fix: 'jv ui --port 7081' },
      { name: 'member', status: 'OK', detail: 'Jevellan member running (pid 79678); jv leaves it alone' },
    ],
  };

  const bot = {
    bot: status.bot,
    config: { tickSeconds: 15, limits: { perProject: 2, total: 4 }, quietHours: { from: '23:00', to: '07:00' }, health: { bind: '127.0.0.1', port: 7073 }, logLines: 20000 },
    service: { file: '/Users/owner/Library/LaunchAgents/dev.jevellan.bot.plist', installed: false },
    log: Array.from({ length: 120 }, (_, i) => `${new Date(now - (120 - i) * 15_000).toISOString()} tick ${641 + i}: reconcile 0 lost, ${i % 7 === 0 ? 1 : 0} admitted; schedules 0 due; jobs 0 stepped`),
    queue: [
      { id: 'TSJ13Y1', project: 'shop', title: 'Import customers from CSV', reason: 'waiting for a slot', createdAt: ago(5) },
      { id: 'TQAFTER', project: 'shop', title: 'Unit test for slugify', reason: 'after T7FDA1R', createdAt: ago(4), after: 'T7FDA1R' },
    ],
  };

  const notes = {
    shop: '# Notes\n\n- The owner wants the empty state copy short.\n- Billing changes always ask the owner before landing.\n',
    'docs-site': '',
  };
  const workflows = {
    shop: [
      { kind: 'feature', source: 'jevellan-workflow-feature', file: '/Users/owner/.jv/skills/jevellan-workflow-feature/workflow.json', steps: [{ duty: 'plan' }, { duty: 'implement' }, { duty: 'verify' }] },
      { kind: 'bug', source: 'project', file: '/Users/owner/.jv/projects/shop/workflows/bug.json', steps: [{ duty: 'investigate' }, { duty: 'implement' }, { duty: 'verify', when: 'always' }] },
    ],
    'docs-site': [],
  };

  const reports = new Map();
  const eventsBySession = new Map([['RJ79PMG', events]]);
  for (const view of views.values()) for (const step of view.steps) for (const run of step.runs) if (run.report) reports.set(run.id, run.report);
  eventsBySession.set('RA2UI01', shift(events, 33 * 60_000).map((e) => ({ ...e, session_id: 'RA2UI01' })));

  // GET /api/providers: the providers.json menu of the Override dialog (M-068).
  const providers = {
    providers: [
      { name: 'claude-main', kind: 'claude-subscription', models: [{ id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] }] },
      { name: 'claude-second', kind: 'claude-subscription', models: [{ id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
      { name: 'local', kind: 'openai-compatible', models: [{ id: 'qwen3-coder', label: 'Qwen3 Coder', efforts: ['default'] }] },
    ],
  };

  return { projects, status, tasks, views, changes, transcript, memories, schedules, goals, jobs, usage, decisions, doctor, bot, providers, notes, workflows, reports, eventsBySession };
}

export function isoWeek(at) {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
