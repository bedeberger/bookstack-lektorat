'use strict';
// EPUB-Export-Job. Laedt via lib/load-contents (Buch/Kapitel/Seite), zieht die
// buch-weiten Publikations-Metadaten (book_publication: Cover/Titelei/Bio) und
// rendert via lib/export-builders/epub. Buffer in In-Memory-Result-Store
// (JSON-Job-Result darf keinen MB-Buffer tragen) → Stream-Endpoint.
//
// Kein KI-Call. Job-Pfad (statt Sync) fuer Progress + Robustheit bei vielen
// Remote-Bildern. Generische Sync-Route /export bleibt als Schnellpfad.

const express = require('express');
const {
  jobs, createJob, enqueueJob, jobAbortControllers,
  updateJob, completeJob, failJob, makeJobLogger,
  findActiveJobId, i18nError, jsonBody,
} = require('./shared');
const { getBookSettings } = require('../../db/schema');
const { getOwnerEmail } = require('../../db/book-access');
const { getUser } = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
const bp = require('../../db/book-publication');
const { loadContents } = require('../../lib/load-contents');
const { getSnapshot } = require('../../db/book-snapshots');
const { snapshotToBundle, snapshotPublication } = require('../../lib/snapshot-export');
const { buildEpub } = require('../../lib/export-builders/epub');
const { validateEpub } = require('../../lib/epubcheck-validate');
const { buildExportFilename } = require('../../lib/filenames');
const { resolveSlug } = require('../../lib/export-builders/shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { sessionEmail } = require('../../lib/acl');

const router = express.Router();
const VALID_SCOPES = new Set(['book', 'chapter', 'page']);

// jobId → { buffer, mime, filename }
const epubResults = new Map();
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;
function _scheduleResultCleanup(jobId) {
  const t = setTimeout(() => epubResults.delete(jobId), RESULT_TTL_MS);
  t.unref?.();
}

function _resolveAuthor(bookId) {
  try {
    const ownerEmail = getOwnerEmail(bookId);
    if (ownerEmail) return getUser(ownerEmail)?.display_name || '';
  } catch { /* nicht aufloesbar */ }
  return '';
}

async function runEpubExportJob(jobId, { scope, entityId, includeSubchapters, snapshotId = null, userEmail, userToken }) {
  const log = makeJobLogger(jobId);
  const ctrl = jobAbortControllers.get(jobId);
  try {
    updateJob(jobId, { progress: 10, statusText: 'job.phase.loadBook' });
    // snapshotId gesetzt → Bundle aus dem selbsttragenden Fassungs-Stand bauen
    // (scope ist dann immer 'book', entityId = bookId). Cover/Titelei kommen dann
    // aus der eingefrorenen Publikation der Fassung (frozenPub), sonst live aus
    // book_publication. Sonst Live-Buchinhalt.
    let bundle;
    let frozenPub = null;
    if (snapshotId) {
      const snap = getSnapshot(entityId, snapshotId);
      if (!snap) throw i18nError('job.error.snapshotNotFound');
      let content;
      try { content = JSON.parse(snap.content_json); }
      catch { throw i18nError('job.error.snapshotCorrupt'); }
      bundle = snapshotToBundle(content, { bookId: entityId });
      if (!bundle.groups.length) throw i18nError('job.error.snapshotCorrupt');
      frozenPub = snapshotPublication(snap.publication_json);
    } else {
      bundle = await loadContents({ scope, id: entityId, includeSubchapters: !!includeSubchapters }, userToken);
    }
    const { book } = bundle;

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    updateJob(jobId, { progress: 40, statusText: 'job.phase.renderEpub' });
    const lang = (book?.id ? getBookSettings(book.id)?.language : null) || 'de';
    // Provenienz-Nachweis im OPF: Instanz-Domain (wo) + exportierender User (wer).
    const opts = {
      lang,
      instanceUrl: (appSettings.get('app.public_url') || '').replace(/\/$/, ''),
      exportedBy: userEmail || '',
    };
    if (book?.id) {
      // Eingefrorene Publikation der Fassung bevorzugen (frozenPub), sonst live.
      const meta = frozenPub ? frozenPub.meta : bp.getMeta(book.id);
      opts.meta = meta;
      // Publikationsname (book_publication.author_name) uebersteuert den Account-Namen.
      opts.author = (meta.author_name || '').trim() || _resolveAuthor(book.id);
      opts.tocTitle = meta.epub_toc_title || undefined;
      if (frozenPub) {
        if (frozenPub.cover) opts.cover = frozenPub.cover;
        if (frozenPub.authorImage) opts.authorImage = frozenPub.authorImage;
      } else {
        if (meta.has_cover) opts.cover = bp.getCover(book.id);
        if (meta.has_author_image) opts.authorImage = bp.getAuthorImage(book.id);
      }
    }

    let buffer = await buildEpub(bundle, opts);
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    // EPUBCheck-Validierung (non-fatal, Pendant zu veraPDF beim PDF-Export):
    // fehlt das Binary, wird übersprungen; meldet es Fehler, liefern wir das
    // EPUB trotzdem aus und zeigen eine Warnung im Job-Result.
    updateJob(jobId, { progress: 80, statusText: 'job.phase.validateEpub' });
    let validation = { available: false };
    try {
      validation = await validateEpub(buffer);
    } catch (e) {
      log.warn(`EPUB validation threw (${e.message}); ignoring`);
      validation = { available: false, reason: 'validator-error' };
    }
    if (validation.available && !validation.passed) {
      log.warn(`epubcheck flagged EPUB as non-compliant (errors=${validation.errors}, fatals=${validation.fatals}, job=${jobId})`);
      // Einzelmeldungen mitloggen, damit man ohne lokales Reproduzieren sieht,
      // welche Regeln greifen. Nur ERROR/FATAL, gedeckelt gegen Log-Flut.
      const blocking = (validation.items || []).filter((m) => m.severity === 'ERROR' || m.severity === 'FATAL');
      const LOG_CAP = 20;
      for (const m of blocking.slice(0, LOG_CAP)) {
        const where = m.path ? `${m.path}${m.line ? `:${m.line}${m.column ? `:${m.column}` : ''}` : ''}` : '?';
        log.warn(`  epubcheck ${m.severity} ${m.id || '?'} @ ${where} — ${m.message}`);
      }
      if (blocking.length > LOG_CAP) {
        log.warn(`  … ${blocking.length - LOG_CAP} weitere epubcheck-Meldungen (gekürzt)`);
      }
    }

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    const filename = buildExportFilename({ prefix: scope, slug: resolveSlug(bundle), ext: 'epub', date: new Date() });
    epubResults.set(jobId, { buffer, mime: 'application/epub+zip', filename });
    _scheduleResultCleanup(jobId);

    const checkLog = validation.available
      ? (validation.passed ? 'epubcheck=pass' : `epubcheck=fail(${validation.errors}E/${validation.fatals}F)`)
      : 'epubcheck=skipped';
    log.info(`EPUB generiert «${filename}» (${Math.round(buffer.length / 1024)} KB, scope=${scope}${snapshotId ? `, fassungId=${snapshotId}` : ''}, ${checkLog})`);
    completeJob(jobId, {
      ready: true, size: buffer.length, mime: 'application/epub+zip', filename, scope,
      epubcheck: {
        validatorAvailable: !!validation.available,
        passed: validation.available ? !!validation.passed : null,
        errors: validation.errors || 0,
        warnings: validation.warnings || 0,
        fatals: validation.fatals || 0,
        reason: validation.reason || null,
        // Einzelmeldungen für die Frontend-Anzeige; gegen aufgeblähte Job-Results
        // gedeckelt (epubcheck kann bei kaputten Dateien hunderte werfen).
        items: (validation.items || []).slice(0, 50),
      },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === 'job.cancelled') { failJob(jobId, e); return; }
    if (e?.code === 'BOOK_EMPTY')    { failJob(jobId, i18nError('job.error.bookEmpty'));    return; }
    if (e?.code === 'CHAPTER_EMPTY') { failJob(jobId, i18nError('job.error.chapterEmpty')); return; }
    if (e?.code === 'PAGE_EMPTY')    { failJob(jobId, i18nError('job.error.pageEmpty'));    return; }
    log.error(`epub-export job ${jobId}: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/epub-export', jsonBody, async (req, res) => {
  const userEmail = sessionEmail(req);

  // Fassungs-Export: snapshotId gesetzt → immer ganzes Buch.
  const snapshotId = toIntId(req.body?.snapshot_id || req.body?.snapshotId);

  const rawScope = snapshotId ? 'book' : String(req.body?.scope || 'book').toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : null;
  if (!scope) return res.status(400).json({ error_code: 'BAD_SCOPE' });

  const entityId = toIntId(req.body?.entityId ?? req.body?.entity_id ?? req.body?.book_id ?? req.body?.bookId);
  if (!entityId) return res.status(400).json({ error_code: 'ENTITY_REQUIRED' });
  const includeSubchapters = scope === 'chapter' && (req.body?.include_subchapters === true || req.body?.includeSubchapters === true);

  // Fassung muss existieren (entityId ist bei snapshotId immer die bookId).
  if (snapshotId && !getSnapshot(entityId, snapshotId)) {
    return res.status(404).json({ error_code: 'SNAPSHOT_NOT_FOUND' });
  }

  // Buch-ID fuer Logging + ACL ableiten.
  let bookId = entityId;
  if (scope !== 'book') {
    const contentStore = require('../../lib/content-store');
    try {
      if (scope === 'chapter') bookId = (await contentStore.loadChapter(entityId, req))?.book_id || 0;
      else if (scope === 'page') bookId = (await contentStore.loadPage(entityId, req))?.book_id || 0;
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
      return res.status(502).json({ error_code: 'CONTENT_LOAD_FAILED' });
    }
  }
  if (bookId) setContext({ book: bookId });

  if (bookId) {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const dedupId = `${scope}:${entityId}${includeSubchapters ? ':sub' : ''}${snapshotId ? `:snap${snapshotId}` : ''}`;
  const existing = findActiveJobId('epub-export', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('epub-export', bookId, userEmail, 'job.label.epubExport', {}, dedupId);
  enqueueJob(jobId, () => runEpubExportJob(jobId, { scope, entityId, includeSubchapters, snapshotId, userEmail, userToken: null }));
  res.status(202).json({ jobId });
});

router.get('/epub-export/:id/file', (req, res) => {
  const userEmail = sessionEmail(req);
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_READY', params: { status: job.status } });
  const r = epubResults.get(req.params.id);
  if (!r) return res.status(410).json({ error_code: 'RESULT_EXPIRED' });

  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Content-Length', r.buffer.length);
  res.end(r.buffer);
});

module.exports = { epubExportRouter: router, runEpubExportJob };
