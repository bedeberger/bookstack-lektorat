// Szenen eines Buchs: GET /figures/scenes/:book_id, Merge, Stale-Cleanup, Delete.
//
// Eigenes Modul aus demselben Grund wie ./zeitstrahl.js: Szenen sind kein
// Figuren-Thema — sie leben in `figure_scenes` (+ den Bruecken `scene_figures`
// und `scene_locations`) und teilen mit `figures` nur den Router-Prefix und
// dessen ACL-Guard. Registriert ueber `register(router)` auf DEMSELBEN Router,
// damit `router.param` (ACL + Log-Kontext) greift und die Reihenfolge erhalten
// bleibt: alle `/scenes/...`-Pfade muessen VOR `/:book_id` stehen, sonst
// schluckt die Buch-Route sie — und `/scenes/:book_id/stale` vor
// `/scenes/:book_id/:id`, sonst matcht 'stale' als `:id`.
const express = require('express');
const { db } = require('../../db/schema');
const { mergeScenes } = require('../../db/entity-merge');
const { toIntId, inClause } = require('../../lib/validate');
const { sessionEmail } = require('../../lib/acl');
const searchIndex = require('../../lib/search');
const semanticChunks = require('../../db/semantic-chunks');
const logger = require('../../logger');

const jsonBody = express.json();

function register(router) {
  // Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
  router.get('/scenes/:book_id', (req, res) => {
    const bookId = toIntId(req.params.book_id);
    if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
    const userEmail = sessionEmail(req);

    const rows = db.prepare(`
      SELECT fs.id, c.chapter_name AS kapitel, p.page_name AS seite,
             fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id, fs.stale, fs.updated_at
      FROM figure_scenes fs
      LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
      LEFT JOIN pages    p ON p.page_id    = fs.page_id
      WHERE fs.book_id = ? AND fs.user_email = ?
      ORDER BY fs.sort_order
    `).all(bookId, userEmail);

    const sceneIds = rows.map(r => r.id);
    const { sql: sceneSql, values: sceneVals } = inClause(sceneIds);
    const sfRows = sceneIds.length
      ? db.prepare(`
          SELECT sf.scene_id, f.fig_id
          FROM scene_figures sf
          JOIN figures f ON f.id = sf.figure_id
          WHERE sf.scene_id IN ${sceneSql}
        `).all(...sceneVals)
      : [];
    const sfMap = {};
    for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);

    const slRows = sceneIds.length
      ? db.prepare(`SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON sl.location_id = l.id WHERE sl.scene_id IN ${sceneSql}`).all(...sceneVals)
      : [];
    const slMap = {};
    for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);

    const szenen = rows.map(s => ({
      id:         s.id,
      stale:      !!s.stale,
      kapitel:    s.kapitel,
      seite:      s.seite,
      titel:      s.titel,
      wertung:    s.wertung,
      kommentar:  s.kommentar,
      chapter_id: s.chapter_id,
      page_id:    s.page_id,
      fig_ids:    sfMap[s.id] || [],
      ort_ids:    slMap[s.id] || [],
    }));

    const updated_at = rows.length ? rows[0].updated_at : null;
    res.json({ szenen, updated_at });
  });

  // Zwei Szenen zusammenführen (Pendant zum Figuren-Merge). `source_id`/`target_id`
  // sind INTEGER `figure_scenes.id` — Szenen führen ihre PK öffentlich.
  router.post('/scenes/:book_id/merge', jsonBody, (req, res) => {
    const bookId = toIntId(req.params.book_id);
    const srcId = toIntId(req.body?.source_id);
    const tgtId = toIntId(req.body?.target_id);
    if (!bookId || !srcId || !tgtId) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (srcId === tgtId) return res.status(409).json({ error_code: 'SAME_ENTITY' });
    const userEmail = sessionEmail(req);
    const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
    const emailVal = userEmail ? [userEmail] : [];
    const get = db.prepare(`SELECT id FROM figure_scenes WHERE id = ? AND book_id = ? AND ${emailCond}`);
    if (!get.get(srcId, bookId, ...emailVal)) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
    if (!get.get(tgtId, bookId, ...emailVal)) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });

    const result = mergeScenes(bookId, userEmail, srcId, tgtId);
    searchIndex.remove('scene', srcId);
    semanticChunks.remove('scene', srcId);
    searchIndex.upsertScene(tgtId);
    logger.info(`Szenen-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
    res.json({ ok: true, ...result });
  });

  // Bulk-Cleanup: alle STALE Szenen eines Buchs auf einmal löschen (Danger-Zone). Pendant
  // zum Einzel-Delete '/scenes/:book_id/:id'. Der Reconcile markiert nicht mehr im Text
  // vorkommende Szenen als stale=1 statt sie zu löschen (FK-Refs überleben); dieser Endpunkt
  // räumt die aufgelaufenen Altlasten. Nur stale wird angefasst. CASCADE räumt die Bridges mit.
  // Muss VOR '/scenes/:book_id/:id' stehen, sonst matcht 'stale' als :id.
  router.delete('/scenes/:book_id/stale', (req, res) => {
    const bookId = toIntId(req.params.book_id);
    if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
    const userEmail = sessionEmail(req);
    const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
    const emailVal = userEmail ? [userEmail] : [];
    const ids = db.prepare(
      `SELECT id FROM figure_scenes WHERE book_id = ? AND ${emailCond} AND stale = 1`
    ).all(bookId, ...emailVal).map(r => r.id);
    db.transaction(() => {
      const del = db.prepare('DELETE FROM figure_scenes WHERE id = ?');
      for (const id of ids) del.run(id);
    })();
    for (const id of ids) { searchIndex.remove('scene', id); semanticChunks.remove('scene', id); }
    res.json({ ok: true, deleted: { scenes: ids.length } });
  });

  // Einzelne STALE-Szene endgültig löschen (GUI-Button auf "nicht mehr im Text"-Zeilen).
  // Nur stale erlaubt. CASCADE räumt scene_figures/scene_locations/song_scenes +
  // research_item_links mit.
  router.delete('/scenes/:book_id/:id', (req, res) => {
    const bookId = toIntId(req.params.book_id);
    const id = toIntId(req.params.id);
    if (!bookId || !id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const userEmail = sessionEmail(req);
    const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
    const row = db.prepare(
      `SELECT stale FROM figure_scenes WHERE id = ? AND book_id = ? AND ${emailCond}`
    ).get(id, bookId, ...(userEmail ? [userEmail] : []));
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (!row.stale) return res.status(409).json({ error_code: 'NOT_STALE' });
    db.prepare('DELETE FROM figure_scenes WHERE id = ?').run(id);
    searchIndex.remove('scene', id);
    semanticChunks.remove('scene', id);
    res.json({ ok: true });
  });
}

module.exports = { register };
