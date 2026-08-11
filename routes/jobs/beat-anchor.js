'use strict';
// Beat-Verankerung (Plot-Werkstatt, Ist-Index): findet die tatsächlichen Fund-
// stellen der geplanten Beats im Buchtext und legt sie in plot_beat_occurrences
// ab (Full-Replace pro Beat). Rein rückwärtsgewandt — liest bestehende Inhalte,
// schreibt NIE in den Buchtext. Kein KI-Prompt/callAI: die Erkennung nutzt den
// bereits vorhandenen Embedding-Index (semantische Ähnlichkeit zu titel+
// beschreibung; die Freitext-Pipeline fusioniert intern schon FTS dazu) — fehlt
// das Backend, fällt der Anchor auf reine FTS über den Beat-Titel zurück.
//
// Der Soll-Ist-Abgleich (beat.status vs. Fundstellen-Dichte) treibt das Drift-
// Badge auf der Beat-Karte. Pendant zur Motiv-Werkstatt (routes/jobs/motif-scan.js).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const plotDb = require('../../db/plot');
const appSettings = require('../../lib/app-settings');
const embed = require('../../lib/embed');
const { semanticQuery } = require('../../lib/semantic-retrieval');
const searchIndex = require('../../lib/search');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const logger = require('../../logger');

const beatAnchorRouter = express.Router();

// Fund-Kinds im Text (Seiten + Szenen — genau die, die plot_beat_occurrences via
// CHECK erlaubt; Figuren-Chunks des Embedding-Index sind für Beats nicht sinnvoll).
const SCAN_KINDS = ['page', 'scene'];
const TOP_K = 25;

const _TAG = /<\/?[^>]+>/g;
const _ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function _plainSnippet(s) {
  return String(s || '').replace(_TAG, '').replace(/&(amp|lt|gt|quot|#39);/g, m => _ENT[m] || m).trim().slice(0, 400);
}

function _occKey(kind, entityId) { return `${kind}:${entityId}`; }
function _toOcc(kind, entityId, score, snippet, source) {
  const isPage = kind === 'page';
  return { kind, pageId: isPage ? entityId : null, sceneId: isPage ? null : entityId, score, snippet, source };
}

// Fundstellen eines Beats sammeln. Query = titel + beschreibung. Semantisch (mit
// interner FTS-Fusion) wenn das Embedding-Backend läuft, sonst reine FTS über den
// Titel. Dedup pro (kind, entity) — ein Ort zählt einmal.
//
// minScore: Score-Untergrenze fürs Speichern. 0 für „im Buch"-Beats (alle Treffer
// zählen — es geht um Drift-Erkennung). Für „geplant"-Beats die hohe Promotion-
// Schwelle, damit nur starke Treffer als „offenbar schon geschrieben" durchkommen
// (sonst Vorschlags-Flut). Bei minScore > 0 wird der reine FTS-Fallback übersprungen:
// ein wörtlicher Titel-Treffer ist ohne Semantik ein zu schwaches Promotion-Signal.
async function _anchorBeat(bookId, beat, useSemantic, signalFn, minScore = 0) {
  const found = new Map();
  const query = [beat.titel, beat.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
  if (!query) return [];

  if (useSemantic) {
    const hits = await semanticQuery(bookId, query, { kinds: SCAN_KINDS, topK: TOP_K, signal: signalFn() });
    for (const h of hits) {
      if (minScore > 0 && h.score != null && h.score < minScore) continue;
      found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, h.score, _plainSnippet(h.text), 'semantic'));
    }
  } else {
    if (minScore > 0) return []; // Promotion nur mit Semantik — FTS-Titel-Treffer zu schwach.
    // Ohne Embedding-Backend: wörtliche FTS über den Beat-Titel (kürzer, präziser
    // als die ganze Beschreibung als Textblob).
    let r;
    try { r = searchIndex.query(beat.titel || '', { bookId, kinds: SCAN_KINDS, limit: TOP_K }); }
    catch (e) { logger.warn(`[beat-anchor] FTS "${beat.titel}" fehlgeschlagen: ${e.message}`); return []; }
    for (const h of (r.hits || [])) {
      found.set(_occKey(h.kind, h.entity_id), _toOcc(h.kind, h.entity_id, null, _plainSnippet(h.snippet || h.title), 'trigger'));
    }
  }

  return [...found.values()];
}

async function runBeatAnchorJob(jobId, bookId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    const useSemantic = embed.isEnabled();
    // Promotion-Schwelle für GEPLANTE Beats (hoch, sonst Vorschlags-Flut). 0 = aus.
    const promoteFloor = Number(appSettings.get('plot.anchor.promote_min_score')) || 0;
    // Verankert werden nicht-verworfene Beats beider Status:
    //   - „im Buch": alle Treffer (Soll-Ist-Drift — ist das laut Plan Geschriebene
    //     wirklich im Text?).
    //   - „geplant": nur Treffer ≥ promoteFloor (Promotion-Erkennung — offenbar schon
    //     geschrieben? → Vorschlag „auf im Buch setzen"). Bei promoteFloor = 0 werden
    //     geplante Beats nicht gescannt (Feature aus).
    // Verworfene Beats haben kein Soll „im Text"; ihre evtl. vorhandenen Alt-Fundstellen
    // werden geleert (kein Stale-Index nach Rückstufung/Verwerfen).
    const allBeats = plotDb.listBeatsForAnchor(bookId, userEmail);
    const beats = allBeats.filter(b => !b.verworfen
      && (b.status === 'im_buch' || (b.status === 'geplant' && promoteFloor > 0)));
    const anchoredIds = new Set(beats.map(b => b.id));
    for (const b of allBeats) {
      if (!anchoredIds.has(b.id)) plotDb.replaceBeatOccurrences(b.id, bookId, []);
    }
    updateJob(jobId, { statusText: 'job.phase.beatAnchor', statusParams: { done: 0, total: beats.length }, progress: 5 });

    let totalOcc = 0;
    for (let i = 0; i < beats.length; i++) {
      throwIfAborted();
      const beat = beats[i];
      const minScore = beat.status === 'im_buch' ? 0 : promoteFloor;
      const rows = await _anchorBeat(bookId, beat, useSemantic, signal, minScore);
      plotDb.replaceBeatOccurrences(beat.id, bookId, rows);
      totalOcc += rows.length;
      updateJob(jobId, {
        statusText: 'job.phase.beatAnchor', statusParams: { done: i + 1, total: beats.length },
        progress: 5 + Math.round(((i + 1) / Math.max(beats.length, 1)) * 90),
      });
    }

    log.info(`Beat-Anchor ${bookId}: ${beats.length} Beats, ${totalOcc} Fundstellen (semantisch=${useSemantic}).`);
    completeJob(jobId, { beats: beats.length, occurrences: totalOcc, semantic: useSemantic }, null,
      `${beats.length} Beats, ${totalOcc} Fundstellen`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Beat-Anchor Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron: hält den Ist-Index aller Bücher/User frisch (nach dem embed-Reindex).
// Ein Anchor pro (Buch, User) mit Beats; Dedup gegen laufende Jobs.
const { db } = require('../../db/schema');
async function anchorAllBooks() {
  const scopes = db.prepare('SELECT DISTINCT book_id, user_email FROM plot_beats').all();
  let enqueued = 0, skipped = 0;
  for (const { book_id, user_email } of scopes) {
    if (findActiveJobId('beat-anchor', book_id, user_email)) { skipped++; continue; }
    const jobId = createJob('beat-anchor', book_id, user_email, 'job.label.beatAnchor', null, book_id);
    enqueueJob(jobId, () => runBeatAnchorJob(jobId, book_id, user_email));
    enqueued++;
  }
  logger.info(`Beat-Anchor (Cron): ${enqueued} Scope(s) eingereiht, ${skipped} übersprungen (läuft bereits).`);
  return { enqueued, skipped };
}

beatAnchorRouter.post('/beat-anchor', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const existing = findActiveJobId('beat-anchor', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('beat-anchor', book_id, userEmail, 'job.label.beatAnchor', null, book_id);
  enqueueJob(jobId, () => runBeatAnchorJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { beatAnchorRouter, runBeatAnchorJob, anchorAllBooks };
