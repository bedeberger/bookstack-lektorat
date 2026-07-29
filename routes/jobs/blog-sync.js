'use strict';
// Blog-Sync-Jobs: einmaliger Initial-Import, manueller Delta-Pull, selektiver Push.
// Mapping 1 Blog == 1 Buch, 1 WP-Post == 1 Page. Block-Editor-HTML round-trips via
// lib/wp-html.js (Gutenberg-Block-Markup). Konflikt-Strategie: Timestamp-LWW (siehe
// docs/blog-sync.md). Job-Dedup pro (type, bookId, user) via findActiveJobId.

const express = require('express');
const {
  createJob, updateJob, completeJob, failJob,
  enqueueJob, findActiveJobId, jobAbortControllers,
  makeJobLogger, jsonBody,
} = require('./shared');
const blogs = require('../../db/blogs');
const contentStore = require('../../lib/content-store');
const { createWpClient } = require('../../lib/wp-client');
const { wpToAppHtml, appToWpHtmlWithMedia } = require('../../lib/wp-html');
const { buildBibliography, resolveCitesInHtml } = require('../../lib/bibliography');
const { makeImageResolver } = require('../../lib/wp-media');
const { classifyPull } = require('../../lib/blog-merge');
const { assertBlogBook } = require('../../lib/buchtyp');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { db } = require('../../db/connection');
const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');

const blogSyncRouter = express.Router();

function _abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

// Chapter-Resolver: WP-Posts werden nach Veroeffentlichungsjahr gebuendelt.
// chapter_name = "YYYY". Get-or-create pro Job, Cache als Map year→chapter_id
// erspart Mehrfach-Lookups.
async function _resolveYearChapter(bookId, year, cache) {
  if (cache.has(year)) return cache.get(year);
  const existing = await contentStore.listChapters(bookId, null);
  for (const ch of existing) {
    if (String(ch.name) === year) {
      cache.set(year, ch.id);
      return ch.id;
    }
  }
  const created = await contentStore.createChapter({ book_id: bookId, name: year }, null);
  cache.set(year, created.id);
  return created.id;
}

function _postYear(post) {
  const src = post.date_gmt || post.date || post.modified_gmt || '';
  const y = String(src).slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undatiert';
}

function _postPageName(post) {
  const src = post.date_gmt || post.date || post.modified_gmt || '';
  const day = String(src).slice(0, 10);
  const title = (post.title && (post.title.rendered || post.title.raw)) || post.slug || `Post ${post.id}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}: ${title}` : title;
}

function _resolveBlogConn(bookId) {
  const conn = blogs.getConnection(bookId);
  if (!conn) {
    const err = new Error('BLOG_NOT_CONNECTED');
    err.code = 'BLOG_NOT_CONNECTED';
    throw err;
  }
  return conn;
}

function _requireBlogBook(bookId, userEmail) {
  return assertBlogBook(bookId, userEmail, 'BLOG_REQUIRES_BLOG_TYPE');
}

async function runBlogImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    if (conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_ALREADY_IMPORTED'), { code: 'BLOG_ALREADY_IMPORTED' });
    }
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.blog.import.fetchPage', statusParams: { page: 1 }, progress: 1 });
    let page = 1;
    let totalPages = 1;
    let totalCount = 0;
    let imported = 0;
    const chapterCache = new Map();
    // Zaehlt Quellen-Chips, die ohne `data-src` zurueckkamen (KSES, siehe
    // lib/wp-html.js#_degradeCitesWithoutPointer) und darum zu Klartext wurden.
    const citeStats = {};

    do {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { posts, totalPages: tp, total } = await wp.listPosts({ page, perPage: 100 });
      totalPages = tp || 1;
      if (page === 1) totalCount = total;

      for (const post of posts) {
        if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
        const pageName = _postPageName(post);
        const year = _postYear(post);
        const chapterId = await _resolveYearChapter(bookId, year, chapterCache);
        const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
        const appHtml = await wpToAppHtml(rawHtml, citeStats) || '<p></p>';
        const created = await contentStore.createPage({
          book_id: bookId,
          chapter_id: chapterId,
          name: pageName,
          html: appHtml,
        }, null);
        blogs.upsertLink({
          pageId: created.id,
          blogId: conn.id,
          wpPostId: post.id,
          wpModifiedAt: post.modified_gmt || post.date_gmt || '',
          wpStatus: post.status || null,
          wpSlug: post.slug || null,
          lastPulledAt: new Date().toISOString(),
        });
        logger.info(`Blog-Import: WP-Post ${post.id} -> Page ${created.id} "${pageName}" (Kapitel ${year})`);
        imported++;
        updateJob(jobId, {
          statusText: 'job.blog.import.progress',
          statusParams: { done: imported, total: totalCount || imported },
          progress: Math.min(98, Math.round((imported / Math.max(1, totalCount)) * 95) + 1),
        });
      }
      page++;
    } while (page <= totalPages);

    blogs.markInitialImportDone(conn.id);
    blogs.touchPull(conn.id);

    // Vortags-Baseline aus Initial-Import (Donut braucht prevChars vor heute,
    // sonst Schreiben am Import-Tag = 0). Analog folder-import.
    if (imported > 0) {
      try {
        const { syncBook } = require('../sync');
        await syncBook(bookId, { session: { user: { email: userEmail } } });
        const yesterday = localIsoDaysAgo(1);
        const today = localIsoDate();
        db.prepare(`
          INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
          SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
            FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
          ON CONFLICT(book_id, recorded_at) DO UPDATE SET
            page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
            unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
            avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
        `).run(yesterday, bookId, today);
        logger.info(`Vortags-Baseline gesetzt (${yesterday}) aus Blog-Import.`);
      } catch (e) {
        logger.warn(`Baseline-Snapshot nach Blog-Import fehlgeschlagen: ${e.message}`);
      }
    }

    if (citeStats.citesDegraded) {
      logger.warn(`Blog-Import: ${citeStats.citesDegraded} Quellenangabe(n) ohne Zeiger — als Klartext uebernommen (WP-Benutzer ohne unfiltered_html?).`);
    }
    logger.info(`Initial-Import: ${imported} Posts importiert.`);
    completeJob(jobId, { imported, totalCount, citesDegraded: citeStats.citesDegraded || 0 }, null,
      `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Import-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

async function runBlogPullJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    if (!conn.initialImportDoneAt) {
      throw Object.assign(new Error('BLOG_IMPORT_FIRST'), { code: 'BLOG_IMPORT_FIRST' });
    }
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.blog.pull.fetch', progress: 1 });

    let page = 1;
    let totalPages = 1;
    let updated = 0;
    let created = 0;
    let conflicts = 0;
    let skipped = 0;
    const chapterCache = new Map();
    // Siehe runBlogImportJob: Chips, die KSES den Zeiger genommen hat.
    const citeStats = {};

    do {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { posts, totalPages: tp } = await wp.listPosts({
        page, perPage: 100,
        modifiedAfter: conn.lastPullAt || undefined,
      });
      totalPages = tp || 1;

      for (const post of posts) {
        if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
        const link = blogs.getLinkByPost(conn.id, post.id);
        const wpModified = post.modified_gmt || post.date_gmt || '';
        const pageName = _postPageName(post);
        const rawHtml = (post.content && (post.content.raw || post.content.rendered)) || '';
        const appHtml = await wpToAppHtml(rawHtml, citeStats) || '<p></p>';

        if (!link) {
          const year = _postYear(post);
          const chapterId = await _resolveYearChapter(bookId, year, chapterCache);
          const createdPage = await contentStore.createPage({
            book_id: bookId, chapter_id: chapterId, name: pageName, html: appHtml,
          }, null);
          blogs.upsertLink({
            pageId: createdPage.id,
            blogId: conn.id,
            wpPostId: post.id,
            wpModifiedAt: wpModified,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
            lastPulledAt: new Date().toISOString(),
          });
          logger.info(`Blog-Pull: WP-Post ${post.id} -> Page ${createdPage.id} "${pageName}" neu angelegt`);
          created++;
          continue;
        }

        const pageRow = await contentStore.loadPage(link.page_id).catch(() => null);
        if (!pageRow) {
          logger.warn(`Blog-Pull: Page ${link.page_id} (WP-Post ${post.id}) nicht gefunden, uebersprungen`);
          skipped++;
          continue;
        }
        const action = classifyPull({
          hasLink: true,
          wpModifiedAt: wpModified,
          linkModifiedAt: link.wp_modified_at,
          pageUpdatedAt: pageRow.updated_at,
          lastPulledAt: link.last_pulled_at,
        });

        if (action === 'conflict') {
          blogs.setConflictState(link.page_id, 'detected');
          logger.info(`Blog-Pull: Page ${link.page_id} "${pageRow.name}" (WP-Post ${post.id}) Konflikt erkannt`);
          conflicts++;
          continue;
        }
        if (action === 'update') {
          await contentStore.savePage(link.page_id, { name: pageName, html: appHtml }, null);
          blogs.markLinkPulled(link.page_id, {
            wpModifiedAt: wpModified,
            wpStatus: post.status || null,
            wpSlug: post.slug || null,
          });
          logger.info(`Blog-Pull: Page ${link.page_id} "${pageName}" aus WP-Post ${post.id} aktualisiert`);
          updated++;
          continue;
        }
        skipped++;
      }
      page++;
    } while (page <= totalPages);

    blogs.touchPull(conn.id);
    if (citeStats.citesDegraded) {
      logger.warn(`Blog-Pull: ${citeStats.citesDegraded} Quellenangabe(n) ohne Zeiger — als Klartext uebernommen (WP-Benutzer ohne unfiltered_html?).`);
    }
    logger.info(`Pull: ${updated} aktualisiert, ${created} neu, ${conflicts} Konflikt, ${skipped} unverändert.`);
    completeJob(jobId, { updated, created, conflicts, skipped, citesDegraded: citeStats.citesDegraded || 0 }, null,
      `${updated} aktualisiert / ${created} neu / ${conflicts} Konflikt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Pull-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

async function runBlogPushJob(jobId, bookId, userEmail, pageIds) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    let blogOrigin = '';
    try { blogOrigin = new URL(conn.baseUrl).origin; } catch { /* validated bei connect */ }
    // Inline-Bilder: data-URIs / fremd-gehostete Bilder in die WP-Mediathek laden,
    // bereits blog-gehostete unveraendert lassen. Fehler verwerfen nur das Bild.
    let imagesUploaded = 0;
    const _resolveImage = makeImageResolver({ wp, blogOrigin, signal: _abortSignal(jobId), logger });
    const resolveImage = async (src) => {
      const r = await _resolveImage(src);
      if (r && r.src && r.src !== src) imagesUploaded++;
      return r;
    };

    const ids = (pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw Object.assign(new Error('BLOG_NO_PAGES'), { code: 'BLOG_NO_PAGES' });

    let pushed = 0;
    let createdRemote = 0;
    let conflictSkipped = 0;
    const errors = [];
    const renamed = []; // [{ pageId, name }] — lokale Umbenennungen (Datum-Prefix)

    for (let i = 0; i < ids.length; i++) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageId = ids[i];
      updateJob(jobId, {
        statusText: 'job.blog.push.upload',
        statusParams: { current: i + 1, total: ids.length },
        progress: Math.round((i / ids.length) * 95) + 2,
      });
      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow) {
        logger.warn(`Blog-Push: Page ${pageId} nicht gefunden`);
        errors.push({ pageId, code: 'PAGE_NOT_FOUND' });
        continue;
      }
      if (pageRow.book_id !== bookId) {
        logger.warn(`Blog-Push: Page ${pageId} gehoert nicht zu Buch ${bookId}`);
        errors.push({ pageId, code: 'PAGE_WRONG_BOOK' });
        continue;
      }

      const link = blogs.getLinkByPage(pageId);
      if (link && link.conflict_state === 'detected') {
        logger.info(`Blog-Push: Page ${pageId} "${pageRow.name}" Konflikt offen, skip`);
        conflictSkipped++;
        errors.push({ pageId, code: 'BLOG_CONFLICT' });
        continue;
      }

      // Quellen: die Einheit ist die SEITE — ein WP-Post ist genau eine Seite.
      // Darum `pageIds: [pageId]`: die Nummern des numerischen Stils folgen den
      // Fundstellen dieses einen Posts ab 1, und Chip-Text und Verzeichnis
      // stimmen zusammen. `resolveCitesInHtml` setzt den Kurzbeleg frisch (der
      // gespeicherte Text ist nur ein Cache) und laeuft VOR dem Block-Emitter.
      //
      // Bewusst pro Seite gebaut statt einmal fuer den Job: die Nummern sind
      // per Definition seiten-spezifisch, und der Aufwand (drei indizierte
      // SQLite-Reads) ist neben dem HTTP-Round-Trip pro Post nicht messbar.
      const bib = await buildBibliography({ bookId, pageIds: [pageId], userEmail });
      const appHtml = await resolveCitesInHtml(pageRow.html || pageRow.body_html || '<p></p>', bib);
      const wpHtml = await appToWpHtmlWithMedia(appHtml, {
        resolveImage,
        // Verzeichnis nur bei ausdruecklich aktiviertem Blog-Anhang. Ohne das
        // Flag bleibt es Sache der Datei-Exporte.
        bibliography: bib.inBlog ? bib : null,
      });

      // Beim Create: der Datum-Prefix `YYYY-MM-DD:` ist app-intern. Der lokale
      // page_name bekommt `YYYY-MM-DD: Rest` (oder nur `YYYY-MM-DD`, falls Rest
      // leer; bereits vorhandener Prefix wird durch heute ersetzt). WordPress
      // bekommt den Titel OHNE Datum (nur `Rest`).
      let wpTitleForCreate = '';
      let localNameForCreate = pageRow.name || '';
      let renamedLocally = false;
      if (!link) {
        const today = localIsoDate();
        const raw = String(pageRow.name || '').trim();
        const m = /^\d{4}-\d{2}-\d{2}(?:\s*:\s*(.*))?$/.exec(raw);
        const rest = (m ? (m[1] || '') : raw).trim();
        wpTitleForCreate = rest;
        localNameForCreate = rest ? `${today}: ${rest}` : today;
        if (localNameForCreate !== pageRow.name) renamedLocally = true;
      }

      try {
        const remote = link
          ? await wp.updatePost(link.wp_post_id, { content: wpHtml })
          : await wp.createPost({
              title: wpTitleForCreate,
              content: wpHtml,
              status: conn.defaultStatus,
            });
        if (renamedLocally) {
          await contentStore.savePage(pageId, { name: localNameForCreate }, null);
          renamed.push({ pageId, name: localNameForCreate });
        }
        blogs.upsertLink({
          pageId,
          blogId: conn.id,
          wpPostId: remote.id,
          wpModifiedAt: remote.modified_gmt || remote.date_gmt || '',
          wpStatus: remote.status || null,
          wpSlug: remote.slug || null,
          lastPushedAt: new Date().toISOString(),
        });
        if (!link) {
          logger.info(`Blog-Push: Page ${pageId} "${localNameForCreate}" -> WP-Post ${remote.id} neu erstellt`);
          createdRemote++;
        } else {
          logger.info(`Blog-Push: Page ${pageId} "${pageRow.name}" -> WP-Post ${remote.id} aktualisiert`);
          pushed++;
        }
      } catch (e) {
        // Remote-Post 404: WP-User hat Draft/Post gelöscht. Link weg, Badge
        // flippt automatisch auf 'new' beim nächsten loadLinks. User kann
        // erneut pushen → neuer Post wird angelegt.
        if (link && (e.code === 'BLOG_HTTP_404' || e.status === 404)) {
          blogs.deleteLink(pageId);
          logger.info(`Blog-Push: Page ${pageId} "${pageRow.name}" -> WP-Post ${link.wp_post_id} weg (404), Link entfernt`);
          errors.push({ pageId, code: 'BLOG_REMOTE_GONE' });
        } else {
          logger.warn(`Blog-Push: Page ${pageId} "${pageRow.name}" Fehler ${e.code || e.message}`);
          errors.push({ pageId, code: e.code || 'BLOG_PUSH_FAILED' });
        }
      }
    }

    blogs.touchPush(conn.id);
    logger.info(`Push: ${pushed} aktualisiert, ${createdRemote} neu in WP, ${conflictSkipped} Konflikt skipped, ${imagesUploaded} Bilder hochgeladen, ${errors.length} Fehler.`);
    completeJob(jobId, { pushed, createdRemote, conflictSkipped, imagesUploaded, errors, renamed }, null,
      `${pushed + createdRemote} gepusht / ${errors.length} Fehler`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Push-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// Reconcile: pruft jeden Link via GET, dropt orphan Links (Remote-Post weg).
// Deckt Hard-Delete in WP (kein Trash-Stamp). Nach Lauf kennt der Buchorganizer
// die toten Links nicht mehr; Badges flippen auf 'new'.
async function runBlogReconcileJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveBlogConn(bookId);
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
      signal: _abortSignal(jobId),
    });

    const links = blogs.listLinksForBlog(conn.id);
    let checked = 0;
    let removed = 0;
    const total = links.length;
    updateJob(jobId, {
      statusText: 'job.blog.reconcile.check',
      statusParams: { current: 0, total },
      progress: 1,
    });

    for (const link of links) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      checked++;
      try {
        await wp.getPost(link.wp_post_id);
      } catch (e) {
        if (e.code === 'BLOG_HTTP_404' || e.status === 404) {
          blogs.deleteLink(link.page_id);
          removed++;
          logger.info(`Blog-Reconcile: Page ${link.page_id} -> WP-Post ${link.wp_post_id} weg, Link entfernt`);
        } else {
          logger.warn(`Blog-Reconcile: Page ${link.page_id} -> WP-Post ${link.wp_post_id} Fehler ${e.code || e.message}`);
        }
      }
      updateJob(jobId, {
        statusText: 'job.blog.reconcile.check',
        statusParams: { current: checked, total },
        progress: Math.min(98, 2 + Math.round((checked / Math.max(1, total)) * 95)),
      });
    }

    logger.info(`Blog-Reconcile: ${checked} geprüft, ${removed} orphan Links entfernt.`);
    completeJob(jobId, { checked, removed }, null, `${removed} orphan Links entfernt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`Blog-Reconcile-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

function _aclEditor(req, res, bookId) {
  try { requireBookAccess(req, bookId, 'editor'); return true; }
  catch (e) { if (sendACLError(res, e)) return false; throw e; }
}

blogSyncRouter.post('/blog-import', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('blog-import', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-import', book_id, userEmail, 'job.label.blogImport');
  enqueueJob(jobId, () => runBlogImportJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

blogSyncRouter.post('/blog-pull', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('blog-pull', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-pull', book_id, userEmail, 'job.label.blogPull');
  enqueueJob(jobId, () => runBlogPullJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

blogSyncRouter.post('/blog-reconcile', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('blog-reconcile', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-reconcile', book_id, userEmail, 'job.label.blogReconcile');
  enqueueJob(jobId, () => runBlogReconcileJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

blogSyncRouter.post('/blog-push', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = req.session?.user?.email || null;
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const pageIds = Array.isArray(req.body?.page_ids) ? req.body.page_ids : [];
  if (!pageIds.length) return res.status(400).json({ error_code: 'BLOG_PAGE_IDS_REQUIRED' });
  const existing = findActiveJobId('blog-push', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('blog-push', book_id, userEmail, 'job.label.blogPushCount', { count: pageIds.length });
  enqueueJob(jobId, () => runBlogPushJob(jobId, book_id, userEmail, pageIds));
  res.json({ jobId });
});

module.exports = { blogSyncRouter, runBlogImportJob, runBlogPullJob, runBlogPushJob, runBlogReconcileJob };
