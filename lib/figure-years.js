'use strict';
// Pro-Figur-Jahr und -Alter aus dem konsolidierten Zeitstrahl.
//
// EIGENES MODUL, weil zwei Konsumenten dieselbe Rechnung brauchen: die Figuren-
// Routen (`jahr_im_roman`/`alter_im_roman` am Katalog, Kontext-Leiste, Figur-
// Lookup) und die Alters-Analyse (routes/jobs/figur-alter.js), die den
// abgeleiteten Wert gegen die Angaben im Text stellt. Zwei Implementierungen
// derselben Rechnung wuerden genau dort auseinanderlaufen, wo der Vergleich
// stattfindet — und der Vergleich IST das Feature.

const { db } = require('../db/connection');
const { getBookSettings } = require('../db/book-settings');

// Erste 4-stellige Jahreszahl aus einem Datums-String (z.B. "Frühling 1850").
function yearFromString(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

// Pro-Figur-Jahr ("in welchem Jahr steckt die Figur") + Alter. Nur bei Romanen
// mit "echter Zeitlinie" (book_settings.zeitlinie_real). Speist sich aus derselben
// kanonischen Quelle wie _computeChronology (zeitstrahl_events), damit Figuren-Jahr
// und der "Manuskript-Ende"/"Zeitspanne"-Header nie divergieren. Map<figures.id, {…}>:
//   jahr_im_roman  → spätestes sicher datiertes Jahr der Figur (inkl. Spannen-
//                    Ende). Fehlt der Figur jede Datierung: Fallback auf das
//                    späteste Jahr im ganzen Buch (= "aktuelles Roman-Jahr").
//   geburtsjahr    → aus dem kuratierten geburtstag-Feld, sonst aus einem
//                    Geburts-Event (subtyp='geburt').
//   alter_im_roman → jahr_im_roman − geburtsjahr (nur wenn beides bekannt und ≥ 0).
//   anchor_ereignis/anchor_kapitel → das datierte Ereignis, das den aktuellen
//                    Stand setzt (= jüngstes datiertes Ereignis der Figur). Das
//                    "weil …": woran die Figur gerade steht, zum Weiterschreiben.
//                    null, wenn die Figur kein eigenes datiertes Ereignis hat
//                    (Jahr stammt dann aus dem Buch-Fallback).
// null, wenn die Zeitlinie ausgeschaltet ist.
function computeFigureYears(bookId, userEmail) {
  const { zeitlinie_real } = getBookSettings(bookId, userEmail);
  if (!zeitlinie_real) return null;
  // Kanonische Quelle ist der konsolidierte Zeitstrahl (zeitstrahl_events) — dieselbe
  // Menge, aus der die Ereignisse-Karte „Manuskript-Ende"/„Zeitspanne" ableitet, damit
  // das Jahr je Figur nie gegen den Header divergiert. Erst wenn für das Buch noch kein
  // Zeitstrahl konsolidiert wurde, Fallback auf die rohen, undeduplizierten figure_events.
  const hasZeitstrahl = !!db.prepare(
    'SELECT 1 FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? LIMIT 1'
  ).get(bookId, userEmail || '');
  let rows;
  if (hasZeitstrahl) {
    rows = db.prepare(`
      SELECT zef.figure_id AS fid, ze.datum_year AS y, ze.datum_ende_year AS ye,
             ze.subtyp AS subtyp, ze.ereignis AS ereignis, ze.sort_order AS so, ze.id AS eid
      FROM zeitstrahl_event_figures zef
      JOIN zeitstrahl_events ze ON ze.id = zef.event_id
      WHERE ze.book_id = ? AND ze.user_email = ?
        AND ze.datum_unsicher = 0 AND ze.datum_year IS NOT NULL
        AND zef.figure_id IS NOT NULL
    `).all(bookId, userEmail || '');
    // Anker-Kapitel je Event (erstes nach sort_order) — ein Zeitstrahl-Event kann
    // mehrere Kapitel verlinken; für die Anker-Anzeige genügt ein repräsentatives.
    const kapByEvt = new Map();
    const kapRows = db.prepare(`
      SELECT zec.event_id AS eid, c.chapter_name AS kapitel
      FROM zeitstrahl_event_chapters zec
      JOIN zeitstrahl_events ze ON ze.id = zec.event_id
      LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
      WHERE ze.book_id = ? AND ze.user_email = ?
      ORDER BY zec.event_id, zec.sort_order
    `).all(bookId, userEmail || '');
    for (const r of kapRows) if (r.kapitel && !kapByEvt.has(r.eid)) kapByEvt.set(r.eid, r.kapitel);
    for (const r of rows) r.kapitel = kapByEvt.get(r.eid) || null;
  } else {
    rows = db.prepare(`
      SELECT fe.figure_id AS fid, fe.datum_year AS y, fe.datum_ende_year AS ye, fe.subtyp AS subtyp,
             fe.ereignis AS ereignis, fe.sort_order AS so, c.chapter_name AS kapitel
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
      LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
      WHERE f.book_id = ? AND f.user_email = ?
        AND fe.datum_unsicher = 0 AND fe.datum_year IS NOT NULL
    `).all(bookId, userEmail || '');
  }
  const figRows = db.prepare(
    'SELECT id, geburtstag FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail || '');

  const latest = new Map();    // fid → { year, ereignis, kapitel, so } (jüngstes Ereignis)
  const birthEvt = new Map();  // fid → frühestes Geburts-Event-Jahr
  let bookMax = -Infinity;
  for (const r of rows) {
    const hi = Math.max(r.y, r.ye != null ? r.ye : r.y);
    const cur = latest.get(r.fid);
    // Höchstes Jahr gewinnt; bei Gleichstand die spätere Manuskript-Reihenfolge.
    if (!cur || hi > cur.year || (hi === cur.year && (r.so ?? 0) >= (cur.so ?? 0))) {
      latest.set(r.fid, { year: hi, ereignis: r.ereignis || '', kapitel: r.kapitel || null, so: r.so ?? 0 });
    }
    if (hi > bookMax) bookMax = hi;
    if (r.subtyp === 'geburt' && (!birthEvt.has(r.fid) || r.y < birthEvt.get(r.fid))) {
      birthEvt.set(r.fid, r.y);
    }
  }

  const out = new Map();
  for (const fr of figRows) {
    const geburtsjahr = yearFromString(fr.geburtstag) ?? (birthEvt.has(fr.id) ? birthEvt.get(fr.id) : null);
    const lat = latest.get(fr.id) || null;
    const jahr = lat ? lat.year : (Number.isFinite(bookMax) ? bookMax : null);
    if (jahr == null && geburtsjahr == null) continue;
    const alter = (jahr != null && geburtsjahr != null && jahr >= geburtsjahr) ? jahr - geburtsjahr : null;
    out.set(fr.id, {
      jahr_im_roman: jahr,
      geburtsjahr,
      alter_im_roman: alter,
      anchor_ereignis: lat ? lat.ereignis : null,
      anchor_kapitel:  lat ? lat.kapitel  : null,
    });
  }
  return out;
}
// Jahres-Spanne des ganzen Buchs (Bezugsrahmen fuer ein aus dem Geburtsjahr
// gerechnetes Alter). Gleiche kanonische Quelle und gleiche Vorrangregel wie
// computeFigureYears: der konsolidierte Zeitstrahl, ersatzweise die rohen
// figure_events. null, wenn es keine sicher datierten Ereignisse gibt.
function bookYearSpan(bookId, userEmail) {
  const hasZeitstrahl = !!db.prepare(
    'SELECT 1 FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? LIMIT 1'
  ).get(bookId, userEmail || '');
  const row = hasZeitstrahl
    ? db.prepare(`
        SELECT MIN(datum_year) AS lo, MAX(COALESCE(datum_ende_year, datum_year)) AS hi
        FROM zeitstrahl_events
        WHERE book_id = ? AND user_email = ? AND datum_unsicher = 0 AND datum_year IS NOT NULL
      `).get(bookId, userEmail || '')
    : db.prepare(`
        SELECT MIN(fe.datum_year) AS lo, MAX(COALESCE(fe.datum_ende_year, fe.datum_year)) AS hi
        FROM figure_events fe
        JOIN figures f ON f.id = fe.figure_id
        WHERE f.book_id = ? AND f.user_email = ? AND fe.datum_unsicher = 0 AND fe.datum_year IS NOT NULL
      `).get(bookId, userEmail || '');
  if (!row || row.lo == null) return null;
  return { minYear: row.lo, maxYear: row.hi ?? row.lo };
}

module.exports = { computeFigureYears, yearFromString, bookYearSpan };
