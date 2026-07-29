'use strict';
// Custom-Word-Export-Job. Laedt via lib/load-contents (Buch/Kapitel/Seite),
// zieht das gewaehlte Profil (docx_export_profile) + die buch-weiten
// Publikations-Metadaten (book_publication: Titelei/Bio) und rendert via
// lib/export-builders/docx (programmatische docx-Lib). Buffer in In-Memory-
// Result-Store (JSON-Job-Result darf keinen MB-Buffer tragen) → Stream-Endpoint.
//
// Kein KI-Call. Pendant zum EPUB-Job; der Sync-Pfad /export/:scope/:id/docx
// (+ docx-normseite) bleibt als Schnellpfad ueber Built-in-Presets.

const express = require('express');
const {
  jobs, createJob, enqueueJob, jobAbortControllers,
  updateJob, completeJob, failJob, makeJobLogger,
  findActiveJobId, i18nError, jsonBody,
} = require('./shared');
const { getProfile } = require('../../db/docx-export');
const { getBookSettings } = require('../../db/schema');
const { getOwnerEmail } = require('../../db/book-access');
const { getUser } = require('../../db/app-users');
const bp = require('../../db/book-publication');
const { loadContents } = require('../../lib/load-contents');
const { getSnapshot } = require('../../db/book-snapshots');
const { snapshotToBundle } = require('../../lib/snapshot-export');
const { buildDocxProfile, DOCX_MIME } = require('../../lib/export-builders/docx');
const { buildBibliography, pageIdsFromGroups } = require('../../lib/bibliography');
const { buildExportFilename } = require('../../lib/filenames');
const { resolveSlug } = require('../../lib/export-builders/shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const router = express.Router();
const VALID_SCOPES = new Set(['book', 'chapter', 'page']);

// jobId → { buffer, mime, filename }
const docxResults = new Map();
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;
function _scheduleResultCleanup(jobId) {
  const t = setTimeout(() => docxResults.delete(jobId), RESULT_TTL_MS);
  t.unref?.();
}

function _resolveAuthor(bookId) {
  try {
    const ownerEmail = getOwnerEmail(bookId);
    if (ownerEmail) return getUser(ownerEmail)?.display_name || '';
  } catch { /* nicht aufloesbar */ }
  return '';
}

async function runDocxExportJob(jobId, { scope, entityId, profileId, includeSubchapters, snapshotId = null, userEmail, userToken }) {
  const log = makeJobLogger(jobId);
  const ctrl = jobAbortControllers.get(jobId);
  try {
    updateJob(jobId, { progress: 5, statusText: 'job.phase.loadProfile' });
    const profile = getProfile(profileId);
    if (!profile) throw i18nError('job.error.profileNotFound');
    if (profile.user_email !== userEmail) throw i18nError('job.error.forbidden');

    updateJob(jobId, { progress: 20, statusText: 'job.phase.loadBook' });
    // snapshotId gesetzt → Bundle aus dem selbsttragenden Fassungs-Stand bauen
    // (scope ist dann immer 'book', entityId = bookId). Titelei kommt weiter
    // buch-weit aus book_publication. Sonst Live-Buchinhalt.
    let bundle;
    if (snapshotId) {
      const snap = getSnapshot(entityId, snapshotId);
      if (!snap) throw i18nError('job.error.snapshotNotFound');
      let content;
      try { content = JSON.parse(snap.content_json); }
      catch { throw i18nError('job.error.snapshotCorrupt'); }
      bundle = snapshotToBundle(content, { bookId: entityId });
      if (!bundle.groups.length) throw i18nError('job.error.snapshotCorrupt');
    } else {
      bundle = await loadContents({ scope, id: entityId, includeSubchapters: !!includeSubchapters }, userToken);
    }
    const { book } = bundle;

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    updateJob(jobId, { progress: 50, statusText: 'job.phase.renderDocx' });
    const lang = (book?.id ? getBookSettings(book.id)?.language : null) || 'de';
    const opts = { lang, config: profile.config, scope };
    if (book?.id) {
      // Quellenverzeichnis + Kurzbeleg-Kontext der gerenderten Einheit
      // (lib/bibliography.js). Nummern im numerischen Stil folgen der Einheit.
      opts.bibliography = await buildBibliography({
        bookId: book.id,
        pageIds: scope === 'book' ? null : pageIdsFromGroups(bundle.groups),
        userEmail,
      });
      const meta = bp.getMeta(book.id);
      opts.meta = meta;
      // Publikationsname (book_publication.author_name) uebersteuert den Account-Namen.
      opts.author = (meta.author_name || '').trim() || _resolveAuthor(book.id);
    } else {
      opts.author = _resolveAuthor(entityId);
    }

    let buffer = await buildDocxProfile(bundle, opts);
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

    if (ctrl?.signal.aborted) throw new Error('job.cancelled');

    const filename = buildExportFilename({ prefix: scope, slug: resolveSlug(bundle), ext: 'docx', date: new Date() });
    docxResults.set(jobId, { buffer, mime: DOCX_MIME, filename });
    _scheduleResultCleanup(jobId);

    log.info(`Word-Dokument generiert «${filename}» (${Math.round(buffer.length / 1024)} KB, scope=${scope}${snapshotId ? `, fassungId=${snapshotId}` : ''}, profile=${profile.name})`);
    completeJob(jobId, {
      ready: true, size: buffer.length, mime: DOCX_MIME, filename, scope, profileName: profile.name,
    });
  } catch (e) {
    if (e?.name === 'AbortError' || e?.message === 'job.cancelled') { failJob(jobId, e); return; }
    if (e?.code === 'BOOK_EMPTY')    { failJob(jobId, i18nError('job.error.bookEmpty'));    return; }
    if (e?.code === 'CHAPTER_EMPTY') { failJob(jobId, i18nError('job.error.chapterEmpty')); return; }
    if (e?.code === 'PAGE_EMPTY')    { failJob(jobId, i18nError('job.error.pageEmpty'));    return; }
    log.error(`docx-export job ${jobId}: ${e.message}`);
    failJob(jobId, e);
  }
}

router.post('/docx-export', jsonBody, async (req, res) => {
  const userEmail = req.session?.user?.email || null;

  // Fassungs-Export: snapshotId gesetzt → immer ganzes Buch.
  const snapshotId = toIntId(req.body?.snapshot_id || req.body?.snapshotId);

  const rawScope = snapshotId ? 'book' : String(req.body?.scope || 'book').toLowerCase();
  const scope = VALID_SCOPES.has(rawScope) ? rawScope : null;
  if (!scope) return res.status(400).json({ error_code: 'BAD_SCOPE' });

  const entityId = toIntId(req.body?.entityId ?? req.body?.entity_id ?? req.body?.book_id ?? req.body?.bookId);
  const profileId = toIntId(req.body?.profile_id || req.body?.profileId);
  if (!entityId || !profileId) return res.status(400).json({ error_code: 'ENTITY_OR_PROFILE_REQUIRED' });
  const includeSubchapters = scope === 'chapter' && (req.body?.include_subchapters === true || req.body?.includeSubchapters === true);

  const profile = getProfile(profileId);
  if (!profile) return res.status(404).json({ error_code: 'PROFILE_NOT_FOUND' });
  if (profile.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

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

  const dedupId = `${scope}:${entityId}:${profileId}${includeSubchapters ? ':sub' : ''}${snapshotId ? `:snap${snapshotId}` : ''}`;
  const existing = findActiveJobId('docx-export', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob('docx-export', bookId, userEmail, 'job.label.docxExport', { profile: profile.name }, dedupId);
  enqueueJob(jobId, () => runDocxExportJob(jobId, { scope, entityId, profileId, includeSubchapters, snapshotId, userEmail, userToken: null }));
  res.status(202).json({ jobId });
});

router.get('/docx-export/:id/file', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_READY', params: { status: job.status } });
  const r = docxResults.get(req.params.id);
  if (!r) return res.status(410).json({ error_code: 'RESULT_EXPIRED' });

  res.setHeader('Content-Type', r.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  res.setHeader('Content-Length', r.buffer.length);
  res.end(r.buffer);
});

module.exports = { docxExportRouter: router, runDocxExportJob };
