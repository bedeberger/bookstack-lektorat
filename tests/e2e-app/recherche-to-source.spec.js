// Recherche-Board → Quellen-Bibliothek: „diesen Link als Quelle uebernehmen"
// gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness oder Integration-Test: der Vertrag der
// Route ist in tests/integration/sources-import.test.js abgedeckt. Ungedeckt ist
// genau die Verdrahtung — der Button lebt in einem Fragment (`@include
// recherche-item-urls`) INNERHALB eines verschachtelten `x-for`, und Alpine wertet
// dessen Ausdruecke (`urlToSource`, `urlToSourceBusy`) nur aus, wenn ein
// Fundstueck mit Links da ist. Der Smoke oeffnet die Karte leer und sieht davon
// nichts; ein vertippter Methodenname faellt erst beim echten Klick auf.
//
// Nichts gestubbt: Fundstueck anlegen, Klick, Uebernahme und Quellenliste laufen
// ueber die echten Routen.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche: ein einzelner Link wird zur Quelle', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Die App-Suite teilt EINEN Server und EINE Wegwerf-DB (workers: 1), andere
  // Specs legen im selben Buch Quellen an — Pool leeren, sonst prueft die
  // Zaehlung fremde Zeilen mit.
  await page.evaluate(async () => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) await fetch(`/sources/${s.id}`, { method: 'DELETE' });
  });

  // Fundstueck mit ZWEI Links: der Testgegenstand ist, dass der geklickte
  // gewinnt und nicht der erste.
  const item = await page.evaluate(async (id) => {
    const r = await fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: id, kind: 'link', title: 'Prozessakten im Landesarchiv',
        urls: [
          { url: 'https://archiv.example.org/b44', label: 'Findbuch' },
          { url: 'https://digital.example.org/x', label: 'Digitalisat' },
        ],
      }),
    });
    return r.json();
  }, bookId);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  const rows = page.locator(`[data-research-id="${item.id}"] .research-item-url-row`);
  await expect(rows).toHaveCount(2);

  // Zweite Zeile uebernehmen.
  await rows.nth(1).getByRole('button', { name: 'Diesen Link als Quelle in die Bibliothek übernehmen' }).click();

  // Bestaetigung als Toast, kein Ansichtswechsel: das Board bleibt offen.
  await expect(page.locator('.job-toast')).toContainText('Als Quelle übernommen');
  await expect(page.locator('#recherche-card')).toBeVisible();

  // Genau eine Quelle, und zwar mit dem GEKLICKTEN Link.
  const saved = await page.evaluate((id) => fetch(`/sources?book_id=${id}`).then(r => r.json()), bookId);
  expect(saved).toHaveLength(1);
  expect(saved[0].url).toBe('https://digital.example.org/x');
  expect(saved[0].title).toBe('Prozessakten im Landesarchiv');
  expect(saved[0].csl_type).toBe('website');

  // Das Fundstueck bleibt unangetastet — die Notiz ist nicht der Nachweis.
  await expect(rows).toHaveCount(2);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});
