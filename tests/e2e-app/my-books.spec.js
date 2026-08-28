// Buecherregal („Meine Buecher") gegen die ECHTE App.
//
// Warum diese Schicht: die drei Schalter der Karte schreiben in die DB und
// wirken an einer ANDEREN Stelle der Oberflaeche (Buchwahl-Combobox). Genau
// diese Kopplung kann kein Unit-Test zeigen — my-books-compute.test.mjs prueft
// die Ordnung, hier wird geprueft, dass der Klick ankommt, ueberlebt und die
// Buchwahl folgt.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

async function openShelf(page) {
  await page.evaluate(async () => {
    if (!window.__app.showMyBooksCard) await window.__app.toggleMyBooksCard();
  });
  await expect(page.locator('.card--mybooks')).toBeVisible();
  await expect(page.locator('.mybooks-table tbody tr').first()).toBeVisible();
}

// Zweites Buch anlegen: der Dev-Seed liefert nur eines, und die beiden
// interessanten Faelle (Pin sortiert nach oben, Archiv verschwindet aus der
// Buchwahl) brauchen zwei Zeilen. Wird am Ende der Spec wieder geloescht, damit
// die geteilte smoke.db fuer die uebrigen Specs unveraendert bleibt.
const TEMP_BOOK = 'zz-Regal-Testbuch';

async function ensureSecondBook(page) {
  const id = await page.evaluate(async (name) => {
    const existing = window.Alpine.store('nav').books.find(b => b.name === name);
    if (existing) return existing.id;
    const r = await fetch('/content/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error('Buch anlegen fehlgeschlagen: HTTP ' + r.status);
    return (await r.json()).id;
  }, TEMP_BOOK);
  await page.evaluate(() => window.__app.loadBooks({ fresh: true, skipPages: true }));
  await page.waitForFunction(
    (name) => (window.Alpine.store('nav').books || []).some(b => b.name === name),
    TEMP_BOOK,
    { timeout: 20000 },
  );
  return id;
}

async function removeSecondBook(page) {
  await page.evaluate(async (name) => {
    const b = (window.Alpine.store('nav').books || []).find(x => x.name === name);
    if (!b) return;
    await fetch('/content/books/' + b.id, { method: 'DELETE', credentials: 'same-origin' });
  }, TEMP_BOOK);
}

// Regal-Zustand fuer alle Buecher des Testkontos zuruecksetzen, damit die
// Reihenfolge der Specs keine Rolle spielt.
async function resetShelf(page) {
  await page.evaluate(async () => {
    const books = window.Alpine.store('nav').books || [];
    for (const b of books) {
      await fetch('/me/books/' + b.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pinned: false, archived: false }),
      });
      b.pinned = false;
      b.archived = false;
    }
  });
}

test('Regal oeffnet, zeigt eine Zeile je Buch und keine Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await resetShelf(page);
  await openShelf(page);

  const bookCount = await page.evaluate(() => window.Alpine.store('nav').books.length);
  await expect(page.locator('.mybooks-table tbody tr')).toHaveCount(bookCount);
  // Summenzeile nutzt die Kennzahl-Atome der Buch-Uebersicht.
  await expect(page.locator('.mybooks-summary .overview-substat').first()).toBeVisible();
  guard.assertClean('Regal geoeffnet');
});

test('Anheften ueberlebt den Reload und sortiert die Zeile nach oben', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await ensureSecondBook(page);
  await resetShelf(page);
  await openShelf(page);

  // Letzte Zeile anheften — sie muss danach die erste sein.
  const rows = page.locator('.mybooks-table tbody tr');
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);
  const lastName = (await rows.nth(count - 1).locator('.mybooks-book-name').innerText()).trim();

  await rows.nth(count - 1).locator('.mybooks-actions button').first().click();
  await expect(rows.first().locator('.mybooks-book-name')).toHaveText(lastName);

  // Neu laden: der Pin steht in book_shelf, nicht im Alpine-State.
  await bootApp(page);
  await selectSeededBook(page);
  await openShelf(page);
  await expect(page.locator('.mybooks-table tbody tr').first().locator('.mybooks-book-name'))
    .toHaveText(lastName);

  // ... und die Buchwahl-Combobox zeigt dieselbe Ordnung (pinned zuerst).
  const firstOption = await page.evaluate(() => window.__app.bookComboOptions()[0].label);
  expect(firstOption).toBe(lastName);

  await resetShelf(page);
  await removeSecondBook(page);
  guard.assertClean('Anheften');
});

test('Archivieren nimmt das Buch aus Reiter „In Arbeit" und aus der Buchwahl', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await ensureSecondBook(page);
  await resetShelf(page);
  await openShelf(page);

  const rows = page.locator('.mybooks-table tbody tr');
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);

  // Nicht das GEWAEHLTE Buch archivieren: das bleibt in seiner eigenen Auswahl
  // sichtbar (bewusste Ausnahme in bookComboOptions).
  const selectedId = await page.evaluate(() => String(window.Alpine.store('nav').selectedBookId));
  const targetIdx = await page.evaluate((sel) => {
    const books = window.Alpine.store('nav').books;
    const other = books.find(b => String(b.id) !== sel);
    return other ? other.name : null;
  }, selectedId);
  expect(targetIdx, 'ein zweites, nicht gewaehltes Buch').toBeTruthy();

  const row = rows.filter({ has: page.locator('.mybooks-book-name', { hasText: targetIdx }) }).first();
  await row.locator('.mybooks-actions button').nth(1).click(); // Archiv-Knopf

  // Im Reiter „In Arbeit" ist es weg, im Reiter „Archiviert" da.
  await expect(page.locator('.mybooks-table tbody tr')).toHaveCount(count - 1);
  await page.locator('.card--mybooks .tabs-btn').nth(2).click();
  await expect(page.locator('.mybooks-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.mybooks-row--archived')).toHaveCount(1);

  // Die Buchwahl kennt es nicht mehr.
  const labels = await page.evaluate(() => window.__app.bookComboOptions().map(o => o.label));
  expect(labels).not.toContain(targetIdx);

  await resetShelf(page);
  await removeSecondBook(page);
  guard.assertClean('Archivieren');
});
