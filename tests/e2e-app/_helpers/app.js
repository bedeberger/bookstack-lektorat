// Geteilte Helper fuer alle Specs gegen die ECHTE App (playwright.app.config.js).
//
// Boot-/Buchauswahl-Sequenz ist SSoT hier, nicht pro Spec kopiert: sie haengt an
// internen Root-/Store-Details (window.__app, Alpine.store('nav')), die sich beim
// Refactoring verschieben — dann bricht eine Stelle, nicht jede Spec.

// App-Boot abwarten: Alpine-Root in window.__app verfuegbar + Buecher geladen.
async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null,
    { timeout: 30000 },
  );
}

// Seed-Buch auswaehlen + Seiten laden (via Hash-Deeplink → _applyHash).
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId,
    { timeout: 20000 },
  );
  return bookId;
}

module.exports = { bootApp, selectSeededBook };
