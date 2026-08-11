'use strict';
// HubSpot-Sync-Jobs: einmaliger Initial-Import (alle PUBLISHED-Posts des
// konfigurierten Authors+Blogs in Jahres-Kapitel), selektiver Push (Page →
// HubSpot). Erst-Push pro Page erstellt einen neuen DRAFT-Post via
// `POST /cms/v3/blogs/posts`. Re-Push einer bereits verknüpften Page
// aktualisiert via `PATCH /cms/v3/blogs/posts/{id}/draft` den Buffer des
// bestehenden Posts; die Live-Version drüben bleibt unverändert, bis der User
// den Buffer in HubSpot publiziert. UI hat ihn vorher per appConfirm darauf
// hingewiesen, dass HubSpot-spezifische Formatierungen (Module/CTAs/Bilder/
// Forms/Tags) im Buffer durch den App-HTML-Body ersetzt werden.
// Mapping 1 Buch == 1 Blog, 1 Post == 1 Page. Job-Dedup pro (type, bookId,
// user) via findActiveJobId.

const express = require('express');
const {
  createJob, updateJob, completeJob, failJob,
  enqueueJob, findActiveJobId, jobAbortControllers,
  makeJobLogger, jsonBody,
} = require('./shared');
const hubspot = require('../../db/hubspot');
const contentStore = require('../../lib/content-store');
const { createHubspotClient } = require('../../lib/hubspot-client');
const { hubspotToAppHtml, appToHubspotHtml } = require('../../lib/hubspot-html');
const {
  buildBibliography, resolveCitesInHtml, bibliographySectionHtml,
} = require('../../lib/bibliography');
const { assertBlogBook } = require('../../lib/buchtyp');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { db } = require('../../db/connection');
const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');

const hubspotSyncRouter = express.Router();

function _abortSignal(jobId) {
  return jobAbortControllers.get(jobId)?.signal || null;
}

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

function _postDate(post) {
  return post.publishDate || post.created || post.updated || '';
}

function _postYear(post) {
  const y = String(_postDate(post)).slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undatiert';
}

function _postPageName(post) {
  const day = String(_postDate(post)).slice(0, 10);
  const title = (post.htmlTitle || post.name || post.slug || `Post ${post.id}`).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}: ${title}` : title;
}

function _resolveHubConn(bookId) {
  const conn = hubspot.getConnection(bookId);
  if (!conn) {
    const err = new Error('HUBSPOT_NOT_CONNECTED');
    err.code = 'HUBSPOT_NOT_CONNECTED';
    throw err;
  }
  return conn;
}

function _requireBlogBook(bookId, userEmail) {
  return assertBlogBook(bookId, userEmail, 'HUBSPOT_REQUIRES_BLOG_TYPE');
}

async function runHubspotImportJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveHubConn(bookId);
    if (conn.initialImportDoneAt) {
      throw Object.assign(new Error('HUBSPOT_ALREADY_IMPORTED'), { code: 'HUBSPOT_ALREADY_IMPORTED' });
    }
    const client = createHubspotClient({
      token: conn.token,
      signal: _abortSignal(jobId),
    });

    updateJob(jobId, { statusText: 'job.hubspot.import.fetch', progress: 1 });
    let imported = 0;
    let dropped = 0;
    const chapterCache = new Map();

    // Alle Posts puffern, dann aufsteigend nach Datum sortieren. HubSpot liefert
    // ohne `sort`-Param newest-first; ungesteuert laegen Jahres-Kapitel und
    // Seiten reverse-chronologisch. Sortieren erzwingt aelteste→neueste, sodass
    // Kapitel-Anlage und book_order chronologisch wachsen.
    const posts = [];
    for await (const post of client.iteratePosts({
      authorId: conn.authorId,
      blogId: conn.blogId,
      state: 'PUBLISHED',
    })) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      posts.push(post);
    }
    posts.sort((a, b) => String(_postDate(a)).localeCompare(String(_postDate(b))));

    for (const post of posts) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Idempotenz: bereits importierter Post (existing link) wird übersprungen.
      const existingLink = hubspot.getLinkByPost(conn.id, post.id);
      if (existingLink) {
        logger.info(`HubSpot-Import: Post ${post.id} bereits verlinkt mit Page ${existingLink.page_id}, skip`);
        dropped++;
        continue;
      }

      const title = (post.htmlTitle || post.name || '').trim();
      if (!title) {
        logger.warn(`HubSpot-Import: Post ${post.id} ohne Titel, skip`);
        dropped++;
        continue;
      }

      const rawHtml = post.postBody || '';
      const appHtml = hubspotToAppHtml(rawHtml) || '<p></p>';
      const pageName = _postPageName(post);
      const year = _postYear(post);
      const chapterId = await _resolveYearChapter(bookId, year, chapterCache);

      const created = await contentStore.createPage({
        book_id: bookId,
        chapter_id: chapterId,
        name: pageName,
        html: appHtml,
      }, null);
      hubspot.upsertLink({
        pageId: created.id,
        hubId: conn.id,
        hubspotPostId: post.id,
        hubspotState: post.state || 'PUBLISHED',
        hubspotCreatedAt: post.created || post.publishDate || null,
        // Sync-Baseline = Anlage-Zeitpunkt der Page. Sonst zaehlt die
        // Seitenanlage selbst (updated_at = jetzt > hubspot_created_at) als
        // lokaler Edit und der Import-Status ist faelschlich 'pushed-dirty'.
        lastPushedAt: created.updated_at || null,
        hubspotUrl: post.url || post.absoluteUrl || null,
      });
      logger.info(`HubSpot-Import: Post ${post.id} -> Page ${created.id} "${pageName}" (Kapitel ${year})`);
      imported++;
      updateJob(jobId, {
        statusText: 'job.hubspot.import.progress',
        statusParams: { done: imported },
        progress: Math.min(98, 2 + imported),
      });
    }

    hubspot.markInitialImportDone(conn.id);

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
        logger.info(`Vortags-Baseline gesetzt (${yesterday}) aus HubSpot-Import.`);
      } catch (e) {
        logger.warn(`Baseline-Snapshot nach HubSpot-Import fehlgeschlagen: ${e.message}`);
      }
    }

    logger.info(`HubSpot-Initial-Import: ${imported} importiert, ${dropped} uebersprungen.`);
    completeJob(jobId, { imported, dropped }, null, `${imported} Posts importiert`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Import-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

async function runHubspotPushJob(jobId, bookId, userEmail, pageIds) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveHubConn(bookId);
    const client = createHubspotClient({
      token: conn.token,
      signal: _abortSignal(jobId),
    });

    const ids = (pageIds || []).map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw Object.assign(new Error('HUBSPOT_NO_PAGES'), { code: 'HUBSPOT_NO_PAGES' });

    // Author-Name auflösen: HubSpot CMS v3 setzt den Autor auf neuen Posts nur
    // zuverlässig, wenn `name` (Autorname) zusätzlich zu `blogAuthorId` mitgeht.
    let authorName;
    try {
      const authors = await client.listAuthors();
      const row = (authors || []).find(a => String(a.id) === String(conn.authorId));
      authorName = (row?.fullName || row?.displayName || row?.name || '').trim() || undefined;
    } catch (e) {
      logger.warn(`HubSpot-Author-Name nicht auflösbar: ${e.code || e.message}`);
    }

    let pushed = 0;
    const errors = [];

    for (let i = 0; i < ids.length; i++) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      const pageId = ids[i];
      updateJob(jobId, {
        statusText: 'job.hubspot.push.upload',
        statusParams: { current: i + 1, total: ids.length },
        progress: Math.round((i / ids.length) * 95) + 2,
      });

      const pageRow = await contentStore.loadPage(pageId).catch(() => null);
      if (!pageRow) {
        logger.warn(`HubSpot-Push: Page ${pageId} nicht gefunden`);
        errors.push({ pageId, code: 'PAGE_NOT_FOUND' });
        continue;
      }
      if (pageRow.book_id !== bookId) {
        logger.warn(`HubSpot-Push: Page ${pageId} gehoert nicht zu Buch ${bookId}`);
        errors.push({ pageId, code: 'PAGE_WRONG_BOOK' });
        continue;
      }

      let existing = hubspot.getLinkByPage(pageId);

      // Quellen: Einheit ist die SEITE (ein Post = eine Seite), darum
      // `pageIds: [pageId]` — die Nummern des numerischen Stils folgen den
      // Fundstellen dieses Posts ab 1. `resolveCitesInHtml` setzt den
      // Kurzbeleg im aktuellen Zitierstil, bevor der Serializer laeuft.
      //
      // Der Chip selbst ueberlebt die HubSpot-Allowlist nicht: `span` steht
      // nicht in INLINE_MAP/BLOCK_MAP (lib/hubspot-html.js), also wird das
      // Element entpackt und der Kurzbeleg-Text bleibt als Klartext im Satz.
      // Genau richtig — HubSpot ist Push-only.
      //
      // KEIN Marker-Wrapper um das Verzeichnis (anders als bei WordPress):
      // HubSpot liest nie zurueck (kein Pull, kein Update-vom-Remote, siehe
      // docs/hubspot-sync.md), es kann also nichts akkumulieren. Ein `<div>`
      // wuerde die Allowlist ausserdem ohnehin entpacken.
      const bib = await buildBibliography({ bookId, pageIds: [pageId], userEmail });
      const appHtml = await resolveCitesInHtml(pageRow.html || pageRow.body_html || '<p></p>', bib);
      const bibSection = bib.inBlog ? bibliographySectionHtml(bib, { list: true }) : '';
      const postBody = appToHubspotHtml(appHtml + bibSection);
      const name = (pageRow.name || `Page ${pageId}`).trim();
      let revivedThis = false;

      const doCreate = () => client.createPost({
        name,
        postBody,
        contentGroupId: conn.blogId,
        blogAuthorId: conn.authorId,
        ...(authorName ? { authorName } : {}),
        state: 'DRAFT',
      });

      try {
        let remote;
        if (existing) {
          // Re-Push: Buffer/Draft des bestehenden Posts via PATCH aktualisieren.
          // Live-Version drüben bleibt unverändert, bis der User den Buffer in
          // HubSpot publiziert. HubSpot-spezifische Formatierungen im Live-Post
          // werden im Buffer durch den App-HTML-Body überschrieben — UI hat den
          // User vorab darauf hingewiesen (Warn-Dialog).
          try {
            remote = await client.updatePostDraft(existing.hubspot_post_id, { name, postBody });
          } catch (e) {
            // Remote-Post weg → Link entfernen, als neuer Push fahren.
            if (e.code === 'HUBSPOT_HTTP_404' || e.status === 404) {
              hubspot.deleteLink(pageId);
              logger.info(`HubSpot-Push: Page ${pageId} -> Post ${existing.hubspot_post_id} weg (404), Link entfernt, lege neu an`);
              existing = null;
              revivedThis = true;
              remote = await doCreate();
            } else {
              throw e;
            }
          }
        } else {
          remote = await doCreate();
        }
        hubspot.upsertLink({
          pageId,
          hubId: conn.id,
          hubspotPostId: (remote && remote.id) || (existing && existing.hubspot_post_id),
          hubspotState: (remote && remote.state) || (existing && existing.hubspot_state) || 'DRAFT',
          hubspotCreatedAt: (remote && (remote.created || remote.publishDate)) || (existing && existing.hubspot_created_at) || null,
          lastPushedAt: new Date().toISOString(),
          hubspotUrl: (remote && (remote.url || remote.absoluteUrl)) || (existing && existing.hubspot_url) || null,
        });
        if (revivedThis) logger.info(`HubSpot-Push: Page ${pageId} "${name}" -> Post ${remote.id} neu angelegt (vorheriger Post 404)`);
        else if (existing) logger.info(`HubSpot-Push: Page ${pageId} "${name}" -> Post ${existing.hubspot_post_id} Buffer aktualisiert`);
        else logger.info(`HubSpot-Push: Page ${pageId} "${name}" -> Post ${remote.id} neu angelegt (DRAFT)`);
        pushed++;
      } catch (e) {
        logger.warn(`HubSpot-Push: Page ${pageId} "${name}" Fehler ${e.code || e.message}`);
        errors.push({ pageId, code: e.code || 'HUBSPOT_PUSH_FAILED' });
      }
    }

    hubspot.touchPush(conn.id);
    logger.info(`HubSpot-Push: ${pushed} gepusht, ${errors.length} Fehler.`);
    completeJob(jobId, { pushed, errors }, null, `${pushed} gepusht / ${errors.length} Fehler`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Push-Fehler: ${e.code || e.message}`);
    failJob(jobId, e);
  }
}

// Reconcile: pruft jeden HubSpot-Link via GET, dropt orphan Links (Draft/Post
// weg). Nach Lauf flippt Badge auf 'new', User kann erneut pushen.
async function runHubspotReconcileJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    _requireBlogBook(bookId, userEmail);
    const conn = _resolveHubConn(bookId);
    const client = createHubspotClient({
      token: conn.token,
      signal: _abortSignal(jobId),
    });

    const links = hubspot.listLinksForConnection(conn.id);
    let checked = 0;
    let removed = 0;
    const total = links.length;
    updateJob(jobId, {
      statusText: 'job.hubspot.reconcile.check',
      statusParams: { current: 0, total },
      progress: 1,
    });

    for (const link of links) {
      if (_abortSignal(jobId)?.aborted) throw new DOMException('Aborted', 'AbortError');
      checked++;
      try {
        await client.getPost(link.hubspot_post_id);
      } catch (e) {
        if (e.code === 'HUBSPOT_HTTP_404' || e.status === 404) {
          hubspot.deleteLink(link.page_id);
          removed++;
          logger.info(`HubSpot-Reconcile: Page ${link.page_id} -> Post ${link.hubspot_post_id} weg, Link entfernt`);
        } else {
          logger.warn(`HubSpot-Reconcile: Page ${link.page_id} -> Post ${link.hubspot_post_id} Fehler ${e.code || e.message}`);
        }
      }
      updateJob(jobId, {
        statusText: 'job.hubspot.reconcile.check',
        statusParams: { current: checked, total },
        progress: Math.min(98, 2 + Math.round((checked / Math.max(1, total)) * 95)),
      });
    }

    logger.info(`HubSpot-Reconcile: ${checked} geprüft, ${removed} orphan Links entfernt.`);
    completeJob(jobId, { checked, removed }, null, `${removed} orphan Links entfernt`);
  } catch (e) {
    if (e.name !== 'AbortError') makeJobLogger(jobId).error(`HubSpot-Reconcile-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

function _aclEditor(req, res, bookId) {
  try { requireBookAccess(req, bookId, 'editor'); return true; }
  catch (e) { if (sendACLError(res, e)) return false; throw e; }
}

hubspotSyncRouter.post('/hubspot-import', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = sessionEmail(req);
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('hubspot-import', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('hubspot-import', book_id, userEmail, 'job.label.hubspotImport');
  enqueueJob(jobId, () => runHubspotImportJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

hubspotSyncRouter.post('/hubspot-reconcile', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = sessionEmail(req);
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const existing = findActiveJobId('hubspot-reconcile', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('hubspot-reconcile', book_id, userEmail, 'job.label.hubspotReconcile');
  enqueueJob(jobId, () => runHubspotReconcileJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

hubspotSyncRouter.post('/hubspot-push', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  if (!_aclEditor(req, res, book_id)) return;
  const userEmail = sessionEmail(req);
  try { _requireBlogBook(book_id, userEmail); }
  catch (e) { return res.status(400).json({ error_code: e.code }); }
  const pageIds = Array.isArray(req.body?.page_ids) ? req.body.page_ids : [];
  if (!pageIds.length) return res.status(400).json({ error_code: 'HUBSPOT_PAGE_IDS_REQUIRED' });
  const existing = findActiveJobId('hubspot-push', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('hubspot-push', book_id, userEmail, 'job.label.hubspotPushCount', { count: pageIds.length });
  enqueueJob(jobId, () => runHubspotPushJob(jobId, book_id, userEmail, pageIds));
  res.json({ jobId });
});

module.exports = { hubspotSyncRouter, runHubspotImportJob, runHubspotPushJob, runHubspotReconcileJob };
