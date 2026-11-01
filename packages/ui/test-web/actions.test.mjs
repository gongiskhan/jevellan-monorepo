/* global document, localStorage, getComputedStyle */
// What the web app does, checked in headless Chromium against the mock UI server (brief section 7): the sign-in
// error, the options as buttons posting jv task answer, the A2UI Button posting the renderer's action to ui-action
// and dimming the surface, a version "1.0" surface shown as unsupported, the Changes modal with committed and
// uncommitted files, the sidebar collapse that survives a reload, Stop only with a live session, Override, the
// landing ask, the coordinator composer and Start, the cron helper, memory archive, notes, the live stream, and the
// read-only mode that offers no action.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SIZES, launch, signedInContext } from './browser.mjs';
import { startMockServer } from './mock-server.mjs';

const desktop = SIZES[0];
let mock;
let browser;

before(async () => {
  mock = await startMockServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await mock?.close();
});

async function open(path, options = {}) {
  const context = await signedInContext(browser, options.mock ?? mock, options.size ?? desktop, options.scheme ?? 'light');
  const page = await context.newPage();
  await page.goto(`${(options.mock ?? mock).url}${path}`);
  return { context, page };
}

/** The posts the page made to `path` since `from`. */
const posts = (path, from = 0, m = mock) => m.requests.slice(from).filter((r) => r.method === 'POST' && r.path === path);

async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('sign-in', () => {
  test('a wrong password shows "Wrong password." and the right one opens the page asked for', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${mock.url}/memory`);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Wrong password.').waitFor();
    assert.equal(await page.getByRole('alert').textContent(), 'Wrong password.');
    await page.getByLabel('Password').fill(mock.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Memory' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/memory');
    await context.close();
  });
});

describe('task page', () => {
  test('the options of a needs-decision report are buttons that post jv task answer', async () => {
    const { context, page } = await open('/t/TX7ZNQX');
    const from = mock.requests.length;
    await page.getByRole('group', { name: 'Options' }).getByRole('button', { name: /Guided start/ }).click();
    const [post] = await until(() => posts('/api/tasks/TX7ZNQX/answer', from).length && posts('/api/tasks/TX7ZNQX/answer', from));
    assert.deepEqual(post.body, { answer: 'Guided start' });
    await page.getByText('Sent: Guided start').waitFor();
    await context.close();
  });

  test('a free-text answer posts the text', async () => {
    const { context, page } = await open('/t/TX7ZNQX');
    const from = mock.requests.length;
    await page.getByLabel('Answer in your own words').fill('Neither, keep the table');
    await page.getByRole('button', { name: 'Answer', exact: true }).last().click();
    const [post] = await until(() => posts('/api/tasks/TX7ZNQX/answer', from).length && posts('/api/tasks/TX7ZNQX/answer', from));
    assert.deepEqual(post.body, { answer: 'Neither, keep the table' });
    await context.close();
  });

  test('the A2UI Button posts the renderer action with the picked option and the surface is dimmed', async () => {
    const { context, page } = await open('/t/TA2UI01');
    const surface = page.locator('.jv-a2ui');
    await surface.getByRole('button', { name: 'Send' }).waitFor();
    await surface.getByRole('radio', { name: 'Import first' }).check();
    const from = mock.requests.length;
    await surface.getByRole('button', { name: 'Send' }).click();
    const [post] = await until(() => posts('/api/tasks/TA2UI01/ui-action', from).length && posts('/api/tasks/TA2UI01/ui-action', from));
    const action = post.body.action;
    assert.equal(action.name, 'answer');
    assert.equal(action.surfaceId, 'empty-state-choice');
    assert.equal(action.sourceComponentId, 'send');
    assert.equal(typeof action.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(action.timestamp)), 'timestamp is a time');
    assert.deepEqual(action.context, { label: 'Import first' });
    await page.getByText(/^Sent to the step at \d{2}:\d{2}$/).waitFor();
    assert.equal(await surface.getAttribute('class'), 'jv-a2ui sent');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.jv-a2ui')).opacity) < 0.6);
    assert.equal(posts('/api/tasks/TA2UI01/answer', from).length, 0, 'the native answer route is not used');
    await context.close();
  });

  test('the native options render beside the A2UI surface, and the inputs keep their value across a refetch', async () => {
    const { context, page } = await open('/t/TA2UI01');
    const surface = page.locator('.jv-a2ui');
    await surface.getByRole('radio', { name: 'Guided start' }).check();
    await page.getByRole('group', { name: 'Options' }).getByRole('button', { name: /Import first/ }).waitFor();
    const before = mock.requests.filter((r) => r.path === '/api/tasks/TA2UI01').length;
    mock.emitChange();
    await until(() => mock.requests.filter((r) => r.path === '/api/tasks/TA2UI01').length > before);
    await page.waitForTimeout(200);
    assert.ok(await surface.getByRole('radio', { name: 'Guided start' }).isChecked(), 'still picked after the refetch');
    await context.close();
  });

  test('a surface whose action the store already holds shows as sent on load, with the time of the message', async () => {
    const { context, page } = await open('/t/TA2SENT');
    const surface = page.locator('.jv-a2ui');
    await surface.getByRole('button', { name: 'Send' }).waitFor();
    const line = page.getByText(/^Sent to the step at \d{2}:\d{2}$/);
    await line.waitFor();
    const sentAt = mock.data.views.get('TA2SENT').messages[0].createdAt;
    const d = new Date(sentAt);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.equal((await line.textContent()).trim(), `Sent to the step at ${hhmm}`);
    assert.equal(await surface.getAttribute('class'), 'jv-a2ui sent');
    assert.equal(await surface.evaluate((el) => el.inert), true);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.jv-a2ui')).opacity) < 0.6);
    // The picker shows what the action sent (Guided start), not the step's first value (Short message).
    await page.waitForFunction(() => document.querySelector('.jv-a2ui input[value="Guided start"]')?.checked === true);
    assert.equal(await surface.getByRole('radio', { name: 'Short message' }).isChecked(), false);
    const from = mock.requests.length;
    await surface.getByRole('button', { name: 'Send' }).click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    assert.equal(posts('/api/tasks/TA2SENT/ui-action', from).length, 0, 'an inert surface posts nothing');
    await context.close();
  });

  test('a message belongs to the newest surface of that id before it: an earlier surface is sent, a later one is not', async () => {
    const { context, page } = await open('/t/TA2AGAN');
    const earlier = page.getByRole('article', { name: 'Report of RA2AGAN' }).locator('.jv-a2ui');
    const later = page.getByRole('article', { name: 'Report of RA2AGN2' }).locator('.jv-a2ui');
    await later.getByRole('button', { name: 'Send' }).waitFor();
    await earlier.getByRole('button', { name: 'Send' }).waitFor();
    assert.equal(await earlier.getAttribute('class'), 'jv-a2ui sent');
    assert.equal(await later.getAttribute('class'), 'jv-a2ui');
    assert.equal(await page.getByText(/^Sent to the step at \d{2}:\d{2}$/).count(), 1);
    await later.getByRole('radio', { name: 'Guided start' }).check();
    const from = mock.requests.length;
    await later.getByRole('button', { name: 'Send' }).click();
    const [post] = await until(() => posts('/api/tasks/TA2AGAN/ui-action', from).length && posts('/api/tasks/TA2AGAN/ui-action', from));
    assert.deepEqual(post.body.action.context, { label: 'Guided start' });
    await context.close();
  });

  test('the surface of a done task is inert with a line and shows nothing as sent', async () => {
    const { context, page } = await open('/t/TA2DONE');
    const surface = page.locator('.jv-a2ui');
    await surface.getByRole('button', { name: 'Send' }).waitFor();
    await page.getByText('Task done: the surface takes no input.').waitFor();
    assert.equal(await surface.getAttribute('class'), 'jv-a2ui closed');
    assert.equal(await surface.evaluate((el) => el.inert), true);
    assert.equal(await page.getByText(/^Sent to the step at/).count(), 0);
    await context.close();
  });

  test('version "1.0" messages show "UI not rendered: unsupported version" and the rest of the report', async () => {
    const { context, page } = await open('/t/TV10UI1');
    await page.getByText('UI not rendered: unsupported version').waitFor();
    assert.equal(await page.locator('.jv-a2ui').count(), 0);
    await page.getByText('The import preview reads the first 20 rows.').waitFor();
    await page.getByRole('group', { name: 'Options' }).getByRole('button', { name: 'Column B' }).waitFor();
    assert.equal(await page.getByText('Tests failed').count(), 1);
    await context.close();
  });

  test('the Changes modal lists committed and uncommitted files and shows the selected diff', async () => {
    const { context, page } = await open('/t/TA2UI01');
    await page.getByRole('toolbar', { name: 'Task actions' }).getByRole('button', { name: 'Changes' }).click();
    const dialog = page.getByRole('dialog', { name: 'Changes · TA2UI01' });
    const files = dialog.getByRole('list', { name: 'Changed files' }).getByRole('button');
    await files.first().waitFor();
    assert.equal(await files.count(), 4);
    assert.equal(await dialog.locator('.uncommitted-chip').count(), 2);
    assert.match(await files.nth(0).textContent(), /^M\s*src\/pages\/customers\.tsx\s*\+4-1$/);
    assert.match(await files.nth(2).textContent(), /uncommitted/);
    await dialog.getByText('if (rows.length === 0) {').waitFor();
    await files.nth(2).click();
    await dialog.getByText("import { CustomersEmpty } from '../src/pages/customers-empty';", { exact: false }).waitFor();
    await dialog.getByText('test/customers-empty.test.tsx (uncommitted)').waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await context.close();
  });

  test('Stop shows only with a live session and posts discard from its checkbox', async () => {
    const waiting = await open('/t/TA2UI01');
    await waiting.page.getByRole('toolbar', { name: 'Task actions' }).waitFor();
    assert.equal(await waiting.page.getByRole('button', { name: 'Stop' }).count(), 0);
    await waiting.context.close();
    const { context, page } = await open('/t/T7FDA1R');
    await page.getByRole('toolbar', { name: 'Task actions' }).getByRole('button', { name: 'Stop' }).click();
    await page.getByLabel('Discard the task (the worktree is kept)').check();
    const from = mock.requests.length;
    await page.getByRole('button', { name: 'Stop and discard' }).click();
    const [post] = await until(() => posts('/api/tasks/T7FDA1R/stop', from).length && posts('/api/tasks/T7FDA1R/stop', from));
    assert.deepEqual(post.body, { discard: true });
    await context.close();
  });

  test('Override offers the providers.json menu and posts the model, effort, provider and mode the owner picked', async () => {
    const { context, page } = await open('/t/T7FDA1R');
    await page.getByRole('toolbar', { name: 'Task actions' }).getByRole('button', { name: 'Override' }).click();
    const dialog = page.getByRole('dialog', { name: 'Override T7FDA1R' });
    await dialog.getByLabel('Keep: record the override; the running session continues').check();
    // The menu's models are suggested; a model the menu knows narrows the efforts and providers to its own.
    await until(async () => (await dialog.locator('#override-models option').evaluateAll((os) => os.map((o) => o.getAttribute('value')))).includes('qwen3-coder'));
    await dialog.getByLabel('Model').fill('qwen3-coder');
    await until(async () => (await dialog.getByLabel('Provider').locator('option').allTextContents()).join('|') === 'Any that serves the model|local');
    assert.deepEqual(await dialog.getByLabel('Effort').locator('option').allTextContents(), ['As the policy says', 'default']);
    await dialog.getByLabel('Model').fill('claude-opus-5-5');
    await dialog.getByLabel('Effort').selectOption('xhigh');
    await dialog.getByLabel('Provider').selectOption('claude-second');
    const from = mock.requests.length;
    await dialog.getByRole('button', { name: 'Override' }).click();
    const [post] = await until(() => posts('/api/tasks/T7FDA1R/override', from).length && posts('/api/tasks/T7FDA1R/override', from));
    assert.deepEqual(post.body, { model: 'claude-opus-5-5', mode: 'keep', effort: 'xhigh', provider: 'claude-second' });
    await context.close();
  });

  test('Attach shows the jv attach command of the session with a copy button', async () => {
    const { context, page } = await open('/t/T7FDA1R');
    await page.getByRole('toolbar', { name: 'Task actions' }).getByRole('button', { name: 'Attach' }).click();
    const dialog = page.getByRole('dialog', { name: 'Attach to T7FDA1R' });
    await dialog.getByText('jv attach R9Q1XXA').waitFor();
    await dialog.getByRole('button', { name: 'Copy jv attach R9Q1XXA' }).waitFor();
    await context.close();
  });

  test('a landing that Jev routed to the owner offers Land now and Leave it', async () => {
    const { context, page } = await open('/t/TLAND01');
    const from = mock.requests.length;
    await page.getByRole('button', { name: 'Land now' }).click();
    const [post] = await until(() => posts('/api/tasks/TLAND01/answer', from).length && posts('/api/tasks/TLAND01/answer', from));
    assert.deepEqual(post.body, { answer: 'Land now' });
    await page.getByRole('button', { name: 'Leave it' }).waitFor();
    await context.close();
  });

  test('the task text folds after 12 lines', async () => {
    const { context, page } = await open('/t/TA2UI01');
    const body = page.locator('.task-text-body');
    await page.getByRole('button', { name: 'Show all' }).waitFor();
    const folded = await body.evaluate((el) => el.clientHeight);
    await page.getByRole('button', { name: 'Show all' }).click();
    const open_ = await body.evaluate((el) => el.clientHeight);
    assert.ok(open_ > folded + 50, `unfolded ${open_} > folded ${folded}`);
    await context.close();
  });
});

describe('shell', () => {
  test('the sidebar collapse hides it with visibility and width, not display, and survives a reload', async () => {
    const { context, page } = await open('/');
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    const shell = page.locator('.app-shell');
    assert.match(await shell.getAttribute('class'), /sidebar-collapsed/);
    const style = await page.locator('aside.sidebar').evaluate((el) => {
      const s = getComputedStyle(el);
      return { visibility: s.visibility, width: el.getBoundingClientRect().width, display: s.display };
    });
    assert.deepEqual(style, { visibility: 'hidden', width: 0, display: 'flex' });
    assert.equal(await page.evaluate(() => localStorage.getItem('jv.sidebar.collapsed')), '1');
    await page.reload();
    await page.getByText('bot alive').waitFor();
    assert.match(await page.locator('.app-shell').getAttribute('class'), /sidebar-collapsed/);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    assert.doesNotMatch(await page.locator('.app-shell').getAttribute('class'), /sidebar-collapsed/);
    assert.equal(await page.evaluate(() => localStorage.getItem('jv.sidebar.collapsed')), '0');
    await context.close();
  });

  test('the theme switch sets the theme and keeps it', async () => {
    const { context, page } = await open('/');
    await page.getByRole('button', { name: 'Dark theme' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.reload();
    await page.getByText('bot alive').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(background, 'rgb(7, 17, 28)');
    await context.close();
  });

  test('a change event from the live stream refetches what the page shows', async () => {
    const { context, page } = await open('/');
    await page.getByText('bot alive').waitFor();
    await page.waitForTimeout(300);
    const count = () => mock.requests.filter((r) => r.path === '/api/status').length;
    const before = count();
    mock.emitChange();
    await until(() => count() > before);
    await context.close();
  });

  test('the phone menu opens the navigation drawer', async () => {
    const { context, page } = await open('/', { size: SIZES[1] });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Schedules' }).click();
    await page.getByRole('heading', { name: 'Schedules' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/schedules');
    await context.close();
  });
});

describe('project page', () => {
  test('the composer posts the message to the running coordinator', async () => {
    const { context, page } = await open('/p/shop');
    await page.getByText('The plan step of T7FDA1R is done; implementation started.').waitFor();
    await page.getByText('1m 1s').waitFor();
    const from = mock.requests.length;
    await page.getByLabel('Message the coordinator').fill('status');
    await page.getByLabel('Message the coordinator').press('Enter');
    const [post] = await until(() => posts('/api/projects/shop/coordinator/message', from).length && posts('/api/projects/shop/coordinator/message', from));
    assert.deepEqual(post.body, { text: 'status' });
    await context.close();
  });

  test('New task creates a task from the UI and opens it', async () => {
    const { context, page } = await open('/p/shop');
    await page.getByRole('button', { name: 'New task' }).click();
    const dialog = page.getByRole('dialog', { name: 'New task in shop' });
    await dialog.getByLabel('Duty').selectOption('answer');
    await dialog.getByLabel('Title').fill('Which colour?');
    await dialog.getByLabel('Text').fill('Ask the owner which colour: Blue or Green.');
    const from = mock.requests.length;
    await dialog.getByRole('button', { name: 'Create task' }).click();
    const [post] = await until(() => posts('/api/tasks', from).length && posts('/api/tasks', from));
    assert.deepEqual(post.body, { project: 'shop', kind: 'single', duty: 'answer', title: 'Which colour?', text: 'Ask the owner which colour: Blue or Green.', visible: false });
    await page.waitForURL(/\/t\/TNEW001$/);
    await context.close();
  });

  test('a stopped coordinator is replaced by Start coordinator', async () => {
    const { context, page } = await open('/p/docs-site');
    assert.equal(await page.getByLabel('Message the coordinator').count(), 0);
    const from = mock.requests.length;
    await page.getByRole('button', { name: 'Start coordinator' }).click();
    await until(() => posts('/api/projects/docs-site/coordinator/start', from).length);
    await context.close();
  });

  test('below 1100 px the columns are the tabs Chat and Work', async () => {
    const { context, page } = await open('/p/shop', { size: { width: 1024, height: 768 } });
    const tabs = page.getByRole('tablist', { name: 'Project sections' });
    await tabs.waitFor();
    await tabs.getByRole('tab', { name: 'Work' }).click();
    await page.getByRole('heading', { name: 'notes.md' }).waitFor();
    assert.equal(await page.getByLabel('Message the coordinator').isVisible(), false);
    await context.close();
    const wide = await open('/p/shop', { size: { width: 1280, height: 800 } });
    await wide.page.getByLabel('Message the coordinator').waitFor();
    assert.equal(await wide.page.getByRole('tablist', { name: 'Project sections' }).isVisible(), false);
    assert.ok(await wide.page.getByRole('heading', { name: 'notes.md' }).isVisible());
    await wide.context.close();
  });

  test('notes.md is read-only with Edit saving through the notes route', async () => {
    const { context, page } = await open('/p/shop');
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'notes.md' }).fill('# Notes\n\n- Ship the short message.\n');
    const from = mock.requests.length;
    await page.getByRole('button', { name: 'Save' }).click();
    const [post] = await until(() => posts('/api/projects/shop/notes', from).length && posts('/api/projects/shop/notes', from));
    assert.deepEqual(post.body, { text: '# Notes\n\n- Ship the short message.\n' });
    await context.close();
  });
});

describe('list pages', () => {
  test('the cron helper prints the next three runs as the owner types, and refuses a bad cron', async () => {
    const { context, page } = await open('/schedules');
    await page.getByRole('button', { name: 'Add' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a schedule' });
    const cron = dialog.getByLabel('Cron (minute hour day month weekday)');
    await cron.fill('15 4 * * 1');
    await dialog.locator('.cron-preview li').nth(2).waitFor();
    assert.equal(await dialog.locator('.cron-preview li').count(), 3);
    for (const text of await dialog.locator('.cron-preview li').allTextContents()) assert.match(text, /04:15$/);
    await cron.fill('61 * * * *');
    await dialog.getByText('minute: 61 is outside 0-59').waitFor();
    assert.ok(await dialog.getByRole('button', { name: 'Add schedule' }).isDisabled());
    await cron.fill('*/30 * * * *');
    await dialog.getByLabel('Name').fill('Half-hourly check');
    await dialog.getByLabel('Text').fill('Run the tests.');
    const from = mock.requests.length;
    await dialog.getByRole('button', { name: 'Add schedule' }).click();
    const [post] = await until(() => posts('/api/schedules', from).length && posts('/api/schedules', from));
    assert.equal(post.body.cron, '*/30 * * * *');
    assert.equal(post.body.kind, 'task');
    assert.deepEqual(post.body.task, { kind: 'single', duty: 'verify', title: 'Half-hourly check', text: 'Run the tests.', visible: false });
    await context.close();
  });

  test('Archive asks for a reason and posts it', async () => {
    const { context, page } = await open('/memory');
    await page.locator('.memory-row', { hasText: 'M4V8C2D' }).getByRole('button', { name: 'Archive' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive M4V8C2D' });
    await dialog.getByLabel('Reason').fill('The tests run without npm ci now');
    const from = mock.requests.length;
    await dialog.getByRole('button', { name: 'Archive' }).click();
    const [post] = await until(() => posts('/api/memory/M4V8C2D/archive', from).length && posts('/api/memory/M4V8C2D/archive', from));
    assert.deepEqual(post.body, { reason: 'The tests run without npm ci now' });
    await context.close();
  });

  test('Plan now queues a plan job for the project', async () => {
    const { context, page } = await open('/goals');
    const from = mock.requests.length;
    await page.locator('.group-card', { hasText: 'shop' }).getByRole('button', { name: 'Plan now' }).click();
    const [post] = await until(() => posts('/api/jobs', from).length && posts('/api/jobs', from));
    assert.deepEqual(post.body, { project: 'shop', kind: 'plan' });
    await context.close();
  });

  test('Run now, Pause and Resume of a schedule post their routes', async () => {
    const { context, page } = await open('/schedules');
    const from = mock.requests.length;
    await page.locator('.schedule-row', { hasText: 'Nightly tests' }).getByRole('button', { name: 'Run now' }).click();
    await until(() => posts('/api/schedules/C3M8K2Q/run', from).length);
    await page.locator('.schedule-row', { hasText: 'Plan' }).getByRole('button', { name: 'Resume' }).click();
    await until(() => posts('/api/schedules/C7PLAN1/resume', from).length);
    await context.close();
  });
});

describe('read-only mode', () => {
  test('no action is offered on any page', async () => {
    const readonly = await startMockServer({ readonly: true });
    try {
      for (const path of ['/', '/t/TX7ZNQX', '/t/TA2UI01', '/p/shop', '/memory', '/schedules', '/goals', '/jobs']) {
        const { context, page } = await open(path, { mock: readonly });
        await page.locator('.readonly-chip').waitFor();
        await page.waitForTimeout(300);
        // Buttons that change nothing (folding, copying, tabs, switches, paging) are fine; the inert A2UI surface too.
        const actions = await page.evaluate(() =>
          [...document.querySelectorAll('main button')]
            .filter((b) => !b.closest('[inert]') && !b.matches('.copy-button, .switch, .pw-tab'))
            .map((b) => (b.textContent ?? '').trim()),
        );
        const allowed = actions.filter((t) => !/^(Show all|Show less|Run checks|Previous|Next|Refresh)$/.test(t));
        assert.deepEqual(allowed, [], `${path} offers ${allowed.join(', ')}`);
        assert.equal(await page.getByLabel('Message the coordinator').count(), 0);
        await context.close();
      }
      assert.equal(readonly.requests.filter((r) => r.method === 'POST').length, 0);
    } finally {
      await readonly.close();
    }
  });
});
