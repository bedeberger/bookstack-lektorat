'use strict';
const express = require('express');
const { db, saveOrteToDb, patchOrtCoords } = require('../db/schema');
const { mergeLocations } = require('../db/entity-merge');
const logger = require('../logger');
const { toIntId, inClause } = require('../lib/validate');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const searchIndex = require('../lib/search');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));
router.param('book_id', bookParamHandler);
const jsonBody = express.json();

// Schauplätze eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id, stimmung,
           land, lat, lng, geo_query, geo_land, stale, updated_at
    FROM locations
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);

  if (!rows.length) return res.json(null);

  const locIds = rows.map(r => r.id);
  const { sql: locSql, values: locVals } = inClause(locIds);

  const lfRows = db.prepare(`
    SELECT lf.location_id, f.fig_id
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id
    WHERE lf.location_id IN ${locSql}
  `).all(...locVals);
  const figMap = {};
  for (const lf of lfRows) (figMap[lf.location_id] ??= []).push(lf.fig_id);

  const lcRows = db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${locSql}
    ORDER BY lc.haeufigkeit DESC
  `).all(...locVals);
  const kapMap = {};
  for (const lc of lcRows) (kapMap[lc.location_id] ??= []).push({ chapter_id: lc.chapter_id, name: lc.chapter_name, haeufigkeit: lc.haeufigkeit });

  // Fallback-Kapitel: hat ein Ort keine expliziten location_chapters, aber eine
  // Erste-Erwähnung-Seite, leiten wir das Kapitel aus deren chapter_id ab –
  // dieselbe Quelle, die location_chapters bei Szenen-/Seitenbezug ohnehin nutzt.
  const derivePageIds = [...new Set(
    rows.filter(r => !kapMap[r.id] && r.erste_erwaehnung_page_id)
        .map(r => r.erste_erwaehnung_page_id)
  )];
  const pageChapterMap = {};
  if (derivePageIds.length) {
    const { sql: pgSql, values: pgVals } = inClause(derivePageIds);
    const pcRows = db.prepare(`
      SELECT p.page_id, p.chapter_id, c.chapter_name
      FROM pages p
      JOIN chapters c ON c.chapter_id = p.chapter_id
      WHERE p.page_id IN ${pgSql}
    `).all(...pgVals);
    for (const pc of pcRows) pageChapterMap[pc.page_id] = { chapter_id: pc.chapter_id, name: pc.chapter_name, haeufigkeit: 1, derived: true };
  }

  const orte = rows.map(r => ({
    id:                       r.loc_id,
    stale:                    !!r.stale,
    name:                     r.name,
    typ:                      r.typ,
    beschreibung:             r.beschreibung,
    erste_erwaehnung:         r.erste_erwaehnung,
    erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
    stimmung:                 r.stimmung,
    land:                     r.land || null,
    lat:                      r.lat != null ? r.lat : null,
    lng:                      r.lng != null ? r.lng : null,
    geo_query:                r.geo_query || null,
    geo_land:                 r.geo_land || null,
    figuren:                  figMap[r.id] || [],
    kapitel:                  kapMap[r.id] || (pageChapterMap[r.erste_erwaehnung_page_id] ? [pageChapterMap[r.erste_erwaehnung_page_id]] : []),
  }));

  res.json({ orte, updated_at: rows[0]?.updated_at || null });
});

// Schauplätze eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  saveOrteToDb(bookId, req.body.orte || [], userEmail);
  // FTS-Index nachziehen — saveOrteToDb ist Full-Replace pro Buch.
  searchIndex.removeKindForBook('location', bookId);
  const locRows = db.prepare('SELECT id FROM locations WHERE book_id = ?').all(bookId);
  for (const r of locRows) searchIndex.upsertLocation(r.id);
  res.json({ ok: true });
});

// Nur Koordinaten einzelner Schauplätze patchen (Marker-Drag, Undo/Redo,
// Georeferenz löschen). Kein Full-Replace → kollidiert nicht mit nebenläufigen
// Edits und berührt FTS nicht (Index hängt an Name/Typ/Beschreibung, nicht an
// lat/lng). Body: { patches: [{ id, lat, lng }] }.
router.patch('/:book_id/coords', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const patches = Array.isArray(req.body.patches) ? req.body.patches : [];
  const updated = patchOrtCoords(bookId, patches, userEmail);
  res.json({ ok: true, updated });
});

// Zwei Schauplätze zusammenführen: Referenzen der Quelle wandern aufs Ziel, die
// Quelle wird gelöscht (Merge-Kern db/entity-merge.js). Pendant zum Figuren-Merge,
// gleiche Begründung: beim blossen Löschen eines verwaisten Orts gingen seine
// Verknüpfungen (scene_locations, Recherche-Links, Kapitel-Vorkommen) verloren.
// `source`/`target` sind `locations.loc_id` (TEXT), wie beim Einzel-Delete.
// Muss VOR '/:book_id/:id' stehen — schadet als POST nicht, hält aber die
// Reihenfolge-Konvention dieser Datei.
router.post('/:book_id/merge', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const src = String(req.body?.source || '').trim();
  const tgt = String(req.body?.target || '').trim();
  if (!bookId || !src || !tgt) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (src === tgt) return res.status(409).json({ error_code: 'SAME_ENTITY' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const get = db.prepare(`SELECT id FROM locations WHERE loc_id = ? AND book_id = ? AND ${emailCond}`);
  const sRow = get.get(src, bookId, ...emailVal);
  const tRow = get.get(tgt, bookId, ...emailVal);
  if (!sRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
  if (!tRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });
  if (sRow.id === tRow.id) return res.status(409).json({ error_code: 'SAME_ENTITY' });

  const result = mergeLocations(bookId, userEmail, sRow.id, tRow.id);
  searchIndex.remove('location', sRow.id);
  searchIndex.upsertLocation(tRow.id);
  logger.info(`Schauplatz-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
  res.json({ ok: true, ...result });
});

// Bulk-Cleanup: alle STALE Schauplätze eines Buchs auf einmal löschen (Danger-Zone).
// Pendant zum Figuren/Szenen-Bulk-Delete; räumt die vom Reconcile aufgelaufenen stale=1-
// Altlasten. Nur stale wird angefasst. CASCADE räumt die Bridges mit.
// Muss VOR '/:book_id/:id' stehen, sonst matcht 'stale' als :id.
router.delete('/:book_id/stale', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const ids = db.prepare(
    `SELECT id FROM locations WHERE book_id = ? AND ${emailCond} AND stale = 1`
  ).all(bookId, ...emailVal).map(r => r.id);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM locations WHERE id = ?');
    for (const id of ids) del.run(id);
  })();
  for (const id of ids) searchIndex.remove('location', id);
  res.json({ ok: true, deleted: { locations: ids.length } });
});

// Einzelnen STALE-Schauplatz endgültig löschen (GUI-Button auf "nicht mehr im Text"-
// Zeilen). Nur stale erlaubt — aktive Orte überleben die Re-Analyse via Reconcile und
// sollen nicht per Einzel-Delete aus dem Katalog fallen. CASCADE (foreign_keys=ON) räumt
// location_figures/-chapters/scene_locations + research_item_links mit.
// `:id` ist die oeffentliche Ort-Kennung `locations.loc_id` (TEXT) — dieselbe, die GET
// als `id` ausliefert und die der Koordinaten-Patch erwartet; die INTEGER-PK verlaesst
// die Route nie. Bei stale-Orten ist sie 'orphan_<rowid>', also nie eine Zahl.
router.delete('/:book_id/:id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const locId = String(req.params.id || '').trim();
  if (!bookId || !locId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const row = db.prepare(
    `SELECT id, stale FROM locations WHERE loc_id = ? AND book_id = ? AND ${emailCond}`
  ).get(locId, bookId, ...(userEmail ? [userEmail] : []));
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!row.stale) return res.status(409).json({ error_code: 'NOT_STALE' });
  db.prepare('DELETE FROM locations WHERE id = ?').run(row.id);
  searchIndex.remove('location', row.id);
  res.json({ ok: true });
});

module.exports = router;
