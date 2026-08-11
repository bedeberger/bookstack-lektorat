'use strict';
// Konsolidierter Zeitstrahl (`zeitstrahl_events`): Full-Replace der
// AI-generierten Ereignisse pro (Buch, User). User-kuratierte Zeilen
// (manually_edited=1) bleiben ueber Re-Runs hinweg erhalten.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
// TEXT-fig_id → INTEGER figures.id: der Lookup liegt bei den Figuren
// (db/figures/refs.js), nicht als eigene Kopie hier.
const { figIdMaps } = require('./figures/refs');
const { NOW_ISO_SQL } = require('./now');
const { requireUserEmail: _requireUserEmail } = require('./write-helpers');
const { toRefString: _toRefString } = require('./write-helpers');
// Strukturierte Datums-Felder aus AI-Output extrahieren — SSoT in
// db/event-datum.js, geteilt mit dem figure_events-Schreibpfad.
const _structuredDatum = require('./event-datum').structuredDatum;

// Ersetzt den gesamten Bestand für book/user.
// ereignisse: Array aus KI-Antwort [{datum, ereignis, typ, bedeutung, kapitel[], seiten[], figuren[]}]
// chNameToId: optionaler Map Kapitelname → chapter_id für stabile ID-Referenzen.
// pageNameToIdByChapter: optionaler Map chapter_id → (page_name → page_id) für
// kapitel-scoped Auflösung der seiten-Einträge. Fehlt er, bleiben page_ids leer.
function saveZeitstrahlEvents(bookId, userEmail, ereignisse, chNameToId = {}, pageNameToIdByChapter = null) {
  const email = _requireUserEmail(userEmail, 'saveZeitstrahlEvents');
  db.transaction(() => {
    // Nur AI-generierte Rows (manually_edited=0) ersetzen — user-kuratierte
    // Events bleiben über Re-Runs hinweg erhalten. CASCADE löscht ihre Child-
    // Rows (chapters/pages/figures) mit; AI-Re-Run baut sie neu auf.
    db.prepare(
      'DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? AND manually_edited = 0'
    ).run(bookId, email);
    const ins = db.prepare(`INSERT INTO zeitstrahl_events
      (book_id, user_email, datum, datum_label,
       datum_year, datum_month, datum_day,
       datum_ende_year, datum_ende_month, datum_ende_day,
       story_tag, datum_unsicher, ereignis, typ, subtyp, bedeutung, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insZec = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, ?)');
    const insZep = db.prepare('INSERT INTO zeitstrahl_event_pages    (event_id, page_id, sort_order)    VALUES (?, ?, ?)');
    const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures  (event_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
    // figures-Lookup TEXT-fig_id → INTEGER figures.id (FK-Target seit Mig 73).
    const { rows: figRows, byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    const figNameToRowId = {};
    for (const r of figRows) {
      for (const n of [r.name, r.kurzname]) {
        if (n) figNameToRowId[n.toLowerCase()] = r.id;
      }
    }
    for (let i = 0; i < ereignisse.length; i++) {
      const ev = ereignisse[i];
      const sd = _structuredDatum(ev);
      const { lastInsertRowid: eventId } = ins.run(
        bookId, email,
        ev.datum || sd.datum_label || '', sd.datum_label,
        sd.datum_year, sd.datum_month, sd.datum_day,
        sd.datum_ende_year, sd.datum_ende_month, sd.datum_ende_day,
        sd.story_tag, sd.datum_unsicher,
        ev.ereignis || '', ev.typ || 'persoenlich', sd.subtyp, ev.bedeutung || null,
        i
      );

      const rawKapitel = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      const kapitelArr = rawKapitel.map(_toRefString).filter(Boolean);
      const chapIds = kapitelArr.map(n => chNameToId?.[n] ?? null).filter(id => id != null);
      const seenChap = new Set();
      let j = 0;
      for (const cid of chapIds) {
        if (seenChap.has(cid)) continue;
        seenChap.add(cid);
        insZec.run(eventId, cid, j++);
      }

      const rawSeiten = Array.isArray(ev.seiten) ? ev.seiten : [];
      const seitenArr = rawSeiten.map(_toRefString).filter(Boolean);
      // Seiten auflösen: erst kapitel-scoped, dann Unambiguous-Match.
      // Halluzinations-Check: seite === kapitel → skip.
      const seenPage = new Set();
      j = 0;
      if (pageNameToIdByChapter) {
        for (const seite of seitenArr) {
          if (!seite || kapitelArr.includes(seite) || seite === 'Sonstige Seiten') continue;
          let pid = null;
          for (const chId of chapIds) {
            pid = pageNameToIdByChapter[chId]?.[seite] ?? null;
            if (pid) break;
          }
          if (pid == null) {
            const cand = [];
            for (const m of Object.values(pageNameToIdByChapter)) {
              if (m[seite]) cand.push(m[seite]);
            }
            if (cand.length === 1) pid = cand[0];
          }
          if (pid != null && !seenPage.has(pid)) {
            seenPage.add(pid);
            insZep.run(eventId, pid, j++);
          }
        }
      }

      // figuren: [{id, name, typ}] oder ["Name"]. id (TEXT-fig_id) per Lookup auf
      // INTEGER figures.id auflösen; Strings via Name-Lookup; figur_name als
      // Snapshot wenn kein figures-Match.
      const rawFiguren = Array.isArray(ev.figuren) ? ev.figuren : [];
      const seenFig = new Set();
      j = 0;
      for (const f of rawFiguren) {
        if (f == null) continue;
        let name = null, rowId = null;
        if (typeof f === 'string') {
          name = f.trim() || null;
          if (name) rowId = figNameToRowId[name.toLowerCase()] ?? null;
        } else if (typeof f === 'object') {
          name = (f.name || f.kurzname || '').trim() || null;
          if (f.id) rowId = figIdToRowId[String(f.id)] ?? null;
          if (rowId == null && name) rowId = figNameToRowId[name.toLowerCase()] ?? null;
        }
        if (!name && rowId == null) continue;
        const key = (rowId ?? '') + '|' + (name || '').toLowerCase();
        if (seenFig.has(key)) continue;
        seenFig.add(key);
        insZef.run(eventId, rowId, name, j++);
      }
    }
  })();
}

module.exports = {
  saveZeitstrahlEvents,
};
