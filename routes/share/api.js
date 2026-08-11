'use strict';
// Share-Link Owner-API (GET/POST/PATCH/DELETE /share/api/...): Link-Verwaltung,
// Pro-Seite-Zähler (Kommentare + Links), Buch-Kommentar-Threads, Owner-Reply/
// Resolve/Delete. Prüft Session selbst (requireSession), da der Router VOR dem
// globalen Auth-Guard gemountet ist.

const contentStore = require('../../lib/content-store');
const shareLinks = require('../../db/share-links');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');
const notify = require('../../lib/notify');
const logger = require('../../logger');
const H = require('../../lib/share-helpers');

const { jsonBody, INTRO_MAX, ANCHOR_BID_RE, resolveBidsToPages, backfillScopeBlockIds } = H;

// ── Auth-Mw ──────────────────────────────────────────────────────────────────
function requireSession(req, res, next) {
  if (!sessionEmail(req)) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  next();
}

function register(router) {
  router.get('/api/links', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const bookId = parseInt(req.query.book_id, 10);
    try {
      const rows = bookId
        ? shareLinks.listSharesByOwnerAndBook(ownerEmail, bookId)
        : shareLinks.listSharesByOwner(ownerEmail);
      if (bookId) setContext({ book: bookId });
      res.json(rows);
    } catch (e) {
      logger.error('[share/api/links GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Pro-Seite-Zähler offener Reviewer-Kommentare über alle Links des Buchs
  // (Page-, Chapter- und Book-Shares). Befüllt den Badge am „Teilen"-Menü und
  // im Tree. Page-Shares: direkt via link.page_id. Chapter/Book-Shares: verankerte
  // Kommentare via anchor_bid → Seite (Block-Scan über den Content-Store, nur
  // einmal pro Buch und nur wenn überhaupt verankerte Kommentare vorliegen);
  // nicht-verankerte Kommentare lassen sich keiner Seite zuordnen und zählen nicht.
  router.get('/api/page-comment-counts', requireSession, async (req, res) => {
    const ownerEmail = req.session.user.email;
    const bookId = parseInt(req.query.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    setContext({ book: bookId });
    try {
      const rows = shareLinks.openReaderCommentsForBook(ownerEmail, bookId);
      const counts = {};
      const bump = (pageId) => { if (pageId) counts[pageId] = (counts[pageId] || 0) + 1; };

      // Block-IDs der noch aufzulösenden, verankerten Kommentare sammeln.
      const pendingBids = new Set();
      for (const r of rows) {
        if (r.kind === 'page') bump(r.page_id);
        else if (r.anchor_bid) pendingBids.add(String(r.anchor_bid).toLowerCase());
      }

      // Block→Seite-Map nur bauen, wenn nötig (gecachter Scan über die Buch-Seiten).
      if (pendingBids.size) {
        const bidToPage = await resolveBidsToPages(bookId, pendingBids);
        for (const r of rows) {
          if (r.kind !== 'page' && r.anchor_bid) bump(bidToPage[String(r.anchor_bid).toLowerCase()]);
        }
      }
      res.json(counts);
    } catch (e) {
      logger.error('[share/api/page-comment-counts GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Pro-Seite-Zähler aktiver Share-Links, die diese Seite enthalten. Speist den
  // `.btn-count`-Badge am „Teilen"-Eintrag des Page-Action-Menüs. Eine Seite ist
  // enthalten in: einem Page-Share auf sie selbst, einem Chapter-Share auf ihr
  // Kapitel (Direkt-Children, analog Reader-Render) und jedem Buch-Share des Buchs.
  router.get('/api/page-link-counts', requireSession, async (req, res) => {
    const ownerEmail = req.session.user.email;
    const bookId = parseInt(req.query.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    setContext({ book: bookId });
    try {
      const links = shareLinks.activeLinksForOwnerBook(ownerEmail, bookId);
      let bookCount = 0;
      const chapterCount = {};
      const pageCount = {};
      for (const l of links) {
        if (l.kind === 'book') bookCount++;
        else if (l.kind === 'chapter' && l.chapter_id != null) chapterCount[l.chapter_id] = (chapterCount[l.chapter_id] || 0) + 1;
        else if (l.kind === 'page' && l.page_id != null) pageCount[l.page_id] = (pageCount[l.page_id] || 0) + 1;
      }
      const counts = {};
      const pages = await contentStore.listPages(bookId);
      for (const p of pages) {
        const n = bookCount
          + (p.chapter_id != null ? (chapterCount[p.chapter_id] || 0) : 0)
          + (pageCount[p.id] || 0);
        if (n > 0) counts[p.id] = n;
      }
      res.json(counts);
    } catch (e) {
      logger.error('[share/api/page-link-counts GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Volle Kommentar-Threads über alle Links eines Owners zu einem Buch. Speist die
  // Kommentar-Leiste der Leseansicht: der Client gruppiert zu Threads und filtert
  // per Anker (data-bid/quote) auf die aktuell gerenderte Seite. Jede Zeile trägt
  // share_token → Reply/Resolve/Delete nutzen die bestehenden Owner-Endpoints.
  router.get('/api/book-comments/:book_id', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const bookId = parseInt(req.params.book_id, 10);
    if (!Number.isInteger(bookId) || bookId <= 0) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    setContext({ book: bookId });
    try {
      const rows = shareLinks.listCommentsByOwnerBook(ownerEmail, bookId);
      if (req.query.mark_seen === '1') shareLinks.markOwnerSeenForBook(ownerEmail, bookId);
      res.json(rows);
    } catch (e) {
      logger.error('[share/api/book-comments GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.post('/api/links', requireSession, jsonBody, async (req, res) => {
    const ownerEmail = req.session.user.email;
    const { kind, page_id, chapter_id, book_id, intro, expires_at, show_toc } = req.body || {};
    if (kind !== 'page' && kind !== 'chapter' && kind !== 'book') return res.status(400).json({ error_code: 'INVALID_KIND' });
    if (kind === 'page' && !Number.isInteger(parseInt(page_id, 10))) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
    if (kind === 'chapter' && !Number.isInteger(parseInt(chapter_id, 10))) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
    if (kind === 'book' && !Number.isInteger(parseInt(book_id, 10))) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    if (intro && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
    if (expires_at) {
      const d = new Date(expires_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
      if (d <= new Date()) return res.status(400).json({ error_code: 'EXPIRES_AT_IN_PAST' });
    }

    // bookId aus Page bzw. Chapter holen + ACL prüfen.
    let bookId = null;
    let pageId = null;
    let chapterId = null;
    try {
      if (kind === 'page') {
        pageId = parseInt(page_id, 10);
        const pd = await contentStore.loadPage(pageId);
        bookId = pd.book_id;
      } else if (kind === 'chapter') {
        chapterId = parseInt(chapter_id, 10);
        const ch = await contentStore.loadChapter(chapterId);
        bookId = ch.book_id;
      } else {
        bookId = parseInt(book_id, 10);
        const b = await contentStore.loadBook(bookId);
        if (!b) throw new Error('book not found');
      }
    } catch {
      return res.status(404).json({ error_code: 'TARGET_NOT_FOUND' });
    }

    try {
      requireBookAccess(req, bookId, 'editor');
    } catch (e) {
      const ack = sendACLError(res, e); if (ack) return; throw e;
    }
    setContext({ book: bookId });

    try {
      const created = shareLinks.createShareLink({
        kind, pageId, chapterId, bookId,
        ownerEmail,
        intro: intro ? String(intro).slice(0, INTRO_MAX) : null,
        expiresAt: expires_at || null,
        showToc: !!show_toc,
      });

      // data-bid auf den Scope-Seiten nachziehen (Detail-Begruendung am Helper).
      await backfillScopeBlockIds(created);

      logger.info(`[share/api/links POST] kind=${kind} book=${bookId} token=${created.token.slice(0, 8)}`);
      res.json(created);
    } catch (e) {
      logger.error('[share/api/links POST] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.patch('/api/links/:token', requireSession, jsonBody, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    const patch = {};
    if ('intro' in (req.body || {})) {
      const intro = req.body.intro;
      if (intro != null && String(intro).length > INTRO_MAX) return res.status(400).json({ error_code: 'INTRO_TOO_LONG' });
      patch.intro = intro ? String(intro).slice(0, INTRO_MAX) : null;
    }
    if ('expires_at' in (req.body || {})) {
      const exp = req.body.expires_at;
      if (exp) {
        const d = new Date(exp);
        if (isNaN(d.getTime())) return res.status(400).json({ error_code: 'INVALID_EXPIRES_AT' });
      }
      patch.expiresAt = exp || null;
    }
    if ('show_toc' in (req.body || {})) {
      patch.showToc = !!req.body.show_toc;
    }
    try {
      shareLinks.updateShareLink(token, ownerEmail, patch);
      res.json(shareLinks.getShareLinkByToken(token));
    } catch (e) {
      logger.error('[share/api/links PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.delete('/api/links/:token', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    try {
      const ok = shareLinks.revokeShareLink(token, ownerEmail);
      if (!ok) return res.status(409).json({ error_code: 'ALREADY_REVOKED' });
      logger.info(`[share/api/links DELETE] token=${token.slice(0, 8)} book=${link.book_id}`);
      res.json({ ok: true });
    } catch (e) {
      logger.error('[share/api/links DELETE] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.get('/api/links/:token/comments', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    try {
      const rows = shareLinks.listCommentsByToken(token, { order: 'desc' });
      if (req.query.mark_seen === '1') shareLinks.markOwnerSeen(token, ownerEmail);
      res.json(rows);
    } catch (e) {
      logger.error('[share/api/links/comments GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Kapitel-Drop-off eines Links (Autor): pro Kapitel Ø-Lesetiefe + Anzahl der
  // Aufrufe, die es erreicht haben. Nur bei Buch-/Kapitel-Shares gefüllt.
  router.get('/api/links/:token/read-depth', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    try {
      res.json({ chapters: shareLinks.readDepthByToken(token) });
    } catch (e) {
      logger.error('[share/api/links/read-depth GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Gesamt-Fazits eines Links (Autor): Sternewertung + Freitext pro Leser.
  router.get('/api/links/:token/feedback', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    try {
      res.json({ feedback: shareLinks.listFeedbackByToken(token) });
    } catch (e) {
      logger.error('[share/api/links/feedback GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner-Sprung: ordnet einen verankerten Kommentar (Block via data-bid) der
  // konkreten Seite zu, damit der Editor sie öffnen kann. Page-Share = trivial;
  // Chapter-Share = Block in den Kapitel-Seiten suchen (Anker speichert keine
  // page_id).
  router.get('/api/links/:token/locate', requireSession, async (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    const bid = String(req.query?.bid || '').toLowerCase();
    if (!ANCHOR_BID_RE.test(bid)) return res.status(400).json({ error_code: 'INVALID_ANCHOR' });
    if (link.kind === 'page') return res.json({ page_id: link.page_id });
    try {
      // data-bid ist buchweit eindeutig → gecachter Scan über alle Buch-Seiten
      // (teilt den Cache mit page-comment-counts).
      const map = await resolveBidsToPages(link.book_id, new Set([bid]));
      res.json({ page_id: map[bid] || null });
    } catch (e) {
      logger.error('[share/api/links/locate GET] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner antwortet auf einen Root-Kommentar (Thread bidirektional).
  router.post('/api/links/:token/comments', requireSession, jsonBody, (req, res) => {
    const ownerEmail = req.session.user.email;
    const token = String(req.params.token || '');
    const link = shareLinks.getShareLinkByToken(token);
    if (!link || link.owner_email !== ownerEmail) return res.status(404).json({ error_code: 'NOT_FOUND' });
    setContext({ book: link.book_id });
    const body = String((req.body?.body || '')).trim();
    if (!body) return res.status(400).json({ error_code: 'BODY_REQUIRED' });
    if (body.length > H.BODY_MAX) return res.status(400).json({ error_code: 'BODY_TOO_LONG' });
    const target = parseInt(req.body?.parent_id, 10);
    if (!Number.isInteger(target)) return res.status(400).json({ error_code: 'INVALID_PARENT' });
    // Flacher Thread: Antwort auf eine Antwort hängt unter denselben Root.
    const parentId = shareLinks.resolveThreadRootId(target, token);
    if (!parentId) return res.status(400).json({ error_code: 'INVALID_PARENT' });
    try {
      const reply = shareLinks.insertOwnerReply({ token, parentId, authorEmail: ownerEmail, body });
      logger.info(`[share/api/reply] token=${token.slice(0, 8)} book=${link.book_id} parent=${parentId}`);
      // Reviewer per Mail zurueckholen, wenn er beim Root eine Adresse hinterlegt
      // hat (fire-and-forget, gedrosselt, opt-out). Kein Leak: Mail nur an den
      // Root-Verfasser dieses Threads.
      notify.maybeNotifyReaderReply(link, reply, shareLinks.getCommentById(parentId)).catch(() => {});
      res.json(reply);
    } catch (e) {
      logger.error('[share/api/reply POST] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  // Owner markiert einen Root-Thread als erledigt / oeffnet ihn wieder.
  router.patch('/api/comments/:id/resolve', requireSession, jsonBody, (req, res) => {
    const ownerEmail = req.session.user.email;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const resolved = req.body?.resolved !== false;
    try {
      const ok = shareLinks.setCommentResolved(id, ownerEmail, resolved);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true, resolved });
    } catch (e) {
      logger.error('[share/api/comments resolve PATCH] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });

  router.delete('/api/comments/:id', requireSession, (req, res) => {
    const ownerEmail = req.session.user.email;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    try {
      const ok = shareLinks.deleteComment(id, ownerEmail);
      if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
      res.json({ ok: true });
    } catch (e) {
      logger.error('[share/api/comments DELETE] ' + e.message);
      res.status(500).json({ error_code: 'DB_ERROR' });
    }
  });
}

module.exports = { register, requireSession };
