// Löschen an den Grenzen formatierter Blöcke im NOTEBOOK-Editor, gegen die
// ECHTE App: `figure`/`img`/`figcaption`, `blockquote`, `div.poem`, `pre`,
// `ul`/`ol`. Schwesterspec zu notebook-todo-delete.spec.js (Checkbox-Listen).
//
// WARUM DIESE SCHICHT: Testgegenstand ist das Ersetzen des nativen
// contenteditable-Löschverhaltens. In linkedom/jsdom gibt es keinen
// Editing-Default — dort wäre jeder nicht abgefangene Tastendruck automatisch
// ein No-Op und die Regression unsichtbar. Nur ein echter Browser zeigt, dass
// Chromium beim Merge über eine Blockgrenze die BERECHNETEN CSS-Werte des
// Quellblocks als Inline-`style` einbäckt.
//
// WARUM DAS ZÄHLT: `cleanPageHtml` strippt `style`-Attribute nicht — der Müll
// wird persistiert, geht in jeden Export mit, und die eingebrannten
// Light-Mode-Farben (`rgb(120,112,104)` …) sind im Dark-Mode falsch. Ein
// Inline-`style` verstösst zudem gegen die harte Regel „Styles nur in
// public/css" ([CLAUDE.md](../../CLAUDE.md)).
//
// Geprüfte Invarianten (public/js/editor/notebook/toolbar/keydown.js):
//   1. Kein Tastendruck erzeugt je ein `style`-Attribut.
//   2. Kein `<figure>` verliert sein `<img>` (Void-Element = Struktur, wie die
//      Checkbox in `ul.todo`).
//   3. Backspace am Anfang des ersten Kind-Blocks verlässt den Wrapper.
//   4. Merges INNERHALB eines Wrappers bleiben beim Default (die sind sauber).
//   5. Über die Wrapper-Grenze verschwindet kein Block spurlos.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
// 1x1-GIF als data-URI: der Test braucht kein echtes Asset, nur ein <img>.
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const FIG_EMPTY = `<p>Vorher</p><figure><img src="${PX}" alt=""><figcaption><br></figcaption></figure><p>Nachher</p>`;
const FIG = `<p>Vorher</p><figure><img src="${PX}" alt=""><figcaption>Legende</figcaption></figure><p>Nachher</p>`;
const POEM = '<p>Vorher</p><div class="poem"><p>Zeile eins</p><p>Zeile zwei</p></div><p>Nachher</p>';
const BQ = '<p>Vorher</p><blockquote><p>Zitat</p></blockquote><p>Nachher</p>';
const PRE = '<p>Vorher</p><pre>code hier</pre><p>Nachher</p>';
const UL = '<p>Vorher</p><ul><li>Eins</li><li>Zwei</li></ul><p>Nachher</p>';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// `target` ist ein CSS-Selector, oder '@firstP'/'@lastP' für den Top-Level-
// Absatz vor/nach dem Wrapper (`:last-of-type` wäre falsch — das matcht auch
// innerhalb von .poem/blockquote).
async function seed(page, html, target, pos) {
  await page.evaluate(({ html, target, pos }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.innerHTML = html;
    const tops = editEl.querySelectorAll(':scope > p');
    const el = target === '@firstP' ? tops[0]
      : target === '@lastP' ? tops[tops.length - 1]
      : editEl.querySelector(target);
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(pos === 'start');
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, pos });
}

function readHtml(page) {
  return page.evaluate(() => document
    .querySelector('#editor-card .page-content-view--editing')
    .innerHTML.replace(/ data-bid="[^"]*"/g, '')
    .replace(/data:image\/gif;base64,[^"]*/g, 'PX'));
}

// Invarianten 1 + 2 — gelten nach JEDEM Tastendruck, fallunabhängig.
async function expectStructureIntact(page, label) {
  const bad = await page.evaluate(() => {
    const e = document.querySelector('#editor-card .page-content-view--editing');
    return {
      styled: e.querySelectorAll('[style]').length,
      nakedFig: e.querySelectorAll('figure:not(:has(img))').length,
    };
  });
  expect(bad.styled, `${label}: kein Inline-style-Attribut`).toBe(0);
  expect(bad.nakedFig, `${label}: kein figure ohne img`).toBe(0);
}

// Ein Tastendruck, ein erwartetes Ergebnis. `expected === null` heisst: No-Op,
// das Dokument darf sich nicht verändern.
const CASES = [
  // ── figure: Void-Element-Schutz (Zwilling des Checkbox-Falls) ──────────────
  { label: 'figure, leere Legende: BS entfernt Bild+Rahmen in einem Druck',
    html: FIG_EMPTY, target: 'figcaption', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p><br></p><p>Nachher</p>' },
  { label: 'figure, Legende mit Text: BS am Anfang ist No-Op (erst Text löschen)',
    html: FIG, target: 'figcaption', pos: 'start', key: 'Backspace', expected: null },
  { label: 'figure: Delete am Legenden-Ende zieht den Folgeabsatz nicht herein',
    html: FIG, target: 'figcaption', pos: 'end', key: 'Delete', expected: null },
  { label: 'figure: BS im Absatz danach löscht das figure (wie <hr>)',
    html: FIG, target: '@lastP', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p>Nachher</p>' },
  { label: 'figure: Delete im Absatz davor löscht das figure',
    html: FIG, target: '@firstP', pos: 'end', key: 'Delete',
    expected: '<p>Vorher</p><p>Nachher</p>' },

  // ── div.poem ───────────────────────────────────────────────────────────────
  { label: 'poem: BS in der ersten Zeile verlässt das Gedicht',
    html: POEM, target: '.poem p:first-child', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p>Zeile eins</p><div class="poem"><p>Zeile zwei</p></div><p>Nachher</p>' },
  { label: 'poem: BS in der zweiten Zeile merged INNERHALB (Default)',
    html: POEM, target: '.poem p:last-child', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><div class="poem"><p>Zeile einsZeile zwei</p></div><p>Nachher</p>' },
  { label: 'poem: Delete am Ende der letzten Zeile zieht den Folgeabsatz herein',
    html: POEM, target: '.poem p:last-child', pos: 'end', key: 'Delete',
    expected: '<p>Vorher</p><div class="poem"><p>Zeile eins</p><p>Zeile zweiNachher</p></div>' },
  { label: 'poem: BS im Absatz danach ist das Gegenstück dazu',
    html: POEM, target: '@lastP', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><div class="poem"><p>Zeile eins</p><p>Zeile zweiNachher</p></div>' },
  { label: 'poem: Delete im Absatz davor zieht die erste Zeile hoch',
    html: POEM, target: '@firstP', pos: 'end', key: 'Delete',
    expected: '<p>VorherZeile eins</p><div class="poem"><p>Zeile zwei</p></div><p>Nachher</p>' },

  // ── blockquote ─────────────────────────────────────────────────────────────
  { label: 'blockquote: BS am Zitat-Anfang verlässt das Zitat',
    html: BQ, target: 'blockquote p', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p>Zitat</p><p>Nachher</p>' },
  { label: 'blockquote: Delete am Zitat-Ende zieht den Folgeabsatz herein',
    html: BQ, target: 'blockquote p', pos: 'end', key: 'Delete',
    expected: '<p>Vorher</p><blockquote><p>ZitatNachher</p></blockquote>' },
  { label: 'blockquote: BS im Absatz danach ist das Gegenstück dazu',
    html: BQ, target: '@lastP', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><blockquote><p>ZitatNachher</p></blockquote>' },
  { label: 'blockquote: Delete im Absatz davor zieht das Zitat hoch',
    html: BQ, target: '@firstP', pos: 'end', key: 'Delete',
    expected: '<p>VorherZitat</p><p>Nachher</p>' },

  // ── pre ────────────────────────────────────────────────────────────────────
  { label: 'pre: BS am Anfang wird zum Absatz',
    html: PRE, target: 'pre', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p>code hier</p><p>Nachher</p>' },
  { label: 'pre: Delete am Ende zieht den Folgeabsatz herein',
    html: PRE, target: 'pre', pos: 'end', key: 'Delete',
    expected: '<p>Vorher</p><pre>code hierNachher</pre>' },
  { label: 'pre: BS im Absatz danach ist das Gegenstück dazu',
    html: PRE, target: '@lastP', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><pre>code hierNachher</pre>' },
  { label: 'pre: Delete im Absatz davor zieht den Code hoch',
    html: PRE, target: '@firstP', pos: 'end', key: 'Delete',
    expected: '<p>Vorhercode hier</p><p>Nachher</p>' },

  // ── plain ul: nur der erste Listenpunkt verlässt die Liste ─────────────────
  { label: 'ul: BS im ersten Listenpunkt verlässt die Liste (wie ul.todo)',
    html: UL, target: 'ul li:first-child', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><p>Eins</p><ul><li>Zwei</li></ul><p>Nachher</p>' },
  { label: 'ul: BS im zweiten Listenpunkt merged INNERHALB (Default)',
    html: UL, target: 'ul li:last-child', pos: 'start', key: 'Backspace',
    expected: '<p>Vorher</p><ul><li>EinsZwei</li></ul><p>Nachher</p>' },
  { label: 'ul: Delete am Ende des letzten Punkts zieht den Folgeabsatz herein',
    html: UL, target: 'ul li:last-child', pos: 'end', key: 'Delete',
    expected: '<p>Vorher</p><ul><li>Eins</li><li>ZweiNachher</li></ul>' },
  { label: 'ul: Delete im Absatz davor zieht den ersten Punkt hoch',
    html: UL, target: '@firstP', pos: 'end', key: 'Delete',
    expected: '<p>VorherEins</p><ul><li>Zwei</li></ul><p>Nachher</p>' },
];

test.describe('Notebook — Löschen an Blockgrenzen', () => {
  test('jede Grenze verhält sich definiert, ohne Inline-style und ohne Bildverlust', async ({ page }) => {
    await enterNotebookEdit(page);
    for (const c of CASES) {
      await seed(page, c.html, c.target, c.pos);
      const before = await readHtml(page);
      await page.keyboard.press(c.key);
      await expectStructureIntact(page, c.label);
      const after = await readHtml(page);
      if (c.expected === null) {
        expect(after, `${c.label} (No-Op)`).toBe(before);
      } else {
        expect(after, c.label).toBe(c.expected);
      }
    }
  });

  test('leere Legende: ein Druck genügt, kein figure ohne Bild dazwischen', async ({ page }) => {
    await enterNotebookEdit(page);
    // Regressionsanker für den Void-Element-Fall: der Default brauchte drei
    // Drücke und hinterliess dazwischen ein <figure> mit Rahmen ohne Bild.
    await seed(page, FIG_EMPTY, 'figcaption', 'start');
    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'nach dem ersten Druck');
    expect(await page.evaluate(() => document
      .querySelectorAll('#editor-card .page-content-view--editing figure').length),
    'figure ist komplett weg, nicht ausgehöhlt').toBe(0);
  });
});
