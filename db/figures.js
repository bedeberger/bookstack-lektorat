const { db } = require('./connection');
require('./migrations');

// Gerichtete Beziehungstypen und ihre Inverse. A→B elternteil ≡ B→A kind,
// A→B mentor ≡ B→A schuetzling. Für Dedup-Zwecke als identisch betrachtet.
const RELATION_INVERSES = { elternteil: 'kind', kind: 'elternteil', mentor: 'schuetzling', schuetzling: 'mentor' };

/** Dedupliziert Relations pro ungeordnetem Paar (A,B). Erste gewinnt.
 *  Eliminiert damit auch widersprüchliche typs (z.B. elternteil + kind auf dem
 *  gleichen Paar) sowie inverse Dubletten (A elternteil B + B kind A). */
function dedupRelations(relations, validIds) {
  const seen = new Set();
  const result = [];
  for (const r of relations) {
    if (!r.from || !r.to || r.from === r.to) continue;
    if (validIds && (!validIds.has(r.from) || !validIds.has(r.to))) continue;
    const [a, b] = r.from < r.to ? [r.from, r.to] : [r.to, r.from];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

function saveFigurenToDb(bookId, figuren, userEmail, idMaps) {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (userEmail) {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
    } else {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email IS NULL').run(bookId);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS NULL').run(bookId);
    }

    const insFig = db.prepare(`
      INSERT INTO figures
        (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung, sozialschicht,
         praesenz, rolle, motivation, konflikt, entwicklung, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate,
         sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insApp = db.prepare('INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, chapter_name, haeufigkeit) VALUES (?, ?, ?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    const validIds = new Set(figuren.map(f => f.id));
    const allRelations = [];

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const zitate = Array.isArray(f.schluesselzitate) && f.schluesselzitate.length
        ? JSON.stringify(f.schluesselzitate.filter(Boolean).slice(0, 3))
        : null;
      const erstPageId = idMaps?.pageNameToId?.[f.erste_erwaehnung] ?? null;
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.beschreibung || null, f.sozialschicht || null,
        f.praesenz || null, f.rolle || null, f.motivation || null, f.konflikt || null,
        f.entwicklung || null, f.erste_erwaehnung || null, erstPageId, zitate,
        i, userEmail || null, now
      );
      for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
      for (const app of (f.kapitel || [])) {
        const chapId = idMaps?.chNameToId?.[app.name] ?? null;
        if (chapId != null) insApp.run(fid, chapId, app.name, app.haeufigkeit || 1);
      }
      for (const bz of (f.beziehungen || [])) {
        const belegeArr = Array.isArray(bz.belege)
          ? bz.belege.filter(b => b && (b.kapitel || b.seite)).slice(0, 5)
          : [];
        allRelations.push({
          from: f.id, to: bz.figur_id, typ: bz.typ,
          beschreibung: bz.beschreibung || null,
          machtverhaltnis: bz.machtverhaltnis ?? null,
          belege: belegeArr.length ? JSON.stringify(belegeArr) : null,
        });
      }
    }
    for (const r of dedupRelations(allRelations, validIds)) {
      insRel.run(bookId, r.from, r.to, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, userEmail || null);
    }
  })();
}

// Ersetzt alle Lebensereignisse für ein Buch/User anhand von fig_id-basierten Assignments.
// assignments: [{ fig_id: "fig_1", lebensereignisse: [...] }]
function updateFigurenEvents(bookId, assignments, userEmail, idMaps) {
  db.transaction(() => {
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?'
    ).all(bookId, userEmail || null);
    if (!figRows.length) return;

    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const delEvt = db.prepare('DELETE FROM figure_events WHERE figure_id = ?');
    for (const row of figRows) delEvt.run(row.id);

    const insEvt = db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, bedeutung, typ, kapitel, seite, chapter_id, page_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const assignment of assignments) {
      const rowId = figIdToRowId[assignment.fig_id];
      if (!rowId) continue;
      for (let j = 0; j < (assignment.lebensereignisse || []).length; j++) {
        const ev = assignment.lebensereignisse[j];
        insEvt.run(rowId, ev.datum || '', ev.ereignis || '', ev.bedeutung || null, ev.typ || 'persoenlich', ev.kapitel || null, ev.seite || null, idMaps?.chNameToId?.[ev.kapitel] ?? null, idMaps?.pageNameToId?.[ev.seite] ?? null, j);
      }
    }
  })();
}

// Sozialschicht + Machtverhältnis für bestehende Figuren/Beziehungen nachträglich setzen.
// figurenSoziogramm: [{ fig_id, sozialschicht }]
// beziehungenMacht:  [{ from_fig_id, to_fig_id, machtverhaltnis }]
function updateFigurenSoziogramm(bookId, figurenSoziogramm, beziehungenMacht, userEmail) {
  db.transaction(() => {
    const updFig = db.prepare(
      'UPDATE figures SET sozialschicht = ? WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    );
    for (const f of (figurenSoziogramm || [])) {
      updFig.run(f.sozialschicht || null, bookId, f.fig_id, userEmail || null);
    }
    const updRel = db.prepare(
      'UPDATE figure_relations SET machtverhaltnis = ? WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ? AND user_email IS ?'
    );
    for (const bz of (beziehungenMacht || [])) {
      updRel.run(bz.machtverhaltnis ?? null, bookId, bz.from_fig_id, bz.to_fig_id, userEmail || null);
    }
  })();
}

/** Fügt kapitelübergreifende Beziehungen zur figure_relations-Tabelle hinzu,
 *  ohne bestehende zu löschen. Strenge Dedup: pro ungeordnetem Paar (A,B)
 *  höchstens EINE Beziehung – wenn zwischen bz.von und bz.zu schon irgendeine
 *  Relation existiert, wird die neue verworfen. Zusätzlich: beide fig_ids
 *  müssen in figures existieren. */
function addFigurenBeziehungen(bookId, beziehungen, userEmail) {
  const pairExists = db.prepare(
    'SELECT COUNT(*) as cnt FROM figure_relations WHERE book_id = ? AND ((from_fig_id = ? AND to_fig_id = ?) OR (from_fig_id = ? AND to_fig_id = ?)) AND user_email IS ?'
  );
  const figExists = db.prepare(
    'SELECT COUNT(*) as cnt FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
  );
  const ins = db.prepare(
    'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    const seenInBatch = new Set();
    for (const bz of beziehungen) {
      if (!bz.von || !bz.zu || !bz.typ || bz.von === bz.zu) continue;
      const em = userEmail || null;
      const [a, b] = bz.von < bz.zu ? [bz.von, bz.zu] : [bz.zu, bz.von];
      const key = `${a}|${b}`;
      if (seenInBatch.has(key)) continue;
      if (pairExists.get(bookId, bz.von, bz.zu, bz.zu, bz.von, em)?.cnt > 0) continue;
      if (figExists.get(bookId, bz.von, em)?.cnt === 0) continue;
      if (figExists.get(bookId, bz.zu, em)?.cnt === 0) continue;
      const belegeArr = Array.isArray(bz.belege)
        ? bz.belege.filter(x => x && (x.kapitel || x.seite)).slice(0, 5)
        : [];
      const belege = belegeArr.length ? JSON.stringify(belegeArr) : null;
      ins.run(bookId, bz.von, bz.zu, bz.typ, bz.beschreibung || null, bz.machtverhaltnis ?? null, belege, em);
      seenInBatch.add(key);
    }
  })();
}

/** Post-Hoc-Cleanup für bereits gespeicherte Figuren-Daten eines Buchs/Users.
 *  1. Namens-Duplikate zusammenführen (case-insensitive, normalisiert).
 *     Referenzen (figure_tags, figure_appearances, figure_events, figure_relations,
 *     scene_figures, location_figures) werden auf die kanonische ID umgelenkt,
 *     das Duplikat-Figurenrecord gelöscht.
 *  2. figure_relations dedupliziert (pro ungeordnetem Paar max 1), Relations mit
 *     nicht-existierenden fig_ids oder Selbst-Referenz entfernt.
 *  3. Beziehungs-Beschreibungen geleert, die den Namen der Zielfigur nicht enthalten
 *     (häufiger Verrutscher bei Lokal-KI). */
function cleanupDuplicateFiguren(bookId, userEmail) {
  const em = userEmail || null;
  const stats = { figurenMerged: 0, relationsRemoved: 0, descriptionsCleared: 0 };
  const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

  db.transaction(() => {
    const figs = db.prepare(
      'SELECT id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung, sozialschicht FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order, id'
    ).all(bookId, em);

    const groups = new Map();
    for (const f of figs) {
      const key = normalize(f.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }

    const updFig = db.prepare(
      'UPDATE figures SET kurzname=?, typ=?, geburtstag=?, geschlecht=?, beruf=?, sozialschicht=?, beschreibung=? WHERE id=?'
    );
    const moveTags = db.prepare(
      'INSERT OR IGNORE INTO figure_tags (figure_id, tag) SELECT ?, tag FROM figure_tags WHERE figure_id = ?'
    );
    const delTags = db.prepare('DELETE FROM figure_tags WHERE figure_id = ?');
    const getDupApps = db.prepare(
      'SELECT chapter_id, chapter_name, haeufigkeit FROM figure_appearances WHERE figure_id = ?'
    );
    const upsertApp = db.prepare(`
      INSERT INTO figure_appearances (figure_id, chapter_id, chapter_name, haeufigkeit) VALUES (?, ?, ?, ?)
      ON CONFLICT(figure_id, chapter_id) DO UPDATE SET haeufigkeit = haeufigkeit + excluded.haeufigkeit
    `);
    const delApps = db.prepare('DELETE FROM figure_appearances WHERE figure_id = ?');
    const moveEvents = db.prepare('UPDATE figure_events SET figure_id = ? WHERE figure_id = ?');
    const remapRelFrom = db.prepare(
      'UPDATE figure_relations SET from_fig_id = ? WHERE book_id = ? AND user_email IS ? AND from_fig_id = ?'
    );
    const remapRelTo = db.prepare(
      'UPDATE figure_relations SET to_fig_id = ? WHERE book_id = ? AND user_email IS ? AND to_fig_id = ?'
    );
    const moveSceneFigs = db.prepare(`
      INSERT OR IGNORE INTO scene_figures (scene_id, fig_id)
      SELECT scene_id, ? FROM scene_figures sf WHERE sf.fig_id = ?
        AND sf.scene_id IN (SELECT id FROM figure_scenes WHERE book_id = ? AND user_email = ?)
    `);
    const delSceneFigs = db.prepare(
      'DELETE FROM scene_figures WHERE fig_id = ? AND scene_id IN (SELECT id FROM figure_scenes WHERE book_id = ? AND user_email = ?)'
    );
    const moveLocFigs = db.prepare(`
      INSERT OR IGNORE INTO location_figures (location_id, fig_id)
      SELECT location_id, ? FROM location_figures lf WHERE lf.fig_id = ?
        AND lf.location_id IN (SELECT id FROM locations WHERE book_id = ? AND user_email IS ?)
    `);
    const delLocFigs = db.prepare(
      'DELETE FROM location_figures WHERE fig_id = ? AND location_id IN (SELECT id FROM locations WHERE book_id = ? AND user_email IS ?)'
    );
    const delFig = db.prepare('DELETE FROM figures WHERE id = ?');

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
      const canon = { ...group[0] };
      for (const other of group.slice(1)) {
        for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'sozialschicht']) {
          if (!canon[field] && other[field]) canon[field] = other[field];
        }
      }
      updFig.run(canon.kurzname, canon.typ, canon.geburtstag, canon.geschlecht, canon.beruf, canon.sozialschicht, canon.beschreibung, canon.id);

      for (const dup of group.slice(1)) {
        moveTags.run(canon.id, dup.id);
        delTags.run(dup.id);
        for (const a of getDupApps.all(dup.id)) {
          upsertApp.run(canon.id, a.chapter_id, a.chapter_name, a.haeufigkeit);
        }
        delApps.run(dup.id);
        moveEvents.run(canon.id, dup.id);
        remapRelFrom.run(canon.fig_id, bookId, em, dup.fig_id);
        remapRelTo.run(canon.fig_id, bookId, em, dup.fig_id);
        moveSceneFigs.run(canon.fig_id, dup.fig_id, bookId, em || '');
        delSceneFigs.run(dup.fig_id, bookId, em || '');
        moveLocFigs.run(canon.fig_id, dup.fig_id, bookId, em);
        delLocFigs.run(dup.fig_id, bookId, em);
        delFig.run(dup.id);
        stats.figurenMerged++;
      }
    }

    const rels = db.prepare(
      'SELECT rowid, from_fig_id, to_fig_id FROM figure_relations WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const existingFigIds = new Set(
      db.prepare('SELECT fig_id FROM figures WHERE book_id = ? AND user_email IS ?').all(bookId, em).map(r => r.fig_id)
    );
    const seenPair = new Set();
    const toDelete = [];
    for (const r of rels) {
      if (r.from_fig_id === r.to_fig_id) { toDelete.push(r.rowid); continue; }
      if (!existingFigIds.has(r.from_fig_id) || !existingFigIds.has(r.to_fig_id)) { toDelete.push(r.rowid); continue; }
      const [a, b] = r.from_fig_id < r.to_fig_id ? [r.from_fig_id, r.to_fig_id] : [r.to_fig_id, r.from_fig_id];
      const key = `${a}|${b}`;
      if (seenPair.has(key)) toDelete.push(r.rowid);
      else seenPair.add(key);
    }
    if (toDelete.length) {
      const delRel = db.prepare('DELETE FROM figure_relations WHERE rowid = ?');
      for (const rid of toDelete) delRel.run(rid);
    }
    stats.relationsRemoved = toDelete.length;

    const figByIdForRescue = db.prepare(
      'SELECT fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const figLookup = figByIdForRescue.map(f => ({
      fig_id: f.fig_id,
      names: [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase()),
    }));

    const relsWithNames = db.prepare(`
      SELECT r.rowid, r.from_fig_id, r.to_fig_id, r.typ, r.machtverhaltnis, r.beschreibung,
             f2.name AS to_name, f2.kurzname AS to_kurz
      FROM figure_relations r
      LEFT JOIN figures f2 ON f2.fig_id = r.to_fig_id AND f2.book_id = r.book_id AND f2.user_email IS ?
      WHERE r.book_id = ? AND r.user_email IS ? AND r.beschreibung IS NOT NULL AND r.beschreibung != ''
    `).all(em, bookId, em);
    const clearDesc = db.prepare('UPDATE figure_relations SET beschreibung = NULL WHERE rowid = ?');
    const getRel = db.prepare(
      'SELECT rowid, beschreibung FROM figure_relations WHERE book_id = ? AND user_email IS ? AND from_fig_id = ? AND to_fig_id = ?'
    );
    const setDesc = db.prepare('UPDATE figure_relations SET beschreibung = ? WHERE rowid = ?');
    const insRel = db.prepare(
      'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    stats.descriptionsMoved = 0;
    for (const r of relsWithNames) {
      const targets = [r.to_name, r.to_kurz].filter(Boolean).map(s => s.toLowerCase());
      if (!targets.length) continue;
      const text = r.beschreibung.toLowerCase();
      if (targets.some(n => text.includes(n))) continue;

      const candidates = figLookup.filter(c =>
        c.fig_id !== r.from_fig_id && c.fig_id !== r.to_fig_id && c.names.some(n => text.includes(n))
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        const existing = getRel.get(bookId, em, r.from_fig_id, target.fig_id);
        if (existing && !existing.beschreibung) {
          setDesc.run(r.beschreibung, existing.rowid);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
        if (!existing) {
          insRel.run(bookId, r.from_fig_id, target.fig_id, r.typ, r.beschreibung, r.machtverhaltnis ?? null, em);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
      }
      clearDesc.run(r.rowid);
      stats.descriptionsCleared++;
    }
  })();

  return stats;
}

/** Figuren eines Kapitels laden (via figure_appearances).
 *  Fallback: alle Buchfiguren, wenn keine Kapitelzuordnung existiert.
 *  Gibt kompakte Objekte zurück: { name, kurzname, geschlecht, beruf, beschreibung, typ } */
function getChapterFigures(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const cols = 'f.name, f.kurzname, f.geschlecht, f.beruf, f.beschreibung, f.typ';
  if (chapterId) {
    const rows = db.prepare(`
      SELECT ${cols} FROM figures f
      JOIN figure_appearances fa ON fa.figure_id = f.id
      WHERE f.book_id = ? AND fa.chapter_id = ? AND f.user_email IS ?
      ORDER BY fa.haeufigkeit DESC, f.sort_order, f.id
    `).all(bookId, chapterId, userEmail || null);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ${cols} FROM figures f
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY f.sort_order, f.id
  `).all(bookId, userEmail || null);
}

/** Beziehungen zwischen Figuren, die im gegebenen Kapitel gemeinsam auftreten.
 *  Liefert: [{ von, zu, typ, beschreibung }] mit Namen (nicht fig_ids).
 *  Ohne chapterId: alle Beziehungen des Buchs. */
function getChapterFigureRelations(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const em = userEmail || null;
  let rows;
  if (chapterId) {
    rows = db.prepare(`
      SELECT ff.name AS von, ft.name AS zu, r.typ, r.beschreibung
      FROM figure_relations r
      JOIN figures ff ON ff.book_id = r.book_id AND ff.fig_id = r.from_fig_id AND ff.user_email IS ?
      JOIN figures ft ON ft.book_id = r.book_id AND ft.fig_id = r.to_fig_id   AND ft.user_email IS ?
      WHERE r.book_id = ? AND r.user_email IS ?
        AND EXISTS (SELECT 1 FROM figure_appearances fa WHERE fa.figure_id = ff.id AND fa.chapter_id = ?)
        AND EXISTS (SELECT 1 FROM figure_appearances fa WHERE fa.figure_id = ft.id AND fa.chapter_id = ?)
      ORDER BY ff.sort_order, ft.sort_order
    `).all(em, em, bookId, em, chapterId, chapterId);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ff.name AS von, ft.name AS zu, r.typ, r.beschreibung
    FROM figure_relations r
    JOIN figures ff ON ff.book_id = r.book_id AND ff.fig_id = r.from_fig_id AND ff.user_email IS ?
    JOIN figures ft ON ft.book_id = r.book_id AND ft.fig_id = r.to_fig_id   AND ft.user_email IS ?
    WHERE r.book_id = ? AND r.user_email IS ?
    ORDER BY ff.sort_order, ft.sort_order
  `).all(em, em, bookId, em);
}

module.exports = {
  RELATION_INVERSES,
  dedupRelations,
  saveFigurenToDb,
  updateFigurenEvents,
  updateFigurenSoziogramm,
  addFigurenBeziehungen,
  cleanupDuplicateFiguren,
  getChapterFigures,
  getChapterFigureRelations,
};
