// Gate fuer die Wahl des Startbuchs (`pickStartBook` in book/tree/load.js) —
// die Antwort auf „welches Buch zeigt die App beim Aufruf der Stamm-URL".
//
// WARUM ALS UNIT-TEST: Der Fehler, gegen den diese Funktion steht, ist im
// Browser nicht reproduzierbar und in der App nicht sichtbar. Er entsteht aus
// MEHREREN gleichzeitig offenen Tabs (je ein Buch) und einem browserweiten,
// nicht tab-lokalen localStorage-Merker: dort gewinnt der zuletzt GELADENE Tab,
// nicht der zuletzt benutzte, und nach einem Deploy-Reload aller Tabs
// entscheidet die Netz-Latenz, welcher zuletzt fertig wird. Jeder einzelne Tab
// verhaelt sich dabei korrekt — nur ihr Zusammenspiel nicht.
//
// DIE INVARIANTE: Schiedsrichter ist der Server-Zeitstempel
// (`book_shelf.last_opened_at`, geliefert von `GET /me/books/last-opened` —
// bewusst nicht von der stale-faehigen Buchliste), nicht der letzte Schreiber.
// Der lokale Merker ist Rueckfall, nie Korrektur. Der Vergleich der Zeitstempel
// liegt im SQL (`ORDER BY last_opened_at DESC`); hier wird geprueft, dass die
// Antwort auch dann gilt, wenn die Liste inzwischen anders aussieht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStartBook } from '../../public/js/book/tree/load.js';

const B = (id, extra = {}) => ({ id, name: `Buch ${id}`, ...extra });

test('Server-Antwort schlaegt den lokalen Merker', () => {
  // Das ist der Kern: der lokale Merker kann von einem fremden Tab stammen, der
  // bloss neu geladen wurde — er darf die gemessene Reihenfolge nicht kippen.
  const books = [B(1), B(2), B(3)];
  assert.equal(pickStartBook(books, { serverBookId: '2', storedId: '1' }), '2');
  // Auch als Zahl statt String (der Server liefert INTEGER).
  assert.equal(pickStartBook(books, { serverBookId: 3, storedId: '1' }), '3');
});

test('lokaler Merker greift nur ohne Server-Antwort', () => {
  // Erster Besuch auf diesem Geraet, oder offline (der Fetch schlaegt fehl und
  // liefert leer).
  const books = [B(1), B(2), B(3)];
  assert.equal(pickStartBook(books, { serverBookId: '', storedId: '3' }), '3');
  assert.equal(pickStartBook(books, { storedId: '3' }), '3');
});

test('ein Kandidat, den die Liste nicht (mehr) enthaelt, faellt durch', () => {
  // Zugriff entzogen oder Buch geloescht — beides passiert zwischen zwei
  // Besuchen, und beides darf nicht in einer leeren App enden.
  const books = [B(1), B(2)];
  assert.equal(pickStartBook(books, { serverBookId: '99', storedId: '2' }), '2');
  assert.equal(pickStartBook(books, { serverBookId: '99', storedId: '98' }), '1');
  assert.equal(pickStartBook(books, {}), '1');
});

test('archiviert ist nie das Startbuch — solange es eine Alternative gibt', () => {
  // Ein Buch zu archivieren heisst, es aus der eigenen Liste zu raeumen; die
  // Buchwahl-Combobox zeigt es ebenfalls nicht. Ein Start dort waere ein Buch,
  // das man in seiner eigenen Auswahl nicht wiederfindet. Der Server filtert
  // das schon in der Abfrage (er kennt den zweitbesten), hier faengt die Regel
  // den lokalen Merker und die Notauswahl.
  const books = [B(1, { archived: true }), B(2)];
  assert.equal(pickStartBook(books, { storedId: '1' }), '2');
  assert.equal(pickStartBook(books, { serverBookId: '1' }), '2');
  assert.equal(pickStartBook(books, {}), '2');
});

test('ist alles archiviert, wird trotzdem eines gewaehlt', () => {
  // Ein Start ohne Buch waere eine leere App — schlechter als ein archiviertes.
  const books = [B(7, { archived: true }), B(8, { archived: true })];
  assert.equal(pickStartBook(books, {}), '7');
});

test('leere Buchliste liefert leer, nicht undefined', () => {
  // Der Aufrufer schreibt das Ergebnis direkt in `nav.selectedBookId`; ein
  // 'undefined' als String waere dort eine Buch-ID, die es nie gibt.
  assert.equal(pickStartBook([], { storedId: '5' }), '');
  assert.equal(pickStartBook(null, { serverBookId: '5' }), '');
  assert.equal(pickStartBook(undefined, {}), '');
  assert.equal(pickStartBook([]), '');
});
