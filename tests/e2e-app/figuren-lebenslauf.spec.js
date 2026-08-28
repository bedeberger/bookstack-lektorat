// Lebenslauf (Reiter „Lebenslauf" der Figuren-Karte) gegen die ECHTE App
// (playwright.app.config.js).
//
// Warum diese Schicht und nicht ein Fixture-Harness: Testgegenstand ist die
// ganze Kette — nested Partial (`partial-figuren-lebenslauf`), die Chip-Auswahl,
// die Vorauswahl beim ersten Oeffnen und eine Matrix aus zwei verschachtelten
// x-for (Zeilen x Spalten). Der Smoke oeffnet die Figuren-Karte, betritt aber
// nur den Standard-Reiter.
//
// KERNBEHAUPTUNG, die hier in der echten App nachgewiesen wird: die Zeilen-Achse
// ist das ALTER. Zwei Figuren mit einem Jahr Altersunterschied wechseln in
// verschiedenen Kalenderjahren die Schule und muessen trotzdem in EINER Zeile
// stehen — sonst ist der Vergleich, um den es geht, zerschnitten.
//
// Lebensereignisse schreibt nur die Komplettanalyse (`updateFigurenEvents`),
// nicht `PUT /figures`. Darum wird die Katalog-Antwort abgefangen und um genau
// diese Ereignisse ergaenzt; Figuren, Karte, Auswahl und Matrix laufen echt.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--figuren';
const RUN = String(Date.now()).slice(-6);
const A_NAME = `CV-Dora ${RUN}`;   // Jg. 1985
const B_NAME = `CV-Emil ${RUN}`;   // Jg. 1986

const EVENTS_A = [
  { datum: '1985', ereignis: 'Geburt im Kantonsspital', subtyp: 'geburt', typ: 'persoenlich' },
  { datum: '1991', ereignis: 'Einschulung im Bifang', subtyp: 'wendepunkt', typ: 'persoenlich' },
  { datum: '1997', ereignis: 'Uebertritt in die Bezirksschule', subtyp: 'wendepunkt', typ: 'persoenlich' },
];
const EVENTS_B = [
  { datum: '1990', ereignis: 'Erkrankt an Leukaemie', subtyp: 'krankheit', typ: 'persoenlich' },
  { datum: '1999', ereignis: 'Uebertritt in die Sekundarschule', subtyp: 'wendepunkt', typ: 'persoenlich' },
];

async function seedFiguren(page, bookId) {
  return page.evaluate(async ({ bookId, aName, bName }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    window.__cvSpecBefore = existing;
    const mk = (suffix, name, jahr) => ({
      id: `fig_cv_${suffix}_${Date.now()}`, name, typ: 'hauptfigur',
      geburtstag: String(jahr), beziehungen: [], kapitel: [], eigenschaften: [],
    });
    const a = mk('a', aName, 1985);
    const b = mk('b', bName, 1986);
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, a, b] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { aId: a.id, bId: b.id };
  }, { bookId, aName: A_NAME, bName: B_NAME });
}

test('lebenslauf: Phasen-Matrix richtet nach Alter aus, Spalten sind waehlbar', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedFiguren(page, bookId);

  // Katalog-Antwort um die Lebensereignisse ergaenzen (echte Antwort, echtes
  // Schema — nur die zwei Testfiguren bekommen ihre Biografie dazu).
  await page.route(`**/figures/${bookId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    for (const f of (body.figuren || [])) {
      if (f.id === seeded.aId) f.lebensereignisse = EVENTS_A;
      if (f.id === seeded.bId) f.lebensereignisse = EVENTS_B;
    }
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  // Kein Alters-Index: der Reiter muss ohne Lauf tragen (Geburtsjahr aus dem
  // Steckbrief reicht).
  await page.route('**/figures/*/alter', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ figuren: [], scan: null }),
  }));

  // Kein eigener loadFiguren-Aufruf: das Oeffnen der Karte laedt den Katalog —
  // und zwar durch die eben registrierte Route.
  await page.evaluate(() => window.__app.toggleFiguresCard());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();

  await card.locator('.tabs-btn', { hasText: 'Lebenslauf' }).click();

  // Chips: nur Figuren MIT Geburtsjahr und Ereignissen — die Seed-Figuren des
  // Testbuchs haben keines und tauchen darum nicht auf.
  const chips = card.locator('.figur-cv-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: A_NAME })).toBeVisible();

  // Erste Oeffnung waehlt selbst vor — eine leere Matrix mit Aufforderung waere
  // ein Formular, kein Befund.
  const table = card.locator('.figur-cv-table');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveCount(3); // Phase + zwei Figuren
  await expect(table.locator('thead th').nth(1)).toContainText(A_NAME);
  await expect(table.locator('thead th').nth(1)).toContainText('Jg. 1985');

  // Graph laeuft auf diesem Reiter nicht mit.
  await expect(card.locator('.figuren-graph-wrap')).toBeHidden();

  // Nur Phasen, in denen etwas passiert — keine leeren Zwischenzeilen.
  const zeilen = table.locator('tbody tr.figur-cv-row');
  await expect(zeilen).toHaveCount(4);
  await expect(table.locator('.figur-cv-phase-name')).toHaveText([
    'Geburt', 'Frühe Kindheit', 'Schulkind', 'Jugend',
  ]);

  // DER KERN: 1997 (Dora, 12) und 1999 (Emil, 13) — verschiedene Jahre, dieselbe
  // Zeile. Nach Kalenderjahr sortiert stuenden sie versetzt.
  const jugend = zeilen.nth(3);
  await expect(jugend.locator('.figur-cv-phase-span')).toHaveText('12–17 Jahre');
  await expect(jugend.locator('td').nth(0)).toContainText('Uebertritt in die Bezirksschule');
  await expect(jugend.locator('td').nth(0).locator('.figur-cv-marke')).toHaveText('1997 · 12 J.');
  await expect(jugend.locator('td').nth(1)).toContainText('Uebertritt in die Sekundarschule');
  await expect(jugend.locator('td').nth(1).locator('.figur-cv-marke')).toHaveText('1999 · 13 J.');

  // Eine Phase, in der nur eine der beiden etwas erlebt, bleibt in der anderen
  // Spalte sichtbar leer — das ist die Aussage, nicht ein fehlender Wert.
  const schulkind = zeilen.nth(2);
  await expect(schulkind.locator('td').nth(0)).toContainText('Einschulung');
  await expect(schulkind.locator('td').nth(1).locator('.figur-cv-event')).toHaveCount(0);

  // Spalte abwaehlen → Matrix schrumpft.
  await chips.filter({ hasText: B_NAME }).click();
  await expect(table.locator('thead th')).toHaveCount(2);
  await expect(table.locator('.figur-cv-phase-name')).toHaveText([
    'Geburt', 'Schulkind', 'Jugend',
  ]); // Emils Kleinkind-Zeile faellt mit ihm weg

  expect(errors, `Konsolenfehler: ${errors.join(' | ')}`).toEqual([]);

  // Bestand wiederherstellen (geteiltes Wegwerf-Buch).
  await page.unroute(`**/figures/${bookId}`);
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before: await page.evaluate(() => window.__cvSpecBefore) });
});
