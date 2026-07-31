'use strict';
// Zentraler Freitext-Query-Pfad der semantischen Suche — eine Stelle für alle
// Qualitäts-Stufen, geteilt von der Such-Route und dem Buch-Chat-Tool
// `search_similar`:
//
//   1. Retrieval   — Embedding-Cosinus (embed.min_score als Long-Tail-Floor)
//   2. Hybrid      — optionale Fusion mit der FTS5/bm25-Rangliste via RRF
//                    (embed.hybrid) → exakte Begriffe/Eigennamen kommen zurück
//   3. Reranking   — optionale Cross-Encoder-Nachordnung des Kandidatenpools
//                    (rerank.*) → schärfere Relevanz als Retrieval allein
//
// Rein rückwärtsgewandt (findet Bestehendes, schreibt nie in den Buchtext).
//
// Drei Einstiege:
//   - semanticQuery()    — Freitext-Anfrage (Retrieval → Hybrid → Rerank).
//   - similarToEntity()  — „ähnliche Stellen zu Figur/Szene/Seite": Retrieval über
//                          den gemittelten Entitäts-Vektor (kein Hybrid — kein
//                          Anfragetext), Rerank optional gegen den Entitäts-TEXT.
//   - passagesInEntity() — „was steht in DIESEM Dokument zu X": mehrere Passagen
//                          innerhalb EINER Entität (langes Recherche-PDF).
// rerankOrder() ist das generische Reorder-Primitiv für Pfade mit eigenem
// Retrieval (z.B. die FTS-Literalsuche des Buch-Chats).

const appSettings = require('./app-settings');
const embed = require('./embed');
const rerank = require('./rerank');
const semanticChunks = require('../db/semantic-chunks');
const sourceSemanticChunks = require('../db/source-semantic-chunks');
const searchIndex = require('./search');
const { fuseCandidates } = require('./semantic-fusion');
const logger = require('../logger');

function _hybridEnabled() {
  return appSettings.get('embed.hybrid') !== false;
}
function _minScore() {
  const v = Number(appSettings.get('embed.min_score'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Cross-Encoder-Nachordnung, geteilt von allen drei Retrieval-Pfaden
// (Freitext im Buch, „ähnliche Stellen", Freitext in der Quellen-Bibliothek).
// Sie unterschieden sich nur in der Form ihrer Treffer — die Mechanik
// (topN-Ausschnitt, minScore-Filter, Abort-Weiterreichen, stiller Fallback auf
// die eigene Reihenfolge) ist dieselbe und lag dreimal fast gleich im Modul.
//
// Rückgabe: [{ cand, score }] in finaler Reihenfolge, oder `null` wenn Rerank
// aus, ohne Kandidaten oder der Endpunkt nicht erreichbar ist — dann behält der
// Aufrufer seine eigene Reihenfolge. Der Aufrufer mappt `cand` in seine Form.
async function _rerankCandidates(queryText, cands, { topK, signal, label }) {
  if (!rerank.isEnabled()) return null;
  const q = String(queryText == null ? '' : queryText).trim();
  if (!q || !cands.length) return null;
  const rr = rerank.getConfig();
  const pool = cands.slice(0, rr.topN);
  let order = null;
  try {
    order = await rerank.rerank(q, pool.map(c => c.text), { signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    logger.warn(`[semantic] Reranker (${label}) nicht erreichbar, Fallback auf die Retrieval-Reihenfolge: ${e.message}`);
  }
  if (!order || !order.length) return null;
  return order
    .filter(o => o.score >= (rr.minScore || 0))
    .slice(0, topK)
    .map(o => ({ cand: pool[o.index], score: o.score }));
}

// Freitext-Semantiksuche. bookId + query Pflicht. kinds default = alle indizierten
// Kinds (page/scene/figure). Rückgabe: [{ kind, entity_id, text, score }] in
// finaler Reihenfolge (score-Bedeutung: Rerank-Relevanz > RRF-Score > Cosinus,
// je nachdem welche Stufe aktiv ist). Fällt der Reranker aus → RRF/Cosinus.
async function semanticQuery(bookId, query, { kinds = null, topK = 20, signal } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];

  const { model } = embed.getConfig();
  const useHybrid = _hybridEnabled();
  const useRerank = rerank.isEnabled();
  const rr = useRerank ? rerank.getConfig() : null;

  // Kandidatenpool grösser ziehen als topK, damit Fusion/Rerank Spielraum haben.
  const pool = Math.min(100, Math.max(topK, useRerank ? rr.topN : 0, useHybrid ? 30 : 0));

  const qVec = await embed.embedQuery(q, { signal });
  const semHits = semanticChunks.searchSimilar(bookId, model, qVec, {
    kinds, topK: pool, minScore: _minScore(),
  });

  let ftsHits = [];
  if (useHybrid) {
    try {
      const r = searchIndex.query(q, { bookId, kinds, limit: pool });
      ftsHits = (r.hits || []).filter(h => !kinds || kinds.includes(h.kind));
    } catch (e) {
      logger.warn(`[semantic] Hybrid-FTS fehlgeschlagen ("${q}"): ${e.message}`);
    }
  }

  const fused = fuseCandidates(semHits, ftsHits);
  if (!fused.length) return [];

  const ranked = await _rerankCandidates(q, fused, { topK, signal, label: 'Freitext' });
  if (ranked) {
    return ranked.map(({ cand, score }) => ({
      kind: cand.kind, entity_id: cand.entity_id, text: cand.text,
      score, semScore: cand.semScore,
    }));
  }
  // sonst: still auf die Fusions-Reihenfolge zurückfallen

  return fused.slice(0, topK).map(c => ({
    kind: c.kind,
    entity_id: c.entity_id,
    text: c.text,
    // Hybrid: RRF-Score (listen-intern vergleichbar). Reine Semantik: Cosinus.
    score: useHybrid ? c.rrf : (c.semScore != null ? c.semScore : c.rrf),
    // Roher Cosinus (0–1, oder null für reine FTS-Fusions-Kandidaten). Stabil und
    // absolut interpretierbar, unabhängig von Hybrid/Rerank — Aufrufer, die eine
    // Konfidenz brauchen (Motiv-Ist-Index), lesen semScore statt score.
    semScore: c.semScore,
  }));
}

// Obergrenze für den synthetischen Rerank-Query-Text einer Entität. bge-reranker
// verträgt lange Eingaben; 2000 Zeichen decken Figuren-Beschreibung / Szenen-Text
// repräsentativ ab, ohne den Cross-Encoder mit einer ganzen Seite zu fluten.
const ENTITY_QUERY_MAXCHARS = 2000;

// „Ähnliche Stellen zu Entität" (Button an Figuren/Szenen/Seiten). Retrieval über
// den gemittelten Entitäts-Vektor — kein Score-Floor, hier zählt Recall (der
// gemittelte Vektor rankt tendenziell tiefer als eine Freitext-Anfrage). Bei
// aktivem Reranker wird der Kandidatenpool anschliessend per Cross-Encoder gegen
// den Entitäts-TEXT geschärft (behebt die schwache Reine-Vektor-Präzision dieses
// Pfads). Rückgabe: { notIndexed, hits:[{ kind, entity_id, text, score }] }.
async function similarToEntity(bookId, likeKind, likeId, { kinds = null, topK = 20, signal } = {}) {
  const { model } = embed.getConfig();
  const qVec = semanticChunks.getEntityVector(likeKind, likeId, model);
  if (!qVec) return { notIndexed: true, hits: [] };

  const useRerank = rerank.isEnabled();
  const rr = useRerank ? rerank.getConfig() : null;
  const pool = useRerank ? Math.min(100, Math.max(topK, rr.topN)) : topK;

  const cands = semanticChunks.searchSimilar(bookId, model, qVec, {
    kinds, topK: pool, excludeKind: likeKind, excludeEntityId: likeId,
  });
  if (!cands.length) return { notIndexed: false, hits: [] };

  if (useRerank) {
    const qText = semanticChunks.getEntityText(likeKind, likeId, model, ENTITY_QUERY_MAXCHARS);
    const ranked = await _rerankCandidates(qText, cands, { topK, signal, label: 'ähnliche Stellen' });
    if (ranked) {
      return {
        notIndexed: false,
        hits: ranked.map(({ cand, score }) => ({
          kind: cand.kind, entity_id: cand.entity_id, text: cand.text, score,
        })),
      };
    }
    // sonst: still auf die Cosinus-Reihenfolge zurückfallen
  }

  return {
    notIndexed: false,
    hits: cands.slice(0, topK).map(c => ({ kind: c.kind, entity_id: c.entity_id, text: c.text, score: c.score })),
  };
}

// Generisches Reorder-Primitiv für Pfade mit eigenem Retrieval (z.B. die FTS-
// Literalsuche des Buch-Chats): ordnet die Index-Reihenfolge von docs per Cross-
// Encoder gegen queryText neu. Rückgabe: Array der Original-Indizes (absteigende
// Relevanz), gefolgt von den nicht gerankten Rest-Indizes (Recall bleibt voll —
// es wird nichts verworfen). null wenn Rerank aus, docs < 2 oder Endpunkt nicht
// erreichbar → der Aufrufer behält seine eigene Reihenfolge. Filtert bewusst NICHT
// nach minScore (der Aufrufer entscheidet, ob Kandidaten wegfallen dürfen).
async function rerankOrder(queryText, docs, { signal } = {}) {
  if (!rerank.isEnabled()) return null;
  const q = String(queryText == null ? '' : queryText).trim();
  const list = Array.isArray(docs) ? docs : [];
  if (!q || list.length < 2) return null;

  const rr = rerank.getConfig();
  const poolN = Math.min(list.length, rr.topN);
  let order;
  try {
    order = await rerank.rerank(q, list.slice(0, poolN).map(d => String(d == null ? '' : d)), { signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    logger.warn(`[semantic] Reranker (Reorder) nicht erreichbar, Reihenfolge unverändert: ${e.message}`);
    return null;
  }
  if (!order || !order.length) return null;

  const ranked = order.map(o => o.index);
  const seen = new Set(ranked);
  const rest = [];
  for (let i = 0; i < list.length; i++) if (!seen.has(i)) rest.push(i);
  return ranked.concat(rest);
}

// Passagen INNERHALB einer indizierten Entität (Anwendungsfall: langes Recherche-
// PDF). `semanticQuery` gibt pro Entität nur den besten Chunk zurück — für die
// Frage „was steht in DIESEM Dokument zu X" ist das zu wenig. Hier wird der
// Anfragetext einmal embeddet, gegen die bereits liegenden Chunk-Vektoren der
// Entität verglichen und der Kandidatenpool optional per Cross-Encoder geschärft
// (non-fatal). Rückgabe: [{ chunk_ix, text, score }] in finaler Reihenfolge.
async function passagesInEntity(kind, entityId, query, { topK = 5, signal } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];

  const { model } = embed.getConfig();
  const useRerank = rerank.isEnabled();
  const pool = useRerank ? Math.min(30, Math.max(topK, rerank.getConfig().topN)) : topK;

  const qVec = await embed.embedQuery(q, { signal });
  const cands = semanticChunks.searchInEntity(kind, entityId, model, qVec, { topK: pool, minScore: _minScore() });
  if (!cands.length) return [];

  const order = await rerankOrder(q, cands.map(c => c.text), { signal });
  const ranked = order ? order.map(i => cands[i]) : cands;
  return ranked.slice(0, topK);
}

// Freitext-Semantiksuche über die Quellen-PDFs eines Users (Pool-Scope). Pendant
// zu `semanticQuery`, aber **user-skopiert** statt buchskopiert: Quellen gehören
// dem User, nicht einem Buch → kein `bookId`, keine FTS5-Hybridfusion (Quellen
// liegen nicht in `search_index`, dessen ACL buchbasiert ist). Score-Floor +
// optionales Cross-Encoder-Reranking wie im Buchpfad. Rückgabe:
// [{ source_id, text, title, citekey, score, semScore }] in finaler Reihenfolge.
async function semanticSourceQuery(userEmail, query, { topK = 20, signal } = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];

  const { model } = embed.getConfig();
  const useRerank = rerank.isEnabled();
  const pool = Math.min(100, Math.max(topK, useRerank ? rerank.getConfig().topN : 0));

  const qVec = await embed.embedQuery(q, { signal });
  const hits = sourceSemanticChunks.searchSimilarSources(userEmail, model, qVec, {
    topK: pool, minScore: _minScore(),
  });
  if (!hits.length) return [];

  const ranked = await _rerankCandidates(q, hits, { topK, signal, label: 'Quellen' });
  if (ranked) {
    return ranked.map(({ cand, score }) => ({
      source_id: cand.source_id, text: cand.text, title: cand.title,
      citekey: cand.citekey, score, semScore: cand.score,
    }));
  }

  return hits.slice(0, topK).map(c => ({
    source_id: c.source_id, text: c.text, title: c.title, citekey: c.citekey,
    score: c.score, semScore: c.score,
  }));
}

module.exports = { semanticQuery, similarToEntity, passagesInEntity, rerankOrder, semanticSourceQuery };
