'use strict';
// Musik (Songs, Buch-Soundtrack). Parallel zu saveOrteToDb: UPSERT by
// song_uid; FK-CASCADE raeumt song_figures / song_chapters / song_scenes bei
// Song-DELETE.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');

// Parallel zu saveOrteToDb. UPSERT by song_uid; FK-CASCADE räumt
// song_figures / song_chapters / song_scenes bei Song-DELETE.
function saveSongsToDb(bookId, songs, userEmail, chNameToId = null, pageNameToIdByChapter = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  if (pageNameToIdByChapter == null) {
    const rows = db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId);
    pageNameToIdByChapter = {};
    for (const r of rows) {
      const k = r.chapter_id ?? 0;
      (pageNameToIdByChapter[k] ??= {})[r.page_name] = r.page_id;
    }
  }
  const resolveErstePageIdForSong = (ersteErwaehnung, kapitel) => {
    if (!ersteErwaehnung) return null;
    for (const k of (kapitel || [])) {
      const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
      const chapId = chName ? chNameToId?.[chName] : null;
      if (chapId != null) {
        const pid = pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
        if (pid) return pid;
      }
    }
    const cand = [];
    for (const m of Object.values(pageNameToIdByChapter)) {
      if (m[ersteErwaehnung]) cand.push(m[ersteErwaehnung]);
    }
    return cand.length === 1 ? cand[0] : null;
  };
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, song_uid FROM songs WHERE book_id = ? AND ${emailCond}`
    ).all(bookId, ...emailVal);
    const existingMap = Object.fromEntries(existing.map(r => [r.song_uid, r.id]));

    const newUids = new Set(songs.map(s => s.id));
    for (const { id, song_uid } of existing) {
      if (!newUids.has(song_uid)) {
        db.prepare('DELETE FROM songs WHERE id = ?').run(id);
      }
    }

    const upd = db.prepare(`
      UPDATE songs SET titel=?, interpret=?, genre=?, beschreibung=?, stimmung=?,
        kontext_typ=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?,
        sort_order=?, updated_at=${NOW_ISO_SQL}
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO songs (book_id, song_uid, titel, interpret, genre, beschreibung, stimmung,
        kontext_typ, erste_erwaehnung, erste_erwaehnung_page_id, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const delSf = db.prepare('DELETE FROM song_figures WHERE song_id = ?');
    const delSc = db.prepare('DELETE FROM song_chapters WHERE song_id = ?');
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, userEmail || null);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO song_figures (song_id, figure_id, kontext_typ) VALUES (?, ?, ?)');
    const insSc = db.prepare('INSERT INTO song_chapters (song_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');

    for (let i = 0; i < songs.length; i++) {
      const s = songs[i];
      const erstPageId = resolveErstePageIdForSong(s.erste_erwaehnung, s.kapitel);
      let songDbId = existingMap[s.id];
      if (songDbId !== undefined) {
        upd.run(s.titel || s.title || '', s.interpret || null, s.genre || null,
          s.beschreibung || null, s.stimmung || null, s.kontext_typ || null,
          s.erste_erwaehnung || null, erstPageId, i, songDbId);
        delSf.run(songDbId);
        delSc.run(songDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, s.id, s.titel || s.title || '', s.interpret || null, s.genre || null,
          s.beschreibung || null, s.stimmung || null, s.kontext_typ || null,
          s.erste_erwaehnung || null, erstPageId, i, userEmail || null
        );
        songDbId = lastInsertRowid;
      }
      for (const f of (s.figuren || [])) {
        // figuren: entweder String (fig_id) oder Objekt { fig_id, kontext_typ }
        const ref = _toRefString(typeof f === 'object' && f ? (f.fig_id ?? f.id) : f);
        const rowId = ref ? figIdToRowId[ref] : null;
        const fKtx = (typeof f === 'object' && f && f.kontext_typ) ? f.kontext_typ : null;
        if (rowId != null) insSf.run(songDbId, rowId, fKtx);
      }
      for (const k of (s.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insSc.run(songDbId, chapId, haeufigkeit);
      }
    }
  })();
}

module.exports = {
  saveSongsToDb,
};
