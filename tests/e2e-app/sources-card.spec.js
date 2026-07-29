// Quellen-Karte + Quellen-Tab der Bucheinstellungen gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: der Testgegenstand ist die Kette aus
// Karten-Registry (EXCLUSIVE_CARDS/Hash), echter /sources-API, sortableTable,
// typabhaengigem Formular und dem eigenen /citation-Schreibpfad der
// Bucheinstellungen. Der Smoke deckt davon nur „oeffnet ohne Konsolenfehler" ab.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('quellen: anlegen, filtern, bearbeiten, archivieren, loeschen, Fundstellen + Zitierstil', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Zwei Quellen via API anlegen (eine mit Koerperschaft).
  //
  // Vorher aufraeumen: die App-Suite fährt EINEN Server auf EINER Wegwerf-DB
  // (playwright.app.config.js, `workers: 1`), und notebook-cite.spec.js legt im
  // selben Seed-Buch eigene Quellen an. Diese Spec zaehlt aber exakte
  // Tabellenzeilen — ohne Reset haengt sie von der Spec-Reihenfolge ab und wird
  // rot, sobald eine andere Spec eine Quelle mehr erzeugt. Geloescht wird aus der
  // BIBLIOTHEK (nicht nur entknuepft), damit auch der Pool-Picker weiter unten
  // von einem bekannten Stand ausgeht.
  await page.evaluate(async (id) => {
    const post = (b) => fetch('/sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...b }),
    }).then(r => r.json());
    const pool = await fetch('/sources/pool?archived=1').then(r => r.json());
    for (const s of Array.isArray(pool) ? pool : []) {
      await fetch(`/sources/${s.id}`, { method: 'DELETE' });
    }
    await post({ csl_type: 'book', title: 'Die Verwandlung', year: '1915', place: 'Leipzig', publisher: 'Kurt Wolff', authors: [{ family: 'Kafka', given: 'Franz' }] });
    await post({ csl_type: 'article', title: 'Zur Lage', year: '2020', container_title: 'Merkur', volume: '12', pages: '44-51', authors: [{ literal: 'Bundesamt fuer Statistik' }] });
  }, bookId);

  await page.evaluate(() => { location.hash = location.hash.replace(/\/[^/]*$/, '') + '/quellen'; });
  await page.evaluate(async () => { await window.__app.toggleSourcesCard?.(); });
  await page.waitForFunction(() => document.querySelector('#sources-card')?.checkVisibility?.());
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 2);

  // Tabelle: Urheber-Spalte, Typ-Tag, Zitier-Badge „nicht zitiert".
  await expect(page.locator('.sources-cell-author').first()).toHaveText(/Bundesamt|Kafka/);
  await expect(page.locator('.sources-cite-badge--uncited')).toHaveCount(2);

  // Sortieren nach Titel.
  await page.locator('.sources-table th', { hasText: 'Titel' }).click();
  await expect(page.locator('.sources-title').first()).toHaveText('Die Verwandlung');

  // Filter auf Zeitschriftenaufsatz.
  await page.fill('#sources-card .filter-bar .filter-search-input', 'Merkur');
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(1);
  await page.click('#sources-card .filter-bar .search-clear--icon');
  await expect(page.locator('.sources-table tbody tr')).toHaveCount(2);

  // Bearbeiten: Formular oeffnet, typabhaengige Felder + Vorschau.
  await page.locator('.sources-title', { hasText: 'Die Verwandlung' }).click();
  await expect(page.locator('.sources-form')).toBeVisible();
  const preview = await page.locator('.sources-form .sources-preview').innerText();
  expect(preview).toContain('Kafka');
  expect(preview).toContain('1915');
  // Buch zeigt Verlag, aber kein Heft.
  await expect(page.locator('.sources-form .card-form-label', { hasText: /^Verlag$/ })).toHaveCount(1);
  await expect(page.locator('.sources-form .card-form-label', { hasText: /^Heft$/ })).toHaveCount(0);

  // Jahr aendern + speichern.
  const yearRow = page.locator('.sources-form .card-form-row').filter({ has: page.locator('.card-form-label', { hasText: /^Jahr$/ }) });
  await yearRow.locator('input').fill('1916');
  await page.locator('.sources-form-actions button.primary').click();
  await expect(page.locator('.sources-form')).toBeHidden();
  await page.waitForFunction(() => [...document.querySelectorAll('.sources-table tbody tr td')].some(td => td.textContent.trim() === '1916'));

  // Neu anlegen ueber das Formular.
  await page.locator('#sources-card .card-toolbar button.btn-compact').first().click();
  await expect(page.locator('.sources-form-title')).toHaveText('Neue Quelle');
  // Ohne Titel/Person kein Speichern.
  await expect(page.locator('.sources-form-actions button.primary')).toBeDisabled();
  const titleRow = page.locator('.sources-form .card-form-row').filter({ has: page.locator('.card-form-label', { hasText: /^Titel$/ }) });
  await titleRow.locator('input').first().fill('Testquelle');
  await expect(page.locator('.sources-form-actions button.primary')).toBeEnabled();
  await page.locator('.sources-form-actions button.primary').click();
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 3);

  // Archivieren → Zeile verschwindet, Schalter holt sie zurueck.
  // Aktionen ueber ihr aria-Label ansprechen, nicht ueber die Spaltenposition:
  // die Zeile traegt vier Aktionen (bearbeiten / archivieren / aus der Arbeit
  // entfernen / aus der Bibliothek loeschen), und drei davon sieht nur der
  // Besitzer — ein Index waere hier eine stille Fehlerquelle.
  const testRow = page.locator('.sources-table tbody tr').filter({ hasText: 'Testquelle' });
  await testRow.getByRole('button', { name: 'Archivieren', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 2);
  await page.check('#sources-card .filter-toggle input');
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 3);
  // x-show → alle drei Badges liegen im DOM, nur eines ist sichtbar.
  await expect(page.locator('.sources-archived-badge:visible')).toHaveCount(1);
  // Wieder aktiv schalten: archivierte Quellen bietet der Bibliotheks-Picker
  // bewusst nicht an, und genau der ist der naechste Testschritt.
  await testRow.getByRole('button', { name: 'Aus dem Archiv holen' }).click();
  await expect(page.locator('.sources-archived-badge:visible')).toHaveCount(0);

  // Aus der Arbeit entfernen: die Quelle verschwindet aus der Tabelle, bleibt
  // aber in der Bibliothek — der Picker bietet sie danach wieder an. Genau das
  // unterscheidet „entfernen" vom Loeschen und ist der Kern des Pool-Modells.
  await page.locator('.sources-table tbody tr').filter({ hasText: 'Testquelle' })
    .getByRole('button', { name: 'Aus dieser Arbeit entfernen' }).click();
  await page.locator('dialog[open] button', { hasText: 'Entfernen' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 2);

  await page.getByRole('button', { name: 'Aus Bibliothek', exact: true }).click();
  const pickerRow = page.locator('.sources-picker-item').filter({ hasText: 'Testquelle' });
  await expect(pickerRow).toHaveCount(1);
  // Zurueckholen: dieselbe id, keine Kopie.
  await pickerRow.getByRole('button', { name: 'Übernehmen' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 3);
  await expect(page.locator('.sources-picker-item').filter({ hasText: 'Testquelle' })).toHaveCount(0);

  // Loeschen mit Bestaetigung. `appConfirm` ist ein natives <dialog> (kein
  // window.confirm) — der Klick geht darum an den Dialog-Button, nicht an einen
  // Playwright-Dialog-Handler.
  await page.locator('.sources-table tbody tr').filter({ hasText: 'Testquelle' })
    .getByRole('button', { name: 'Aus Bibliothek löschen' }).click();
  await page.locator('dialog[open] button', { hasText: 'Löschen' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length === 2);
  await page.locator('.sources-picker .icon-btn').last().click();

  // Fundstellen-Panel: erst einen echten Beleg im Seitentext erzeugen (der
  // Fund-Index entsteht am Seiten-Write, nicht durch die Karte), dann das Badge
  // aufklappen und von dort in den Editor springen.
  const srcId = await page.evaluate(async () => {
    const list = await fetch('/sources?book_id=' + window.Alpine.store('nav').selectedBookId)
      .then(r => r.json());
    return list.find(s => s.title === 'Die Verwandlung').id;
  });
  await page.evaluate(async (id) => {
    const app = window.__app;
    await app.selectPage(window.Alpine.store('nav').pages[0]);
    app.startEdit();
    await new Promise(r => setTimeout(r, 300));
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.insertAdjacentHTML('beforeend',
      `<p>Belegsatz <span class="cite" data-src="${id}" data-loc="44" contenteditable="false">(Kafka, 1916, S. 44)</span> Ende.</p>`);
    app._markEditDirty();
    await app.saveEdit();
  }, srcId);
  await page.waitForFunction(() => window.__app.editMode === false);

  await page.evaluate(async () => { await window.__app.toggleSourcesCard(); });
  await page.waitForFunction(() => document.querySelectorAll('.sources-table tbody tr').length > 0);
  const cited = page.locator('.sources-cite-badge--cited');
  await expect(cited).toHaveCount(1);
  await expect(cited).toHaveText('1× zitiert');
  await cited.click();
  await expect(page.locator('.sources-citations')).toBeVisible();
  await expect(page.locator('.sources-citation')).toHaveCount(1);
  // Sprung zur Fundstelle öffnet den Notebook-Editor auf der Seite.
  await page.locator('.sources-citation-link').click();
  await page.waitForFunction(() => window.__app.showEditorCard === true && window.__app.showSourcesCard === false);

  // Bucheinstellungen → Quellen-Tab: Stil wechseln, Vorschau folgt, speichern.
  await page.evaluate(async () => { await window.__app.toggleBookSettingsCard(); });
  await page.locator('.card--settings .tabs-btn', { hasText: 'Quellen' }).click();
  const before = await page.locator('.card--settings .sources-preview').innerText();
  expect(before).toContain('Kafka');
  await page.locator('.card--settings .card-form-row').filter({ has: page.locator('.card-form-label', { hasText: 'Zitierstil' }) })
    .locator('.combobox-trigger').click();
  await page.locator('.combobox-option', { hasText: 'Numerisch' }).click();
  await expect.poll(async () => page.locator('.card--settings .sources-preview').innerText())
    .not.toBe(before);
  await page.check('#bs-bib-enabled');
  await page.locator('.card--settings .card-header button[data-label-ok]').click();
  await page.waitForFunction(async () => {
    const id = window.Alpine.store('nav').selectedBookId;
    const s = await fetch(`/booksettings/${id}`).then(r => r.json());
    return s.citation_style === 'numeric' && s.bibliography_enabled === 1;
  });

  expect(errors).toEqual([]);
});
