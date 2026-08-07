'use strict';
// Interview-Transkription als Job.
//
// Warum Job und nicht Sync-Proxy wie das Diktat: eine Stunde Gespraech braucht
// beim Transkribieren Minuten. Der HTTP-Request, der das anstoesst, kann darauf
// nicht warten, und der Nutzer soll die App inzwischen weiter benutzen.
//
// KEIN `callAI`. Whisper transkribiert, es formuliert nicht — kein Token-Budget,
// kein Prompt, kein Modell-Fallback. Die Job-Queue liefert hier nur Lifecycle,
// Fortschritt und Wiederaufnahme.
//
// Am Ende steht der Volltext in `research_items.doc_text`. Genau dadurch ist das
// Transkript ohne weiteren Code auffindbar: FTS (lib/search.js#upsertResearch)
// und Embedding-Index (Job embed-index, kind 'research') haengen bereits daran.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { db } = require('../../db/connection');
const { NOW_ISO_SQL } = require('../../db/now');
const {
  getTranscript, getAudio, setStatus, replaceSegments, speakerLabels, listSegments,
} = require('../../db/interview');
const { itemBookId } = require('../../db/research-items');
const {
  transcribeAudio, transcriptToText, transcriptionAvailable,
} = require('../../lib/interview-transcribe');
const { getBookLocale } = require('../../db/schema');
const searchIndex = require('../../lib/search');
const { enqueueEmbedIndexJob } = require('./embed-index');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const logger = require('../../logger');

const interviewRouter = express.Router();

/**
 * Volltext + Kennzahlen ans Fundstueck schreiben. `doc_chars` traegt die Laenge,
 * `doc_pages` bleibt null — ein Gespraech hat keine Seiten, und eine erfundene
 * Zahl dort waere in der Recherche-Karte eine Falschangabe.
 */
function _writeItemText(itemId, text) {
  db.prepare(
    `UPDATE research_items
        SET doc_text = ?, doc_chars = ?, updated_at = ${NOW_ISO_SQL}
      WHERE id = ?`,
  ).run(text, text.length, parseInt(itemId));
  searchIndex.upsertResearch(itemId);
}

async function runInterviewJob(jobId, bookId, itemId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    updateJob(jobId, { statusText: 'job.phase.transcribeLoading', progress: 5 });
    const head = getTranscript(itemId);
    if (!head) throw i18nError('job.error.transcriptMissing');
    const row = getAudio(itemId);
    if (!row?.audio) throw i18nError('job.error.transcriptNoAudio');

    setStatus(itemId, 'running');
    updateJob(jobId, { statusText: 'job.phase.transcribeRunning', progress: 15 });

    let language = '';
    try { language = getBookLocale(bookId, userEmail) || ''; } catch { /* Buch-Locale optional */ }

    const t0 = Date.now();
    const result = await transcribeAudio(row.audio, { mime: row.audio_mime, language });
    const dauerMs = Date.now() - t0;

    updateJob(jobId, { statusText: 'job.phase.transcribeSaving', progress: 85 });
    replaceSegments(itemId, bookId, result.segments);

    // Sprecher-Namen aus einem FRUEHEREN Lauf gelten weiter: sie sind Handarbeit
    // und haengen am Sprecher-Schluessel, nicht an den ersetzten Segmenten.
    const text = transcriptToText(listSegments(itemId), speakerLabels(itemId));
    _writeItemText(itemId, text);

    db.prepare(
      `UPDATE interview_transcripts
          SET duration_s = ?, sprache = ?, modell = ?, diarisiert = ?, updated_at = ${NOW_ISO_SQL}
        WHERE item_id = ?`,
    ).run(result.duration_s, result.sprache, result.modell, result.diarisiert ? 1 : 0, parseInt(itemId));
    setStatus(itemId, 'ready');

    // Semantik-Index nachziehen (non-fatal): ohne das waere das frische
    // Transkript bis zum Nacht-Cron nur ueber exakten Wortmatch auffindbar.
    try { enqueueEmbedIndexJob(bookId, userEmail); }
    catch (e) { logger.warn(`[interview] embed-index enqueue fehlgeschlagen: ${e.message}`); }

    const sprecher = new Set(result.segments.map(s => s.speaker).filter(Boolean)).size;
    log.info(`Transkript fertig: ${result.segments.length} Redebeiträge, ${text.length} Zeichen, `
      + `${result.diarisiert ? `${sprecher} Sprecher` : 'ohne Sprechertrennung'}, ${Math.round(dauerMs / 1000)}s.`);
    completeJob(jobId, {
      segmente: result.segments.length,
      zeichen: text.length,
      diarisiert: result.diarisiert,
      sprecher,
      duration_s: result.duration_s,
    }, null, `Transkript: ${result.segments.length} Redebeiträge`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      log.error(`Fehler Transkription Item #${itemId}: ${e.message}`, { stack: e.stack });
    }
    // Der Fehler gehoert AN die Transkript-Zeile, nicht nur ins Job-Protokoll:
    // die Karte zeigt das Fundstueck weiter an und muss sagen koennen, warum
    // dort kein Wortlaut steht.
    try { setStatus(itemId, 'error', e.code || e.message); } catch { /* Zeile ggf. weg */ }
    failJob(jobId, e);
  }
}

/** Transkription anstossen (auch erneut — ein zweiter Lauf ersetzt die Segmente). */
interviewRouter.post('/interview-transcribe', jsonBody, (req, res) => {
  const itemId = toIntId(req.body?.item_id);
  if (!itemId) return res.status(400).json({ error_code: 'ITEM_ID_REQUIRED' });
  const bookId = itemBookId(itemId);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  if (!transcriptionAvailable()) {
    return res.status(404).json({ error_code: 'TRANSCRIBE_DISABLED' });
  }
  const head = getTranscript(itemId);
  if (!head) return res.status(404).json({ error_code: 'TRANSCRIPT_NOT_FOUND' });
  if (!head.has_audio) return res.status(400).json({ error_code: 'TRANSCRIPT_NO_AUDIO' });

  const userEmail = req.session?.user?.email || null;
  const entityId = `i${itemId}`;
  const existing = findActiveJobId('interview-transcribe', entityId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('interview-transcribe', bookId, userEmail,
    'job.label.interviewTranscribe', null, entityId);
  enqueueJob(jobId, () => runInterviewJob(jobId, bookId, itemId, userEmail));
  res.json({ jobId });
});

module.exports = { interviewRouter, runInterviewJob };
