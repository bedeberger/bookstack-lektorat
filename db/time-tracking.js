'use strict';
// Zeit-Tracking der drei Heartbeat-Zaehler (Schreibzeit, Diktat, Lektoratszeit).
//
// Die drei sind dieselbe Mechanik mit unterschiedlichem Umfang: der Client
// meldet in festem Takt einen Sekunden-Delta, der Server clamped und summiert
// pro (User, Buch, Tag) auf, und der Lesepfad liefert Aggregat + Tagesreihe.
// Darum EINE Spec-Tabelle statt dreier wortgleicher Modul-Kopien — ein vierter
// Zaehler ist ein Eintrag in TRACKERS, kein neues Modul.
//
// Was pro Tracker wirklich unterschiedlich ist, steht in der Spec:
//   extraCols  — zusaetzlich summierte Spalten (Diktat zaehlt auch Zeichen)
//   scopeCol   — zusaetzliche Dimension im Primaerschluessel (Lektorat pro Seite)
//   perPage    — Lesepfad liefert zusaetzlich die Aufschluesselung je Seite
//   sideEffects— abgeleitete Nebenbuecher (Schreibzeit fuehrt Stunden-Histogramm
//                und Sessions mit)
//
// Der Seitennamen-JOIN des Lektorat-Lesepfads lebt hier und nicht im Route-
// Handler (CLAUDE.md: "Content-Store-Facade als einziger Eintrittspunkt" gilt
// auch fuer den blossen Namens-JOIN).

const { db } = require('./connection');

// Server-Clamp pro Ping: ein Uhrensprung oder ein manipulierter Wert darf die
// Tagessumme nicht verbiegen. Der Heartbeat kommt alle ~30 s.
const MAX_SECONDS_PER_PING = 3600;
const MAX_CHARS_PER_PING = 100000;

// Zwei aufeinanderfolgende writing-time-Pings gelten als dieselbe Schreib-
// Session, solange zwischen ihnen hoechstens so viele Sekunden liegen. Eine
// Pause laenger als 15 min zaehlt als Session-Ende.
const SESSION_GAP_SECONDS = 900;

// --- Nebenbuecher der Schreibzeit -------------------------------------------

// Tageszeit-Histogramm: denselben Delta der aktuellen lokalen Stunde zuschlagen.
// Lebenslang aggregiert, ohne Datums-Dimension.
function _bumpWritingHour(userEmail, bookId, hour, seconds) {
  db.prepare(`
    INSERT INTO writing_hour (user_email, book_id, hour, seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, hour) DO UPDATE SET seconds = seconds + excluded.seconds
  `).run(userEmail, bookId, hour, seconds);
}

// Schreib-Session ableiten: die juengste Session dieses (User, Buch)
// verlaengern, wenn ihr Ende hoechstens SESSION_GAP_SECONDS zurueckliegt; sonst
// eine neue anlegen. started_at des neuen Abschnitts = jetzt minus die gerade
// gemeldeten Sekunden.
function _extendWritingSession(userEmail, bookId, date, seconds) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const last = db.prepare(`
    SELECT id, ended_at FROM writing_session
    WHERE user_email = ? AND book_id = ? ORDER BY ended_at DESC LIMIT 1
  `).get(userEmail, bookId);
  if (last && (nowMs - Date.parse(last.ended_at)) <= SESSION_GAP_SECONDS * 1000) {
    db.prepare('UPDATE writing_session SET ended_at = ?, seconds = seconds + ? WHERE id = ?')
      .run(nowIso, seconds, last.id);
    return;
  }
  const startIso = new Date(nowMs - seconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO writing_session (user_email, book_id, date, started_at, ended_at, seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userEmail, bookId, date, startIso, nowIso, seconds);
}

// --- Spec der drei Tracker --------------------------------------------------

const TRACKERS = {
  writing: {
    table: 'writing_time',
    extraCols: [],
    scopeCol: null,
    perPage: false,
    sideEffects: ({ userEmail, bookId, date, seconds, hour }) => {
      _bumpWritingHour(userEmail, bookId, hour, seconds);
      _extendWritingSession(userEmail, bookId, date, seconds);
    },
  },
  stt: {
    table: 'stt_time',
    // Diktat zaehlt neben der Zeit die diktierten Zeichen mit; Clamp defensiv
    // gegen manipulierte Werte.
    extraCols: [{ name: 'chars', max: MAX_CHARS_PER_PING }],
    scopeCol: null,
    perPage: false,
  },
  lektorat: {
    table: 'lektorat_time',
    extraCols: [],
    // Lektoratszeit haengt an der Seite — sie ist der Gegenstand der Pruefung.
    scopeCol: 'page_id',
    perPage: true,
  },
};

function trackerSpec(kind) {
  const spec = TRACKERS[kind];
  if (!spec) throw new Error(`Unbekannter Zeit-Tracker: ${kind}`);
  return spec;
}

// Einen gemeldeten Zahlenwert auf einen ganzzahligen, gedeckelten Delta
// normalisieren. Nicht-Zahlen und <= 0 werden zu 0 (kein Write).
function clampDelta(raw, max = MAX_SECONDS_PER_PING) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), max);
}

// --- Schreibpfad ------------------------------------------------------------

/** Heartbeat verbuchen. `extra` traegt die Zusatzspalten der Spec (z.B. chars),
 *  `scopeId` die zusaetzliche Dimension (z.B. page_id). Liefert die tatsaechlich
 *  gutgeschriebenen Werte. */
function recordHeartbeat(kind, { userEmail, bookId, date, hour, seconds, scopeId = null, extra = {} }) {
  const spec = trackerSpec(kind);

  const cols = ['user_email', 'book_id'];
  const vals = [userEmail, bookId];
  if (spec.scopeCol) { cols.push(spec.scopeCol); vals.push(scopeId); }
  cols.push('date'); vals.push(date);

  // Summierte Spalten: seconds plus die Zusatzspalten der Spec.
  const sumCols = ['seconds', ...spec.extraCols.map(c => c.name)];
  const added = { seconds };
  vals.push(seconds);
  for (const c of spec.extraCols) {
    const v = clampDelta(extra[c.name], c.max);
    added[c.name] = v;
    vals.push(v);
  }
  cols.push(...sumCols);

  const conflictCols = ['user_email', 'book_id', ...(spec.scopeCol ? [spec.scopeCol] : []), 'date'];
  db.prepare(`
    INSERT INTO ${spec.table} (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(${conflictCols.join(', ')}) DO UPDATE SET
      ${sumCols.map(c => `${c} = ${c} + excluded.${c}`).join(',\n      ')}
  `).run(...vals);

  if (spec.sideEffects) spec.sideEffects({ userEmail, bookId, date, seconds, hour });
  return added;
}

// --- Lesepfad ---------------------------------------------------------------

// „Zeile zaehlt als aktiv": bei Zusatzspalten reicht Aktivitaet in EINER davon
// (ein Diktat-Tag mit Zeichen aber 0 s ist ein aktiver Tag).
function _activeWhere(spec) {
  const cols = ['seconds', ...spec.extraCols.map(c => c.name)];
  return cols.length === 1 ? 'seconds > 0' : `(${cols.map(c => `${c} > 0`).join(' OR ')})`;
}

/** Aggregat + Tagesreihe (+ optional Aufschluesselung je Seite). */
function readSummary(kind, { userEmail, bookId }) {
  const spec = trackerSpec(kind);
  const extras = spec.extraCols.map(c => c.name);
  const active = _activeWhere(spec);
  // Per-Page-Tracker haben mehrere Zeilen pro Tag → Tage distinct zaehlen und
  // die Tagesreihe gruppieren.
  const dayCount = spec.scopeCol ? 'COUNT(DISTINCT date)' : 'COUNT(*)';

  const row = db.prepare(`
    SELECT COALESCE(SUM(seconds), 0) AS total_seconds,
           ${extras.map(c => `COALESCE(SUM(${c}), 0) AS total_${c},`).join('\n           ')}
           ${dayCount} AS active_days,
           MIN(date)  AS first_date,
           MAX(date)  AS last_date
    FROM ${spec.table}
    WHERE user_email = ? AND book_id = ? AND ${active}
  `).get(userEmail, bookId);

  const daily = spec.scopeCol
    ? db.prepare(`
        SELECT date, SUM(seconds) AS seconds FROM ${spec.table}
        WHERE user_email = ? AND book_id = ? AND ${active}
        GROUP BY date ORDER BY date ASC
      `).all(userEmail, bookId)
    : db.prepare(`
        SELECT date, seconds${extras.map(c => `, ${c}`).join('')} FROM ${spec.table}
        WHERE user_email = ? AND book_id = ? AND ${active}
        ORDER BY date ASC
      `).all(userEmail, bookId);

  const out = {
    total_seconds: row?.total_seconds || 0,
    active_days: row?.active_days || 0,
    first_date: row?.first_date || null,
    last_date: row?.last_date || null,
    daily,
  };
  for (const c of extras) out[`total_${c}`] = row?.[`total_${c}`] || 0;
  if (spec.perPage) {
    out.per_page = _perPage(spec, userEmail, bookId);
    out.per_chapter = _perChapter(spec, userEmail, bookId);
  }
  return out;
}

// Aufschluesselung je Seite inkl. Seitenname (Namens-JOIN gehoert in dieses
// Modul, nicht in den Route-Handler).
function _perPage(spec, userEmail, bookId) {
  return db.prepare(`
    SELECT t.${spec.scopeCol} AS page_id, COALESCE(p.page_name, '') AS page_name,
           SUM(t.seconds) AS seconds
    FROM ${spec.table} t
    LEFT JOIN pages p ON p.page_id = t.${spec.scopeCol}
    WHERE t.user_email = ? AND t.book_id = ? AND t.seconds > 0
    GROUP BY t.${spec.scopeCol}
    ORDER BY seconds DESC
  `).all(userEmail, bookId);
}

// Aufschluesselung je Kapitel. Zeichen/Woerter aus page_stats, damit die
// Kapitel-Tiles der Overview auf derselben Skala liegen wie die uebrigen.
// Seiten ohne chapter_id (lose Seiten direkt im Buch) gruppieren unter NULL/''.
function _perChapter(spec, userEmail, bookId) {
  return db.prepare(`
    SELECT p.chapter_id                 AS chapter_id,
           COALESCE(c.chapter_name, '') AS chapter_name,
           SUM(t.seconds)               AS seconds,
           COUNT(DISTINCT t.${spec.scopeCol}) AS pages_count,
           COALESCE(SUM(ps.chars), 0)   AS chars,
           COALESCE(SUM(ps.words), 0)   AS words
    FROM ${spec.table} t
    LEFT JOIN pages p       ON p.page_id    = t.${spec.scopeCol}
    LEFT JOIN chapters c    ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    LEFT JOIN page_stats ps ON ps.page_id   = t.${spec.scopeCol}
    WHERE t.user_email = ? AND t.book_id = ? AND t.seconds > 0
    GROUP BY p.chapter_id, c.chapter_name
    ORDER BY seconds DESC
  `).all(userEmail, bookId);
}

module.exports = {
  TRACKERS,
  MAX_SECONDS_PER_PING,
  MAX_CHARS_PER_PING,
  SESSION_GAP_SECONDS,
  clampDelta,
  trackerSpec,
  recordHeartbeat,
  readSummary,
};
