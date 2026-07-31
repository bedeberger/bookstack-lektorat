'use strict';
// Integration test: kind='research' in semantic_chunks (Migration 259).
// Prueft die Schicht, die weder Unit-Test noch HTTP-Test sieht — das Zusammenspiel
// aus CHECK-Constraint, typisierter FK-Spalte, generierter entity_id und CASCADE:
//   - schreiben/lesen ueber die polymorphe entity_id
//   - der CHECK weist eine falsch besetzte Spaltenkombination ab (sentinel-frei)
//   - Item-Delete raeumt seine Vektoren selbst (CASCADE, kein Hook noetig)
//   - searchInEntity liefert MEHRERE Passagen aus EINEM Dokument (der Grund,
//     warum es die Funktion neben searchSimilar gibt)
//   - searchSimilar gibt pro Entitaet genau EINEN (den besten) Chunk
// Kein Embedding-Endpunkt im Spiel: die Vektoren werden von Hand gesetzt, damit
// die Cosinus-Rangfolge deterministisch ist.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let semanticChunks;

const NOW = '2026-01-01T00:00:00.000Z';
const MODEL = 'test-embed';
const DIM = 3;

// Einheitsvektoren: e0 steht dem Query e0 am naechsten, dann e1, dann e2.
const V = {
  e0: Float32Array.from([1, 0, 0]),
  e1: Float32Array.from([0.9, 0.44, 0]),
  e2: Float32Array.from([0, 0, 1]),
};

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  semanticChunks = require('../../db/semantic-chunks');
});
test.after(() => ctx.cleanup());

test.beforeEach(() => {
  for (const t of ['semantic_chunks', 'research_items', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function seed(bookId, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)")
    .run(bookId, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  const itemId = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, doc_text, created_at, updated_at)
     VALUES (?, ?, 'document', 'Gutachten', 'langer PDF-Text', ?, ?)`
  ).run(bookId, user, NOW, NOW).lastInsertRowid;
  return { itemId };
}

const row = (ix, vector, text) => ({ chunk_ix: ix, content_hash: `h${ix}`, vector, text });

test('replaceEntity schreibt research-Chunks und entity_id loest polymorph auf', () => {
  const BOOK = 9401;
  const { itemId } = seed(BOOK);

  semanticChunks.replaceEntity('research', itemId, BOOK, MODEL, DIM, [
    row(0, V.e0, 'Passage A'),
    row(1, V.e2, 'Passage B'),
  ]);

  const stored = db.prepare(
    'SELECT kind, research_item_id, page_id, scene_id, figure_id, entity_id FROM semantic_chunks ORDER BY chunk_ix'
  ).all();
  assert.equal(stored.length, 2);
  for (const r of stored) {
    assert.equal(r.kind, 'research');
    assert.equal(r.research_item_id, itemId);
    assert.equal(r.entity_id, itemId, 'generierte entity_id spiegelt research_item_id');
    assert.equal(r.page_id, null);
    assert.equal(r.scene_id, null);
    assert.equal(r.figure_id, null);
  }

  // Delta-Cache-Lesepfad findet die Chunks ueber dieselbe polymorphe Abfrage.
  const existing = semanticChunks.getEntityChunks('research', itemId, MODEL);
  assert.equal(existing.size, 2);
  assert.equal(existing.get(0).content_hash, 'h0');
});

test('CHECK weist eine research-Zeile ohne research_item_id ab', () => {
  const BOOK = 9402;
  seed(BOOK);
  assert.throws(
    () => db.prepare(
      `INSERT INTO semantic_chunks (kind, book_id, page_id, chunk_ix, content_hash, model, dim, vector, text, created_at)
       VALUES ('research', ?, NULL, 0, 'h', ?, ?, x'00', 'txt', ?)`
    ).run(BOOK, MODEL, DIM, NOW),
    /CHECK constraint failed/,
  );
});

test('Item-Delete raeumt seine Vektoren per CASCADE', () => {
  const BOOK = 9403;
  const { itemId } = seed(BOOK);
  semanticChunks.replaceEntity('research', itemId, BOOK, MODEL, DIM, [row(0, V.e0, 'Passage A')]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks').get().n, 1);

  db.prepare('DELETE FROM research_items WHERE id = ?').run(itemId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks').get().n, 0);
});

test('searchInEntity liefert mehrere Passagen EINES Dokuments, nach Naehe sortiert', () => {
  const BOOK = 9404;
  const { itemId } = seed(BOOK);
  semanticChunks.replaceEntity('research', itemId, BOOK, MODEL, DIM, [
    row(0, V.e2, 'weit weg'),
    row(1, V.e0, 'genau das Thema'),
    row(2, V.e1, 'fast das Thema'),
  ]);

  const hits = semanticChunks.searchInEntity('research', itemId, MODEL, V.e0, { topK: 3 });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map(h => h.text), ['genau das Thema', 'fast das Thema', 'weit weg']);
  assert.ok(hits[0].score > hits[1].score && hits[1].score > hits[2].score);

  // minScore schneidet den schwachen Long-Tail ab.
  const floored = semanticChunks.searchInEntity('research', itemId, MODEL, V.e0, { topK: 3, minScore: 0.5 });
  assert.deepEqual(floored.map(h => h.chunk_ix), [1, 2]);
});

test('searchSimilar gibt pro Recherche-Eintrag nur den besten Chunk', () => {
  const BOOK = 9405;
  const { itemId } = seed(BOOK);
  semanticChunks.replaceEntity('research', itemId, BOOK, MODEL, DIM, [
    row(0, V.e2, 'weit weg'),
    row(1, V.e0, 'genau das Thema'),
  ]);

  const hits = semanticChunks.searchSimilar(BOOK, MODEL, V.e0, { kinds: ['research'], topK: 10 });
  assert.equal(hits.length, 1, 'ein Treffer je Entitaet');
  assert.equal(hits[0].kind, 'research');
  assert.equal(hits[0].entity_id, itemId);
  assert.equal(hits[0].text, 'genau das Thema');
});

test('pruneMissing entfernt Chunks geloeschter Recherche-Eintraege', () => {
  const BOOK = 9406;
  const { itemId } = seed(BOOK);
  semanticChunks.replaceEntity('research', itemId, BOOK, MODEL, DIM, [row(0, V.e0, 'Passage A')]);

  assert.equal(semanticChunks.pruneMissing(BOOK, MODEL, 'research', [itemId]), 0);
  assert.equal(semanticChunks.pruneMissing(BOOK, MODEL, 'research', []), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks').get().n, 0);
});
