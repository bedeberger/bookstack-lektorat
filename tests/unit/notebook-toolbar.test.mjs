// Unit-Tests für die Notebook-Toolbar (public/js/editor/notebook/toolbar/):
//   - Slash-Transforms (_applySlashItem) pro Blocktyp erzeugen die richtige
//     DOM-Struktur — zuvor komplett ungetestet.
//   - slashItems()-Filter (Substring auf Label + Key).
//   - _normalizeLinkUrl (pure).
//   - _brLeftOfCaret (Shift+Enter-Doppel-<br>-Dedup).
//
// Setup: linkedom liefert window/document; Alpine-/__app-Stubs für _formatStamp
// und _markEditDirty. Test-HTML sind statische Literale — kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.Alpine = { store: () => ({ uiLocale: 'de' }) };
// linkedom hat keine Selection-API — placeCaretIn/insertText-Pfade early-returnen
// dann sauber; getestet wird die DOM-Transform-Struktur, nicht die Caret-Position.
if (typeof document.getSelection !== 'function') document.getSelection = () => null;

const { toolbarCardMethods } = await import('../../public/js/editor/notebook/toolbar.js');
const { _normalizeLinkUrl, _brLeftOfCaret, SLASH_ITEMS, BOUNDARY_WRAPPER_SEL } = await import('../../public/js/editor/notebook/toolbar/_shared.js');
const { createTodoList, TODO_LIST_SEL, TODO_ITEM_SEL, TODO_TEXT_SEL, TODO_BOX_SEL } = await import('../../public/js/editor/shared/todo-html.js');

window.__app = { focusActive: false, _markEditDirty() {}, t: (k) => k };

// Container `#editor-card .page-content-view--editing` mit einem leeren Block
// aufbauen, damit getEditEl() ihn findet. Liefert { editEl, block }.
function mountBlock(tag = 'p') {
  document.body.replaceChildren();
  const host = document.createElement('div');
  host.id = 'editor-card';
  const editEl = document.createElement('div');
  editEl.className = 'page-content-view page-content-view--editing';
  editEl.focus = () => {}; // linkedom-Elemente haben kein focus()
  const block = document.createElement(tag);
  block.appendChild(document.createElement('br'));
  editEl.appendChild(block);
  host.appendChild(editEl);
  document.body.appendChild(host);
  return { editEl, block };
}

function slashCtx(block) {
  return {
    ...toolbarCardMethods,
    _slashBlock: block,
    slashShow: true,
    slashQuery: '',
    slashIdx: 0,
    _slashLabels: null,
    _slashFilterCache: null,
  };
}

// ── _applySlashItem: Blocktyp-Transforms ─────────────────────────────────────

test('_applySlashItem: h2 → Tag-Swap auf <h2>', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'h2', tag: 'h2', group: 'block' });
  assert.ok(editEl.querySelector('h2'), 'h2 erzeugt');
  assert.equal(editEl.querySelector('p'), null, 'alter <p> ersetzt');
});

test('_applySlashItem: blockquote (wrapP) → <blockquote><p>', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'blockquote', tag: 'blockquote', wrapP: true, group: 'block' });
  const bq = editEl.querySelector('blockquote');
  assert.ok(bq, 'blockquote erzeugt');
  assert.ok(bq.querySelector('p'), 'innerer <p> als Schreibfläche');
});

test('_applySlashItem: poem → <div class="poem"><p>', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'poem', tag: 'div', className: 'poem', wrapP: true, group: 'block' });
  const poem = editEl.querySelector('div.poem');
  assert.ok(poem, 'div.poem erzeugt');
  assert.ok(poem.querySelector('p'), 'innerer <p>');
});

test('_applySlashItem: list → <ul><li>', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'list', tag: 'ul', list: true, group: 'block' });
  assert.ok(editEl.querySelector('ul > li'), 'ul>li erzeugt');
});

test('_applySlashItem: todo → <ul class="todo"><li class="todo-item"> mit Checkbox', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'todo', tag: 'ul', className: 'todo', todoList: true, group: 'block' });
  const li = editEl.querySelector('ul.todo > li.todo-item');
  assert.ok(li, 'todo-li erzeugt');
  assert.ok(li.querySelector('input[type="checkbox"]'), 'Checkbox vorhanden');
  assert.ok(li.querySelector('span.todo-text'), 'todo-text-Span vorhanden');
});

test('_applySlashItem: hr → <hr> + Folge-<p> als Schreibanker', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'hr', tag: 'hr', group: 'break' });
  const hr = editEl.querySelector('hr');
  assert.ok(hr, 'hr erzeugt');
  assert.equal(hr.nextElementSibling?.tagName, 'P', 'Folge-<p> hinter <hr>');
});

test('_applySlashItem: pagebreak → <hr class="pagebreak">', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'pagebreak', tag: 'hr', className: 'pagebreak', group: 'break' });
  assert.ok(editEl.querySelector('hr.pagebreak'), 'hr.pagebreak erzeugt');
});

test('_applySlashItem: Datums-Stempel (insertText) → <p> mit Text', () => {
  const { editEl, block } = mountBlock('p');
  slashCtx(block)._applySlashItem({ key: 'heute', insertText: 'date', group: 'insert' });
  const p = editEl.querySelector('p');
  assert.ok(p, '<p> erzeugt');
  assert.ok((p.textContent || '').trim().length > 0, 'Stempel-Text eingefügt');
});

test('_applySlashItem: markiert dirty', () => {
  const { block } = mountBlock('p');
  let dirty = 0;
  window.__app._markEditDirty = () => { dirty++; };
  slashCtx(block)._applySlashItem({ key: 'h2', tag: 'h2', group: 'block' });
  assert.equal(dirty, 1);
  window.__app._markEditDirty = () => {};
});

// ── slashItems(): Filter ─────────────────────────────────────────────────────

test('slashItems: leere Query → alle Einträge', () => {
  const ctx = { ...toolbarCardMethods, slashQuery: '', _slashLabels: null, _slashFilterCache: null };
  // Aus der SSoT abgeleitet, nicht als Zahl hingeschrieben: sonst bricht dieser
  // Test bei jedem neuen Slash-Item, ohne dass etwas kaputt ist.
  assert.equal(ctx.slashItems().length, SLASH_ITEMS.length);
});

test('slashItems: Query filtert per Substring auf Label + Key', () => {
  const ctx = { ...toolbarCardMethods, slashQuery: 'h2', _slashLabels: null, _slashFilterCache: null };
  const r = ctx.slashItems();
  assert.ok(r.some(it => it.key === 'h2'), 'h2 per Key gefunden');
});

test('slashItems: kein Match → leere Liste', () => {
  const ctx = { ...toolbarCardMethods, slashQuery: 'zzzznope', _slashLabels: null, _slashFilterCache: null };
  assert.equal(ctx.slashItems().length, 0);
});

// ── _normalizeLinkUrl ────────────────────────────────────────────────────────

test('_normalizeLinkUrl: Schemes durchreichen, mailto-Erkennung, https-Prefix', () => {
  assert.equal(_normalizeLinkUrl(''), '');
  assert.equal(_normalizeLinkUrl('  '), '');
  assert.equal(_normalizeLinkUrl('https://a.io'), 'https://a.io');
  assert.equal(_normalizeLinkUrl('mailto:a@b.io'), 'mailto:a@b.io');
  assert.equal(_normalizeLinkUrl('a@b.io'), 'mailto:a@b.io');
  assert.equal(_normalizeLinkUrl('example.com'), 'https://example.com');
});

// ── _brLeftOfCaret: Shift+Enter-Doppel-<br>-Dedup ────────────────────────────

test('_brLeftOfCaret: <br> direkt links vom Caret → true (kein zweiter Soft-Break)', () => {
  const p = document.createElement('p');
  p.appendChild(document.createTextNode('x'));
  p.appendChild(document.createElement('br'));
  const sel = { isCollapsed: true, rangeCount: 1, getRangeAt: () => ({ startContainer: p, startOffset: 2 }) };
  assert.equal(_brLeftOfCaret(sel), true);
});

test('_brLeftOfCaret: echter Text links vom Caret → false (Break erlaubt)', () => {
  const p = document.createElement('p');
  const t = document.createTextNode('hallo');
  p.appendChild(t);
  const sel = { isCollapsed: true, rangeCount: 1, getRangeAt: () => ({ startContainer: t, startOffset: 5 }) };
  assert.equal(_brLeftOfCaret(sel), false);
});

test('_brLeftOfCaret: nicht-collapsed Selection → false', () => {
  const sel = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({}) };
  assert.equal(_brLeftOfCaret(sel), false);
});

// ── Kopplung BOUNDARY_WRAPPER_SEL ↔ SLASH_ITEMS ──────────────────────────────
// Warum dieses Gate: `SLASH_ITEMS` bestimmt, welche Blocktypen der Editor
// erzeugt; `BOUNDARY_WRAPPER_SEL` listet die formatierten Wrapper, deren
// Löschgrenzen `_kbBlockBoundary` selbst bedient (siehe docs/notebook-editor.md
// „Löschen an Blockgrenzen"). Die beiden Listen sind unabhängig gepflegt — ein
// neuer Wrapper im Slash-Menü, der im Selektor fehlt, fällt lautlos auf den
// Browser-Default zurück und bäckt dort Inline-`style` ein. Genau das fängt
// dieser Test, statt es erst im echten Editor auffallen zu lassen.

test('jeder Wrapper-erzeugende SLASH_ITEM ist in BOUNDARY_WRAPPER_SEL erfasst', () => {
  // Wrapper-erzeugend = der Slash-Block ist ein Container mit Kind-Blöcken
  // (`wrapP` → <p> darin, `list`/`todoList` → <li> darin).
  const wrappers = SLASH_ITEMS.filter((i) => i.wrapP || i.list || i.todoList);
  assert.ok(wrappers.length >= 4, 'Fixture-Annahme: es gibt Wrapper-Slash-Items');

  for (const item of wrappers) {
    const el = document.createElement(item.tag);
    if (item.className) el.className = item.className;
    const covered = el.matches(BOUNDARY_WRAPPER_SEL);
    // `ul.todo` ist die EINE bewusste Ausnahme: dafür ist der spezifischere
    // `_kbTodoDelete` zuständig, der zusätzlich die Checkbox als Struktur
    // behandelt. Wäre sie im generischen Selektor, würden beide greifen.
    const expected = !(item.key === 'todo');
    assert.equal(covered, expected,
      `Slash-Item "${item.key}" (<${item.tag}${item.className ? ' class=' + item.className : ''}>) `
      + `${expected ? 'MUSS' : 'darf NICHT'} von BOUNDARY_WRAPPER_SEL erfasst sein`);
  }
});

test('BOUNDARY_WRAPPER_SEL erfasst auch die nicht per Slash erzeugbaren Wrapper', () => {
  // `pre` und `ol` entstehen über Paste/Import, nicht über das Slash-Menü —
  // ihre Grenzen brauchen dieselbe Behandlung. Ohne diese Zeile könnte man sie
  // beim Aufräumen des Selektors für „ungenutzt" halten und entfernen.
  for (const tag of ['pre', 'ol']) {
    assert.ok(document.createElement(tag).matches(BOUNDARY_WRAPPER_SEL),
      `<${tag}> muss von BOUNDARY_WRAPPER_SEL erfasst sein (Paste-/Import-Pfad)`);
  }
});

test('Todo-Markup der Factory passt zu den Lookup-Selektoren', () => {
  // Erzeugung (createTodoList) und Suche (TODO_*_SEL, TODO_BOX_SEL) liegen in
  // derselben SSoT — dieser Test hält sie zueinander konsistent, damit ein
  // umbenannter Klassenname nicht die eine Seite still verfehlt.
  const { list, item, text } = createTodoList();
  const host = document.createElement('div');
  host.appendChild(list);
  assert.ok(list.matches(TODO_LIST_SEL), 'Liste matcht TODO_LIST_SEL');
  assert.ok(item.matches(TODO_ITEM_SEL), 'Zeile matcht TODO_ITEM_SEL');
  assert.ok(text.matches(TODO_TEXT_SEL), 'Text-Span matcht TODO_TEXT_SEL');
  assert.equal(host.querySelectorAll(TODO_BOX_SEL).length, 1, 'Checkbox zählt für den Persistenz-Index');
  // Der <br> ist Caret-Platzhalter: ohne ihn hat die leere Zeile keine Höhe.
  assert.equal(text.firstChild?.nodeName, 'BR', 'Text-Span trägt den Caret-Platzhalter');
});
