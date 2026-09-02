// Startbuch beim Aufruf der Stamm-URL — gegen die ECHTE App.
//
// Warum diese Schicht: die Regel selbst ist eine reine Funktion und in
// tests/unit/start-book.test.mjs gedeckt. Was dort NICHT geprueft werden kann,
// ist die Verdrahtung — dass der Boot den ungecachten Serverstand ueberhaupt
// holt und ihn VOR seiner Wahl abwartet. Genau diese Kette ist der Fehler, den
// man in der App als „es kommt ein Buch, an dem ich gar nicht gearbeitet habe"
// erlebt, und sie laeuft nur im echten Boot: `/config` → `loadBooks` →
// `GET /me/books/last-opened` → `pickStartBook` → `nav.selectedBookId`.
//
// Der lokale Merker wird in jedem Fall absichtlich auf das ANDERE Buch gesetzt.
// Wuerde die Server-Antwort fehlen oder zu spaet kommen, waere er die Antwort —
// der Test kann also nicht versehentlich gruen sein, weil localStorage zufaellig
// dasselbe sagt.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, reboot } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

// Der Dev-Seed liefert nur ein Buch; „welches von beiden" braucht zwei.
// Wird am Ende wieder geloescht, damit die geteilte smoke.db unveraendert bleibt.
const TEMP_BOOK = 'zz-Startbuch-Testbuch';

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

// Stempel setzen wie die App es tut (`PUT /me/books/:id/opened`), in fester
// Reihenfolge. Zwischen den Aufrufen liegt eine Server-Roundtrip-Latenz, und
// NOW_ISO_SQL hat Millisekunden-Aufloesung — die Stempel sind unterscheidbar.
async function touch(page, bookId) {
  const ok = await page.evaluate(async (id) => {
    const r = await fetch(`/me/books/${id}/opened`, { method: 'PUT', credentials: 'same-origin' });
    return r.ok;
  }, bookId);
  expect(ok, `touch ${bookId}`).toBe(true);
}

// Lokalen Rueckfall-Merker auf ein Buch stellen (Key-Form siehe
// public/js/local-prefs.js) — er darf die Server-Antwort nicht kippen.
async function setLocalFallback(page, bookId) {
  await page.evaluate(async (id) => {
    const email = window.Alpine.store('session').currentUser?.email || '';
    localStorage.setItem(`sw:lastBookId:${email}`, String(id));
  }, bookId);
}

// Auf das ENDE des Landing-Pfads warten (Editor oder Uebersicht offen), nicht
// nur auf die Buchwahl. Sonst laeuft die Wiederherstellung der letzten Seite
// noch, waehrend der Test schon den naechsten Stempel setzt — und `selectPage`
// stempelt selbst, womit der Test seine eigene Vorbereitung ueberschreiben
// wuerde.
async function settled(page) {
  await page.waitForFunction(
    () => window.__app.showEditorCard || window.__app.showBookOverviewCard,
    null,
    { timeout: 30000 },
  );
  return page.evaluate(() => String(window.Alpine.store('nav').selectedBookId));
}

// Stamm-URL frisch laden (Hash weg, EIN Dokument-Load) und die Wahl abwarten.
async function bootAtRoot(page) {
  await reboot(page);
  return settled(page);
}

test('Stamm-URL startet mit dem Buch des juengsten Server-Stempels', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await settled(page);
  const seedId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  const tempId = await ensureSecondBook(page);
  expect(String(tempId)).not.toBe(String(seedId));

  // Zuletzt das Temp-Buch offen gehabt, lokaler Merker zeigt aufs Seed-Buch.
  await touch(page, seedId);
  await touch(page, tempId);
  await setLocalFallback(page, seedId);
  expect(await bootAtRoot(page)).toBe(String(tempId));

  // Andere Richtung — sonst koennte der Test auch bestehen, wenn der Boot
  // schlicht immer das letzte Buch der Liste nimmt.
  await touch(page, seedId);
  await setLocalFallback(page, tempId);
  expect(await bootAtRoot(page)).toBe(String(seedId));

  guard.assertClean('Startbuch-Wahl');
});

test('ein archiviertes Buch wird nicht zum Startbuch', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await settled(page);
  const seedId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  const tempId = await ensureSecondBook(page);

  // Juengster Stempel auf dem Temp-Buch — aber archiviert. Es ist aus der
  // eigenen Liste geraeumt (und aus der Buchwahl-Combobox), also darf die App
  // dort nicht starten, sondern beim naechstbesten.
  await touch(page, seedId);
  await touch(page, tempId);
  await page.evaluate(async (id) => {
    await fetch(`/me/books/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ archived: true }),
    });
  }, tempId);
  await setLocalFallback(page, tempId);

  expect(await bootAtRoot(page)).toBe(String(seedId));
  guard.assertClean('Archiv-Ausschluss');
});

test.afterAll(async ({ browser }) => {
  // Temp-Buch wieder weg (seine Regal-Zeile faellt per CASCADE mit) und den
  // lokalen Merker leeren, damit die uebrigen Specs unveraenderte Verhaeltnisse
  // sehen.
  const page = await browser.newPage();
  try {
    await bootApp(page);
    await page.evaluate(async (name) => {
      const b = (window.Alpine.store('nav').books || []).find(x => x.name === name);
      if (b) await fetch('/content/books/' + b.id, { method: 'DELETE', credentials: 'same-origin' });
      const email = window.Alpine.store('session').currentUser?.email || '';
      localStorage.removeItem(`sw:lastBookId:${email}`);
    }, TEMP_BOOK);
  } finally {
    await page.close();
  }
});
