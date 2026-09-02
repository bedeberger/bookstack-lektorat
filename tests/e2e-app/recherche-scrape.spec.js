// Recherche-Board: „diesen Link lesen" (POST /research/:id/scrape) gegen die
// ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Knopf lebt in einem Fragment
// (`@include recherche-item-urls`) INNERHALB eines verschachtelten `x-for`.
// Alpine wertet dessen Ausdruecke (`scrapeUrl`, `urlScrapeBusy`) nur aus, wenn
// ein Fundstueck mit Links da ist — der Smoke oeffnet die Karte leer und sieht
// davon nichts; ein vertippter Methodenname faellt erst beim echten Klick auf.
//
// Warum die ERWARTUNG ein Fehlerfall ist: der Test darf nicht ins Internet
// greifen (kein Netz in CI, keine fremde Seite als stille Testabhaengigkeit).
// Ein Link auf den eigenen Server ist loopback und wird vom SSRF-Guard
// abgewiesen — und genau das ist die Kette, die hier gemessen werden soll:
// Klick → Route → Guard → `error_code` → lokalisierte Meldung in der Karte.
// Die Extraktion selbst deckt tests/unit/url-scrape.test.mjs ab.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche: Link lesen ist verdrahtet und meldet ein geblocktes Ziel', async ({ page }) => {
  const errors = [];
  // Der abgewiesene Abruf ist der Testgegenstand, und Chromium protokolliert
  // JEDE nicht-2xx-Antwort als Konsolenfehler. Nur diese eine Zeile wird
  // ausgenommen — Alpine-Expression-Fehler und pageerror bleiben fatal, sie
  // sind der Grund, warum diese Spec in der App-Suite steht.
  const EXPECTED = /Failed to load resource.*400/;
  page.on('console', (m) => {
    if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Fundstueck mit ZWEI Links: Testgegenstand ist auch, dass der geklickte
  // gewinnt und nicht der erste (die url_id geht mit).
  const item = await page.evaluate(async (id) => {
    const r = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: id, kind: 'link', title: 'Aus der Android-App geteilt',
        urls: [
          { url: 'https://erster.example.org/a' },
          { url: 'http://127.0.0.1:9/nicht-oeffentlich' },
        ],
      }),
    });
    return r.json();
  }, bookId);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  const rows = page.locator(`[data-research-id="${item.id}"] .research-item-url-row`);
  await expect(rows).toHaveCount(2);

  // Zweite Zeile lesen lassen — die auf loopback zeigt.
  await rows.nth(1)
    .getByRole('button', { name: 'Diese Seite lesen und Titel, Text und Herkunft ins Fundstück übernehmen' })
    .click();

  // `.first()`: die Karte fuehrt den Status-Block zweimal (Board + Detail-Dialog),
  // beide an dasselbe `errorMessage` gebunden.
  await expect(page.locator('#recherche-card .card-status--error').first())
    .toContainText('zeigt nicht ins offene Netz');

  // Das Fundstueck bleibt unangetastet: ein fehlgeschlagener Lesevorgang
  // schreibt nichts.
  const after = await page.evaluate(
    (id) => fetch(`/research?book_id=${id}`).then(r => r.json()), bookId,
  );
  const mine = after.find(i => i.id === item.id);
  expect(mine.title).toBe('Aus der Android-App geteilt');
  expect(mine.body ?? null).toBe(null);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});
