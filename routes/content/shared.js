'use strict';
// Geteilte HTTP-Helfer der Content-Routes (books/chapters/pages/assets):
// User-/Client-Labels, ACL-Guards (Page/Chapter → Buch), Fehler-Mapping,
// Body-Parser + Validierungs-Konstanten.

const express = require('express');
const logger = require('../../logger');
const { setContext } = require('../../lib/log-context');
const { resolvePageBookId, resolveChapterBookId } = require('../../lib/content-ownership');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const deviceTokens = require('../../db/device-tokens');

const jsonBody = express.json({ limit: '10mb' });
const NAME_MAX = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _validDeviceId(s) { return typeof s === 'string' && UUID_RE.test(s); }


// Beschreibt den anfragenden Client fuer Logs. Bei Device-Token-Auth (nativer
// Mac-Client) loest es Geraetename + Plattform aus dem Token auf, sonst "session".
function _clientLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token') return 'session';
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    if (dev) return `device "${dev.device_name}"${dev.platform ? ` ${dev.platform}` : ''}`;
  } catch { /* Lookup-Fehler nie den Bundle-Download blockieren lassen */ }
  return 'device';
}

// Echter Geraetename aus dem Device-Token (nativer Client), fuer das
// app_users_devices.label → „Zuletzt bearbeitet auf <Geraet>"-Hint. Browser
// (Session-Auth) liefern null → upsertDevice faellt auf das UA-Label zurueck.
function _deviceTokenLabel(req) {
  const u = req.session?.user;
  if (u?.via !== 'device_token' || !u.tokenId) return null;
  try {
    const dev = deviceTokens.getDeviceTokenById(u.tokenId);
    return dev?.device_name?.trim() || null;
  } catch { return null; }
}

function _guardPage(req, res, pageId, minRole) {
  const bookId = resolvePageBookId(pageId);
  if (!bookId) { res.status(404).json({ error_code: 'PAGE_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

function _guardChapter(req, res, chapterId, minRole) {
  const bookId = resolveChapterBookId(chapterId);
  if (!bookId) { res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' }); return null; }
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return bookId; }
  catch (e) { sendACLError(res, e); return null; }
}

function _fail(res, e, opName) {
  const status = e?.status || 500;
  const bodySnippet = e?.bodyText ? ' | body: ' + String(e.bodyText).slice(0, 200) : '';
  logger.warn(`${opName} fehlgeschlagen: ${e.message}${bodySnippet}`);
  res.status(status === 401 ? 502 : status).json({
    error_code: 'CONTENT_FAILED',
    status,
    detail: e.message,
  });
}

module.exports = {
  jsonBody, NAME_MAX, UUID_RE, _validDeviceId,
  _clientLabel, _deviceTokenLabel,
  _guardPage, _guardChapter, _fail,
};
