// Contract tests (brief section 3): every fixture under test/fixtures/contracts/ parses with its schema, the schemas
// refuse obvious bad inputs, the report's `ui` limits hold at their edges, and the objects the lifted code produces
// (a placement through a fake Jev, the workflow questions, the owner's placement, a report, events, jv status and
// jv task show of a real store, wake lines, request ids, a JvError's --json form) parse too. The type checks at the
// end keep each written schema and the lifted TypeScript type it describes in step. The public index is checked for
// the names the brief gives the API. Runs against a temporary JV_HOME; nothing reaches Jev or a provider.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { z } from 'zod';
import type { DecisionRow, EventRow, ReportRow } from '../src/types.js';
import type { PlacementChosen, PlacementState, WorkflowState } from '../src/route.js';
import type { StatusView } from '../src/status.js';
import type { TaskView } from '../src/tasks.js';
import type { ReportView } from '../src/report.js';

const home = mkdtempSync(join(realpathSync(tmpdir()), 'jv-contracts-test-'));
process.env.JV_HOME = home;

const C = await import('../src/contracts/index.js');
const core = await import('../src/index.js');
const { RUNTIME_ROOT } = await import('../src/paths.js');
const { openStore } = await import('../src/store.js');
const R = await import('../src/route.js');
const { recordProviderAuth } = await import('../src/providers.js');
const { recordEvent } = await import('../src/events.js');
const { writeReport, reportView, parseReport } = await import('../src/report.js');
const { statusView } = await import('../src/status.js');
const { taskView, autoRequestId, AUTO_REQUEST_PREFIX } = await import('../src/tasks.js');
const { recordOutcome, wakeLine: stepWakeLine } = await import('../src/advance.js');
const W = await import('../src/wake.js');
const { EXIT, JvError, notFound } = await import('../src/errors.js');

after(() => rmSync(home, { recursive: true, force: true }));

const FIXTURES = join(RUNTIME_ROOT, 'test', 'fixtures', 'contracts');
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function rejects(schema: z.ZodType, value: unknown, why: RegExp | string): void {
  const r = schema.safeParse(value);
  assert.equal(r.success, false, `expected a refusal (${String(why)})`);
  if (!r.success) {
    const text = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    if (why instanceof RegExp) assert.match(text, why);
    else assert.ok(text.includes(why), `"${text}" does not mention ${why}`);
  }
}
function accepts(schema: z.ZodType, value: unknown): void {
  const r = schema.safeParse(value);
  assert.ok(r.success, r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
}

// ---- the store the live checks read ---------------------------------------------------------------------------

const providersJson = {
  jev: { keyFile: '~/.jv/secrets/jev.key', model: 'jev-latest', timeoutMs: 4000 },
  providers: [
    {
      name: 'claude-main',
      kind: 'claude-subscription',
      home: '~/.jv/homes/claude-main',
      tokenFile: '~/.jv/secrets/claude-main.token',
      models: [
        { id: 'claude-opus-5-5', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'claude-haiku-5-5', label: 'Haiku', efforts: ['low', 'medium'] },
      ],
    },
    { name: 'claude-second', kind: 'claude-subscription', home: '~/.jv/homes/claude-second', models: 'same as claude-main' },
  ],
};
mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
writeFileSync(join(home, 'secrets', 'jev.key'), 'made-up-jev-key-for-tests-0123\n', { mode: 0o600 });
writeFileSync(join(home, 'secrets', 'claude-main.token'), 'made-up-token-for-tests-4567\n', { mode: 0o600 });
for (const p of ['claude-main', 'claude-second']) mkdirSync(join(home, 'homes', p), { recursive: true });
writeFileSync(join(home, 'providers.json'), JSON.stringify(providersJson));
cpSync(join(RUNTIME_ROOT, 'test', 'fixtures', 'skills', 'jevellan-router'), join(home, 'skills', 'jevellan-router'), { recursive: true });
for (const [duty, needs] of Object.entries({ investigate: ['repo-read'], plan: ['repo-read'], implement: ['repo-write', 'shell'], document: ['repo-write'] })) {
  mkdirSync(join(home, 'skills', `jevellan-duty-${duty}`), { recursive: true });
  writeFileSync(join(home, 'skills', `jevellan-duty-${duty}`, 'SKILL.md'), `---\nname: jevellan-duty-${duty}\njv-needs:\n${needs.map((n) => `  - ${n}`).join('\n')}\n---\nBody.\n`);
}

type Questions = Record<string, { type: string; criteria: Record<string, string> }>;
function fakeJev(answer: (questions: Questions) => Record<string, unknown>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body === undefined) return new Response(JSON.stringify({ models: [{ name: 'jev-latest', description: '', release_date: '2026-10-01' }] }), { status: 200 });
    const body = JSON.parse(String(init.body)) as { questions: Questions };
    return new Response(JSON.stringify({ model: 'jev-test-1', answers: answer(body.questions), usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200 });
  }) as typeof fetch;
}
function pick(q: { criteria: Record<string, string> }, match: (key: string) => boolean) {
  const keys = Object.keys(q.criteria);
  const chosen = keys.find(match)!;
  return { type: 'choice', choice: chosen, probabilities: Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.8 : 0.2 / (keys.length - 1)])), confidence: 0.8 };
}

const store = openStore();
after(() => store.close());
for (const name of ['claude-main', 'claude-second']) recordProviderAuth(store, name, { auth: 'ready', observedAt: new Date().toISOString() });
const repo = join(home, 'repos', 'shop');
mkdirSync(repo, { recursive: true });
const project = store.createProject({ name: 'shop', path: repo, default_branch: 'main' }).row;

const taskA = store.createTask({
  project_id: project.id,
  request_id: 'contracts-a',
  kind: 'single',
  title: 'Customers empty state',
  task_text: 'Find where the customers table renders.',
  workflow_json: JSON.stringify({ name: 'single', source: 'single' }),
}).row;
const stepA = store.createStep({ task_id: taskA.id, ordinal: 1, duty: 'investigate', instructions: 'Name the files.' }).row;
store.incrementStepAttempts(stepA.id);
const placed = await R.placeStep({
  store,
  taskId: taskA.id,
  stepId: stepA.id,
  keyReady: () => true,
  fetch: fakeJev((qs) => ({
    ...(qs.model ? { model: pick(qs.model, (k) => k.startsWith('Opus via ')) } : {}),
    ...(qs.effort ? { effort: pick(qs.effort, (k) => k === 'high') } : {}),
    ...(qs.provider ? { provider: pick(qs.provider, (k) => k === 'claude-main') } : {}),
  })),
});
const runA = store.createSession({
  project_id: project.id,
  task_id: taskA.id,
  step_id: stepA.id,
  request_id: `run:${placed.decisionId}`,
  kind: 'step',
  runtime: placed.runtime,
  provider: placed.provider,
  model: placed.model,
  effort: placed.effort,
  cwd: repo,
  native_session_id: '9d1c3b5a-7e2f-4a6b-8c0d-1e2f3a4b5c6d',
}).row;
store.setSessionState(runA.id, 'running', 'started');
store.setStepState(stepA.id, 'running', 'placed');
store.setTaskState(taskA.id, 'running', 'step 1 investigate running');
const liveEvents = [
  recordEvent(store, runA.id, 'start', { runtime: runA.runtime, provider: runA.provider, model: runA.model, effort: runA.effort, cwd: repo, resume: false }),
  recordEvent(store, runA.id, 'text', { text: 'x'.repeat(30_000) }),
  recordEvent(store, runA.id, 'usage', { inputTokens: 1200, outputTokens: 80, costUsd: 0.02 }),
  recordEvent(store, runA.id, 'rate-limit', { fiveHourPct: 10, weeklyPct: 20, weeklyResetsAt: '2026-11-05T09:00:00.000Z' }),
];
const reported = writeReport(store, runA.id, {
  status: 'needs-decision',
  summary: 'The table renders in src/pages/customers.tsx.',
  question: 'Which empty state?',
  options: [{ label: 'Short' }, { label: 'Guided', description: 'A checklist.' }],
  testsRun: { command: 'npm test', passed: true, summary: '3 passing' },
});
assert.equal(reported.outcome, 'recorded');
recordEvent(store, runA.id, 'end', { status: 'done', reason: 'turn ended', report: 'needs-decision' });
store.setSessionState(runA.id, 'done', 'turn ended: needs-decision');
store.setTaskState(taskA.id, 'waiting-owner', 'step 1 investigate: needs-decision');
store.createMessage({ task_id: taskA.id, direction: 'owner', text: 'One line, please.' });
// A UI action's message: the raw A2UI action in meta_json (packages/ui server/actions.ts); task show gives it as meta.
const uiAction = { name: 'answer', surfaceId: 'empty-state-choice', sourceComponentId: 'send', timestamp: '2026-11-01T18:20:00.000Z', context: { label: 'Short message' } };
const actionMessage = store.createMessage({ task_id: taskA.id, direction: 'answer', text: 'Short message', meta_json: JSON.stringify(uiAction) });
// The owner keeps Jev's placement but records his own (jv task override --keep), and the step's outcome is recorded.
const kept = R.ownerPlacement({ store, taskId: taskA.id, stepId: stepA.id, model: 'claude-opus-5-5', effort: 'xhigh', mode: 'keep', keyReady: () => true });
const outcome = recordOutcome(store, store.requireStep(stepA.id), 'blocked');

const taskB = store.createTask({
  project_id: project.id,
  request_id: 'contracts-b',
  kind: 'feature',
  title: 'Import customers from CSV',
  task_text: 'Customers can import a CSV of contacts and see errors per row.',
  workflow_json: JSON.stringify({ name: 'feature', source: 'jevellan-workflow-feature' }),
}).row;
const stepsB = [
  { duty: 'plan', when: 'jev:needs_plan' },
  { duty: 'implement', when: 'always' },
  { duty: 'document', when: 'jev:needs_docs' },
].map((s, i) => store.createStep({ task_id: taskB.id, ordinal: i + 1, duty: s.duty, when_rule: s.when, instructions: '' }).row);
const workflow = await R.askWorkflowQuestions({
  store,
  taskId: taskB.id,
  fetch: fakeJev(() => ({ needs_plan: { type: 'noul', noul: 0.8 }, needs_docs: { type: 'noul', noul: 0.1 } })),
});
for (const s of workflow.skip) store.setStepState(s.stepId, 'skipped', s.reason);
const ownerUndo = R.ownerPlacement({ store, taskId: taskB.id, stepId: stepsB[1]!.id, model: 'claude-haiku-5-5', mode: 'undo', keyReady: () => true });

// ---- fixtures -------------------------------------------------------------------------------------------------

describe('every fixture parses with its schema', () => {
  test('report.json: the report contract, its ui, and the lifted report schema without ui', () => {
    const report = fixture('report.json') as Record<string, unknown>;
    accepts(C.ReportSchema, report);
    accepts(C.ReportWithUiSchema, report);
    const ui = C.checkReportUi(report.ui);
    assert.equal(ui.ok, true);
    assert.deepEqual(
      (report.ui as Array<Record<string, unknown>>).map((m) => Object.keys(m).find((k) => k !== 'version')),
      ['createSurface', 'updateComponents', 'updateDataModel'],
    );
    const { ui: _ui, ...withoutUi } = report;
    assert.equal(parseReport(withoutUi).ok, true, 'everything but ui is the lifted contract');
  });

  test('placement-state.json and decisions.json: the state and every kind of decision row', () => {
    accepts(C.PlacementStateSchema, fixture('placement-state.json'));
    const rows = fixture('decisions.json') as Array<{ kind: string; chosen_json: string }>;
    for (const row of rows) accepts(C.DecisionSchema, row);
    const kinds = rows.map((r) => `${r.kind}:${(JSON.parse(r.chosen_json) as { source?: string }).source ?? '-'}`);
    assert.deepEqual(kinds.sort(), ['landing:jev', 'placement:jev', 'placement:owner', 'workflow:-']);
    const landing = rows.find((r) => r.kind === 'landing') as { state_json: string } | undefined;
    accepts(C.LandingRouteStateSchema, JSON.parse(landing!.state_json));
  });

  test('events.json: one row of every event kind', () => {
    const rows = fixture('events.json') as Array<{ kind: string; seq: number }>;
    for (const row of rows) accepts(C.EventSchema, row);
    assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), [...C.EVENT_KINDS].sort());
    assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1));
  });

  test('exit-codes.json: the codes and the --json error form', () => {
    const f = fixture('exit-codes.json') as { exit: unknown; errors: unknown[] };
    assert.deepEqual(f.exit, { ...EXIT });
    for (const e of f.errors) accepts(C.CliErrorSchema, e);
    for (const code of Object.values(EXIT)) accepts(C.ExitCodeSchema, code);
  });

  test('request-ids.json: every form jv writes, and ids a caller chose', () => {
    const f = fixture('request-ids.json') as { task: Record<string, string[]>; session: Record<string, string[]>; invalid: string[] };
    for (const [form, ids] of Object.entries(f.task)) {
      for (const id of ids) {
        accepts(C.TaskRequestIdSchema, id);
        assert.equal(C.taskRequestIdForm(id), form, id);
      }
    }
    for (const id of f.task.auto!) accepts(C.AutoRequestIdSchema, id);
    for (const [form, ids] of Object.entries(f.session)) {
      const pattern = C.SESSION_REQUEST_ID_FORMS[form as keyof typeof C.SESSION_REQUEST_ID_FORMS];
      assert.ok(pattern, form);
      for (const id of ids) assert.match(id, pattern, id);
    }
    for (const id of f.invalid) rejects(C.RequestIdSchema, id, /request id/);
  });

  test('wake-lines.json: step, task, landing, merged and cut lines', () => {
    const lines = fixture('wake-lines.json') as string[];
    for (const line of lines) accepts(C.WakeLineSchema, line);
    const parsed = lines.map((l) => C.parseWakeLine(l)!);
    assert.deepEqual(parsed.map((p) => p.form), ['task', 'task', 'task', 'task', 'merged', 'cut']);
    const first = parsed[0]!;
    assert.ok(first.form === 'task');
    assert.equal(first.duty, 'investigate');
    assert.equal(first.event, 'needs-decision');
    assert.match(first.run, /^jv report R/);
    const landing = parsed[3]!;
    assert.ok(landing.form === 'task' && landing.landing && landing.duty === undefined);
    assert.ok(parsed[2]!.form === 'task' && parsed[2]!.duty === undefined && !parsed[2]!.landing);
    assert.deepEqual(parsed[4], { form: 'merged', count: 3 });
  });

  test('providers.json: the lifted schema and its full validation', () => {
    const f = fixture('providers.json');
    accepts(C.ProvidersFileSchema, f);
    const config = C.parseProviders(f, join(home, 'providers-fixture.json'));
    assert.deepEqual(config.providers.map((p) => p.name), ['claude-main', 'claude-second', 'ollama']);
    assert.equal(config.providers[1]!.modelsFrom, 'claude-main');
  });

  test('status.json and task-show.json', () => {
    accepts(C.StatusSchema, fixture('status.json'));
    accepts(C.TaskShowSchema, fixture('task-show.json'));
  });

  test('the fixtures hold no path of this machine and no secret-looking value', () => {
    for (const name of ['report.json', 'placement-state.json', 'decisions.json', 'events.json', 'exit-codes.json', 'request-ids.json', 'wake-lines.json', 'providers.json', 'status.json', 'task-show.json']) {
      const text = readFileSync(join(FIXTURES, name), 'utf8');
      assert.doesNotMatch(text, /\/Users\/|\/private\/|\/var\/folders\//, name);
      // The key prefix is built from parts so this file itself never holds a key shape (scripts/secret-scan.mjs).
      assert.doesNotMatch(text, new RegExp(`${['sk', 'ant'].join('-')}-|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN`), name);
      assert.doesNotMatch(text, /\u2014/u, name);
    }
  });
});

// ---- refusals -------------------------------------------------------------------------------------------------

describe('the schemas refuse obvious bad inputs', () => {
  const report = fixture('report.json') as Record<string, unknown>;

  test('report: the needs-decision rule, unknown keys, bounds', () => {
    const noQuestion = clone(report);
    delete noQuestion.question;
    rejects(C.ReportSchema, noQuestion, C.NEEDS_DECISION_QUESTION);
    rejects(C.ReportSchema, { ...clone(report), options: undefined }, C.NEEDS_DECISION_OPTIONS);
    rejects(C.ReportSchema, { ...clone(report), extra: 1 }, /extra|Unrecognized/);
    rejects(C.ReportSchema, { ...clone(report), status: 'finished' }, /status/);
    rejects(C.ReportSchema, { ...clone(report), summary: 'x'.repeat(C.SUMMARY_MAX + 1) }, /summary/);
    accepts(C.ReportSchema, { status: 'done', summary: 'Done.' });
  });

  test('report ui: exactly one message key, a known version, a surfaceId, an array', () => {
    const create = { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'c' } };
    const cases: Array<[unknown, RegExp]> = [
      [[{ version: 'v0.9', createSurface: { surfaceId: 's1' }, deleteSurface: { surfaceId: 's1' } }], /createSurface and deleteSurface.*exactly one/],
      [[{ version: 'v0.9' }], /none of createSurface.*exactly one/],
      [[{ ...create, version: '0.8' }], /version "0.8"/],
      [[{ createSurface: { surfaceId: 's1' } }], /version missing/],
      [[{ version: 'v0.9', deleteSurface: {} }], /deleteSurface has no surfaceId/],
      [[{ version: 'v0.9', updateDataModel: 'x' }], /updateDataModel is not an object/],
      [[{ ...create, extra: true }], /unknown key extra/],
      [['not a message'], /ui\[0\] is not an object/],
      [{ version: 'v0.9', createSurface: { surfaceId: 's1' } }, /not an array/],
    ];
    for (const [ui, reason] of cases) {
      const checked = C.checkReportUi(ui);
      assert.equal(checked.ok, false, JSON.stringify(ui));
      if (!checked.ok) assert.match(checked.reason, reason);
      assert.equal(C.ReportUiSchema.safeParse(ui).success, false, JSON.stringify(ui));
      assert.equal(C.ReportSchema.safeParse({ status: 'done', summary: 's', ui }).success, false);
    }
    assert.equal(C.checkReportUi([create, { version: '1.0', deleteSurface: { surfaceId: 's1' } }]).ok, true, 'version 1.0 passes the envelope check');
    assert.equal(C.checkReportUi([]).ok, true);
  });

  test('report ui: at most 65536 characters serialised', () => {
    assert.equal(C.REPORT_UI_MAX_CHARS, 65536);
    const sized = (chars: number) => {
      const base = [{ version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/note', value: '' } }];
      const pad = chars - JSON.stringify(base).length;
      base[0]!.updateDataModel.value = 'a'.repeat(pad);
      assert.equal(JSON.stringify(base).length, chars);
      return base;
    };
    assert.equal(C.checkReportUi(sized(65536)).ok, true);
    accepts(C.ReportUiSchema, sized(65536));
    const over = C.checkReportUi(sized(65537));
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.reason, 'ui is 65537 characters serialised; at most 65536');
    rejects(C.ReportUiSchema, sized(65537), /65537 characters/);
    rejects(C.ReportSchema, { status: 'done', summary: 's', ui: sized(65537) }, /65537 characters/);
  });

  test('the report with ui still derives a tool input JSON Schema', () => {
    const schema = z.toJSONSchema(C.ReportWithUiSchema, { io: 'input' }) as { properties?: Record<string, unknown> };
    assert.ok(schema.properties?.ui, 'ui is in the tool input schema');
    assert.ok(schema.properties?.status);
  });

  test('placement state and decisions', () => {
    const state = fixture('placement-state.json') as Record<string, unknown>;
    rejects(C.PlacementStateSchema, { ...clone(state), menu: undefined }, /menu/);
    rejects(C.PlacementStateSchema, { ...clone(state), extra: 1 }, /extra|Unrecognized/);
    const badRuntime = clone(state) as { duty: { runtimes: string[] } };
    badRuntime.duty.runtimes = ['telepathy'];
    rejects(C.PlacementStateSchema, badRuntime, /runtimes/);

    const rows = fixture('decisions.json') as Array<Record<string, unknown>>;
    const jev = rows.find((r) => r.kind === 'placement' && r.jev_model !== 'none')!;
    const landing = rows.find((r) => r.kind === 'landing')!;
    rejects(C.DecisionSchema, { ...clone(jev), chosen_json: landing.chosen_json }, /chosen_json/);
    rejects(C.DecisionSchema, { ...clone(landing), state_json: jev.state_json }, /state_json/);
    rejects(C.DecisionSchema, { ...clone(jev), state_json: '{not json' }, /not JSON/);
    rejects(C.DecisionSchema, { ...clone(jev), override_mode: 'undo' }, /override/);
    rejects(C.DecisionSchema, { ...clone(jev), id: 'D12345' }, /id/);
    rejects(C.DecisionSchema, { ...clone(jev), id: 'DLLLLLL' }, /Crockford/);
    rejects(C.DecisionSchema, { ...clone(jev), kind: 'guess' }, /kind/);
    const ownerAsJev = rows.find((r) => r.jev_model === 'none')!;
    rejects(C.DecisionSchema, { ...clone(ownerAsJev), jev_model: 'jev-1' }, /none/);
  });

  test('events, exit codes, request ids', () => {
    const row = (fixture('events.json') as Array<Record<string, unknown>>)[0]!;
    rejects(C.EventRowSchema, { ...row, kind: 'shout' }, /kind/);
    rejects(C.EventRowSchema, { ...row, payload: 'not json' }, /not JSON/);
    rejects(C.EventRowSchema, { ...row, at: '2026-11-01 12:00' }, /ISO/);
    rejects(C.EventSchema, { ...row, kind: 'usage', payload: JSON.stringify({ inputTokens: -1 }) }, /inputTokens/);
    rejects(C.ExitCodeSchema, 5, /./);
    rejects(C.CliErrorSchema, { error: 'fine', exitCode: 0 }, /exitCode/);
    rejects(C.CliErrorSchema, { error: '', exitCode: 2 }, /error/);
    rejects(C.AutoRequestIdSchema, `auto:${'A'.repeat(64)}`, /sha256/);
    rejects(C.AutoRequestIdSchema, 'auto:abc', /sha256/);
    assert.equal(C.taskRequestIdForm('auto:abc'), 'given');
    assert.equal(C.taskRequestIdForm('schedule:C3M8K2Q:2026-11-03'), 'given');
  });

  test('wake lines', () => {
    const lines = fixture('wake-lines.json') as string[];
    rejects(C.WakeLineSchema, `${lines[0]}\n${lines[1]}`, /not a wake line/);
    rejects(C.WakeLineSchema, lines[0]!.replace('. Run: jv report', '. Read: jv report'), /not a wake line/);
    rejects(C.WakeLineSchema, lines[0]!.replace('jv report R', 'jv tail R'), /not a wake line/);
    rejects(C.WakeLineSchema, `${lines[5]!}x`, /not a wake line/);
    rejects(C.WakeLineSchema, ` ${lines[0]}`, /not a wake line/);
    rejects(C.WakeLineSchema, 'Task done.', /not a wake line/);
    assert.equal(C.parseWakeLine(lines[5]!.slice(0, 400)), undefined, 'a cut line is exactly 500 characters');
  });

  test('providers.json, status and task show', () => {
    const providers = fixture('providers.json') as { providers: Array<Record<string, unknown>> };
    const typo = clone(providers);
    typo.providers[0]!.ceilingPCT = 80;
    rejects(C.ProvidersFileSchema, typo, /ceilingPCT|Unrecognized/);
    const status = fixture('status.json') as { tasks: Array<Record<string, unknown>> };
    rejects(C.StatusSchema, { ...clone(status), extra: {} }, /extra|Unrecognized/);
    const wrongState = clone(status);
    wrongState.tasks[0]!.state = 'sleeping';
    rejects(C.StatusSchema, wrongState, /state/);
    const show = fixture('task-show.json') as Record<string, unknown>;
    rejects(C.TaskShowSchema, { ...clone(show), steps: undefined }, /steps/);
    rejects(C.TaskShowSchema, { ...clone(show), id: 'task-1' }, /id/);
  });
});

// ---- what the lifted code produces ----------------------------------------------------------------------------

describe('the objects the lifted code produces parse', () => {
  test('placement: the state, the Jev decision row with override and outcome, the owner placement', () => {
    const ctx = R.placementContext({ store, taskId: taskA.id, stepId: stepA.id, keyReady: () => true });
    accepts(C.PlacementStateSchema, ctx.state);
    const jevRow = store.requireDecision(placed.decisionId);
    accepts(C.DecisionSchema, jevRow);
    accepts(C.PlacementStateSchema, JSON.parse(jevRow.state_json));
    assert.ok(kept.overridden && outcome);
    accepts(C.DecisionSchema, kept.overridden);
    accepts(C.DecisionSchema, outcome);
    assert.notEqual(outcome.override_json, null);
    assert.notEqual(outcome.outcome_json, null);
    assert.ok(ownerUndo.decision);
    accepts(C.DecisionSchema, ownerUndo.decision);
  });

  test('workflow questions: the decision row and its state', () => {
    assert.ok(workflow.decision);
    accepts(C.DecisionSchema, workflow.decision);
    accepts(C.WorkflowStateSchema, JSON.parse(workflow.decision.state_json));
    assert.equal(workflow.skip.length, 1);
  });

  test('a report: the row, the view, and the report event', () => {
    assert.ok(reported.outcome === 'recorded');
    accepts(C.ReportRowSchema, reported.row);
    accepts(C.ReportViewSchema, reportView(reported.row));
    for (const event of store.listEvents(runA.id)) accepts(C.EventSchema, event);
    for (const event of liveEvents) accepts(C.EventSchema, event);
    assert.equal((JSON.parse(liveEvents[1]!.payload) as { truncated?: boolean }).truncated, true);
  });

  test('jv status --json and jv task show --json of this store', () => {
    const view = statusView(store, { markLost: false });
    accepts(C.StatusSchema, view);
    assert.ok(view.tasks.some((t) => t.id === taskA.id && t.question === 'Which empty state?'));
    const shown = taskView(store, store.requireTask(taskA.id));
    accepts(C.TaskShowSchema, shown);
    accepts(C.TaskShowSchema, taskView(store, store.requireTask(taskB.id)));
    // meta only on the message that has meta_json, as the action object it holds.
    assert.deepEqual(shown.messages.find((m) => m.id === actionMessage.id)?.meta, uiAction);
    assert.ok(shown.messages.filter((m) => m.id !== actionMessage.id).every((m) => !('meta' in m)));
    rejects(C.TaskShowSchema, { ...clone(shown), messages: shown.messages.map((m) => ({ ...m, meta: 'text' })) }, /meta/);
  });

  test('request ids: the auto form, the coordinator conversation, and the prefix', () => {
    assert.equal(C.AUTO_REQUEST_PREFIX, AUTO_REQUEST_PREFIX);
    const id = autoRequestId({ projectId: project.id, kind: 'single', duty: 'investigate', title: 'T', text: 'x', parent: null, after: null, visible: false });
    accepts(C.AutoRequestIdSchema, id);
    assert.equal(C.taskRequestIdForm(id), 'auto');
    assert.equal(C.taskRequestIdForm(store.coordinatorTask(project.id).request_id), 'coordinatorConversation');
    assert.match(runA.request_id, C.SESSION_REQUEST_ID_FORMS.run);
  });

  test('wake lines: advance, merged, cut, and the limit', () => {
    assert.equal(C.WAKE_LINE_MAX_CHARS, W.WAKE_LINE_MAX);
    const line = W.wakeLine(stepWakeLine(taskA, 'investigate', 'needs-decision', `jv report ${runA.id}`));
    accepts(C.WakeLineSchema, line);
    accepts(C.WakeLineSchema, W.wakeLine(stepWakeLine({ id: taskA.id, title: 'A title (with parentheses): and a colon' }, undefined, 'failed', `jv task show ${taskA.id}`)));
    accepts(C.WakeLineSchema, W.mergedLine([line, line]));
    const long = W.wakeLine(`[jv] ${taskA.id} (Long) landing: ${'checks failed '.repeat(60)}. Run: jv task show ${taskA.id}`);
    assert.equal([...long].length, 500);
    assert.deepEqual(C.parseWakeLine(long), { form: 'cut', task: taskA.id });
  });

  test("a JvError's --json form", () => {
    const e = notFound('no task TZZZZZZ');
    accepts(C.CliErrorSchema, { error: e.message, exitCode: e.exitCode });
    accepts(C.JvExitCodeSchema, new JvError('refused').exitCode);
  });
});

// ---- the public index -------------------------------------------------------------------------------------------

describe('src/index.ts', () => {
  test('exports the API the brief names', () => {
    for (const name of [
      'openStore', 'Store', 'createTask', 'messageTask', 'answerTask', 'stopTask', 'resumeTask', 'overrideTask', 'override',
      'taskView', 'startStep', 'afterRun', 'landTask', 'land', 'placeStep', 'ownerPlacement', 'createRun', 'spawnRun',
      'stopRun', 'markLost', 'executeRun', 'loadRuntime', 'tailEvents', 'recordEvent', 'statusView', 'runChecks', 'doctor',
      'buildSystemAppend', 'assemblePrompt', 'readLimits', 'slotUse', 'slotRefusal', 'WAITING_FOR_A_SLOT', 'bootstrap',
      'JvError', 'EXIT', 'notifyCoordinator', 'ReportSchema', 'DecisionSchema', 'StatusSchema', 'TaskShowSchema',
    ]) {
      assert.ok(name in core, `jevellan-core exports ${name}`);
    }
    assert.equal(core.land, core.landTask);
    assert.equal(core.override, core.overrideTask);
    assert.equal(core.doctor, core.runChecks);
    assert.equal(core.assemblePrompt, core.buildSystemAppend);
    assert.equal(typeof core.advance.afterRun, 'function');
    assert.equal(typeof core.coordinator.startCoordinator, 'function');
    assert.equal(typeof core.providers.loadProviders, 'function');
    assert.equal(typeof core.wake.mergedLine, 'function');
    assert.equal(typeof core.workflows.resolveWorkflow, 'function');
    assert.equal(core.EXIT, EXIT);
    assert.equal(core.ReportFieldsSchema, C.ReportFieldsSchema);
  });
});

// ---- the written schemas against the lifted types (checked by the compiler) ----------------------------------------

type Keys<T> = T extends unknown ? keyof T : never;
type SameKeys<A, B> = [Exclude<Keys<A>, Keys<B>>, Exclude<Keys<B>, Keys<A>>] extends [never, never] ? true : false;
function assignable<T>(_value: T): void {}
function sameKeys<_T extends true>(): void {}

test('every written schema produces the lifted type it describes, with the same keys', () => {
  // A parsed value is usable wherever the lifted code takes its type (the compiler checks these lines).
  const types = (): void => {
    assignable<PlacementState>(null as unknown as z.output<typeof C.PlacementStateSchema>);
    assignable<WorkflowState>(null as unknown as z.output<typeof C.WorkflowStateSchema>);
    assignable<PlacementChosen>(null as unknown as z.output<typeof C.PlacementChosenSchema>);
    assignable<StatusView>(null as unknown as z.output<typeof C.StatusSchema>);
    assignable<TaskView>(null as unknown as z.output<typeof C.TaskShowSchema>);
    assignable<ReportView>(null as unknown as z.output<typeof C.ReportViewSchema>);
    assignable<DecisionRow>(null as unknown as z.output<typeof C.DecisionRowSchema>);
    assignable<EventRow>(null as unknown as z.output<typeof C.EventRowSchema>);
    assignable<ReportRow>(null as unknown as z.output<typeof C.ReportRowSchema>);
    sameKeys<SameKeys<PlacementState, z.output<typeof C.PlacementStateSchema>>>();
    sameKeys<SameKeys<PlacementState['step'], z.output<typeof C.PlacementStateSchema>['step']>>();
    sameKeys<SameKeys<PlacementChosen, z.output<typeof C.PlacementChosenSchema>>>();
    sameKeys<SameKeys<StatusView, z.output<typeof C.StatusSchema>>>();
    sameKeys<SameKeys<StatusView['tasks'][number], z.output<typeof C.TaskStatusSchema>>>();
    sameKeys<SameKeys<StatusView['sessions'][number], z.output<typeof C.SessionStatusSchema>>>();
    sameKeys<SameKeys<TaskView, z.output<typeof C.TaskShowSchema>>>();
    sameKeys<SameKeys<TaskView['steps'][number], z.output<typeof C.StepViewSchema>>>();
    sameKeys<SameKeys<TaskView['steps'][number]['runs'][number], z.output<typeof C.RunViewSchema>>>();
    sameKeys<SameKeys<ReportView, z.output<typeof C.ReportViewSchema>>>();
    sameKeys<SameKeys<DecisionRow, z.output<typeof C.DecisionRowSchema>>>();
    sameKeys<SameKeys<EventRow, z.output<typeof C.EventRowSchema>>>();
    sameKeys<SameKeys<ReportRow, z.output<typeof C.ReportRowSchema>>>();
  };
  assert.equal(typeof types, 'function');
});
