'use strict';
// REST-Endpoints fuer die Blog-Verbindung eines Buchs.
// /blog/:book_id/status   GET     — public connection meta (kein Passwort)
// /blog/:book_id/connect  POST    — credentials speichern + Test-Call
// /blog/:book_id/test     POST    — Connection testen ohne speichern
// /blog/:book_id          DELETE  — Verbindung loeschen (CASCADE killt Links)
//
// Pflicht: Buchtyp == 'blog' (gated via book_settings.buchtyp), aclParamGuard('editor').
// Logging-Context book-Slot via router.param + bookParamHandler.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { getBookSettings } = require('../db/schema');
const { isBlogBook, requireBlogTypeRoute } = require('../lib/buchtyp');
const blogs = require('../db/blogs');
const { createWpClient, validateBaseUrl } = require('../lib/wp-client');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

function _requireBlogType(req, res) {
  return requireBlogTypeRoute(req, res, 'BLOG_REQUIRES_BLOG_TYPE');
}

router.get('/:book_id/status', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  const isBlogType = isBlogBook(settings);
  const conn = blogs.getConnectionPublic(bookId);
  res.json({
    isBlogType: !!isBlogType,
    connected: !!conn,
    connection: conn,
  });
});

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const { baseUrl, username, password } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username || !password) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  try {
    const wp = createWpClient({ baseUrl: url, username, password });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(403).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
    return res.json({ ok: true, userId: me.id, name: me.name || me.slug || username });
  } catch (e) {
    const code = e.code || 'BLOG_TEST_FAILED';
    logger.warn(`Blog-Test fehlgeschlagen: ${code}`);
    return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
  }
});

router.post('/:book_id/connect', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const bookId = req.bookId;
  const { baseUrl, username, password, defaultStatus = 'draft' } = req.body || {};
  let url;
  try { url = validateBaseUrl(baseUrl); }
  catch (e) {
    return res.status(400).json({ error_code: e.code || 'BLOG_INVALID_URL' });
  }
  if (!username) {
    return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  }
  if (!['draft', 'publish', 'private'].includes(defaultStatus)) {
    return res.status(400).json({ error_code: 'BLOG_INVALID_STATUS' });
  }
  // Reuse stored password wenn Client `__keep__` schickt und Connection existiert.
  // Schutz: PW darf nie an Client zurueck und der bestehende verschlüsselte
  // Wert wird ueber db/blogs.js entschluesselt.
  let effectivePw = password;
  if ((!password || password === '__keep__')) {
    const existing = blogs.getConnection(bookId);
    if (existing) effectivePw = existing.password;
  }
  if (!effectivePw) return res.status(400).json({ error_code: 'BLOG_CREDENTIALS_REQUIRED' });
  try {
    const wp = createWpClient({ baseUrl: url, username, password: effectivePw });
    const me = await wp.me();
    const canEdit = !!(me && me.capabilities && me.capabilities.edit_posts);
    if (!canEdit) {
      return res.status(403).json({ error_code: 'BLOG_INSUFFICIENT_CAPABILITY' });
    }
  } catch (e) {
    const code = e.code || 'BLOG_TEST_FAILED';
    return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
  }
  const conn = blogs.upsertConnection({
    bookId, baseUrl: url, username, password: effectivePw, defaultStatus,
  });
  return res.json({ ok: true, connection: conn });
});

router.delete('/:book_id', aclParamGuard('editor'), (req, res) => {
  const ok = blogs.deleteConnection(req.bookId);
  res.json({ ok });
});

// Liste aller Page-Link-Stati fuer das Buch. Buchorganizer-Badges + Push-Auswahl
// lesen hier. Pro Eintrag: page_id, wp_post_id, wp_modified_at, wp_status,
// last_pulled_at, last_pushed_at, conflict_state.
router.get('/:book_id/links', aclParamGuard('viewer'), (req, res) => {
  const conn = blogs.getConnectionPublic(req.bookId);
  if (!conn) return res.json({ links: [], connected: false });
  const links = blogs.listLinksForBlog(conn.id);
  res.json({ links, connected: true, baseUrl: conn.baseUrl });
});

// WP-seitige Version einer verlinkten Page laden — fuer Konflikt-Diff. Liefert
// das App-Format-HTML (wpToAppHtml angewandt), damit der Renderer es gegen
// pages.body_html stellen kann.
router.get('/:book_id/pages/:page_id/remote', aclParamGuard('viewer'), async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) {
    return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  }
  const link = blogs.getLinkByPage(pageId);
  if (!link) return res.status(404).json({ error_code: 'BLOG_LINK_MISSING' });
  const conn = blogs.getConnection(req.bookId);
  if (!conn || conn.id !== link.blog_id) {
    return res.status(404).json({ error_code: 'BLOG_NOT_CONNECTED' });
  }
  try {
    const wp = createWpClient({
      baseUrl: conn.baseUrl,
      username: conn.username,
      password: conn.password,
    });
    const remote = await wp.getPost(link.wp_post_id);
    const { wpToAppHtml } = require('../lib/wp-html');
    return res.json({
      wpPostId: link.wp_post_id,
      title: (remote.title && (remote.title.raw || remote.title.rendered)) || '',
      html: await wpToAppHtml((remote.content && (remote.content.raw || remote.content.rendered)) || ''),
      status: remote.status,
      modifiedAt: remote.modified_gmt || remote.date_gmt || '',
    });
  } catch (e) {
    const code = e.code || 'BLOG_REMOTE_FETCH_FAILED';
    return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
  }
});

// Konflikt aufloesen: 'app' oder 'wp' gewinnt. Setzt conflict_state + ggf.
// schreibt Page mit WP-Inhalt (resolve=wp) oder pushed App-Inhalt (resolve=app).
// Push selbst laeuft als Job — hier wird nur der Konflikt-Marker geklaert, der
// User triggert dann explizit den Push.
router.post('/:book_id/pages/:page_id/resolve', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) {
    return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  }
  const resolve = (req.body && req.body.resolve) || '';
  if (resolve !== 'app' && resolve !== 'wp') {
    return res.status(400).json({ error_code: 'BLOG_RESOLVE_INVALID' });
  }
  const link = blogs.getLinkByPage(pageId);
  if (!link) return res.status(404).json({ error_code: 'BLOG_LINK_MISSING' });
  const conn = blogs.getConnection(req.bookId);
  if (!conn || conn.id !== link.blog_id) {
    return res.status(404).json({ error_code: 'BLOG_NOT_CONNECTED' });
  }
  if (resolve === 'wp') {
    try {
      const wp = createWpClient({
        baseUrl: conn.baseUrl, username: conn.username, password: conn.password,
      });
      const remote = await wp.getPost(link.wp_post_id);
      const { wpToAppHtml } = require('../lib/wp-html');
      const contentStore = require('../lib/content-store');
      const html = await wpToAppHtml((remote.content && (remote.content.raw || remote.content.rendered)) || '') || '<p></p>';
      const title = (remote.title && (remote.title.raw || remote.title.rendered)) || undefined;
      await contentStore.savePage(pageId, { html, ...(title ? { name: title } : {}) }, null);
      blogs.markLinkPulled(pageId, {
        wpModifiedAt: remote.modified_gmt || remote.date_gmt || '',
        wpStatus: remote.status || null,
        wpSlug: remote.slug || null,
      });
    } catch (e) {
      const code = e.code || 'BLOG_REMOTE_FETCH_FAILED';
      return res.status(code === 'BLOG_AUTH_FAILED' ? 401 : 502).json({ error_code: code });
    }
  } else {
    blogs.setConflictState(pageId, 'resolved-app');
  }
  return res.json({ ok: true, resolve });
});

module.exports = router;
