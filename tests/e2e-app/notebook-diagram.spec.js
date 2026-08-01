// Diagramme im NOTEBOOK-Editor, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: die tragende Invariante des Features ist eine
// Persistenz-Aussage („nur der Quelltext steht in pages.content, nie das
// gerenderte Bild"), und die laesst sich nur pruefen, wenn ein echter Save-Pfad
// mit echtem Server-Cleaner dazwischen liegt. Dazu kommen zwei Eigenschaften,
// die Chromium auswertet und nicht unser Code: `contenteditable="false"` auf dem
// Block und die Dirty-Erkennung, die gemounteten Editor-DOM gegen den
// Server-Stand vergleicht — ein Fehler dort zeigt sich als „Seite gilt beim
// Oeffnen als geaendert".
//
// Geprueft:
//   1. Der Dialog setzt einen `pre.mermaid` mit dem eingegebenen Quelltext.
//   2. Gespeichert wird NUR der Quelltext — kein SVG, kein `contenteditable`.
//   3. Die Leseansicht rendert daneben ein SVG und blendet den Quelltext aus.
//   4. Oeffnen + Speichern ohne Aenderung erzeugt keine Scheinaenderung.
//   5. Der Quelltext zaehlt nicht als Prosa (page_stats-Woerter).
//
// Konventionen wie notebook-xref.spec.js: Inhalt wird ANGEHAENGT, und jeder Test
// arbeitet auf einer eigenen Seite — die Smoke-DB lebt ueber den ganzen Lauf.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const READ_SEL = '#editor-card .page-content-view:not(.page-content-view--editing)';
const CODE = 'flowchart TD\n  A[Ausgangslage] --> B[Folge]';

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

async function serverHtml(page) {
  return page.evaluate(async () => {
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return (await r.json()).html || '';
  });
}

// Diagramm ueber den echten Dialog einfuegen: leeren Absatz anhaengen, Dialog
// darauf oeffnen, Quelltext setzen, uebernehmen. Genau der Weg, den das
// Slash-Menue nimmt (`openDiagramDialog(block)`).
async function insertDiagramViaDialog(page, code) {
  await page.evaluate((c) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.insertAdjacentHTML('beforeend', '<p><br></p>');
    const block = editEl.lastElementChild;
    const card = window.Alpine.$data(document.querySelector('[x-data="editorToolbarCard"]'));
    card.openDiagramDialog(block);
    card.diagramSource = c;
    card.applyDiagram();
  }, code);
}

test('Diagramm: Dialog setzt den Block, gespeichert wird nur der Quelltext', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 0);
  await insertDiagramViaDialog(page, CODE);

  // 1. Block steht im Editor, atomar, mit dem eingegebenen Quelltext.
  const inEditor = await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing pre.mermaid');
    return el ? { code: el.textContent, editable: el.getAttribute('contenteditable') } : null;
  });
  expect(inEditor).not.toBeNull();
  expect(inEditor.code).toBe(CODE);
  expect(inEditor.editable).toBe('false');

  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  // 2. Persistenz: Quelltext ja, Editor-Attribut nein, Bild nein.
  // Attributreihenfolge nicht festnageln — `ensureBlockIds` setzt am
  // Write-Chokepoint zusätzlich ein `data-bid` auf den Block (Write-Path-
  // Invariante, Basis des Block-Level-Merge).
  const stored = await serverHtml(page);
  expect(stored).toMatch(/<pre\b[^>]*class="mermaid"/);
  expect(stored).toMatch(/<pre\b[^>]*\bdata-bid="/);
  expect(stored).toContain('flowchart TD');
  expect(stored).not.toContain('contenteditable');
  expect(stored).not.toContain('<svg');
  expect(stored).not.toContain('mermaid-render');
});

test('Diagramm: Leseansicht rendert daneben und blendet den Quelltext aus', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 1);
  await insertDiagramViaDialog(page, CODE);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  // Der Render-Knoten haengt NEBEN dem <pre>, nicht an seiner Stelle — der
  // Quelltext bleibt im DOM und ist damit weiterhin die Wahrheit.
  await page.waitForSelector(`${READ_SEL} .mermaid-render svg`, { timeout: 30000 });
  const shape = await page.evaluate((sel) => {
    const pre = document.querySelector(`${sel} pre.mermaid`);
    const host = pre?.nextElementSibling;
    return {
      preExists: !!pre,
      preHidden: !!pre && getComputedStyle(pre).display === 'none',
      hostIsSibling: !!host && host.classList.contains('mermaid-render'),
      hasSvg: !!host?.querySelector('svg'),
      // htmlLabels:false — ein <foreignObject> waere im Export unbrauchbar.
      hasForeignObject: !!host?.querySelector('foreignObject'),
    };
  }, READ_SEL);
  expect(shape).toEqual({
    preExists: true, preHidden: true, hostIsSibling: true, hasSvg: true, hasForeignObject: false,
  });

  // Der Render-Knoten darf beim erneuten Bearbeiten nicht in den Save-Pfad
  // geraten: im Edit-Modus wird der Quelltext gezeigt, das Bild verschwindet.
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  const inEdit = await page.evaluate(() => ({
    renders: document.querySelectorAll(`${'#editor-card .page-content-view--editing'} .mermaid-render`).length,
    pre: !!document.querySelector('#editor-card .page-content-view--editing pre.mermaid'),
  }));
  expect(inEdit).toEqual({ renders: 0, pre: true });

  // 4. Speichern ohne Aenderung darf keine Scheinaenderung erzeugen
  // (`contenteditable` ist Editor-Laufzeit und muss aus der Vergleichsform fallen).
  const dirty = await page.evaluate(() => window.__app.editDirty === true);
  expect(dirty).toBe(false);
});

test('Diagramm: der Quelltext zaehlt nicht als Prosa', async ({ page }) => {
  await boot(page);
  await openPageInEdit(page, 2);

  const before = await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    return window.__app.htmlToText
      ? window.__app.htmlToText(el.innerHTML)
      : el.textContent;
  });

  await insertDiagramViaDialog(page, CODE);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });

  // htmlToPlainText schneidet `pre.mermaid` heraus — sonst zaehlten `flowchart`
  // und `TD` als Woerter, gingen in die Satzlaengen des Rhythmus-Bands ein und
  // taeuchten im Wortschatz als Lieblingswoerter auf.
  const text = await page.evaluate(async () => {
    const mod = await import('/js/html-text.js');
    const id = window.__app.currentPage.id;
    const r = await fetch(`/content/pages/${id}`, { headers: { Accept: 'application/json' } });
    return mod.htmlToPlainText((await r.json()).html || '');
  });
  expect(text).not.toContain('flowchart');
  expect(text).not.toContain('Ausgangslage');
  expect(before.length > 0 ? text.length : 1).toBeGreaterThan(0);
});
