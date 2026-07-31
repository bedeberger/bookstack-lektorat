'use strict';
// Datenzugriff auf source_semantic_chunks (semantische Suche über Quellen-PDFs).
// Pendant zu db/semantic-chunks.js, aber **user-skopiert** statt buchskopiert:
// Quellen leben im User-Pool (`sources.owner_email`) und gehören keinem Buch,
// darum gibt es hier kein `book_id` und keine Pages/Scenes/Figures-FKs — nur
// `source_id` (CASCADE) + `owner_email` (denormalisiert für billige Scopes).
//
// Reiner Ableitungs-Index — jederzeit über routes/jobs/source-embed-index.js
// neu berechenbar. Vektoren liegen als Float32-BLOB; (De)Serialisierung + Cosinus
// kommen aus lib/embed-chunk.js (gleiche Form wie beim buchskopierten Index).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { vectorToBlob, blobToVector, cosineSim } = require('../lib/embed-chunk');

const _selSourceChunks = db.prepare(
  'SELECT chunk_ix, content_hash, vector FROM source_semantic_chunks WHERE source_id = ? AND model = ? ORDER BY chunk_ix'
);
const _delSourceModel = db.prepare(
  'DELETE FROM source_semantic_chunks WHERE source_id = ? AND model = ?'
);
const _delSourceAll = db.prepare(
  'DELETE FROM source_semantic_chunks WHERE source_id = ?'
);
const _ins = db.prepare(`
  INSERT INTO source_semantic_chunks (source_id, owner_email, chunk_ix, content_hash, model, dim, vector, text, created_at)
  VALUES (@source_id, @owner_email, @chunk_ix, @content_hash, @model, @dim, @vector, @text, ${NOW_ISO_SQL})
`);

// Bestehende Chunks einer Quelle (unter einem Modell) als Map chunk_ix →
// { content_hash, vector }. Basis des Delta-Caches im Index-Job: bei
// unverändertem Hash wird der alte Vektor wiederverwendet statt neu embeddet.
function getSourceChunks(sourceId, model) {
  const map = new Map();
  for (const r of _selSourceChunks.all(sourceId, model)) {
    map.set(r.chunk_ix, { content_hash: r.content_hash, vector: blobToVector(r.vector) });
  }
  return map;
}

// Ersetzt den kompletten Chunk-Satz einer Quelle (unter einem Modell) atomar.
// rows: [{ chunk_ix, content_hash, vector:Float32Array, text }]. Leeres rows →
// nur Löschung (Quelle hat keinen indizierbaren Text mehr — z.B. PDF entfernt).
const _replaceTx = db.transaction((sourceId, ownerEmail, model, dim, rows) => {
  _delSourceModel.run(sourceId, model);
  for (const row of rows) {
    _ins.run({
      source_id: sourceId, owner_email: ownerEmail,
      chunk_ix: row.chunk_ix, content_hash: row.content_hash,
      model, dim, vector: vectorToBlob(row.vector), text: row.text,
    });
  }
});
function replaceSource(sourceId, ownerEmail, model, dim, rows) {
  _replaceTx(sourceId, ownerEmail, model, dim, rows || []);
}

// Vollständige Entfernung einer Quelle (alle Modelle) — beim Quellen-Delete
// bzw. beim PDF-Entfernen aufzurufen.
function removeSource(sourceId) {
  _delSourceAll.run(sourceId);
}

// Alle Quellen-IDs eines Users, die einen PDF-Text tragen (Index-Kandidaten).
// Basis des Index-Jobs und des Nacht-Crons.
function listIndexedCandidates(ownerEmail) {
  return db.prepare(
    `SELECT id, doc_text, doc_content_hash, doc_indexed_at, updated_at
       FROM sources
      WHERE owner_email = ? AND doc_text IS NOT NULL AND doc_text <> ''`
  ).all(ownerEmail);
}

// Index-Frische für die Quellen-Karte: lastIndexedAt = jüngster Chunk-Timestamp,
// staleCount = Quellen mit PDF, deren `doc_indexed_at` (oder `updated_at`)
// nach dem letzten Index-Lauf liegt. Billige Heuristik ohne Re-Hashing.
function indexStatus(ownerEmail, model) {
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM source_semantic_chunks WHERE owner_email = ? AND model = ?'
  ).get(ownerEmail, model)?.n || 0;
  const last = db.prepare(
    `SELECT MAX(sc.created_at) AS last
       FROM source_semantic_chunks sc
       JOIN sources s ON s.id = sc.source_id
      WHERE sc.owner_email = ? AND sc.model = ?`
  ).get(ownerEmail, model)?.last || null;
  if (!last) return { indexed: false, lastIndexedAt: null, staleCount: 0, total };
  // Stale = Quellen mit PDF, deren doc_indexed_at NICHT dem letzten Lauf
  // entspricht (nie indexiert oder seit/Index-Lauf geändert/getrennt).
  const sources = db.prepare(
    `SELECT COUNT(*) AS n FROM sources
      WHERE owner_email = ? AND doc_text IS NOT NULL AND doc_text <> ''
        AND (doc_indexed_at IS NULL OR doc_indexed_at <> ?)`
  ).get(ownerEmail, last).n;
  return { indexed: true, lastIndexedAt: last, staleCount: sources, total };
}

// Brute-Force-Ähnlichkeitssuche über alle Quellen-PDFs eines Users (unter dem
// aktiven Modell). Wie semantic_chunks.searchSimilar, aber user-skopiert. Query-
// Vektor Pflicht. topK = wie viele Treffer; minScore = Cosinus-Untergrenze
// (Long-Tail-Floor). Ein Treffer pro Quelle (bester Chunk), nach Score sortiert.
function searchSimilarSources(ownerEmail, model, queryVec, { topK = 20, minScore = 0 } = {}) {
  const rows = db.prepare(
    `SELECT sc.source_id, sc.chunk_ix, sc.text, sc.vector, s.title, s.citekey
       FROM source_semantic_chunks sc
       JOIN sources s ON s.id = sc.source_id
      WHERE sc.owner_email = ? AND sc.model = ?`
  ).all(ownerEmail, model);
  const best = new Map(); // source_id → { source_id, chunk_ix, text, title, citekey, score }
  for (const r of rows) {
    const score = cosineSim(queryVec, blobToVector(r.vector));
    if (!Number.isFinite(score)) continue;
    if (score < minScore) continue;
    const cur = best.get(r.source_id);
    if (!cur || score > cur.score) {
      best.set(r.source_id, {
        source_id: r.source_id, chunk_ix: r.chunk_ix,
        text: r.text, title: r.title, citekey: r.citekey, score,
      });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, topK);
}

// Verwaiste Chunks nach Full-Reindex entfernen: Quellen, die kein PDF mehr
// haben oder gelöscht wurden (delete paar via FK nicht selbst erfasst). Mod-
// Scoping gegen Fremdmodell-Reste.
function pruneMissing(ownerEmail, model, keepSourceIds) {
  const keep = new Set((keepSourceIds || []).map(Number));
  const rows = db.prepare(
    "SELECT DISTINCT source_id FROM source_semantic_chunks WHERE owner_email = ? AND model = ?"
  ).all(ownerEmail, model);
  const del = db.prepare(
    'DELETE FROM source_semantic_chunks WHERE source_id = ? AND model = ?'
  );
  let removed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!keep.has(Number(r.source_id))) { del.run(r.source_id, model); removed++; }
    }
  })();
  return removed;
}

// Aufräumen bei Modell-Wechsel: alle Chunks eines Users unter Fremdmodell
// löschen, wenn ein Full-Reindex unter dem neuen Modell startet. Optional mit
// `model = null` für „alle Modelle" (Admin-Reset).
function clearOwner(ownerEmail, model = null) {
  if (model) {
    db.prepare('DELETE FROM source_semantic_chunks WHERE owner_email = ? AND model = ?').run(ownerEmail, model);
  } else {
    db.prepare('DELETE FROM source_semantic_chunks WHERE owner_email = ?').run(ownerEmail);
  }
}

module.exports = {
  getSourceChunks, replaceSource, removeSource,
  listIndexedCandidates, indexStatus, searchSimilarSources, pruneMissing, clearOwner,
};