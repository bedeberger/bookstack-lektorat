'use strict';
const express = require('express');
const { db, saveSongsToDb } = require('../db/schema');
const { toIntId, inClause } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const searchIndex = require('../lib/search');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));
const jsonBody = express.json();

// Musikbibliothek eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);

  const rows = db.prepare(`
    SELECT id, song_uid, titel, interpret, genre, kontext_typ, beschreibung,
           stimmung, erste_erwaehnung, erste_erwaehnung_page_id, updated_at
    FROM songs
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);

  if (!rows.length) return res.json(null);

  const songIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(songIds);

  const sfRows = db.prepare(`
    SELECT sf.song_id, f.fig_id, sf.kontext_typ
    FROM song_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.song_id IN ${idSql}
  `).all(...idVals);
  const figMap = {};
  for (const sf of sfRows) (figMap[sf.song_id] ??= []).push({ fig_id: sf.fig_id, kontext_typ: sf.kontext_typ });

  const scRows = db.prepare(`
    SELECT sc.song_id, sc.chapter_id, c.chapter_name, sc.haeufigkeit
    FROM song_chapters sc
    LEFT JOIN chapters c ON c.chapter_id = sc.chapter_id
    WHERE sc.song_id IN ${idSql}
    ORDER BY sc.haeufigkeit DESC
  `).all(...idVals);
  const kapMap = {};
  for (const sc of scRows) (kapMap[sc.song_id] ??= []).push({ chapter_id: sc.chapter_id, name: sc.chapter_name, haeufigkeit: sc.haeufigkeit });

  const ssRows = db.prepare(`
    SELECT song_id, scene_id FROM song_scenes WHERE song_id IN ${idSql}
  `).all(...idVals);
  const szMap = {};
  for (const ss of ssRows) (szMap[ss.song_id] ??= []).push(ss.scene_id);

  const songs = rows.map(r => ({
    id:                       r.song_uid,
    titel:                    r.titel,
    interpret:                r.interpret,
    genre:                    r.genre,
    kontext_typ:              r.kontext_typ,
    beschreibung:             r.beschreibung,
    stimmung:                 r.stimmung,
    erste_erwaehnung:         r.erste_erwaehnung,
    erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
    figuren:                  figMap[r.id] || [],
    kapitel:                  kapMap[r.id] || [],
    szenen:                   szMap[r.id] || [],
  }));

  res.json({ songs, updated_at: rows[0]?.updated_at || null });
});

// Musikbibliothek speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);
  saveSongsToDb(bookId, req.body.songs || [], userEmail);
  searchIndex.removeKindForBook('song', bookId);
  const songRows = db.prepare('SELECT id FROM songs WHERE book_id = ?').all(bookId);
  for (const r of songRows) searchIndex.upsertSong(r.id);
  res.json({ ok: true });
});

module.exports = router;
