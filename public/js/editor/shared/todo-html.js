// Todo-Checkboxen (`/todo`-Slash-Block): Markup erzeugen + im Seiten-HTML
// setzen/loeschen.
//
// SSoT fuer die Struktur — wer eine Todo-Zeile baut oder sucht, nimmt die
// Factories/Selektoren von hier, statt Klassennamen von Hand zu schreiben:
//   <ul class="todo"><li class="todo-item"><input type="checkbox"><span class="todo-text">…</span></li></ul>
// Erzeugt wird sie an zwei Stellen (Liste anlegen via `/todo` in
// notebook/toolbar/slash.js, neue Zeile bei Enter in notebook/toolbar/keydown.js)
// und gesucht in beiden plus toolbar/_shared.js und cards/editor-toolbar-card.js.
// Die CSS-Seite (css/components/manuscript-content.css) kann diese Konstanten
// nicht lesen — dort bleiben die Klassennamen zwangslaeufig gespiegelt.
//
// Der Haken lebt als ATTRIBUT (`checked`), nicht als Property — nur das
// serialisiert in `innerHTML` und damit in die Persistenz. Wer nur
// `box.checked = true` setzt, sieht den Haken und speichert ihn nie.
//
// `setTodoCheckedAt` arbeitet index-basiert: der n-te Todo-Kasten der
// Leseansicht ist der n-te im gespeicherten HTML. Das haelt auch mit
// Lektorat-/Chat-Marks und `decorateMentions` (siehe book/page-view.js#
// updatePageView), weil die nur Inline-Spans einziehen — sie fuegen keine
// `input`-Elemente ein und aendern deren Reihenfolge nicht.

// Klassennamen als Konstanten, damit die Factories und die Selektoren unten aus
// derselben Quelle bauen.
export const TODO_LIST_CLASS = 'todo';
export const TODO_ITEM_CLASS = 'todo-item';
export const TODO_TEXT_CLASS = 'todo-text';

export const TODO_LIST_SEL = `ul.${TODO_LIST_CLASS}`;
export const TODO_TEXT_SEL = `.${TODO_TEXT_CLASS}`;
// Eine Zeile der Liste — absichtlich OHNE `.todo-item`-Klasse: die Editor-Pfade
// (Caret-Lookup, Loeschen) behandeln jedes `li` in einer Todo-Liste als Zeile,
// auch aus Alt-/Import-Markup ohne die Klasse. Wer den `.todo-text`-Span
// braucht, prueft ihn einzeln und faellt sonst auf den Browser-Default zurueck.
export const TODO_ITEM_SEL = `${TODO_LIST_SEL} > li`;

// Gleicher Selektor fuer beide Seiten (Live-DOM + HTML-String), damit die
// Indizes zueinander passen. Checkboxen ausserhalb einer Todo-Liste (Legacy-/
// Import-Markup) zaehlen auf keiner Seite mit. Hier BEWUSST die strenge Form mit
// `.todo-item`: der Index ist persistenzrelevant (n-ter Kasten der Leseansicht =
// n-ter im gespeicherten HTML) und darf nicht von Alt-Markup verschoben werden.
export const TODO_BOX_SEL = `${TODO_LIST_SEL} > li.${TODO_ITEM_CLASS} > input[type="checkbox"]`;

// Eine leere Todo-Zeile. Der `<br>` im Text-Span ist Caret-Platzhalter — ohne
// ihn hat die leere Zeile keine Hoehe und nimmt keinen Cursor auf.
export function createTodoItem() {
  const li = document.createElement('li');
  li.className = TODO_ITEM_CLASS;
  const box = document.createElement('input');
  box.type = 'checkbox';
  const text = document.createElement('span');
  text.className = TODO_TEXT_CLASS;
  text.appendChild(document.createElement('br'));
  li.appendChild(box);
  li.appendChild(text);
  return li;
}

// Frische Todo-Liste mit einer leeren Zeile. Liefert `{ list, item, text }` —
// `text` ist das Caret-Ziel des Aufrufers.
export function createTodoList() {
  const list = document.createElement('ul');
  list.className = TODO_LIST_CLASS;
  const item = createTodoItem();
  list.appendChild(item);
  return { list, item, text: item.querySelector(TODO_TEXT_SEL) };
}

// Setzt den Haken am `index`-ten Todo-Kasten. Liefert das neue HTML oder
// `null`, wenn es diesen Kasten nicht gibt (Aufrufer bricht dann ab, statt
// einen fremden Haken zu verschieben).
export function setTodoCheckedAt(html, index, checked) {
  if (typeof html !== 'string' || !html) return null;
  if (!Number.isInteger(index) || index < 0) return null;
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return null;
  const box = root.querySelectorAll(TODO_BOX_SEL)[index];
  if (!box) return null;
  if (checked) box.setAttribute('checked', '');
  else box.removeAttribute('checked');
  return root.innerHTML;
}

// Index eines Live-DOM-Kastens innerhalb seines Ansichts-Containers. -1, wenn
// der Knoten nicht als Todo-Kasten zaehlt.
export function todoBoxIndex(container, box) {
  if (!container || !box) return -1;
  return Array.prototype.indexOf.call(container.querySelectorAll(TODO_BOX_SEL), box);
}
