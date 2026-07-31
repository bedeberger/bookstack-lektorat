'use strict';
// Datenzugriff auf semantic_chunks (semantische Suche). Der Vektor liegt als
// Float32-BLOB; (De)Serialisierung + Cosinus kommen aus lib/embed-chunk.js.
// Reiner Ableitungs-Index — jederzeit über routes/jobs/embed-index.js neu
// berechenbar.
//
// Die Quell-Entität hängt an einer der vier typisierten Spalten page_id/scene_id/
// figure_id/research_item_id (CASCADE-FK, passend zu `kind` per CHECK erzwungen) —
// ein Entity- oder Buch-Delete räumt seine Vektoren selbst auf. Gelesen wird
// polymorph über die generierte Spalte entity_id (COALESCE der vier), geschrieben
// ausschliesslich über die typisierten Spalten; _entityCols() ist der einzige
// Übersetzer dafür.
// pruneMissing() bleibt zuständig für Entitäten, die noch existieren, aber nicht
// mehr indizierbar sind (stale-Figur, Seite in anderes Buch verschoben) — das deckt
// kein FK ab.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { vectorToBlob, blobToVector, cosineSim } = require('../lib/embed-chunk');

const _selEntity = db.prepare(
  'SELECT chunk_ix, content_hash, vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
);
const _delEntityModel = db.prepare(
  'DELETE FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ?'
);
const _delEntityAll = db.prepare(
  'DELETE FROM semantic_chunks WHERE kind = ? AND entity_id = ?'
);
const _ins = db.prepare(`
  INSERT INTO semantic_chunks (kind, page_id, scene_id, figure_id, research_item_id, book_id, chunk_ix, content_hash, model, dim, vector, text, created_at)
  VALUES (@kind, @page_id, @scene_id, @figure_id, @research_item_id, @book_id, @chunk_ix, @content_hash, @model, @dim, @vector, @text, ${NOW_ISO_SQL})
`);

// kind + entityId → die vier typisierten FK-Spalten. Genau eine ist gesetzt; der
// CHECK auf der Tabelle weist jede andere Kombination ab.
function _entityCols(kind, entityId) {
  return {
    page_id: kind === 'page' ? entityId : null,
    scene_id: kind === 'scene' ? entityId : null,
    figure_id: kind === 'figure' ? entityId : null,
    research_item_id: kind === 'research' ? entityId : null,
  };
}

// Bestehende Chunks einer Entität (unter einem Modell) als Map chunk_ix →
// { content_hash, vector }. Basis des Delta-Caches im Index-Job: bei
// unverändertem Hash wird der alte Vektor wiederverwendet statt neu embeddet.
function getEntityChunks(kind, entityId, model) {
  const map = new Map();
  for (const r of _selEntity.all(kind, entityId, model)) {
    map.set(r.chunk_ix, { content_hash: r.content_hash, vector: blobToVector(r.vector) });
  }
  return map;
}

// Ersetzt den kompletten Chunk-Satz einer Entität (unter einem Modell) atomar.
// rows: [{ chunk_ix, content_hash, vector:Float32Array, text }]. Leeres rows →
// nur Löschung (Entität hat keinen indizierbaren Text mehr).
const _replaceTx = db.transaction((kind, entityId, bookId, model, dim, rows) => {
  _delEntityModel.run(kind, entityId, model);
  const cols = _entityCols(kind, entityId);
  for (const row of rows) {
    _ins.run({
      kind, ...cols, book_id: bookId, chunk_ix: row.chunk_ix,
      content_hash: row.content_hash, model, dim,
      vector: vectorToBlob(row.vector), text: row.text,
    });
  }
});
function replaceEntity(kind, entityId, bookId, model, dim, rows) {
  _replaceTx(kind, entityId, bookId, model, dim, rows || []);
}

// Vollständige Entfernung einer Entität (alle Modelle) — beim Entity-Delete
// aus den Quelltabellen aufzurufen (Pages/Scenes/Figures).
function remove(kind, entityId) {
  _delEntityAll.run(kind, entityId);
}

// ORDER BY macht die MAX_CHUNKS-Kappung im Redundanz-Radar deterministisch: ohne
// stabile Reihenfolge schnitte .slice() in SQLite-rowid-Ordnung, und welche Passagen
// bei einem Buch über dem Cap fehlen, wäre zwischen Läufen nicht reproduzierbar.
const _selBookKinds = db.prepare(
  'SELECT kind, entity_id, chunk_ix, text, vector FROM semantic_chunks WHERE book_id = ? AND model = ? ORDER BY entity_id, chunk_ix'
);

// Brute-Force-Ähnlichkeitssuche innerhalb eines Buches gegen queryVec. Bei
// Buchgrösse (Hunderte–wenige Tausend Chunks) ist der lineare Scan Millisekunden
// — kein sqlite-vec nötig. Filtert aufs aktive Modell (model), optional auf
// kinds und schliesst die Quell-Entität aus (exclude), damit „ähnliche Stellen
// zu dieser Szene" nicht die Szene selbst zurückgibt. Ein Treffer pro Entität
// (bester Chunk), nach Score sortiert, top-K. minScore: Cosinus-Untergrenze —
// die Ähnlichkeitssuche liefert nie „keine Treffer", darum schneidet der Floor
// den schwachen Long-Tail ab (0 = aus).
function searchSimilar(bookId, model, queryVec, { kinds = null, topK = 20, excludeKind = null, excludeEntityId = null, minScore = 0 } = {}) {
  const kindSet = kinds && kinds.length ? new Set(kinds) : null;
  const best = new Map(); // key `${kind}:${entity_id}` → { kind, entity_id, chunk_ix, text, score }
  for (const r of _selBookKinds.all(bookId, model)) {
    if (kindSet && !kindSet.has(r.kind)) continue;
    if (excludeKind && r.kind === excludeKind && r.entity_id === excludeEntityId) continue;
    const score = cosineSim(queryVec, blobToVector(r.vector));
    if (!Number.isFinite(score)) continue;
    if (score < minScore) continue;
    const key = `${r.kind}:${r.entity_id}`;
    const cur = best.get(key);
    if (!cur || score > cur.score) {
      best.set(key, { kind: r.kind, entity_id: r.entity_id, chunk_ix: r.chunk_ix, text: r.text, score });
    }
  }
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, topK);
}

// Beste Chunks INNERHALB einer Entität gegen queryVec. Gegenstück zu
// searchSimilar, das pro Entität nur den besten Chunk liefert: hier zählt die
// Verteilung im Inneren eines langen Dokuments (Recherche-PDF), von dem mehrere
// Passagen zur Frage passen können. Kein Embedding-Call für die Chunks — die
// Vektoren liegen schon; der Aufrufer bringt nur den Query-Vektor mit.
function searchInEntity(kind, entityId, model, queryVec, { topK = 5, minScore = 0 } = {}) {
  const rows = db.prepare(
    'SELECT chunk_ix, text, vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
  ).all(kind, entityId, model);
  const out = [];
  for (const r of rows) {
    const score = cosineSim(queryVec, blobToVector(r.vector));
    if (!Number.isFinite(score) || score < minScore) continue;
    out.push({ chunk_ix: r.chunk_ix, text: r.text, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, topK);
}

// Alle Chunks eines Buches unter einem Modell für den Redundanz-Radar laden:
// pro Chunk { entity_id, chunk_ix, text, vector:Float32Array }, gefiltert auf die
// angegebenen kinds (Redundanz vergleicht nur Seiten). Basis des All-Pairs-
// Cosinus in lib/redundancy.js — kein Embedding-Call, die Vektoren liegen schon.
function loadChunksForPairing(bookId, model, kinds = ['page']) {
  const kindSet = new Set(kinds);
  const out = [];
  for (const r of _selBookKinds.all(bookId, model)) {
    if (!kindSet.has(r.kind)) continue;
    out.push({ entity_id: r.entity_id, chunk_ix: r.chunk_ix, text: r.text, vector: blobToVector(r.vector) });
  }
  return out;
}

// Gemittelte Profil-Vektoren aller Figuren eines Buchs für den Figuren-Dubletten-
// Radar (lib/redundancy.js#findFigureDuplicates). EIN Vektor je Figur (Mittel über
// ihre Chunks unter model). Der JOIN auf figures scoped auf den anfragenden User
// und filtert stale-Figuren — der embed-index indexiert Figuren buchweit über alle
// User und OHNE stale-Filter, ein ungefilterter Vergleich brächte Fremd-User- und
// verwaiste Figuren als Falsch-Treffer. Rückgabe: [{ id, name, vector:Float32Array }].
function loadFigureVectorsForPairing(bookId, userEmail, model) {
  const rows = db.prepare(`
    SELECT sc.entity_id, sc.vector, f.name
      FROM semantic_chunks sc
      JOIN figures f ON f.id = sc.entity_id
     WHERE sc.book_id = ? AND sc.model = ? AND sc.kind = 'figure'
       AND f.book_id = ? AND f.user_email IS ? AND f.stale = 0
     ORDER BY sc.entity_id, sc.chunk_ix
  `).all(bookId, model, bookId, userEmail || null);
  const acc = new Map(); // entity_id → { name, sum:Float32Array, count }
  for (const r of rows) {
    const v = blobToVector(r.vector);
    let e = acc.get(r.entity_id);
    if (!e) { e = { name: r.name, sum: new Float32Array(v.length), count: 0 }; acc.set(r.entity_id, e); }
    if (v.length !== e.sum.length) continue; // Fremdmodell-Rest überspringen
    for (let i = 0; i < v.length; i++) e.sum[i] += v[i];
    e.count++;
  }
  const out = [];
  for (const [id, e] of acc) {
    if (!e.count) continue;
    const vec = new Float32Array(e.sum.length);
    for (let i = 0; i < vec.length; i++) vec[i] = e.sum[i] / e.count;
    out.push({ id, name: e.name, vector: vec });
  }
  return out;
}

// Repräsentativer Vektor einer indizierten Entität = Mittel über ihre Chunks
// (unter model). Basis der „ähnliche Stellen zu dieser Figur/Szene"-Suche —
// kein Embedding-Call nötig, der Vektor liegt schon. null wenn nicht indiziert.
function getEntityVector(kind, entityId, model) {
  const rows = db.prepare(
    'SELECT vector FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ?'
  ).all(kind, entityId, model);
  if (!rows.length) return null;
  const first = blobToVector(rows[0].vector);
  const acc = new Float32Array(first.length);
  for (const r of rows) {
    const v = blobToVector(r.vector);
    if (v.length !== acc.length) continue;
    for (let i = 0; i < acc.length; i++) acc[i] += v[i];
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= rows.length;
  return acc;
}

// Repräsentativer Text einer indizierten Entität = ihre Chunk-Texte in chunk_ix-
// Reihenfolge verkettet (unter model), auf maxChars begrenzt. Query-String für das
// Reranking der „ähnliche Stellen zu dieser Entität"-Suche — der Cross-Encoder
// bewertet (Text, Text)-Paare, der gemittelte Vektor aus getEntityVector taugt nur
// fürs Retrieval. '' wenn nicht indiziert.
function getEntityText(kind, entityId, model, maxChars = 2000) {
  const rows = db.prepare(
    'SELECT text FROM semantic_chunks WHERE kind = ? AND entity_id = ? AND model = ? ORDER BY chunk_ix'
  ).all(kind, entityId, model);
  let out = '';
  for (const r of rows) {
    if (!r.text) continue;
    out += (out ? '\n' : '') + r.text;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars);
}

// Index-Status pro Buch (für die Karte/Admin): Chunks + distinkte Entitäten je
// kind unter dem aktiven Modell, plus ob unter Fremdmodellen Chunks liegen
// (→ „Reindex nötig nach Modellwechsel").
function bookStats(bookId, model) {
  const byKind = db.prepare(`
    SELECT kind, COUNT(*) AS chunks, COUNT(DISTINCT entity_id) AS entities
    FROM semantic_chunks WHERE book_id = ? AND model = ? GROUP BY kind
  `).all(bookId, model);
  const staleModels = db.prepare(
    'SELECT COUNT(*) AS n FROM semantic_chunks WHERE book_id = ? AND model <> ?'
  ).get(bookId, model);
  const total = byKind.reduce((s, r) => s + r.chunks, 0);
  return { model, total, byKind, staleModelChunks: staleModels?.n || 0 };
}

// Verwaiste Chunks nach einem Full-Reindex entfernen: pro kind alle Entitäten
// löschen, die nicht mehr in keepIds stehen (gelöschte Seiten/Szenen/Figuren,
// deren remove()-Hook z.B. bei einem Bulk-Delete nicht lief). Fremdmodell-Chunks
// bleiben unangetastet (model-Filter).
function pruneMissing(bookId, model, kind, keepIds) {
  const keep = new Set((keepIds || []).map(Number));
  const rows = db.prepare(
    'SELECT DISTINCT entity_id FROM semantic_chunks WHERE book_id = ? AND model = ? AND kind = ?'
  ).all(bookId, model, kind);
  const del = db.prepare('DELETE FROM semantic_chunks WHERE book_id = ? AND model = ? AND kind = ? AND entity_id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!keep.has(Number(r.entity_id))) { del.run(bookId, model, kind, r.entity_id); removed++; }
    }
  })();
  return removed;
}

// Index-Frische für die Such-Karte. lastIndexedAt = jüngster Chunk-Timestamp
// (replaceEntity schreibt bei jedem Lauf alle Chunks einer Entität neu → das ist
// der Zeitpunkt des letzten Index-Laufs). staleCount = Quell-Entitäten, deren
// updated_at danach liegt (seither geändert oder neu hinzugekommen) — billiger
// Heuristik-Zähler ohne Re-Hashing. Plus bookStats (total/byKind/staleModel).
function indexStatus(bookId, model) {
  const stats = bookStats(bookId, model);
  const last = db.prepare(
    'SELECT MAX(created_at) AS last FROM semantic_chunks WHERE book_id = ? AND model = ?'
  ).get(bookId, model)?.last || null;
  if (!last) return { indexed: false, lastIndexedAt: null, staleCount: 0, ...stats };
  const _changedSince = (table) => db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE book_id = ? AND updated_at > ?`
  ).get(bookId, last).n;
  const staleCount = _changedSince('pages') + _changedSince('figure_scenes')
                   + _changedSince('figures') + _changedSince('research_items');
  return { indexed: true, lastIndexedAt: last, staleCount, ...stats };
}

// Alle Chunks eines Buches (aktives Modell) löschen — vor einem sauberen
// Full-Reindex bzw. beim Deaktivieren.
function clearBook(bookId, model = null) {
  if (model) db.prepare('DELETE FROM semantic_chunks WHERE book_id = ? AND model = ?').run(bookId, model);
  else db.prepare('DELETE FROM semantic_chunks WHERE book_id = ?').run(bookId);
}

module.exports = {
  getEntityChunks, replaceEntity, remove, searchSimilar, searchInEntity, getEntityVector, getEntityText,
  bookStats, clearBook, pruneMissing, indexStatus,
  loadChunksForPairing, loadFigureVectorsForPairing,
};
