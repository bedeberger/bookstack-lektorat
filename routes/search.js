'use strict';
// Volltextsuche-API.
//
// GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0
//   - ACL strikt: JOIN gegen book_access via session.user.email.
//   - book_id: viewer-Guard auf das Buch (Cross-Book-Suche unterbunden).
//   - kind: Komma-Liste aus VALID_KINDS (book/chapter/page/figure/location/
//           scene/idea); Default = page,chapter (Spec-Default).
//   - Trigram-Fallback automatisch bei Single-Word-Zero-Hit.
//
// Response: { hits: [{ kind, entity_id, book_id, title, snippet, rank }],
//             fallback: boolean }

const express = require('express');
const { toIntId } = require('../lib/validate');
const { requireBookAccess, sendACLError, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const bookAccess = require('../db/book-access');
const searchIndex = require('../lib/search');
const semanticChunks = require('../db/semantic-chunks');
const embed = require('../lib/embed');
const semanticRetrieval = require('../lib/semantic-retrieval');
const { db } = require('../db/connection');
const logger = require('../logger');

const router = express.Router();

const DEFAULT_KINDS = ['page', 'chapter'];
// Kinds, für die ein Embedding-Index existiert (semantische Suche).
const SEMANTIC_KINDS = ['page', 'scene', 'figure', 'research'];

function _parseKinds(raw) {
  if (raw == null) return DEFAULT_KINDS;
  const s = String(raw).trim();
  if (!s || s === '*' || s === 'all') return Array.from(searchIndex.VALID_KINDS);
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const filtered = parts.filter(k => searchIndex.VALID_KINDS.has(k));
  return filtered.length ? filtered : DEFAULT_KINDS;
}

router.get('/', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ hits: [], fallback: false });
  if (q.length > 200) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const bookId = req.query.book_id ? toIntId(req.query.book_id) : null;
  if (req.query.book_id && !bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  if (bookId) {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const kinds = _parseKinds(req.query.kind);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let allowedBookIds = null;
  if (!bookId) {
    allowedBookIds = bookAccess.listBookIdsForUser(email).map(r => r.book_id);
    if (!allowedBookIds.length) return res.json({ hits: [], fallback: false });
  }

  try {
    const result = searchIndex.query(q, {
      allowedBookIds, kinds, bookId, limit, offset,
    });
    res.json({
      hits: result.hits || [],
      fallback: !!result.fallback,
    });
  } catch (e) {
    logger.error(`[search] GET /search failed: ${e.message}`);
    res.status(500).json({ error_code: 'SEARCH_FAILED', detail: e.message });
  }
});

// Semantische Suche (Embedding-basiert, buch-skopiert). Zwei Eingänge:
//   ?q=…                    → Freitext, wird einmal embeddet
//   ?like_kind=…&like_id=…  → „ähnliche Stellen zu dieser Entität" (Figur/Szene/
//                             Seite); nutzt den bereits indizierten Mittelvektor,
//                             KEIN Embedding-Call, und schliesst die Quelle aus.
// Immer book_id-Pflicht (Vektoren leben pro Buch) + viewer-ACL. Trefferformat
// spiegelt die FTS-Route: { kind, entity_id, book_id, title, snippet, score }.
// Snippet fliesst im Frontend in einen x-html-Sink (search.html) → server-seitig
// escapen (Hard-Rule „x-html nur mit vorab-escaptem Content"). Kein <mark> nötig
// (semantische Treffer haben keine Wort-Offsets).
function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _resolveSemanticHits(hits) {
  const out = [];
  for (const h of hits) {
    let row = null;
    if (h.kind === 'page') row = db.prepare('SELECT page_name AS title, book_id FROM pages WHERE page_id = ?').get(h.entity_id);
    else if (h.kind === 'scene') row = db.prepare('SELECT titel AS title, book_id FROM figure_scenes WHERE id = ?').get(h.entity_id);
    else if (h.kind === 'figure') row = db.prepare('SELECT name AS title, book_id FROM figures WHERE id = ?').get(h.entity_id);
    // Recherche-Schnipsel haben keinen Pflichttitel — der Dateiname des
    // hochgeladenen PDFs ist dann die einzige Beschriftung, die der Treffer hat.
    else if (h.kind === 'research') row = db.prepare("SELECT COALESCE(NULLIF(title,''), doc_name) AS title, book_id FROM research_items WHERE id = ?").get(h.entity_id);
    if (!row) continue; // gelöschte Entität → Geister-Chunk überspringen
    out.push({
      kind: h.kind, entity_id: h.entity_id, book_id: row.book_id,
      title: row.title || '', snippet: _escHtml(String(h.text || '').slice(0, 300)),
      score: Math.round(h.score * 1000) / 1000,
    });
  }
  return out;
}

router.get('/semantic', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const rawKinds = _parseKinds(req.query.kind).filter(k => SEMANTIC_KINDS.includes(k));
  const kinds = rawKinds.length ? rawKinds : SEMANTIC_KINDS;
  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const likeKind = String(req.query.like_kind || '').trim();
  const likeId = req.query.like_id ? toIntId(req.query.like_id) : null;

  try {
    if (likeKind && likeId && SEMANTIC_KINDS.includes(likeKind)) {
      // „Ähnliche Stellen zu Entität": Retrieval über den gemittelten Entitäts-
      // Vektor, danach optionales Reranking gegen den Entitäts-Text (siehe
      // lib/semantic-retrieval#similarToEntity). Kein Hybrid — hier gibt es keinen
      // Anfragetext für die FTS-Seite.
      const sim = await semanticRetrieval.similarToEntity(bookId, likeKind, likeId, { kinds, topK });
      if (sim.notIndexed) return res.json({ hits: [], mode: 'semantic', notIndexed: true });
      return res.json({ hits: _resolveSemanticHits(sim.hits), mode: 'semantic' });
    }
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json({ hits: [], mode: 'semantic' });
    if (q.length > 500) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });
    // Freitext: Retrieval → Hybrid-Fusion → Reranking (siehe lib/semantic-retrieval).
    const raw = await semanticRetrieval.semanticQuery(bookId, q, { kinds, topK });
    res.json({ hits: _resolveSemanticHits(raw), mode: 'semantic' });
  } catch (e) {
    logger.error(`[search] GET /search/semantic failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE', detail: e.message });
  }
});

// Index-Frische für die Such-Karte (semantische Suche). Zeigt an, wann der
// Embedding-Index zuletzt gebaut wurde und wie viele Einträge seither geändert
// wurden (→ „Index veraltet, neu bauen"). Reiner Lese-Status, kein Embedding-Call.
router.get('/semantic/status', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.json({ enabled: false });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const { model } = embed.getConfig();
  try {
    res.json({ enabled: true, ...semanticChunks.indexStatus(bookId, model) });
  } catch (e) {
    logger.error(`[search] GET /search/semantic/status failed: ${e.message}`);
    res.status(500).json({ error_code: 'STATUS_FAILED', detail: e.message });
  }
});

// Semantische Suche über die Quellen-PDFs des Users (Pool-Scope). Pendant zu
// /search/semantic, aber **user-skopiert**: keine book_id, keine Buch-ACL —
// der User durchsucht seine eigene Bibliothek. Trefferformat:
//   { source_id, title, citekey, snippet, score }
// Der Snippet ist ROHTEXT und wird bewusst NICHT escapt: er landet in einem
// `x-text`-Sink (public/partials/sources-lib-search.html), der selbst escapt —
// ein zweiter Durchgang zeigte dem Leser sichtbare `&amp;`/`&lt;` im Zitat.
// Anders als /search/semantic, dessen Snippet ein <mark>-Highlight traegt und
// darum ueber x-html geht. Wer den Sink hier auf x-html umstellt, muss das
// Escaping mit umstellen.
router.get('/sources-semantic', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ hits: [], mode: 'sources-semantic' });
  if (q.length > 500) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  try {
    const raw = await semanticRetrieval.semanticSourceQuery(email, q, { topK });
    const hits = raw.map(h => ({
      source_id: h.source_id,
      title: h.title || '', citekey: h.citekey || '',
      snippet: String(h.text || '').slice(0, 300),
      score: Math.round(h.score * 1000) / 1000,
    }));
    res.json({ hits, mode: 'sources-semantic' });
  } catch (e) {
    logger.error(`[search] GET /search/sources-semantic failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE', detail: e.message });
  }
});

module.exports = router;
