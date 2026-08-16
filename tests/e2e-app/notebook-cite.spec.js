// Beleg-Chip (Quellenverzeichnis) im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: die kritischen Zusagen des Chips lassen sich in keinem
// Fixture-Harness zeigen.
//   - Der Paste-Filter (`sanitizePasteHtml`) läuft auf `DOMParser` und wird von
//     einem echten Paste-Event getrieben.
//   - `contenteditable="false"` ist eine Editing-Eigenschaft: dass der Caret
//     den Chip überspringt und Backspace ihn ganz löscht, entscheidet Chromium,
//     nicht unser Code.
//   - Die Dirty-Erkennung vergleicht den gemounteten Editor-DOM (mit
//     Editor-Attribut) gegen den gespeicherten Stand (ohne). Ein Fehler dort
//     zeigt sich als „Seite gilt beim Öffnen als geändert" — sichtbar nur in
//     der gebooteten App mit echtem Save-Pfad.
//
// Geprüfte Invarianten:
//   1. Chip überlebt Speichern → Neuladen → Edit-Modus (Zeiger + Stelle + Text).
//   2. `contenteditable` landet NIE in der Persistenz.
//   3. Öffnen + Speichern ohne Änderung erzeugt keine neue Fassung
//      (`isNoChange` erkennt den Chip-Zustand als unverändert).
//   4. Backspace hinter dem Chip löscht ihn vollständig (kein halber Beleg).
//   5. Paste behält den eigenen Chip und wirft fremde <span>-Hüllen weg.
//   6. Der Fund-Index (source_citations) folgt dem Save.
//   7. Der Beleg-Picker fügt am Caret ein und markiert die Seite als geändert.
//   8. Eine Selektion wird belegt, nicht ersetzt (der Kurzbeleg landet dahinter).
//   9. Klick auf einen Chip öffnet den Picker auf ihm (Stelle/Zitat-Art zurück-
//      gelesen, verknüpfte Quelle vorne) und „Beleg entfernen" räumt ihn weg.
//
// Konventionen dieser Suite (übernommen von notebook-todo-readmode.spec.js):
//   - Inhalt wird ANGEHÄNGT, nie ersetzt: ein Save, der den Text auf < 20 %
//     kürzt, öffnet den Bestätigungsdialog und `saveEdit()` würde nie
//     zurückkehren.
//   - Jeder Test arbeitet auf einer eigenen Seite (`pageIdx`): die Smoke-DB
//     lebt über den ganzen Lauf, sonst stapeln sich die Belege übereinander.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

async function boot(page) {
  await bootApp(page);
  await selectSeededBook(page);
}

// Quelle im Testbuch anlegen und ihre id zurückgeben.
async function createSource(page, title) {
  return page.evaluate(async (t) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const res = await fetch('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: bookId, csl_type: 'book', title: t, year: '1915',
        authors: [{ family: 'Kafka', given: 'Franz' }],
      }),
    });
    return (await res.json()).id;
  }, title);
}

async function openPageInEdit(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

// Markup ans Seitenende anhängen (Chips atomar machen wie der Mount-Pfad) und
// speichern. Wartet, bis der Editor die Session verlassen hat.
async function appendAndSave(page, html) {
  await page.evaluate((h) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', h);
    for (const el of editEl.querySelectorAll('span.cite[data-src]')) {
      el.setAttribute('contenteditable', 'false');
    }
    window.__app._markEditDirty();
  }, html);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
}

async function serverHtml(page) {
  return page.evaluate(async () => {
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return (await r.json()).html || '';
  });
}

async function citationsOf(page, srcId) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/sources/${id}/citations`, { headers: { Accept: 'application/json' } });
    return r.json();
  }, srcId);
}

test('Chip überlebt Speichern und Wieder-Öffnen, ohne Editor-Attribut zu persistieren', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Die Verwandlung');
  await openPageInEdit(page, 0);

  await appendAndSave(page,
    `<p>Belegsatz <span class="cite" data-src="${srcId}" data-loc="44">(Kafka, 1915, S. 44)</span> Ende.</p>`);

  const saved = await serverHtml(page);
  expect(saved).toContain(`data-src="${srcId}"`);
  expect(saved).toContain('data-loc="44"');
  expect(saved).toContain('(Kafka, 1915, S. 44)');
  // Invariante 2: Editor-Laufzeit darf nicht in die Persistenz.
  expect(saved).not.toContain('contenteditable');

  // Neu laden und wieder in den Edit-Modus: der Chip muss atomar zurückkommen.
  await page.reload();
  await boot(page);
  await openPageInEdit(page, 0);
  const chip = await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing span.cite[data-src]');
    return el ? {
      src: el.getAttribute('data-src'), loc: el.getAttribute('data-loc'),
      editable: el.getAttribute('contenteditable'), text: el.textContent,
    } : null;
  });
  expect(chip).not.toBeNull();
  expect(chip.src).toBe(String(srcId));
  expect(chip.loc).toBe('44');
  expect(chip.editable).toBe('false');
  expect(chip.text).toBe('(Kafka, 1915, S. 44)');

  // Invariante 3: Speichern ohne Änderung muss als No-Op erkannt werden.
  // `stripLektoratMarks(editorHtml)` trägt am Chip `contenteditable="false"`,
  // der Server-Stand nicht — bleibt das Attribut in der Vergleichsform stehen,
  // schlägt `isNoChange` fehl und jedes Öffnen+Speichern erzeugt eine neue
  // Fassung und verschiebt `updated_at`.
  const before = await page.evaluate(() => window.__app.currentPage.updated_at);
  await page.evaluate(() => window.__app._markEditDirty());
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const after = await page.evaluate(() => window.__app.currentPage.updated_at);
  expect(after).toBe(before);
});

test('Backspace hinter dem Chip löscht ihn vollständig', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Loeschprobe');
  await openPageInEdit(page, 1);

  await page.evaluate((id) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend',
      `<p id="cite-probe">Satz <span class="cite" data-src="${id}">(Kafka, 1915)</span></p>`);
    for (const el of editEl.querySelectorAll('span.cite[data-src]')) {
      el.setAttribute('contenteditable', 'false');
    }
    const p = editEl.querySelector('#cite-probe');
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, srcId);

  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);

  // Invariante 4: kein halber Beleg — entweder ganz da oder ganz weg.
  const state = await page.evaluate(() => {
    const p = document.querySelector('#editor-card .page-content-view--editing #cite-probe');
    return { chips: p.querySelectorAll('span.cite').length, text: p.textContent.trim() };
  });
  expect(state.chips).toBe(0);
  expect(state.text).toBe('Satz');
});

test('Paste behält den eigenen Chip und wirft fremde Span-Hüllen weg', async ({ page, browserName }) => {
  // Nicht die App, sondern das Harness: Gecko ignoriert das dem
  // `ClipboardEvent`-Konstruktor uebergebene `DataTransfer` und liefert dem
  // Handler ein leeres Clipboard (`getData('text/html') === ''`), waehrend
  // Chromium es durchreicht. Der Paste-Pfad bekommt in Firefox also gar keine
  // Daten — die Invariante bleibt durch den Chromium-Lauf abgedeckt.
  test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
  await boot(page);
  const srcId = await createSource(page, 'Paste-Probe');
  await openPageInEdit(page, 2);

  await page.evaluate(() => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', '<p id="paste-target">Ziel</p>');
    const p = editEl.querySelector('#paste-target');
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });

  // Clipboard-HTML mit eigenem Chip + Word-typischer Span-Hülle.
  await page.evaluate((id) => {
    const html = ` mit <span class="cite" data-src="${id}" data-loc="9">(Kafka, 1915, S. 9)</span>`
      + ' und <span style="font-family:Calibri" lang="DE">Fremdmarkup</span>';
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', ' mit (Kafka, 1915, S. 9) und Fremdmarkup');
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, srcId);
  await page.waitForTimeout(300);

  const res = await page.evaluate(() => {
    const p = document.querySelector('#editor-card .page-content-view--editing #paste-target');
    const chip = p.querySelector('span.cite[data-src]');
    return {
      chips: p.querySelectorAll('span.cite[data-src]').length,
      otherSpans: p.querySelectorAll('span:not(.cite)').length,
      src: chip ? chip.getAttribute('data-src') : null,
      loc: chip ? chip.getAttribute('data-loc') : null,
      hasStyleAttr: !!p.querySelector('[style]'),
      text: p.textContent,
    };
  });
  // Invariante 5: Beleg wandert beim Kopieren mit (sonst wäre der Zeiger weg),
  // Fremdhüllen verlieren ihre Hülle, Text bleibt.
  expect(res.chips).toBe(1);
  expect(res.src).toBe(String(srcId));
  expect(res.loc).toBe('9');
  expect(res.otherSpans).toBe(0);
  expect(res.hasStyleAttr).toBe(false);
  expect(res.text).toContain('Fremdmarkup');
});

test('Fund-Index folgt dem Save', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Index-Probe');
  await openPageInEdit(page, 3);

  await appendAndSave(page,
    `<p id="idx-probe">A <span class="cite" data-src="${srcId}">(K, 1915)</span> B `
    + `<span class="cite" data-src="${srcId}">(K, 1915)</span></p>`);

  const cites = await citationsOf(page, srcId);
  expect(cites.length).toBe(1);
  expect(cites[0].count).toBe(2);

  // Belege entfernen → Fundstellen verschwinden (Full-Replace pro Save).
  await openPageInEdit(page, 3);
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing #idx-probe');
    el.innerHTML = 'A B ohne Belege';
    window.__app._markEditDirty();
  });
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  expect((await citationsOf(page, srcId)).length).toBe(0);
});

test('Beleg-Picker fügt einen Chip am Caret ein', async ({ page }) => {
  await boot(page);
  await createSource(page, 'Picker-Probe');
  await openPageInEdit(page, 4);

  await page.evaluate(() => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', '<p id="picker-target">Ein Satz</p>');
    const p = editEl.querySelector('#picker-target');
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });

  // Über den Toolbar-Scope: die Bubble braucht eine Selektion, der Picker-Pfad
  // selbst ist hier der Testgegenstand.
  await page.evaluate(async () => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    await ctx.openCiteInput();
    ctx.citeLoc = '44';
    ctx._commitCite(ctx.citeHits[0].src);
  });
  await page.waitForTimeout(200);

  const res = await page.evaluate(() => {
    const target = document.querySelector('#editor-card .page-content-view--editing #picker-target');
    const chip = target.querySelector('span.cite[data-src]');
    return chip ? {
      loc: chip.getAttribute('data-loc'), text: chip.textContent,
      editable: chip.getAttribute('contenteditable'), dirty: window.__app.editDirty,
      styleAttrs: target.querySelectorAll('[style]').length,
      spans: target.querySelectorAll('span').length,
    } : null;
  });
  expect(res).not.toBeNull();
  expect(res.loc).toBe('44');
  expect(res.text).toBe('(Kafka, 1915, S. 44)');
  expect(res.editable).toBe('false');
  expect(res.dirty).toBe(true);
  // Regressionsschutz: mit `execCommand('insertHTML')` schleust Chromium das
  // Fragment durch seinen Editing-Sanitizer — `class`/`data-*` fallen weg und
  // die CSS-Werte der Klasse landen als Inline-`style` im Text. Deshalb fügt
  // _commitCite über die Range-API ein.
  expect(res.styleAttrs).toBe(0);
  expect(res.spans).toBe(1);
});

test('Beleg-Picker ersetzt eine Selektion nicht, sondern belegt sie', async ({ page }) => {
  await boot(page);
  await createSource(page, 'Selektions-Probe');
  await openPageInEdit(page, 0);

  await page.evaluate(() => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', '<p id="sel-target">Kafka schrieb das</p>');
    const p = editEl.querySelector('#sel-target');
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(p);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });

  await page.evaluate(async () => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    await ctx.openCiteInput();
    ctx._commitCite(ctx.citeHits[0].src);
  });
  await page.waitForTimeout(200);

  // Der belegte Satz muss stehen bleiben: ein Kurzbeleg weist die Stelle NACH,
  // er ersetzt sie nicht (anders als der Linktext beim Link-Input). Vorher
  // löschte `range.deleteContents()` genau den markierten Satz.
  const res = await page.evaluate(() => {
    const t = document.querySelector('#editor-card .page-content-view--editing #sel-target');
    return {
      text: t.textContent,
      chips: t.querySelectorAll('span.cite[data-src]').length,
      chipAfterText: t.textContent.indexOf('Kafka schrieb das') === 0,
    };
  });
  expect(res.text).toContain('Kafka schrieb das');
  expect(res.chips).toBe(1);
  expect(res.chipAfterText).toBe(true);
});

test('Klick auf einen Chip öffnet den Picker auf ihm; Entfernen räumt ihn weg', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Klick-Probe');
  await openPageInEdit(page, 1);

  await page.evaluate((id) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend',
      `<p id="click-probe">Satz <span class="cite" data-src="${id}" data-loc="77">(Kafka, 1915, S. 77)</span></p>`);
    for (const el of editEl.querySelectorAll('span.cite[data-src]')) {
      el.setAttribute('contenteditable', 'false');
    }
  }, srcId);

  await page.click('#editor-card .page-content-view--editing #click-probe span.cite');
  await page.waitForFunction(() => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    return ctx.citeShow === true && ctx.citeLoading === false;
  }, null, { timeout: 15000 });

  const state = await page.evaluate(() => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    return { editing: ctx.citeEditing, loc: ctx.citeLoc, kind: ctx.citeKind, firstHit: ctx.citeHits[0]?.id };
  });
  expect(state.editing).toBe(true);
  // Stelle + Zitat-Art kommen aus dem Markup zurück …
  expect(state.loc).toBe('77');
  expect(state.kind).toBe('quote');
  // … und die verknüpfte Quelle steht ohne Suchbegriff vorne, damit Enter nicht
  // eine fremde Quelle trifft (die Liste ist auf CITE_MAX_HITS gedeckelt).
  expect(state.firstHit).toBe(srcId);

  await page.evaluate(() => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    ctx._removeCite();
  });
  const after = await page.evaluate(() => {
    const p = document.querySelector('#editor-card .page-content-view--editing #click-probe');
    return { chips: p.querySelectorAll('span.cite').length, text: p.textContent.trim(), dirty: window.__app.editDirty };
  });
  expect(after.chips).toBe(0);
  expect(after.text).toBe('Satz');
  expect(after.dirty).toBe(true);
});

test('Chip erscheint in der Leseansicht', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Leseansicht-Probe');
  await openPageInEdit(page, 4);
  await appendAndSave(page,
    `<p id="read-probe">Gelesen <span class="cite" data-src="${srcId}">(Kafka, 1915)</span></p>`);

  // appendAndSave verlässt den Edit-Modus → die Leseansicht rendert bereits.
  await page.waitForSelector('#editor-card .page-content-view:not(.page-content-view--editing)', { timeout: 15000 });
  const inView = await page.evaluate((id) => {
    const view = document.querySelector('#editor-card .page-content-view:not(.page-content-view--editing)');
    return view ? view.querySelectorAll(`span.cite[data-src="${id}"]`).length : -1;
  }, srcId);
  expect(inView).toBe(1);
});

test('Klick auf einen Chip in der Leseansicht schlägt die Quelle nach (und schliesst wieder)', async ({ page }) => {
  // Der Voll-Eintrag im Popover kommt aus der QUELLE, nicht aus dem Chip-Text:
  // der Chip trägt bewusst einen veralteten Kurzbeleg („Alt, 1900"), das Popover
  // muss trotzdem den aktuellen Stand zeigen (Text ist Cache, `data-src` ist die
  // Wahrheit).
  await boot(page);
  const srcId = await createSource(page, 'Popover-Probe');
  await openPageInEdit(page, 2);
  await appendAndSave(page,
    `<p id="popover-probe">Belegt <span class="cite" data-src="${srcId}" data-loc="44">(Alt, 1900, S. 44)</span></p>`);

  const chip = page.locator(`#editor-card .page-content-view:not(.page-content-view--editing) #popover-probe span.cite[data-src="${srcId}"]`);
  await expect(chip).toHaveCount(1);
  await chip.click();

  const popover = page.locator('.entity-popover.entity-popover--source');
  await expect(popover).toBeVisible();
  await expect(popover.locator('.entity-popover-name')).toHaveText('Kafka, Franz');
  // Voll-Eintrag im Zitierstil des Buchs, nicht der Chip-Text.
  await expect(popover.locator('.entity-popover-entry')).toContainText('Popover-Probe');
  await expect(popover.locator('.entity-popover-entry')).toContainText('1915');
  // Stellenangabe wird qualifiziert („44" → „S. 44").
  await expect(popover.locator('.entity-popover-tag:visible').first()).toHaveText('S. 44');
  // Genau eine sichtbare Aktion: ohne DOI/URL bleibt der Weg ins Verzeichnis.
  // (Die Aktionen der anderen `kind`-Varianten stehen im selben DOM, x-show-aus.)
  await expect(popover.locator('.entity-popover-link:visible')).toHaveCount(1);

  // Erneuter Klick auf denselben Chip schliesst (Toggle) — der mousedown-
  // Outside-Close darf den Anker vorher nicht wegräumen.
  await chip.click();
  await expect(popover).toBeHidden();

  // Der Klick bleibt beim Nachschlagen: keine Edit-Session, kein Picker.
  const state = await page.evaluate(() => ({
    editMode: window.__app.editMode,
    picker: window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]')).citeShow,
  }));
  expect(state.editMode).toBe(false);
  expect(state.picker).toBe(false);
});

test('Leseansicht: Chip einer aus dem Buch entfernten Quelle sagt es statt leer aufzugehen', async ({ page }) => {
  await boot(page);
  const srcId = await createSource(page, 'Verwaiste Probe');
  await openPageInEdit(page, 3);
  await appendAndSave(page,
    `<p id="orphan-probe">Verwaist <span class="cite" data-src="${srcId}">(Kafka, 1915)</span></p>`);

  // Quelle aus dem Buch entfernen (Pool-Eintrag bleibt) — der Marker steht noch
  // im Text. Der Cache des Popovers hängt an `sources:changed`, das der Unlink-
  // Pfad der Karte dispatcht; hier direkt, weil der Test die Route ruft.
  await page.evaluate(async (id) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    await fetch(`/sources/${id}/link?book_id=${bookId}`, { method: 'DELETE' });
    window.dispatchEvent(new CustomEvent('sources:changed', { detail: { bookId } }));
  }, srcId);

  await page.locator(`#editor-card .page-content-view:not(.page-content-view--editing) #orphan-probe span.cite[data-src="${srcId}"]`).click();
  const popover = page.locator('.entity-popover.entity-popover--source');
  await expect(popover).toBeVisible();
  await expect(popover.locator('.entity-popover-hint:visible')).toHaveCount(1);
  // Kein Weg ins Verzeichnis, wo die Quelle für dieses Buch nicht steht.
  await expect(popover.locator('.entity-popover-link:visible')).toHaveCount(0);
});
