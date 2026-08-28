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

// ── Lesepfad ────────────────────────────────────────────────────────────────

/** Welt-Fakten eines Buchs mit ihren Kapitelnamen (JOIN zur Lesezeit, kein
 *  Snapshot). `kategorien` filtert optional auf eine Whitelist-Teilmenge —
 *  Konsumenten, die nur die Weltgesetze brauchen, reichen ['regel','technik']
 *  herein, statt alles zu laden und im Speicher zu sieben.
 *
 *  Gemeinsamer Lesepfad fuer alle Konsumenten, die Kapitelnamen brauchen: der
 *  Namens-JOIN gehoert nach `db/` (Content-Store-Facade-Regel), nicht in einen
 *  Route- oder Job-Handler.
 *
 *  @returns {Array<{id,kategorie,subjekt,fakt,seite,kapitel:string[],updated_at}>}
 */
function listWorldFacts(bookId, userEmail, { kategorien = null } = {}) {
  const bookIdInt = parseInt(bookId);
  if (!bookIdInt) return [];
  const email = userEmail || null;
  const kats = Array.isArray(kategorien)
    ? kategorien.map(k => String(k || '').toLowerCase()).filter(k => FAKT_KATEGORIE_WL.has(k))
    : null;
  // Eine leere (aber uebergebene) Kategorienliste heisst „nichts davon" — nicht „alles".
  if (kats && !kats.length) return [];
  const katCond = kats ? ` AND wf.kategorie IN (${kats.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, wf.seite_label, wf.updated_at,
           c.chapter_name
      FROM world_facts wf
      LEFT JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
      LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
     WHERE wf.book_id = ? AND wf.user_email IS ?${katCond}
     ORDER BY wf.sort_order, wf.id, c.position
  `).all(bookIdInt, email, ...(kats || []));

  // Bridge-Zeilen (eine je Kapitel) zu einem Fakt zusammenfassen.
  const byId = new Map();
  for (const r of rows) {
    let e = byId.get(r.id);
    if (!e) {
      e = {
        id: r.id,
        kategorie: r.kategorie,
        subjekt: r.subjekt || null,
        fakt: r.fakt,
        seite: r.seite_label || null,
        kapitel: [],
        updated_at: r.updated_at || null,
      };
      byId.set(r.id, e);
    }
    if (r.chapter_name && !e.kapitel.includes(r.chapter_name)) e.kapitel.push(r.chapter_name);
  }
  return [...byId.values()];
}

/** Ist der Fakten-Index dieses Buchs je erhoben worden?
 *
 *  **Leer heisst „nie analysiert", nicht „keine Weltfakten"** — dasselbe Muster wie
 *  `scanned: false` bei `motif_occurrences` und `anchorMap === null` im Plot-Check.
 *  Ohne diese Unterscheidung behauptet ein nie gelaufener Lauf, das Buch habe keine
 *  Welt: die Bewertung liest 0 Fakten als weltarm, die Consistency-Pruefung meldet
 *  „verletzt keine Weltregel", und die Karte fordert eine Analyse, die schon lief.
 *
 *  `world_facts` fuehrt bewusst KEINE Scan-Marker-Tabelle (Full-Replace pro Lauf,
 *  kein Delta-Cache) — die Frage wird darum aus zwei Signalen beantwortet:
 *  vorhandene Fakten (deckt auch importierte Buecher ab, die nie einen Job gesehen
 *  haben) ODER ein abgeschlossener `komplett-analyse`-Lauf in `job_runs` (nie geprunt).
 *  Grenzfall mit Absicht in Kauf genommen: faellt allein der Fakten-Pass eines
 *  sonst erfolgreichen Laufs aus (`job.warn.faktenFailed`), gilt das Buch als
 *  gescannt — die Warnung stand im Job-Ergebnis.
 *
 *  @returns {{scanned: boolean, count: number}}
 */
function worldFactsScanState(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  if (!bookIdInt) return { scanned: false, count: 0 };
  const email = userEmail || null;
  const { n } = db.prepare(
    'SELECT COUNT(*) AS n FROM world_facts WHERE book_id = ? AND user_email IS ?'
  ).get(bookIdInt, email);
  if (n > 0) return { scanned: true, count: n };
  const run = db.prepare(`
    SELECT 1 FROM job_runs
     WHERE type = 'komplett-analyse' AND status = 'done'
       AND book_id = ? AND user_email IS ? LIMIT 1
  `).get(bookIdInt, email);
  return { scanned: !!run, count: 0 };
}

module.exports = {
  saveFaktenToDb,
  listWorldFacts,
  worldFactsScanState,
  FAKT_KATEGORIE_WL,
};
