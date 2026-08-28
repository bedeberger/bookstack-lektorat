'use strict';
// Motiv-Werkstatt — Katalog: Themen + Motive. Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//   themes — abstrakte Cluster (Schuld & Vergebung …), geordnet via position.
//   motifs — die zentrale Nabe; theme_id (SET NULL) ordnet sie einem Thema zu.

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');
const { NOW_ISO_SQL } = require('../now');
const { parseTerms, serializeTerms } = require('./terms');

// ── Themen ─────────────────────────────────────────────────────────────────

const _stmtListThemes = db.prepare(`
  SELECT id, book_id, user_email, name, beschreibung, farbe, position, created_at, updated_at
    FROM themes
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtGetTheme = db.prepare('SELECT * FROM themes WHERE id = ?');
const _stmtInsertTheme = db.prepare(`
  INSERT INTO themes (book_id, user_email, name, beschreibung, farbe, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateTheme = db.prepare(`
  UPDATE themes SET name = ?, beschreibung = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetThemePos = db.prepare(`
  UPDATE themes SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteTheme = db.prepare('DELETE FROM themes WHERE id = ?');
const _stmtMaxThemePos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM themes WHERE book_id = ? AND user_email = ?');

function listThemes(bookId, userEmail) {
  return _stmtListThemes.all(parseInt(bookId), userEmail);
}
function getTheme(id) {
  return _stmtGetTheme.get(parseInt(id)) || null;
}
function createTheme(bookId, userEmail, { name, beschreibung = null, farbe = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxThemePos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertTheme.run(parseInt(bookId), userEmail, name, beschreibung, farbe, pos);
  return getTheme(info.lastInsertRowid);
}
function updateTheme(id, { name, beschreibung = null, farbe = null }) {
  _stmtUpdateTheme.run(name, beschreibung, farbe, parseInt(id));
  return getTheme(id);
}
function deleteTheme(id) {
  // motifs.theme_id hängt via ON DELETE SET NULL dran — Motive bleiben (ohne Thema).
  _stmtDeleteTheme.run(parseInt(id));
}
const reorderThemes = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((tid, idx) => _stmtSetThemePos.run(idx, parseInt(tid), parseInt(bookId), userEmail));
});

// ── Motive ───────────────────────────────────────────────────────────────

const _stmtListMotifs = db.prepare(`
  SELECT id, book_id, user_email, theme_id, name, beschreibung, trigger_terms, farbe, position, created_at, updated_at
    FROM motifs
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtGetMotif = db.prepare('SELECT * FROM motifs WHERE id = ?');
const _stmtInsertMotif = db.prepare(`
  INSERT INTO motifs (book_id, user_email, theme_id, name, beschreibung, trigger_terms, farbe, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateMotif = db.prepare(`
  UPDATE motifs SET theme_id = ?, name = ?, beschreibung = ?, trigger_terms = ?, farbe = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetMotifPos = db.prepare(`
  UPDATE motifs SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteMotif = db.prepare('DELETE FROM motifs WHERE id = ?');
const _stmtMaxMotifPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM motifs WHERE book_id = ? AND user_email = ?');

// trigger_terms wird als JSON-Array persistiert. Nach aussen immer als Array.
function _hydrateMotif(row) {
  if (!row) return null;
  return { ...row, trigger_terms: parseTerms(row.trigger_terms) };
}

function listMotifs(bookId, userEmail) {
  return _stmtListMotifs.all(parseInt(bookId), userEmail).map(_hydrateMotif);
}
function getMotif(id) {
  return _hydrateMotif(_stmtGetMotif.get(parseInt(id)) || null);
}
function createMotif(bookId, userEmail, { themeId = null, name, beschreibung = null, triggerTerms = null, farbe = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxMotifPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertMotif.run(
    parseInt(bookId), userEmail,
    themeId != null ? parseInt(themeId) : null,
    name, beschreibung, serializeTerms(triggerTerms), farbe, pos,
  );
  return getMotif(info.lastInsertRowid);
}
function updateMotif(id, { themeId = null, name, beschreibung = null, triggerTerms = null, farbe = null }) {
  _stmtUpdateMotif.run(
    themeId != null ? parseInt(themeId) : null,
    name, beschreibung, serializeTerms(triggerTerms), farbe, parseInt(id),
  );
  return getMotif(id);
}
function deleteMotif(id) {
  // motif_relations / Bridges / motif_occurrences hängen via CASCADE dran.
  _stmtDeleteMotif.run(parseInt(id));
}
const reorderMotifs = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((mid, idx) => _stmtSetMotifPos.run(idx, parseInt(mid), parseInt(bookId), userEmail));
});

module.exports = {
  listThemes, getTheme, createTheme, updateTheme, deleteTheme, reorderThemes,
  listMotifs, getMotif, createMotif, updateMotif, deleteMotif, reorderMotifs,
};
