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
// Das Lese-Blatt. Ohne .page-view-wrap trifft der Selektor auch das
// contenteditable des Bearbeitungsmodus — und das steht im DOM zuerst.
const READ_SHEET = '#editor-card .page-view-wrap .page-content-view';

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

// Zurück in die Leseansicht. `cancelEdit` fragt nur bei ungespeicherten
// Änderungen nach — die Tests hier fassen den Fliesstext nicht an, der Dialog
// kommt also nicht.
//
// Gewartet wird auf den ZUSTAND, nicht auf das Verschwinden des Knotens: das
// contenteditable bleibt nach dem Teardown im DOM stehen und wird nur
// ausgeblendet (siehe den quickSave-Guard in editor/notebook/edit/lifecycle.js).
async function stopEdit(page) {
  await page.evaluate(() => window.__app.cancelEdit());
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await page.waitForSelector(READ_SHEET, { state: 'visible', timeout: 15000 });
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
    // Cursor steht nach dem Tippen noch im Feld, also darf der Wert nicht in der
    // DB stehen.
    //
    // Geprüft wird der WERT, nicht die Abwesenheit der Zeile: ein `toBe(null)`
    // setzte voraus, dass diese Seite noch nie einen Titel hatte — und derselbe
    // Seitenindex wird weiter unten vom Geometrie-Test beschrieben. Die Zusage
    // hängt an der Reihenfolge der Tests und an einer frischen DB, und beides
    // gilt nicht: `reuseExistingServer` lässt einen zweiten Lauf auf die
    // vollgeschriebene smoke.db des ersten treffen.
    await page.fill(`${HEAD} #page-head-dachzeile`, 'Politik · Bundeshaus');
    expect((await headlineOf(page, pageId))?.dachzeile).not.toBe('Politik · Bundeshaus');

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

    // DER SCHALTER LEBT NUR IN DER EDIT-TOOLBAR. Im Lesemodus gibt es ihn
    // bewusst nicht: dort wäre er eine Anzeige-Wahl ohne Wirkung auf den Text
    // und kostete einen Platz in einer Leiste, die auf eine Zeile passen soll
    // (Begründung im Markup, editor-page-actions.html). Seine WIRKUNG gilt
    // weiterhin für beide Modi — genau das prüft dieser Test, nur eben in der
    // Richtung, die es noch gibt: im Editor schalten, im Lesemodus nachsehen.
    await startEdit(page);
    await page.locator(`.page-editor-toolbar button[aria-label="${TIP_OFF}"]`).first().click();
    await expect(page.locator(HEAD)).toBeHidden();

    // … und der Zustand überlebt den Rückweg in die Leseansicht.
    await stopEdit(page);
    await expect(page.locator(HEAD)).toBeHidden();

    // Der Knopf holt ihn zurück — MIT Inhalt. Die Anzeige-Wahl darf nie die
    // Lade-Bedingung gewesen sein.
    await startEdit(page);
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

    // Zurücksetzen für die übrigen Tests dieser Datei — und zugleich die
    // Gegenprobe zum Reload: die Wahl liegt in den Editor-Prefs, nicht am
    // Beitrag, und lässt sich von dort wieder umlegen.
    await startEdit(page);
    await page.locator(`.page-editor-toolbar button[aria-label="${TIP_ON}"]`).first().click();
    await stopEdit(page);
    await expect(page.locator(`${HEAD} .page-head__title`)).toBeVisible();
  });

  // Der Kopf ist das obere Ende des Blatts, kein Block darüber. Diese Zusage
  // lebt ausschliesslich in der CSS-Kette der echten Shell (Lesebreite,
  // Seitenpadding, Schiene des Bearbeitungsmodus) — ein Fixture-Harness mit
  // Minimal-CSS könnte grün bleiben, während der Kopf im Editor wieder neben
  // dem Dokument steht. Darum hier und nicht in tests/e2e/.
  test('Kopf und Blatt sind EIN Bogen — gleiche Textkante, gleiche Breite, keine Fuge', async ({ page }) => {
    await setBuchtyp(page, 'journalismus');
    const pageId = await openPage(page, 1);
    await page.evaluate(async (id) => {
      // Der Aha-Hinweis des Lektorats rendert im Lesemodus zwischen Kopf und
      // Blatt und wäre eine echte Fuge. Einmaliger Erstkontakt-Hinweis, hier
      // weggeklickt, damit gemessen wird, was der Kopf verantwortet.
      localStorage.setItem('sw:ahaLektorat', '1');
      await fetch(`/headline/page/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dachzeile: 'Reportage', titel: 'Am Rand der Stadt', lead: 'Ein Nachmittag.' }),
      });
    }, pageId);
    await openPage(page, 0);
    await openPage(page, 1);
    // Der Kopf misst sich am Blatt — also erst messen, wenn das Blatt steht.
    // Es gibt ZWEI .page-content-view im Baum (Lese-Blatt und contenteditable);
    // der Lesemodus-Zweig hängt unter .page-view-wrap.
    await page.waitForSelector(READ_SHEET, { state: 'visible', timeout: 15000 });
    await expect(page.locator(`${HEAD} .page-head__title`)).toBeVisible();

    const box = async (sel) => {
      const b = await page.locator(sel).first().boundingBox();
      if (!b) throw new Error('nicht sichtbar: ' + sel);
      return b;
    };
    // Ein Pixel Toleranz: Sub-Pixel-Rundung, nicht Spielraum im Entwurf.
    const gleich = (a, b) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);

    // ── Leseansicht ──
    let head = await box(HEAD);
    let sheet = await box(READ_SHEET);
    gleich(head.x, sheet.x);
    gleich(head.width, sheet.width);
    gleich(head.y + head.height, sheet.y);          // keine Fuge an der Naht
    // Textkante: die Schlagzeile beginnt dort, wo der Fliesstext beginnt.
    gleich((await box(`${HEAD} .page-head__title`)).x,
           (await box(`${READ_SHEET} p`)).x);

    // ── Bearbeitungsmodus ──
    // Die 5px-Schiene ersetzt im Blatt den 1px-Rahmen und verschiebt die
    // Textkante; der Kopf muss dieselbe Schiene tragen, sonst fällt er hier
    // wieder heraus.
    await startEdit(page);
    head = await box(HEAD);
    sheet = await box('#editor-card .page-content-view--editing');
    gleich(head.x, sheet.x);
    gleich(head.width, sheet.width);
    gleich(head.y + head.height, sheet.y);
    gleich((await box(`${HEAD} #page-head-titel`)).x,
           (await box('#editor-card .page-content-view--editing p')).x);
  });

  test('im Roman gibt es den Knopf nicht', async ({ page }) => {
    // Er schaltete dort etwas, das gar nicht existiert.
    //
    // Geprüft wird nur die Edit-Toolbar: in der Lese-Kopfleiste steht der
    // Schalter seit 810f2e40 für KEINEN Buchtyp mehr, eine Zusicherung dort
    // wäre also immer wahr und unterschiede Roman und Ressort nicht — sie sähe
    // aus wie Abdeckung, ohne welche zu sein.
    await setBuchtyp(page, 'roman');
    await openPage(page, 0);
    await startEdit(page);
    await expect(page.locator(`.page-editor-toolbar button[aria-label="${TIP_OFF}"]`)).toBeHidden();
    await expect(page.locator(`.page-editor-toolbar button[aria-label="${TIP_ON}"]`)).toBeHidden();
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
