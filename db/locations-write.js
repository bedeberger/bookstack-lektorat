'use strict';
// Orte: Match-Planung, Schreibpfad (`locations` + Bruecke
// `location_chapters`), Koordinaten-Patch und der Kapitel-Lesepfad.
//
// `planOrteMatch` ist bewusst NUR LESEND und die SSoT beider Seiten:
// `saveOrteToDb` ruft sie selbst, und der Job ruft sie VOR dem Speichern, um die
// unsicheren Paare vom KI-Judge beurteilen zu lassen — eine DB-Schreibfunktion
// darf keinen KI-Call machen. Ohne diese gemeinsame Funktion gaebe es zwei
// Matcher, die auseinanderdriften.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
// TEXT-fig_id → INTEGER figures.id: der Lookup liegt bei den Figuren
// (db/figures/refs.js), nicht als eigene Kopie hier.
const { figIdMaps } = require('./figures/refs');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');
const logger = require('../logger');
const { matchLocations } = require('../lib/entity-match');

// Geo-Koordinate als Number normalisieren + auf gueltigen Bereich clampen.
// Fremd-Input (Nominatim / Marker-Drag) → null bei NaN/leer, sonst geklemmt.
function _clampCoord(v, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-max, Math.min(max, n));
}

// Match-Planung Orte (NUR LESEND) — SSoT fuer beide Seiten: `saveOrteToDb` ruft sie
// selbst, und der Job ruft sie VOR dem Speichern, um die unsicheren Paare vom
// KI-Judge beurteilen zu lassen (eine DB-Schreibfunktion darf keinen KI-Call machen).
// Ohne diese gemeinsame Funktion gaebe es zwei Matcher, die auseinanderdriften.
// Gibt { matchOf: Map(incomingIndex → locations.id), unsure: [...], existing: [...] }.
function planOrteMatch(bookId, orte, userEmail, chNameToId = null, hint = null) {
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  const existing = db.prepare(
    `SELECT id, loc_id, name, typ, lat, lng, land FROM locations WHERE book_id = ? AND ${emailCond}`
  ).all(bookId, ...emailVal);
  // Indizien (lib/entity-match.js#locationEvidence): gemeinsames Kapitel und gemeinsame
  // Figur unterscheiden zwei aehnlich benannte Orte deutlich besser als der Name allein.
  const chapRows = db.prepare(`
    SELECT lc.location_id AS lid, lc.chapter_id AS cid
    FROM location_chapters lc JOIN locations l ON l.id = lc.location_id
    WHERE l.book_id = ? AND l.${emailCond}`).all(bookId, ...emailVal);
  const figRows = db.prepare(`
    SELECT lf.location_id AS lid, lf.figure_id AS fid
    FROM location_figures lf JOIN locations l ON l.id = lf.location_id
    WHERE l.book_id = ? AND l.${emailCond}`).all(bookId, ...emailVal);
  const byLoc = new Map();
  const bucket = (lid) => {
    if (!byLoc.has(lid)) byLoc.set(lid, { chapters: [], figures: [] });
    return byLoc.get(lid);
  };
  for (const r of chapRows) bucket(r.lid).chapters.push(r.cid);
  for (const r of figRows) bucket(r.lid).figures.push(r.fid);
  // Beide Seiten auf IDs vergleichen (nicht auf Namen): Kapitel-/Figurennamen
  // kollidieren, IDs nicht. Die neuen Orte tragen Kapitel als NAMEN und Figuren als
  // TEXT-fig_id des Laufs — beides uebersetzen, sonst findet der Score nie eine
  // Ueberschneidung.
  const exCands = existing.map(ex => {
    const e = byLoc.get(ex.id) || { chapters: [], figures: [] };
    return { ...ex, chapters: e.chapters, figures: e.figures };
  });
  const { byFigId } = figIdMaps(bookId, userEmail);
  const incoming = orte.map(o => ({
    id: o.id, name: o.name, typ: o.typ, land: o.land, lat: o.lat, lng: o.lng,
    chapters: (o.kapitel || [])
      .map(k => chNameToId?.[_toRefString(typeof k === 'object' && k ? (k.name ?? k) : k)])
      .filter(v => v != null),
    figures: (o.figuren || []).map(fid => byFigId[fid]).filter(v => v != null),
  }));
  const plan = matchLocations(exCands, incoming, { hint });
  return { ...plan, existing };
}

// Reconcile statt Delete+Re-Insert, damit locations.id (und FK-Refs darauf:
// research_item_links.location_id, scene_locations …) ueber Re-Analysen stabil bleibt.
// chNameToId: optionaler Map Kapitelname → chapter_id. Wird er nicht übergeben,
// wird er aus der chapters-Tabelle aufgebaut (für UI-Endpunkt ohne Job-Kontext).
// pageNameToIdByChapter: optional. Fehlt er, wird er aus der pages-Tabelle
// aufgebaut — kapitel-scoped gegen Namenskollisionen zwischen Kapiteln.
// opts.matchBy 'name' (Komplettanalyse) | 'locId' (Default, Manual-Edit);
// opts.onMissing 'stale' (markieren) | 'delete' (Default).
// opts.matchHint (Map loc_id → locations.id): vom KI-Judge bestaetigte Paare, die die
//   Regel allein nicht entscheiden konnte. Nur im 'name'-Modus wirksam. Kommt aus dem
//   Job (routes/jobs/komplett/entity-reconcile.js), weil eine DB-Schreibfunktion keinen
//   KI-Call machen darf (harte Regel „KI-Calls nur via Job-Queue").
function saveOrteToDb(bookId, orte, userEmail, chNameToId = null, pageNameToIdByChapter = null, opts = {}) {
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
  // Löst erste_erwaehnung einer Location auf eine konkrete page_id auf.
  // Scope: Kapitel aus location_chapters (o.kapitel). Fallback: Unambiguous-Match.
  const resolveErstePageIdForOrt = (ersteErwaehnung, kapitel) => {
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
  // Reconcile-Modus (siehe figures.js): matchBy 'name' (Komplettanalyse) matcht per
  // normalisiertem Namen, weil die loc_id pro Lauf frisch vergeben wird (ort_N, NICHT
  // identitaetsstabil) → re-detektiert behaelt seine locations.id (FK-Refs ueberleben),
  // re-detektiert → stale=0, verschwunden → stale=1 statt Loeschen. matchBy 'locId'
  // (Default, Manual-Edit-CRUD) matcht per loc_id (round-trippt stabil durch GET→PUT),
  // verschwundene werden geloescht (User autoritativ).
  const matchByName = opts.matchBy === 'name';
  const onMissingStale = opts.onMissing === 'stale';
  let droppedFigRefs = 0;

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, loc_id, name, typ, lat, lng, land FROM locations WHERE book_id = ? AND ${emailCond}`
    ).all(bookId, ...emailVal);
    const prevById = Object.fromEntries(existing.map(r => [r.id, r]));

    // Komplettanalyse liefert keine Geo-Daten (AI extrahiert kein lat/lng) und
    // wuerde manuell gepinnte/gegeocodete Koordinaten beim Full-Replace mit NULL
    // ueberschreiben. Bei `preserveExistingCoords` Bestandskoordinaten per
    // normalisiertem Namen reattachen — loc_id taugt nicht (AI regeneriert ids).
    // Manuell-Pfad (routes/locations.js) setzt das Flag NICHT → Coords bleiben
    // dort leerbar.
    let coordByName = null;
    let geoByName = null;
    if (opts.preserveExistingCoords) {
      coordByName = new Map();
      const cr = db.prepare(
        `SELECT name, lat, lng, land FROM locations WHERE book_id = ? AND ${emailCond} AND lat IS NOT NULL AND lng IS NOT NULL`
      ).all(bookId, ...emailVal);
      for (const r of cr) {
        const key = String(r.name || '').trim().toLowerCase();
        if (key && !coordByName.has(key)) coordByName.set(key, r);
      }
      // Geocode-Resolve-Cache (geo_query/geo_land) ueber die Komplettanalyse-
      // Reextraktion retten — die regeneriert loc_ids und wuerde die Rows sonst
      // neu anlegen (Cache verloren → naechster «Alle verorten»-Lauf ruft die KI
      // erneut). Per normalisiertem Namen reattachen, unabhaengig von Koordinaten
      // (auch rein fiktive Orte mit geo_query='' sollen den Cache behalten).
      geoByName = new Map();
      const gr = db.prepare(
        `SELECT name, geo_query, geo_land FROM locations WHERE book_id = ? AND ${emailCond} AND geo_query IS NOT NULL`
      ).all(bookId, ...emailVal);
      for (const r of gr) {
        const key = String(r.name || '').trim().toLowerCase();
        if (key && !geoByName.has(key)) geoByName.set(key, r);
      }
    }

    // Match neue Orte → bestehende (greedy, jede Bestands-Row hoechstens einmal).
    const matchOf = new Map();       // incomingIndex → existingId
    const usedExisting = new Set();
    if (matchByName) {
      // Auch stale-Orte sind Match-Kandidaten — ein wiederaufgetauchter Ort wird revived.
      // Geplant wird in planOrteMatch (dieselbe Funktion, die der Job vor dem Judge
      // ruft): exakter Name → Token-Teilmenge/-Overlap + Indizien, Unsicheres bleibt
      // getrennt. `opts.matchHint` sind die vom Judge bestaetigten Paare.
      const locMatch = planOrteMatch(bookId, orte, userEmail, chNameToId, opts.matchHint || null);
      for (const [i, exId] of locMatch.matchOf) { matchOf.set(i, exId); usedExisting.add(exId); }
    } else {
      const byLocId = new Map(existing.map(ex => [ex.loc_id, ex.id]));
      for (let i = 0; i < orte.length; i++) {
        const exId = byLocId.get(orte[i].id);
        if (exId != null && !usedExisting.has(exId)) { matchOf.set(i, exId); usedExisting.add(exId); }
      }
    }

    // Verschwundene (nicht wiedergefundene) Bestands-Orte behandeln.
    const missing = existing.filter(ex => !usedExisting.has(ex.id));
    if (onMissingStale) {
      // stale=1 statt Loeschen → FK-Refs (research_item_links.location_id, scene_locations)
      // ueberleben. loc_id auf 'orphan_<id>' ziehen, damit der 'ort_N'-Namespace fuer den
      // naechsten Lauf kollisionsfrei (UNIQUE(book_id, loc_id, user_email)) bleibt.
      const markStale = db.prepare("UPDATE locations SET stale = 1, loc_id = 'orphan_' || id WHERE id = ?");
      for (const ex of missing) markStale.run(ex.id);
    } else {
      // CASCADE entfernt location_figures, location_chapters, scene_locations.
      const delLoc = db.prepare('DELETE FROM locations WHERE id = ?');
      for (const ex of missing) delLoc.run(ex.id);
    }

    // Beim Name-Match werden die loc_ids auf die frischen Lauf-Werte umgebogen — matched
    // Rows zuerst transient auf 'tmp_<id>' setzen, sonst kollidieren zwei Orte, die ihre
    // loc_ids tauschen, in UNIQUE(book_id, loc_id, user_email).
    if (matchByName) {
      const tmpRename = db.prepare("UPDATE locations SET loc_id = 'tmp_' || id WHERE id = ?");
      for (const exId of usedExisting) tmpRename.run(exId);
    }

    const upd = db.prepare(`
      UPDATE locations SET loc_id=?, name=?, typ=?, beschreibung=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?, stimmung=?,
        land=?, lat=?, lng=?, sort_order=?, ${matchByName ? 'stale=0, ' : ''}updated_at=${NOW_ISO_SQL}
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id, stimmung,
        land, lat, lng, sort_order, user_email, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL})`);
    const delLf = db.prepare('DELETE FROM location_figures WHERE location_id = ?');
    const delLc = db.prepare('DELETE FROM location_chapters WHERE location_id = ?');
    // Geocode-Resolve-Cache: bei Umbenennung nullen (Toponym-Aufloesung ist dann
    // stale), bei Komplett-Reextraktion per Name reattachen (geoByName).
    const resetGeo = db.prepare('UPDATE locations SET geo_query = NULL, geo_land = NULL WHERE id = ?');
    const setGeo = db.prepare('UPDATE locations SET geo_query = ?, geo_land = ? WHERE id = ?');
    // location_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const { byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    const insLf = db.prepare('INSERT OR IGNORE INTO location_figures (location_id, figure_id) VALUES (?, ?)');
    const insLc = db.prepare('INSERT INTO location_chapters (location_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');

    for (let i = 0; i < orte.length; i++) {
      const o = orte[i];
      const erstPageId = resolveErstePageIdForOrt(o.erste_erwaehnung, o.kapitel);
      if (coordByName && (o.lat == null || o.lng == null)) {
        const m = coordByName.get(String(o.name || '').trim().toLowerCase());
        if (m) { o.lat = m.lat; o.lng = m.lng; if (o.land == null && m.land) o.land = m.land; }
      }
      const lat = _clampCoord(o.lat, 90);
      const lng = _clampCoord(o.lng, 180);
      // land normalisiert auf ISO-3166-1-alpha-2 lowercase; alles andere → NULL.
      const land = /^[A-Za-z]{2}$/.test(String(o.land || '').trim()) ? String(o.land).trim().toLowerCase() : null;
      const existingId = matchOf.get(i);
      let locDbId = existingId;
      if (existingId != null) {
        // integer id (und scene_locations) bleibt erhalten; loc_id wird auf den
        // frischen Lauf-Wert gesetzt (matched-Rows wurden vorab auf 'tmp_<id>' geparkt).
        upd.run(o.id, o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          land, lat, lng, i, locDbId);
        delLf.run(locDbId);
        delLc.run(locDbId);
        // Resolve-Cache fallen lassen, wenn das Label sich aendert ODER der User
        // die Georeferenz manuell entfernt (hatte Koordinaten, jetzt keine) — Letzteres
        // ist sein «nochmal von vorn»-Signal, dann soll auch die KI neu aufloesen.
        // Komplett-Reextraktion (preserveExistingCoords) reattacht Coords und faellt
        // hier nicht durch.
        const prev = prevById[existingId];
        const renamed = String(prev?.name ?? '') !== String(o.name ?? '');
        const clearedCoords = !opts.preserveExistingCoords
          && prev && prev.lat != null && prev.lng != null && (lat == null || lng == null);
        if (renamed || clearedCoords) resetGeo.run(locDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, o.id, o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          land, lat, lng, i, userEmail || null
        );
        locDbId = lastInsertRowid;
        // Komplett-Reextraktion: Cache der namensgleichen Vorgaenger-Row uebernehmen.
        if (geoByName) {
          const g = geoByName.get(String(o.name || '').trim().toLowerCase());
          if (g) setGeo.run(g.geo_query, g.geo_land || null, locDbId);
        }
      }
      for (const fid of (o.figuren || [])) {
        const ref = _toRefString(fid);
        const rowId = ref ? figIdToRowId[ref] : null;
        if (rowId != null) insLf.run(locDbId, rowId);
        else if (ref) droppedFigRefs++;
      }
      for (const k of (o.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insLc.run(locDbId, chapId, haeufigkeit);
      }
    }
  })();
  if (droppedFigRefs > 0) {
    logger.warn(`saveOrteToDb: ${droppedFigRefs} Ort→Figur-Referenzen verworfen (Figur nicht in figures-Tabelle).`);
  }
}

// Koordinaten einzelner Schauplätze patchen (Marker-Drag, Undo/Redo, Georeferenz
// löschen). Bewusst KEIN Full-Replace via saveOrteToDb: dort hängen Match-/
// Reconcile-Heuristiken (clearedCoords, loc_id-Tausch) am ganzen Array — bei
// nebenläufigen Einzel-Edits race-anfällig. Hier wird streng pro loc_id nur
// lat/lng gesetzt; geht eine Koordinate auf NULL, wird zusätzlich der Geocode-
// Resolve-Cache (geo_query/geo_land) genullt — der User signalisiert mit dem
// Löschen „wieder von vorn geocodierbar". Andere Felder/Relationen unberührt.
// patches: [{ id (=loc_id), lat, lng }]. Liefert die Zahl geänderter Rows.
function patchOrtCoords(bookId, patches, userEmail) {
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];
  const upd = db.prepare(
    `UPDATE locations SET lat=?, lng=?, updated_at=${NOW_ISO_SQL} WHERE book_id=? AND loc_id=? AND ${emailCond}`
  );
  const clearGeo = db.prepare(
    `UPDATE locations SET geo_query=NULL, geo_land=NULL WHERE book_id=? AND loc_id=? AND ${emailCond}`
  );
  let changed = 0;
  db.transaction(() => {
    for (const p of (patches || [])) {
      if (!p || p.id == null) continue;
      const lat = _clampCoord(p.lat, 90);
      const lng = _clampCoord(p.lng, 180);
      const locId = String(p.id);
      const info = upd.run(lat, lng, bookId, locId, ...emailVal);
      if (info.changes) {
        changed += info.changes;
        if (lat == null || lng == null) clearGeo.run(bookId, locId, ...emailVal);
      }
    }
  })();
  return changed;
}

// Backfill für location_chapters: ergänzt fehlende Kapitel-Zuordnungen aus
// scene_locations → figure_scenes.chapter_id. Nutzt INSERT OR IGNORE — bestehende
// Einträge (Primary-Key location_id+chapter_id) bleiben unverändert (haeufigkeit
// wird nicht überschrieben). Deckt Fall ab: AI liefert für Ort kein kapitel-Array,
// aber Ort hängt an Szene mit aufgelöstem chapter_id.
function backfillLocationChaptersFromScenes(bookId, userEmail) {
  const emailCond = userEmail ? 'fs.user_email = ?' : 'fs.user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];
  db.prepare(`
    INSERT OR IGNORE INTO location_chapters (location_id, chapter_id, haeufigkeit)
    SELECT sl.location_id, fs.chapter_id, COUNT(*)
    FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    WHERE fs.book_id = ? AND ${emailCond} AND fs.chapter_id IS NOT NULL AND fs.stale = 0
    GROUP BY sl.location_id, fs.chapter_id
  `).run(bookId, ...emailVal);
}


/** Schauplätze eines Kapitels. Fallback: alle Buchorte, wenn keine Kapitelzuordnung existiert.
 *  Liefert: [{ name, typ, beschreibung, stimmung }] */
function getChapterLocations(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const em = userEmail || null;
  const cols = 'l.name, l.typ, l.beschreibung, l.stimmung';
  if (chapterId) {
    const rows = db.prepare(`
      SELECT ${cols} FROM locations l
      JOIN location_chapters lc ON lc.location_id = l.id
      WHERE l.book_id = ? AND lc.chapter_id = ? AND l.user_email IS ?
      ORDER BY lc.haeufigkeit DESC, l.sort_order, l.id
    `).all(bookId, chapterId, em);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ${cols} FROM locations l
    WHERE l.book_id = ? AND l.user_email IS ?
    ORDER BY l.sort_order, l.id
  `).all(bookId, em);
}

module.exports = {
  planOrteMatch,
  saveOrteToDb,
  patchOrtCoords,
  backfillLocationChaptersFromScenes,
  getChapterLocations,
};
