// M8 A2UI (brief section 14): a report fixture, and then a real `single` task whose step attaches a surface with a
// ChoicePicker of three options and a Button named answer, render in the task page under "From the step"; pressing
// the button posts the renderer's action to POST /api/tasks/:id/ui-action, a messages row with meta_json appears,
// and the step receives it as "From the owner:" on its next turn; findings record whether `version: "1.0"` messages
// render with @a2ui 0.14.0. Real providers and Jev in a temporary JV_HOME, on the sandbox.
//
// Part one, the report fixture: a real investigate task whose step is told to ask a question with three options and
// wait. Once the task waits on the owner, the journey writes the fixture's `ui` into that report's ui_json (one
// UPDATE on the store, as packages/ui/test fixtures write rows): a v0.9 surface (createSurface, updateComponents with
// a ChoicePicker bound to /choice and a Button named answer whose context.label is /choice/0, updateDataModel) plus one
// `version: "1.0"` createSurface for a second surface. The page must render the v0.9 surface, show "UI not rendered:
// unsupported version" for the 1.0 message and the rest of the report as usual. Picking an option and pressing the
// button must post the action, write the message row with the raw action in meta_json, dim the surface with "Sent to
// the step at HH:MM", and resume the waiting step: the next turn's `message` event (the prompt jv run builds from
// the task's undelivered messages, prompt.ts resumeMessage) reads "From the owner: <label>", and the message is
// marked delivered to that run when the turn ends, the same path a `jv task message` takes. After a reload the
// surface must still show as sent, at the message's time and with the sent option picked (task show's messages[].meta).
//
// Part two, the real step: an investigate task whose text gives the exact `ui` JSON and asks the step to call
// jv_report with status needs-decision, a question, the three options and that `ui`. The page renders the step's own
// surface; picking and pressing resumes the step, whose final report must name the picked option.
//
// Both tasks are read-only investigate steps (no commit, nothing to land), so they run on the main sandbox; the
// worktrees they get are removed at the end. Every screenshot goes to acceptance/results/m08-shots/ (gitignored); two
// are copied to acceptance/shots/.
//
// Usage: node acceptance/m08-a2ui.mjs [--keep]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m08.json.

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  check,
  cleanup,
  finish,
  hasHorizontalScroll,
  jv,
  jvJson,
  log,
  note,
  parseFlags,
  query,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  RESULTS_DIR,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  SHOTS_DIR,
  startUi,
  stopChild,
  storeFile,
  uiPage,
  waitFor,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm08';
const RUN_SHOTS = join(RESULTS_DIR, 'm08-shots');
const CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';
const UNSUPPORTED = 'UI not rendered: unsupported version';
const SENT = /^Sent to the step at \d{2}:\d{2}$/;
const STEP_STATES = ['waiting-owner', 'done', 'failed', 'stopped'];

/** A v0.9 surface: a title, a ChoicePicker of `labels` bound to /choice (first one picked), a Button named answer. */
function surfaceMessages(surfaceId, title, pickerLabel, labels) {
  return [
    { version: 'v0.9', createSurface: { surfaceId, catalogId: CATALOG } },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId,
        components: [
          { id: 'root', component: 'Column', children: ['title', 'picker', 'send'] },
          { id: 'title', component: 'Text', text: title, variant: 'h3' },
          {
            id: 'picker',
            component: 'ChoicePicker',
            label: pickerLabel,
            variant: 'mutuallyExclusive',
            options: labels.map((label) => ({ label, value: label })),
            value: { path: '/choice' },
          },
          { id: 'send-label', component: 'Text', text: 'Send' },
          { id: 'send', component: 'Button', child: 'send-label', variant: 'primary', action: { event: { name: 'answer', context: { label: { path: '/choice/0' } } } } },
        ],
      },
    },
    { version: 'v0.9', updateDataModel: { surfaceId, path: '/choice', value: [labels[0]] } },
  ];
}

// Part one: the fixture. The step asks the question; the journey adds the surface and the 1.0 message.
const FRUITS = ['Apple', 'Pear', 'Plum'];
const FRUIT_PICK = 'Pear';
const FIXTURE_UI = [
  ...surfaceMessages('fruit-choice', 'Pick the fruit for the fixture', 'Fruit', FRUITS),
  { version: '1.0', createSurface: { surfaceId: 'fruit-preview', catalogId: CATALOG } },
];
const FIXTURE_TEXT = [
  'This task tests how the owner answers a question. Do not read, run or change anything in the repository.',
  '',
  'Turn 1: call jv_report once with status "needs-decision", summary "The fixture needs a fruit.", question "Which fruit should the fixture use?" and options [{"label":"Apple"},{"label":"Pear"},{"label":"Plum"}]. Then stop and wait.',
  '',
  'When the owner answers: call jv_report with status "done" and the summary "The owner picked <the fruit>." with the fruit the owner named.',
].join('\n');

// Part two: the step attaches the surface itself.
const COLOURS = ['Teal', 'Amber', 'Violet'];
const COLOUR_PICK = 'Violet';
const STEP_UI = surfaceMessages('badge-colour', 'Pick the badge colour', 'Colour', COLOURS);
const STEP_TEXT = [
  'This task tests a form the owner answers. Do not read, run or change anything in the repository.',
  '',
  'Turn 1: call jv_report once with these fields and nothing else:',
  '- status: "needs-decision"',
  '- summary: "The sandbox badge needs a colour."',
  '- question: "Which colour should the sandbox badge use?"',
  '- options: [{"label":"Teal"},{"label":"Amber"},{"label":"Violet"}]',
  '- ui: exactly this JSON array, copied as it is (three A2UI v0.9 messages):',
  JSON.stringify(STEP_UI),
  'Then stop and wait.',
  '',
  'When the owner answers: call jv_report with status "done" and the summary "The owner picked <the colour>." with the colour the owner named.',
].join('\n');

function openStoreRw(home) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(storeFile(home));
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function createTask(home, title, text) {
  const r = jvJson(['task', 'create', '--project', SANDBOX_NAME, '--kind', 'single', '--duty', 'investigate', '--title', title, '--text', text], { home, timeoutMs: 180_000 });
  return { id: r.json?.task?.id, r };
}

/** The newest report of a task, with its session's native id. */
function latestReport(home, taskId) {
  return queryOne(
    storeFile(home),
    'SELECT r.id, r.session_id, r.status, r.summary, r.question, r.options_json, r.limitations, r.ui_json, r.created_at, s.native_session_id FROM reports r JOIN sessions s ON s.id = r.session_id WHERE r.task_id = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1',
    taskId,
  );
}

function events(home, sessionId, kind) {
  return query(storeFile(home), 'SELECT seq, kind, payload FROM events WHERE session_id = ? AND kind = ? ORDER BY seq', sessionId, kind).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
}

function sameJson(a, b) {
  const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : Array.isArray(v) ? v.map(norm) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** The task page's "From the step" section (only a report with a `ui` array has one). */
function surfaceSection(page) {
  return page.locator('section.report-ui');
}

/** A viewport screenshot with the surface scrolled into view; a failure is a note, not a crash. */
async function shot(page, name) {
  mkdirSync(RUN_SHOTS, { recursive: true });
  const file = join(RUN_SHOTS, `m08-${name}.png`);
  try {
    await surfaceSection(page).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: file });
    return file;
  } catch (error) {
    note(`screenshot ${name} not taken: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    return undefined;
  }
}

async function asViewport(page, { width, height, colorScheme }) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme });
  await page.waitForTimeout(200);
}

const DESKTOP = { width: 1280, height: 800, colorScheme: 'light' };
const PHONE = { width: 390, height: 844, colorScheme: 'dark' };

/**
 * Picks `pick` in the surface and presses its Send button; returns {request, response} of the ui-action POST and
 * the number of POSTs to the native answer route meanwhile.
 */
async function pressSurface(page, taskId, pick) {
  try {
    return await pressSurfaceOnce(page, taskId, pick);
  } catch (error) {
    return { error: error instanceof Error ? error.message.split('\n')[0] : String(error), answerPosts: [] };
  }
}

async function pressSurfaceOnce(page, taskId, pick) {
  const surface = page.locator('.jv-a2ui');
  await surface.getByRole('radio', { name: pick }).check();
  const answerPosts = [];
  const onRequest = (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === `/api/tasks/${taskId}/answer`) answerPosts.push(req.url());
  };
  page.on('request', onRequest);
  const waitResponse = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/tasks/${taskId}/ui-action`, { timeout: 30_000 });
  await surface.getByRole('button', { name: 'Send' }).click();
  const response = await waitResponse;
  const body = await response.json().catch(() => undefined);
  page.off('request', onRequest);
  return { request: response.request().postDataJSON(), status: response.status(), body, answerPosts };
}

/** Checks the POST and the message row it wrote; returns the message row. */
async function checkPostAndRow(home, taskId, pressed, pick, surfaceId, label) {
  let row;
  await check(`${label}: pressing Send posts the renderer's action to /api/tasks/${taskId}/ui-action`, () => {
    const a = pressed.request?.action ?? {};
    const shape = a.name === 'answer' && a.surfaceId === surfaceId && a.sourceComponentId === 'send' && typeof a.timestamp === 'string' && !Number.isNaN(Date.parse(a.timestamp)) && sameJson(a.context, { label: pick });
    if (pressed.error) return { ok: false, detail: `could not press: ${pressed.error}` };
    return {
      ok: pressed.status === 200 && shape && pressed.body?.kind === 'answer' && pressed.answerPosts.length === 0,
      detail: `HTTP ${pressed.status}, action ${JSON.stringify(a)}; server ${pressed.body?.kind ?? '?'} ${pressed.body?.answer ?? ''}, run ${pressed.body?.session ?? 'none'}; native answer posts ${pressed.answerPosts.length}`,
    };
  });
  await check(`${label}: a messages row with the raw action in meta_json`, () => {
    row = queryOne(storeFile(home), 'SELECT id, direction, text, meta_json, created_at, delivered_at, session_id FROM messages WHERE task_id = ? AND meta_json IS NOT NULL ORDER BY created_at DESC LIMIT 1', taskId);
    if (!row) return { ok: false, detail: 'no message row with meta_json' };
    const meta = JSON.parse(row.meta_json);
    return {
      ok: sameJson(meta, pressed.request?.action) && row.text === pick && row.id === pressed.body?.message?.id,
      detail: `${row.id} ${row.direction} "${row.text}", meta_json ${row.meta_json}`,
    };
  });
  return row;
}

/** The surface shows as sent: the line, the `sent` class, inert, and dimmed once its 0.2 s fade has run. */
async function dimmedState(page) {
  const line = page.getByText(SENT);
  await line.waitFor({ timeout: 15_000 });
  const text = (await line.textContent())?.trim();
  const surface = page.locator('.jv-a2ui');
  await page.waitForFunction(() => Number(globalThis.getComputedStyle(globalThis.document.querySelector('.jv-a2ui')).opacity) < 0.6, null, { timeout: 3000 }).catch(() => undefined);
  const cls = await surface.getAttribute('class');
  const inert = await surface.evaluate((el) => el.inert === true);
  const opacity = Number(await surface.evaluate((el) => globalThis.getComputedStyle(el).opacity));
  return { ok: /\bsent\b/.test(cls ?? '') && inert && opacity < 0.6, text, cls, inert, opacity };
}

async function checkDimmed(page, label) {
  await check(`${label}: the surface is dimmed and inert with "Sent to the step at HH:MM"`, async () => {
    const s = await dimmedState(page);
    const hhmm = new Date().toTimeString().slice(0, 5);
    return { ok: s.ok, detail: `"${s.text}" (now ${hhmm}), class "${s.cls}", inert ${s.inert}, opacity ${s.opacity}` };
  });
}

/** After a reload (and so on any other device) the page still shows the surface as sent, from the store. */
async function checkDimmedAfterReload(page, home, taskId, pick, label) {
  await check(`${label}: after a reload the surface still shows as sent (from the message's meta), at the message's time, with ${pick} picked`, async () => {
    await page.reload();
    await surfaceSection(page).getByRole('heading', { name: 'From the step' }).waitFor({ timeout: 30_000 });
    const s = await dimmedState(page);
    const picked = await page
      .waitForFunction((value) => globalThis.document.querySelector(`.jv-a2ui input[value="${value}"]`)?.checked === true, pick, { timeout: 5000 })
      .then(() => true, () => false);
    const row = queryOne(storeFile(home), 'SELECT created_at FROM messages WHERE task_id = ? AND meta_json IS NOT NULL ORDER BY created_at DESC LIMIT 1', taskId);
    const at = row ? new Date(row.created_at).toTimeString().slice(0, 5) : '?';
    const state = jvJson(['task', 'show', taskId], { home }).json?.state;
    return { ok: s.ok && s.text === `Sent to the step at ${at}` && picked, detail: `task ${state}; "${s.text}" (message at ${at}), class "${s.cls}", inert ${s.inert}, opacity ${s.opacity}, ${pick} ${picked ? 'picked' : 'not picked'}` };
  });
}

/**
 * The step's next turn after the answer: a new run of the same step resuming the same native session, whose
 * `message` event (the prompt of the turn) says "From the owner: <pick>" and lists the message; the message is
 * marked delivered to that run when the turn ends.
 */
async function checkDelivered(home, taskId, message, pressed, firstNative, pick, label) {
  const runId_ = pressed.body?.session;
  await check(`${label}: the step's next turn starts with "From the owner: ${pick}" in its prompt`, async () => {
    if (!runId_ || !message) return { ok: false, detail: `no run in the answer (${JSON.stringify(pressed.body)})` };
    const ev = await waitFor(() => events(home, runId_, 'message').find((e) => (e.payload.messages ?? []).includes(message.id)), { timeoutMs: 3 * 60_000, intervalMs: 2000 });
    const start = events(home, runId_, 'start')[0];
    const run = queryOne(storeFile(home), 'SELECT id, native_session_id, state FROM sessions WHERE id = ?', runId_);
    const text = String(ev?.payload?.text ?? '');
    return {
      ok: !!ev && text.startsWith(`From the owner: ${pick}`) && start?.payload?.resume === true && !!firstNative && run?.native_session_id === firstNative,
      detail: `${runId_} ${run?.state ?? '?'}, resume ${start?.payload?.resume}, native ${run?.native_session_id === firstNative ? 'same' : `${run?.native_session_id} vs ${firstNative}`}; message event: ${JSON.stringify(text.slice(0, 200))}`,
    };
  });
  await check(`${label}: the message is marked delivered to that run when the turn ends`, async () => {
    const row = await waitFor(() => {
      const m = queryOne(storeFile(home), 'SELECT delivered_at, session_id FROM messages WHERE id = ?', message?.id ?? '');
      return m?.delivered_at ? m : undefined;
    }, { timeoutMs: 15 * 60_000, intervalMs: 3000 });
    return { ok: !!row && row.session_id === runId_, detail: row ? `delivered at ${row.delivered_at} to ${row.session_id}` : 'not delivered within 15 min' };
  });
}

async function checkFinalReport(home, taskId, pick, label) {
  await check(`${label}: the step answers it: the task ends done and its final report names ${pick}`, async () => {
    const end = await waitForTask(home, taskId, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 15 * 60_000 });
    const report = latestReport(home, taskId);
    const others = (label.startsWith('fixture') ? FRUITS : COLOURS).filter((x) => x !== pick);
    const names = new RegExp(`\\b${pick}\\b`).test(report?.summary ?? '');
    const namesOther = others.some((o) => new RegExp(`picked ${o}\\b`).test(report?.summary ?? ''));
    return { ok: end?.state === 'done' && report?.status === 'done' && names && !namesOther, detail: `${taskId} ${end?.state}: ${end?.stateReason ?? ''}; report ${report?.status}: ${report?.summary ?? 'none'}` };
  });
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { usage: 'node acceptance/m08-a2ui.mjs [--keep]' });
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M8 A2UI ${id}`);
  let home;
  let ui;
  let browser;
  const tasks = {};
  const consoleErrors = [];
  try {
    home = realJvHome(id).home;

    await check('two read-only single investigate tasks on the sandbox: the fixture one and the one with its own surface', () => {
      const a = createTask(home, 'Ask the owner for a fruit', FIXTURE_TEXT);
      const b = createTask(home, 'Ask the owner for a badge colour with a form', STEP_TEXT);
      tasks.fixture = a.id;
      tasks.step = b.id;
      return { ok: !!a.id && !!b.id, detail: `${a.id ?? a.r.stderr}: ${a.r.json?.start?.state ?? ''}; ${b.id ?? b.r.stderr}: ${b.r.json?.start?.state ?? ''}` };
    });

    // ---- part one: the report fixture -----------------------------------------------------------------------
    let fixtureReport;
    await check('fixture: the step asks its question and the task waits on the owner', async () => {
      const end = await waitForTask(home, tasks.fixture, STEP_STATES, { timeoutMs: 15 * 60_000 });
      fixtureReport = latestReport(home, tasks.fixture);
      const options = JSON.parse(fixtureReport?.options_json ?? '[]').map((o) => o.label);
      return {
        ok: end?.state === 'waiting-owner' && fixtureReport?.status === 'needs-decision' && sameJson(options, FRUITS) && !!fixtureReport?.native_session_id,
        detail: `${tasks.fixture} ${end?.state}: ${end?.stateReason ?? ''}; report ${fixtureReport?.status}: ${fixtureReport?.question ?? ''} [${options.join(', ')}], native ${fixtureReport?.native_session_id ?? 'none'}`,
      };
    });

    await check('fixture: the report gets the fixture ui (a v0.9 surface and one "1.0" message) in ui_json', () => {
      if (!fixtureReport) return { ok: false, detail: 'no report' };
      const db = openStoreRw(home);
      try {
        db.prepare('UPDATE reports SET ui_json = ? WHERE id = ?').run(JSON.stringify(FIXTURE_UI), fixtureReport.id);
      } finally {
        db.close();
      }
      const ui_ = jvJson(['report', fixtureReport.session_id], { home }).json?.ui ?? [];
      return { ok: sameJson(ui_, FIXTURE_UI), detail: `${fixtureReport.id}: ${ui_.length} messages (${ui_.map((m) => `${m.version} ${Object.keys(m).find((k) => k !== 'version')}`).join(', ')}); the step's own ui_json was ${fixtureReport.ui_json === null ? 'empty' : 'set'}` };
    });

    let page;
    const signedIn = await check('jv ui starts on a free port and a headless page signs in at 1280 by 800', async () => {
      ui = await startUi(home);
      const opened = await uiPage(ui, DESKTOP);
      browser = opened.browser;
      page = opened.page;
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e?.message ?? e)));
      return { ok: true, detail: ui.url };
    });
    if (!signedIn) return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });

    await check('fixture: /t/<id> renders the ChoicePicker and the Button under "From the step"', async () => {
      await page.goto(`${ui.url}/t/${tasks.fixture}`);
      const section = surfaceSection(page);
      await section.getByRole('heading', { name: 'From the step' }).waitFor({ timeout: 30_000 });
      const surface = section.locator('.jv-a2ui');
      await surface.getByRole('button', { name: 'Send' }).waitFor({ timeout: 20_000 });
      const radios = await surface.getByRole('radio').evaluateAll((els) => els.map((e) => ({ label: e.closest('label')?.textContent?.trim() ?? '', checked: e.checked })));
      const title = await surface.getByText('Pick the fruit for the fixture').count();
      return {
        ok: sameJson(radios.map((r) => r.label), FRUITS) && radios[0]?.checked === true && title === 1,
        detail: `radios ${radios.map((r) => `${r.label}${r.checked ? ' (picked)' : ''}`).join(', ')}; title ${title ? 'shown' : 'missing'}`,
      };
    });

    await check('fixture: the "1.0" message shows "UI not rendered: unsupported version" and the rest of the report is intact', async () => {
      const section = surfaceSection(page);
      await section.getByText(UNSUPPORTED).waitFor({ timeout: 10_000 });
      const report = page.locator('article.pw-report').filter({ has: section });
      const summary = await report.getByText('The fixture needs a fruit.').count();
      const question = await report.getByText('Which fruit should the fixture use?').count();
      const native = await report.getByRole('group', { name: 'Options' }).getByRole('button').allTextContents();
      const chip = await report.locator('.report-status').textContent();
      const surfaces = await section.locator('.jv-a2ui .a2ui-option-label').count();
      return {
        ok: summary === 1 && question === 1 && sameJson(native.map((t) => t.trim()), FRUITS) && /decision/.test(chip ?? '') && surfaces === 3,
        detail: `notice shown; summary ${summary}, question ${question}, native options [${native.map((t) => t.trim()).join(', ')}], status "${chip?.trim()}", v0.9 picker options ${surfaces}`,
      };
    });

    const shots = {};
    shots.fixtureDesktop = await shot(page, 'fixture-before-1280x800-light');
    await asViewport(page, PHONE);
    shots.fixturePhone = await shot(page, 'fixture-before-390x844-dark');
    await check('fixture: no sideways scroll at 390 by 844 dark', async () => {
      const scrolls = await hasHorizontalScroll(page);
      return { ok: !scrolls, detail: scrolls ? 'the page scrolls sideways' : 'none' };
    });

    const fixturePressed = await pressSurface(page, tasks.fixture, FRUIT_PICK);
    const fixtureMessage = await checkPostAndRow(home, tasks.fixture, fixturePressed, FRUIT_PICK, 'fruit-choice', 'fixture');
    await checkDimmed(page, 'fixture');
    shots.fixturePhoneSent = await shot(page, 'fixture-sent-390x844-dark');
    await asViewport(page, DESKTOP);
    shots.fixtureDesktopSent = await shot(page, 'fixture-sent-1280x800-light');
    await checkDelivered(home, tasks.fixture, fixtureMessage, fixturePressed, fixtureReport?.native_session_id, FRUIT_PICK, 'fixture');
    await checkFinalReport(home, tasks.fixture, FRUIT_PICK, 'fixture');
    await checkDimmedAfterReload(page, home, tasks.fixture, FRUIT_PICK, 'fixture');
    shots.fixtureDesktopReloaded = await shot(page, 'fixture-reloaded-1280x800-light');

    // ---- part two: the real step's own surface --------------------------------------------------------------
    let stepReport;
    await check('real step: it reports needs-decision with its own ui (three v0.9 messages, nothing dropped)', async () => {
      const end = await waitForTask(home, tasks.step, STEP_STATES, { timeoutMs: 15 * 60_000 });
      stepReport = latestReport(home, tasks.step);
      const sent = stepReport?.ui_json ? JSON.parse(stepReport.ui_json) : [];
      const options = JSON.parse(stepReport?.options_json ?? '[]').map((o) => o.label);
      const dropped = /ui dropped/.test(stepReport?.limitations ?? '');
      return {
        ok: end?.state === 'waiting-owner' && stepReport?.status === 'needs-decision' && sent.length === 3 && sent.every((m) => m.version === 'v0.9') && !dropped && sameJson(options, COLOURS),
        detail: `${tasks.step} ${end?.state}: ${end?.stateReason ?? ''}; report ${stepReport?.status}, ui ${sent.length} messages${sameJson(sent, STEP_UI) ? ' (as given)' : ' (differs from the text)'}${dropped ? `, ${stepReport.limitations}` : ''}, options [${options.join(', ')}]`,
      };
    });

    await check('real step: /t/<id> renders the step\'s ChoicePicker and Button', async () => {
      await page.goto(`${ui.url}/t/${tasks.step}`);
      const section = surfaceSection(page);
      await section.getByRole('heading', { name: 'From the step' }).waitFor({ timeout: 30_000 });
      const surface = section.locator('.jv-a2ui');
      await surface.getByRole('button', { name: 'Send' }).waitFor({ timeout: 20_000 });
      const radios = await surface.getByRole('radio').evaluateAll((els) => els.map((e) => e.closest('label')?.textContent?.trim() ?? ''));
      const notices = await section.locator('.ui-notice').allTextContents();
      return { ok: sameJson(radios, COLOURS) && notices.length === 0, detail: `radios ${radios.join(', ')}; notices ${notices.length ? notices.join('; ') : 'none'}` };
    });

    shots.stepDesktop = await shot(page, 'step-before-1280x800-light');
    await asViewport(page, PHONE);
    shots.stepPhone = await shot(page, 'step-before-390x844-dark');
    await asViewport(page, DESKTOP);
    const stepPressed = await pressSurface(page, tasks.step, COLOUR_PICK);
    const stepMessage = await checkPostAndRow(home, tasks.step, stepPressed, COLOUR_PICK, 'badge-colour', 'real step');
    await checkDimmed(page, 'real step');
    shots.stepDesktopSent = await shot(page, 'step-sent-1280x800-light');
    await asViewport(page, PHONE);
    shots.stepPhoneSent = await shot(page, 'step-sent-390x844-dark');
    await checkDelivered(home, tasks.step, stepMessage, stepPressed, stepReport?.native_session_id, COLOUR_PICK, 'real step');
    await checkFinalReport(home, tasks.step, COLOUR_PICK, 'real step');

    await check('no console error on the task pages', () => ({ ok: consoleErrors.length === 0, detail: consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : 'none' }));

    mkdirSync(SHOTS_DIR, { recursive: true });
    if (shots.fixtureDesktop) copyFileSync(shots.fixtureDesktop, join(SHOTS_DIR, 'm08-fixture-1280x800-light.png'));
    if (shots.stepPhoneSent) copyFileSync(shots.stepPhoneSent, join(SHOTS_DIR, 'm08-sent-390x844-dark.png'));
    note(`screenshots in ${RUN_SHOTS}; m08-fixture-1280x800-light.png and m08-sent-390x844-dark.png copied to acceptance/shots/`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (ui) await stopChild(ui.child);
    if (home) {
      for (const t of Object.values(tasks)) {
        if (!t) continue;
        const state = jvJson(['task', 'show', t], { home }).json?.state;
        if (state && !['done', 'stopped', 'failed'].includes(state)) {
          const r = jv(['task', 'stop', t, '--discard'], { home, timeoutMs: 60_000 });
          note(`stopped ${t} (${state}) at the end: exit ${r.code}`);
        }
      }
      note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    }
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: 'real providers in a temporary JV_HOME' });
}

runJourney(JOURNEY, main);
