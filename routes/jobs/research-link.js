'use strict';
// Recherche-Verknüpfungs-Job (KI-first, rückwärtsgewandt): nimmt EINEN Recherche-
// Schnipsel und schlägt Verknüpfungen zu bereits existierenden Buch-Entitäten
// (Figuren/Orte/Szenen/Plot-Beats) vor. Persistiert NICHTS automatisch — liefert
// Vorschläge zurück, die der User in der Karte bestätigt (POST /research/:id/links).
// Generiert keinen Buchtext und schlägt keine neuen Entitäten vor.
const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps,
  createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const researchLinkRouter = express.Router();
const MAX_CANDIDATES = 200;

// KI-«art» → research_item_links.target_kind.
const ART_TO_KIND = { figur: 'figure', ort: 'location', szene: 'scene', beat: 'beat', strang: 'thread' };

function _loadCandidates(bookId, userEmail) {
  const q = (sql) => db.prepare(sql).all(bookId, userEmail).slice(0, MAX_CANDIDATES);
  return {
    figur:  q('SELECT id, name AS label, typ, beruf, rolle, beschreibung FROM figures WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'),
    ort:    q('SELECT id, name AS label, typ, land, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'),
    szene:  q('SELECT id, titel AS label, kommentar FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
    beat:   q('SELECT id, titel AS label, status, beschreibung FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
    strang: q('SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name'),
  };
}

async function runResearchLinkJob(jobId, itemId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    updateJob(jobId, { statusText: 'job.phase.researchLinking', progress: 15 });
    const item = db.prepare(
      'SELECT id, title, body, source, doc_name, doc_text FROM research_items WHERE id = ? AND book_id = ?'
    ).get(itemId, bookId);
    if (!item) throw i18nError('job.error.researchItemMissing');
    item.urls = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id').all(itemId);

    const cands = _loadCandidates(bookId, userEmail);
    const total = cands.figur.length + cands.ort.length + cands.szene.length
      + cands.beat.length + cands.strang.length;
    if (!total) {
      completeJob(jobId, { suggestions: [], empty: true }, null, '0 Kandidaten');
      return;
    }

    // id → { kind, label } für Validierung (KI darf nur diese ids zurückgeben).
    const byArtId = new Map();
    for (const [art, kind] of Object.entries(ART_TO_KIND)) {
      for (const c of cands[art]) byArtId.set(`${art}:${c.id}`, { kind, id: c.id, label: c.label || '' });
    }

    const { buildSystemResearchLink, buildResearchLinkPrompt, SCHEMA_RESEARCH_LINK } = await getPrompts(userEmail);
    const tok = { in: 0, out: 0, ms: 0 };
    const maxOut = 600 + Math.min(total, 60) * 40;
    const result = await aiCall(jobId, tok,
      buildResearchLinkPrompt(item, cands),
      buildSystemResearchLink(),
      15, 90, Math.max(800, total * 20), 0.2, maxOut, undefined, SCHEMA_RESEARCH_LINK,
    );
    if (!Array.isArray(result?.links)) throw i18nError('job.error.researchLinksMissing');

    // Bereits bestehende Verknüpfungen ausblenden.
    const existing = new Set(
      db.prepare('SELECT target_kind, chapter_id, page_id, figure_id, location_id, scene_id, beat_id FROM research_item_links WHERE item_id = ?')
        .all(itemId)
        .map(r => `${r.target_kind}:${r.chapter_id ?? r.page_id ?? r.figure_id ?? r.location_id ?? r.scene_id ?? r.beat_id}`)
    );

    const seen = new Set();
    const suggestions = [];
    for (const l of result.links) {
      const art = String(l?.art || '').trim();
      const cand = byArtId.get(`${art}:${toIntId(l?.id)}`);
      if (!cand) continue;
      const key = `${cand.kind}:${cand.id}`;
      if (seen.has(key) || existing.has(key)) continue;
      seen.add(key);
      suggestions.push({
        target_kind: cand.kind,
        target_id: cand.id,
        label: cand.label,
        grund: String(l?.grund || '').trim().slice(0, 200),
      });
    }

    logger.info(`Recherche-Verknüpfung: ${suggestions.length} Vorschlag/Vorschläge aus ${total} Kandidaten`);
    completeJob(jobId, { suggestions, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${suggestions.length} Vorschlaege`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Recherche-Verknüpfung Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

researchLinkRouter.post('/research-link', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  const item_id = toIntId(req.body?.item_id);
  if (!book_id || !item_id) return res.status(400).json({ error_code: 'INVALID_IDS' });
  setContext({ book: book_id });
  {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, book_id, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const userEmail = req.session?.user?.email || null;
  const entityKey = `${book_id}|${item_id}`;
  const existing = findActiveJobId('research-link', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('research-link', book_id, userEmail, 'job.label.researchLink', null, entityKey);
  enqueueJob(jobId, () => runResearchLinkJob(jobId, item_id, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { researchLinkRouter, runResearchLinkJob };
