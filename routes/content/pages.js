'use strict';
// Content-Routes: Seiten-Ebene (Detail/Save/Create/Delete), Page-Presence-
// Heartbeats + Page-Revisions (Liste/Detail/Restore).

const express = require('express');
const contentStore = require('../../lib/content-store');
const pageRevisions = require('../../db/page-revisions');
const pagePresence = require('../../db/page-presence');
const bookPresence = require('../../db/book-presence');
const appUsersDevices = require('../../db/app-users-devices');
const bookAccess = require('../../db/book-access');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { resolveChapterBookId } = require('../../lib/content-ownership');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const { jsonBody, _validDeviceId, _deviceTokenLabel, _guardPage, _fail } = require('./shared');

function register(router) {
  // GET /content/pages/:page_id — Volltext + Metadaten.
  router.get('/pages/:page_id', async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (_guardPage(req, res, pageId, 'viewer') == null) return;
    try { res.json(await contentStore.loadPage(pageId, req)); }
    catch (e) { _fail(res, e, 'GET /content/pages/:id'); }
  });

  // PUT /content/pages/:page_id — Free-Edit-Pfad. minRole editor.
  // Blockiert durch fremden Page-Lock (lektorat-Session).
  router.put('/pages/:page_id', jsonBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    const bookId = _guardPage(req, res, pageId, 'editor');
    if (bookId == null) return;
    const email = sessionEmail(req);
    const blocking = bookAccess.getBlockingLockFor(pageId, email);
    if (blocking) return res.status(423).json({
      error_code: 'PAGE_LOCKED',
      locked_by_email: blocking.locked_by_email,
      expires_at: blocking.expires_at,
    });
    // Geraet, das den Edit schreibt, vorab registrieren — sonst verletzt das
    // FK-getragene pages.last_editor_device_id die Referenz auf app_users_devices,
    // falls der erste device-ping/presence-Heartbeat noch nicht durch ist.
    if (req.body && req.body.device_id !== undefined) {
      if (_validDeviceId(req.body.device_id)) {
        try {
          // Nativer Client (Device-Token-Auth) liefert seinen echten Geraetenamen
          // ueber device_tokens.device_name — als Label durchreichen, sonst stuende
          // im „Zuletzt bearbeitet"-Hint nur das UA-Label („Unbekanntes Geraet").
          appUsersDevices.upsertDevice(req.body.device_id, email, req.get('user-agent') || '', _deviceTokenLabel(req));
          // Push registriert das schreibende Geraet zugleich als Buch-Praesenz —
          // so erkennt ein paralleler Browser (eigener device-ping) das Zweit-Geraet
          // (z.B. nativer Mac-Client) ueber self_book_device_count und schaltet den
          // Collab-Poll frei, der dann diesen Edit via /changes als Remote-Change
          // einsammelt. Ephemeral (90s-Stale), kein eigener Heartbeat noetig.
          if (email) bookPresence.ping(bookId, email, req.body.device_id, pageId);
        } catch { /* nicht-fatal: savePage faellt auf NULL device zurueck */ }
      } else {
        // Ungueltige device_id verwerfen, damit savePage keine FK-Verletzung schreibt.
        req.body.device_id = null;
      }
    }
    try { res.json(await contentStore.savePage(pageId, req.body || {}, req)); }
    catch (e) {
      if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
      if (e.code === 'PAGE_CONFLICT') return res.status(409).json({
        error_code: 'PAGE_CONFLICT',
        server_updated_at: e.serverUpdatedAt || null,
        server_editor_email: e.serverEditorEmail || null,
        server_editor_name: e.serverEditorDisplay || e.serverEditorEmail || null,
        // Eigenes Zweit-Geraet statt fremder User: der Editor formuliert das
        // Konflikt-Banner danach.
        server_is_self: !!email && e.serverEditorEmail === email,
        server_editor_device: e.serverEditorDevice || null,
      });
      _fail(res, e, 'PUT /content/pages/:id');
    }
  });

  // ── Page-Presence ────────────────────────────────────────────────────────
  // Heartbeat-Pings, damit die UI „Alice editiert gerade Seite X" anzeigen kann.
  // Client pingt waehrend Edit-Mode alle 30s; Server filtert Stale-Eintraege
  // (>90s) bei jedem List-Read.

  // POST /content/pages/:page_id/presence — Heartbeat. Min-Role viewer reicht;
  // Lese-Rollen koennen auch nur „lesen-da" signalisieren wenn wir das spaeter
  // brauchen. Auf editor-Rolle gaten, falls Datenschutz das verlangt — derzeit
  // keine Anforderung dafuer.
  router.post('/pages/:page_id/presence', jsonBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    const bookId = _guardPage(req, res, pageId, 'editor');
    if (bookId == null) return;
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const deviceId = req.body?.device_id;
    if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
    try {
      appUsersDevices.upsertDevice(deviceId, email, req.get('user-agent') || '');
      pagePresence.ping(pageId, email, bookId, deviceId);
    } catch (e) { return _fail(res, e, 'POST /content/pages/:id/presence'); }
    res.json({ ok: true });
  });

  // DELETE /content/pages/:page_id/presence — Eigener Edit-Exit (cancel/blur).
  // Optional — Stale-Filter wuerde den Eintrag eh nach 90s entfernen, aber
  // expliziter Abmelden gibt der UI sofortige Korrektheit.
  router.delete('/pages/:page_id/presence', jsonBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    const bookId = _guardPage(req, res, pageId, 'viewer');
    if (bookId == null) return;
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    // Body wird bei sendBeacon/keepalive nicht immer geparst; Query als Fallback.
    const deviceId = req.body?.device_id || req.query?.device_id;
    if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
    try { pagePresence.leave(pageId, email, deviceId); }
    catch (e) { return _fail(res, e, 'DELETE /content/pages/:id/presence'); }
    res.json({ ok: true });
  });

  // ── Page-Revisions ─────────────────────────────────────────────────────────
  // Schreib-Hook lebt in der content-store-Facade (jeder erfolgreiche
  // savePage → page_revisions-Row). Routen hier sind nur Lese-Pfad + Restore.

  // GET /content/pages/:page_id/revisions — Liste (ohne body_html).
  router.get('/pages/:page_id/revisions', async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (_guardPage(req, res, pageId, 'viewer') == null) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    res.json({ revisions: pageRevisions.listForPage(pageId, limit) });
  });

  // GET /content/pages/:page_id/revisions/:rev_id — Voller Body fuer Vorschau.
  router.get('/pages/:page_id/revisions/:rev_id', async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    const revId = toIntId(req.params.rev_id);
    if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (_guardPage(req, res, pageId, 'viewer') == null) return;
    const rev = pageRevisions.get(revId);
    if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
    res.json({ revision: rev });
  });

  // POST /content/pages/:page_id/revisions/:rev_id/restore — Body der Revision
  // wird via Facade als neue Revision (source='main') zurueckgeschrieben.
  // Page-Lock + editor-Rolle wie der normale Save-Pfad.
  router.post('/pages/:page_id/revisions/:rev_id/restore', jsonBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    const revId = toIntId(req.params.rev_id);
    if (!pageId || !revId) return res.status(400).json({ error_code: 'INVALID_ID' });
    const bookId = _guardPage(req, res, pageId, 'editor');
    if (bookId == null) return;
    const email = sessionEmail(req);
    const blocking = bookAccess.getBlockingLockFor(pageId, email);
    if (blocking) return res.status(423).json({
      error_code: 'PAGE_LOCKED',
      locked_by_email: blocking.locked_by_email,
      expires_at: blocking.expires_at,
    });
    const rev = pageRevisions.get(revId);
    if (!rev || rev.page_id !== pageId) return res.status(404).json({ error_code: 'REVISION_NOT_FOUND' });
    try {
      const saved = await contentStore.savePage(
        pageId,
        { html: rev.body_html, source: 'main', summary: `restored from #${revId}` },
        req,
      );
      res.json({ ok: true, page: saved, restored_from: revId });
    } catch (e) {
      if (e.code === 'EMPTY_BODY') return res.status(400).json({ error_code: 'EMPTY_BODY' });
      _fail(res, e, 'POST /content/pages/:id/revisions/:rev/restore');
    }
  });

  // POST /content/pages — Neue Seite. Body: { book_id?, chapter_id?, name, html? }.
  // Mindestens einer von book_id/chapter_id ist Pflicht. minRole editor.
  router.post('/pages', jsonBody, async (req, res) => {
    const bookIdRaw = req.body?.book_id !== undefined ? toIntId(req.body.book_id) : null;
    const chapterIdRaw = req.body?.chapter_id !== undefined ? toIntId(req.body.chapter_id) : null;
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
    if (!bookIdRaw && !chapterIdRaw) return res.status(400).json({ error_code: 'BOOK_OR_CHAPTER_REQUIRED' });
    const effBookId = bookIdRaw || resolveChapterBookId(chapterIdRaw);
    if (!effBookId) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
    setContext({ book: effBookId });
    try { requireBookAccess(req, effBookId, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
    try {
      const created = await contentStore.createPage({
        book_id: effBookId,
        chapter_id: chapterIdRaw || undefined,
        name,
        html: req.body?.html,
      }, req);
      res.json(created);
    } catch (e) { _fail(res, e, 'POST /content/pages'); }
  });

  // POST /content/pages/:page_id/move — Seite in ein anderes Buch verschieben.
  // Body: { target_book_id, target_chapter_id? }. minRole editor auf BEIDEN
  // Buechern. Blockiert durch fremden Page-Lock (lektorat-Session) wie der Save-
  // Pfad. Buchwelt-Analyse der Quelle wird gekappt (siehe contentStore.movePage).
  router.post('/pages/:page_id/move', jsonBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    const sourceBookId = _guardPage(req, res, pageId, 'editor');
    if (sourceBookId == null) return;
    const targetBookId = toIntId(req.body?.target_book_id);
    if (!targetBookId) return res.status(400).json({ error_code: 'INVALID_TARGET_BOOK_ID' });
    if (targetBookId === sourceBookId) return res.status(400).json({ error_code: 'SAME_BOOK' });
    const hasChap = req.body?.target_chapter_id !== undefined
      && req.body?.target_chapter_id !== null && req.body?.target_chapter_id !== 0;
    const targetChapterId = hasChap ? toIntId(req.body.target_chapter_id) : null;
    // editor-Recht auf dem Ziel-Buch erzwingen.
    try { requireBookAccess(req, targetBookId, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
    const email = sessionEmail(req);
    const blocking = bookAccess.getBlockingLockFor(pageId, email);
    if (blocking) return res.status(423).json({
      error_code: 'PAGE_LOCKED',
      locked_by_email: blocking.locked_by_email,
      expires_at: blocking.expires_at,
    });
    try {
      const result = await contentStore.movePage(pageId, { targetBookId, targetChapterId }, req);
      res.json(result);
    } catch (e) {
      if (e.code === 'SAME_BOOK') return res.status(400).json({ error_code: 'SAME_BOOK' });
      if (e.code === 'TARGET_BOOK_NOT_FOUND') return res.status(404).json({ error_code: 'TARGET_BOOK_NOT_FOUND' });
      if (e.code === 'CHAPTER_NOT_IN_TARGET') return res.status(400).json({ error_code: 'CHAPTER_NOT_IN_TARGET' });
      _fail(res, e, 'POST /content/pages/:id/move');
    }
  });

  // DELETE /content/pages/:page_id — Seite hart löschen (kein Papierkorb). minRole editor.
  router.delete('/pages/:page_id', async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (_guardPage(req, res, pageId, 'editor') == null) return;
    const email = sessionEmail(req);
    const deviceId = _validDeviceId(req.query?.device_id) ? req.query.device_id : null;
    try {
      await contentStore.deletePage(pageId, req, { deletedBy: email, deviceId });
      res.json({ ok: true });
    } catch (e) { _fail(res, e, 'DELETE /content/pages/:id'); }
  });

  // ── Manuskript-Bilder (Notebook-Editor) ────────────────────────────────────
  // Vom User eingefuegte Bilder, als BLOB an die Seite gebunden (CASCADE),
  // im Page-HTML referenziert als <img src="/content/page-image/:id">.

  // Rohe Bild-Bytes (Browser sendet den File-Body mit Content-Type: image/*).
  const rawImageBody = express.raw({ type: 'image/*', limit: '16mb' });

  // POST /content/pages/:page_id/images — Bild hochladen. minRole editor.
  // Body = rohe Bild-Bytes. sharp normalisiert (sRGB, EXIF-strip, max 2000px,
  // JPEG/PNG). Liefert { id, url, width, height, mime }.
  router.post('/pages/:page_id/images', rawImageBody, async (req, res) => {
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (_guardPage(req, res, pageId, 'editor') == null) return;
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return res.status(400).json({ error_code: 'EMPTY_IMAGE' });
    }
    try {
      const { preparePageImage } = require('../../lib/page-image-prepare');
      const { insertPageImage } = require('../../db/page-images');
      const prepared = await preparePageImage(raw);
      const id = insertPageImage({
        pageId,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
        size: prepared.buffer.length,
        image: prepared.buffer,
      });
      res.json({
        id,
        url: `/content/page-image/${id}`,
        width: prepared.width,
        height: prepared.height,
        mime: prepared.mime,
      });
    } catch (e) {
      if (/^image-/.test(e.message || '')) {
        return res.status(400).json({ error_code: 'INVALID_IMAGE', detail: e.message });
      }
      _fail(res, e, 'POST /content/pages/:id/images');
    }
  });

  // GET /content/page-image/:id — Bild streamen. ACL-Owner-Scope via JOIN
  // page_id → pages.book_id (viewer reicht — Bild ist Teil des lesbaren Inhalts).
  // ?download=1 erzwingt Attachment-Disposition.
  router.get('/page-image/:id', (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const { getPageImage } = require('../../db/page-images');
    const row = getPageImage(id);
    if (!row) return res.status(404).json({ error_code: 'IMAGE_NOT_FOUND' });
    setContext({ book: row.book_id });
    try { requireBookAccess(req, row.book_id, 'viewer'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }

    // Defense-in-depth: nur Raster-MIMEs inline; nosniff + restriktive CSP
    // verhindern HTML/Script-Interpretation des Bild-Bodys (Stored-XSS-Schutz).
    const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const safe = SAFE_IMAGE_MIME.has(row.mime);
    const ext = (safe && row.mime.split('/')[1]) || 'jpg';
    res.setHeader('Content-Type', safe ? row.mime : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download || !safe) {
      res.setHeader('Content-Disposition', `attachment; filename="bild-${id}.${ext}"`);
    }
    res.setHeader('Content-Length', row.image.length);
    res.end(row.image);
  });
}

module.exports = { register };
