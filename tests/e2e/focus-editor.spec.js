const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .page-content-view--editing';

async function enter(page) {
  // exitFocusMode droppt bei !editDirty zurück in den View-Modus (editMode=false).
  // Für Re-Entry im Test editMode zurücksetzen.
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
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

test('Enter erzeugt <p>-Absatz (kein <div>), auch bei bare-text Content', async ({ page }) => {
  // Chromium-Default für contenteditable-Enter ist <div>. startEdit muss
  // defaultParagraphSeparator=p setzen, sonst verlieren neue Absätze das
  // Block-Styling (margin, focus-paragraph-Erkennung via BLOCK_TAGS).
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Bare-Text mit <br> – klassische Problemstelle, wo Chromium ohne Fix <div> produziert.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.replaceChildren(
      document.createTextNode('Zeile eins.'),
      document.createElement('br'),
      document.createTextNode('Zeile zwei.'),
    );
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('neu');
  await page.waitForTimeout(50);

  const divCount = await page.locator(`${EDITOR} > div`).count();
  const pCount   = await page.locator(`${EDITOR} > p`).count();
  expect(divCount).toBe(0);
  expect(pCount).toBeGreaterThan(0);
  await expect(page.locator(`${EDITOR} > p`).last()).toHaveText('neu');
});

test('Enter in <p> splittet sauber in zwei <p> (Standardfall)', async ({ page }) => {
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  const before = await page.locator(`${EDITOR} > p`).count();
  await placeCaretInParagraph(page, 3);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const after = await page.locator(`${EDITOR} > p`).count();
  expect(after).toBe(before + 1);
  expect(await page.locator(`${EDITOR} > div`).count()).toBe(0);
});

test('Enter im Fokus-Mode zentriert auf den neuen Absatz (Typewriter-Scroll)', async ({ page }) => {
  // Regression: vor defaultParagraphSeparator=p erzeugte Enter <div>, das
  // nicht in BLOCK_TAGS ist → findBlockFromNode lieferte null → kein
  // Recenter auf die neue Zeile. Ergebnis: Cursor wanderte unsichtbar
  // aus dem Viewport-Zentrum.
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Absatz weit unten fokussieren + zentrieren, damit Enter einen messbaren
  // Scroll-Delta erzeugen kann. Caret ans Ende, damit der neue <p> nach
  // Enter die aktive Zeile ist (nicht der verbleibende Rest).
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[30];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  // Scroll auf 0 zurücksetzen: ohne Recenter bleibt der neue Absatz weit
  // unterhalb des Viewports. Mit Recenter springt scrollTop messbar nach oben.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);

  await page.keyboard.press('Enter');
  await page.keyboard.type('frisch');
  await page.waitForTimeout(100);

  // Der frisch getippte Absatz muss aktiv markiert sein (Recenter-Pfad
  // basiert auf BLOCK_TAGS-Match, DIV würde hier durchfallen).
  const activeText = await page.locator(`${EDITOR} .focus-paragraph-active`).innerText();
  expect(activeText).toBe('frisch');

  // Recenter muss scrollTop klar nach oben bewegen (neuer Absatz weit unten).
  expect(await scrollTop(page)).toBeGreaterThan(200);
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
