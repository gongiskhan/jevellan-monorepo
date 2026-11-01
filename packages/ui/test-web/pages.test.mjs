/* global document */
// Every page of the web app (brief section 7) renders against the mock UI server at 1280 by 800 and 390 by 844, in
// the light and the dark scheme, with no horizontal scroll and no script error; each one is saved to
// test-web/shots/<page>-<size>-<scheme>.png for a look. Run with `npm run test:web` (it builds dist/web first).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SCHEMES, SIZES, horizontalOverflow, launch, overflowingElements, shot, signedInContext } from './browser.mjs';
import { startMockServer } from './mock-server.mjs';

/** Each page: its path, a text it must show, and what to do before the screenshot. */
const PAGES = [
  { name: 'projects', path: '/', expect: 'bot alive' },
  { name: 'project', path: '/p/shop', expect: 'coordinator running' },
  { name: 'project-stopped', path: '/p/docs-site', expect: 'Start coordinator' },
  { name: 'task-a2ui', path: '/t/TA2UI01', expect: 'From the step', ready: '.jv-a2ui a2ui-basic-button' },
  { name: 'task-v10', path: '/t/TV10UI1', expect: 'UI not rendered: unsupported version' },
  { name: 'task-running', path: '/t/T7FDA1R', expect: 'Steps' },
  { name: 'task-landing', path: '/t/TLAND01', expect: 'Land now' },
  { name: 'task-fixture', path: '/t/TX7ZNQX', expect: 'Which empty state should the customers page show?' },
  { name: 'session', path: '/s/RJ79PMG', expect: 'Session RJ79PMG' },
  { name: 'decisions', path: '/decisions', expect: 'DPQ5R7T' },
  { name: 'usage', path: '/usage', expect: 'claude-main' },
  { name: 'memory', path: '/memory', expect: 'M4V8C2D' },
  { name: 'schedules', path: '/schedules', expect: 'Nightly tests' },
  { name: 'goals', path: '/goals', expect: 'Plan now' },
  { name: 'jobs', path: '/jobs', expect: 'J7Q2W9X' },
  { name: 'bot', path: '/bot', expect: 'bot.log' },
  { name: 'doctor', path: '/doctor', expect: 'ports:ui', act: (page) => page.getByRole('button', { name: 'Run checks' }).click() },
];

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

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    describe(`${size.name} ${size.width}x${size.height} ${scheme}`, () => {
      test('the sign-in page', async () => {
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme });
        const page = await context.newPage();
        await page.goto(`${mock.url}/t/TA2UI01`);
        await page.getByRole('button', { name: 'Sign in' }).waitFor();
        assert.match(page.url(), /\/login\?next=%2Ft%2FTA2UI01$/);
        assert.equal(await page.locator('h1').textContent(), 'Jevellan');
        assert.ok((await horizontalOverflow(page)) <= 0, 'no horizontal scroll');
        await shot(page, `login-${size.name}-${scheme}`);
        await context.close();
      });

      test('the Changes modal', async () => {
        const context = await signedInContext(browser, mock, size, scheme);
        const page = await context.newPage();
        await page.goto(`${mock.url}/t/TA2UI01`);
        await page.getByRole('toolbar', { name: 'Task actions' }).getByRole('button', { name: 'Changes' }).click();
        const dialog = page.getByRole('dialog', { name: 'Changes · TA2UI01' });
        await dialog.getByText('if (rows.length === 0) {').waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.ok((await horizontalOverflow(page)) <= 0, 'no horizontal scroll');
        const box = await dialog.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= size.width, 'the dialog fits the window');
        await shot(page, `changes-${size.name}-${scheme}`);
        await context.close();
      });

      for (const spec of PAGES) {
        test(spec.name, async () => {
          const context = await signedInContext(browser, mock, size, scheme);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('console', (message) => {
            if (message.type() === 'error') errors.push(message.text());
          });
          await page.goto(`${mock.url}${spec.path}`);
          if (spec.act) await spec.act(page);
          await page.getByText(spec.expect, { exact: false }).first().waitFor({ timeout: 10_000 });
          if (spec.ready) await page.locator(spec.ready).first().waitFor({ timeout: 10_000 });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(150);
          const overflow = await horizontalOverflow(page);
          assert.ok(overflow <= 0, `${spec.path} scrolls sideways by ${overflow}px: ${(await overflowingElements(page)).join(', ')}`);
          await shot(page, `${spec.name}-${size.name}-${scheme}`);
          assert.deepEqual(errors, [], `script errors on ${spec.path}`);
          await context.close();
        });
      }
    });
  }
}
