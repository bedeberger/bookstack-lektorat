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

// Index-Kandidaten eines Users: Quellen mit PDF-Volltext. Bewusst OHNE
// `doc_text` — bei 40 angehaengten Werken laegen sonst mehrere MB Text
// gleichzeitig im Job-Speicher, obwohl er sie einzeln nacheinander chunkt.
// Den Text holt der Job pro Quelle (db/sources.js#getSourceDocText).
function listIndexedCandidates(ownerEmail) {
  return db.prepare(
    `SELECT id, doc_chars, doc_content_hash, doc_indexed_at, updated_at
       FROM sources
      WHERE owner_email = ? AND doc_text IS NOT NULL AND doc_text <> ''
      ORDER BY id`
  ).all(ownerEmail);
}

// Index-Frische für die Quellen-Karte: lastIndexedAt = jüngster Chunk-Timestamp,
// staleCount = Quellen mit PDF, die seit ihrem letzten Index-Lauf angefasst
// wurden. Billige Heuristik ohne Re-Hashing.
//
// Der Vergleich läuft PRO QUELLE (`doc_indexed_at` gegen ihr eigenes
// `updated_at`), nicht gegen einen benutzerweiten Maximal-Timestamp: die beiden
// Stempel kommen aus verschiedenen Uhren (JS-`Date` im Job vs. `strftime` beim
// Insert) und eine Gleichheitsprüfung darüber wäre nie erfüllt — jede Quelle
// gälte dauerhaft als veraltet. `setSourceDoc` nullt `doc_indexed_at`, ein
// frisch hochgeladenes PDF ist damit unabhängig von der Uhr stale.
function indexStatus(ownerEmail, model) {
  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM source_semantic_chunks WHERE owner_email = ? AND model = ?'
  ).get(ownerEmail, model)?.n || 0;
  const last = db.prepare(
    'SELECT MAX(created_at) AS last FROM source_semantic_chunks WHERE owner_email = ? AND model = ?'
  ).get(ownerEmail, model)?.last || null;
  const staleCount = db.prepare(
    `SELECT COUNT(*) AS n FROM sources
      WHERE owner_email = ? AND doc_text IS NOT NULL AND doc_text <> ''
        AND (doc_indexed_at IS NULL OR doc_indexed_at < updated_at)`
  ).get(ownerEmail).n;
  if (!last) return { indexed: false, lastIndexedAt: null, staleCount, total };
  return { indexed: true, lastIndexedAt: last, staleCount, total };
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
// haben (ein geloeschter Datensatz raeumt via FK-CASCADE selbst auf). Zaehlt
// entfernte QUELLEN, nicht Chunks — das ist die Zahl, die der Job meldet.
function pruneMissing(ownerEmail, model, keepSourceIds) {
  const keep = (keepSourceIds || []).map(Number).filter(Number.isFinite);
  const placeholders = keep.length ? keep.map(() => '?').join(',') : null;
  const where = placeholders
    ? `owner_email = ? AND model = ? AND source_id NOT IN (${placeholders})`
    : 'owner_email = ? AND model = ?';
  const args = placeholders ? [ownerEmail, model, ...keep] : [ownerEmail, model];
  const stale = db.prepare(
    `SELECT COUNT(DISTINCT source_id) AS n FROM source_semantic_chunks WHERE ${where}`
  ).get(...args).n;
  if (stale) db.prepare(`DELETE FROM source_semantic_chunks WHERE ${where}`).run(...args);
  return stale;
}

// Aufräumen bei Modell-Wechsel: Chunks eines Users unter einem FREMDEN Modell
// löschen. Ohne diesen Aufruf wächst die Tabelle bei jedem Modellwechsel
// monoton weiter — `pruneMissing` ist modell-skopiert und sieht Alt-Modelle
// per Definition nie. Der Index-Job ruft es, sobald er unter dem aktiven
// Modell durch ist. Rückgabe: gelöschte Chunks.
function clearForeignModels(ownerEmail, keepModel) {
  return db.prepare(
    'DELETE FROM source_semantic_chunks WHERE owner_email = ? AND model <> ?'
  ).run(ownerEmail, keepModel).changes;
}

// Ein Voll-Reset pro User braucht es hier nicht: `source_id` haengt mit
// ON DELETE CASCADE an `sources`, und wer alle Quellen eines Users loescht,
// raeumt die Chunks damit mit. Kein `clearOwner` als toter Export.

module.exports = {
  getSourceChunks, replaceSource, removeSource,
  listIndexedCandidates, indexStatus, searchSimilarSources,
  pruneMissing, clearForeignModels,
};