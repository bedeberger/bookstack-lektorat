// E2E: Spellcheck-Controller im Bucheditor-Setup.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=book';

async function squiggleCount(page) {
  return page.evaluate(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].reduce((sum, k) => {
      const h = CSS.highlights.get(k);
      return sum + (h ? h.size : 0);
    }, 0);
  });
}

async function waitForSquiggles(page, timeout = 5000) {
  await page.waitForFunction(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].some((k) => {
      const h = CSS.highlights.get(k);
      return h && h.size > 0;
    });
  }, null, { timeout });
}

test('book: badge traegt data-editor=book', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-editor="book"]');
});

test('book: matches sichtbar nach Initial-Check', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  expect(await squiggleCount(page)).toBeGreaterThan(0);
});

async function clickFirstSquiggle(page) {
  const pt = await page.evaluate(() => {
    for (const k of ['lt-typo', 'lt-grammar', 'lt-style']) {
      const h = CSS.highlights.get(k);
      if (!h || !h.size) continue;
      const range = h.values().next().value;
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  });
  if (!pt) throw new Error('no squiggle present');
  await page.mouse.click(pt.x, pt.y);
}

// Bucheditor scrollt am Window → Popover haengt an <body>, nicht im
// contenteditable. Escape und Close-Button muessen trotzdem greifen.
test('book: escape und close-button schliessen den body-gemounteten popover', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  expect(await page.evaluate(() => document.querySelector('.lt-popover').parentElement.tagName)).toBe('BODY');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);

  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__close').click();
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
});

test('book: status-badge erscheint', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-editor="book"]');
  const state = await page.locator('.lt-badge').first().getAttribute('data-state');
  expect(['matches', 'clean', 'loading']).toContain(state);
});
