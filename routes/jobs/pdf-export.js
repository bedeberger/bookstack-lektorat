'use strict';
// Custom-PDF-Export-Job. Lädt Buch + Kapitel + Seiten, rendert via lib/pdf-render
// und persistiert das Buffer in einem In-Memory-Result-Store, weil die
// Standard-Job-Result-Serialisierung JSON ist und MB-Buffers darin nichts zu
// suchen haben. Frontend lädt das fertige PDF über einen separaten Endpoint
// als Stream.
//
// Job-Result-JSON enthält nur Metadaten: Größe, MIME, Validation-Status. Der
// eigentliche Buffer wird in `pdfResults` Map gehalten und beim Job-Cleanup
// (siehe shared.js) zusammen mit dem Job entfernt.

const express = require('express');
const {
  jobs, createJob, enqueueJob, jobAbortControllers,
  updateJob, completeJob, failJob, makeJobLogger,
  findActiveJobId,
  i18nError,
  jsonBody,
} = require('./shared');
const { getTokenForRequest, getPdfExportProfile, getPdfExportProfileCover } = require('../../db/schema');
const { bsGet } = require('../../lib/bookstack');
const { loadBookContents } = require('../../lib/load-book-contents');
const { renderPdfBuffer } = require('../../lib/pdf-render');
const { validatePdfa } = require('../../lib/pdfa-validate');
const { buildExportFilename } = require('../../lib/filenames');
const { toIntId } = require('../../lib/validate');
const logger = require('../../logger');

const router = express.Router();

// jobId → { buffer, mime, filename }
// Wird beim Job-Cleanup nicht automatisch geleert (shared.js kennt diese Map
// nicht). Daher manuell: bei completeJob/failJob/Cancel räumen wir den Eintrag
// nach 2 h im selben Intervall, das shared.js für jobs nutzt.
const pdfResults = new Map();

const RESULT_TTL_MS = 2 * 60 * 60 * 1000;

function _scheduleResultCleanup(jobId) {
  const t = setTimeout(() => pdfResults.delete(jobId), RESULT_TTL_MS);
  t.unref?.();
}

async function runPdfExportJob(jobId, { bookId, profileId, userEmail, userToken }) {
  const log = makeJobLogger(jobId);
  const ctrl = jobAbortControllers.get(jobId);

  try {
    updateJob(jobId, { progress: 5, statusText: 'job.phase.loadProfile' });
    const profile = getPdfExportProfile(profileId);
    if (!profile) throw i18nError('job.error.profileNotFound');
    if (profile.user_email !== userEmail) throw i18nError('job.error.forbidden');

    updateJob(jobId, { progress: 10, statusText: 'job.phase.loadBook' });
    const book = await bsGet(`books/${bookId}`, userToken);
    log.info(`Start PDF-Export «${book.name}» (book=${bookId}, profile=${profile.name})`);

    updateJob(jobId, { progress: 20, statusText: 'job.phase.loadPages' });
    const { groups } = await loadBookContents(bookId, userToken);

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    let coverBuf = null;
    if (profile.config.cover.enabled && profile.has_cover) {
      const cover = getPdfExportProfileCover(profileId);
      if (cover) coverBuf = cover.image;
    }

    updateJob(jobId, { progress: 40, statusText: 'job.phase.renderPdf' });
    const buffer = await renderPdfBuffer({
      book,
      groups,
      profile,
      coverBuf,
      token: userToken,
    });

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    let validation = { available: false };
    if (profile.config.pdfa.enabled) {
      updateJob(jobId, { progress: 85, statusText: 'job.phase.validatePdfa' });
      try {
        validation = await validatePdfa(buffer);
      } catch (e) {
        log.warn(`PDF/A validation failed (${e.message}); ignoring`);
        validation = { available: false, reason: 'validator-error' };
      }
      if (validation.available && !validation.passed) {
        // Validation-Fail wird derzeit nicht-fatal behandelt — Buffer wird
        // trotzdem ausgeliefert, das Frontend zeigt aber eine Warnung.
        log.warn(`veraPDF flagged document as non-compliant (job=${jobId})`);
      }
    }

    const slug = book.slug || book.name || `book${bookId}`;
    const filename = buildExportFilename({
      prefix: 'book',
      slug, ext: 'pdf', date: new Date(),
    });

    pdfResults.set(jobId, { buffer, mime: 'application/pdf', filename });
    _scheduleResultCleanup(jobId);

    const sizeKb = Math.round(buffer.length / 1024);
    log.info(`PDF generiert «${filename}» (${sizeKb} KB, profile=${profile.name}, pdfa=${validation.available ? (validation.passed ? 'pass' : 'fail') : 'skipped'})`);

    completeJob(jobId, {
      ready: true,
      size: buffer.length,
      mime: 'application/pdf',
      filename,
      profileName: profile.name,
      pdfa: {
        requested: !!profile.config.pdfa.enabled,
        validatorAvailable: !!validation.available,
        passed: validation.available ? !!validation.passed : null,
        reason: validation.reason || null,
      },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === 'job.cancelled') {
      failJob(jobId, e);
      return;
    }
    if (e?.code === 'BOOK_EMPTY') {
      failJob(jobId, i18nError('job.error.bookEmpty'));
      return;
    }
    log.error(`pdf-export job ${jobId}: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/pdf-export', jsonBody, async (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  if (!userToken) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });

  const bookId = toIntId(req.body?.book_id || req.body?.bookId);
  const profileId = toIntId(req.body?.profile_id || req.body?.profileId);
  if (!bookId || !profileId) return res.status(400).json({ error_code: 'BOOK_OR_PROFILE_REQUIRED' });

  const profile = getPdfExportProfile(profileId);
  if (!profile) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  if (profile.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  const dedupId = `${bookId}:${profileId}`;
  const existing = findActiveJobId('pdf-export', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('pdf-export', bookId, userEmail, 'job.label.pdfExport', { profile: profile.name }, dedupId);
  enqueueJob(jobId, () => runPdfExportJob(jobId, { bookId, profileId, userEmail, userToken }));
  res.status(202).json({ jobId });
});

router.get('/pdf-export/:id/file', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_READY', params: { status: job.status } });
  const r = pdfResults.get(req.params.id);
  if (!r) return res.status(410).json({ error_code: 'RESULT_EXPIRED' });

  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Content-Length', r.buffer.length);
  res.end(r.buffer);
});

module.exports = { pdfExportRouter: router, runPdfExportJob };
