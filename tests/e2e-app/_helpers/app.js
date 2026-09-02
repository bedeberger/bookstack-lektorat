// Geteilte Helper fuer alle Specs gegen die ECHTE App (playwright.app.config.js).
//
// Boot-/Buchauswahl-Sequenz ist SSoT hier, nicht pro Spec kopiert: sie haengt an
// internen Root-/Store-Details (window.__app, Alpine.store('nav')), die sich beim
// Refactoring verschieben — dann bricht eine Stelle, nicht jede Spec.

// App-Boot abwarten: Alpine-Root in window.__app verfuegbar + Buecher geladen.
async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBooted(page);
}

// Warten, bis der Boot durch ist: Root da, Buchliste da, Buch gewaehlt.
// Getrennt von `bootApp`, weil ein Test auch OHNE `goto` neu booten kann
// (`reload()`) — und ein `reload()` mit direkt folgendem `goto()` waere eine
// zweite Navigation, die die noch laufenden Fetches des Reloads abbricht
// (i18n-Fetch → console.error → Console-Guard schlaegt zu). Ein Dokument-Load,
// dann warten.
async function waitBooted(page) {
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null,
    { timeout: 30000 },
  );
  // Auch auf die Buchwahl warten, nicht nur auf die Liste: das Startbuch faellt
  // eine Netzantwort spaeter (`GET /me/books/last-opened`, siehe
  // book/tree/load.js#pickStartBook). Ohne dieses Warten laufen Specs los,
  // waehrend `nav.selectedBookId` noch leer ist — und buchgebundene Karten
  // rendern dann nicht.
  await page.waitForFunction(
    () => !!window.Alpine.store('nav').selectedBookId,
    null,
    { timeout: 30000 },
  );
}

// Frischer Boot vom Server ohne zweite Navigation: Hash weg (sonst wendet der
// Hash-Router beim Start wieder die alte Ansicht an), dann EIN Dokument-Load.
async function reboot(page) {
  await page.evaluate(() => history.replaceState(null, '', '/'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitBooted(page);
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

module.exports = { bootApp, waitBooted, reboot, selectSeededBook };
