// Facade: verteilt Schema-/Migrations-Setup und die verbliebenen DB-Helfer
// auf dedizierte Module, exportiert alles gebündelt. Ladereihenfolge matters:
// migrations muss vor allen Modulen laufen, die Prepared Statements auf
// migrierten Spalten anlegen.
const { db } = require('./connection');
require('./migrations');

const figures = require('./figures');
const pages = require('./pages');
const tokens = require('./tokens');

// ── Job-Laufzeiten ────────────────────────────────────────────────────────────
const _stmtInsJobRun = db.prepare(
  `INSERT INTO job_runs (job_id, type, book_id, user_email, label, status, queued_at)
   VALUES (?, ?, ?, ?, ?, 'queued', ?)`
);
const _stmtStartJobRun = db.prepare(
  `UPDATE job_runs SET status = 'running', started_at = ? WHERE job_id = ?`
);
const _stmtEndJobRun = db.prepare(
  `UPDATE job_runs SET status = ?, ended_at = ?, tokens_in = ?, tokens_out = ?, tokens_per_sec = ?, error = ? WHERE job_id = ?`
);

function insertJobRun(job) {
  _stmtInsJobRun.run(job.id, job.type, job.bookId || null, job.userEmail || null, job.label || null, new Date().toISOString());
}
function startJobRun(jobId, startedAt) {
  _stmtStartJobRun.run(startedAt, jobId);
}
function endJobRun(jobId, status, endedAt, tokensIn, tokensOut, tokensPerSec, error) {
  _stmtEndJobRun.run(status, endedAt, tokensIn || 0, tokensOut || 0, tokensPerSec ?? null, error || null, jobId);
}

/** Setzt alle hängenden job_runs (status 'running' oder 'queued') auf 'error'.
 *  Gibt die Anzahl bereinigter Einträge zurück. */
function cleanupStuckJobRuns() {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE job_runs SET status = 'error', ended_at = ?, error = 'Job-Prozess gestorben (Server-Neustart oder Absturz)'
     WHERE status IN ('running', 'queued')`
  ).run(now);
  return result.changes;
}

// ── Konsolidierter Zeitstrahl ─────────────────────────────────────────────────
// Ersetzt den gesamten Bestand für book/user.
// ereignisse: Array aus KI-Antwort [{datum, ereignis, typ, bedeutung, kapitel[], seiten[], figuren[]}]
// chNameToId: optionaler Map Kapitelname → chapter_id für stabile ID-Referenzen.
function saveZeitstrahlEvents(bookId, userEmail, ereignisse, chNameToId = {}) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
    const ins = db.prepare(`INSERT INTO zeitstrahl_events
      (book_id, user_email, datum, ereignis, typ, bedeutung, kapitel, chapter_ids, seiten, figuren, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < ereignisse.length; i++) {
      const ev = ereignisse[i];
      const kapitelArr = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      const chapIds = kapitelArr.map(n => chNameToId?.[n] ?? null).filter(id => id != null);
      ins.run(
        bookId, userEmail || '',
        ev.datum || '', ev.ereignis || '', ev.typ || 'persoenlich', ev.bedeutung || null,
        kapitelArr.length ? JSON.stringify(kapitelArr) : null,
        chapIds.length    ? JSON.stringify(chapIds)    : null,
        Array.isArray(ev.seiten) ? JSON.stringify(ev.seiten) : null,
        ev.figuren ? JSON.stringify(ev.figuren) : null,
        i, now
      );
    }
  })();
}

// ── Orte ──────────────────────────────────────────────────────────────────────
// UPSERT by loc_id statt Delete+Re-Insert, damit bestehende scene_locations-Einträge
// (ON DELETE CASCADE) erhalten bleiben.
// chNameToId: optionaler Map Kapitelname → chapter_id. Wird er nicht übergeben,
// wird er aus der chapters-Tabelle aufgebaut (für UI-Endpunkt ohne Job-Kontext).
function saveOrteToDb(bookId, orte, userEmail, chNameToId = null) {
  if (chNameToId == null) {
    const rows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
    chNameToId = Object.fromEntries(rows.map(r => [r.chapter_name, r.chapter_id]));
  }
  const now = new Date().toISOString();
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal  = userEmail ? [userEmail] : [];

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, loc_id FROM locations WHERE book_id = ? AND ${emailCond}`
    ).all(bookId, ...emailVal);
    const existingMap = Object.fromEntries(existing.map(r => [r.loc_id, r.id]));

    const newLocIds = new Set(orte.map(o => o.id));

    // Entfernte Orte löschen (CASCADE entfernt location_figures, location_chapters, scene_locations)
    for (const { id, loc_id } of existing) {
      if (!newLocIds.has(loc_id)) {
        db.prepare('DELETE FROM locations WHERE id = ?').run(id);
      }
    }

    const upd = db.prepare(`
      UPDATE locations SET name=?, typ=?, beschreibung=?, erste_erwaehnung=?, stimmung=?,
        sort_order=?, updated_at=?
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, stimmung,
        sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const delLf = db.prepare('DELETE FROM location_figures WHERE location_id = ?');
    const delLc = db.prepare('DELETE FROM location_chapters WHERE location_id = ?');
    const insLf = db.prepare('INSERT INTO location_figures (location_id, fig_id) VALUES (?, ?)');
    const insLc = db.prepare('INSERT INTO location_chapters (location_id, chapter_id, chapter_name, haeufigkeit) VALUES (?, ?, ?, ?)');

    for (let i = 0; i < orte.length; i++) {
      const o = orte[i];
      let locDbId = existingMap[o.id];
      if (locDbId !== undefined) {
        // integer id (und scene_locations) bleibt erhalten
        upd.run(o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, o.stimmung || null,
          i, now, locDbId);
        delLf.run(locDbId);
        delLc.run(locDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, o.id, o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, o.stimmung || null,
          i, userEmail || null, now
        );
        locDbId = lastInsertRowid;
      }
      for (const fid of (o.figuren || [])) insLf.run(locDbId, fid);
      for (const k of (o.kapitel || [])) {
        const chapId = chNameToId?.[k.name] ?? null;
        if (chapId != null) insLc.run(locDbId, chapId, k.name, k.haeufigkeit || 1);
      }
    }
  })();
}

// ── Job-Checkpoints ───────────────────────────────────────────────────────────
// Speichert Zwischenergebnisse für Multi-Pass-Jobs, damit diese nach einem
// Server-Neustart fortgesetzt werden können statt von vorne zu beginnen.
// user_email wird als '' (Leerstring) gespeichert wenn null, damit der
// UNIQUE-Constraint über (job_type, book_id, user_email) korrekt greift.

const _saveCheckpoint = db.prepare(`
  INSERT INTO job_checkpoints (job_type, book_id, user_email, data, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
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
  _saveCheckpoint.run(jobType, parseInt(bookId), userEmail || '', JSON.stringify(data));
}
function loadCheckpoint(jobType, bookId, userEmail) {
  const row = _loadCheckpoint.get(jobType, parseInt(bookId), userEmail || '');
  return row ? JSON.parse(row.data) : null;
}
function deleteCheckpoint(jobType, bookId, userEmail) {
  _deleteCheckpoint.run(jobType, parseInt(bookId), userEmail || '');
}

// ── Delta-Cache: Phase-1-Extraktion pro Kapitel ───────────────────────────────
// Cache-Key: (book_id, user_email, chapter_key, pages_sig).
// pages_sig: sortierter String aus "page_id:updated_at"-Paaren aller Seiten des Kapitels.
// Ändert sich irgendeine Seite, ändert sich die Signatur → Cache-Miss → Neu-Extraktion.

const _loadChapterCache = db.prepare(
  `SELECT extract_json FROM chapter_extract_cache
   WHERE book_id = ? AND user_email = ? AND chapter_key = ? AND pages_sig = ?`
);
const _saveChapterCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_extract_cache
   (book_id, user_email, chapter_key, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterExtractCache(bookId, userEmail, chapterKey, pagesSig) {
  const row = _loadChapterCache.get(parseInt(bookId), userEmail || '', chapterKey, pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.extract_json); } catch { return null; }
}

function saveChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, extract) {
  _saveChapterCache.run(
    parseInt(bookId), userEmail || '', chapterKey, pagesSig,
    JSON.stringify(extract), new Date().toISOString(),
  );
}

const _deleteChapterCache = db.prepare(
  `DELETE FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?`
);

function deleteChapterExtractCache(bookId, userEmail) {
  const result = _deleteChapterCache.run(parseInt(bookId), userEmail || '');
  return result.changes;
}

// ── User-Profile & Einstellungen ──────────────────────────────────────────────

const _upsertUserLogin = db.prepare(`
  INSERT INTO users (email, name, created_at, last_login_at)
  VALUES (?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    name          = excluded.name,
    last_login_at = excluded.last_login_at
`);
const _getUser = db.prepare(
  'SELECT email, name, created_at, last_login_at, locale, theme, default_buchtyp, default_language, default_region FROM users WHERE email = ?'
);
const _updateUserSettings = db.prepare(`
  UPDATE users
  SET locale = ?, theme = ?, default_buchtyp = ?, default_language = ?, default_region = ?
  WHERE email = ?
`);

/** Upsert User bei Login – aktualisiert name + last_login_at. */
function upsertUserLogin(email, name) {
  _upsertUserLogin.run(email, name || email);
}

/** Gibt User-Profil zurück oder null. */
function getUser(email) {
  return _getUser.get(email) || null;
}

/** Aktualisiert alle Settings-Felder. Null-Werte setzen die Spalte zurück. */
function updateUserSettings(email, settings) {
  _updateUserSettings.run(
    settings.locale ?? null,
    settings.theme ?? null,
    settings.default_buchtyp ?? null,
    settings.default_language ?? null,
    settings.default_region ?? null,
    email
  );
}

// ── Buch-Einstellungen (Sprache + Region) ─────────────────────────────────────

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit FROM book_settings WHERE book_id = ?');
const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    erzaehlperspektive=excluded.erzaehlperspektive, erzaehlzeit=excluded.erzaehlzeit,
    updated_at=excluded.updated_at
`);

/** Gibt {language, region, buchtyp, buch_kontext, erzaehlperspektive, erzaehlzeit} für ein Buch zurück.
 *  Fehlt die book_settings-Zeile, werden – wenn vorhanden – die User-Defaults
 *  (default_language/region/buchtyp) als Fallback verwendet. */
function getBookSettings(bookId, userEmail = null) {
  const row = _getBookSettings.get(parseInt(bookId));
  if (row) return row;
  if (userEmail) {
    const u = _getUser.get(userEmail);
    if (u && (u.default_language || u.default_buchtyp)) {
      const language = u.default_language || 'de';
      const region   = u.default_region   || (language === 'en' ? 'US' : 'CH');
      return { language, region, buchtyp: u.default_buchtyp || null, buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null };
    }
  }
  return { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId, userEmail = null) {
  const { language, region } = getBookSettings(bookId, userEmail);
  return `${language}-${region}`;
}

/** Speichert/aktualisiert Sprache, Region, Buchtyp, Buchkontext, Erzählperspektive und Erzählzeit. */
function saveBookSettings(bookId, language, region, buchtyp, buchKontext, erzaehlperspektive = null, erzaehlzeit = null) {
  _upsertBookSettings.run(
    parseInt(bookId), language, region,
    buchtyp || null, buchKontext || null,
    erzaehlperspektive || null, erzaehlzeit || null,
    new Date().toISOString()
  );
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

module.exports = {
  db,
  // figures
  saveFigurenToDb:          figures.saveFigurenToDb,
  addFigurenBeziehungen:    figures.addFigurenBeziehungen,
  updateFigurenEvents:      figures.updateFigurenEvents,
  updateFigurenSoziogramm:  figures.updateFigurenSoziogramm,
  cleanupDuplicateFiguren:  figures.cleanupDuplicateFiguren,
  getChapterFigures:        figures.getChapterFigures,
  getChapterFigureRelations: figures.getChapterFigureRelations,
  // locations
  getChapterLocations,
  // pages
  reconcilePageIds:   pages.reconcilePageIds,
  pruneStaleBookData: pages.pruneStaleBookData,
  // tokens
  getUserToken:     tokens.getUserToken,
  setUserToken:     tokens.setUserToken,
  getAnyUserToken:  tokens.getAnyUserToken,
  getAllUserTokens: tokens.getAllUserTokens,
  // local
  saveZeitstrahlEvents,
  saveOrteToDb,
  upsertUserLogin, getUser, updateUserSettings,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  insertJobRun, startJobRun, endJobRun, cleanupStuckJobRuns,
  getBookSettings, getBookLocale, saveBookSettings,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
};
