'use strict';
// Motiv-Werkstatt — Lauf-Historien der beiden KI-Jobs plus der Brainstorm-Delta-
// Cache. Die deterministische Konsistenz-Messung (lib/motif-consistency.js) hat
// bewusst KEINE Historie: sie ist eine Messung auf dem aktuellen Stand und wird
// bei jedem Board-Load frisch gerechnet.

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');
const { NOW_ISO_SQL } = require('../now');

// ── KI-Brainstorm-Lauf-Historie ─────────────────────────────────────────────
// Persistierte Motiv-Brainstorm-Läufe pro (Buch, User). Insert beim Job-Complete
// in routes/jobs/motif-brainstorm.js; List/Get/Delete via /motifs/brainstorm-runs
// Routes. Die Liste kommt ohne result_json (Spaltensparsamkeit bei vielen
// Einträgen) — vorschlag_count ist denormalisiert fürs Listen-Rendering; das
// Detail liefert die vollen Vorschläge. Buchweit, kein Sub-Scope (der Brainstorm
// schlägt neue Motive/Themen vor, hängt an keinem einzelnen Motiv).

const _stmtInsertBrainstormRun = db.prepare(`
  INSERT INTO motif_brainstorm_runs (book_id, user_email, created_at, vorschlag_count, result_json, model)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListBrainstormRuns = db.prepare(`
  SELECT id, book_id, created_at, vorschlag_count, model
    FROM motif_brainstorm_runs
   WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetBrainstormRun = db.prepare(`
  SELECT id, book_id, user_email, created_at, vorschlag_count, result_json, model
    FROM motif_brainstorm_runs
   WHERE id = ?
`);
const _stmtDeleteBrainstormRun = db.prepare('DELETE FROM motif_brainstorm_runs WHERE id = ? AND user_email = ?');

function insertBrainstormRun({ bookId, userEmail, vorschlagCount = 0, result, model = null }) {
  const info = _stmtInsertBrainstormRun.run(
    parseInt(bookId), userEmail, parseInt(vorschlagCount) || 0, JSON.stringify(result), model,
  );
  return info.lastInsertRowid;
}
function listBrainstormRuns(bookId, userEmail) {
  return _stmtListBrainstormRuns.all(parseInt(bookId), userEmail);
}
function getBrainstormRun(id) {
  const r = _stmtGetBrainstormRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    created_at: r.created_at, vorschlag_count: r.vorschlag_count,
    result, model: r.model,
  };
}
function deleteBrainstormRun(id, userEmail) {
  return _stmtDeleteBrainstormRun.run(parseInt(id), userEmail).changes;
}

// ── KI-Consistency-Lauf-Historie ────────────────────────────────────────────
// Persistierte Motiv-Consistency-Laeufe pro (Buch, User) — Spiegel der Plot-
// Variante. Insert beim Job-Complete in routes/jobs/motif-consistency.js.
// NUR die KI-Schicht wird historisiert: die deterministischen Befunde sind eine
// Messung auf dem aktuellen Stand (lib/motif-consistency.js) und werden bei jedem
// Board-Load frisch gerechnet.

const _stmtInsertConsistencyRun = db.prepare(`
  INSERT INTO motif_consistency_runs (book_id, user_email, created_at, konflikt_count, result_json, model)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListConsistencyRuns = db.prepare(`
  SELECT id, book_id, created_at, konflikt_count, model
    FROM motif_consistency_runs
   WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetConsistencyRun = db.prepare(`
  SELECT id, book_id, user_email, created_at, konflikt_count, result_json, model
    FROM motif_consistency_runs
   WHERE id = ?
`);
const _stmtDeleteConsistencyRun = db.prepare('DELETE FROM motif_consistency_runs WHERE id = ? AND user_email = ?');

function insertConsistencyRun({ bookId, userEmail, konfliktCount = 0, result, model = null }) {
  const info = _stmtInsertConsistencyRun.run(
    parseInt(bookId), userEmail, parseInt(konfliktCount) || 0, JSON.stringify(result), model,
  );
  return info.lastInsertRowid;
}
function listConsistencyRuns(bookId, userEmail) {
  return _stmtListConsistencyRuns.all(parseInt(bookId), userEmail);
}
function getConsistencyRun(id) {
  const r = _stmtGetConsistencyRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    created_at: r.created_at, konflikt_count: r.konflikt_count,
    result, model: r.model,
  };
}
function deleteConsistencyRun(id, userEmail) {
  return _stmtDeleteConsistencyRun.run(parseInt(id), userEmail).changes;
}

// ── KI-Brainstorm Delta-Cache ────────────────────────────────────────────────
// Pro Chunk (Kapitel bzw. __singlepass__) der rohe Modell-Output, keyed auf
// pages_sig (page_id:updated_at + Settings + Kapitelname + Modell/Prompt-Version).
// pages_sig ist NICHT im PK → INSERT OR REPLACE ueberschreibt die Chunk-Zeile bei
// Aenderung (keine Akkumulation). Analog chapter_extract_cache. Roher Output VOR
// seen-Dedup — die Dedup laeuft jeden Lauf frisch (siehe motif-brainstorm.js).
const _stmtLoadBrainstormCache = db.prepare(`
  SELECT result_json FROM motif_brainstorm_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND chunk_key = ? AND pages_sig = ?
`);
const _stmtSaveBrainstormCache = db.prepare(`
  INSERT OR REPLACE INTO motif_brainstorm_cache
    (book_id, user_email, provider, chunk_key, pages_sig, result_json, cached_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtDeleteBrainstormCache = db.prepare(
  'DELETE FROM motif_brainstorm_cache WHERE book_id = ? AND user_email = ?'
);

function loadBrainstormCache(bookId, userEmail, chunkKey, pagesSig, provider = '') {
  const row = _stmtLoadBrainstormCache.get(parseInt(bookId), userEmail || '', provider || '', chunkKey, pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}
function saveBrainstormCache(bookId, userEmail, chunkKey, pagesSig, result, provider = '') {
  _stmtSaveBrainstormCache.run(
    parseInt(bookId), userEmail || '', provider || '', chunkKey, pagesSig, JSON.stringify(result),
  );
}
function deleteBrainstormCache(bookId, userEmail) {
  return _stmtDeleteBrainstormCache.run(parseInt(bookId), userEmail || '').changes;
}

module.exports = {
  insertBrainstormRun, listBrainstormRuns, getBrainstormRun, deleteBrainstormRun,
  insertConsistencyRun, listConsistencyRuns, getConsistencyRun, deleteConsistencyRun,
  loadBrainstormCache, saveBrainstormCache, deleteBrainstormCache,
};
