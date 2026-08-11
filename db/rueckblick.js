'use strict';
// Tagebuch-Rueckblicke: Endergebnis-Cache (`rueckblick_cache`) plus die
// dauerhafte Historie (`tagebuch_rueckblicke`, analog book_reviews). Beide hier
// zusammen, weil der Cache nur diesen einen Konsumenten hat.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

// ── Endergebnis-Cache: Tagebuch-Rückblick (rueckblick.js) ─────────────────────
// Single-Row pro (Buch, User, Zeitraum, Provider). pages_sig macht den Cache
// selbst-invalidierend bei Eintrags-Änderung im Zeitraum. provider im PK gegen
// Cross-Provider-Bleeding. Kein Monats-Delta (bewusst: Endergebnis pro zeitraum).
const _loadRueckblickCache = db.prepare(
  `SELECT result_json FROM tagebuch_rueckblick_cache
   WHERE book_id = ? AND user_email = ? AND zeitraum = ? AND provider = ? AND pages_sig = ?`
);
const _saveRueckblickCache = db.prepare(
  `INSERT OR REPLACE INTO tagebuch_rueckblick_cache
   (book_id, user_email, zeitraum, provider, pages_sig, result_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _deleteRueckblickCache = db.prepare(
  `DELETE FROM tagebuch_rueckblick_cache WHERE book_id = ? AND user_email = ?`
);

function loadRueckblickCache(bookId, userEmail, zeitraum, pagesSig, provider = '') {
  const row = _loadRueckblickCache.get(parseInt(bookId), userEmail || '', zeitraum, provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveRueckblickCache(bookId, userEmail, zeitraum, pagesSig, result, provider = '') {
  _saveRueckblickCache.run(
    parseInt(bookId), userEmail || '', zeitraum, provider || '',
    pagesSig, JSON.stringify(result),
  );
}

function deleteRueckblickCache(bookId, userEmail) {
  return _deleteRueckblickCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── History: Tagebuch-Rückblicke (dauerhaft, analog book_reviews) ─────────────
// Eine Zeile pro „Erstellen"-Lauf — re-öffenbar im Karten-History-Block.
const _insertRueckblick = db.prepare(
  `INSERT INTO tagebuch_rueckblicke (book_id, user_email, zeitraum, result_json, model, entry_count, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _listRueckblicke = db.prepare(
  `SELECT id, zeitraum, result_json, model, entry_count, created_at
   FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC LIMIT ?`
);
const _latestRueckblickJson = db.prepare(
  `SELECT result_json FROM tagebuch_rueckblicke
   WHERE book_id = ? AND user_email = ? AND zeitraum = ?
   ORDER BY created_at DESC, id DESC LIMIT 1`
);
// Aktualisiert den entry_count-Snapshot der jüngsten Zeile eines Zeitraums, ohne
// eine neue History-Zeile zu erzeugen (identisches Ergebnis nach Lösch-Vorgang).
const _touchRueckblickEntryCount = db.prepare(
  `UPDATE tagebuch_rueckblicke SET entry_count = ?
   WHERE id = (SELECT id FROM tagebuch_rueckblicke
               WHERE book_id = ? AND user_email = ? AND zeitraum = ?
               ORDER BY created_at DESC, id DESC LIMIT 1)`
);
const _deleteRueckblick = db.prepare(
  `DELETE FROM tagebuch_rueckblicke WHERE id = ? AND user_email = ?`
);

function insertRueckblick(bookId, userEmail, zeitraum, result, model = null, entryCount = null) {
  return _insertRueckblick.run(
    parseInt(bookId), userEmail || '', zeitraum,
    JSON.stringify(result), model || null,
    entryCount == null ? null : parseInt(entryCount),
  ).lastInsertRowid;
}

function touchRueckblickEntryCount(bookId, userEmail, zeitraum, entryCount) {
  return _touchRueckblickEntryCount.run(
    entryCount == null ? null : parseInt(entryCount),
    parseInt(bookId), userEmail || '', zeitraum,
  ).changes;
}

// Roher result_json-String des jüngsten History-Eintrags eines Zeitraums (oder
// null). Dient dem Dedup: identische Re-Runs / Cache-HITs erzeugen keine neue
// Zeile, nur inhaltlich abweichende Läufe werden festgehalten.
function latestRueckblickJson(bookId, userEmail, zeitraum) {
  const row = _latestRueckblickJson.get(parseInt(bookId), userEmail || '', zeitraum);
  return row ? row.result_json : null;
}

function listRueckblicke(bookId, userEmail, limit = 20) {
  return _listRueckblicke.all(parseInt(bookId), userEmail || '', limit)
    .map(r => ({ ...r, result_json: JSON.parse(r.result_json || 'null') }));
}

function deleteRueckblick(id, userEmail) {
  return _deleteRueckblick.run(parseInt(id), userEmail || '').changes;
}

module.exports = {
  loadRueckblickCache,
  saveRueckblickCache,
  deleteRueckblickCache,
  insertRueckblick,
  touchRueckblickEntryCount,
  latestRueckblickJson,
  listRueckblicke,
  deleteRueckblick,
};
