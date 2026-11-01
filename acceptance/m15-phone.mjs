// M15 Phone (brief section 14): `jv ui --bind 100.108.210.116` (this machine's tailnet address) on a free port; the
// login, project, task and session pages render at 390 by 844 in light and dark with no horizontal scroll;
// screenshots under acceptance/shots/ and copies under ~/.jevellan-build/manager/shots/. The pages need something to
// show, so the journey runs one cheap single answer task first (real providers in a temporary JV_HOME).
//
// Usage: node acceptance/m15-phone.mjs [--keep] [--bind ADDRESS]
// Exit 0 when every check passes, 1 otherwise. Writes acceptance/results/m15.json.

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cleanup,
  finish,
  hasHorizontalScroll,
  jvJson,
  loadPlaywright,
  log,
  note,
  OWNER_SHOTS_DIR,
  parseFlags,
  queryOne,
  realJvHome,
  removeWorktreesUnder,
  run,
  runId,
  runJourney,
  SANDBOX,
  SANDBOX_NAME,
  SHOTS_DIR,
  startUi,
  stopChild,
  storeFile,
  waitForTask,
} from './lib.mjs';

const JOURNEY = 'm15';

function tailnetAddress() {
  const r = run('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['ip', '-4']);
  const fromApp = r.stdout.trim().split('\n')[0];
  if (/^100\./.test(fromApp ?? '')) return fromApp;
  const cli = run('tailscale', ['ip', '-4']);
  return cli.stdout.trim().split('\n')[0] || '100.108.210.116';
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { values: ['bind'], usage: 'node acceptance/m15-phone.mjs [--keep] [--bind ADDRESS]' });
  const bind = flags.bind ?? tailnetAddress();
  const started = Date.now();
  const id = runId(JOURNEY);
  log(`M15 Phone ${id} on ${bind}`);
  let home;
  let ui;
  let taskId;
  let sessionId;
  try {
    home = realJvHome(id).home;
    await check('a cheap single answer task gives the pages something to show', async () => {
      const r = jvJson(['task', 'create', '--project', SANDBOX_NAME, '--kind', 'single', '--duty', 'answer', '--title', 'One line about invoices', '--text', 'In one sentence: what is an invoice total?'], { home, timeoutMs: 180_000 });
      taskId = r.json?.task?.id;
      const end = taskId ? await waitForTask(home, taskId, ['done', 'failed', 'stopped', 'waiting-owner'], { timeoutMs: 10 * 60_000 }) : undefined;
      sessionId = taskId ? queryOne(storeFile(home), 'SELECT id FROM sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId)?.id : undefined;
      return { ok: end?.state === 'done' && !!sessionId, detail: `${taskId} ${end?.state}; session ${sessionId}` };
    });

    await check(`jv ui --bind ${bind} starts on a free port`, async () => {
      ui = await startUi(home, { bind });
      return { ok: ui.url.includes(bind), detail: ui.url };
    });

    const { pw } = loadPlaywright();
    mkdirSync(SHOTS_DIR, { recursive: true });
    mkdirSync(OWNER_SHOTS_DIR, { recursive: true });
    const pages = [
      ['login', '/login'],
      ['project', `/p/${SANDBOX_NAME}`],
      ['task', `/t/${taskId}`],
      ['session', `/s/${sessionId}`],
    ];
    for (const scheme of ['light', 'dark']) {
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        for (const [name, path] of pages) {
          await check(`${name} page at 390 by 844, ${scheme}: renders, no horizontal scroll`, async () => {
            if (name !== 'login' && !page.url().includes('/p/') && !page.url().includes('/t/') && !page.url().includes('/s/')) {
              await page.goto(`${ui.url}/login`);
              await page.locator('input[type="password"]').fill(ui.password);
              await page.getByRole('button', { name: 'Sign in' }).click();
              await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
            }
            await page.goto(`${ui.url}${path}`);
            await page.waitForLoadState('networkidle');
            const scroll = await hasHorizontalScroll(page);
            const file = join(SHOTS_DIR, `m15-${name}-390x844-${scheme}.png`);
            await page.screenshot({ path: file, fullPage: true });
            copyFileSync(file, join(OWNER_SHOTS_DIR, `m15-${name}-390x844-${scheme}.png`));
            return { ok: !scroll, detail: `${scroll ? 'scrolls sideways' : 'no horizontal scroll'}; ${file}` };
          });
        }
      } finally {
        await browser.close();
      }
    }
    note(`screenshots in acceptance/shots/ and ${OWNER_SHOTS_DIR}`);
  } finally {
    if (ui) await stopChild(ui.child);
    if (home) note(`worktrees removed from the sandbox: ${removeWorktreesUnder(SANDBOX, home).length}`);
    if (!flags.keep) cleanup(id);
  }
  return finish(JOURNEY, { startedAt: started, mode: `real providers in a temporary JV_HOME, jv ui on ${bind}` });
}

runJourney(JOURNEY, main);
