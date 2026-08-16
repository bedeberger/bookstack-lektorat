// Querverweise im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT (Begruendung wie notebook-cite.spec.js): der Paste-Filter
// laeuft auf `DOMParser` und braucht ein echtes Paste-Event; `contenteditable`
// ist eine Editing-Eigenschaft, die Chromium auswertet, nicht unser Code; und
// die Dirty-Erkennung vergleicht gemounteten Editor-DOM gegen Server-Stand —
// ein Fehler dort zeigt sich als „Seite gilt beim Oeffnen als geaendert" und ist
// nur in der gebooteten App mit echtem Save-Pfad sichtbar.
//
// Geprueft:
//   1. Verweis ueberlebt Speichern → Neuladen → Edit-Modus (Zeiger + Form + Text).
//   2. `contenteditable` landet NIE in der Persistenz.
//   3. Oeffnen + Speichern ohne Aenderung erzeugt keine neue Fassung.
//   4. Der Index (xref_links) folgt dem Save, Full-Replace inklusive.
//   5. Der Ziel-Picker fuegt am Caret ein (Range-API, kein execCommand).
//   6. Paste behaelt den Verweis und wirft fremde <span>-Huellen weg.
//   7. Abbildungen einer Seite werden als Ziel indiziert und im Picker angeboten.
//
// Konventionen wie notebook-cite.spec.js: Inhalt wird ANGEHAENGT (ein Save, der
// den Text auf < 20 % kuerzt, oeffnet den Bestaetigungsdialog), und jeder Test
// arbeitet auf einer eigenen Seite — die Smoke-DB lebt ueber den ganzen Lauf.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

async function boot(page) {
  await bootApp(page);
  await selectSeededBook(page);
}

async function openPageInEdit(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
}

async function appendAndSave(page, html) {
  await page.evaluate((h) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', h);
    for (const el of editEl.querySelectorAll('span.xref[data-xref-id]')) {
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

async function targets(page) {
  return page.evaluate(async () => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const r = await fetch(`/xrefs/targets?book_id=${bookId}`, { headers: { Accept: 'application/json' } });
    return r.json();
  });
}

async function backlinks(page, kind, target) {
  return page.evaluate(async ({ k, t }) => {
    const bookId = window.Alpine.store('nav').selectedBookId;
    const r = await fetch(`/xrefs/backlinks?book_id=${bookId}&kind=${k}&target=${encodeURIComponent(t)}`,
      { headers: { Accept: 'application/json' } });
    return r.json();
  }, { k: kind, t: target });
}

// Caret ans Ende eines frisch angehaengten Absatzes setzen.
async function appendParagraphAndFocus(page, id, text) {
  await page.evaluate(({ pid, txt }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', `<p id="${pid}">${txt}</p>`);
    const p = editEl.querySelector(`#${pid}`);
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { pid: id, txt: text });
}

test('Verweis ueberlebt Speichern und Wieder-Oeffnen, ohne Editor-Attribut zu persistieren', async ({ page }) => {
  await boot(page);
  const { chapters } = await targets(page);
  expect(chapters.length).toBeGreaterThan(0);
  const chId = chapters[0].target;

  await openPageInEdit(page, 0);
  await appendAndSave(page,
    `<p>Wie in <span class="xref" data-xref="chapter" data-xref-id="${chId}">Kapitel 1</span> gezeigt.</p>`);

  const saved = await serverHtml(page);
  expect(saved).toContain('data-xref="chapter"');
  expect(saved).toContain(`data-xref-id="${chId}"`);
  expect(saved).toContain('Kapitel 1');
  // Invariante 2.
  expect(saved).not.toContain('contenteditable');

  await page.reload();
  await boot(page);
  await openPageInEdit(page, 0);
  const ref = await page.evaluate(() => {
    const el = document.querySelector(`${'#editor-card .page-content-view--editing'} span.xref[data-xref-id]`);
    return el ? {
      kind: el.getAttribute('data-xref'), id: el.getAttribute('data-xref-id'),
      editable: el.getAttribute('contenteditable'), text: el.textContent,
    } : null;
  });
  expect(ref).not.toBeNull();
  expect(ref.kind).toBe('chapter');
  expect(ref.id).toBe(String(chId));
  expect(ref.editable).toBe('false');

  // Invariante 3: ohne den contenteditable-Strip in der Vergleichsform gaelte
  // jede Seite mit Verweis beim Oeffnen als geaendert und wuerde ungefragt eine
  // neue Fassung erzeugen.
  const before = await page.evaluate(() => window.__app.currentPage.updated_at);
  await page.evaluate(() => window.__app._markEditDirty());
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  const after = await page.evaluate(() => window.__app.currentPage.updated_at);
  expect(after).toBe(before);
});

test('Index folgt dem Save (Full-Replace)', async ({ page }) => {
  await boot(page);
  const { chapters } = await targets(page);
  const chId = chapters[0].target;

  await openPageInEdit(page, 1);
  await appendAndSave(page,
    `<p id="xref-idx">A <span class="xref" data-xref="chapter" data-xref-id="${chId}">Kapitel 1</span> `
    + `B <span class="xref" data-xref="chapter" data-xref-id="${chId}">Kapitel 1</span></p>`);

  const pageId = await page.evaluate(() => window.__app.currentPage.id);
  const back = await backlinks(page, 'chapter', chId);
  const mine = back.filter(b => b.page_id === pageId);
  expect(mine.length).toBe(1);
  expect(mine[0].count).toBe(2);

  // Verweise entfernen → Index-Zeile verschwindet.
  await openPageInEdit(page, 1);
  await page.evaluate(() => {
    document.querySelector('#editor-card .page-content-view--editing #xref-idx').innerHTML = 'A B ohne Verweise';
    window.__app._markEditDirty();
  });
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  const pid = await page.evaluate(() => window.__app.currentPage.id);
  expect((await backlinks(page, 'chapter', chId)).filter(b => b.page_id === pid).length).toBe(0);
});

test('Ziel-Picker fuegt einen Verweis am Caret ein', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 2);
  await appendParagraphAndFocus(page, 'xref-picker-target', 'Ein Satz');

  await page.evaluate(async () => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    await ctx.openXrefInput();
    ctx._commitXref(ctx.xrefHits[0]);
  });
  await page.waitForTimeout(200);

  const res = await page.evaluate(() => {
    const target = document.querySelector('#editor-card .page-content-view--editing #xref-picker-target');
    const el = target.querySelector('span.xref[data-xref-id]');
    return el ? {
      kind: el.getAttribute('data-xref'),
      editable: el.getAttribute('contenteditable'),
      text: el.textContent,
      dirty: window.__app.editDirty,
      styleAttrs: target.querySelectorAll('[style]').length,
      spans: target.querySelectorAll('span').length,
    } : null;
  });
  expect(res).not.toBeNull();
  expect(res.kind).toBe('chapter');
  expect(res.editable).toBe('false');
  expect(res.text).toMatch(/^Kapitel \d/);
  expect(res.dirty).toBe(true);
  // Regressionsschutz wie beim Beleg-Chip: mit `execCommand('insertHTML')`
  // schleust Chromium das Fragment durch seinen Editing-Sanitizer — `class`/
  // `data-*` fallen weg und die CSS-Werte landen als Inline-`style`. Deshalb
  // fuegt _commitXref ueber die Range-API ein.
  expect(res.styleAttrs).toBe(0);
  expect(res.spans).toBe(1);
});

test('Paste behaelt den Verweis und wirft fremde Span-Huellen weg', async ({ page, browserName }) => {
  // Nicht die App, sondern das Harness: Gecko ignoriert das dem
  // `ClipboardEvent`-Konstruktor uebergebene `DataTransfer` und liefert dem
  // Handler ein leeres Clipboard (`getData('text/html') === ''`), waehrend
  // Chromium es durchreicht. Der Paste-Pfad bekommt in Firefox also gar keine
  // Daten — die Invariante bleibt durch den Chromium-Lauf abgedeckt.
  test.skip(browserName === 'firefox', 'ClipboardEvent traegt in Gecko kein synthetisches DataTransfer');
  await boot(page);
  const { chapters } = await targets(page);
  const chId = chapters[0].target;

  await openPageInEdit(page, 3);
  await appendParagraphAndFocus(page, 'xref-paste-target', 'Ziel');

  await page.evaluate((id) => {
    const html = ` siehe <span class="xref" data-xref="chapter" data-xref-id="${id}">Kapitel 1</span>`
      + ' und <span style="font-family:Calibri" lang="DE">Fremdmarkup</span>';
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', ' siehe Kapitel 1 und Fremdmarkup');
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, chId);
  await page.waitForTimeout(300);

  const res = await page.evaluate(() => {
    const p = document.querySelector('#editor-card .page-content-view--editing #xref-paste-target');
    const el = p.querySelector('span.xref[data-xref-id]');
    return {
      refs: p.querySelectorAll('span.xref[data-xref-id]').length,
      otherSpans: p.querySelectorAll('span:not(.xref)').length,
      id: el ? el.getAttribute('data-xref-id') : null,
      hasStyleAttr: !!p.querySelector('[style]'),
      text: p.textContent,
    };
  });
  // Ohne die Paste-Allowlist zerfiele der Verweis zu einer toten Zahl, die beim
  // naechsten Umbau des Buchs nicht mehr mitnummeriert.
  expect(res.refs).toBe(1);
  expect(res.id).toBe(String(chId));
  expect(res.otherSpans).toBe(0);
  expect(res.hasStyleAttr).toBe(false);
  expect(res.text).toContain('Fremdmarkup');
});

test('Abbildung wird als Ziel indiziert und im Picker angeboten', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 4);

  // `data-bid` vergibt der Server am Schreib-Chokepoint (ensureBlockIds) — die
  // Abbildung wird also erst durch das Speichern zu einem verweisbaren Ziel.
  await appendAndSave(page,
    '<figure><img src="/icons.svg#quote" alt=""><figcaption>Der Kaefer</figcaption></figure>');

  const saved = await serverHtml(page);
  expect(saved).toMatch(/<figure[^>]*data-bid="[0-9a-f]+"/);

  const { figures } = await targets(page);
  const mine = figures.filter(f => f.title === 'Der Kaefer');
  expect(mine.length).toBe(1);
  expect(mine[0].target).toMatch(/^[0-9a-f]{8,32}$/);

  // Und der Picker bietet sie an. Caret setzen ist Pflicht: `openXrefInput`
  // sichert eine Range und steigt ohne Selektion sofort wieder aus.
  await openPageInEdit(page, 4);
  await appendParagraphAndFocus(page, 'xref-fig-caret', 'Satz');
  const hits = await page.evaluate(async () => {
    const ctx = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    await ctx.openXrefInput();
    const out = ctx.xrefHits.filter(h => h.kind === 'figure').map(h => h.title);
    ctx._closeXref();
    return out;
  });
  expect(hits).toContain('Der Kaefer');
});

test('Verweis erscheint in der Leseansicht', async ({ page }) => {
  await boot(page);
  const { chapters } = await targets(page);
  const chId = chapters[0].target;

  await openPageInEdit(page, 4);
  await appendAndSave(page,
    `<p id="xref-read">Gelesen <span class="xref" data-xref="chapter" data-xref-id="${chId}">Kapitel 1</span></p>`);

  await page.waitForSelector('#editor-card .page-content-view:not(.page-content-view--editing)', { timeout: 15000 });
  const inView = await page.evaluate((id) => {
    const view = document.querySelector('#editor-card .page-content-view:not(.page-content-view--editing)');
    return view ? view.querySelectorAll(`span.xref[data-xref-id="${id}"]`).length : -1;
  }, chId);
  expect(inView).toBe(1);
});
