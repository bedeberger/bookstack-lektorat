// Tabellen im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Gitter-Dialog ist verschachteltes Alpine-Markup
// (`x-if` um zwei `x-for`-Ebenen, public/partials/editor-table-dialog.html).
// Alpine schluckt Expression-Fehler — ein Tippfehler dort zeigt sich nicht als
// Ausnahme, sondern als leeres Gitter. Der Smoke-Test faengt das NICHT: er
// oeffnet Karten, aber keinen Dialog. Dazu kommt `contenteditable`, das Chromium
// auswertet und nicht unser Code, und die Dirty-Erkennung, die den gemounteten
// Editor-DOM gegen den Server-Stand vergleicht.
//
// Geprueft:
//   1. Slash-Menue kennt „Tabelle"; der Dialog oeffnet mit gefuelltem Gitter.
//   2. Uebernehmen schreibt Markup nach dem Vertrag (thead/scope, data-align).
//   3. Die Tabelle ueberlebt Speichern → Neuladen → Edit-Modus.
//   4. `contenteditable` landet NIE in der Persistenz.
//   5. Oeffnen + Speichern ohne Aenderung erzeugt keine Aenderung (die Tabelle
//      ist beim Mount atomar markiert — ohne den Strip gaelte jede Seite mit
//      Tabelle beim Oeffnen als geaendert).
//   6. Klick auf eine gesetzte Tabelle oeffnet den Dialog zum Bearbeiten.
//
// Konventionen wie notebook-xref.spec.js: Inhalt wird ANGEHAENGT, und jeder Test
// arbeitet auf einer eigenen Seite — die Smoke-DB lebt ueber den ganzen Lauf.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const DLG_SEL = 'dialog.table-dialog';

async function boot(page) {
  await bootApp(page);
  await selectSeededBook(page);
}

async function openPageInEdit(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

// Dialog ueber den Karten-Scope oeffnen (der Slash-Weg braucht echte Tastatur —
// den prueft Test 1 separat).
async function openTableDialog(page) {
  await page.evaluate(() => {
    const el = document.querySelector('#partial-editor-toolbar [x-data="editorToolbarCard"]')
      || document.querySelector('[x-data="editorToolbarCard"]');
    window.Alpine.$data(el).openTableDialog(null);
  });
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });
}

async function serverHtml(page) {
  return page.evaluate(async () => {
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return (await r.json()).html || '';
  });
}

test('Slash-Menue bietet „Tabelle" an', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  const keys = await page.evaluate(() => {
    const el = document.querySelector('[x-data="editorToolbarCard"]');
    return window.Alpine.$data(el).slashItems().map(i => i.key);
  });
  expect(keys).toContain('tabelle');
});

test('Dialog rendert ein befuelltes Gitter (verschachteltes x-for)', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);

  // Kopfzeile + zwei Datenzeilen × drei Spalten = 9 Zellenfelder. Bliebe ein
  // x-for stumm, waeren es 0 — genau der Fehler, den Alpine verschluckt.
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(9);
  await expect(page.locator(`${DLG_SEL} .table-grid-colhead`)).toHaveCount(3);
  await expect(page.locator(`${DLG_SEL} .table-caption-input`)).toHaveCount(1);
  // Ausrichtungs-Knoepfe: drei pro Spalte.
  await expect(page.locator(`${DLG_SEL} .table-align-btn`)).toHaveCount(9);
});

test('Zeile/Spalte hinzufuegen und entfernen wirkt aufs Gitter', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await openTableDialog(page);

  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(0).click(); // Zeile
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(12);
  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(1).click(); // Spalte
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(16);
  // Kopfzeile abschalten → die Kopf-Felder verschwinden.
  await page.locator(`${DLG_SEL} .table-dialog-tools button`).nth(2).click();
  await expect(page.locator(`${DLG_SEL} .table-grid-input`)).toHaveCount(12);
});

test('Uebernehmen schreibt Markup nach dem Vertrag und ueberlebt den Save', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  await openTableDialog(page);

  // Zellen ueber die echten Felder befuellen (Input-Event-Pfad, nicht via State).
  const cells = page.locator(`${DLG_SEL} .table-grid-input`);
  await cells.nth(0).fill('Jahr');
  await cells.nth(1).fill('Umsatz');
  await cells.nth(2).fill('Quote');
  await cells.nth(3).fill('2023');
  await cells.nth(4).fill('1.2 Mio');
  await cells.nth(5).fill('4.1 %');
  await page.locator(`${DLG_SEL} .table-caption-input`).fill('Umsatz nach Jahr');
  // Zweite Spalte rechtsbuendig.
  await page.locator(`${DLG_SEL} .table-grid-colhead`).nth(1)
    .locator('.table-align-btn').nth(2).click();

  await page.locator(`${DLG_SEL} .editor-dialog__actions button.primary`).click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });

  await expect(page.locator(`${EDIT_SEL} table`)).toHaveCount(1);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  const html = await serverHtml(page);
  expect(html).toContain('<table');
  expect(html).toContain('<caption>Umsatz nach Jahr</caption>');
  expect(html).toMatch(/<th[^>]*scope="col"/);
  expect(html).toContain('data-align="right"');
  expect(html).toContain('1.2 Mio');
  // Editor-Laufzeit gehoert nie in die Persistenz.
  expect(html).not.toContain('contenteditable');
  // Die Nummer ist ein Render-Artefakt — sie darf nicht mitgespeichert werden.
  expect(html).not.toMatch(/Tab\.\s*\d/);
});

test('Oeffnen und Speichern ohne Aenderung laesst die Tabelle unberuehrt', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  const before = await serverHtml(page);
  expect(before).toContain('<table');

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const after = await serverHtml(page);
  expect(after).toBe(before);
});

test('Klick auf eine gesetzte Tabelle oeffnet den Dialog zum Bearbeiten', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  await page.locator(`${EDIT_SEL} table`).first().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { timeout: 5000 });

  // Bearbeiten-Modus: „Tabelle entfernen" ist sichtbar, das Gitter traegt den
  // gespeicherten Inhalt.
  await expect(page.locator(`${DLG_SEL} .editor-dialog__actions button.danger`)).toBeVisible();
  await expect(page.locator(`${DLG_SEL} .table-caption-input`)).toHaveValue('Umsatz nach Jahr');
  const first = await page.locator(`${DLG_SEL} .table-grid-input`).first().inputValue();
  expect(first).toBe('Jahr');

  await page.locator(`${DLG_SEL} .editor-dialog__actions button:not(.primary):not(.danger)`).last().click();
  await page.waitForSelector(`${DLG_SEL}[open]`, { state: 'detached', timeout: 5000 });
});
