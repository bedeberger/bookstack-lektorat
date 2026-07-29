// Quellen-Erkennung (Panel in der Quellen-Karte) gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Testgegenstand ist die Kette aus
// Panel-Fragment (`@include sources-detect`), Alpine-Markup der Fundliste, dem
// echten Uebernehmen ueber POST /sources und der Lauf-Historie. Der Smoke deckt
// davon nichts ab — das Panel ist zugeklappt, und Alpine wertet die Ausdruecke
// innerhalb eines leeren `x-for` nie aus.
//
// Der JOB selbst wird gestubbt (page.route): sein Verhalten ist in
// tests/integration/source-detect*.test.js abgedeckt, und die App-Suite hat kein
// Modell. Alles danach — Rendern, Uebernehmen, Historie — laeuft echt.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const JOB_ID = 'stub-source-detect';

// Zwei Funde, die die beiden Zustaende abdecken, die die Karte unterscheiden
// muss: im Register bestaetigt (mit Metadaten) und nur aus dem Text (ohne).
const FUNDE = [
  {
    csl_type: 'book', title: 'Die Struktur wissenschaftlicher Revolutionen',
    authors: [{ family: 'Kuhn', given: 'Thomas S.' }], year: '1962',
    container_title: null, publisher: 'Suhrkamp', place: 'Frankfurt',
    edition: null, volume: null, issue: null, pages: null,
    doi: null, isbn: '9783518276259', issn: null, url: null,
    erwaehnung: 'Schon Kuhn hat gezeigt, dass Paradigmen springen.',
    page_id: null, page_name: null, chapter_name: 'Einleitung',
    verified: true, register: 'openlibrary',
    existing_source_id: null, existing_linked: false,
  },
  {
    csl_type: 'article', title: 'Ein unauffindbarer Aufsatz',
    authors: [{ family: 'Meier' }], year: null,
    container_title: 'Zeitschrift fuer Unbekanntes',
    publisher: null, place: null, edition: null, volume: null, issue: null, pages: null,
    doi: null, isbn: null, issn: null, url: null,
    erwaehnung: 'Meier schreibt dazu in seinem Aufsatz.',
    page_id: null, page_name: null, chapter_name: null,
    verified: false, register: null,
    existing_source_id: null, existing_linked: false,
  },
];

const RUN_ROW = {
  id: 4711, book_id: 0, user_email: 'dev@local', scope: 'book', scope_chapter_id: null,
  scope_chapter_name: null, created_at: '2026-07-01T09:00:00.000Z',
  found_count: 2, verified_count: 1, model: 'stub',
};

test('quellen-erkennung: Panel, Funde, Uebernehmen, Lauf-Historie', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Job + Historie stubben. Bewusst eng gefasste Muster statt `**/jobs/**`:
  // die App pollt im Hintergrund `/jobs/queue` und `/jobs/active`, und die
  // sollen unangetastet echt bleiben.
  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  });

  await page.route('**/jobs/source-detect', (route) => json(route, { jobId: JOB_ID }));
  await page.route('**/jobs/source-detect/runs?**', (route) => json(route, [RUN_ROW]));
  await page.route(`**/jobs/source-detect/runs/${RUN_ROW.id}`, (route) => json(route, {
    ...RUN_ROW, result: { vorschlaege: FUNDE },
  }));
  await page.route(`**/jobs/${JOB_ID}`, (route) => json(route, {
    id: JOB_ID, type: 'source-detect', status: 'done', progress: 100,
    result: { vorschlaege: FUNDE, verified: 1, lookupSkipped: 0, scopeName: null, runId: RUN_ROW.id },
  }));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Pool leeren: die App-Suite teilt EINEN Server und EINE Wegwerf-DB
  // (playwright.app.config.js, `workers: 1`), andere Specs legen im selben Buch
  // Quellen an. Diese Spec prueft „Fund ist neu" und braeuchte sonst Glueck.
  await page.evaluate(async () => {
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) await fetch(`/sources/${s.id}`, { method: 'DELETE' });
  });

  // Hash direkt aus der Buch-ID bauen statt das letzte Segment zu ersetzen:
  // nach `selectSeededBook` haengt es vom Timing ab, ob die Buchuebersicht ihr
  // `/uebersicht` schon angehaengt hat.
  await page.evaluate((id) => { location.hash = `#book/${id}/quellen`; }, bookId);
  await expect(page.locator('#sources-card')).toBeVisible();

  // Panel oeffnen.
  await page.getByRole('button', { name: 'Erwähnte Werke finden' }).first().click();
  const panel = page.locator('.sources-detect');
  await expect(panel).toBeVisible();

  // Lauf starten (gestubbt) → beide Funde erscheinen.
  await panel.getByRole('button', { name: 'Text durchsuchen' }).click();
  const items = panel.locator('.sources-detect-item');
  await expect(items).toHaveCount(2);

  // Der bestaetigte Fund traegt das Register-Badge, der andere den
  // Ungeprueft-Hinweis — genau die Unterscheidung, die den User schuetzt.
  await expect(items.nth(0)).toContainText('Die Struktur wissenschaftlicher Revolutionen');
  await expect(items.nth(0).locator('.badge-ok')).toHaveText('bestätigt');
  await expect(items.nth(1)).toContainText('ungeprüft');
  // Autoren-/Jahr-Zeile und die woertliche Fundstelle stehen an der Karte.
  await expect(items.nth(0)).toContainText('Kuhn, 1962');
  await expect(items.nth(0)).toContainText('Paradigmen springen');

  // Uebernehmen laeuft ueber den ECHTEN /sources-Schreibpfad.
  await items.nth(0).getByRole('button', { name: 'Übernehmen' }).click();
  await expect(items).toHaveCount(1);
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.sources-table tbody tr').first()).toContainText('Kuhn');

  // Die Registerdaten sind mitgekommen — nicht nur Titel und Autor.
  const saved = await page.evaluate(async (id) => {
    const rows = await fetch(`/sources?book_id=${id}`).then(r => r.json());
    return rows[0];
  }, bookId);
  expect(saved.isbn).toBe('9783518276259');
  expect(saved.publisher).toBe('Suhrkamp');

  // Lauf-Historie: der frische Lauf steht in der Liste und ist als offener
  // markiert (er liegt ja gerade im Vorschlagsfeld).
  const runs = panel.locator('.sources-detect-run');
  await expect(runs).toHaveCount(1);
  await expect(runs.first()).toContainText('2 Funde, 1 bestätigt');
  await expect(runs.first()).toHaveClass(/sources-detect-run--active/);

  // Klick auf den offenen Lauf klappt ihn zu, der naechste holt ihn vom Server
  // zurueck. Dass der Server dabei den Bibliotheks-Status neu rechnet, prueft
  // tests/integration/source-detect-runs.test.js — hier ist die Route gestubbt.
  const runBtn = runs.first().locator('.sources-detect-run-open');
  await runBtn.click();
  await expect(items).toHaveCount(0);
  await runBtn.click();
  await expect(items).toHaveCount(2);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});
