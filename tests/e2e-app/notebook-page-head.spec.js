// Titel-Kopf des Beitrags im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Kopf ist buchtyp-gegatet und lebt in zwei
// `<template x-if>`-Zweigen. Der Smoke öffnet den Editor am Demo-Buch — das ist
// ein Roman, der Kopf bleibt dort also verborgen, und keine seiner
// Alpine-Expressions wird je ausgewertet. Genau das ist die Fehlerklasse, für
// die diese Suite existiert: Alpine schluckt Expression-Fehler in nicht
// gerenderten Templates vollständig.
//
// Geprüfte Zusagen:
//   1. Im Roman ist der Kopf nicht da (Gate greift), im Ressort schon.
//   2. Der Edit-Modus rendert alle drei Felder — und NICHT den Teaser.
//   3. Speichern läuft beim Verlassen des Feldes über PUT /headline/page/:id.
//   4. Der Kopf bewegt `pages.updated_at` NICHT — er steht in `page_headline`
//      und darf den Konflikt-/Stale-Pfad des Editors nicht anfassen.
//   5. Die Leseansicht zeigt den gespeicherten Stand nach einem Reload.
//   6. Das Zeichen-Lineal färbt sich, validiert aber nichts (zu lang wird
//      gespeichert).

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const HEAD = '#editor-card .page-head';

// Der Ein-/Aus-Knopf trägt den Zustand im aria-label (wie seine Geschwister in
// der Toolbar): sichtbarer Kopf → „ausblenden", verborgener → „einblenden".
// Aus den Locale-Dateien gelesen statt hier kopiert.
const DE = require(process.cwd() + '/public/js/i18n/de.json');
const TIP_OFF = DE['headline.head.off'];
const TIP_ON = DE['headline.head.on'];

async function setBuchtyp(page, buchtyp) {
  await page.evaluate(async (bt) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const res = await fetch(`/booksettings/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'de', region: 'CH', buchtyp: bt }),
    });
    if (!res.ok) throw new Error('booksettings PUT ' + res.status);
    // Der Buchtyp hängt am Buch-Objekt im nav-Store (currentBuchtyp liest von
    // dort) — nach dem PUT die Bücherliste neu ziehen, sonst greift das Gate
    // erst nach einem Reload.
    await window.__app.loadBooks();
  }, buchtyp);
}

// Seite per Index öffnen (jeder Test auf eigener Seite — die Smoke-DB lebt über
// den ganzen Lauf).
async function openPage(page, idx) {
  const pageId = await page.evaluate(async (i) => {
    const p = window.Alpine.store('nav').pages[i];
    await window.__app.selectPage(p);
    return p.id;
  }, idx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  return pageId;
}

async function startEdit(page) {
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector('#editor-card .page-content-view--editing', { timeout: 15000 });
}

async function headlineOf(page, pageId) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/headline/page/${id}`);
    return r.ok ? (await r.json()).headline : { __status: r.status };
  }, pageId);
}

test.describe('Notebook: Titel-Kopf des Beitrags', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
  });

  // Das Testbuch wird umgetypt; am Ende zurück auf den Ausgangszustand, damit
  // die übrigen Specs derselben DB einen Roman sehen.
  test.afterEach(async ({ page }) => {
    await setBuchtyp(page, 'roman').catch(() => {});
  });

  test('Gate: im Roman kein Kopf, im Ressort einer', async ({ page }) => {
    await setBuchtyp(page, 'roman');
    await openPage(page, 0);
    // Die Karte mountet immer (sie hängt am Editor-Partial), zeigt aber nichts:
    // das Gate sitzt in `headVisible()` als x-show, nicht als x-if — so kostet
    // der Buchtyp-Wechsel keinen Remount.
    await expect(page.locator(HEAD)).toBeHidden();

    await setBuchtyp(page, 'journalismus');
    await startEdit(page);
    await expect(page.locator(`${HEAD} .page-head__edit`)).toBeVisible();
  });

  test('drei Felder, kein Teaser — und Speichern beim Verlassen des Feldes', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const pageId = await openPage(page, 1);
    await startEdit(page);
    await expect(page.locator(`${HEAD} .page-head__edit`)).toBeVisible();

    // Alle drei Kopf-Felder da, der Teaser nicht: er ist der Anreisser für
    // Übersichten, nicht Teil des Beitrags.
    await expect(page.locator(`${HEAD} #page-head-dachzeile`)).toBeVisible();
    await expect(page.locator(`${HEAD} #page-head-titel`)).toBeVisible();
    await expect(page.locator(`${HEAD} #page-head-lead`)).toBeVisible();
    await expect(page.locator(`${HEAD} #page-head-teaser`)).toHaveCount(0);

    const stampBefore = await page.evaluate(() => window.__app.currentPage.updated_at);

    // Gespeichert wird beim VERLASSEN des Feldes, nicht bei jedem Anschlag: der
    // Cursor steht nach dem Tippen noch im Feld, also darf nichts in der DB sein.
    await page.fill(`${HEAD} #page-head-dachzeile`, 'Politik · Bundeshaus');
    expect(await headlineOf(page, pageId)).toBe(null);

    // Jeder Feldwechsel schreibt genau das verlassene Feld.
    await page.fill(`${HEAD} #page-head-titel`, 'Der lange Weg zum Referendum');
    await expect
      .poll(async () => (await headlineOf(page, pageId))?.dachzeile, { timeout: 5000 })
      .toBe('Politik · Bundeshaus');

    await page.fill(`${HEAD} #page-head-lead`, 'Nach zwei Jahren Streit steht der Termin.');
    await page.locator(`${HEAD} #page-head-dachzeile`).click();
    await expect
      .poll(async () => (await headlineOf(page, pageId))?.lead, { timeout: 5000 })
      .toBe('Nach zwei Jahren Streit steht der Termin.');

    // Teil-PUT: jedes Feld einzeln geschrieben, keines vom nächsten geleert.
    const row = await headlineOf(page, pageId);
    expect(row.dachzeile).toBe('Politik · Bundeshaus');
    expect(row.titel).toBe('Der lange Weg zum Referendum');
    expect(row.teaser).toBe(null);

    // Der Kopf steht in page_headline, nicht in pages.content: er darf den
    // Stempel der Seite nicht bewegen (daran hängt der Konflikt-/Stale-Pfad).
    const stampAfter = await page.evaluate(async () => {
      const id = window.__app.currentPage.id;
      const r = await fetch(`/content/pages/${id}`);
      return (await r.json()).updated_at;
    });
    expect(stampAfter).toBe(stampBefore);
  });

  test('Leseansicht zeigt den Stand nach einem Reload', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const pageId = await openPage(page, 2);
    await page.evaluate(async (id) => {
      await fetch(`/headline/page/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dachzeile: 'Kultur', titel: 'Ein Abend im Depot', lead: 'Was blieb.' }),
      });
    }, pageId);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootApp(page);
    await selectSeededBook(page);
    await openPage(page, 2);

    await expect(page.locator(`${HEAD} .page-head__kicker`)).toHaveText('Kultur');
    await expect(page.locator(`${HEAD} .page-head__title`)).toHaveText('Ein Abend im Depot');
    await expect(page.locator(`${HEAD} .page-head__lead`)).toHaveText('Was blieb.');
  });

  test('der heading-Knopf blendet den Kopf aus — in beiden Modi und über den Reload', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const pageId = await openPage(page, 4);
    await page.evaluate(async (id) => {
      await fetch(`/headline/page/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dachzeile: 'Sport', titel: 'Ein Satz zu viel', lead: 'Kurz.' }),
      });
    }, pageId);
    await openPage(page, 0);
    await openPage(page, 4);
    await expect(page.locator(`${HEAD} .page-head__title`)).toBeVisible();

    // Lese-Kopfleiste: der Knopf ist da (die Edit-Toolbar gibt es hier nicht).
    const readBtn = page.locator(`#editor-card .card-actions button[aria-label="${TIP_OFF}"]`);
    await readBtn.click();
    await expect(page.locator(HEAD)).toBeHidden();

    // Der Zustand gilt auch im Bearbeitungsmodus …
    await startEdit(page);
    await expect(page.locator(HEAD)).toBeHidden();

    // … und der Knopf der Edit-Toolbar holt ihn zurück — MIT Inhalt. Die
    // Anzeige-Wahl darf nie die Lade-Bedingung gewesen sein.
    await page.locator(`.page-editor-toolbar button[aria-label="${TIP_ON}"]`).first().click();
    await expect(page.locator(`${HEAD} #page-head-titel`)).toHaveValue('Ein Satz zu viel');

    // Wieder aus, und über den Reload hinweg aus (editorPrefs).
    await page.locator(`.page-editor-toolbar button[aria-label="${TIP_OFF}"]`).first().click();
    await expect(page.locator(HEAD)).toBeHidden();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootApp(page);
    await selectSeededBook(page);
    await openPage(page, 4);
    await expect(page.locator(HEAD)).toBeHidden();

    // Zurücksetzen für die übrigen Tests dieser Datei.
    await page.locator(`#editor-card .card-actions button[aria-label="${TIP_ON}"]`).click();
    await expect(page.locator(`${HEAD} .page-head__title`)).toBeVisible();
  });

  test('im Roman gibt es den Knopf nicht', async ({ page }) => {
    // Er schaltete dort etwas, das gar nicht existiert.
    await setBuchtyp(page, 'roman');
    await openPage(page, 0);
    await expect(page.locator(`#editor-card .card-actions button[aria-label="${TIP_OFF}"]`)).toBeHidden();
    await startEdit(page);
    await expect(page.locator(`.page-editor-toolbar button[aria-label="${TIP_OFF}"]`)).toBeHidden();
  });

  test('das Zeichen-Lineal färbt, sperrt aber nicht', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const pageId = await openPage(page, 3);
    await startEdit(page);
    await expect(page.locator(`${HEAD} .page-head__edit`)).toBeVisible();

    const zulang = 'Sehr ' + 'lange '.repeat(20) + 'Schlagzeile';
    await page.fill(`${HEAD} #page-head-titel`, zulang);
    // Ein zu langer Titel ist ein unfertiger Titel, kein Fehler: die Anzeige
    // warnt, das Speichern läuft trotzdem.
    await expect(page.locator(`${HEAD} .page-head__field--titel .page-head__count`))
      .toHaveClass(/page-head__count--zulang/);
    await page.locator(`${HEAD} #page-head-dachzeile`).click();
    await expect
      .poll(async () => (await headlineOf(page, pageId))?.titel, { timeout: 5000 })
      .toBe(zulang);
  });
});
