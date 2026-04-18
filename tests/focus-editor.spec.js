const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .page-content-view--editing';

async function enter(page) {
  await page.evaluate(() => window.harness.enterFocusMode());
  await page.waitForFunction(() => window.harness._focusListeners !== null);
}

async function placeCaretInParagraph(page, idx) {
  await page.evaluate((i) => {
    const p = document.querySelectorAll(`${'#editor-card .page-content-view--editing'} p`)[i];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, idx);
}

async function scrollTop(page) {
  return page.evaluate((sel) => document.querySelector(sel).scrollTop, EDITOR);
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.harnessReady === true);
});

test('toggle: enterFocusMode setzt body-Klasse, exit entfernt sie', async ({ page }) => {
  await enter(page);
  await expect(page.locator('body')).toHaveClass(/focus-mode/);

  await page.evaluate(() => window.harness.exitFocusMode());
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Tippen führt zu Recenter (scroll bewegt sich)', async ({ page }) => {
  await enter(page);

  // Reset auf 0, damit Recenter messbar ist.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);
  expect(await scrollTop(page)).toBe(0);

  // Caret weit unten setzen + ein Zeichen tippen → muss recentern.
  await placeCaretInParagraph(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(100);

  expect(await scrollTop(page)).toBeGreaterThan(200);
});

test('Pointer-Schonfrist verhindert Recenter (Klick-Verhalten)', async ({ page }) => {
  await enter(page);

  // Erst zentrieren auf Absatz 10.
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);
  const before = await scrollTop(page);

  // Echter Playwright-Click würde das Ziel auto-in-Viewport-scrollen → verfälscht
  // die Messung. Wir testen direkt das relevante Verhalten: ein Pointer-Event
  // unmittelbar gefolgt von selectionchange darf nicht recentern (auch wenn der
  // Cursor weit weg vom Zentrum landet).
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[40];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(100);
  const after = await scrollTop(page);

  expect(Math.abs(after - before)).toBeLessThan(20);
});

test('Cleanup: exit nullt State, entfernt Klassen + CSS-Vars', async ({ page }) => {
  await enter(page);
  // Etwas State erzeugen.
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);

  await page.evaluate(() => window.harness.exitFocusMode());

  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);

  const cssVars = await page.evaluate(() => ({
    vh:  document.documentElement.style.getPropertyValue('--focus-vh'),
    top: document.documentElement.style.getPropertyValue('--focus-vh-top'),
  }));
  expect(cssVars.vh).toBe('');
  expect(cssVars.top).toBe('');

  const state = await page.evaluate(() => ({
    listeners: window.harness._focusListeners,
    visible:   window.harness._focusVisibleBlocks,
    raf:       window.harness._focusRaf,
  }));
  expect(state.listeners).toBeNull();
  expect(state.visible).toBeNull();
  expect(state.raf).toBeNull();
});

test('5× Toggle leakt keine Observer/Listeners', async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await enter(page);
    await page.evaluate(() => window.harness.exitFocusMode());
  }
  // Nach dem letzten Exit: alles sauber zurück.
  const state = await page.evaluate(() => ({
    listeners: window.harness._focusListeners,
    visible:   window.harness._focusVisibleBlocks,
  }));
  expect(state.listeners).toBeNull();
  expect(state.visible).toBeNull();
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);
});
