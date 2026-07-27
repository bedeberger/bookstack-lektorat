// Full-SPA-Smoke gegen die echte App (siehe playwright.app.config.js).
//
// Zweck: Alpine-/Library-Laufzeitfehler abfangen, die Unit-/Integration-Tests
// nie sehen, weil sie kein Browser-DOM rendern, und die die Fixture-Harnesses
// nur fuer einzeln gemountete Karten abdecken. Hier laeuft der KOMPLETTE
// Template-Baum: jede Hauptkarte wird geoeffnet und alle drei Editoren
// (Notebook/Focus/Bucheditor) betreten. Tritt dabei irgendein unbehandelter
// Fehler auf (Alpine wirft Expression-Fehler asynchron via setTimeout →
// pageerror, plus console-Spur), schlaegt der Smoke fehl.
//
// Die Karten-Liste wird zur Laufzeit aus dem Root-Alpine-Proxy abgeleitet
// (alle `toggleXxxCard`-Methoden) — kein Drift gegen feature-registry.js:
// neue Karte ⇒ automatisch im Smoke.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

test('SPA bootet ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.waitForTimeout(500);
  guard.assertClean('Boot + Buchauswahl');
});

test('jede Hauptkarte oeffnet ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Toggle-Namen aus der Feature-Registry (SSoT EXCLUSIVE_CARDS) ziehen — kein
  // Drift, neue Karte ⇒ automatisch dabei. Nur Toggles, die am Root als
  // Funktion existieren (bespoke/admin inkl.).
  const toggles = await page.evaluate(async () => {
    const reg = await import('/js/cards/feature-registry.js');
    return reg.EXCLUSIVE_CARDS
      .map((c) => c.toggle)
      .filter((t) => typeof window.__app[t] === 'function')
      .sort();
  });
  expect(toggles.length, 'mind. eine Toggle-Karte gefunden').toBeGreaterThan(5);

  const failures = [];
  for (const name of toggles) {
    // Vorherige Karte schliessen, damit Exklusivitaet sauber durchlaeuft.
    await page.evaluate(() => window.__app._closeOtherMainCards?.(null));
    await page.waitForTimeout(80);
    const before = guard.unmatched().length;
    try {
      await page.evaluate((n) => Promise.resolve(window.__app[n]()), name);
    } catch (e) {
      failures.push(`${name}: toggle warf ${e.message}`);
      continue;
    }
    // Render + Lazy-Partial-Inject + Sub-Mount abwarten.
    await page.waitForTimeout(450);
    const fresh = guard.unmatched().slice(before);
    if (fresh.length) {
      failures.push(`${name}:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);
    }
  }

  expect(failures, `Karten mit Fehlern:\n${failures.join('\n')}`).toEqual([]);
});

test('alle drei Editoren oeffnen ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  const failures = [];

  // Notebook-Editor: erste Seite selektieren (selectPage → Editor-Modus).
  let before = guard.unmatched().length;
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForTimeout(500);
  let fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Notebook-Editor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  // Focus-Editor: Page-View-Direkteinstieg (realistischer Pfad aus der
  // gerade geoeffneten Seite; Trampoline-Event, editor-focus-card hoert darauf).
  before = guard.unmatched().length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForTimeout(600);
  fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Focus-Editor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  // Focus wieder verlassen + Bucheditor (Manuskript-Stream).
  before = guard.unmatched().length;
  await page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent('editor:focus:exit'));
    window.__app._closeOtherMainCards?.(null);
    await Promise.resolve(window.__app.toggleBookEditorCard());
  });
  await page.waitForTimeout(600);
  fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Bucheditor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  expect(failures, `Editoren mit Fehlern:\n${failures.join('\n')}`).toEqual([]);
});

// Anlege-Pfade gegen den ECHTEN Root + Alpine.store('nav') + Backend. Regress-
// Guard fuer den nav-store-Migrations-Skew: createKapitelPage() las frueher
// `root.pages` (existiert seit der Migration nicht mehr → „root.pages is not
// iterable"). Die Methoden laufen hier am realen Card-/Root-Scope, schreiben in
// den echten Store und treffen das echte /content-Backend (Wegwerf-DB).
test('neue Seite + neues Kapitel anlegen ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Kapitel-Bewertung oeffnen — _openKapitelReview() waehlt das erste eligible
  // Kapitel (Seed-Buch qualifiziert: 2 Kapitel, eines mehrseitig).
  await page.evaluate(() => window.__app.toggleKapitelReviewCard());
  await page.waitForFunction(
    () => document.querySelector('.card--kapitel') && window.__app.kapitelReviewChapterId,
    null,
    { timeout: 10000 },
  );

  // Neue Seite im Kapitel anlegen (Card-Methode am echten Scope).
  const pageResult = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--kapitel'));
    const store = window.Alpine.store('nav');
    const chapterId = window.__app.kapitelReviewChapterId;
    const chBefore = store.tree.find(
      (i) => i.type === 'chapter' && !i.solo && String(i.id) === String(chapterId),
    ).pages.length;
    const pagesBefore = store.pages.length;
    window.__app.newPageTitle = 'Smoke-Testseite';
    await card.createKapitelPage();
    const chItem = store.tree.find(
      (i) => i.type === 'chapter' && !i.solo && String(i.id) === String(chapterId),
    );
    return {
      pagesDelta: store.pages.length - pagesBefore,
      chapterPagesDelta: chItem.pages.length - chBefore,
      hasNew: store.pages.some((p) => p.name === 'Smoke-Testseite'),
      error: window.__app.newPageError,
    };
  });
  expect(pageResult.error, 'kein newPageError').toBeFalsy();
  expect(pageResult.pagesDelta, 'Seite in store.pages eingehaengt').toBe(1);
  expect(pageResult.chapterPagesDelta, 'Seite in Tree-Kapitel eingehaengt').toBe(1);
  expect(pageResult.hasNew, 'neue Seite per Name auffindbar').toBe(true);

  // Neues Geschwister-Kapitel anlegen (createSiblingChapter → root.createChapter).
  const chapterResult = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--kapitel'));
    const store = window.Alpine.store('nav');
    const isChapter = (i) => i.type === 'chapter' && !i.solo;
    const before = store.tree.filter(isChapter).length;
    window.__app.newChapterTitle = 'Smoke-Testkapitel';
    await card.createSiblingChapter();
    return {
      chaptersDelta: store.tree.filter(isChapter).length - before,
      hasNew: store.tree.some((i) => isChapter(i) && i.name === 'Smoke-Testkapitel'),
      error: window.__app.newChapterError,
    };
  });
  expect(chapterResult.error, 'kein newChapterError').toBeFalsy();
  expect(chapterResult.chaptersDelta, 'Kapitel im Tree eingehaengt').toBe(1);
  expect(chapterResult.hasNew, 'neues Kapitel per Name auffindbar').toBe(true);

  await page.waitForTimeout(300);
  guard.assertClean('Seite + Kapitel anlegen');
});
