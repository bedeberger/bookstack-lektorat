'use strict';
// Quellen-Bibliothek, DB-Schicht (db/sources.js + book_settings.citation_*).
// Geprueft werden die Eigenschaften, auf die spaetere Schichten bauen:
// Personen-Normalisierung, Pool-vs-Buch-Skopierung, die M:N-Bruecke, Full-Replace
// des Fund-Index, Buch-Guard gegen nicht zugeordnete Quell-IDs, CASCADE-Verhalten
// und die Enum-Whitelist der Settings.
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
const ME = 'me@x.test';

schema.upsertBookByName(BOOK, 'Quellen-Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Fremdbuch');

function makePage(pageId, position, bookId = BOOK) {
  db.prepare(
    'INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(pageId, bookId, `S${position}`, position, NOW);
  return pageId;
}
const PAGE_A = makePage(41001, 1);
const PAGE_B = makePage(41002, 2);

/** Anlegen + gleich zuordnen — der Normalfall aus der Quellen-Karte heraus. */
function makeSource(bookId, fields, owner = ME) {
  const s = schema.createSource(owner, fields);
  if (bookId) schema.linkSource(bookId, s.id, owner);
  return s;
}

test('createSource normalisiert Personen in CSL-Form', () => {
  const s = makeSource(BOOK, {
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
  assert.equal(s.owner_email, ME);
  assert.equal(s.cite_count, 0);
  assert.equal(s.cite_pages, 0);
});

test('csl_type faellt bei Fremdwert auf book zurueck', () => {
  const s = makeSource(BOOK, { title: 'X', csl_type: 'bogus' });
  assert.equal(s.csl_type, 'book');
});

test('citekey ist pro Bibliothek eindeutig, NULL beliebig oft', () => {
  schema.createSource(ME, { title: 'A', citekey: 'kafka1915' });
  // Derselbe Key ein zweites Mal — auch fuer ein anderes Buch — ist jetzt ein
  // Konflikt: die Bibliothek gehoert dem User, nicht dem Werk.
  assert.throws(
    () => schema.createSource(ME, { title: 'B', citekey: 'kafka1915' }),
    /UNIQUE/
  );
  // Ein anderer User darf denselben Key haben.
  assert.ok(schema.createSource('other@x.test', { title: 'C', citekey: 'kafka1915' }).id);
  // Mehrere Quellen ohne Key kollidieren nicht.
  assert.ok(schema.createSource(ME, { title: 'D' }).id);
  assert.ok(schema.createSource(ME, { title: 'E' }).id);
});

test('updateSource patcht nur uebergebene Felder', () => {
  const s = makeSource(BOOK, {
    title: 'Original', year: '1900', authors: [{ family: 'Meier' }], csl_type: 'article',
  });
  const u = schema.updateSource(s.id, { year: '1901' });
  assert.equal(u.year, '1901');
  assert.equal(u.title, 'Original');
  assert.equal(u.csl_type, 'article');
  assert.deepEqual(u.authors, [{ family: 'Meier' }]);
});

test('dieselbe Quelle liegt in mehreren Buechern, ohne kopiert zu werden', () => {
  const s = schema.createSource(ME, { title: 'Geteilte Literatur' });
  assert.equal(schema.linkSource(BOOK, s.id, ME), true);
  assert.equal(schema.linkSource(OTHER_BOOK, s.id, ME), true);
  // Idempotent: der Picker darf eine bereits zugeordnete Quelle nicht sprengen.
  assert.equal(schema.linkSource(BOOK, s.id, ME), false);

  assert.ok(schema.listSources(BOOK).some(r => r.id === s.id));
  assert.ok(schema.listSources(OTHER_BOOK).some(r => r.id === s.id));
  assert.deepEqual(schema.listSourceBooks(s.id).map(b => b.book_id).sort(), [BOOK, OTHER_BOOK]);
  assert.equal(schema.getSource(s.id).book_count, 2);
});

test('listPoolSources liefert die Bibliothek, exclude_book blendet Zugeordnetes aus', () => {
  const owner = 'pool@x.test';
  const bookId = 4010;
  schema.upsertBookByName(bookId, 'Pool-Buch');
  const drin = schema.createSource(owner, { title: 'Schon zugeordnet' });
  const frei = schema.createSource(owner, { title: 'Nur im Pool' });
  const alt = schema.createSource(owner, { title: 'Archiviert' });
  schema.linkSource(bookId, drin.id, owner);
  schema.updateSource(alt.id, { archived: 1 });

  const pool = schema.listPoolSources(owner);
  assert.deepEqual(pool.map(r => r.id).sort(), [drin.id, frei.id].sort());

  const pickable = schema.listPoolSources(owner, { excludeBookId: bookId });
  assert.deepEqual(pickable.map(r => r.id), [frei.id]);

  assert.equal(schema.listPoolSources(owner, { includeArchived: true }).length, 3);
  // Fremde Bibliotheken tauchen nie auf.
  assert.equal(schema.listPoolSources('niemand@x.test').length, 0);
});

test('Kennzahlen der Buchliste sind buch-skopiert, die des Pools global', () => {
  const bookA = 4011;
  const bookB = 4012;
  schema.upsertBookByName(bookA, 'A');
  schema.upsertBookByName(bookB, 'B');
  makePage(41101, 1, bookA);
  makePage(41201, 1, bookB);

  const s = schema.createSource(ME, { title: 'In beiden zitiert' });
  schema.linkSource(bookA, s.id, ME);
  schema.linkSource(bookB, s.id, ME);
  schema.replacePageCitations(41101, [{ sourceId: s.id, count: 3, firstOffset: 1 }]);
  schema.replacePageCitations(41201, [{ sourceId: s.id, count: 5, firstOffset: 1 }]);

  assert.equal(schema.listSources(bookA).find(r => r.id === s.id).cite_count, 3);
  assert.equal(schema.listSources(bookB).find(r => r.id === s.id).cite_count, 5);
  assert.equal(schema.getSource(s.id, bookA).cite_count, 3);
  // Ohne Buch die Pool-Sicht: Summe ueber alle Arbeiten.
  assert.equal(schema.getSource(s.id).cite_count, 8);
  assert.equal(schema.getSource(s.id).cite_pages, 2);
});

test('unlinkSource nimmt die Quelle aus EINEM Buch, deleteSource aus allen', () => {
  const bookA = 4013;
  const bookB = 4014;
  schema.upsertBookByName(bookA, 'A2');
  schema.upsertBookByName(bookB, 'B2');
  makePage(41301, 1, bookA);
  makePage(41401, 1, bookB);

  const s = schema.createSource(ME, { title: 'Wandert' });
  schema.linkSource(bookA, s.id, ME);
  schema.linkSource(bookB, s.id, ME);
  schema.replacePageCitations(41301, [{ sourceId: s.id, count: 2, firstOffset: 1 }]);
  schema.replacePageCitations(41401, [{ sourceId: s.id, count: 1, firstOffset: 1 }]);

  assert.equal(schema.unlinkSource(bookA, s.id), true);
  assert.equal(schema.isSourceLinked(bookA, s.id), false);
  assert.equal(schema.isSourceLinked(bookB, s.id), true);
  // Der Pool-Eintrag lebt weiter …
  assert.ok(schema.getSource(s.id));
  // … die Fundstellen des entkoppelten Buchs sind weg, die des anderen bleiben.
  assert.equal(schema.listPageCitations(41301).length, 0);
  assert.equal(schema.listPageCitations(41401).length, 1);

  schema.deleteSource(s.id);
  assert.equal(schema.getSource(s.id), null);
  assert.equal(schema.listPageCitations(41401).length, 0);
  assert.equal(schema.isSourceLinked(bookB, s.id), false);
});

test('replacePageCitations ist Full-Replace und zaehlt Fundstellen', () => {
  const a = makeSource(BOOK, { title: 'Quelle A' });
  const b = makeSource(BOOK, { title: 'Quelle B' });

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

test('replacePageCitations ignoriert nicht zugeordnete Quellen und Duplikate', () => {
  const own = makeSource(BOOK, { title: 'Zugeordnet' });
  const foreign = makeSource(OTHER_BOOK, { title: 'Anderes Buch' });
  const poolOnly = schema.createSource(ME, { title: 'Nur in der Bibliothek' });

  const written = schema.replacePageCitations(PAGE_B, [
    { sourceId: own.id, count: 1, firstOffset: 5 },
    { sourceId: foreign.id, count: 9, firstOffset: 1 },  // nur OTHER_BOOK zugeordnet
    { sourceId: poolOnly.id, count: 4, firstOffset: 2 }, // keinem Buch zugeordnet
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
  const s1 = makeSource(bookId, { title: 'S1' });
  const s2 = makeSource(bookId, { title: 'S2' });
  const s3 = makeSource(bookId, { title: 'S3' });

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

test('CASCADE: Quelle, Seite und Buch raeumen Fund-Index und Bruecke auf', () => {
  const bookId = 4004;
  schema.upsertBookByName(bookId, 'Cascade');
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?,?,?,?,?)')
    .run(44001, bookId, 'S1', 1, NOW);
  const s = makeSource(bookId, { title: 'Weg damit' });

  schema.replacePageCitations(44001, [{ sourceId: s.id, count: 1 }]);
  schema.deleteSource(s.id);
  assert.equal(schema.listPageCitations(44001).length, 0);

  const s2 = makeSource(bookId, { title: 'Zweite' });
  schema.replacePageCitations(44001, [{ sourceId: s2.id, count: 1 }]);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(44001);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_citations WHERE source_id = ?').get(s2.id).n, 0);

  // Buch weg → Bruecke weg, der Bibliothekseintrag bleibt (er gehoert dem User).
  db.prepare('DELETE FROM books WHERE book_id = ?').run(bookId);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM book_source_links WHERE book_id = ?').get(bookId).n, 0
  );
  assert.ok(schema.getSource(s2.id));
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('archivierte Quellen sind aus der Standardliste ausgeblendet', () => {
  const bookId = 4005;
  schema.upsertBookByName(bookId, 'Archiv');
  const s = makeSource(bookId, { title: 'Alt' });
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
