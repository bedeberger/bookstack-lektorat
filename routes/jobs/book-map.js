'use strict';
// Buchlandkarte-Job: projiziert die Seiten-Vektoren des Embedding-Index in zwei
// Dimensionen und rechnet die Kennzahlen (Kapitel-Kohaesion, Nachbar-Kapitel,
// Ausreisser-Seiten) — Mathematik in lib/book-map.js.
//
// Rein rueckwaertsgewandt: liest den bestehenden `semantic_chunks`-Index, ruft
// KEIN Embedding- und KEIN KI-Backend und schreibt NIE in den Buchtext. Setzt
// einen gebauten Index voraus (embed-index-Job); ohne Chunks → leeres Ergebnis.
//
// WARUM EIN JOB UND KEINE ROUTE (anders als `GET /search/semantic`): die
// Power-Iteration laeuft ueber ALLE Punkte × Dimension × Iterationen. Bei 800
// Seiten und dim=1024 sind das ein paar hundert Millionen Multiplikationen —
// genug, um den Single-Process-Server sichtbar anzuhalten. Der Job gibt darum
// zwischen den Phasen an den Event-Loop zurueck, gleiche Ueberlegung wie beim
// Redundanz-Radar.
//
// Das ERGEBNIS ist klein (ein Punkt je Seite, zwei Zahlen) und wird nicht
// persistiert: es ist vollstaendig aus dem Index neu berechenbar, und ein
// Ableitungs-Index eines Ableitungs-Index waere nur eine weitere Stelle, die
// veralten kann.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const embed = require('../../lib/embed');
const semanticChunks = require('../../db/semantic-chunks');
const { preparePoints, project2d, chapterStats, outliers } = require('../../lib/book-map');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');

const bookMapRouter = express.Router();

// Nur Seiten. Szenen/Figuren sind kurze Meta-Steckbriefe — sie lagen in einer
// gemeinsamen Projektion als eigener Klumpen neben dem Buch und haetten die
// Achsen dominiert, ohne etwas ueber den Text zu sagen (gleiche Begruendung wie
// die KINDS-Wahl des Redundanz-Radars).
const KINDS = ['page'];
// Obergrenze der projizierten Seiten. Schuetzt vor pathologisch grossen Buechern;
// wird sie ueberschritten, verarbeiten wir die ersten MAX_POINTS und melden es
// ehrlich (`result.truncatedPages`), statt still einen Teil der Karte zu
// verschweigen.
const MAX_POINTS = 4000;
// Wieviele Ausreisser-Seiten die Karte auflistet. Mehr liest niemand, und die
// Aussage „das passt nicht ins Buch" verwaessert mit jeder Zeile.
const OUTLIER_TOP_K = 12;

const _yield = () => new Promise(r => setImmediate(r));

async function runBookMapJob(jobId, bookId) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model } = embed.getConfig();
    const abortIfCancelled = () => {
      if (jobAbortControllers.get(jobId)?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
    };

    updateJob(jobId, { statusText: 'job.phase.bookMapLoad', progress: 5 });
    const chunks = semanticChunks.loadPageChunksWithChapter(bookId, model);
    await _yield();
    abortIfCancelled();

    let { points } = preparePoints(chunks);
    const foundPages = points.length;
    let truncatedPages = 0;
    if (points.length > MAX_POINTS) {
      truncatedPages = points.length - MAX_POINTS;
      points = points.slice(0, MAX_POINTS);
      logger.warn(`Buchlandkarte ${bookId}: ${foundPages} Seiten > Cap ${MAX_POINTS} → ${truncatedPages} uebersprungen.`);
    }
    logger.info(`Buchlandkarte ${bookId}: ${points.length} Seiten-Punkte, Modell ${model}.`);

    updateJob(jobId, { statusText: 'job.phase.bookMapProject', progress: 30 });
    await _yield();
    abortIfCancelled();
    const { coords, explainedVariance } = project2d(points);

    updateJob(jobId, { statusText: 'job.phase.bookMapStats', progress: 80 });
    await _yield();
    abortIfCancelled();
    const chapters = chapterStats(points);
    const far = outliers(points, { topK: OUTLIER_TOP_K });

    const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    const result = {
      model,
      pages: points.map((p, i) => ({
        id: p.id,
        chapterId: p.chapterId,
        x: round(coords[i][0]),
        y: round(coords[i][1]),
        chunks: p.chunks,
      })),
      chapters: chapters.map(c => ({
        ...c,
        cohesion: round(c.cohesion),
        spread: round(c.spread),
        nearestScore: round(c.nearestScore),
      })),
      outliers: far.map(o => ({ ...o, distance: round(o.distance) })),
      explainedVariance: round(explainedVariance),
      truncatedPages,
    };

    updateJob(jobId, { progress: 98 });
    completeJob(jobId, result, null, `${result.pages.length} Seiten · ${result.chapters.length} Kapitel`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Buchlandkarte Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

bookMapRouter.post('/book-map', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('book-map', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('book-map', book_id, userEmail, 'job.label.bookMap', null, book_id);
  enqueueJob(jobId, () => runBookMapJob(jobId, book_id));
  res.json({ jobId });
});

module.exports = { bookMapRouter, runBookMapJob };
