'use strict';
// Redundanz-Radar-Job: findet buchweite Doppelungen, indem er alle Seiten-Chunks
// des Embedding-Index paarweise per Cosinus vergleicht (lib/redundancy.js). Rein
// rückwärtsgewandt — liest den bestehenden semantic_chunks-Index, ruft KEIN
// Embedding-/KI-Backend und schreibt NIE in den Buchtext. Setzt einen gebauten
// Semantik-Index voraus (embed-index-Job); ohne Chunks → leeres Ergebnis.
//
// Der O(n²)-Scan läuft blockweise mit Yield an den Event-Loop, damit er den
// Single-Process-Server auch bei grossen Büchern nicht einfriert.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const embed = require('../../lib/embed');
const semanticChunks = require('../../db/semantic-chunks');
const { prepare, scanBlock, finalizePairs, findFigureDuplicates } = require('../../lib/redundancy');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');

const redundancyRouter = express.Router();

// Nur Seiten vergleichen (Prosa-Doppelungen). Szenen/Figuren sind kurze Meta-
// Steckbriefe, deren Ähnlichkeit erwartbar/rauschig ist.
const KINDS = ['page'];
// Schwelle-Bandbreite (bge-m3-Cosinus): darunter/darüber sinnlos → geclampt.
const MIN_THRESHOLD = 0.70;
const MAX_THRESHOLD = 0.97;
// Obergrenze verglichener Chunks. Schützt vor pathologisch grossen Büchern; wird
// sie überschritten, verarbeiten wir die ersten MAX_CHUNKS und melden es ehrlich
// (result.truncatedChunks), statt still Befunde zu verschlucken.
const MAX_CHUNKS = 6000;
const TOP_K = 60;
// Outer-Indizes pro Scan-Block, danach einmal an den Event-Loop zurückgeben.
const BLOCK = 50;
// Figuren-Dubletten laufen mit einem FESTEN hohen Floor, unabhängig vom Seiten-
// Schwellwert-Band der Karte: Figuren-Profile (name+beschreibung) sind kurz und
// archetyp-lastig, ihre Vektor-Nähe ist verrauscht → nur nahezu deckungsgleiche
// Profile sind ein Dubletten-Signal. Die lexikalische Namens-Fusion (alias vs.
// duplicate) passiert in findFigureDuplicates.
const FIGURE_DUPE_THRESHOLD = 0.88;
const FIGURE_TOP_K = 40;

const _yield = () => new Promise(r => setImmediate(r));

async function runRedundancyJob(jobId, bookId, threshold, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model } = embed.getConfig();

    updateJob(jobId, { statusText: 'job.phase.redundancyLoad', progress: 5 });
    let chunks = semanticChunks.loadChunksForPairing(bookId, model, KINDS);
    const loadedChunks = chunks.length;
    let truncatedChunks = 0;
    if (chunks.length > MAX_CHUNKS) {
      truncatedChunks = chunks.length - MAX_CHUNKS;
      chunks = chunks.slice(0, MAX_CHUNKS);
      logger.warn(`Redundanz ${bookId}: ${loadedChunks} Chunks > Cap ${MAX_CHUNKS} → ${truncatedChunks} übersprungen.`);
    }

    const { vecs, metas } = prepare(chunks);
    const n = vecs.length;
    logger.info(`Redundanz ${bookId}: ${n} vergleichbare Seiten-Chunks, Schwelle ${threshold}.`);

    const best = new Map();
    let comparedPairs = 0;
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    for (let i = 0; i < n; i += BLOCK) {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      comparedPairs += scanBlock(vecs, metas, i, Math.min(i + BLOCK, n), threshold, best);
      updateJob(jobId, {
        statusText: 'job.phase.redundancyScan',
        statusParams: { done: Math.min(i + BLOCK, n), total: n },
        progress: 10 + Math.round((Math.min(i + BLOCK, n) / Math.max(n, 1)) * 85),
      });
      await _yield();
    }

    const { pairs, totalFound, truncated } = finalizePairs(best, metas, { topK: TOP_K });

    // Figuren-Dubletten (billiger Zusatz-Abschnitt: ein Vektor pro Figur). Rein
    // rückwärtsgewandt — Signal an den Autor, kein Auto-Merge. Non-fatal: ein
    // Fehler hier verwirft nie das Seiten-Ergebnis.
    updateJob(jobId, { statusText: 'job.phase.redundancyFigures', progress: 97 });
    let figures = { pairs: [], totalFound: 0, truncated: false, figuresCompared: 0 };
    try {
      const figVecs = semanticChunks.loadFigureVectorsForPairing(bookId, userEmail, model);
      const figRes = figVecs.length >= 2
        ? findFigureDuplicates(figVecs, { threshold: FIGURE_DUPE_THRESHOLD, topK: FIGURE_TOP_K })
        : { pairs: [], totalFound: 0, truncated: false };
      figures = { ...figRes, figuresCompared: figVecs.length, threshold: FIGURE_DUPE_THRESHOLD };
    } catch (e) {
      logger.warn(`Figuren-Dubletten übersprungen (${bookId}): ${e.message}`);
    }

    updateJob(jobId, { progress: 98 });
    completeJob(jobId, {
      model, threshold, comparedChunks: n, comparedPairs,
      totalFound, truncated, truncatedChunks, pairs, figures,
    }, null, `${totalFound} Passagen-Paar(e) · ${figures.totalFound} Figuren-Paar(e)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Redundanz-Radar Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

function _clampThreshold(raw) {
  const t = Number(raw);
  if (!Number.isFinite(t)) return 0.82;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, t));
}

redundancyRouter.post('/redundancy', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('redundancy', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const threshold = _clampThreshold(req.body?.threshold);
  const jobId = createJob('redundancy', book_id, userEmail, 'job.label.redundancy', null, book_id);
  enqueueJob(jobId, () => runRedundancyJob(jobId, book_id, threshold, userEmail));
  res.json({ jobId });
});

module.exports = { redundancyRouter, runRedundancyJob };
