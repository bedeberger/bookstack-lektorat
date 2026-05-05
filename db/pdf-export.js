'use strict';
// CRUD für pdf_export_profile (multiple Profile pro Buch+User).
// Cover-Bild als BLOB direkt im Profil. JSON-Config-Field als String persistiert.
//
// book_id = 0 ist reserviert für „User-Default-Profile" (buchunabhängige Vorlagen).
// Pro (book_id, user_email) max. ein Profil mit is_default=1 — wird in
// `setDefault` exklusiv gesetzt.

const { db } = require('./connection');

const _stmtList = db.prepare(
  `SELECT id, book_id, user_email, name, config_json, is_default,
          (cover_image IS NOT NULL) AS has_cover, cover_mime,
          created_at, updated_at
     FROM pdf_export_profile
    WHERE book_id = ? AND user_email = ?
    ORDER BY is_default DESC, name COLLATE NOCASE ASC`
);
const _stmtGet = db.prepare(
  `SELECT id, book_id, user_email, name, config_json, is_default,
          (cover_image IS NOT NULL) AS has_cover, cover_mime,
          created_at, updated_at
     FROM pdf_export_profile
    WHERE id = ?`
);
const _stmtGetCover = db.prepare(
  `SELECT cover_image AS image, cover_mime AS mime FROM pdf_export_profile WHERE id = ?`
);
const _stmtInsert = db.prepare(
  `INSERT INTO pdf_export_profile (book_id, user_email, name, config_json, is_default, created_at, updated_at)
   VALUES (?, ?, ?, ?, 0, ?, ?)`
);
const _stmtUpdate = db.prepare(
  `UPDATE pdf_export_profile SET name = ?, config_json = ?, updated_at = ? WHERE id = ?`
);
const _stmtDelete = db.prepare(`DELETE FROM pdf_export_profile WHERE id = ?`);
const _stmtSetCover = db.prepare(
  `UPDATE pdf_export_profile SET cover_image = ?, cover_mime = ?, updated_at = ? WHERE id = ?`
);
const _stmtClearCover = db.prepare(
  `UPDATE pdf_export_profile SET cover_image = NULL, cover_mime = NULL, updated_at = ? WHERE id = ?`
);
const _stmtClearDefaultsForScope = db.prepare(
  `UPDATE pdf_export_profile SET is_default = 0 WHERE book_id = ? AND user_email = ?`
);
const _stmtSetDefaultForId = db.prepare(
  `UPDATE pdf_export_profile SET is_default = 1, updated_at = ? WHERE id = ?`
);

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    book_id: r.book_id,
    user_email: r.user_email,
    name: r.name,
    config: JSON.parse(r.config_json),
    is_default: !!r.is_default,
    has_cover: !!r.has_cover,
    cover_mime: r.cover_mime || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listProfiles(bookId, userEmail) {
  return _stmtList.all(parseInt(bookId), userEmail).map(_row);
}

function getProfile(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function createProfile(bookId, userEmail, name, config) {
  const now = Date.now();
  const info = _stmtInsert.run(parseInt(bookId), userEmail, name, JSON.stringify(config), now, now);
  return getProfile(info.lastInsertRowid);
}

function updateProfile(id, name, config) {
  _stmtUpdate.run(name, JSON.stringify(config), Date.now(), parseInt(id));
  return getProfile(id);
}

function deleteProfile(id) {
  _stmtDelete.run(parseInt(id));
}

function setCover(id, buffer, mime) {
  _stmtSetCover.run(buffer, mime, Date.now(), parseInt(id));
}

function clearCover(id) {
  _stmtClearCover.run(Date.now(), parseInt(id));
}

function getCover(id) {
  const r = _stmtGetCover.get(parseInt(id));
  if (!r || !r.image) return null;
  return { image: r.image, mime: r.mime };
}

const _setDefaultTx = db.transaction((bookId, userEmail, id) => {
  _stmtClearDefaultsForScope.run(parseInt(bookId), userEmail);
  _stmtSetDefaultForId.run(Date.now(), parseInt(id));
});

function setDefault(bookId, userEmail, id) {
  _setDefaultTx(bookId, userEmail, id);
  return getProfile(id);
}

module.exports = {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  setCover, clearCover, getCover, setDefault,
};
