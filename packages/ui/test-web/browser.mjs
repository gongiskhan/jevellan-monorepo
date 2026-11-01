/* global document, window */
// Shared setup of the web app's browser checks: headless Chromium from the owner's Playwright cache (the
// PLAYWRIGHT_BROWSERS_PATH that workers use, ~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux;
// M-006, M-021), a mock UI server, pages at the two sizes and two colour schemes of brief section 7, the horizontal
// scroll measure and the screenshots under test-web/shots/ (gitignored).

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(here, 'shots');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const found = [join(homedir(), 'Library', 'Caches', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright')].find((p) => existsSync(p));
  if (found) process.env.PLAYWRIGHT_BROWSERS_PATH = found;
}

export const SIZES = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
];
export const SCHEMES = ['light', 'dark'];

export async function launch() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
}

/** A signed-in browser context of one size and scheme against the mock server. */
export async function signedInContext(browser, mock, size, scheme, extra = {}) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 1, ...extra });
  await context.addCookies([{ name: mock.cookie.name, value: mock.cookie.value, url: mock.url }]);
  return context;
}

/** How far the page scrolls sideways (0 when nothing is wider than the viewport). */
export function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
}

/** The elements that stick out past the right edge of the viewport, for a failure message. */
export function overflowingElements(page) {
  return page.evaluate(() => {
    const out = [];
    const width = window.innerWidth;
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect();
      if (box.right > width + 1 && box.width > 0) {
        let hidden = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = window.getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            hidden = true;
            break;
          }
        }
        if (!hidden) out.push(`${element.tagName.toLowerCase()}.${String(element.className).split(' ').join('.')} right=${Math.round(box.right)}`);
      }
    }
    return out.slice(0, 8);
  });
}

export async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
