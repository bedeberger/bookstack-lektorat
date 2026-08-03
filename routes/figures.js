const express = require('express');
const { db, saveFigurenToDb, saveZeitstrahlEvents, getChapterFigures, getBookSettings } = require('../db/schema');
const { ensureTree } = require('../db/book-order');
const { mergeFigures, mergeScenes } = require('../db/entity-merge');
const { recomputeBookFigureMentions } = require('../lib/page-index');
const { toIntId, inClause } = require('../lib/validate');
const { aclParamGuard } = require('../lib/acl');
const { bookParamHandler } = require('../lib/log-context');
const { parseDatum } = require('../lib/datum-parse');
const searchIndex = require('../lib/search');
const semanticChunks = require('../db/semantic-chunks');
const logger = require('../logger');

const router = express.Router();
// Figuren/Orte/Szenen sind nur fuer editor+ relevant (Buchwelt-CRUD); Lektor
// und Viewer sehen die Karten nicht — Server folgt der Frontend-Sicht.
router.param('book_id', aclParamGuard('editor'));
router.param('book_id', bookParamHandler);
const jsonBody = express.json();

// Lese-Reihenfolge: globaler Ordinalwert je Kapitel/Seite aus dem book_order-Tree
// (Depth-First). Brücke, um zu einer Event-Referenz (chapter_id/page_id) die
// Position im Manuskript zu bestimmen.
function _readingOrdinalMap(bookId) {
  const order = ensureTree(bookId);
  const map = new Map();
  let i = 0;
  (function walk(nodes) {
    for (const n of (nodes || [])) {
      if (n.type === 'chapter') { map.set('c' + n.id, i++); walk(n.children); }
      else if (n.type === 'page') { map.set('p' + n.id, i++); }
    }
  })(order?.tree || []);
  return map;
}

// "In welchem Jahr spielt der Roman?" — abgeleitet aus den sicher datierten
// Zeitstrahl-Events (datum_unsicher === false, datum_year gesetzt).
//   minYear/maxYear  → Jahres-Spektrum des Romans (Start inkl. Spannen-Ende)
//   endYear          → spätestes Story-Jahr des Romans (= maxYear)
//   chapters         → Story-Jahr je Kapitel in Lese-Reihenfolge:
//                      [{ chapter_id, name, minYear, maxYear }]. Ein Kapitel
//                      bündelt die sicher datierten Events, die es verlinken.
// null, wenn es keine sicher datierten Events gibt. Abgeleitete Jahre
// (datum_unsicher) fliessen bewusst NICHT ein.
function _computeChronology(bookId, events) {
  const secure = (events || []).filter(e => !e.datum_unsicher && e.datum_year != null);
  if (!secure.length) return null;
  let minYear = Infinity, maxYear = -Infinity;
  for (const e of secure) {
    if (e.datum_year < minYear) minYear = e.datum_year;
    const end = e.datum_ende_year != null ? e.datum_ende_year : e.datum_year;
    if (end > maxYear) maxYear = end;
  }
  // Pro-Kapitel: Story-Jahr(e), in denen das Kapitel spielt. kapitel[i] gehört
  // zu chapter_ids[i] (gleiche Push-Reihenfolge in der /zeitstrahl-Route).
  const byChapter = new Map(); // chapter_id → { chapter_id, name, min, max }
  for (const e of secure) {
    const end = e.datum_ende_year != null ? e.datum_ende_year : e.datum_year;
    const ids = e.chapter_ids || [], names = e.kapitel || [];
    ids.forEach((cid, i) => {
      if (cid == null) return;
      const c = byChapter.get(cid);
      if (!c) { byChapter.set(cid, { chapter_id: cid, name: names[i] || null, min: e.datum_year, max: end }); }
      else {
        if (e.datum_year < c.min) c.min = e.datum_year;
        if (end > c.max) c.max = end;
        if (!c.name && names[i]) c.name = names[i];
      }
    });
  }
  const ordinal = _readingOrdinalMap(bookId);
  const chapters = [...byChapter.values()]
    .filter(c => c.name) // ohne Namen nicht anzeigbar (z.B. gelöschtes Kapitel)
    .sort((a, b) => (ordinal.get('c' + a.chapter_id) ?? Infinity) - (ordinal.get('c' + b.chapter_id) ?? Infinity))
    .map(c => ({ chapter_id: c.chapter_id, name: c.name, minYear: c.min, maxYear: c.max }));
  return { minYear, maxYear, endYear: maxYear, chapters };
}

// Erste 4-stellige Jahreszahl aus einem Datums-String (z.B. "Frühling 1850").
function _yearFromString(s) {
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
function _computeFigureYears(bookId, userEmail) {
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
    const geburtsjahr = _yearFromString(fr.geburtstag) ?? (birthEvt.has(fr.id) ? birthEvt.get(fr.id) : null);
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

// Konsolidierten Zeitstrahl eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/zeitstrahl/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  // ORDER BY: strukturierte Datums-Felder zuerst (Year/Month/Day), Events ohne
  // Jahr ans Ende ("unbekannt"-Bucket via COALESCE-Sentinel 9999/99). sort_order
  // dient nur noch als Tiebreaker bei Datums-Gleichstand.
  const rows = db.prepare(`
    SELECT id, datum, datum_label, datum_year, datum_month, datum_day,
           datum_ende_year, datum_ende_month, datum_ende_day,
           story_tag, datum_unsicher, ereignis, typ, subtyp, bedeutung,
           storyline_id, manually_edited, sort_order
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ?
    ORDER BY
      COALESCE(datum_year,  9999),
      COALESCE(datum_month, 99),
      COALESCE(datum_day,   99),
      COALESCE(story_tag,   99999),
      sort_order, id
  `).all(bookId, userEmail || '');
  if (!rows.length) return res.json({ ereignisse: null });

  // Lazy-Parser-Fallback: Events mit Label aber ohne strukturierte Felder
  // (z.B. nachträglich verbesserter Parser oder manuelle Legacy-Strings)
  // beim Read erneut durchschleusen — füllt nur In-Memory, kein DB-Write.
  for (const r of rows) {
    if (r.datum_label && r.datum_year == null && r.datum_month == null
        && r.datum_day == null && r.story_tag == null) {
      const p = parseDatum(r.datum_label);
      if (p.year  != null) r.datum_year  = p.year;
      if (p.month != null) r.datum_month = p.month;
      if (p.day   != null) r.datum_day   = p.day;
      if (p.story_tag != null) r.story_tag = p.story_tag;
    }
  }

  const eventIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(eventIds);

  const chRows = db.prepare(`
    SELECT zec.event_id, zec.chapter_id, c.chapter_name
    FROM zeitstrahl_event_chapters zec
    LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
    WHERE zec.event_id IN ${idSql}
    ORDER BY zec.event_id, zec.sort_order
  `).all(...idVals);
  const pgRows = db.prepare(`
    SELECT zep.event_id, zep.page_id, p.page_name
    FROM zeitstrahl_event_pages zep
    LEFT JOIN pages p ON p.page_id = zep.page_id
    WHERE zep.event_id IN ${idSql}
    ORDER BY zep.event_id, zep.sort_order
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT zef.event_id, f.fig_id, COALESCE(f.name, zef.figur_name) AS name, f.typ
    FROM zeitstrahl_event_figures zef
    LEFT JOIN figures f ON f.id = zef.figure_id
    WHERE zef.event_id IN ${idSql}
    ORDER BY zef.event_id, zef.sort_order
  `).all(...idVals);

  const chByEvt = new Map();
  for (const r of chRows) {
    if (!chByEvt.has(r.event_id)) chByEvt.set(r.event_id, { kapitel: [], chapter_ids: [] });
    const b = chByEvt.get(r.event_id);
    if (r.chapter_name) b.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) b.chapter_ids.push(r.chapter_id);
  }
  const pgByEvt = new Map();
  for (const r of pgRows) {
    if (!pgByEvt.has(r.event_id)) pgByEvt.set(r.event_id, { seiten: [], page_ids: [] });
    const b = pgByEvt.get(r.event_id);
    if (r.page_name) b.seiten.push(r.page_name);
    if (r.page_id != null) b.page_ids.push(r.page_id);
  }
  const fgByEvt = new Map();
  for (const r of fgRows) {
    if (!fgByEvt.has(r.event_id)) fgByEvt.set(r.event_id, []);
    if (!r.name) continue;
    const out = { name: r.name };
    if (r.fig_id) out.id = r.fig_id;
    if (r.typ) out.typ = r.typ;
    fgByEvt.get(r.event_id).push(out);
  }

  const ereignisse = rows.map(r => ({
    id:               r.id,
    datum:            r.datum,
    datum_label:      r.datum_label || r.datum || '',
    datum_year:       r.datum_year,
    datum_month:      r.datum_month,
    datum_day:        r.datum_day,
    datum_ende_year:  r.datum_ende_year,
    datum_ende_month: r.datum_ende_month,
    datum_ende_day:   r.datum_ende_day,
    story_tag:        r.story_tag,
    datum_unsicher:   !!r.datum_unsicher,
    ereignis:         r.ereignis,
    typ:              r.typ || 'persoenlich',
    subtyp:           r.subtyp || 'sonstiges',
    bedeutung:        r.bedeutung || '',
    storyline_id:     r.storyline_id,
    manually_edited:  !!r.manually_edited,
    sort_order:       r.sort_order ?? 0,
    kapitel:          chByEvt.get(r.id)?.kapitel     || [],
    chapter_ids:      chByEvt.get(r.id)?.chapter_ids || [],
    seiten:           pgByEvt.get(r.id)?.seiten      || [],
    page_ids:         pgByEvt.get(r.id)?.page_ids    || [],
    figuren:          fgByEvt.get(r.id) || [],
  }));

  // Jahres-Anzeige nur bei Romanen mit "echter Zeitlinie" (book_settings.zeitlinie_real).
  const { zeitlinie_real } = getBookSettings(bookId, userEmail);
  const chronology = zeitlinie_real ? _computeChronology(bookId, ereignisse) : null;
  res.json({ ereignisse, chronology });
});

// Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/scenes/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

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

// Figuren eines Kapitels laden (für Kontext-Panel im Editor)
router.get('/chapter/:book_id/:chapter_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const chapterId = toIntId(req.params.chapter_id);
  if (!bookId || !chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const figuren = getChapterFigures(bookId, chapterId, userEmail);
  // Pro-Figur-Jahr/Alter anreichern (nur bei zeitlinie_real; sonst null-Map).
  const yearMap = _computeFigureYears(bookId, userEmail);
  if (yearMap) {
    for (const fig of figuren) {
      const fy = yearMap.get(fig.id);
      if (!fy) continue;
      fig.jahr_im_roman   = fy.jahr_im_roman;
      fig.geburtsjahr     = fy.geburtsjahr;
      fig.alter_im_roman  = fy.alter_im_roman;
      fig.anchor_ereignis = fy.anchor_ereignis;
      fig.anchor_kapitel  = fy.anchor_kapitel;
    }
  }
  res.json({ figuren });
});

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const figs = db.prepare(`
    SELECT * FROM figures
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ, fe.subtyp,
           fe.chapter_id, fe.page_id,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, userEmail);
  const rels = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id,
           r.typ, r.beschreibung, r.machtverhaltnis, r.belege
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email = ?
  `).all(bookId, userEmail);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  // Kapitel-Auftritte: alleinige Quelle figure_appearances (KI). Die KI erkennt die
  // Figur im Kontext und unterscheidet sie von gleichnamigen, im Text nur erwähnten
  // realen Personen (z.B. Figur „Pamela" vs. „Pamela Anderson"). Reine Namensnennungen
  // (page_figure_mentions) zählen hier bewusst nicht mit. Sortierung: Häufigkeit DESC.
  // Erst nach einer Komplettanalyse befüllt.
  const kapMap = {};
  for (const a of apps) {
    if (a.chapter_id == null) continue;
    (kapMap[a.figure_id] ??= new Map()).set(a.chapter_id, {
      chapter_id: a.chapter_id, name: a.chapter_name, haeufigkeit: a.haeufigkeit || 1,
    });
  }
  const kapitelFor = (figId) => {
    const m = kapMap[figId];
    if (!m) return [];
    return [...m.values()].sort((a, b) =>
      (b.haeufigkeit || 0) - (a.haeufigkeit || 0) || a.chapter_id - b.chapter_id);
  };
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({
    datum: e.datum, ereignis: e.ereignis, bedeutung: e.bedeutung,
    typ: e.typ || 'persoenlich', subtyp: e.subtyp || 'sonstiges',
    chapter_id: e.chapter_id ?? null, page_id: e.page_id ?? null,
    kapitel: e.kapitel || null, seite: e.seite || null,
  });
  const relMap = {};
  for (const r of rels) {
    let belege = [];
    if (r.belege) { try { belege = JSON.parse(r.belege) || []; } catch { belege = []; } }
    (relMap[r.from_fig_id] ??= []).push({
      figur_id: r.to_fig_id,
      typ: r.typ,
      beschreibung: r.beschreibung,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: Array.isArray(belege) ? belege : [],
    });
  }

  const sceneFigRows = db.prepare(`
    SELECT c.chapter_name AS kapitel, p.page_name AS seite, f.fig_id
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    JOIN figures f ON f.id = sf.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
  `).all(bookId, userEmail);
  const seitenMap = {};
  for (const sc of sceneFigRows) {
    if (!seitenMap[sc.fig_id]) seitenMap[sc.fig_id] = [];
    const key = sc.kapitel + '::' + (sc.seite || '');
    if (!seitenMap[sc.fig_id].some(x => x.kapitel + '::' + x.seite === key)) {
      seitenMap[sc.fig_id].push({ kapitel: sc.kapitel, seite: sc.seite || '' });
    }
  }

  const yearMap = _computeFigureYears(bookId, userEmail);

  const figuren = figs.map(f => {
    let zitate = [];
    if (f.schluesselzitate) {
      try { zitate = JSON.parse(f.schluesselzitate) || []; } catch { zitate = []; }
    }
    const fy = yearMap?.get(f.id) || null;
    let arc = null;
    if (f.arc) {
      try { arc = JSON.parse(f.arc); } catch { arc = null; }
      // Alt-Daten / Fehlparse: arc-Spalte hielt einen Flachstring statt JSON.
      if (arc === null && typeof f.arc === 'string') arc = { typ: '', anfang: '', wendepunkte: [], ende: f.arc };
    }
    return {
      id: f.fig_id,
      stale: !!f.stale,
      name: f.name,
      kurzname: f.kurzname,
      typ: f.typ,
      geburtstag: f.geburtstag,
      geschlecht: f.geschlecht,
      beruf: f.beruf,
      wohnadresse: f.wohnadresse || null,
      aeusseres: f.aeusseres || null,
      stimme: f.stimme || null,
      hintergrund: f.hintergrund || null,
      beschreibung: f.beschreibung,
      sozialschicht: f.sozialschicht || null,
      praesenz: f.praesenz || null,
      rolle: f.rolle || null,
      motivation: f.motivation || null,
      konflikt: f.konflikt || null,
      entwicklung: f.entwicklung || null,
      arc: (arc && (arc.anfang || arc.ende || (Array.isArray(arc.wendepunkte) && arc.wendepunkte.length) || arc.typ)) ? arc : null,
      erste_erwaehnung: f.erste_erwaehnung || null,
      erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
      schluesselzitate: Array.isArray(zitate) ? zitate : [],
      eigenschaften: tagMap[f.id] || [],
      kapitel: kapitelFor(f.id),
      seiten: seitenMap[f.fig_id] || [],
      lebensereignisse: evtMap[f.id] || [],
      beziehungen: relMap[f.fig_id] || [],
      jahr_im_roman:   fy ? fy.jahr_im_roman   : null,
      geburtsjahr:     fy ? fy.geburtsjahr     : null,
      alter_im_roman:  fy ? fy.alter_im_roman  : null,
      anchor_ereignis: fy ? fy.anchor_ereignis : null,
      anchor_kapitel:  fy ? fy.anchor_kapitel  : null,
    };
  });

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  // Reconcile per fig_id (round-trippt stabil durch GET→PUT): behaltene Figuren
  // behalten ihre figures.id → externe Referenzen (Plot/Recherche/Events) überleben
  // den manuellen Save. Im Katalog entfernte Figuren werden gelöscht (User autoritativ).
  saveFigurenToDb(bookId, req.body.figuren || [], userEmail, null, { reconcile: true, matchBy: 'figId', onMissing: 'delete' });
  // Response sofort – Mentions-Neuberechnung läuft im Hintergrund. Auf grossen Büchern
  // (>500 Seiten × >50 Figuren) braucht der Regex-Scan mehrere Sekunden.
  res.json({ ok: true });
  // FTS-Index nachziehen: saveFigurenToDb ist Full-Replace pro Buch — daher
  // kind/book droppen und neu indexieren.
  searchIndex.removeKindForBook('figure', bookId);
  const figRows = db.prepare('SELECT id FROM figures WHERE book_id = ?').all(bookId);
  for (const r of figRows) searchIndex.upsertFigure(r.id);
  setImmediate(() => {
    try {
      const { figures, pagesProcessed } = recomputeBookFigureMentions(bookId, userEmail);
      logger.info(`Figuren-Mentions aktualisiert: Buch ${bookId}, ${figures} Figuren × ${pagesProcessed} Seiten.`);
    } catch (e) {
      logger.warn(`Figuren-Mentions-Neuberechnung für Buch ${bookId} fehlgeschlagen: ${e.message}`);
    }
  });
});

// Zwei Figuren zusammenführen: alle Referenzen der Quelle wandern aufs Ziel, die
// Quelle wird gelöscht (Merge-Kern db/entity-merge.js). Gedacht für verwaiste
// («nicht mehr im Text») Einträge, deren Verknüpfungen beim blossen Löschen
// verloren gingen — bewusst OHNE stale-Gate, weil der Reconcile dieselbe Figur
// gelegentlich auch als zwei aktive Einträge auseinanderhält.
// `source`/`target` sind `figures.fig_id` (TEXT) — dieselbe Kennung, die GET als
// `id` ausliefert und die der Einzel-Delete-Handler nimmt.
router.post('/:book_id/merge', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const src = String(req.body?.source || '').trim();
  const tgt = String(req.body?.target || '').trim();
  if (!bookId || !src || !tgt) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (src === tgt) return res.status(409).json({ error_code: 'SAME_ENTITY' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const get = db.prepare(`SELECT id FROM figures WHERE fig_id = ? AND book_id = ? AND ${emailCond}`);
  const sRow = get.get(src, bookId, ...emailVal);
  const tRow = get.get(tgt, bookId, ...emailVal);
  if (!sRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'source' });
  if (!tRow) return res.status(404).json({ error_code: 'NOT_FOUND', side: 'target' });
  if (sRow.id === tRow.id) return res.status(409).json({ error_code: 'SAME_ENTITY' });

  const result = mergeFigures(bookId, userEmail, sRow.id, tRow.id);
  // Index-Pflege wie beim Einzel-Delete: Quelle raus, Ziel neu schreiben (der
  // Feld-Backfill kann seinen FTS-Text verändert haben).
  searchIndex.remove('figure', sRow.id);
  semanticChunks.remove('figure', sRow.id);
  searchIndex.upsertFigure(tRow.id);
  logger.info(`Figuren-Merge: «${result.sourceName}» → «${result.targetName}» (Buch ${bookId}).`);
  res.json({ ok: true, ...result });
  // page_figure_mentions ist abgeleitet: die Summe aus dem Merge hält den Stand
  // brauchbar, korrekt wird er erst mit dem Neu-Scan (der auch den kurzname des
  // Ziels berücksichtigt). Wie im PUT-Pfad im Hintergrund.
  setImmediate(() => {
    try {
      recomputeBookFigureMentions(bookId, userEmail);
    } catch (e) {
      logger.warn(`Figuren-Mentions nach Merge (Buch ${bookId}) fehlgeschlagen: ${e.message}`);
    }
  });
});

// Zwei Szenen zusammenführen (Pendant zum Figuren-Merge). `source_id`/`target_id`
// sind INTEGER `figure_scenes.id` — Szenen führen ihre PK öffentlich.
router.post('/scenes/:book_id/merge', jsonBody, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const srcId = toIntId(req.body?.source_id);
  const tgtId = toIntId(req.body?.target_id);
  if (!bookId || !srcId || !tgtId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (srcId === tgtId) return res.status(409).json({ error_code: 'SAME_ENTITY' });
  const userEmail = req.session?.user?.email || null;
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
  const userEmail = req.session?.user?.email || null;
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

// Bulk-Cleanup: alle STALE Figuren eines Buchs auf einmal löschen (Danger-Zone). Pendant
// zum Einzel-Delete '/:book_id/:id'. Nur stale wird angefasst — aktive Figuren bleiben
// unberührt. CASCADE räumt die Bridges mit.
// Muss VOR '/:book_id/:id' stehen, sonst matcht 'stale' als :id.
router.delete('/:book_id/stale', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const ids = db.prepare(
    `SELECT id FROM figures WHERE book_id = ? AND ${emailCond} AND stale = 1`
  ).all(bookId, ...emailVal).map(r => r.id);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM figures WHERE id = ?');
    for (const id of ids) del.run(id);
  })();
  for (const id of ids) { searchIndex.remove('figure', id); semanticChunks.remove('figure', id); }
  res.json({ ok: true, deleted: { figures: ids.length } });
});

// Einzelne STALE-Szene endgültig löschen (GUI-Button auf "nicht mehr im Text"-Zeilen).
// Nur stale erlaubt. CASCADE räumt scene_figures/scene_locations/song_scenes +
// research_item_links mit.
router.delete('/scenes/:book_id/:id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
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

// Einzelne STALE-Figur endgültig löschen (GUI-Button auf "nicht mehr im Text"-Zeilen).
// Nur stale erlaubt — aktive Figuren überleben die Re-Analyse via Reconcile. CASCADE räumt
// figure_relations/-events/-scenes/-appearances/-tags/page_figure_mentions +
// plot_beat_figures/research_item_links mit.
// `:id` ist die oeffentliche Figuren-Kennung `figures.fig_id` (TEXT) — dieselbe, die GET
// als `id` ausliefert; die INTEGER-PK verlaesst die Route nie. Bei stale-Figuren ist sie
// 'orphan_<rowid>', also nie eine Zahl.
router.delete('/:book_id/:id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const figId = String(req.params.id || '').trim();
  if (!bookId || !figId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const row = db.prepare(
    `SELECT id, stale FROM figures WHERE fig_id = ? AND book_id = ? AND ${emailCond}`
  ).get(figId, bookId, ...(userEmail ? [userEmail] : []));
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!row.stale) return res.status(409).json({ error_code: 'NOT_STALE' });
  db.prepare('DELETE FROM figures WHERE id = ?').run(row.id);
  searchIndex.remove('figure', row.id);
  semanticChunks.remove('figure', row.id);
  res.json({ ok: true });
});

module.exports = router;
