// Quellen-Tab des REFERENZ-SLOTS (Begleitpanel neben dem Notebook-Editor),
// gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Slot ist kein Eintrag in `EXCLUSIVE_CARDS` — der
// registry-getriebene Smoke-Test öffnet ihn nie, und ein Fixture-Harness hätte
// weder den Fund-Index noch den Save-Pfad, der ihn füllt. Geprüft wird genau die
// Kette, die kein Unit-Test abbilden kann: Quellennachweis speichern → Server baut
// `source_citations` → Slot liest ihn → Klick springt per Permalink ins
// Quellenverzeichnis und hebt dort die Zeile hervor.
//
// Geprüfte Invarianten:
//   1. Das Tab erscheint nur, wenn das Buch überhaupt Quellen hat.
//   2. Seiten-Scope zeigt die auf DIESER Seite belegte Quelle („Auf dieser Seite")
//      und nicht die eines anderen Kapitels.
//   3. Buch-Scope zeigt beide.
//   4. Klick setzt `#book/:id/quellen/<sourceId>`, öffnet das Quellenverzeichnis
//      und fokussiert die Zeile.
//   5. Nichts davon erzeugt einen unbehandelten Alpine-/Library-Fehler.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const REF = '#reference-card';
const EDIT_SEL = '#editor-card .page-content-view--editing';

const TITLE_A = 'Referenz-Slot Quelle A';
const TITLE_B = 'Referenz-Slot Quelle B';

async function createSource(page, title) {
  return page.evaluate(async (t) => {
    const res = await fetch('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: window.Alpine.store('nav').selectedBookId,
        csl_type: 'book', title: t, year: '1915',
        authors: [{ family: 'Kafka', given: 'Franz' }],
      }),
    });
    return (await res.json()).id;
  }, title);
}

// Inhalt wird ANGEHÄNGT, nie ersetzt: ein Save, der den Text stark kürzt, öffnet
// einen Bestätigungsdialog und `saveEdit()` käme nie zurück (Konvention der
// Notebook-Specs gegen die echte App).
async function citeOnPage(page, pageIdx, srcId) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.evaluate((id) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend',
      `<p>Belegt <span class="cite" data-src="${id}" contenteditable="false">(Kafka, 1915)</span></p>`);
    window.__app._markEditDirty();
  }, srcId);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
}

// Slot auf einer Seite öffnen und aufs Quellen-Tab wechseln. Der Toggle sitzt in
// der Editor-Toolbar; `selectPage` schliesst den Slot (Mutex im Editor-Slot),
// darum immer erst die Seite wählen, dann öffnen.
async function openQuellenTab(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(async () => { await window.__app.toggleReferenceCard(); });
  await page.waitForSelector(REF, { state: 'visible', timeout: 15000 });
  const tab = page.locator(`${REF} .tabs-btn`, { hasText: 'Quellen' });
  await expect(tab).toBeVisible({ timeout: 15000 });   // Invariante 1
  await tab.click();
}

function rowByTitle(page, title) {
  return page.locator(`${REF} .reference-row`, { hasText: title });
}

test('Referenz-Slot: Quellen-Tab zeigt Belege der Seite und verlinkt ins Quellenverzeichnis', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Zwei Seiten aus VERSCHIEDENEN Kapiteln — nur so ist „nicht im Kapitel"
  // überhaupt prüfbar. Eigene Seiten je Spec, weil die Smoke-DB über den ganzen
  // Lauf lebt und andere Specs Belege auf Seite 0/3 stapeln.
  const idx = await page.evaluate(() => {
    const pages = window.Alpine.store('nav').pages;
    const first = 1;
    const other = pages.findIndex(p => (p.chapter_id ?? null) !== (pages[first].chapter_id ?? null));
    return { first, other };
  });
  expect(idx.other).toBeGreaterThanOrEqual(0);

  const srcA = await createSource(page, TITLE_A);
  const srcB = await createSource(page, TITLE_B);
  await citeOnPage(page, idx.first, srcA);
  await citeOnPage(page, idx.other, srcB);

  // Invariante 2: Seiten-Scope
  await openQuellenTab(page, idx.first);
  const rowA = rowByTitle(page, TITLE_A);
  await expect(rowA).toBeVisible();
  await expect(rowA).toContainText('Auf dieser Seite');
  await expect(rowByTitle(page, TITLE_B)).toHaveCount(0);

  // Invariante 3: Buch-Scope zeigt beide (Scope-Umschalter im Karten-Header).
  await page.locator(`${REF} .card-actions .icon-btn`).first().click();
  await expect(rowByTitle(page, TITLE_A)).toBeVisible();
  await expect(rowByTitle(page, TITLE_B)).toBeVisible();

  // Invariante 4: Sprung ins Quellenverzeichnis auf genau diese Zeile.
  await rowByTitle(page, TITLE_B).click();
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/quellen/${srcB}$`));
  await page.waitForFunction(() => window.__app.showSourcesCard === true, null, { timeout: 15000 });
  await expect(page.locator(`#sources-card tr[data-source-id="${srcB}"]`)).toBeVisible({ timeout: 15000 });

  expect(errors).toEqual([]);   // Invariante 5
});
