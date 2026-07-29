// Quellenliste eines Buchs — ein Fetch pro Buch, geteilt von allen Konsumenten
// im Notebook-Editor.
//
// Zwei Konsumenten, die dieselbe Liste brauchen und sie nie doppelt holen
// sollen: der Beleg-Picker im Edit-Modus (editor/notebook/toolbar/cite.js) und
// das Quellen-Popover in der Leseansicht (cards/editor-entities-card.js).
//
// Der Cache ist bewusst modulweit (nicht an einer Karte), weil er den Wechsel
// zwischen Lese- und Edit-Modus ueberleben soll. Invalidiert wird er von aussen:
// die Quellen-Karte dispatcht `sources:changed`, wenn sie eine Quelle anlegt,
// aendert, zuordnet oder loescht — beide Konsumenten haengen `invalidateSourceCache`
// an dieses Event (und an `book:changed`).

const _cache = new Map();

export function invalidateSourceCache(bookId = null) {
  if (bookId == null) _cache.clear();
  else _cache.delete(String(bookId));
}

/** Quellen des Buchs (`GET /sources?book_id=`). Wirft bei HTTP-Fehler — die
 *  Konsumenten entscheiden selbst, ob das ein Hinweis im Panel oder ein
 *  stiller Leerzustand ist. */
export async function loadBookSources(bookId) {
  const key = String(bookId);
  if (_cache.has(key)) return _cache.get(key);
  const res = await fetch(`/sources?book_id=${encodeURIComponent(key)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  const arr = Array.isArray(list) ? list : [];
  _cache.set(key, arr);
  return arr;
}
