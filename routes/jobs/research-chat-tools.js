'use strict';
// Werkzeuge für den agentischen Recherche-Chat (Claude-only, mit Web-Suche).
// Rückwärtsgewandt: liest vorhandenes Material + Buch-Entitäten und SAMMELT
// Vorschläge — schreibt NIE Buchtext und persistiert NICHTS automatisch.
//
// `web_search` ist Anthropics serverseitiges Tool und hat hier KEINEN Handler —
// die API führt es selbst aus (siehe lib/ai.js: server_tool_use wird nicht an den
// Caller durchgereicht). `propose_research_item` sammelt nur in ctx.proposals;
// der User bestätigt jeden Vorschlag im Frontend (POST /research).
//
// ctx = { bookId, userEmail, jobSignal, logger, proposals: [] }

const { db } = require('../../db/schema');
const { _truncateResult } = require('./book-chat-tools/shared');
const searchIndex = require('../../lib/search');
const embed = require('../../lib/embed');
const semanticRetrieval = require('../../lib/semantic-retrieval');
const {
  PROPOSAL_KINDS, LIST_FILTER_KINDS, TITLE_MAX, BODY_MAX, SOURCE_MAX,
  cleanStr, normalizeUrls, normalizeTags,
} = require('../../lib/research-validate');

// FTS-Vorfilter weit fassen (wie das Board), dann auf ITEM_LIST_MAX kappen.
const FTS_LIMIT = 500;
const ITEM_LIST_MAX = 60;
const SNIPPET_MAX = 220;
const DOC_TEXT_MAX = 8000;
const MAX_PROPOSALS = 12;

const _snip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── list_research_items ──────────────────────────────────────────────────────
function tool_list_research_items(input, ctx) {
  const where = ['ri.book_id = ?', 'ri.archived = 0'];
  const vals = [ctx.bookId];
  if (LIST_FILTER_KINDS.has(input.kind)) { where.push('ri.kind = ?'); vals.push(input.kind); }

  const q = String(input.q || '').trim();
  if (q) {
    try {
      const hits = searchIndex.query(q, { bookId: ctx.bookId, kinds: ['research'], limit: FTS_LIMIT });
      const ids = (hits?.hits || []).map(h => h.entity_id).filter(Boolean);
      if (!ids.length) return { items: [], count: 0, total: 0, truncated: false };
      where.push(`ri.id IN (${ids.map(() => '?').join(',')})`);
      vals.push(...ids);
    } catch (e) {
      ctx.logger?.warn?.(`[research-chat] FTS-Filter fehlgeschlagen: ${e.message}`);
    }
  }

  // Gesamtzahl passender Einträge — damit das Modell weiß, ob die auf ITEM_LIST_MAX
  // gedeckelte Liste truncated ist (statt still „nur diese existieren" anzunehmen).
  const total = db.prepare(`SELECT COUNT(*) AS n FROM research_items ri WHERE ${where.join(' AND ')}`).get(...vals)?.n || 0;

  const rows = db.prepare(
    `SELECT ri.id, ri.kind, ri.title, ri.body, ri.source, ri.doc_name,
            (ri.doc_mime IS NOT NULL) AS has_doc
       FROM research_items ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.pinned DESC, ri.updated_at DESC
      LIMIT ${ITEM_LIST_MAX}`
  ).all(...vals);

  const idPh = rows.length ? rows.map(() => '?').join(',') : '';
  const tagRows = rows.length
    ? db.prepare(`SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${idPh})`).all(...rows.map(r => r.id))
    : [];
  const tagsBy = new Map();
  for (const t of tagRows) { if (!tagsBy.has(t.item_id)) tagsBy.set(t.item_id, []); tagsBy.get(t.item_id).push(t.tag); }

  const urlRows = rows.length
    ? db.prepare(`SELECT item_id, url FROM research_item_urls WHERE item_id IN (${idPh}) ORDER BY item_id, position, id`).all(...rows.map(r => r.id))
    : [];
  const urlsBy = new Map();
  for (const u of urlRows) { if (!urlsBy.has(u.item_id)) urlsBy.set(u.item_id, []); urlsBy.get(u.item_id).push(u.url); }

  const items = rows.map(r => {
    const urls = urlsBy.get(r.id) || [];
    return {
      id: r.id,
      kind: r.kind,
      title: r.title || '',
      snippet: _snip(r.body || urls[0] || r.source, SNIPPET_MAX),
      tags: tagsBy.get(r.id) || [],
      url_count: urls.length,
      has_doc: !!r.has_doc,
      ...(r.doc_name ? { doc_name: r.doc_name } : {}),
    };
  });
  return { items, count: items.length, total, truncated: total > items.length };
}

// ── read_research_item ───────────────────────────────────────────────────────
function tool_read_research_item(input, ctx) {
  const id = parseInt(input.id, 10);
  if (!id) return { error: 'id fehlt oder ungültig.' };
  const row = db.prepare(
    `SELECT id, kind, title, body, source, doc_name, doc_text
       FROM research_items WHERE id = ? AND book_id = ?`
  ).get(id, ctx.bookId);
  if (!row) return { error: 'Eintrag nicht gefunden.' };
  const tags = db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ? ORDER BY tag').all(id).map(t => t.tag);
  const urls = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id')
    .all(id).map(u => ({ url: u.url, label: u.label || '' }));
  // Ein langes PDF passt nicht in ein Tool-Result. Die Kappung wird deshalb
  // AUSGEWIESEN (doc_chars + doc_truncated) statt still zu passieren — sonst hält
  // das Modell den Anfang für das ganze Dokument. Der Rest ist über
  // search_research_passages(item_id) erreichbar.
  const docText = String(row.doc_text || '');
  const docTruncated = docText.length > DOC_TEXT_MAX;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title || '',
    body: row.body || '',
    urls,
    source: row.source || '',
    tags,
    ...(row.doc_name ? { doc_name: row.doc_name } : {}),
    ...(docText ? {
      doc_text: docText.slice(0, DOC_TEXT_MAX),
      doc_chars: docText.length,
      doc_truncated: docTruncated,
      ...(docTruncated ? { hinweis: `Nur die ersten ${DOC_TEXT_MAX} von ${docText.length} Zeichen. Für Stellen weiter hinten: search_research_passages mit item_id=${row.id} und deiner Frage.` } : {}),
    } : {}),
  };
}

// ── search_research_passages ─────────────────────────────────────────────────
// Semantischer Zugriff aufs Archiv. Zwei Modi, ein Werkzeug:
//   ohne item_id → beste Passage je Eintrag, über das ganze Board (semanticQuery,
//                  kinds:['research'] → Hybrid-Fusion mit FTS + optional Rerank)
//   mit item_id  → mehrere Passagen INNERHALB eines Eintrags (passagesInEntity).
// Der zweite Modus ist der Grund für das Werkzeug: `read_research_item` liefert
// von einem langen PDF nur den Anfang, hier kommen die zur Frage passenden
// Stellen aus der Mitte. Setzt den Embedding-Index voraus (routes/jobs/embed-index)
// — ist er leer, sind die Treffer leer und das Modell fällt auf die Wortsuche in
// `list_research_items` zurück.
const PASSAGE_MAX = 1200;
const PASSAGE_TOPK_DEFAULT = 6;
const PASSAGE_TOPK_MAX = 15;

async function tool_search_research_passages(input, ctx) {
  const q = String(input.q || '').trim();
  if (!q) return { error: 'q fehlt.' };
  if (!embed.isEnabled()) {
    return { error: 'Semantische Suche ist nicht aktiviert. Nutze list_research_items (Wortsuche).' };
  }
  const topK = Math.min(Math.max(parseInt(input.top_k, 10) || PASSAGE_TOPK_DEFAULT, 1), PASSAGE_TOPK_MAX);
  const itemId = input.item_id ? parseInt(input.item_id, 10) : null;

  try {
    if (itemId) {
      // Buch-Guard: nur Einträge DIESES Buchs; sonst liesse sich über eine geratene
      // id fremdes Material lesen (der Index selbst ist buchübergreifend).
      const row = db.prepare(
        "SELECT id, COALESCE(NULLIF(title,''), doc_name) AS title FROM research_items WHERE id = ? AND book_id = ?"
      ).get(itemId, ctx.bookId);
      if (!row) return { error: 'Eintrag nicht gefunden.' };
      const passages = await semanticRetrieval.passagesInEntity('research', itemId, q, { topK, signal: ctx.jobSignal });
      return {
        item_id: itemId, title: row.title || '', q,
        passages: passages.map(p => ({ passage: _snip(p.text, PASSAGE_MAX), score: Math.round(p.score * 1000) / 1000 })),
        count: passages.length,
        ...(passages.length ? {} : { hinweis: 'Keine Passage im Index — ist der Eintrag schon indexiert?' }),
      };
    }

    const hits = await semanticRetrieval.semanticQuery(ctx.bookId, q, { kinds: ['research'], topK, signal: ctx.jobSignal });
    if (!hits.length) return { q, results: [], count: 0 };
    const ids = hits.map(h => h.entity_id);
    const meta = new Map(
      db.prepare(
        `SELECT id, kind, COALESCE(NULLIF(title,''), doc_name) AS title, doc_name
           FROM research_items WHERE book_id = ? AND id IN (${ids.map(() => '?').join(',')})`
      ).all(ctx.bookId, ...ids).map(r => [r.id, r])
    );
    const results = hits
      .filter(h => meta.has(h.entity_id))   // Fremdbuch-/Geister-Chunk überspringen
      .map(h => {
        const m = meta.get(h.entity_id);
        return {
          item_id: h.entity_id, kind: m.kind, title: m.title || '',
          ...(m.doc_name ? { doc_name: m.doc_name } : {}),
          passage: _snip(h.text, PASSAGE_MAX),
          score: Math.round(h.score * 1000) / 1000,
        };
      });
    return { q, results, count: results.length };
  } catch (e) {
    ctx.logger?.warn?.(`[research-chat] Passagen-Suche fehlgeschlagen: ${e.message}`);
    return { error: `Semantische Suche nicht verfügbar (${e.message}). Nutze list_research_items (Wortsuche).` };
  }
}

// ── list_book_entities ───────────────────────────────────────────────────────
const ENTITY_QUERIES = {
  figur:  'SELECT id, name AS label, typ, rolle, beschreibung FROM figures WHERE book_id = ? AND user_email = ? AND COALESCE(stale,0) = 0 ORDER BY sort_order, name',
  ort:    'SELECT id, name AS label, typ, land, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name',
  szene:  'SELECT id, titel AS label, kommentar FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel',
  beat:   'SELECT id, titel AS label, beschreibung FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel',
  strang: 'SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name',
};
const ENTITY_LIMIT = 120;

function _entityList(art, ctx) {
  const sql = ENTITY_QUERIES[art];
  if (!sql) return [];
  return db.prepare(sql).all(ctx.bookId, ctx.userEmail || null).slice(0, ENTITY_LIMIT).map(r => {
    const meta = [_snip(r.typ, 40), _snip(r.rolle || r.land, 40), _snip(r.beschreibung || r.kommentar, 140)]
      .filter(Boolean).join(' · ');
    return { id: r.id, name: r.label, ...(meta ? { kontext: meta } : {}) };
  });
}

function tool_list_book_entities(input, ctx) {
  const art = ['figur', 'ort', 'szene', 'beat', 'strang'].includes(input.art) ? input.art : 'alle';
  if (art !== 'alle') return { art, entities: _entityList(art, ctx) };
  return {
    figuren:        _entityList('figur', ctx),
    schauplaetze:   _entityList('ort', ctx),
    szenen:         _entityList('szene', ctx),
    plot_abschnitte: _entityList('beat', ctx),
    handlungsstraenge: _entityList('strang', ctx),
  };
}

// ── propose_research_item ────────────────────────────────────────────────────
// Persistiert NICHTS — sammelt nur in ctx.proposals; der User bestätigt im Frontend.
function tool_propose_research_item(input, ctx) {
  const kind = PROPOSAL_KINDS.has(input.kind) ? input.kind : 'note';
  const title = cleanStr(input.title, TITLE_MAX) || '';
  const body = cleanStr(input.body, BODY_MAX) || '';
  const source = cleanStr(input.source, SOURCE_MAX) || '';
  const tags = normalizeTags(input.tags);

  // Normalisierung (http(s)-only, Dedup, Cap, Label) geteilt mit POST /research
  // über lib/research-validate — so kann der Vorschlag nicht andere Regeln
  // akzeptieren als das Speichern später durchlässt.
  const { urls, hadBadUrl } = normalizeUrls(input.urls);

  if (!title && !body && !urls.length) {
    return { ok: false, error: 'Vorschlag braucht mindestens Titel, Inhalt oder eine URL.' };
  }
  if (hadBadUrl && !urls.length) return { ok: false, error: 'URLs müssen mit http:// oder https:// beginnen.' };

  if ((ctx.proposals?.length || 0) >= MAX_PROPOSALS) {
    return { ok: false, error: `Maximal ${MAX_PROPOSALS} Vorschläge pro Antwort.` };
  }
  const proposal = { kind, title, body, urls, source, tags };
  ctx.proposals.push(proposal);
  return { ok: true, accepted_as_proposal: true, kind, title: title || urls[0]?.url || _snip(body, 60) };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
const TOOLS = {
  list_research_items: tool_list_research_items,
  read_research_item:  tool_read_research_item,
  search_research_passages: tool_search_research_passages,
  list_book_entities:  tool_list_book_entities,
  propose_research_item: tool_propose_research_item,
};

async function executeResearchTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeResearchTool, TOOLS, entityList: _entityList };
