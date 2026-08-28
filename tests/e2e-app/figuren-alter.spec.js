// Alterstabelle (Reiter „Alter" der Figuren-Karte) gegen die ECHTE App
// (playwright.app.config.js).
//
// Warum diese Schicht und nicht ein Fixture-Harness: Testgegenstand ist die
// ganze Kette — nested Partial (`partial-figuren-alter`), der `sortableTable`-
// Scope, zwei Filter-Comboboxen, deren Options-Expression die karten-lokale
// Liste reaktiv liest, und die aufklappbare Beleg-Zeile (ein `<tbody>` pro Zeile
// aus dem x-for, siehe DESIGN.md „Aufklappbare Tabellenzeile"). Der Smoke oeffnet
// die Figuren-Karte, betritt aber nur den Standard-Reiter — Tabelle und
// Belegzeile bleiben dort ungerendert.
//
// Der Alters-Index selbst kommt aus einem KI-Job und ist in der Testumgebung
// nicht erzeugbar. Darum wird die EINE Leseroute abgefangen (`page.route`) und
// mit einer realistischen Antwort bedient; alles andere (Figuren, Karte, Filter,
// Sortierung, Aufklappen) laeuft echt.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const A_NAME = `Alter-Anna ${RUN}`;
const B_NAME = `Alter-Bert ${RUN}`;

async function seedFiguren(page, bookId) {
  return page.evaluate(async ({ bookId, aName, bName }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    window.__alterSpecBefore = existing;
    const a = { id: `fig_alter_a_${Date.now()}`, name: aName, typ: 'hauptfigur', geburtstag: '1900', beziehungen: [], kapitel: [], eigenschaften: [] };
    const b = { id: `fig_alter_b_${Date.now()}`, name: bName, typ: 'randfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, a, b] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { aId: a.id, bId: b.id };
  }, { bookId, aName: A_NAME, bName: B_NAME });
}

test('alterstabelle: Reiter rendert, Filter greifen, Belege klappen auf', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedFiguren(page, bookId);

  // Leseroute des Alters-Index bedienen: Anna hat eine belegte Spanne MIT
  // Widerspruch, Bert gar keine Zeile (der haeufige Fall „nichts bekannt").
  await page.route('**/figures/*/alter', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        figuren: [{
          fig_id: seeded.aId,
          name: A_NAME,
          alter_von: 12, alter_bis: 19,
          bezugsjahr_von: 1912, bezugsjahr_bis: 1919,
          geburtsjahr: 1900, gerechnet: 25, geburtsjahr_quelle: 'kuratiert',
          quelle: 'text', konfidenz: 0.7,
          widerspruch: [{ typ: 'rechnung', a: 19, b: 25 }],
          begruendung: null,
          scanned_at: '2026-01-02T03:04:05.000Z',
          belege: [
            { art: 'alter', wert: 12, bezugsjahr: 1912, zitat: 'sie war zwölf Jahre alt', page_id: 1, page_name: 'Seite Eins', chapter_id: null, chapter_name: 'Kapitel Eins', unsicher: false, begruendung: null },
            { art: 'alter', wert: 19, bezugsjahr: 1919, zitat: 'die neunzehnjährige Anna', page_id: null, page_name: 'Seite Zwei', chapter_id: null, chapter_name: 'Kapitel Zwei', unsicher: true, begruendung: null },
          ],
        }],
        scan: { scanned_at: '2026-01-02T03:04:05.000Z', figuren_total: 2, mit_alter: 1, belege_total: 2, embed_used: true, model: 'test' },
      }),
    });
  });

  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  // Reiter wechseln → Tabelle + geladener Index.
  await card.locator('.tabs-btn', { hasText: 'Alter' }).click();
  const table = card.locator('.figur-alter-table');
  await expect(table).toBeVisible();
  await page.waitForFunction(
    () => !!window.Alpine.$data(document.querySelector('.card--figuren')).figurenAlterData?.scan,
    null, { timeout: 15000 },
  );

  // Graph darf auf diesem Reiter nicht mitlaufen (kein vis-Bundle, kein Canvas).
  await expect(card.locator('.figuren-graph-wrap')).toBeHidden();

  const rowA = table.locator('tbody', { hasText: A_NAME }).first();
  const rowB = table.locator('tbody', { hasText: B_NAME }).first();
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  // Spanne als Spanne, nicht als Einzelwert; Widerspruch als „prüfen"-Plakette.
  await expect(rowA.locator('.figur-alter-age')).toHaveText('12–19');
  await expect(rowA.locator('.tag--stale')).toHaveText('prüfen');
  // Bert hat nichts — die Tabelle behauptet dort kein Alter, und ohne Alter auch
  // kein Bezugsjahr (`jahr_im_roman` faellt sonst aufs Buchende zurueck).
  await expect(rowB.locator('.figur-alter-age')).toHaveText('unbekannt');
  // Der gerechnete Wert stammt aus dem Index (Spalte `gerechnet`), nicht aus dem
  // Katalog-Feld `alter_im_roman` — der Server kennt dort auch ein nur im Text
  // gefundenes Geburtsjahr.
  await expect(rowA.locator('td').nth(4)).toHaveText('25');

  // Belege aufklappen: zwei Fundstellen, die zweite als unsicher markiert.
  await expect(rowA.locator('.figur-alter-belege-row')).toBeHidden();
  await rowA.locator('tr.figur-alter-row').click();
  await expect(rowA.locator('.figur-alter-beleg')).toHaveCount(2);
  await expect(rowA.locator('.figur-alter-zitat').first()).toContainText('zwölf Jahre alt');
  // Beleg MIT Seite bekommt ein Sprungziel, der ohne bleibt ohne — beide Zweige.
  // Auf Sichtbarkeit pruefen, nicht auf Anzahl: `x-show` laesst den versteckten
  // Knoten im DOM stehen, `toHaveCount` zaehlt ihn mit.
  const orte = rowA.locator('.figur-alter-beleg-ort');
  await expect(orte.first()).toBeVisible();
  await expect(orte.first()).toHaveText('Kapitel Eins › Seite Eins');
  await expect(orte.nth(1)).toBeHidden();

  // Filter „nur mit Alter" (zweite Combobox) blendet Bert aus.
  const boxes = card.locator('.figur-alter .filter-bar .combobox-wrap');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(1).locator('.combobox-trigger').click();
  await boxes.nth(1).locator('.combobox-option').filter({ hasText: 'Nur mit Alter' }).click();
  await expect(rowB).toBeHidden();
  await expect(rowA).toBeVisible();

  // Suche schraenkt weiter ein.
  await card.locator('.figur-alter .filter-search-input').fill(B_NAME);
  await expect(table.locator('tbody', { hasText: A_NAME })).toHaveCount(0);

  expect(errors, `Konsolenfehler: ${errors.join(' | ')}`).toEqual([]);

  // Bestand wiederherstellen (geteiltes Wegwerf-Buch).
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before: await page.evaluate(() => window.__alterSpecBefore) });
});
