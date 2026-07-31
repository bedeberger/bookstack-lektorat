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
// Zwei Einstiege:
//   - semanticQuery()    — Freitext-Anfrage (Retrieval → Hybrid → Rerank).
//   - similarToEntity()  — „ähnliche Stellen zu Figur/Szene/Seite": Retrieval über
//                          den gemittelten Entitäts-Vektor (kein Hybrid — kein
//                          Anfragetext), Rerank optional gegen den Entitäts-TEXT.
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

  if (useRerank) {
    const cands = fused.slice(0, rr.topN);
    let order = null;
    try {
      order = await rerank.rerank(q, cands.map(c => c.text), { signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      logger.warn(`[semantic] Reranker nicht erreichbar, RRF-Fallback: ${e.message}`);
    }
    if (order && order.length) {
      return order
        .filter(o => o.score >= (rr.minScore || 0))
        .slice(0, topK)
        .map(o => ({ kind: cands[o.index].kind, entity_id: cands[o.index].entity_id, text: cands[o.index].text, score: o.score, semScore: cands[o.index].semScore }));
    }
    // sonst: still auf die Fusions-Reihenfolge zurückfallen
  }

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
    if (qText) {
      let order = null;
      try {
        order = await rerank.rerank(qText, cands.map(c => c.text), { signal });
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        logger.warn(`[semantic] Reranker (ähnliche Stellen) nicht erreichbar, Cosinus-Fallback: ${e.message}`);
      }
      if (order && order.length) {
        return {
          notIndexed: false,
          hits: order
            .filter(o => o.score >= (rr.minScore || 0))
            .slice(0, topK)
            .map(o => ({ kind: cands[o.index].kind, entity_id: cands[o.index].entity_id, text: cands[o.index].text, score: o.score })),
        };
      }
      // sonst: still auf die Cosinus-Reihenfolge zurückfallen
    }
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
  const rr = useRerank ? rerank.getConfig() : null;
  const pool = Math.min(100, Math.max(topK, useRerank ? rr.topN : 0));

  const qVec = await embed.embedQuery(q, { signal });
  const hits = sourceSemanticChunks.searchSimilarSources(userEmail, model, qVec, {
    topK: pool, minScore: _minScore(),
  });
  if (!hits.length) return [];

  if (useRerank) {
    const cands = hits.slice(0, rr.topN);
    let order = null;
    try {
      order = await rerank.rerank(q, cands.map(c => c.text), { signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      logger.warn(`[semantic] Quellen-Reranker nicht erreichbar, Cosinus-Fallback: ${e.message}`);
    }
    if (order && order.length) {
      return order
        .filter(o => o.score >= (rr.minScore || 0))
        .slice(0, topK)
        .map(o => ({
          source_id: cands[o.index].source_id,
          text: cands[o.index].text, title: cands[o.index].title,
          citekey: cands[o.index].citekey,
          score: o.score, semScore: cands[o.index].score,
        }));
    }
  }

  return hits.slice(0, topK).map(c => ({
    source_id: c.source_id, text: c.text, title: c.title, citekey: c.citekey,
    score: c.score, semScore: c.score,
  }));
}

module.exports = { semanticQuery, similarToEntity, rerankOrder, semanticSourceQuery };
