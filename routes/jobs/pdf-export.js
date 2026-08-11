'use strict';
// Custom-PDF-Export-Job. Laedt via lib/load-contents (Buch/Kapitel/Seite),
// rendert via lib/pdf-render und persistiert das Buffer in einem In-Memory-
// Result-Store, weil die Standard-Job-Result-Serialisierung JSON ist und MB-
// Buffers darin nichts zu suchen haben. Frontend laedt das fertige PDF ueber
// einen separaten Endpoint als Stream.
//
// Job-Result-JSON enthaelt nur Metadaten: Groesse, MIME, Validation-Status. Der
// eigentliche Buffer wird in `pdfResults`-Map gehalten und nach 2 h gecleart.

const express = require('express');
const {
  jobs, createJob, enqueueJob, jobAbortControllers,
  updateJob, completeJob, failJob, makeJobLogger,
  findActiveJobId,
  i18nError,
  jsonBody,
} = require('./shared');
const { getPdfExportProfile, getPdfExportProfileBackCover, getPdfExportProfileSpineImage, getBookSettings } = require('../../db/schema');
// Cover/Autorfoto + Titelei sind buch-weit (book_publication), geteilt mit dem
// EPUB-Export. Der PDF-Render liest sie von hier, nicht mehr vom Profil.
const {
  getMeta: getBookPublication,
  getCover: getBookPublicationCover,
  getAuthorImage: getBookPublicationAuthorImage,
} = require('../../db/book-publication');
const { loadContents } = require('../../lib/load-contents');
const { getSnapshot } = require('../../db/book-snapshots');
const { snapshotToBundle, snapshotPublication } = require('../../lib/snapshot-export');
const { renderPdfBuffer } = require('../../lib/pdf-render');
const { buildBibliography, pageIdsFromGroups } = require('../../lib/bibliography');
const { renderCoverBuffer, computeSpineMm } = require('../../lib/pdf-cover-render');
const { validatePdfa } = require('../../lib/pdfa-validate');
const { convertToPdfX } = require('../../lib/pdfx-convert');
const { buildExportFilename } = require('../../lib/filenames');
const { resolveSlug } = require('../../lib/export-builders/shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');
const { sessionEmail } = require('../../lib/acl');

const router = express.Router();

const VALID_SCOPES = new Set(['book', 'chapter', 'page']);
const VALID_TARGETS = new Set(['interior', 'cover']);

// jobId → { buffer, mime, filename }
const pdfResults = new Map();
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;

function _scheduleResultCleanup(jobId) {
  const t = setTimeout(() => pdfResults.delete(jobId), RESULT_TTL_MS);
  t.unref?.();
}

async function runPdfExportJob(jobId, { scope, entityId, profileId, includeSubchapters, target = 'interior', snapshotId = null, userEmail, userToken }) {
  const log = makeJobLogger(jobId);
  const ctrl = jobAbortControllers.get(jobId);

  try {
    updateJob(jobId, { progress: 5, statusText: 'job.phase.loadProfile' });
    const profile = getPdfExportProfile(profileId);
    if (!profile) throw i18nError('job.error.profileNotFound');
    if (profile.user_email !== userEmail) throw i18nError('job.error.forbidden');

    updateJob(jobId, { progress: 10, statusText: 'job.phase.loadBook' });
    // snapshotId gesetzt → Bundle aus dem selbsttragenden Fassungs-Stand bauen
    // (scope ist dann immer 'book', entityId = bookId). Sonst Live-Buchinhalt.
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
    const { book, chapter, page, groups } = bundle;
    const snapDetail = snapshotId ? `, fassungId=${snapshotId}` : '';
    const scopeDetail = scope === 'chapter' && chapter?.id ? `, chapter=${chapter.id}${includeSubchapters ? '+sub' : ''}`
                      : scope === 'page'    && page?.id    ? `, page=${page.id}`
                      : '';
    log.info(`Start PDF-Export «${book.name}» (scope=${scope}${scopeDetail}${snapDetail}, profile=${profile.name})`);

    updateJob(jobId, { progress: 30, statusText: 'job.phase.loadPages' });

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    const { language: bookLang } = getBookSettings(book.id, userEmail);
    const standard = profile.config.pdfa?.standard || (profile.config.pdfa?.enabled ? 'pdfa' : 'none');

    // Buch-weite Publikations-Metadaten in config.extras spiegeln, damit die
    // Render-Funktionen (pages.js, cover-render) unveraendert config.extras
    // lesen. Render-Toggles (barcode, imprintPosition) bleiben Profil-Sache.
    // Cover/Autorfoto kommen ebenfalls buch-weit (geteilt mit EPUB).
    // Bei einer Fassung mit eingefrorener Publikation (frozenPub) wird statt der
    // Live-book_publication der eingefrorene Stand gespiegelt.
    let pubCoverBuf = null;
    let pubAuthorBuf = null;
    if (scope === 'book') {
      const pub = frozenPub ? frozenPub.meta : getBookPublication(book.id);
      const ex = profile.config.extras;
      ex.authorName  = pub.author_name || '';
      ex.isbn        = pub.isbn || '';
      ex.subtitle    = pub.subtitle || '';
      ex.year        = pub.year || '';
      ex.dedication  = pub.dedication || '';
      ex.imprint     = pub.imprint || '';
      ex.copyright   = pub.copyright || '';
      ex.frontMatter = pub.frontmatter || '';
      ex.authorBio   = pub.author_bio || '';
      if (frozenPub) {
        if (frozenPub.cover) pubCoverBuf = frozenPub.cover.image;
        if (frozenPub.authorImage) pubAuthorBuf = frozenPub.authorImage.image;
      } else {
        if (pub.has_cover) { const c = getBookPublicationCover(book.id); if (c) pubCoverBuf = c.image; }
        if (pub.has_author_image) { const a = getBookPublicationAuthorImage(book.id); if (a) pubAuthorBuf = a.image; }
      }
    }

    let buffer;
    let lowResImages = 0;
    let coverInInterior = false;
    let interiorPages = null;

    if (target === 'cover') {
      // Separates Umschlag-PDF: nur fuer das ganze Buch sinnvoll. Front =
      // buch-weites Cover (book_publication), Rueckseite render-spezifisch (Profil).
      const cs = profile.config.coverSpec || {};
      if (!(cs.pageCount > 0) || !(cs.paperBulkMmPer1000 > 0)) {
        throw i18nError('job.error.coverSpecRequired');
      }
      const frontImageBuf = pubCoverBuf;
      let backImageBuf = null;
      if (profile.has_back_cover) {
        const back = getPdfExportProfileBackCover(profileId);
        if (back) backImageBuf = back.image;
      }
      let spineImageBuf = null;
      if (profile.has_spine) {
        const spine = getPdfExportProfileSpineImage(profileId);
        if (spine) spineImageBuf = spine.image;
      }
      updateJob(jobId, { progress: 40, statusText: 'job.phase.renderCover' });
      buffer = await renderCoverBuffer({ book, profile, frontImageBuf, backImageBuf, spineImageBuf, lang: bookLang });
      log.info(`Umschlag-PDF gerendert (Ruecken=${computeSpineMm(cs).toFixed(1)} mm, ${cs.pageCount} Seiten, profile=${profile.name})`);
    } else {
      const coverBuf = (scope === 'book' && profile.config.cover.enabled) ? pubCoverBuf : null;
      const authorImageBuf = (scope === 'book') ? pubAuthorBuf : null;

      // Quellenverzeichnis + Kurzbeleg-Kontext der gerenderten Einheit. Nummern
      // im numerischen Stil folgen der Einheit: ganzes Buch → Buch-Leserichtung,
      // Kapitel-/Seiten-Scope → nur deren Fundstellen ab 1 (lib/bibliography.js).
      const bibliography = await buildBibliography({
        bookId: book.id,
        pageIds: scope === 'book' ? null : pageIdsFromGroups(groups),
        userEmail,
      });

      updateJob(jobId, { progress: 40, statusText: 'job.phase.renderPdf' });
      const meta = {};
      buffer = await renderPdfBuffer({
        book, groups, profile,
        coverBuf, authorImageBuf, token: userToken, lang: bookLang,
        scope, chapter, page, meta, bibliography,
      });
      lowResImages = Array.isArray(meta.dpiWarnings) ? meta.dpiWarnings.length : 0;
      interiorPages = Number.isInteger(meta.totalPages) ? meta.totalPages : null;
      if (lowResImages) log.warn(`${lowResImages} Bild(er) unter ${profile.config.print?.dpiWarnThreshold || 300} dpi (scope=${scope})`);
      // Druckfertiger Innenteil sollte kein Innen-Cover tragen — Hinweis (non-fatal).
      coverInInterior = !!(scope === 'book' && coverBuf && (profile.config.print?.bleedMm > 0));
      if (coverInInterior) log.warn(`Innenteil enthaelt Cover trotz Beschnitt — separates Umschlag-PDF empfohlen (job=${jobId})`);
    }

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    let validation = { available: false };
    if (standard === 'pdfa') {
      updateJob(jobId, { progress: 85, statusText: 'job.phase.validatePdfa' });
      try {
        validation = await validatePdfa(buffer);
      } catch (e) {
        log.warn(`PDF/A validation failed (${e.message}); ignoring`);
        validation = { available: false, reason: 'validator-error' };
      }
      if (validation.available && !validation.passed) {
        log.warn(`veraPDF flagged document as non-compliant (job=${jobId})`);
      }
    }

    // PDF/X-3-Post-Step (Druckvorstufe): Ghostscript stempelt OutputIntent + ICC.
    // RGB bleibt, keine CMYK-Separation. Non-fatal — fehlt gs/ICC, bleibt das
    // unkonvertierte PDF mit Warnung im Result.
    let pdfx = null;
    if (standard === 'pdfx') {
      updateJob(jobId, { progress: 85, statusText: 'job.phase.convertPdfx' });
      let conv = { available: false, reason: 'convert-error' };
      try {
        conv = await convertToPdfX(buffer, { title: book.name || 'Document' });
      } catch (e) {
        log.warn(`PDF/X conversion threw (${e.message}); ignoring`);
      }
      if (conv.available && conv.buffer) {
        buffer = conv.buffer;
        log.info(`PDF/X-3 erzeugt (OutputIntent=${conv.identifier}, job=${jobId})`);
      } else {
        log.warn(`PDF/X conversion unavailable (${conv.reason}); liefere unkonvertiertes PDF (job=${jobId})`);
      }
      pdfx = { applied: !!conv.available, reason: conv.reason || null, identifier: conv.identifier || null };
    }

    const slug = resolveSlug(bundle);
    const filename = buildExportFilename({
      prefix: target === 'cover' ? 'umschlag' : scope, slug, ext: 'pdf', date: new Date(),
    });

    pdfResults.set(jobId, { buffer, mime: 'application/pdf', filename });
    _scheduleResultCleanup(jobId);

    const sizeKb = Math.round(buffer.length / 1024);
    const normLog = standard === 'pdfx'
      ? `pdfx=${pdfx?.applied ? 'ok' : `fallback(${pdfx?.reason})`}`
      : `pdfa=${validation.available ? (validation.passed ? 'pass' : 'fail') : 'skipped'}`;
    log.info(`PDF generiert «${filename}» (${sizeKb} KB, scope=${scope}${scopeDetail}, profile=${profile.name}, ${normLog})`);

    completeJob(jobId, {
      ready: true,
      size: buffer.length,
      mime: 'application/pdf',
      filename,
      profileName: profile.name,
      scope,
      target,
      coverInInterior,
      interiorPages,
      lowResImages,
      dpiThreshold: profile.config.print?.dpiWarnThreshold || 0,
      standard,
      pdfa: {
        requested: standard === 'pdfa',
        validatorAvailable: !!validation.available,
        passed: validation.available ? !!validation.passed : null,
        reason: validation.reason || null,
      },
      pdfx: pdfx ? {
        requested: true,
        applied: !!pdfx.applied,
        reason: pdfx.reason,
        identifier: pdfx.identifier,
      } : { requested: false, applied: false, reason: null, identifier: null },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === 'job.cancelled') {
      failJob(jobId, e);
      return;
    }
    if (e?.code === 'BOOK_EMPTY')    { failJob(jobId, i18nError('job.error.bookEmpty'));    return; }
    if (e?.code === 'CHAPTER_EMPTY') { failJob(jobId, i18nError('job.error.chapterEmpty')); return; }
    if (e?.code === 'PAGE_EMPTY')    { failJob(jobId, i18nError('job.error.pageEmpty'));    return; }
    log.error(`pdf-export job ${jobId}: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/pdf-export', jsonBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  const userToken = null;

  // Fassungs-Export: snapshotId gesetzt → immer ganzes Buch, Innenteil.
  const snapshotId = toIntId(req.body?.snapshot_id || req.body?.snapshotId);

  const rawTarget = snapshotId ? 'interior' : String(req.body?.target || 'interior').toLowerCase();
  const target = VALID_TARGETS.has(rawTarget) ? rawTarget : null;
  if (!target) return res.status(400).json({ error_code: 'BAD_TARGET' });

  // Umschlag-PDF gibt es nur fuer das ganze Buch; Fassungs-Export ebenso.
  const rawScope = (target === 'cover' || snapshotId) ? 'book' : String(req.body?.scope || 'book').toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : null;
  if (!scope) return res.status(400).json({ error_code: 'BAD_SCOPE' });

  const entityId = toIntId(req.body?.entityId ?? req.body?.entity_id ?? req.body?.book_id ?? req.body?.bookId);
  const profileId = toIntId(req.body?.profile_id || req.body?.profileId);
  if (!entityId || !profileId) return res.status(400).json({ error_code: 'ENTITY_OR_PROFILE_REQUIRED' });
  const includeSubchapters = scope === 'chapter' && (req.body?.include_subchapters === true || req.body?.includeSubchapters === true);

  const profile = getPdfExportProfile(profileId);
  if (!profile) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  if (profile.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  // Fassung muss existieren (entityId ist bei snapshotId immer die bookId).
  if (snapshotId && !getSnapshot(entityId, snapshotId)) {
    return res.status(404).json({ error_code: 'SNAPSHOT_NOT_FOUND' });
  }

  // Buch-ID fuer Logging + Dedup ableiten: bei scope='book' === entityId,
  // sonst via content-store-Lookup (Chapter/Page).
  let bookId = entityId;
  if (scope !== 'book') {
    const contentStore = require('../../lib/content-store');
    try {
      if (scope === 'chapter') {
        const ch = await contentStore.loadChapter(entityId, req);
        bookId = ch?.book_id || 0;
      } else if (scope === 'page') {
        const pg = await contentStore.loadPage(entityId, req);
        bookId = pg?.book_id || 0;
      }
    } catch (e) {
      if (e.status === 404) return res.status(404).json({ error_code: 'NOT_FOUND' });
      return res.status(502).json({ error_code: 'CONTENT_LOAD_FAILED' });
    }
  }
  if (bookId) setContext({ book: bookId });

  // PDF-Export: viewer reicht (Export gilt fuer alle Rollen).
  if (bookId) {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, bookId, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const dedupId = `${target}:${scope}:${entityId}:${profileId}${includeSubchapters ? ':sub' : ''}${snapshotId ? `:snap${snapshotId}` : ''}`;
  const existing = findActiveJobId('pdf-export', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('pdf-export', bookId, userEmail, 'job.label.pdfExportProfile', { profile: profile.name }, dedupId);
  enqueueJob(jobId, () => runPdfExportJob(jobId, { scope, entityId, profileId, includeSubchapters, target, snapshotId, userEmail, userToken }));
  res.status(202).json({ jobId });
});

router.get('/pdf-export/:id/file', (req, res) => {
  const userEmail = sessionEmail(req);
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
