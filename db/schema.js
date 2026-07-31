// Facade: verteilt Schema-/Migrations-Setup und die verbliebenen DB-Helfer
// auf dedizierte Module, exportiert alles gebündelt. Ladereihenfolge matters:
// migrations muss vor allen Modulen laufen, die Prepared Statements auf
// migrierten Spalten anlegen.
const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

const figures = require('./figures');
const pages = require('./pages');
const pdfExport = require('./pdf-export');
const fonts = require('./fonts');
const books = require('./books');
const tokenUsage = require('./token-usage');
const { recordJobLedger } = require('./cost-ledger');
const draftFigures = require('./draft-figures');
const sources = require('./sources');
const motifs = require('./motifs');
const { parseDatum } = require('../lib/datum-parse');
const { normEventSubtyp } = require('./event-subtyp');
const { matchLocations } = require('../lib/entity-match');
const logger = require('../logger');

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

// Schreib-Guard für user_email auf den Tabellen mit FK auf app_users(email)
// (job_checkpoints, zeitstrahl_events und die Delta-Caches für Extract, Review,
// Makro-Review, Lektorat, Synonyme, Finetune-Augmentation). Die Spalten tragen
// dort ein NOT NULL DEFAULT '' — ein Leerstring ist aber keine app_users-Zeile,
// der Write liefe also in einen FK-Constraint-Fehler aus dem Prepared Statement,
// der nicht verrät, welcher Aufrufer ohne User-Kontext lief. Deshalb hier hart
// abbrechen statt auf '' zu coalescen. Lese- und Löschpfade behalten das
// Coalescing: dort ist der Effekt ein Cache-Miss bzw. ein No-Op.
function _requireUserEmail(userEmail, what) {
  const e = userEmail == null ? '' : String(userEmail).trim();
  if (!e) throw new Error(`${what}: user_email fehlt — Schreibzugriff ohne User-Kontext.`);
  return e;
}

// Strukturierte Datums-Felder aus AI-Output extrahieren; fehlt etwas, parseDatum
// als Fallback. Liefert Felder, die direkt in zeitstrahl_events/figure_events
// eingefügt werden können.
function _structuredDatum(ev) {
  const labelSrc = ev.datum_label || ev.datum || '';
  const p = parseDatum(labelSrc);
  return {
    datum_label:       (ev.datum_label || ev.datum || p.label || '').toString(),
    datum_year:        ev.datum_year        ?? p.year      ?? null,
    datum_month:       ev.datum_month       ?? p.month     ?? null,
    datum_day:         ev.datum_day         ?? p.day       ?? null,
    datum_ende_year:   ev.datum_ende_year   ?? null,
    datum_ende_month:  ev.datum_ende_month  ?? null,
    datum_ende_day:    ev.datum_ende_day    ?? null,
    story_tag:         ev.story_tag         ?? p.story_tag ?? null,
    // Nur sinnvoll, wenn ein Jahr vorliegt; ohne datum_year ist "unsicher" bedeutungslos.
    datum_unsicher:    (ev.datum_unsicher && (ev.datum_year ?? p.year) != null) ? 1 : 0,
    subtyp:            normEventSubtyp(ev.subtyp),
  };
}

// ── Job-Laufzeiten ────────────────────────────────────────────────────────────
const _stmtInsJobRun = db.prepare(
  `INSERT INTO job_runs (job_id, type, book_id, user_email, label, provider, model, status, queued_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ${NOW_ISO_SQL})`
);
const _stmtStartJobRun = db.prepare(
  `UPDATE job_runs SET status = 'running', started_at = ${NOW_ISO_SQL} WHERE job_id = ?`
);
const _stmtEndJobRun = db.prepare(
  `UPDATE job_runs SET status = ?, ended_at = ${NOW_ISO_SQL}, tokens_in = ?, tokens_out = ?, cache_read_in = ?, cache_creation_in = ?, cache_creation_1h_in = ?, tokens_per_sec = ?, error = ?, error_params = ? WHERE job_id = ?`
);

function insertJobRun(job) {
  // bookId normalisieren: System-Jobs (Backfill, Synonym ohne Buch, …) übergeben
  // 0 als „kein Buchkontext". Mig 83 hat die books-Sentinel-Zeile (book_id=0)
  // entfernt → FK `job_runs.book_id REFERENCES books(book_id)` würde brechen.
  // Nicht-positive / nicht-numerische Werte daher als NULL persistieren.
  const bookNum = Number(job.bookId);
  const bookId = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : null;
  _stmtInsJobRun.run(
    job.id, job.type, bookId, job.userEmail || null, job.label || null,
    job.provider || null, job.model || null,
  );
}
function startJobRun(jobId) {
  _stmtStartJobRun.run(jobId);
}
function endJobRun(jobId, status, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, tokensPerSec, error, errorParams = null) {
  const paramsJson = errorParams ? JSON.stringify(errorParams) : null;
  _stmtEndJobRun.run(
    status,
    tokensIn || 0, tokensOut || 0,
    cacheReadIn || 0, cacheCreationIn || 0, cacheCreation1hIn || 0,
    tokensPerSec ?? null, error || null, paramsJson, jobId,
  );
  // Eingefrorene Kosten ins persistente Ledger schreiben (chat-sourced Typen
  // werden dort uebersprungen — ihr Verbrauch laeuft ueber chat_messages).
  recordJobLedger(jobId);
}

/** Setzt alle hängenden job_runs (status 'running' oder 'queued') auf 'error'.
 *  Gibt die Anzahl bereinigter Einträge zurück. */
function cleanupStuckJobRuns() {
  const result = db.prepare(
    `UPDATE job_runs SET status = 'error', ended_at = ${NOW_ISO_SQL}, error = 'Job-Prozess gestorben (Server-Neustart oder Absturz)'
     WHERE status IN ('running', 'queued')`
  ).run();
  return result.changes;
}

// KI liefert in Listenfeldern (figuren/kapitel/seiten) gelegentlich Objekte
// statt blanker Strings — z.B. `{name: 'Renate', id: 'fig-3'}` oder
// `{name: 'Olten', haeufigkeit: 2}`. Vor dem Persistieren auf String reduzieren,
// damit Renderer nicht "[object Object]" ausgeben.
function _toRefString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

// Geo-Koordinate als Number normalisieren + auf gueltigen Bereich clampen.
// Fremd-Input (Nominatim / Marker-Drag) → null bei NaN/leer, sonst geklemmt.
function _clampCoord(v, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-max, Math.min(max, n));
}

// ── Konsolidierter Zeitstrahl ─────────────────────────────────────────────────
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
    const { rows: figRows, byFigId: figIdToRowId } = figures.figIdMaps(bookId, userEmail);
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

// ── Orte ──────────────────────────────────────────────────────────────────────
// Reconcile statt Delete+Re-Insert, damit locations.id (und FK-Refs darauf:
// research_item_links.location_id, scene_locations …) ueber Re-Analysen stabil bleibt.
// chNameToId: optionaler Map Kapitelname → chapter_id. Wird er nicht übergeben,
// wird er aus der chapters-Tabelle aufgebaut (für UI-Endpunkt ohne Job-Kontext).
// pageNameToIdByChapter: optional. Fehlt er, wird er aus der pages-Tabelle
// aufgebaut — kapitel-scoped gegen Namenskollisionen zwischen Kapiteln.
// opts.matchBy 'name' (Komplettanalyse) | 'locId' (Default, Manual-Edit);
// opts.onMissing 'stale' (markieren) | 'delete' (Default).
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
      `SELECT id, loc_id, name, typ, lat, lng FROM locations WHERE book_id = ? AND ${emailCond}`
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
      // Zweistufig (matchLocations): exakter Name → Token-Teilmenge/-Overlap. Fängt
      // Schreibvarianten zwischen Läufen ab («Mathys AG (Bettlach)» ~ «Mathys AG
      // Produktionsstätte Bettlach»), die sonst als stale-Dublette akkumulieren.
      const locMatch = matchLocations(existing, orte);
      for (const [i, exId] of locMatch) { matchOf.set(i, exId); usedExisting.add(exId); }
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
    const { byFigId: figIdToRowId } = figures.figIdMaps(bookId, userEmail);
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

// ── Welt-Fakten ─────────────────────────────────────────────────────────────
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

// ── Job-Checkpoints ───────────────────────────────────────────────────────────
// Speichert Zwischenergebnisse für Multi-Pass-Jobs, damit diese nach einem
// Server-Neustart fortgesetzt werden können statt von vorne zu beginnen.
// user_email ist Teil des UNIQUE-Constraints (job_type, book_id, user_email)
// und FK auf app_users(email) — der Schreibpfad verlangt deshalb einen echten
// User (siehe _requireUserEmail).

const _saveCheckpoint = db.prepare(`
  INSERT INTO job_checkpoints (job_type, book_id, user_email, data, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(job_type, book_id, user_email) DO UPDATE SET
    data = excluded.data, updated_at = excluded.updated_at
`);
const _loadCheckpoint = db.prepare(
  'SELECT data FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);
const _deleteCheckpoint = db.prepare(
  'DELETE FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);

function saveCheckpoint(jobType, bookId, userEmail, data) {
  const email = _requireUserEmail(userEmail, `saveCheckpoint(${jobType})`);
  _saveCheckpoint.run(jobType, parseInt(bookId), email, JSON.stringify(data));
}
function loadCheckpoint(jobType, bookId, userEmail) {
  const row = _loadCheckpoint.get(jobType, parseInt(bookId), userEmail || '');
  return row ? JSON.parse(row.data) : null;
}
function deleteCheckpoint(jobType, bookId, userEmail) {
  _deleteCheckpoint.run(jobType, parseInt(bookId), userEmail || '');
}

// ── Delta-Cache: Phase-1-Extraktion pro Kapitel + Buch-Level ──────────────────
// pages_sig: sortierter String aus "page_id:updated_at"-Paaren aller Seiten.
// Ändert sich irgendeine Seite, ändert sich die Signatur → Cache-Miss → Neu-Extraktion.
//
// chapter_extract_cache: pro Kapitel (FK auf chapters.chapter_id, Mig 75).
//   PK (book_id, user_email, chapter_id, phase). phase ∈
//     '' (full chunk), 'figuren'/'orte' (Lokal split-Pässe),
//     'sub<N>'(:figuren|:orte)? (sub-chunk wenn Kapitel zu lang).
// book_extract_cache: Buch-Level-Single-Pass (Mig 75, kein FK-Target — book_id extern).
//
// chapterKey-Format (Legacy-API): <chapter_id>(__sub<N>)?(:phase)? oder '__singlepass__'.

function _parseChapterKey(key) {
  if (key === '__singlepass__') return { book: true };
  const m = String(key).match(/^(\d+)(__sub\d+)?(?::(.+))?$/);
  if (!m) return null;
  const chapterId = parseInt(m[1]);
  const sub = m[2] ? m[2].slice(2) : '';
  const phaseSuffix = m[3] || '';
  const phase = sub ? (phaseSuffix ? `${sub}:${phaseSuffix}` : sub) : phaseSuffix;
  return { chapterId, phase };
}

// provider in PK. Caller MUSS den resolvten Provider durchreichen,
// sonst landet Claude-Output unter '' (Backfill-Default) und Ollama-User
// kriegt es ausgeliefert.
const _loadChapterCache = db.prepare(
  `SELECT extract_json FROM chapter_extract_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_extract_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookCache = db.prepare(
  `SELECT extract_json FROM book_extract_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookCache = db.prepare(
  `INSERT OR REPLACE INTO book_extract_cache
   (book_id, user_email, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return null;
  const row = parsed.book
    ? _loadBookCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig)
    : _loadChapterCache.get(parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.extract_json); } catch { return null; }
}

function saveChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, extract, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return;
  const email = _requireUserEmail(userEmail, 'saveChapterExtractCache');
  const json = JSON.stringify(extract);
  const now = new Date().toISOString();
  if (parsed.book) {
    _saveBookCache.run(parseInt(bookId), email, provider || '', pagesSig, json, now);
  } else {
    _saveChapterCache.run(parseInt(bookId), email, parsed.chapterId, parsed.phase, provider || '', pagesSig, json, now);
  }
}

const _deleteChapterCache = db.prepare(
  `DELETE FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookCache = db.prepare(
  `DELETE FROM book_extract_cache WHERE book_id = ? AND user_email = ?`
);

function deleteChapterExtractCache(bookId, userEmail) {
  const c = _deleteChapterCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Buch-Review (Kapitelanalyse + Single-Pass-Review) ────────────
// Spart bei grossen Büchern den Kapitelanalyse-Call, wenn pages_sig identisch
// (page_id:updated_at + Prompt-Vars). chapterKey-Format identisch zum Extract-
// Cache: '<chapter_id>(__sub<N>)?' oder '__singlepass__'.
const _loadChapterReviewCache = db.prepare(
  `SELECT review_json FROM chapter_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_review_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookReviewCache = db.prepare(
  `SELECT review_json FROM book_review_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookReviewCache = db.prepare(
  `INSERT OR REPLACE INTO book_review_cache
   (book_id, user_email, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return null;
  const row = _loadChapterReviewCache.get(
    parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, review, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return;
  const email = _requireUserEmail(userEmail, 'saveChapterReviewCache');
  _saveChapterReviewCache.run(
    parseInt(bookId), email, parsed.chapterId, parsed.phase, provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function loadBookReviewCache(bookId, userEmail, pagesSig, provider = '') {
  const row = _loadBookReviewCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveBookReviewCache(bookId, userEmail, pagesSig, review, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveBookReviewCache');
  _saveBookReviewCache.run(
    parseInt(bookId), email, provider || '', pagesSig,
    JSON.stringify(review), new Date().toISOString(),
  );
}

const _deleteChapterReviewCache = db.prepare(
  `DELETE FROM chapter_review_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookReviewCache = db.prepare(
  `DELETE FROM book_review_cache WHERE book_id = ? AND user_email = ?`
);

function deleteReviewCache(bookId, userEmail) {
  const c = _deleteChapterReviewCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookReviewCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Kapitel-Makro-Review (kapitel.js) ────────────────────────────
// Single-Row pro Kapitel (Endergebnis). Sub-Chunk-Caches der Multi-Pass-Variante
// werden bewusst NICHT gecached (sehr seltener Fall, eigene Tabelle wäre Overhead).
const _loadChapterMacroReviewCache = db.prepare(
  `SELECT review_json FROM chapter_macro_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterMacroReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_macro_review_cache
   (book_id, user_email, chapter_id, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteChapterMacroReviewCache = db.prepare(
  `DELETE FROM chapter_macro_review_cache WHERE book_id = ? AND user_email = ?`
);

function loadChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, provider = '') {
  const row = _loadChapterMacroReviewCache.get(
    parseInt(bookId), userEmail || '', parseInt(chapterId), provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, review, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveChapterMacroReviewCache');
  _saveChapterMacroReviewCache.run(
    parseInt(bookId), email, parseInt(chapterId), provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function deleteChapterMacroReviewCache(bookId, userEmail) {
  return _deleteChapterMacroReviewCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Endergebnis-Cache: Tagebuch-Rückblick (rueckblick.js) ─────────────────────
// Single-Row pro (Buch, User, Zeitraum, Provider). pages_sig macht den Cache
// selbst-invalidierend bei Eintrags-Änderung im Zeitraum. provider im PK gegen
// Cross-Provider-Bleeding. Kein Monats-Delta (bewusst: Endergebnis pro zeitraum).
const _loadRueckblickCache = db.prepare(
  `SELECT result_json FROM tagebuch_rueckblick_cache
   WHERE book_id = ? AND user_email = ? AND zeitraum = ? AND provider = ? AND pages_sig = ?`
);
const _saveRueckblickCache = db.prepare(
  `INSERT OR REPLACE INTO tagebuch_rueckblick_cache
   (book_id, user_email, zeitraum, provider, pages_sig, result_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _deleteRueckblickCache = db.prepare(
  `DELETE FROM tagebuch_rueckblick_cache WHERE book_id = ? AND user_email = ?`
);

function loadRueckblickCache(bookId, userEmail, zeitraum, pagesSig, provider = '') {
  const row = _loadRueckblickCache.get(parseInt(bookId), userEmail || '', zeitraum, provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveRueckblickCache(bookId, userEmail, zeitraum, pagesSig, result, provider = '') {
  _saveRueckblickCache.run(
    parseInt(bookId), userEmail || '', zeitraum, provider || '',
    pagesSig, JSON.stringify(result),
  );
}

function deleteRueckblickCache(bookId, userEmail) {
  return _deleteRueckblickCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── History: Tagebuch-Rückblicke (dauerhaft, analog book_reviews) ─────────────
// Eine Zeile pro „Erstellen"-Lauf — re-öffenbar im Karten-History-Block.
const _insertRueckblick = db.prepare(
  `INSERT INTO tagebuch_rueckblicke (book_id, user_email, zeitraum, result_json, model, entry_count, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _listRueckblicke = db.prepare(
  `SELECT id, zeitraum, result_json, model, entry_count, created_at
   FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC LIMIT ?`
);
const _latestRueckblickJson = db.prepare(
  `SELECT result_json FROM tagebuch_rueckblicke
   WHERE book_id = ? AND user_email = ? AND zeitraum = ?
   ORDER BY created_at DESC, id DESC LIMIT 1`
);
// Aktualisiert den entry_count-Snapshot der jüngsten Zeile eines Zeitraums, ohne
// eine neue History-Zeile zu erzeugen (identisches Ergebnis nach Lösch-Vorgang).
const _touchRueckblickEntryCount = db.prepare(
  `UPDATE tagebuch_rueckblicke SET entry_count = ?
   WHERE id = (SELECT id FROM tagebuch_rueckblicke
               WHERE book_id = ? AND user_email = ? AND zeitraum = ?
               ORDER BY created_at DESC, id DESC LIMIT 1)`
);
const _deleteRueckblick = db.prepare(
  `DELETE FROM tagebuch_rueckblicke WHERE id = ? AND user_email = ?`
);

function insertRueckblick(bookId, userEmail, zeitraum, result, model = null, entryCount = null) {
  return _insertRueckblick.run(
    parseInt(bookId), userEmail || '', zeitraum,
    JSON.stringify(result), model || null,
    entryCount == null ? null : parseInt(entryCount),
  ).lastInsertRowid;
}

function touchRueckblickEntryCount(bookId, userEmail, zeitraum, entryCount) {
  return _touchRueckblickEntryCount.run(
    entryCount == null ? null : parseInt(entryCount),
    parseInt(bookId), userEmail || '', zeitraum,
  ).changes;
}

// Roher result_json-String des jüngsten History-Eintrags eines Zeitraums (oder
// null). Dient dem Dedup: identische Re-Runs / Cache-HITs erzeugen keine neue
// Zeile, nur inhaltlich abweichende Läufe werden festgehalten.
function latestRueckblickJson(bookId, userEmail, zeitraum) {
  const row = _latestRueckblickJson.get(parseInt(bookId), userEmail || '', zeitraum);
  return row ? row.result_json : null;
}

function listRueckblicke(bookId, userEmail, limit = 20) {
  return _listRueckblicke.all(parseInt(bookId), userEmail || '', limit)
    .map(r => ({ ...r, result_json: JSON.parse(r.result_json || 'null') }));
}

function deleteRueckblick(id, userEmail) {
  return _deleteRueckblick.run(parseInt(id), userEmail || '').changes;
}

// ── Delta-Cache: Synonym-Suche (synonyme.js) ──────────────────────────────────
// Key-Hash deckt wort + satz + buchtyp + locale + cacheVersion ab. Pro User.
const _loadSynonymCache = db.prepare(
  `SELECT result_json FROM synonym_cache WHERE user_email = ? AND provider = ? AND key_hash = ?`
);
const _saveSynonymCache = db.prepare(
  `INSERT OR REPLACE INTO synonym_cache (user_email, provider, key_hash, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?)`
);
const _deleteSynonymCache = db.prepare(`DELETE FROM synonym_cache WHERE user_email = ?`);

function loadSynonymCache(userEmail, keyHash, provider = '') {
  const row = _loadSynonymCache.get(userEmail || '', provider || '', keyHash);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveSynonymCache(userEmail, keyHash, result, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveSynonymCache');
  _saveSynonymCache.run(email, provider || '', keyHash, JSON.stringify(result), new Date().toISOString());
}

function deleteSynonymCache(userEmail) {
  return _deleteSynonymCache.run(userEmail || '').changes;
}

// ── Delta-Cache: Seiten-Lektorat (lektorat.js Single + Batch) ─────────────────
// Single-Row pro Seite. ctx_sig deckt updated_at, Kapitelkontext (figuren/orte/
// beziehungen), narrative, Stopwords/Regeln und cacheVersion ab.
const _loadLektoratCache = db.prepare(
  `SELECT result_json FROM lektorat_cache
   WHERE book_id = ? AND user_email = ? AND page_id = ? AND provider = ? AND ctx_sig = ?`
);
const _saveLektoratCache = db.prepare(
  `INSERT OR REPLACE INTO lektorat_cache
   (book_id, user_email, page_id, provider, ctx_sig, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteLektoratCache = db.prepare(
  `DELETE FROM lektorat_cache WHERE book_id = ? AND user_email = ?`
);

function loadLektoratCache(bookId, userEmail, pageId, ctxSig, provider = '') {
  const row = _loadLektoratCache.get(
    parseInt(bookId), userEmail || '', parseInt(pageId), provider || '', ctxSig
  );
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveLektoratCache(bookId, userEmail, pageId, ctxSig, result, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveLektoratCache');
  _saveLektoratCache.run(
    parseInt(bookId), email, parseInt(pageId), provider || '',
    ctxSig, JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteLektoratCache(bookId, userEmail) {
  return _deleteLektoratCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Delta-Cache: Finetune-AI-Augmentation ─────────────────────────────────────
// Cache-Key: (book_id, user_email, scope, scope_key, version).
// scope: 'reverse-prompts' | 'fact-qa' | 'reasoning-backfill'
// scope_key: stabile Entität (z.B. 'page:42', 'figure:alice', 'corr:hash')
// sig: Inhalts-Signatur (z.B. content-Hash + Modellname). Bei sig-Mismatch wird
// der Eintrag verworfen — das verhindert Stale-Augmentations bei Textänderung.
const _loadFtAiCache = db.prepare(
  `SELECT result_json, sig FROM finetune_ai_cache
   WHERE book_id = ? AND user_email = ? AND scope = ? AND scope_key = ? AND version = ?`
);
const _saveFtAiCache = db.prepare(
  `INSERT OR REPLACE INTO finetune_ai_cache
   (book_id, user_email, scope, scope_key, sig, version, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _deleteFtAiCache = db.prepare(
  `DELETE FROM finetune_ai_cache WHERE book_id = ? AND user_email = ?`
);

function loadFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version) {
  const row = _loadFtAiCache.get(parseInt(bookId), userEmail || '', scope, scopeKey, version);
  if (!row) return null;
  if (row.sig !== sig) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version, result) {
  const email = _requireUserEmail(userEmail, `saveFinetuneAiCache(${scope})`);
  _saveFtAiCache.run(
    parseInt(bookId), email, scope, scopeKey, sig, version,
    JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteFinetuneAiCache(bookId, userEmail) {
  return _deleteFtAiCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Buch-Einstellungen (Sprache + Region) ─────────────────────────────────────

// Quellenverzeichnis-Defaults: einmal deklariert, von Row-Mapping und beiden
// Fallback-Pfaden in getBookSettings geteilt. Die Werte spiegeln die
// Spalten-Defaults aus Migration 252 — driften sie auseinander, sieht ein Buch
// ohne book_settings-Zeile andere Einstellungen als eines mit.
const CITATION_DEFAULTS = Object.freeze({
  citation_style: 'apa7',
  citation_notes: 'inline',
  bibliography_enabled: 0,
  bibliography_title: null,
  bibliography_scope: 'cited',
  bibliography_in_blog: 0,
});
const VALID_CITATION_STYLES = ['apa7', 'chicago-ad', 'numeric'];
// Deckungsgleich mit CITATION_NOTES_MODES in lib/endnotes.js — laufen die
// auseinander, faellt der Schreibpfad stumm auf 'inline' zurueck.
const VALID_CITATION_NOTES = ['inline', 'endnotes', 'footnotes'];
const VALID_BIBLIOGRAPHY_SCOPES = ['cited', 'all'];

// Querverweis-Defaults (Migration 255). Steht aus demselben Grund in
// book_settings wie der Zitierstil: ob ein Werk seine Abbildungen nummeriert,
// gilt fuer ALLE Ausgabewege gleichzeitig und darf nicht je Exportprofil
// abweichen. Default 0 — ein Roman mit Bildern will keine „Abb. 1:"-Praefixe.
const XREF_DEFAULTS = Object.freeze({
  figure_numbering: 0,
});

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, entities_enabled, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, figure_numbering FROM book_settings WHERE book_id = ?');
const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    stilprofil=excluded.stilprofil,
    erzaehlperspektive=excluded.erzaehlperspektive, erzaehlzeit=excluded.erzaehlzeit,
    is_finished=excluded.is_finished,
    allow_lektor_book_chat=excluded.allow_lektor_book_chat,
    daily_goal_chars=excluded.daily_goal_chars,
    goal_target_chars=excluded.goal_target_chars,
    goal_deadline=excluded.goal_deadline,
    orte_real=excluded.orte_real,
    schauplatz_land=excluded.schauplatz_land,
    zeitlinie_real=excluded.zeitlinie_real,
    weltfakten_real_pruefen=excluded.weltfakten_real_pruefen,
    exclude_from_stats=excluded.exclude_from_stats,
    updated_at=excluded.updated_at
`);
const _updateBookSettingsEntitiesEnabled = db.prepare(`
  INSERT INTO book_settings (book_id, entities_enabled, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    entities_enabled=excluded.entities_enabled,
    updated_at=excluded.updated_at
`);
const _updateBookStilprofil = db.prepare(`
  INSERT INTO book_settings (book_id, stilprofil, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    stilprofil=excluded.stilprofil,
    updated_at=excluded.updated_at
`);
// Quellenverzeichnis-Einstellungen als eigener Schreibpfad (Muster
// entities_enabled/stilprofil) statt als weitere Positionsargumente an
// saveBookSettings: der Quellen-Tab speichert unabhaengig vom Haupt-Formular,
// und die 18-stellige Positionsliste von saveBookSettings soll nicht weiter
// wachsen.
const _updateBookCitationSettings = db.prepare(`
  INSERT INTO book_settings (book_id, citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog, citation_notes, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    citation_style=excluded.citation_style,
    bibliography_enabled=excluded.bibliography_enabled,
    bibliography_title=excluded.bibliography_title,
    bibliography_scope=excluded.bibliography_scope,
    bibliography_in_blog=excluded.bibliography_in_blog,
    citation_notes=excluded.citation_notes,
    updated_at=excluded.updated_at
`);
// Querverweis-Einstellungen, eigener Schreibpfad aus demselben Grund.
const _updateBookXrefSettings = db.prepare(`
  INSERT INTO book_settings (book_id, figure_numbering, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    figure_numbering=excluded.figure_numbering,
    updated_at=excluded.updated_at
`);

/** Gibt {language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, entities_enabled} für ein Buch zurück.
 *  Fehlt die book_settings-Zeile, werden – wenn vorhanden – die User-Defaults
 *  (default_language/region/buchtyp) als Fallback verwendet. `daily_goal_chars`
 *  bleibt NULL, wenn nichts gesetzt — Frontend mappt auf 1500-Default. */
function getBookSettings(bookId, userEmail = null) {
  const row = _getBookSettings.get(parseInt(bookId));
  if (row) return {
    ...row,
    is_finished: row.is_finished ? 1 : 0,
    allow_lektor_book_chat: row.allow_lektor_book_chat ? 1 : 0,
    entities_enabled: row.entities_enabled ? 1 : 0,
    orte_real: row.orte_real ? 1 : 0,
    zeitlinie_real: row.zeitlinie_real ? 1 : 0,
    weltfakten_real_pruefen: row.weltfakten_real_pruefen ? 1 : 0,
    exclude_from_stats: row.exclude_from_stats ? 1 : 0,
    citation_style: row.citation_style || CITATION_DEFAULTS.citation_style,
    bibliography_enabled: row.bibliography_enabled ? 1 : 0,
    bibliography_title: row.bibliography_title || null,
    bibliography_scope: row.bibliography_scope || CITATION_DEFAULTS.bibliography_scope,
    bibliography_in_blog: row.bibliography_in_blog ? 1 : 0,
    citation_notes: row.citation_notes || CITATION_DEFAULTS.citation_notes,
    figure_numbering: row.figure_numbering ? 1 : 0,
  };
  if (userEmail) {
    const u = require('./app-users').getUser(userEmail);
    if (u && (u.default_language || u.default_buchtyp)) {
      const language = u.default_language || 'de';
      const region   = u.default_region   || (language === 'en' ? 'US' : 'CH');
      return { language, region, buchtyp: u.default_buchtyp || null, buch_kontext: null, stilprofil: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0, daily_goal_chars: null, goal_target_chars: null, goal_deadline: null, entities_enabled: 0, orte_real: 0, schauplatz_land: null, zeitlinie_real: 0, weltfakten_real_pruefen: 0, exclude_from_stats: 0, ...CITATION_DEFAULTS, ...XREF_DEFAULTS };
    }
  }
  return { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, stilprofil: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0, daily_goal_chars: null, goal_target_chars: null, goal_deadline: null, entities_enabled: 0, orte_real: 0, schauplatz_land: null, zeitlinie_real: 0, weltfakten_real_pruefen: 0, exclude_from_stats: 0, ...CITATION_DEFAULTS, ...XREF_DEFAULTS };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId, userEmail = null) {
  const { language, region } = getBookSettings(bookId, userEmail);
  return `${language}-${region}`;
}

/** Speichert/aktualisiert Sprache, Region, Buchtyp, Buchkontext, Erzählperspektive, Erzählzeit, is_finished, allow_lektor_book_chat, daily_goal_chars.
 *  `entities_enabled` wird hier nicht angefasst — Quick-Toggle aus der Notebook-Toolbar laeuft ueber setBookEntitiesEnabled. */
function saveBookSettings(bookId, language, region, buchtyp, buchKontext, erzaehlperspektive = null, erzaehlzeit = null, isFinished = 0, allowLektorBookChat = 0, dailyGoalChars = null, orteReal = 0, schauplatzLand = null, goalTargetChars = null, goalDeadline = null, stilprofil = null, zeitlinieReal = 0, excludeFromStats = 0, weltfaktenRealPruefen = 0) {
  _upsertBookSettings.run(
    parseInt(bookId), language, region,
    buchtyp || null, buchKontext || null,
    stilprofil || null,
    erzaehlperspektive || null, erzaehlzeit || null,
    isFinished ? 1 : 0,
    allowLektorBookChat ? 1 : 0,
    dailyGoalChars == null ? null : Math.round(Number(dailyGoalChars)),
    goalTargetChars == null ? null : Math.round(Number(goalTargetChars)),
    goalDeadline || null,
    orteReal ? 1 : 0,
    schauplatzLand || null,
    zeitlinieReal ? 1 : 0,
    weltfaktenRealPruefen ? 1 : 0,
    excludeFromStats ? 1 : 0,
    new Date().toISOString()
  );
}

/** Toggle aus Notebook-Toolbar — Quick-Update nur fuer entities_enabled,
 *  ohne andere Settings anzufassen (Toolbar-Toggle laedt Form nicht). */
function setBookEntitiesEnabled(bookId, enabled) {
  _updateBookSettingsEntitiesEnabled.run(
    parseInt(bookId),
    enabled ? 1 : 0,
    new Date().toISOString()
  );
}

/** Quellenverzeichnis-Einstellungen pro Buch (Quellen-Tab der Bucheinstellungen).
 *  Eigener Schreibpfad — beruehrt keine anderen Settings. Enum-Werte werden hier
 *  hart auf die Whitelist gezwungen, damit ein Fremdwert nie in der DB landet
 *  (der Formatter kennt nur diese Stile und wuerde sonst still auf apa7 fallen). */
function setBookCitationSettings(bookId, {
  citation_style, bibliography_enabled, bibliography_title, bibliography_scope, bibliography_in_blog,
  citation_notes,
} = {}) {
  const style = VALID_CITATION_STYLES.includes(citation_style)
    ? citation_style : CITATION_DEFAULTS.citation_style;
  const scope = VALID_BIBLIOGRAPHY_SCOPES.includes(bibliography_scope)
    ? bibliography_scope : CITATION_DEFAULTS.bibliography_scope;
  const title = bibliography_title ? String(bibliography_title).trim().slice(0, 200) : null;
  _updateBookCitationSettings.run(
    parseInt(bookId), style,
    bibliography_enabled ? 1 : 0,
    title || null, scope,
    bibliography_in_blog ? 1 : 0,
    VALID_CITATION_NOTES.includes(citation_notes) ? citation_notes : CITATION_DEFAULTS.citation_notes,
    new Date().toISOString(),
  );
}

/** Querverweis-Einstellungen pro Buch. Eigener Schreibpfad — beruehrt keine
 *  anderen Settings. */
function setBookXrefSettings(bookId, { figure_numbering } = {}) {
  _updateBookXrefSettings.run(
    parseInt(bookId),
    figure_numbering ? 1 : 0,
    new Date().toISOString(),
  );
}

/** Quick-Update nur fuer stilprofil — der Stilprofil-Extraktions-Job persistiert
 *  sein Ergebnis, ohne die uebrigen Settings (die er nicht geladen hat) zu beruehren. */
function setBookStilprofil(bookId, stilprofil) {
  _updateBookStilprofil.run(
    parseInt(bookId),
    stilprofil || null,
    new Date().toISOString()
  );
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────
// Eine Zeile pro Issue (continuity_issues) plus Bridge-Tabellen für Figuren-/
// Kapitel-Referenzen. Vorbild: figure_scenes mit scene_figures/scene_locations.

const _insContinuityCheck = db.prepare(
  `INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model)
   VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?)`
);
const _insContinuityIssue = db.prepare(
  `INSERT INTO continuity_issues
   (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle, sort_order, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _insContinuityIssueFig = db.prepare(
  `INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`
);
const _insContinuityIssueCh = db.prepare(
  `INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, ?)`
);

/** Speichert einen Kontinuitäts-Check mit allen Issues als eigene Zeilen.
 *  issues: [{schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung,
 *            figuren:[Namen], kapitel:[Namen]}]
 *  figNameToId / chNameToId: Auflösungs-Maps (Name → fig_id / chapter_id).
 *  Gibt { checkId, normalizedIssues } zurück, wobei normalizedIssues die
 *  Frontend-Form mit fig_ids/chapter_ids enthält (kompatibel zur alten Antwort). */
// Eine Issue-Zeile + Figuren-/Kapitel-Bridges anlegen und die Frontend-Normalform
// zurückgeben. Geteilt von saveContinuityCheck (Voll-Check) und saveFaktencheckIssues
// (Anhang an bestehenden Check). figIdToRowId: TEXT-fig_id → INTEGER figures.id.
function _persistOneContinuityIssue(cid, bookIdInt, email, it, sortIndex, figNameToId, figIdToRowId, chNameToId) {
  const { lastInsertRowid: issueId } = _insContinuityIssue.run(
    cid, bookIdInt, email,
    it.schwere || null, it.typ || null, it.beschreibung || null,
    it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
    it.quelle || null,
    sortIndex,
  );
  const figNames = Array.isArray(it.figuren) ? it.figuren.map(_toRefString).filter(Boolean) : [];
  const fig_ids = [];
  const seenFig = new Set();
  figNames.forEach((name, j) => {
    const fid = figNameToId?.[name] || null;
    const key = (fid || '') + '|' + name;
    if (seenFig.has(key)) return;
    seenFig.add(key);
    if (fid) fig_ids.push(fid);
    const figureRowId = fid ? (figIdToRowId[fid] ?? null) : null;
    _insContinuityIssueFig.run(issueId, figureRowId, name, j);
  });
  const chNames = Array.isArray(it.kapitel) ? it.kapitel.map(_toRefString).filter(Boolean) : [];
  const chapter_ids = [];
  const seenCh = new Set();
  chNames.forEach((name, j) => {
    const cidCh = chNameToId?.[name] ?? null;
    const key = (cidCh ?? '') + '|' + name;
    if (seenCh.has(key)) return;
    seenCh.add(key);
    if (cidCh != null) chapter_ids.push(cidCh);
    if (cidCh != null) _insContinuityIssueCh.run(issueId, cidCh, j);
  });
  return {
    id: issueId,
    schwere: it.schwere || null, typ: it.typ || null,
    beschreibung: it.beschreibung || null,
    stelle_a: it.stelle_a || null, stelle_b: it.stelle_b || null,
    empfehlung: it.empfehlung || null,
    quelle: it.quelle || null,
    figuren: figNames, fig_ids,
    kapitel: chNames, chapter_ids,
  };
}

function _figIdToRowIdMap(bookIdInt, email) {
  // continuity_issue_figures.figure_id ist INTEGER (figures.id) seit Mig 73 —
  // figNameToId liefert TEXT-fig_id, zusaetzlicher Lookup TEXT → INT.
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  return Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
}

function saveContinuityCheck(bookId, userEmail, summary, model, issues, figNameToId, chNameToId) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const normalizedIssues = [];
  let checkId = null;
  const figIdToRowId = _figIdToRowIdMap(bookIdInt, email);
  db.transaction(() => {
    const { lastInsertRowid: cid } = _insContinuityCheck.run(
      bookIdInt, email, summary || '', model || null,
    );
    checkId = cid;
    const issuesArr = Array.isArray(issues) ? issues : [];
    for (let i = 0; i < issuesArr.length; i++) {
      const { id, ...rest } = _persistOneContinuityIssue(cid, bookIdInt, email, issuesArr[i] || {}, i, figNameToId, figIdToRowId, chNameToId);
      normalizedIssues.push(rest);
    }
  })();
  return { checkId, normalizedIssues };
}

// Faktencheck-Befunde (typ='faktenfehler') an den NEUESTEN Kontinuitäts-Check anhängen,
// statt einen konkurrierenden Check anzulegen (getLatestContinuityCheck zeigt nur den
// neuesten → ein eigener Check würde die Kontinuitäts-Befunde verdecken). Idempotent:
// vorhandene faktenfehler-Zeilen dieses Checks werden zuerst gelöscht (Bridges via CASCADE),
// dann die neuen eingefügt. Gibt es noch keinen Check (Faktencheck vor jeder Komplettanalyse),
// wird einer angelegt. summaryFallback nur für diesen Neuanlage-Fall. Die Kontinuitäts-Befunde
// (andere typ) des Checks bleiben unberührt. */
function saveFaktencheckIssues(bookId, userEmail, model, issues, figNameToId, chNameToId, summaryFallback = '') {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const figIdToRowId = _figIdToRowIdMap(bookIdInt, email);
  const issuesArr = Array.isArray(issues) ? issues : [];
  const normalizedIssues = [];
  db.transaction(() => {
    let row = db.prepare(
      'SELECT id FROM continuity_checks WHERE book_id = ? AND user_email IS ? ORDER BY checked_at DESC LIMIT 1'
    ).get(bookIdInt, email);
    let cid = row?.id;
    if (!cid) {
      ({ lastInsertRowid: cid } = _insContinuityCheck.run(bookIdInt, email, summaryFallback || '', model || null));
    } else {
      db.prepare("DELETE FROM continuity_issues WHERE check_id = ? AND typ = 'faktenfehler'").run(cid);
    }
    // Neue faktenfehler ans Ende einsortieren (sort_order nach den bestehenden Issues).
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM continuity_issues WHERE check_id = ?').get(cid).m;
    for (let i = 0; i < issuesArr.length; i++) {
      const { id, ...rest } = _persistOneContinuityIssue(cid, bookIdInt, email, issuesArr[i] || {}, maxSort + 1 + i, figNameToId, figIdToRowId, chNameToId);
      normalizedIssues.push(rest);
    }
  })();
  return { normalizedIssues };
}

/** Lädt den letzten Kontinuitäts-Check eines Buchs in Frontend-Form
 *  ({id, checked_at, issues:[{...}], summary, model}) oder null. */
function getLatestContinuityCheck(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const row = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookIdInt, email);
  if (!row) return null;
  const issueRows = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle, resolved
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(row.id);
  const figRows = db.prepare(`
    SELECT cif.issue_id, f.fig_id, cif.figur_name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cif.issue_id, cif.sort_order
  `).all(row.id);
  const chRows = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cic.issue_id, cic.sort_order
  `).all(row.id);
  const figByIssue = new Map();
  for (const r of figRows) {
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, { figuren: [], fig_ids: [] });
    const bucket = figByIssue.get(r.issue_id);
    if (r.figur_name) bucket.figuren.push(r.figur_name);
    if (r.fig_id) bucket.fig_ids.push(r.fig_id);
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, { kapitel: [], chapter_ids: [] });
    const bucket = chByIssue.get(r.issue_id);
    if (r.chapter_name) bucket.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) bucket.chapter_ids.push(r.chapter_id);
  }
  const issues = issueRows.map(r => ({
    id: r.id,
    resolved: !!r.resolved,
    schwere: r.schwere, typ: r.typ, beschreibung: r.beschreibung,
    stelle_a: r.stelle_a, stelle_b: r.stelle_b, empfehlung: r.empfehlung,
    quelle: r.quelle || null,
    figuren: figByIssue.get(r.id)?.figuren || [],
    fig_ids: figByIssue.get(r.id)?.fig_ids || [],
    kapitel: chByIssue.get(r.id)?.kapitel || [],
    chapter_ids: chByIssue.get(r.id)?.chapter_ids || [],
  }));
  return { id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model };
}

/** book_id eines Issues (fuer ACL/Log-Context vor der Mutation). null wenn unbekannt. */
function getContinuityIssueBookId(issueId) {
  const id = parseInt(issueId);
  if (!id) return null;
  const row = db.prepare('SELECT book_id FROM continuity_issues WHERE id = ?').get(id);
  return row ? row.book_id : null;
}

/** Setzt das resolved-Flag eines Kontinuitaets-Issues. resolved_at = jetzt bzw.
 *  null beim Wiederoeffnen. Gibt true zurueck, wenn eine Zeile betroffen war. */
function setContinuityIssueResolved(issueId, resolved) {
  const id = parseInt(issueId);
  if (!id) return false;
  const now = resolved ? new Date().toISOString() : null;
  const info = db.prepare(
    'UPDATE continuity_issues SET resolved = ?, resolved_at = ? WHERE id = ?'
  ).run(resolved ? 1 : 0, now, id);
  return info.changes > 0;
}

// ── Musik (Songs) ────────────────────────────────────────────────────────────
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

// ── Schauplätze eines Kapitels (via location_chapters) ───────────────────────

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

// ── Kapitel-Erzählprofil (Komplettanalyse-Phase) ─────────────────────────────
// Full-Replace pro (Buch, User): die Phase regeneriert das gesamte Profil bei jedem
// Lauf (nur wenn der Konsolidierungs-Checkpoint nicht greift). Themen als CASCADE-Kind.
function saveChapterNarrativeProfiles(bookId, userEmail, profiles, chNameToId, figNameToId, declared) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const list = Array.isArray(profiles) ? profiles : [];
  // TEXT-fig_id (KI/Katalog) → INTEGER figures.id (FK-Target).
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
  // Soll-Erzählform aus book_settings (Keys, nicht Labels). 'gemischt' ist als Soll
  // absichtlich tolerant → dann nie als Abweichung werten (jeder Wechsel erlaubt).
  const declaredP = declared?.erzaehlperspektive || null;
  const declaredT = declared?.erzaehlzeit || null;
  let saved = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM chapter_narrative_profile WHERE book_id = ? AND user_email IS ?').run(bookIdInt, email);
    const insP = db.prepare(`INSERT INTO chapter_narrative_profile
      (book_id, user_email, chapter_id, perspektive, erzaehlzeit, erzaehler_figur_id, erzaehler_figur,
       pov_konfidenz, pov_beleg, pov_abweichung, intensitaet, intensitaet_begruendung, zusammenfassung, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insT = db.prepare(
      'INSERT INTO chapter_narrative_themes (profile_id, thema, typ, belege, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    list.forEach((p, i) => {
      const chId = (p.kapitel != null && chNameToId?.[p.kapitel] != null) ? chNameToId[p.kapitel] : null;
      const figName = p.erzaehler_figur ? String(p.erzaehler_figur).trim() : '';
      const figTextId = figName ? (figNameToId?.[figName] || null) : null;
      const figRowId = figTextId ? (figIdToRowId[figTextId] ?? null) : null;
      const persp = p.perspektive || null;
      const zeit  = p.erzaehlzeit || null;
      // Abweichung nur bei deklariertem, nicht-'gemischt'-Soll und abweichendem Ist.
      let abw = 0;
      if (declaredP && declaredP !== 'gemischt' && persp && persp !== declaredP) abw = 1;
      if (declaredT && declaredT !== 'gemischt' && zeit && zeit !== declaredT) abw = 1;
      const konf  = (typeof p.pov_konfidenz === 'number' && isFinite(p.pov_konfidenz))
        ? Math.max(0, Math.min(1, p.pov_konfidenz)) : null;
      const inten = Number.isFinite(p.intensitaet)
        ? Math.max(1, Math.min(5, Math.round(p.intensitaet))) : null;
      // Klarnamen-Fallback nur speichern, wenn keine FK aufgelöst werden konnte
      // (Snapshot-Vermeidung – aufgelöste Namen kommen zur Lesezeit per JOIN).
      const { lastInsertRowid: pid } = insP.run(
        bookIdInt, email, chId, persp, zeit, figRowId, figRowId ? null : (figName || null),
        konf, p.pov_beleg || null, abw, inten, p.intensitaet_begruendung || null, p.zusammenfassung || null, i,
      );
      const themen = Array.isArray(p.themen) ? p.themen : [];
      themen.forEach((t, j) => {
        const thema = (t && typeof t === 'object') ? (t.thema || '') : String(t || '');
        const trimmed = String(thema).trim();
        if (!trimmed) return;
        // belege: Array wörtlicher Zitate → JSON. Legacy-Einzelstring (t.beleg)
        // wird tolerant ins Array gehoben. Leeres/kein Beleg → NULL.
        const rawBelege = (t && typeof t === 'object')
          ? (Array.isArray(t.belege) ? t.belege : (t.beleg != null ? [t.beleg] : []))
          : [];
        const belegeArr = rawBelege.map(b => String(b || '').trim()).filter(Boolean);
        const belege = belegeArr.length ? JSON.stringify(belegeArr) : null;
        insT.run(pid, trimmed, (t && typeof t === 'object' && t.typ) || null, belege, j);
      });
      saved++;
    });
  })();
  return saved;
}

/** Liest das aktuelle Kapitel-Erzählprofil eines Buchs (inkl. Themen + deklarierter
 *  Soll-Erzählform für den Abweichungs-Abgleich in der Karte). */
function getChapterNarrativeProfile(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const rows = db.prepare(`
    SELECT p.id, p.chapter_id, c.chapter_name, p.perspektive, p.erzaehlzeit,
           p.erzaehler_figur_id, f.name AS erzaehler_figur_name, p.erzaehler_figur,
           p.pov_konfidenz, p.pov_beleg, p.pov_abweichung, p.intensitaet,
           p.intensitaet_begruendung, p.zusammenfassung, p.sort_order, p.updated_at
      FROM chapter_narrative_profile p
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
      LEFT JOIN figures  f ON f.id = p.erzaehler_figur_id
     WHERE p.book_id = ? AND p.user_email IS ?
     ORDER BY p.sort_order, p.id
  `).all(bookIdInt, email);
  const bs = getBookSettings(bookIdInt, email);
  const declared = { erzaehlperspektive: bs?.erzaehlperspektive || null, erzaehlzeit: bs?.erzaehlzeit || null };
  if (!rows.length) return { chapters: [], declared, updated_at: null };
  const themeRows = db.prepare(`
    SELECT profile_id, thema, typ, belege FROM chapter_narrative_themes
     WHERE profile_id IN (SELECT id FROM chapter_narrative_profile WHERE book_id = ? AND user_email IS ?)
     ORDER BY profile_id, sort_order, id
  `).all(bookIdInt, email);
  const parseBelege = (raw) => {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(b => String(b || '').trim()).filter(Boolean) : [];
    } catch { return String(raw).trim() ? [String(raw).trim()] : []; }
  };
  const byPid = new Map();
  for (const t of themeRows) {
    if (!byPid.has(t.profile_id)) byPid.set(t.profile_id, []);
    byPid.get(t.profile_id).push({ thema: t.thema, typ: t.typ, belege: parseBelege(t.belege) });
  }
  // Abweichung zur Lese-Zeit aus der aktuellen Soll-Erzählform berechnen (statt aus
  // dem beim Lauf gespeicherten Flag) — so bleibt die Anzeige korrekt, auch wenn der
  // Autor die Soll-Perspektive/-zeit nach dem Analyselauf ändert, und Perspektiv- vs.
  // Tempus-Abweichung sind getrennt. 'gemischt' als Soll ist tolerant (nie Abweichung).
  const deviates = (soll, ist) => !!(soll && soll !== 'gemischt' && ist && ist !== soll);
  const chapters = rows.map(r => ({
    chapter_id: r.chapter_id,
    kapitel: r.chapter_name || null,
    perspektive: r.perspektive,
    erzaehlzeit: r.erzaehlzeit,
    erzaehler_figur_id: r.erzaehler_figur_id,
    erzaehler_figur: r.erzaehler_figur_name || r.erzaehler_figur || null,
    pov_konfidenz: r.pov_konfidenz,
    pov_beleg: r.pov_beleg,
    pov_abweichung: deviates(declared.erzaehlperspektive, r.perspektive),
    tempus_abweichung: deviates(declared.erzaehlzeit, r.erzaehlzeit),
    intensitaet: r.intensitaet,
    intensitaet_begruendung: r.intensitaet_begruendung,
    zusammenfassung: r.zusammenfassung,
    themen: byPid.get(r.id) || [],
  }));
  return { chapters, declared, updated_at: rows[0]?.updated_at || null };
}

module.exports = {
  db,
  saveChapterNarrativeProfiles,
  getChapterNarrativeProfile,
  // figures
  saveFigurenToDb:          figures.saveFigurenToDb,
  addFigurenBeziehungen:    figures.addFigurenBeziehungen,
  updateFigurenEvents:      figures.updateFigurenEvents,
  updateFigurenSoziogramm:  figures.updateFigurenSoziogramm,
  cleanupDuplicateFiguren:  figures.cleanupDuplicateFiguren,
  getChapterFigures:        figures.getChapterFigures,
  getChapterFigureRelations: figures.getChapterFigureRelations,
  getFigureWithDetails:     figures.getFigureWithDetails,
  backfillAppearancesFromScenesEvents: figures.backfillAppearancesFromScenesEvents,
  // locations
  getChapterLocations,
  // motifs (Soll-Kontext fürs Lektorat)
  getPageMotifs:            motifs.getPageMotifs,
  // pages
  reconcilePageIds:   pages.reconcilePageIds,
  pruneStaleBookData: pages.pruneStaleBookData,
  // books
  upsertBook:         books.upsertBook,
  upsertBookByName:   books.upsertBookByName,
  getBookName:        books.getBookName,
  pruneStaleByAge:    books.pruneStaleByAge,
  // local
  saveZeitstrahlEvents,
  saveOrteToDb,
  patchOrtCoords,
  saveFaktenToDb,
  saveSongsToDb,
  backfillLocationChaptersFromScenes,
  saveContinuityCheck,
  saveFaktencheckIssues,
  getLatestContinuityCheck,
  getContinuityIssueBookId,
  setContinuityIssueResolved,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  insertJobRun, startJobRun, endJobRun, cleanupStuckJobRuns,
  getDailyTokenUsage:    tokenUsage.getDailyTokenUsage,
  getDailyTotalsByUser:  tokenUsage.getDailyTotalsByUser,
  getBookSettings, getBookLocale, saveBookSettings, setBookEntitiesEnabled, setBookStilprofil,
  setBookCitationSettings, VALID_CITATION_STYLES, VALID_BIBLIOGRAPHY_SCOPES, VALID_CITATION_NOTES,
  setBookXrefSettings,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
  loadChapterReviewCache, saveChapterReviewCache,
  loadBookReviewCache, saveBookReviewCache, deleteReviewCache,
  loadChapterMacroReviewCache, saveChapterMacroReviewCache, deleteChapterMacroReviewCache,
  loadRueckblickCache, saveRueckblickCache, deleteRueckblickCache,
  insertRueckblick, touchRueckblickEntryCount, latestRueckblickJson, listRueckblicke, deleteRueckblick,
  loadSynonymCache, saveSynonymCache, deleteSynonymCache,
  loadLektoratCache, saveLektoratCache, deleteLektoratCache,
  loadFinetuneAiCache, saveFinetuneAiCache, deleteFinetuneAiCache,
  // pdf-export profiles
  listPdfExportProfiles:  pdfExport.listProfiles,
  getPdfExportProfile:    pdfExport.getProfile,
  createPdfExportProfile: pdfExport.createProfile,
  updatePdfExportProfile: pdfExport.updateProfile,
  deletePdfExportProfile: pdfExport.deleteProfile,
  setPdfExportProfileBackCover:   pdfExport.setBackCover,
  clearPdfExportProfileBackCover: pdfExport.clearBackCover,
  getPdfExportProfileBackCover:   pdfExport.getBackCover,
  setPdfExportProfileSpineImage:   pdfExport.setSpineImage,
  clearPdfExportProfileSpineImage: pdfExport.clearSpineImage,
  getPdfExportProfileSpineImage:   pdfExport.getSpineImage,
  setPdfExportProfileDefault: pdfExport.setDefault,
  // fonts
  getCachedFont: fonts.getCachedFont,
  cacheFont:     fonts.cacheFont,
  // draft figures (Figuren-Werkstatt)
  listDraftFigures:        draftFigures.listDraftFigures,
  getDraftFigure:          draftFigures.getDraftFigure,
  getDraftFigureBySource:  draftFigures.getDraftFigureBySource,
  createDraftFigure:       draftFigures.createDraftFigure,
  updateDraftFigure:       draftFigures.updateDraftFigure,
  deleteDraftFigure:       draftFigures.deleteDraftFigure,
  // Quellen-Bibliothek (User-Pool `sources` + Bruecke `book_source_links`
  // + abgeleiteter Fund-Index `source_citations`)
  CSL_TYPES:              sources.CSL_TYPES,
  normalizeSourcePersons: sources.normalizePersons,
  listSources:            sources.listSources,
  listPoolSources:        sources.listPoolSources,
  getSource:              sources.getSource,
  countSources:           sources.countSources,
  findSourceByUrl:        sources.findSourceByUrl,
  createSource:           sources.createSource,
  updateSource:           sources.updateSource,
  deleteSource:           sources.deleteSource,
  linkSource:             sources.linkSource,
  unlinkSource:           sources.unlinkSource,
  isSourceLinked:         sources.isSourceLinked,
  listSourceBooks:        sources.listSourceBooks,
  replacePageCitations:   sources.replacePageCitations,
  listBookCitations:      sources.listBookCitations,
  listPageCitations:      sources.listPageCitations,
  getBookQuoteStats:      sources.getBookQuoteStats,
  setSourceDoc:           sources.setSourceDoc,
  clearSourceDoc:         sources.clearSourceDoc,
  getSourceDocMeta:       sources.getSourceDocMeta,
  getSourceDocBlob:       sources.getSourceDocBlob,
  getSourceDocText:       sources.getSourceDocText,
  markSourceIndexed:      sources.markSourceIndexed,
  insertWerkstattRun:      draftFigures.insertWerkstattRun,
  listWerkstattRuns:       draftFigures.listWerkstattRuns,
  getWerkstattRun:         draftFigures.getWerkstattRun,
  deleteWerkstattRun:      draftFigures.deleteWerkstattRun,
};
