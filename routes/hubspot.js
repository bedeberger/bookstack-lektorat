'use strict';
// REST-Endpoints fuer die HubSpot-Verbindung eines Buchs (Buchtyp 'blog').
//   GET    /hubspot/:book_id/status    — public connection meta (kein Token)
//   POST   /hubspot/:book_id/test      — Token gegen /integrations/v1/me pruefen
//   GET    /hubspot/:book_id/blogs     — Combobox-Source contentGroups
//   GET    /hubspot/:book_id/authors   — Combobox-Source Autoren
//   POST   /hubspot/:book_id/connect   — Token + Blog-ID + Author-ID speichern
//   GET    /hubspot/:book_id/links     — Page-Link-Status fuer Badges/Push
//   DELETE /hubspot/:book_id           — Verbindung loeschen (CASCADE killt Links)
//
// Pflicht: Buchtyp == 'blog' (gated via book_settings.buchtyp), aclParamGuard().
// Logging-Context book-Slot via router.param + bookParamHandler.

const express = require('express');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { getBookSettings } = require('../db/schema');
const { isBlogBook, requireBlogTypeRoute } = require('../lib/buchtyp');
const hubspot = require('../db/hubspot');
const { createHubspotClient } = require('../lib/hubspot-client');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

router.param('book_id', bookParamHandler);

const KEEP_TOKEN = '__keep__';

function _requireBlogType(req, res) {
  return requireBlogTypeRoute(req, res, 'HUBSPOT_REQUIRES_BLOG_TYPE');
}

function _resolveToken(req, bookId) {
  const raw = (req.body && req.body.token) || '';
  if (raw && raw !== KEEP_TOKEN) return String(raw);
  const existing = hubspot.getConnection(bookId);
  return existing ? existing.token : '';
}

function _mapHubspotError(res, e) {
  const code = e?.code || 'HUBSPOT_FETCH_FAILED';
  const status =
    code === 'HUBSPOT_AUTH_FAILED' ? 401 :
    code === 'HUBSPOT_FORBIDDEN'   ? 403 :
    code === 'HUBSPOT_RATE_LIMIT'  ? 429 :
    502;
  return res.status(status).json({ error_code: code });
}

router.get('/:book_id/status', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, sessionEmail(req));
  const isBlogType = isBlogBook(settings);
  const conn = hubspot.getConnectionPublic(bookId);
  res.json({
    isBlogType: !!isBlogType,
    connected: !!conn,
    connection: conn,
  });
});

router.post('/:book_id/test', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const token = _resolveToken(req, req.bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const client = createHubspotClient({ token });
    const me = await client.me();
    return res.json({ ok: true, portalId: me.portalId || null });
  } catch (e) {
    logger.warn(`HubSpot-Test fehlgeschlagen: ${e.code || e.message}`);
    return _mapHubspotError(res, e);
  }
});

router.get('/:book_id/blogs', aclParamGuard('editor'), async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const conn = hubspot.getConnection(req.bookId);
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const token = tokenFromQuery || (conn ? conn.token : '');
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const client = createHubspotClient({ token });
    const items = await client.listBlogs();
    res.json({
      blogs: items.map(b => ({
        id: String(b.id || b.contentGroupId || ''),
        name: b.name || b.htmlTitle || '(ohne Name)',
      })).filter(b => b.id),
    });
  } catch (e) {
    return _mapHubspotError(res, e);
  }
});

router.get('/:book_id/authors', aclParamGuard('editor'), async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const conn = hubspot.getConnection(req.bookId);
  const tokenFromQuery = typeof req.query.token === 'string' ? req.query.token : '';
  const token = tokenFromQuery || (conn ? conn.token : '');
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  try {
    const client = createHubspotClient({ token });
    const items = await client.listAuthors();
    res.json({
      authors: items.map(a => ({
        id: String(a.id || ''),
        name: (a.fullName || a.displayName || a.name || '(ohne Name)').trim(),
        email: a.email || null,
      })).filter(a => a.id),
    });
  } catch (e) {
    return _mapHubspotError(res, e);
  }
});

router.post('/:book_id/connect', aclParamGuard('editor'), jsonBody, async (req, res) => {
  if (!_requireBlogType(req, res)) return;
  const bookId = req.bookId;
  const { blogId, authorId } = req.body || {};
  if (!blogId) return res.status(400).json({ error_code: 'HUBSPOT_BLOG_REQUIRED' });
  if (!authorId) return res.status(400).json({ error_code: 'HUBSPOT_AUTHOR_REQUIRED' });
  const token = _resolveToken(req, bookId);
  if (!token) return res.status(400).json({ error_code: 'HUBSPOT_TOKEN_REQUIRED' });
  let portalId = null;
  try {
    const client = createHubspotClient({ token });
    const me = await client.me();
    if (me && me.portalId != null) portalId = String(me.portalId);
  } catch (e) {
    return _mapHubspotError(res, e);
  }
  const conn = hubspot.upsertConnection({
    bookId, token, blogId: String(blogId), authorId: String(authorId), portalId,
  });
  return res.json({ ok: true, connection: conn });
});

router.delete('/:book_id', aclParamGuard('editor'), (req, res) => {
  const ok = hubspot.deleteConnection(req.bookId);
  res.json({ ok });
});

router.get('/:book_id/links', aclParamGuard('viewer'), async (req, res) => {
  const conn = hubspot.getConnectionPublic(req.bookId);
  if (!conn) return res.json({ links: [], connected: false });
  let portalId = conn.portalId || null;
  // Self-Heal fuer Pre-150-Connections: einmaliger me()-Roundtrip persistiert
  // portalId, danach kein weiterer Call mehr noetig.
  if (!portalId) {
    try {
      const full = hubspot.getConnection(req.bookId);
      if (full && full.token) {
        const client = createHubspotClient({ token: full.token });
        const me = await client.me();
        if (me && me.portalId != null) {
          portalId = String(me.portalId);
          hubspot.setPortalId(conn.id, portalId);
        }
      }
    } catch (e) {
      logger.warn(`HubSpot-portalId-Backfill fehlgeschlagen: ${e.code || e.message}`);
    }
  }
  const links = hubspot.listLinksForConnection(conn.id);
  res.json({ links, connected: true, blogId: conn.blogId, portalId });
});

module.exports = router;
