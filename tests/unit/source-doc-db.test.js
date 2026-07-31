'use strict';
// Quellen-Dokument (PDF-Anhang am User-Pool) auf der DB-Schicht:
// Metadaten-Sichten, Kosten-Trennung (kein BLOB/Volltext in Listen), das
// Trunkierungs-Signal und die Stale-Heuristik des Embedding-Index.
//
// Die Stale-Heuristik hat einen eigenen Test, weil sie schon einmal
// wrong-by-construction war: sie verglich `doc_indexed_at` auf Gleichheit mit
// einem benutzerweiten MAX(created_at) der Chunks. Beide Stempel kommen aus
// verschiedenen Uhren (JS-`Date` im Job vs. `strftime` beim Insert) — die
// Gleichheit traf nie zu, also galt jede Quelle dauerhaft als veraltet.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Eigene Test-DB pro Lauf (die Suites laufen mit --test-concurrency parallel).
process.env.DB_PATH = path.join('/tmp', `source-doc-db-${process.pid}-${Date.now()}.db`);

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const sourceChunks = require('../../db/source-semantic-chunks');
const { MAX_TEXT_CHARS } = require('../../lib/pdf-extract');

const OWNER = 'doc-owner@x.test';
appUsers.createUser({ email: OWNER, displayName: 'Owner' });

function newSource(title, owner = OWNER) {
  return schema.createSource(owner, { csl_type: 'book', title });
}

// `indexStatus` zaehlt ueber die ganze Bibliothek eines Users. Tests, die eine
// absolute Zahl pruefen, brauchen darum einen eigenen Besitzer — sonst zaehlen
// die Quellen der Nachbartests mit.
let _ownerSeq = 0;
function freshOwner() {
  const email = `doc-owner-${++_ownerSeq}@x.test`;
  appUsers.createUser({ email, displayName: `Owner ${_ownerSeq}` });
  return email;
}

test('setSourceDoc legt Metadaten ab; has_doc ist ein Flag, kein BLOB', () => {
  const src = newSource('Mit Anhang');
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'werk.pdf', text: 'Ein Satz.',
    pages: 12, chars: 9, hash: 'abc123', buffer: Buffer.from('%PDF-1.4 x'),
  });

  const row = schema.getSource(src.id);
  assert.equal(row.has_doc, true);
  assert.equal(row.doc_name, 'werk.pdf');
  assert.equal(row.doc_pages, 12);
  assert.equal(row.doc_chars, 9);
  assert.equal(row.doc_truncated, false);
  // Weder Original noch Volltext duerfen ueber die Listen-/Detailsicht kommen.
  assert.equal(row.doc, undefined);
  assert.equal(row.doc_text, undefined);

  // Die getrennten Lesepfade liefern sie dagegen sehr wohl.
  assert.ok(Buffer.isBuffer(schema.getSourceDocBlob(src.id)));
  assert.equal(schema.getSourceDocText(src.id), 'Ein Satz.');
});

test('Listen ziehen kein BLOB durch den Prozess', () => {
  const src = newSource('Listen-Quelle');
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'gross.pdf', text: 'text',
    pages: 1, chars: 4, hash: 'h', buffer: Buffer.alloc(64 * 1024, 1),
  });
  const pool = schema.listPoolSources(OWNER);
  const row = pool.find(r => r.id === src.id);
  assert.equal(row.has_doc, true);
  assert.equal(row.doc, undefined);
  assert.equal(row.doc_text, undefined);
});

test('doc_truncated meldet den gedeckelten Volltext', () => {
  const src = newSource('Dickes Werk');
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'dick.pdf', text: 'x'.repeat(MAX_TEXT_CHARS),
    pages: 900, chars: MAX_TEXT_CHARS, hash: 'h2', buffer: Buffer.from('%PDF-1.4'),
  });
  assert.equal(schema.getSource(src.id).doc_truncated, true);
});

test('getSourceDocMeta liefert Hash + Besitzer, aber nie den BLOB', () => {
  const src = newSource('Meta-Quelle');
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'm.pdf', text: 't', pages: 2,
    chars: 1, hash: 'deadbeef', buffer: Buffer.from('%PDF-1.4'),
  });
  const meta = schema.getSourceDocMeta(src.id);
  assert.equal(meta.owner_email, OWNER);
  assert.equal(meta.doc_content_hash, 'deadbeef'); // Basis des Re-Upload-Kurzschlusses
  assert.equal(meta.has_doc, 1);
  assert.equal(meta.doc, undefined);
});

test('clearSourceDoc raeumt alle doc-Spalten, die Quelle bleibt', () => {
  const src = newSource('Wieder leer');
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'weg.pdf', text: 't', pages: 3,
    chars: 1, hash: 'h3', buffer: Buffer.from('%PDF-1.4'),
  });
  schema.clearSourceDoc(src.id);
  const row = schema.getSource(src.id);
  assert.equal(row.has_doc, false);
  assert.equal(row.doc_name, null);
  assert.equal(row.doc_pages, null);
  assert.equal(row.doc_chars, null);
  assert.equal(row.doc_indexed_at, null);
  assert.equal(row.title, 'Wieder leer');
});

test('frisch hochgeladenes PDF ist stale, markSourceIndexed beendet das', () => {
  const owner = freshOwner();
  const src = newSource('Index-Quelle', owner);
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'i.pdf', text: 'Inhalt', pages: 1,
    chars: 6, hash: 'h4', buffer: Buffer.from('%PDF-1.4'),
  });

  const before = sourceChunks.indexStatus(owner, 'test-model');
  assert.equal(before.staleCount, 1, 'neu hochgeladen ⇒ stale');

  // Index-Lauf: Stempel NACH updated_at.
  const after = new Date(Date.now() + 1000).toISOString();
  schema.markSourceIndexed(src.id, after);

  const st = sourceChunks.indexStatus(owner, 'test-model');
  assert.equal(st.staleCount, 0, 'indiziert ⇒ nicht mehr stale');
  // Der Index-Lauf darf updated_at NICHT anfassen — sonst koennte die Quelle
  // nie wieder stale werden.
  assert.equal(schema.getSource(src.id).doc_indexed_at, after);
});

test('erneuter Upload macht die Quelle wieder stale', () => {
  const owner = freshOwner();
  const src = newSource('Zweitfassung', owner);
  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'v1.pdf', text: 'alt', pages: 1,
    chars: 3, hash: 'v1', buffer: Buffer.from('%PDF-1.4'),
  });
  schema.markSourceIndexed(src.id, new Date(Date.now() + 1000).toISOString());
  assert.equal(sourceChunks.indexStatus(owner, 'test-model').staleCount, 0);

  schema.setSourceDoc(src.id, {
    mime: 'application/pdf', name: 'v2.pdf', text: 'neu', pages: 2,
    chars: 3, hash: 'v2', buffer: Buffer.from('%PDF-1.4'),
  });
  // setSourceDoc nullt doc_indexed_at — unabhaengig von jeder Uhr.
  assert.equal(schema.getSource(src.id).doc_indexed_at, null);
  assert.equal(sourceChunks.indexStatus(owner, 'test-model').staleCount, 1);
});

test('pruneMissing entfernt genau die Quellen ausserhalb der Keep-Liste', () => {
  const keep = newSource('Behalten');
  const drop = newSource('Verwaist');
  const vec = new Float32Array([0.1, 0.2, 0.3]);
  for (const id of [keep.id, drop.id]) {
    sourceChunks.replaceSource(id, OWNER, 'm1', 3, [
      { chunk_ix: 0, content_hash: `h${id}`, vector: vec, text: 'chunk' },
    ]);
  }
  const removed = sourceChunks.pruneMissing(OWNER, 'm1', [keep.id]);
  assert.equal(removed, 1);
  assert.equal(sourceChunks.getSourceChunks(keep.id, 'm1').size, 1);
  assert.equal(sourceChunks.getSourceChunks(drop.id, 'm1').size, 0);

  // Leere Keep-Liste raeumt alles — und wirft keinen SQL-Syntaxfehler.
  assert.equal(sourceChunks.pruneMissing(OWNER, 'm1', []), 1);
});

test('clearForeignModels raeumt nur die Chunks des Alt-Modells', () => {
  const src = newSource('Modellwechsel');
  const vec = new Float32Array([1, 0]);
  sourceChunks.replaceSource(src.id, OWNER, 'alt', 2, [
    { chunk_ix: 0, content_hash: 'a', vector: vec, text: 'alt' },
  ]);
  sourceChunks.replaceSource(src.id, OWNER, 'neu', 2, [
    { chunk_ix: 0, content_hash: 'b', vector: vec, text: 'neu' },
  ]);

  const dropped = sourceChunks.clearForeignModels(OWNER, 'neu');
  assert.ok(dropped >= 1);
  assert.equal(sourceChunks.getSourceChunks(src.id, 'alt').size, 0);
  assert.equal(sourceChunks.getSourceChunks(src.id, 'neu').size, 1);
});

test('Quelle loeschen raeumt ihre Chunks per FK-CASCADE', () => {
  const src = newSource('Weg damit');
  sourceChunks.replaceSource(src.id, OWNER, 'm1', 2, [
    { chunk_ix: 0, content_hash: 'c', vector: new Float32Array([1, 1]), text: 't' },
  ]);
  schema.deleteSource(src.id);
  assert.equal(sourceChunks.getSourceChunks(src.id, 'm1').size, 0);
});
