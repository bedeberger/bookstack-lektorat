// E2E: Spellcheck-Controller im Notebook-Editor-Setup.
// Harness mountet den Controller direkt; LT-Endpoint ist im Test-Server
// gemockt (Walld -> Tippfehler, scheinet -> Grammatik).
//
// Squiggles werden ueber die CSS Custom Highlight API gerendert (kein
// DOM-Element pro Match) — Tests greifen Highlight-Sets aus `CSS.highlights`
// ab und klicken via Maus-Koordinaten ins highlight-Range.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=notebook';

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

test('notebook: squiggle erscheint nach Debounce', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  const count = await squiggleCount(page);
  expect(count).toBeGreaterThanOrEqual(2);
});

test('notebook: status-badge zeigt match-count', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-state="matches"]', { timeout: 5000 });
  const label = await page.locator('.lt-badge__label').textContent();
  expect(parseInt(label, 10)).toBeGreaterThanOrEqual(2);
});

test('notebook: klick auf squiggle oeffnet popover', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  const replacements = await page.locator('.lt-popover__replacement').count();
  expect(replacements).toBeGreaterThanOrEqual(1);
});

test('notebook: escape schliesst popover, text bleibt unveraendert', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  const before = await page.locator('#editor').textContent();
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
  expect(await page.locator('#editor').textContent()).toBe(before);
});

test('notebook: close-button schliesst popover und traegt aria-label', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  const closeBtn = page.locator('.lt-popover__close');
  // i18n im Harness ist Identity → der rohe Key belegt, dass uebersetzt wird.
  await expect(closeBtn).toHaveAttribute('aria-label', 'spellcheck.popover.close');
  // Trefferflaeche >= 24x24.
  const box = await closeBtn.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await closeBtn.click();
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
});

test('notebook: close-button ist per tastatur erreichbar + aktivierbar', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  // Caret sitzt im contenteditable vor dem Popover-Subtree → Tab landet auf dem
  // ersten fokussierbaren Element darin, dem Close-Button.
  await page.keyboard.press('Tab');
  const focusedClass = await page.evaluate(() => document.activeElement?.className || '');
  expect(focusedClass).toContain('lt-popover__close');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
});

test('notebook: popover-markup landet nicht im gespeicherten HTML', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  const res = await page.evaluate(() => {
    const root = document.getElementById('editor');
    return {
      inDom: root.innerHTML.indexOf('lt-popover') !== -1,
      saved: window.__stripLektoratMarks(root.innerHTML),
    };
  });
  // Vorbedingung: der Popover haengt wirklich im contenteditable (Notebook-Mount).
  expect(res.inDom).toBe(true);
  expect(res.saved).not.toContain('lt-popover');
  expect(res.saved).not.toContain('lt-badge');
  expect(res.saved).not.toContain('<button');
});

test('notebook: replacement-klick ersetzt text', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__replacement').first().click();
  // Walld -> Wald (erstes Replacement).
  await expect.poll(() => page.locator('#editor').textContent()).not.toContain('Walld');
});
