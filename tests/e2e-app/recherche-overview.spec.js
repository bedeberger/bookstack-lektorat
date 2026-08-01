// Recherche-Board: Uebersicht (Anriss) vs. Detailansicht (Volltext lesen, darin
// bearbeiten) — gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Anriss-Cap ist eine CSS-Hoehen-
// Aussage (nur ein Browser mit dem VOLLEN Shell-CSS sieht, ob abgeschnitten wird),
// und der Dialog haengt am nativen <dialog>/Top-Layer-Verhalten, das kein Harness
// nachstellt. Der Smoke oeffnet die Karte, prueft aber kein Verhalten. Nichts
// gestubbt: Anlegen, Bild-Upload und Klicks laufen ueber die echten Routen.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Text, der den Listen-Cap in JEDER Spaltenbreite ueberschreitet.
const LONG_BODY = 'Im Landesarchiv liegen die Prozessakten in zwoelf Kartons. '.repeat(60);
// 8x8-PNG (rot) — laeuft durch dieselbe sharp-Pipeline (prepareCover) wie ein
// echter Upload, inklusive Magic-Bytes-Pruefung und JPEG-Normalisierung.
const PNG_8PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=';

test('recherche: Liste zeigt Anriss, Detailansicht zeigt Volltext und bleibt verknuepfbar', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const made = await page.evaluate(async ({ id, body, png }) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());

    const long = await post({ kind: 'note', title: 'Aktenlage', body });
    const withImg = await post({ kind: 'image', title: 'Grundrissplan' });

    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const up = await fetch(`/research/${withImg.id}/image`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bin,
    });
    const upBody = await up.json();
    return { long: long.id, img: withImg.id, upStatus: up.status, upBody };
  }, { id: bookId, body: LONG_BODY, png: PNG_8PX_B64 });
  // Ohne erfolgreichen Upload traegt das Item kein has_image und die Bild-
  // Zusicherung unten wuerde aus dem falschen Grund scheitern.
  expect(made.upStatus, JSON.stringify(made.upBody)).toBe(200);
  expect(made.upBody.has_image).toBe(true);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // ── Liste: Anriss, nicht Volltext ─────────────────────────────────────────
  const longItem = page.locator(`[data-research-id="${made.long}"]`);
  const teaser = longItem.locator('.research-item-text');
  await expect(teaser).toBeVisible();
  // Der Cap ist echt: gerenderte Hoehe bleibt unter der Inhaltshoehe. Und er ist
  // knapp — ein einzelner Fund darf die Uebersicht nicht auffuellen.
  const teaserBox = await teaser.evaluate(el => ({ h: el.getBoundingClientRect().height, full: el.scrollHeight }));
  expect(teaserBox.h).toBeLessThan(teaserBox.full);
  expect(teaserBox.h).toBeLessThan(100);
  // Vorschaubild bleibt klein und ist ein Button (kein Neuer-Tab-Link mehr).
  const thumb = page.locator(`[data-research-id="${made.img}"] button.research-item-thumb`);
  await expect(thumb).toBeVisible();
  expect(await thumb.locator('img').evaluate(el => el.getBoundingClientRect().height))
    .toBeLessThanOrEqual(96 + 1);

  // ── Detailansicht: Volltext, lesbar gesetzt ───────────────────────────────
  const dialog = page.locator('dialog.research-dialog:not(.research-dialog--create)');
  await longItem.locator('.research-item-title').click();
  await expect(dialog).toBeVisible();
  const detailText = dialog.locator('.research-dialog__text');
  // Ungekappt: die sichtbare Hoehe ist die volle Inhaltshoehe.
  const detail = await detailText.evaluate(el => ({
    h: el.getBoundingClientRect().height,
    full: el.scrollHeight,
    w: el.getBoundingClientRect().width,
    px: parseFloat(getComputedStyle(el).fontSize),
  }));
  expect(detail.h).toBeGreaterThanOrEqual(detail.full - 1);
  expect(detail.h).toBeGreaterThan(teaserBox.h * 3);
  // Lesetypografie: Lesegroesse und begrenzter Satzspiegel (nicht Panelbreite).
  expect(detail.px).toBeGreaterThanOrEqual(15);
  expect(detail.w).toBeLessThan(700);
  // Der Permalink zeigt aufs offene Fundstueck.
  expect(page.url()).toContain(`/recherche/${made.long}`);

  // ── Bearbeiten IM Dialog: Verknuepfen bleibt erreichbar ───────────────────
  await dialog.getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(dialog.locator('textarea.recherche-input--tall')).toBeVisible();
  // Genau der Regressionsfall: im Bearbeiten-Modus war die Verknuepfen-Aktion
  // vorher weg, weil Anzeige- und Formular-Zweig sich ausgeschlossen haben.
  await expect(dialog.locator('.research-dialog__foot button').first()).toBeVisible();
  await dialog.locator('.research-dialog__foot button').first().click();
  await expect(dialog.locator('.recherche-linkpicker')).toBeVisible();
  await dialog.locator('.recherche-linkpicker .btn-compact').last().click(); // Abbrechen
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();          // Edit verlassen
  await expect(detailText).toBeVisible();

  // ── Schliessen per ESC raeumt Dialog + Permalink ──────────────────────────
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Auf den Hash WARTEN, nicht sofort lesen: die Permalink-Spiegelung laeuft als
  // Alpine-Effekt nach dem close-Event (sonst flaky).
  await page.waitForFunction((id) => !location.hash.includes(`/recherche/${id}`), made.long);
  // Und die Seite ist wieder bedienbar (kein zurueckgebliebenes inertes Dokument).
  await expect(longItem.locator('.research-item-title')).toBeEnabled();

  // Aufraeumen: die App-Suite teilt eine DB, fremde Specs sollen die Fundstuecke
  // nicht mitzaehlen.
  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.long, made.img]);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});

// Anlegen laeuft im gleichen Dialog-Rahmen wie Bearbeiten und aus DEMSELBEN
// Felder-Fragment (recherche-form-fields.html). Der Feld-Vergleich unten ist die
// eigentliche Drift-Schranke: baut jemand das Anlegen-Formular wieder als eigene
// Kopie, weichen die Signaturen ab und dieser Test wird rot.
test('recherche: Anlegen im Modal — gleiche Felder wie im Bearbeiten-Modus', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  const createDlg = page.locator('dialog.research-dialog--create');
  const detailDlg = page.locator('dialog.research-dialog:not(.research-dialog--create)');

  // Kein Inline-Formular mehr: der Toolbar-Knopf zieht ein Modal auf.
  await expect(createDlg).toBeHidden();
  await page.locator('#recherche-card .card-toolbar > button.btn-compact').first().click();
  await expect(createDlg).toBeVisible();

  // Feld-Signatur des Anlegen-Formulars (Reihenfolge + Klassen + Platzhalter).
  const sig = (dlg) => dlg.locator('.recherche-form').first().evaluate((form) => [
    ...form.querySelectorAll('.recherche-kind-combo, input.recherche-input, textarea.recherche-input'),
  ].map(el => `${el.tagName}|${el.className}|${el.placeholder || ''}`));
  const createSig = await sig(createDlg);
  expect(createSig.length).toBeGreaterThan(3);

  await createDlg.locator('input.recherche-title-input').fill('Modal-Fund');
  await createDlg.locator('textarea.recherche-input').fill('Im Modal erfasst.');
  await createDlg.locator('.research-dialog__bar button.recherche-primary').click();

  // Gespeichert → Dialog zu, Eintrag in der Liste.
  await expect(createDlg).toBeHidden();
  const row = page.locator('.research-item', { hasText: 'Modal-Fund' }).first();
  await expect(row).toBeVisible();

  // Bearbeiten-Modus der Detailansicht: dieselben Felder, mit den Werten des Funds.
  await row.locator('.research-item-title').click();
  await expect(detailDlg).toBeVisible();
  await detailDlg.getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(detailDlg.locator('textarea.recherche-input--tall')).toBeVisible();
  expect(await sig(detailDlg)).toEqual(createSig);
  await expect(detailDlg.locator('input.recherche-title-input')).toHaveValue('Modal-Fund');
  await expect(detailDlg.locator('textarea.recherche-input')).toHaveValue('Im Modal erfasst.');

  // Schliessen raeumt beide Wege auf (kein inertes Dokument zurueck).
  await page.keyboard.press('Escape'); // verlaesst den Bearbeiten-Modus
  await page.keyboard.press('Escape'); // schliesst den Dialog
  await expect(detailDlg).toBeHidden();

  await page.evaluate(async (id) => {
    const rows = await fetch(`/research?book_id=${id}`).then(r => r.json());
    for (const r of rows) await fetch(`/research/${r.id}`, { method: 'DELETE' });
  }, bookId);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});
