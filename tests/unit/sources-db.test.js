'use strict';
// Quellenverzeichnis, DB-Schicht (db/sources.js + book_settings.citation_*).
// Geprueft werden die Eigenschaften, auf die spaetere Schichten bauen:
// Personen-Normalisierung, Full-Replace des Fund-Index, Buch-Guard gegen
// buchfremde Quell-IDs, CASCADE-Verhalten und die Enum-Whitelist der Settings.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Suites laufen mit --test-concurrency parallel).
const tmp = path.join('/tmp', `sources-db-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');
const { db } = require('../../db/connection');

const NOW = '2026-07-28T10:00:00.000Z';
const BOOK = 4001;
const OTHER_BOOK = 4002;

schema.upsertBookByName(BOOK, 'Quellen-Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Fremdbuch');

function makePage(pageId, position) {
  db.prepare(
    'INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(pageId, BOOK, `S${position}`, position, NOW);
  return pageId;
}
const PAGE_A = makePage(41001, 1);
const PAGE_B = makePage(41002, 2);

test('createSource normalisiert Personen in CSL-Form', () => {
  const s = schema.createSource(BOOK, 'me@x.test', {
    csl_type: 'book',
    title: 'Die Verwandlung',
    authors: [{ family: 'Kafka', given: 'Franz' }, 'Bundesamt fuer Statistik', { literal: 'o. A.' }],
    editors: [{ family: 'Wolff' }],
    year: '1915',
  });
  assert.deepEqual(s.authors, [
    { family: 'Kafka', given: 'Franz' },
    { literal: 'Bundesamt fuer Statistik' },   // blosser String → literal, keine Namensteil-Heuristik
    { literal: 'o. A.' },
  ]);
  assert.deepEqual(s.editors, [{ family: 'Wolff' }]);
  assert.equal(s.csl_type, 'book');
  assert.equal(s.cite_count, 0);
  assert.equal(s.cite_pages, 0);
});

test('csl_type faellt bei Fremdwert auf book zurueck', () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'X', csl_type: 'bogus' });
  assert.equal(s.csl_type, 'book');
});

test('citekey ist pro Buch eindeutig, NULL beliebig oft', () => {
  schema.createSource(BOOK, 'me@x.test', { title: 'A', citekey: 'kafka1915' });
  assert.throws(
    () => schema.createSource(BOOK, 'me@x.test', { title: 'B', citekey: 'kafka1915' }),
    /UNIQUE/
  );
  // Derselbe Key in einem anderen Buch ist erlaubt.
  assert.ok(schema.createSource(OTHER_BOOK, 'me@x.test', { title: 'C', citekey: 'kafka1915' }).id);
  // Mehrere Quellen ohne Key kollidieren nicht.
  assert.ok(schema.createSource(BOOK, 'me@x.test', { title: 'D' }).id);
  assert.ok(schema.createSource(BOOK, 'me@x.test', { title: 'E' }).id);
});

test('updateSource patcht nur uebergebene Felder', () => {
  const s = schema.createSource(BOOK, 'me@x.test', {
    title: 'Original', year: '1900', authors: [{ family: 'Meier' }], csl_type: 'article',
  });
  const u = schema.updateSource(s.id, { year: '1901' });
  assert.equal(u.year, '1901');
  assert.equal(u.title, 'Original');
  assert.equal(u.csl_type, 'article');
  assert.deepEqual(u.authors, [{ family: 'Meier' }]);
});

test('replacePageCitations ist Full-Replace und zaehlt Fundstellen', () => {
  const a = schema.createSource(BOOK, 'me@x.test', { title: 'Quelle A' });
  const b = schema.createSource(BOOK, 'me@x.test', { title: 'Quelle B' });

  const n1 = schema.replacePageCitations(PAGE_A, [
    { sourceId: a.id, count: 3, firstOffset: 120 },
    { sourceId: b.id, count: 1, firstOffset: 400 },
  ]);
  assert.equal(n1, 2);
  assert.deepEqual(
    schema.listPageCitations(PAGE_A).map(r => [r.source_id, r.count, r.first_offset]),
    [[a.id, 3, 120], [b.id, 1, 400]]
  );

  // Zweiter Lauf ersetzt komplett — kein Fortschreiben, keine Akkumulation.
  const n2 = schema.replacePageCitations(PAGE_A, [{ sourceId: b.id, count: 2, firstOffset: 10 }]);
  assert.equal(n2, 1);
  assert.deepEqual(
    schema.listPageCitations(PAGE_A).map(r => [r.source_id, r.count]),
    [[b.id, 2]]
  );

  // Kennzahlen landen in der Liste.
  const row = schema.listSources(BOOK).find(r => r.id === b.id);
  assert.equal(row.cite_count, 2);
  assert.equal(row.cite_pages, 1);
});

test('replacePageCitations ignoriert buchfremde Quellen und Duplikate', () => {
  const own = schema.createSource(BOOK, 'me@x.test', { title: 'Eigene' });
  const foreign = schema.createSource(OTHER_BOOK, 'me@x.test', { title: 'Buchfremd' });

  const written = schema.replacePageCitations(PAGE_B, [
    { sourceId: own.id, count: 1, firstOffset: 5 },
    { sourceId: foreign.id, count: 9, firstOffset: 1 },  // gehoert zu OTHER_BOOK
    { sourceId: own.id, count: 7 },                       // Duplikat
    { sourceId: 999999, count: 1 },                       // existiert nicht
  ]);
  assert.equal(written, 1);
  assert.deepEqual(schema.listPageCitations(PAGE_B).map(r => r.source_id), [own.id]);
});

test('listBookCitations liefert Buch-Leserichtung (Seitenposition, dann Offset)', () => {
  const bookId = 4003;
  schema.upsertBookByName(bookId, 'Reihenfolge');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?,?,?,?,?)')
    .run(43001, bookId, 'zweite', 2, NOW);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?,?,?,?,?)')
    .run(43002, bookId, 'erste', 1, NOW);
  const s1 = schema.createSource(bookId, 'me@x.test', { title: 'S1' });
  const s2 = schema.createSource(bookId, 'me@x.test', { title: 'S2' });
  const s3 = schema.createSource(bookId, 'me@x.test', { title: 'S3' });

  schema.replacePageCitations(43001, [{ sourceId: s1.id, count: 1, firstOffset: 10 }]);
  schema.replacePageCitations(43002, [
    { sourceId: s3.id, count: 1, firstOffset: 500 },
    { sourceId: s2.id, count: 1, firstOffset: 20 },
  ]);

  // Seite mit position=1 zuerst, darin nach Offset — Basis der Nummernvergabe
  // im numerischen Zitierstil (Nummer nach Erstzitat).
  assert.deepEqual(
    schema.listBookCitations(bookId).map(r => r.source_id),
    [s2.id, s3.id, s1.id]
  );
});

test('CASCADE: Quelle, Seite und Buch raeumen den Fund-Index auf', () => {
  const bookId = 4004;
  schema.upsertBookByName(bookId, 'Cascade');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?,?,?,?,?)')
    .run(44001, bookId, 'S1', 1, NOW);
  const s = schema.createSource(bookId, 'me@x.test', { title: 'Weg damit' });

  schema.replacePageCitations(44001, [{ sourceId: s.id, count: 1 }]);
  schema.deleteSource(s.id);
  assert.equal(schema.listPageCitations(44001).length, 0);

  const s2 = schema.createSource(bookId, 'me@x.test', { title: 'Zweite' });
  schema.replacePageCitations(44001, [{ sourceId: s2.id, count: 1 }]);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(44001);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_citations WHERE source_id = ?').get(s2.id).n, 0);

  db.prepare('DELETE FROM books WHERE book_id = ?').run(bookId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_sources WHERE book_id = ?').get(bookId).n, 0);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('archivierte Quellen sind aus der Standardliste ausgeblendet', () => {
  const bookId = 4005;
  schema.upsertBookByName(bookId, 'Archiv');
  const s = schema.createSource(bookId, 'me@x.test', { title: 'Alt' });
  schema.updateSource(s.id, { archived: 1 });
  assert.equal(schema.listSources(bookId).length, 0);
  assert.equal(schema.listSources(bookId, { includeArchived: true }).length, 1);
  assert.equal(schema.countSources(bookId), 1);
});

test('Verzeichnis-Settings: Defaults, Patch und Enum-Whitelist', () => {
  const bookId = 4006;
  schema.upsertBookByName(bookId, 'Settings');

  // Ohne book_settings-Zeile gelten die Defaults aus Migration 252.
  const d = schema.getBookSettings(bookId);
  assert.equal(d.citation_style, 'apa7');
  assert.equal(d.bibliography_enabled, 0);
  assert.equal(d.bibliography_title, null);
  assert.equal(d.bibliography_scope, 'cited');
  assert.equal(d.bibliography_in_blog, 0);

  schema.setBookCitationSettings(bookId, {
    citation_style: 'numeric',
    bibliography_enabled: 1,
    bibliography_title: '  Literatur  ',
    bibliography_scope: 'all',
    bibliography_in_blog: 1,
  });
  const set = schema.getBookSettings(bookId);
  assert.equal(set.citation_style, 'numeric');
  assert.equal(set.bibliography_enabled, 1);
  assert.equal(set.bibliography_title, 'Literatur');   // getrimmt
  assert.equal(set.bibliography_scope, 'all');
  assert.equal(set.bibliography_in_blog, 1);

  // Fremdwerte landen nie in der DB — der Formatter kennt nur die Whitelist.
  schema.setBookCitationSettings(bookId, { citation_style: 'bogus', bibliography_scope: 'bogus' });
  const forced = schema.getBookSettings(bookId);
  assert.equal(forced.citation_style, 'apa7');
  assert.equal(forced.bibliography_scope, 'cited');
});

test('Verzeichnis-Settings beruehren die uebrigen Buch-Settings nicht', () => {
  const bookId = 4007;
  schema.upsertBookByName(bookId, 'Koexistenz');
  schema.saveBookSettings(bookId, 'en', 'US', 'sachbuch', 'Kontext');
  schema.setBookCitationSettings(bookId, { citation_style: 'chicago-ad', bibliography_enabled: 1 });

  const s = schema.getBookSettings(bookId);
  assert.equal(s.language, 'en');
  assert.equal(s.region, 'US');
  assert.equal(s.buchtyp, 'sachbuch');
  assert.equal(s.buch_kontext, 'Kontext');
  assert.equal(s.citation_style, 'chicago-ad');
  assert.equal(s.bibliography_enabled, 1);
});
