// Pure Compute des Buecherregals (public/js/cards/my-books-compute.js).
// Drei Eigenschaften, die die Karte tragen:
//   1. Zusammenfuehren: der Server liefert Kennzahlen ohne Buchnamen, die Namen
//      kommen aus der Buchliste. Ein Buch ohne Server-Zeile darf nicht
//      verschwinden, ein Buch ohne Zugriff nicht auftauchen.
//   2. Der Reiter entscheidet ueber die Archiv-Sichtbarkeit — die Suche darf sie
//      nicht aufheben (sonst taucht Archiviertes beim Tippen wieder auf).
//   3. Der Pin gewinnt gegen die Spalten-Sortierung, sonst ist er wirkungslos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeShelfRows, filterShelfRows, pinnedFirst, shelfTotals, mayToggleFinished, SHELF_TABS,
} from '../../public/js/cards/my-books-compute.js';

const BOOKS = [
  { id: 1, name: 'Alpha', category_id: 7, buchtyp: 'roman' },
  { id: 2, name: 'Beta', category_id: null },
  { id: 3, name: 'Gamma', category_id: null },
];
const CATS = new Map([['7', 'Krimis']]);

test('mergeShelfRows: Namen aus der Buchliste, Kennzahlen vom Server', () => {
  const rows = mergeShelfRows([
    { book_id: 1, role: 'owner', chars: 1000, comments: 2, comments_unread: 1, pinned: true, pinned_at: '2026-01-01T00:00:00.000Z' },
    { book_id: 2, role: 'lektor', chars: 50, archived: true, archived_at: '2026-02-01T00:00:00.000Z' },
    { book_id: 99, role: 'owner', chars: 999 }, // Zugriff entzogen → nicht anzeigen
  ], BOOKS, CATS);

  assert.equal(rows.length, 3, 'drei sichtbare Buecher, das entzogene faellt weg');
  const alpha = rows.find(r => r.book_id === 1);
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.category, 'Krimis');
  assert.equal(alpha.chars, 1000);
  assert.equal(alpha.pinned, true);

  // Buch ohne Server-Zeile (frisch angelegt) erscheint als Nullzeile.
  const gamma = rows.find(r => r.book_id === 3);
  assert.equal(gamma.name, 'Gamma');
  assert.equal(gamma.chars, 0);
  assert.equal(gamma.comments_unread, 0);
  assert.equal(gamma.pinned, false);
  assert.equal(gamma.last_activity_at, null);

  assert.equal(rows.some(r => r.book_id === 99), false);
});

test('filterShelfRows: der Reiter bestimmt die Archiv-Sichtbarkeit', () => {
  const rows = mergeShelfRows([
    { book_id: 1, chars: 10 },
    { book_id: 2, archived: true },
    { book_id: 3, is_finished: 1 },
  ], BOOKS, CATS);

  assert.deepEqual(filterShelfRows(rows, { tab: 'aktiv' }).map(r => r.name), ['Alpha']);
  assert.deepEqual(filterShelfRows(rows, { tab: 'fertig' }).map(r => r.name), ['Gamma']);
  assert.deepEqual(filterShelfRows(rows, { tab: 'archiviert' }).map(r => r.name), ['Beta']);
  assert.equal(filterShelfRows(rows, { tab: 'alle' }).length, 3);

  // Suche filtert INNERHALB des Reiters — sie holt Archiviertes nicht hervor.
  assert.equal(filterShelfRows(rows, { tab: 'aktiv', query: 'Beta' }).length, 0);
  assert.deepEqual(filterShelfRows(rows, { tab: 'alle', query: 'beta' }).map(r => r.name), ['Beta']);
  // Kategorie ist mitsuchbar.
  assert.deepEqual(filterShelfRows(rows, { tab: 'alle', query: 'krimi' }).map(r => r.name), ['Alpha']);
  assert.deepEqual(SHELF_TABS, ['aktiv', 'fertig', 'archiviert', 'alle']);
});

test('pinnedFirst: Pin schlaegt die Spalten-Sortierung, laenger angeheftet zuerst', () => {
  const sorted = [
    { name: 'A', pinned: false, pinned_at: null },
    { name: 'B', pinned: true, pinned_at: '2026-03-01T00:00:00.000Z' },
    { name: 'C', pinned: false, pinned_at: null },
    { name: 'D', pinned: true, pinned_at: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(pinnedFirst(sorted).map(r => r.name), ['D', 'B', 'A', 'C']);
  // Unangeheftete behalten die uebergebene Ordnung (stabil).
  const flat = [{ name: 'X', pinned: false }, { name: 'Y', pinned: false }];
  assert.deepEqual(pinnedFirst(flat).map(r => r.name), ['X', 'Y']);
});

test('shelfTotals: Summen der uebergebenen (gefilterten) Menge', () => {
  const rows = mergeShelfRows([
    { book_id: 1, chars: 1500, pages: 2, writing_seconds: 60, exports: 1, comments: 3, comments_unread: 2, snapshots: 1, share_links_active: 1 },
    { book_id: 2, chars: 500, pages: 1, is_finished: 1, archived: true, exports: 2 },
  ], BOOKS, CATS);
  const t = shelfTotals(rows.filter(r => r.book_id !== 3));
  assert.equal(t.books, 2);
  assert.equal(t.chars, 2000);
  assert.equal(t.exports, 3);
  assert.equal(t.finished, 1);
  assert.equal(t.archived, 1);
  assert.equal(t.comments_unread, 2);
  assert.equal(shelfTotals([]).books, 0);
});

test('mayToggleFinished: Fertig-Schalter nur ab Rolle editor (Server-Gate gespiegelt)', () => {
  assert.equal(mayToggleFinished('owner'), true);
  assert.equal(mayToggleFinished('editor'), true);
  assert.equal(mayToggleFinished('lektor'), false);
  assert.equal(mayToggleFinished('viewer'), false);
  assert.equal(mayToggleFinished(null), false);
});
