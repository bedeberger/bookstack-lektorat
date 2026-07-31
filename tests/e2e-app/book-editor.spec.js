// Bucheditor gegen die ECHTE App (siehe playwright.app.config.js): Verhalten,
// nicht nur „Karte öffnet ohne Fehler" (das deckt smoke.spec.js ab).
//
// Warum diese Schicht: der Bucheditor hat keinen Fixture-Harness, und seine
// heiklen Pfade laufen über echtes contenteditable + echten Save gegen das
// Backend. Zwei Klassen von Fehlern fallen NUR hier auf:
//   - Alpine-Scope: `this.$el` zeigt in einer aus `@click` gerufenen Methode
//     auf das auslösende Element, nicht auf die Karten-Wurzel — ein Lookup mit
//     dem falschen Wurzel-Element findet nichts und der Block bekommt keinen
//     Fokus (Tippen läuft ins Leere, ohne dass irgendwo ein Fehler entsteht).
//   - Save-Kette: dirty → Queue → PUT → persistiert. Unit-Tests sehen davon
//     nur `applySaveOutcome`.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

test.describe.configure({ mode: 'serial' });

const card = (page) => page.locator('.card--bookeditor');

// Karten-State lesen (dirtyCount/savingCount sind abgeleitete Getter).
const state = (page) => page.evaluate(() => {
  const d = window.Alpine.$data(document.querySelector('.card--bookeditor'));
  return { dirty: d.dirtyCount, saving: d.savingCount, blocks: d.blocks.length, active: d.activePageId };
});

async function openBookEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(() => window.__app.toggleBookEditorCard());
  await expect(card(page).locator('.book-editor-page-body').first()).toBeVisible({ timeout: 15000 });
}

test('Klick aktiviert den Block, Tippen macht dirty, Save-All persistiert', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);
  expect((await state(page)).dirty).toBe(0);

  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect(body).toHaveAttribute('contenteditable', 'true');
  // Der Fokus kommt erst im $nextTick nach dem contenteditable-Flip (der Block
  // ist beim Mousedown noch nicht editierbar, der Browser fokussiert also
  // nicht selbst). Abwarten statt blind tippen — sonst landen die Tasten im
  // Nichts, und genau das wäre der Bug, den dieser Test fangen soll.
  await expect.poll(
    () => page.evaluate(() => document.activeElement?.classList?.contains('book-editor-page-body') === true),
    { timeout: 5000 },
  ).toBe(true);
  await page.keyboard.type('PROBE ');

  expect((await state(page)).dirty, 'dirtyCount leitet sich aus den Blöcken ab').toBe(1);
  await expect(card(page).locator('.book-editor-page-status').first()).toHaveText(/.+/);

  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).saveAllDirty());
  await expect.poll(async () => (await state(page)).dirty, { timeout: 15000 }).toBe(0);

  // Wirklich geschrieben? Neu laden und im Stream nachsehen.
  await openBookEditor(page);
  await expect(card(page).locator('.book-editor-page-body').first()).toContainText('PROBE');
  guard.assertClean('Bucheditor: Tippen + Save-All');
});

test('Ohne caretRangeFromPoint setzt der Fallback den Caret (Tippen läuft nicht ins Leere)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  // Deterministisch den Fallback-Pfad erzwingen: ohne die API (bzw. bei einem
  // Klick, der kein Textnode trifft) muss der Caret trotzdem im Block landen —
  // sonst ist der Block zwar fokussiert, aber jede Eingabe verpufft.
  await page.addInitScript(() => { delete Document.prototype.caretRangeFromPoint; });
  await openBookEditor(page);

  const body = card(page).locator('.book-editor-page-body').first();
  await body.click();
  await expect(body).toHaveAttribute('contenteditable', 'true');
  // Auf den FOKUS warten, nicht auf „irgendeine Selektion im Block": der Browser
  // setzt beim Mousedown selbst eine Selektion in den (noch nicht editierbaren)
  // Block — die ist bereits da, bevor `activateBlock` im $nextTick fokussiert und
  // den Fallback-Caret setzt. Wer darauf gated, tippt ins Leere und misst nichts.
  // `el.focus()` läuft synchron vor `_placeCaret` im selben $nextTick: sobald der
  // Block das aktive Element ist, steht auch der Fallback-Caret.
  await expect.poll(
    () => page.evaluate(() => {
      const el = document.querySelector('.book-editor-page-body');
      if (document.activeElement !== el) return false;
      const s = document.getSelection();
      return !!(s && s.anchorNode && el.contains(s.anchorNode));
    }),
    { timeout: 5000 },
  ).toBe(true);

  await page.keyboard.type('X');
  expect((await state(page)).dirty).toBe(1);
  // Der Fallback setzt den Caret an den Blockanfang — das Zeichen muss dort
  // stehen, nicht an der Klickstelle. Sonst hätte auch die Browser-Selektion
  // gereicht und der Fallback-Pfad wäre ungeprüft.
  expect(await page.evaluate(
    () => document.querySelector('.book-editor-page-body').textContent.startsWith('X'),
  )).toBe(true);
  guard.assertClean('Bucheditor: Caret-Fallback');
});

test('Find/Replace läuft über den ganzen Stream', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);

  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).openFind());
  await card(page).locator('.book-editor-find-input').first().fill('der');
  await expect.poll(
    async () => page.evaluate(() => window.Alpine.$data(document.querySelector('.card--bookeditor')).findMatches.length),
    { timeout: 5000 },
  ).toBeGreaterThan(0);

  await card(page).locator('.book-editor-find-input--replace').fill('DEEER');
  // .book-editor-find-btn--text: [0] = Ersetzen, [1] = Alle ersetzen (locale-frei).
  await card(page).locator('.book-editor-find-btn--text').nth(1).click();
  await expect.poll(async () => (await state(page)).dirty, { timeout: 5000 }).toBeGreaterThan(0);
  await expect(card(page).locator('.book-editor-page-body').first()).toContainText('DEEER');
  guard.assertClean('Bucheditor: Find/Replace');
});

test('Outline-Chevron klappt ein Kapitel ein', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await openBookEditor(page);

  const chapter = card(page).locator('.book-editor-outline-chapter').first();
  await expect(chapter.locator('.history-chevron')).toHaveClass(/open/);
  const before = await card(page).locator('.book-editor-outline-page').count();
  await chapter.click();
  await expect(chapter.locator('.history-chevron')).not.toHaveClass(/open/);
  expect(await card(page).locator('.book-editor-outline-page').count()).toBeLessThan(before);
  guard.assertClean('Bucheditor: Outline');
});
