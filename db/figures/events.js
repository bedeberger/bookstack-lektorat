const { db } = require('../connection');
const { figIdMaps, _cleanRefName, enrichBelegWithIds } = require('./refs');
require('../migrations');

// Ersetzt alle Lebensereignisse für ein Buch/User anhand von fig_id-basierten Assignments.
// assignments: [{ fig_id: "fig_1", lebensereignisse: [...] }]
// Strukturierte Datumsfelder (datum_year/month/day/ende/story_tag/datum_label/subtyp)
// werden vom AI-Pass mitgeliefert; structuredDatum normalisiert sie und zieht
// parseDatum als Fallback bei. manually_edited=1 schützt vor Re-Run-Overwrite.
function updateFigurenEvents(bookId, assignments, userEmail, idMaps) {
  const { structuredDatum } = require('../event-datum');
  db.transaction(() => {
    const { rows: figRows, byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    if (!figRows.length) return;

    const delEvt = db.prepare('DELETE FROM figure_events WHERE figure_id = ? AND manually_edited = 0');
    for (const row of figRows) delEvt.run(row.id);

    const insEvt = db.prepare(`INSERT INTO figure_events
      (figure_id, datum, datum_label,
       datum_year, datum_month, datum_day,
       datum_ende_year, datum_ende_month, datum_ende_day,
       story_tag, datum_unsicher, ereignis, bedeutung, typ, subtyp, chapter_id, page_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const assignment of assignments) {
      const rowId = figIdToRowId[assignment.fig_id];
      if (!rowId) continue;
      for (let j = 0; j < (assignment.lebensereignisse || []).length; j++) {
        const ev = assignment.lebensereignisse[j];
        const evKapitel = _cleanRefName(ev.kapitel);
        const evSeite = _cleanRefName(ev.seite);
        const chId = (evKapitel && idMaps?.chNameToId?.[evKapitel]) ?? null;
        // LLM-Halluzination: seite === kapitel (Kapitelname statt Seitentitel)
        // oder chMap-Fallback «Sonstige Seiten» → seite nullen.
        const effSeite = (evSeite && evSeite !== evKapitel && evSeite !== 'Sonstige Seiten')
          ? evSeite : null;
        const pageId = effSeite
          ? (idMaps?.pageNameToIdByChapter?.[chId ?? 0]?.[effSeite] ?? null)
          : null;
        const sd = structuredDatum(ev);
        insEvt.run(
          rowId, ev.datum || sd.datum_label || '',
          sd.datum_label,
          sd.datum_year, sd.datum_month, sd.datum_day,
          sd.datum_ende_year, sd.datum_ende_month, sd.datum_ende_day,
          sd.story_tag, sd.datum_unsicher,
          ev.ereignis || '', ev.bedeutung || null,
          ev.typ || 'persoenlich', sd.subtyp, chId, pageId, j,
        );
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
    // figure_relations.from_fig_id/to_fig_id sind INTEGER (figures.id) — Lookup TEXT → INTEGER.
    const { byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    const updRel = db.prepare(
      'UPDATE figure_relations SET machtverhaltnis = ? WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ? AND user_email IS ?'
    );
    for (const bz of (beziehungenMacht || [])) {
      const fromId = figIdToRowId[bz.from_fig_id];
      const toId   = figIdToRowId[bz.to_fig_id];
      if (fromId == null || toId == null) continue;
      updRel.run(bz.machtverhaltnis ?? null, bookId, fromId, toId, userEmail || null);
    }
  })();
}

/** Fügt kapitelübergreifende Beziehungen zur figure_relations-Tabelle hinzu,
 *  ohne bestehende zu löschen. Strenge Dedup: pro ungeordnetem Paar (A,B)
 *  höchstens EINE Beziehung – wenn zwischen bz.von und bz.zu schon irgendeine
 *  Relation existiert, wird die neue verworfen. Zusätzlich: beide fig_ids
 *  müssen in figures existieren. */
function addFigurenBeziehungen(bookId, beziehungen, userEmail, idMaps) {
  const em = userEmail || null;
  // Lookup TEXT-fig_id → INTEGER figures.id (FK-Target seit Mig 72).
  const { byFigId: figIdToRowId } = figIdMaps(bookId, em);
  const pairExists = db.prepare(
    'SELECT COUNT(*) as cnt FROM figure_relations WHERE book_id = ? AND ((from_fig_id = ? AND to_fig_id = ?) OR (from_fig_id = ? AND to_fig_id = ?)) AND user_email IS ?'
  );
  const ins = db.prepare(
    'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    const seenInBatch = new Set();
    for (const bz of beziehungen) {
      if (!bz.von || !bz.zu || !bz.typ || bz.von === bz.zu) continue;
      const fromId = figIdToRowId[bz.von];
      const toId   = figIdToRowId[bz.zu];
      if (fromId == null || toId == null) continue;
      const [a, b] = bz.von < bz.zu ? [bz.von, bz.zu] : [bz.zu, bz.von];
      const key = `${a}|${b}`;
      if (seenInBatch.has(key)) continue;
      if (pairExists.get(bookId, fromId, toId, toId, fromId, em)?.cnt > 0) continue;
      const belegeArr = Array.isArray(bz.belege)
        ? bz.belege.filter(x => x && (x.kapitel || x.seite))
            .slice(0, 5)
            .map(x => enrichBelegWithIds(x, idMaps))
        : [];
      const belege = belegeArr.length ? JSON.stringify(belegeArr) : null;
      ins.run(bookId, fromId, toId, bz.typ, bz.beschreibung || null, bz.machtverhaltnis ?? null, belege, em);
      seenInBatch.add(key);
    }
  })();
}

module.exports = { updateFigurenEvents, updateFigurenSoziogramm, addFigurenBeziehungen };
