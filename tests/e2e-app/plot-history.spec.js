// Undo/Redo der Plot-Werkstatt gegen die ECHTE App (Server + SQLite + Alpine).
//
// Warum hier und nicht als Fixture-Harness: die Historie ist nur dann etwas wert,
// wenn der Server den zurückgedrehten Stand wirklich übernimmt — jeder Applier ist
// ein echter PATCH/DELETE/PUT. Genau das prüft diese Ebene (Reload beweist die
// Persistenz), ein Mock-Server würde die Zusage nur nachspielen.
//
// Nicht abgedeckt: der Drag-&-Drop-Pfad (`beat-place`) — SortableJS mit
// forceFallback-Ghost ist im Headless-Chromium nicht verlässlich fahrbar. Dessen
// Kern (`_hApplyPlacements`: nur abweichende Beats, Quell- + Ziel-Zelle
// persistieren) liegt in tests/unit/plot-history.test.mjs.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

// Flaches Board und Grid liegen beide im DOM (je x-show) — das Seed-Buch hat keine
// Stränge, also ist das flache Board das sichtbare. Alle Board-Locator dorthin
// skopieren, sonst matcht jeder Selektor doppelt (strict-mode violation).
const BOARD = '#partial-plot-board-flat';

const ACT_NAME = 'Undo-Test-Akt';
const ACT_RENAMED = 'Umbenannter Akt';
const BEAT_TITEL = 'Undo-Test-Bogen';

// Plot-Karte oeffnen und auf das Board warten.
async function openPlot(page) {
  await page.evaluate(() => window.__app.togglePlotCard());
  await expect(page.locator('.card--plot')).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('.card--plot')
    ?.textContent?.includes('…lade'), null, { timeout: 10000 }).catch(() => {});
}

// Akt anlegen — der Einstieg unterscheidet sich je nachdem, ob das Board leer ist
// (Empty-State-Button) oder schon Spalten hat (Add-Spalte am Ende).
async function addAct(page, name) {
  const input = page.locator(`${BOARD} .plot-new-act-input`);
  if (!(await input.isVisible())) {
    const emptyBtn = page.locator('.card--plot .card-empty .btn-primary');
    if (await emptyBtn.isVisible()) await emptyBtn.click();
    else await page.locator(`${BOARD} .plot-add-act-btn`).first().click();
  }
  await input.fill(name);
  await input.press('Enter');
  await expect(page.locator(`${BOARD} .plot-column-title`, { hasText: name })).toBeVisible();
}

const undoBtn = (page) => page.locator('.card--plot .card-actions button').first();
const redoBtn = (page) => page.locator('.card--plot .card-actions button').nth(1);
const actTitle = (page, name) => page.locator(`${BOARD} .plot-column-title`, { hasText: name });

test('Undo/Redo: Akt anlegen, umbenennen, Bogen anlegen — serverseitig zurückgedreht', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openPlot(page);

  // Leerer Stack → beide Buttons deaktiviert.
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  // ── create-act: Undo löscht den frisch angelegten Akt ──────────────────────
  await addAct(page, ACT_NAME);
  await expect(undoBtn(page)).toBeEnabled();
  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toHaveCount(0);
  // Nach dem Undo eines Create ist der Redo-Stack invalidiert (neue ID beim
  // Wiederanlegen) — der Button bleibt aus.
  await expect(redoBtn(page)).toBeDisabled();

  // ── act-fields: Umbenennen zurückdrehen und wiederherstellen ───────────────
  await addAct(page, ACT_NAME);
  // Spalten-Locator OHNE hasText: im Bearbeiten-Modus ersetzt das x-if den Titel-
  // Span durch ein Input, die Spalte enthaelt den Namen dann nicht mehr als Text —
  // ein hasText-Filter loest danach ins Leere auf. Das Board hat hier genau eine Spalte.
  const column = page.locator(`${BOARD} .plot-column`).first();
  await column.locator('.plot-column-title').dblclick(); // Doppelklick = umbenennen
  const titleInput = column.locator('.plot-column-title-input');
  await titleInput.fill(ACT_RENAMED);
  await titleInput.press('Enter');
  await expect(actTitle(page, ACT_RENAMED)).toBeVisible();

  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toBeVisible();
  await expect(redoBtn(page)).toBeEnabled();
  await redoBtn(page).click();
  await expect(actTitle(page, ACT_RENAMED)).toBeVisible();
  // Rückweg muss wieder undo-bar sein (Guard gegen den Re-Entry-Guard).
  await expect(undoBtn(page)).toBeEnabled();
  await undoBtn(page).click();
  await expect(actTitle(page, ACT_NAME)).toBeVisible();

  // ── create-beat: Undo löscht den Bogen, der Akt bleibt ─────────────────────
  const col = page.locator(`${BOARD} .plot-column`).first();
  await col.locator('.plot-add-beat-btn').click();
  const beatInput = col.locator('.plot-add-beat-input');
  await beatInput.fill(BEAT_TITEL);
  await beatInput.press('Enter');
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toBeVisible();

  await undoBtn(page).click();
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toHaveCount(0);
  await expect(actTitle(page, ACT_NAME)).toBeVisible();

  // ── Persistenz: Reload zeigt den zurückgedrehten Stand (Akt ohne Bogen) ────
  await bootApp(page); // frischer Load (wartet auf window.__app + geladene Bücher)
  await selectSeededBook(page);
  await openPlot(page);
  await expect(actTitle(page, ACT_NAME)).toBeVisible();
  await expect(page.locator(`${BOARD} .plot-beat-title`, { hasText: BEAT_TITEL })).toHaveCount(0);
  await expect(actTitle(page, ACT_RENAMED)).toHaveCount(0);
  // Board-Reload leert die Historie (fremde Änderungen könnten Records entwerten).
  await expect(undoBtn(page)).toBeDisabled();

  expect(guard.unmatched().map((f) => `[${f.channel}] ${f.text}`)).toEqual([]);
});
