'use strict';
// Welt-Fakten (`world_facts` + Bruecke `world_fact_chapters`): der
// Schreibpfad der Komplettanalyse-Phase.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');

// Whitelist für Welt-Fakten-Kategorien (harte Gruppierung analog EVENT_SUBTYP_WL).
// KI liefert die Kategorie im Komplettanalyse-Output; unbekannte/leere Werte
// fallen auf 'sonstiges' zurück. Frontend rendert Label + Icon je Key
// (public/js/cards/world-facts-card.js, i18n weltfakten.kategorie.*).
const FAKT_KATEGORIE_WL = new Set([
  'figur', 'ort', 'objekt', 'organisation', 'technik', 'regel',
  'kultur', 'historie', 'zeit', 'soziolekt', 'ereignis', 'sonstiges',
]);

// Normalisiert einen KI-Kategorie-String auf einen Whitelist-Key (lowercase,
// getrimmt). Unbekannt/leer → 'sonstiges'.
function _normFaktKategorie(raw) {
  const k = (raw == null ? '' : String(raw)).trim().toLowerCase();
  return FAKT_KATEGORIE_WL.has(k) ? k : 'sonstiges';
}

// Deklaratives Buch-Wissen aus der Komplettanalyse (Phase 1). Anders als Orte
// haben Fakten keine stabile KI-ID → Full-Replace pro (book, user) statt Upsert
// (regenerierter Cache, kein manuelles Edit). Bridge auf chapters primär via Kapitelname
// (chNameToId). Liefert das (z.B. im Single-Pass mit kapitel='Gesamtbuch') kein Kapitel,
// greift der Fallback über den Seitennamen des Fakts (f.seite → pages.page_name →
// chapter_id) – aber nur bei EINDEUTIGER Namens-Auflösung, sonst bleibt der Fakt
// book-level ohne Bridge-Eintrag (kein Sentinel). So bekommen auch Single-Pass-Fakten
// eine Kapitel-Zuordnung (Anachronismus-Erzähljahr, Buch-Chat list_world_facts).
// chapterFakten: [{ kapitel, fakten: [{ kategorie, subjekt, fakt, seite }] }]
function saveFaktenToDb(bookId, chapterFakten, userEmail, chNameToId = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  // Seitenname → chapter_id; mehrdeutige Namen (zwei Seiten gleichen Namens in
  // verschiedenen Kapiteln) als ambig markieren und NICHT auflösen.
  const pageNameToChapter = new Map();
  const ambigPageName = new Set();
  for (const r of db.prepare('SELECT page_name, chapter_id FROM pages WHERE book_id = ?').all(bookId)) {
    if (r.chapter_id == null || !r.page_name) continue;
    if (pageNameToChapter.has(r.page_name)) {
      if (pageNameToChapter.get(r.page_name) !== r.chapter_id) ambigPageName.add(r.page_name);
    } else {
      pageNameToChapter.set(r.page_name, r.chapter_id);
    }
  }
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  db.transaction(() => {
    // Full-Replace: alte Fakten weg (CASCADE räumt world_fact_chapters).
    db.prepare(`DELETE FROM world_facts WHERE book_id = ? AND ${emailCond}`).run(bookId, ...emailVal);

    const ins = db.prepare(`
      INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, seite_label, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insWfc = db.prepare('INSERT OR IGNORE INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)');

    let order = 0;
    for (const cf of (chapterFakten || [])) {
      const chName = _toRefString(cf?.kapitel);
      const chapId = chName ? (chNameToId?.[chName] ?? null) : null;
      for (const f of (cf?.fakten || [])) {
        const fakt = _toRefString(f?.fakt);
        if (!fakt) continue;
        const seite = _toRefString(f?.seite) || null;
        const { lastInsertRowid } = ins.run(
          bookId, _normFaktKategorie(f?.kategorie), _toRefString(f?.subjekt) || null,
          fakt, seite, order++, userEmail || null
        );
        // Kapitelname zuerst; sonst eindeutiger Seitenname als Fallback.
        let factChap = chapId;
        if (factChap == null && seite && !ambigPageName.has(seite)) {
          factChap = pageNameToChapter.get(seite) ?? null;
        }
        if (factChap != null) insWfc.run(lastInsertRowid, factChap);
      }
    }
  })();
}

module.exports = {
  saveFaktenToDb,
  FAKT_KATEGORIE_WL,
};
