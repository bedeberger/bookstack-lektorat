'use strict';
// Sharing- und Page-Lock-Routen. Mount-Punkt: /books — die Router-Pfade enthalten alle :book_id und
// laufen durch aclParamGuard fuer Logging-Context + Mindestrolle.

const express = require('express');
const appUsers = require('../db/app-users');
const bookAccess = require('../db/book-access');
const bookCategories = require('../db/book-categories');
const books = require('../db/books');
const { ACLError, aclParamGuard, requireBookAccess, sendACLError, sessionEmail } = require('../lib/acl');
const { resolvePageBookId } = require('../lib/content-ownership');
const { db } = require('../db/connection');
const { NOW_ISO_SQL } = require('../db/now');
const logger = require('../logger');
const mailer = require('../lib/mailer');
const appSettings = require('../lib/app-settings');

const router = express.Router();
const jsonBody = express.json({ limit: '64kb' });

const VALID_SHARE_ROLES = ['editor', 'lektor', 'viewer'];

function _normEmail(e) { return (e || '').toString().trim().toLowerCase(); }

function _notifyBookShared({ target, granter, bookId, role }) {
  try {
    const targetUser = appUsers.getUser(target);
    const granterUser = appUsers.getUser(granter);
    const locale = targetUser?.language === 'en' ? 'en' : 'de';
    const inviterName = granterUser?.display_name || granter;
    const bookName = books.getBookName(bookId) || `Buch ${bookId}`;
    const base = (appSettings.get('app.public_url') || '').replace(/\/$/, '');
    const bookUrl = base ? `${base}/#book/${bookId}` : '';
    mailer.send({
      to: target,
      template: 'book-shared',
      locale,
      ctx: { inviterName, bookName, role, bookUrl },
    }).catch(e => logger.warn(`book-shared mail failed to=${target}: ${e.message}`));
  } catch (e) {
    logger.warn(`book-shared mail prep failed to=${target}: ${e.message}`);
  }
}

// ── Access-Liste pro Buch ───────────────────────────────────────────────────

router.get('/:book_id/access', aclParamGuard('viewer'), (req, res) => {
  const list = bookAccess.listBookAccess(req.bookId);
  res.json({ access: list, my_role: req.bookRole });
});

// ── Share/Invite ────────────────────────────────────────────────────────────
//
// POST /books/:book_id/share { email, role }
// - Nur Owner darf sharen.
// - Ziel-User muss in app_users existieren (status='active' oder 'invited').
// - Auto-Accept: book_access-Row sofort + book_share_invites mit accepted_at.

router.post('/:book_id/share', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.body?.email);
  const role = req.body?.role;
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (!VALID_SHARE_ROLES.includes(role)) {
    return res.status(400).json({ error_code: 'ROLE_INVALID', detail: { allowed: VALID_SHARE_ROLES } });
  }
  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  if (user.status !== 'active' && user.status !== 'invited') {
    return res.status(400).json({ error_code: 'USER_NOT_USABLE', detail: { status: user.status } });
  }
  // Owner-Slot ist via Transfer-Route geschuetzt, nicht via Share — Share darf
  // einen Eintrag zu owner nicht hochstufen.
  const currentRole = bookAccess.getBookRole(req.bookId, target);
  if (currentRole === 'owner') {
    return res.status(409).json({ error_code: 'CANNOT_DOWNGRADE_OWNER' });
  }
  const granter = sessionEmail(req);
  try {
    db.transaction(() => {
      bookAccess.grantAccess(req.bookId, target, role, granter);
      db.prepare(`
        INSERT INTO book_share_invites (book_id, invitee_email, role, invited_by, invited_at, accepted_at)
        VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
        ON CONFLICT(book_id, invitee_email) DO UPDATE SET
          role        = excluded.role,
          invited_by  = excluded.invited_by,
          invited_at  = ${NOW_ISO_SQL},
          accepted_at = ${NOW_ISO_SQL},
          revoked_at  = NULL
      `).run(req.bookId, target, role, granter);
    })();
    appUsers.recordAuditEvent(target, 'role-changed', {
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      meta: { event: 'book-shared', book_id: req.bookId, role, by: granter },
    });
    logger.info(`Buch geteilt: book=${req.bookId} ${target} role=${role} by ${granter}`);
    _notifyBookShared({ target, granter, bookId: req.bookId, role });
    res.json({ ok: true, email: target, role });
  } catch (e) {
    logger.error(`POST /books/:id/share fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'SHARE_FAILED', detail: e.message });
  }
});

// PUT /books/:book_id/access/:email { role }
// Owner kann Rolle aendern — nicht fuer sich selbst und nicht zu 'owner'.
router.put('/:book_id/access/:email', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.params.email);
  const role = req.body?.role;
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (!VALID_SHARE_ROLES.includes(role)) {
    return res.status(400).json({ error_code: 'ROLE_INVALID', detail: { allowed: VALID_SHARE_ROLES } });
  }
  const current = bookAccess.getBookRole(req.bookId, target);
  if (!current) return res.status(404).json({ error_code: 'NOT_SHARED' });
  if (current === 'owner') {
    return res.status(409).json({ error_code: 'OWNER_NOT_DOWNGRADABLE', detail: 'Use /transfer-ownership instead' });
  }
  bookAccess.grantAccess(req.bookId, target, role, sessionEmail(req));
  logger.info(`Buch-Rolle geaendert: book=${req.bookId} ${target} ${current}→${role} by ${sessionEmail(req)}`);
  res.json({ ok: true, email: target, role });
});

// DELETE /books/:book_id/access/:email
// Owner darf revoken — nicht sich selbst (Transfer noetig).
router.delete('/:book_id/access/:email', aclParamGuard('owner'), (req, res) => {
  const target = _normEmail(req.params.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  const current = bookAccess.getBookRole(req.bookId, target);
  if (!current) return res.status(404).json({ error_code: 'NOT_SHARED' });
  if (current === 'owner') {
    return res.status(409).json({ error_code: 'CANNOT_REVOKE_OWNER' });
  }
  bookAccess.revokeAccess(req.bookId, target);
  logger.info(`Buch-Zugriff entzogen: book=${req.bookId} ${target} (was ${current}) by ${sessionEmail(req)}`);
  res.json({ ok: true });
});

// POST /books/:book_id/transfer-ownership { email }
// Neuer Owner muss bereits in book_access sein (= sehen das Buch schon).
router.post('/:book_id/transfer-ownership', aclParamGuard('owner'), jsonBody, (req, res) => {
  const target = _normEmail(req.body?.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  if (target === _normEmail(sessionEmail(req))) {
    return res.status(400).json({ error_code: 'CANNOT_TRANSFER_TO_SELF' });
  }
  try {
    const { previousOwner, newOwner } = bookAccess.transferOwnership(req.bookId, target, sessionEmail(req));
    logger.info(`Ownership-Transfer: book=${req.bookId} ${previousOwner}→${newOwner}`);
    res.json({ ok: true, previous_owner: previousOwner, new_owner: newOwner });
  } catch (e) {
    if (e.message === 'transferOwnership: target not in book_access') {
      return res.status(404).json({ error_code: 'TARGET_NOT_IN_ACCESS' });
    }
    logger.error(`Transfer fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'TRANSFER_FAILED', detail: e.message });
  }
});

// ── Kategorie ───────────────────────────────────────────────────────────────
//
// Pool wird ueber /local/categories verwaltet (admin-only fuer Mutationen).
// Hier nur Zuordnung auf das Buch — editor+ erforderlich.

router.get('/:book_id/category', aclParamGuard('viewer'), (req, res) => {
  const row = db.prepare('SELECT category_id FROM books WHERE book_id = ?').get(req.bookId);
  const category = row?.category_id ? bookCategories.get(row.category_id) : null;
  res.json({ category });
});

router.put('/:book_id/category', aclParamGuard('editor'), jsonBody, (req, res) => {
  const raw = req.body?.category_id;
  const cid = raw === null || raw === '' || raw === undefined ? null : parseInt(raw, 10);
  if (cid !== null && (!Number.isInteger(cid) || cid <= 0)) {
    return res.status(400).json({ error_code: 'INVALID_CATEGORY_ID' });
  }
  try {
    bookCategories.setForBook(req.bookId, cid);
    res.json({ ok: true, category_id: cid });
  } catch (e) {
    if (e.message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ error_code: 'CATEGORY_NOT_FOUND' });
    logger.error(`PUT /books/:id/category: ${e.message}`);
    res.status(500).json({ error_code: 'UPDATE_FAILED', detail: e.message });
  }
});

// ── Page-Locks ──────────────────────────────────────────────────────────────
//
// Lock-Routen sind page-scoped — Mindestrolle 'lektor' (Lektor darf locken
// um Findings sicher anzuwenden; Editor/Owner ebenfalls). Buch-ID wird per
// Page-ID nachgeladen.

function _resolvePageRole(req, pageId, minRole) {
  const bookId = resolvePageBookId(pageId);
  if (!bookId) throw new ACLError('PAGE_NOT_FOUND', 404);
  const role = requireBookAccess(req, bookId, minRole);
  return { bookId, role };
}

router.get('/pages/:page_id/lock', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  try {
    _resolvePageRole(req, pageId, 'viewer');
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  const lock = bookAccess.getPageLock(pageId);
  res.json({ lock: lock || null });
});

const _VALID_LOCK_REASONS = new Set(['lektorat', 'edit']);

router.post('/pages/:page_id/lock', jsonBody, (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  // reason aus Body, Default 'lektorat' (Backwards-Compat). 'edit' braucht
  // nur 'editor'-Rolle, 'lektorat' braucht 'lektor'-Rolle.
  const reason = _VALID_LOCK_REASONS.has(req.body?.reason) ? req.body.reason : 'lektorat';
  const minRole = reason === 'edit' ? 'editor' : 'lektor';
  let bookId;
  try {
    ({ bookId } = _resolvePageRole(req, pageId, minRole));
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  try {
    const lock = bookAccess.acquireLock(pageId, bookId, email, reason);
    res.json({ lock });
  } catch (e) {
    if (e.code === 'PAGE_LOCKED') {
      return res.status(423).json({
        error_code: 'PAGE_LOCKED',
        locked_by_email: e.lock.locked_by_email,
        reason: e.lock.reason,
        expires_at: e.lock.expires_at,
      });
    }
    logger.error(`acquireLock fehlgeschlagen: ${e.message}`);
    res.status(500).json({ error_code: 'LOCK_FAILED', detail: e.message });
  }
});

router.post('/pages/:page_id/lock/heartbeat', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = sessionEmail(req);
  try {
    const lock = bookAccess.heartbeatLock(pageId, email);
    if (!lock) return res.status(404).json({ error_code: 'LOCK_NOT_FOUND' });
    res.json({ lock });
  } catch (e) {
    if (e.code === 'PAGE_LOCKED') {
      return res.status(423).json({
        error_code: 'PAGE_LOCKED',
        locked_by_email: e.lock.locked_by_email,
        expires_at: e.lock.expires_at,
      });
    }
    throw e;
  }
});

router.delete('/pages/:page_id/lock', (req, res) => {
  const pageId = parseInt(req.params.page_id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  const email = sessionEmail(req);
  const force = req.query?.force === 'true' || req.query?.force === '1';
  let bookId, role;
  try {
    ({ bookId, role } = _resolvePageRole(req, pageId, force ? 'owner' : 'lektor'));
  } catch (e) {
    const sent = sendACLError(res, e); if (sent) return; throw e;
  }
  if (force) {
    const lock = bookAccess.getPageLock(pageId);
    const released = bookAccess.releaseLock(pageId, email, { force: true });
    if (released && lock) {
      appUsers.recordAuditEvent(lock.locked_by_email, 'role-changed', {
        ip: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
        meta: { event: 'lock-broken', book_id: bookId, page_id: pageId, broken_by: email },
      });
      logger.warn(`Lock gebrochen: page=${pageId} broken_by=${email} original=${lock.locked_by_email}`);
    }
    return res.json({ ok: true, released });
  }
  const released = bookAccess.releaseLock(pageId, email);
  res.json({ ok: true, released });
});

module.exports = router;
