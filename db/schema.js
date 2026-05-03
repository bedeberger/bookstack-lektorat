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

// ── Konsolidierter Zeitstrahl ─────────────────────────────────────────────────
// Ersetzt den gesamten Bestand für book/user.
// ereignisse: Array aus KI-Antwort [{datum, ereignis, typ, bedeutung, kapitel[], seiten[], figuren[]}]
// chNameToId: optionaler Map Kapitelname → chapter_id für stabile ID-Referenzen.
// pageNameToIdByChapter: optionaler Map chapter_id → (page_name → page_id) für
// kapitel-scoped Auflösung der seiten-Einträge. Fehlt er, bleiben page_ids leer.
function saveZeitstrahlEvents(bookId, userEmail, ereignisse, chNameToId = {}, pageNameToIdByChapter = null) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
    const ins = db.prepare(`INSERT INTO zeitstrahl_events
      (book_id, user_email, datum, ereignis, typ, bedeutung, kapitel, chapter_ids, seiten, page_ids, figuren, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < ereignisse.length; i++) {
      const ev = ereignisse[i];
      const rawKapitel = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      const kapitelArr = rawKapitel.map(_toRefString).filter(Boolean);
      const chapIds = kapitelArr.map(n => chNameToId?.[n] ?? null).filter(id => id != null);
      const rawSeiten = Array.isArray(ev.seiten) ? ev.seiten : [];
      const seitenArr = rawSeiten.map(_toRefString).filter(Boolean);
      // figuren als {id, name, typ}-Objekte erhalten (Schema verlangt das, Renderer
      // braucht id für Klick-Link und typ für Badge-Klasse). Strings/Mischformen
      // tolerant in Objekte heben.
      const figurenArr = Array.isArray(ev.figuren) ? ev.figuren.map(f => {
        if (f == null) return null;
        if (typeof f === 'string') {
          const name = f.trim();
          return name ? { name } : null;
        }
        if (typeof f === 'object') {
          const name = (f.name || f.kurzname || '').trim();
          if (!name) return null;
          const out = { name };
          if (f.id) out.id = String(f.id);
          if (f.typ) out.typ = String(f.typ);
          return out;
        }
        return null;
      }).filter(Boolean) : [];
      // Seiten auflösen: erst in den Event-Kapiteln suchen (kapitel-scoped),
      // dann Unambiguous-Match global. Halluzinations-Check: seite === kapitel → skip.
      const pageIds = [];
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
          if (pid != null && !pageIds.includes(pid)) pageIds.push(pid);
        }
      }
      ins.run(
        bookId, userEmail || '',
        ev.datum || '', ev.ereignis || '', ev.typ || 'persoenlich', ev.bedeutung || null,
        kapitelArr.length ? JSON.stringify(kapitelArr) : null,
        chapIds.length    ? JSON.stringify(chapIds)    : null,
        seitenArr.length  ? JSON.stringify(seitenArr)  : null,
        pageIds.length    ? JSON.stringify(pageIds)    : null,
        figurenArr.length ? JSON.stringify(figurenArr) : null,
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
// pageNameToIdByChapter: optional. Fehlt er, wird er aus der pages-Tabelle
// aufgebaut — kapitel-scoped gegen Namenskollisionen zwischen Kapiteln.
function saveOrteToDb(bookId, orte, userEmail, chNameToId = null, pageNameToIdByChapter = null) {
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
      UPDATE locations SET name=?, typ=?, beschreibung=?, erste_erwaehnung=?, erste_erwaehnung_page_id=?, stimmung=?,
        sort_order=?, updated_at=?
      WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id, stimmung,
        sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const delLf = db.prepare('DELETE FROM location_figures WHERE location_id = ?');
    const delLc = db.prepare('DELETE FROM location_chapters WHERE location_id = ?');
    const insLf = db.prepare('INSERT INTO location_figures (location_id, fig_id) VALUES (?, ?)');
    const insLc = db.prepare('INSERT INTO location_chapters (location_id, chapter_id, chapter_name, haeufigkeit) VALUES (?, ?, ?, ?)');

    for (let i = 0; i < orte.length; i++) {
      const o = orte[i];
      const erstPageId = resolveErstePageIdForOrt(o.erste_erwaehnung, o.kapitel);
      let locDbId = existingMap[o.id];
      if (locDbId !== undefined) {
        // integer id (und scene_locations) bleibt erhalten
        upd.run(o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          i, now, locDbId);
        delLf.run(locDbId);
        delLc.run(locDbId);
      } else {
        const { lastInsertRowid } = ins.run(
          bookId, o.id, o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, erstPageId, o.stimmung || null,
          i, userEmail || null, now
        );
        locDbId = lastInsertRowid;
      }
      for (const fid of (o.figuren || [])) {
        const ref = _toRefString(fid);
        if (ref) insLf.run(locDbId, ref);
      }
      for (const k of (o.kapitel || [])) {
        const chName = _toRefString(typeof k === 'object' && k ? (k.name ?? k) : k);
        if (!chName) continue;
        const chapId = chNameToId?.[chName] ?? null;
        const haeufigkeit = (k && typeof k === 'object' && k.haeufigkeit) || 1;
        if (chapId != null) insLc.run(locDbId, chapId, chName, haeufigkeit);
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
    INSERT OR IGNORE INTO location_chapters (location_id, chapter_id, chapter_name, haeufigkeit)
    SELECT sl.location_id, fs.chapter_id, fs.kapitel, COUNT(*)
    FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    WHERE fs.book_id = ? AND ${emailCond} AND fs.chapter_id IS NOT NULL
    GROUP BY sl.location_id, fs.chapter_id
  `).run(bookId, ...emailVal);
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
  _saveFtAiCache.run(
    parseInt(bookId), userEmail || '', scope, scopeKey, sig, version,
    JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteFinetuneAiCache(bookId, userEmail) {
  return _deleteFtAiCache.run(parseInt(bookId), userEmail || '').changes;
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
  'SELECT email, name, created_at, last_login_at, last_seen_at, locale, theme, default_buchtyp, default_language, default_region, focus_granularity FROM users WHERE email = ?'
);
const _updateUserSettings = db.prepare(`
  UPDATE users
  SET locale = ?, theme = ?, default_buchtyp = ?, default_language = ?, default_region = ?, focus_granularity = ?
  WHERE email = ?
`);
const _touchUserLastSeen = db.prepare(
  "UPDATE users SET last_seen_at = ? WHERE email = ?"
);
const _addUserActivity = db.prepare(`
  INSERT INTO user_activity (user_email, date, seconds, first_at, last_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_email, date) DO UPDATE SET
    seconds = seconds + excluded.seconds,
    last_at = excluded.last_at
`);

/** Upsert User bei Login – aktualisiert name + last_login_at. */
function upsertUserLogin(email, name) {
  _upsertUserLogin.run(email, name || email);
}

/** Gibt User-Profil zurück oder null. */
function getUser(email) {
  return _getUser.get(email) || null;
}

/** Aktualisiert `last_seen_at` auf jetzt. Throttling macht der Aufrufer. */
function touchUserLastSeen(email, nowIso = new Date().toISOString()) {
  if (!email) return;
  _touchUserLastSeen.run(nowIso, email);
}

/** Summiert aktive Sekunden für (user, Tag). Aufrufer clamped/heuristisiert selbst. */
function addUserActivity(email, seconds, nowIso = new Date().toISOString()) {
  if (!email || !(seconds > 0)) return;
  const date = nowIso.slice(0, 10);
  _addUserActivity.run(email, date, Math.round(seconds), nowIso, nowIso);
}

/** Aktualisiert alle Settings-Felder. Null-Werte setzen die Spalte zurück. */
function updateUserSettings(email, settings) {
  _updateUserSettings.run(
    settings.locale ?? null,
    settings.theme ?? null,
    settings.default_buchtyp ?? null,
    settings.default_language ?? null,
    settings.default_region ?? null,
    settings.focus_granularity ?? null,
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

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────
// Eine Zeile pro Issue (continuity_issues) plus Bridge-Tabellen für Figuren-/
// Kapitel-Referenzen. Vorbild: figure_scenes mit scene_figures/scene_locations.

const _insContinuityCheck = db.prepare(
  `INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model)
   VALUES (?, ?, ?, ?, ?)`
);
const _insContinuityIssue = db.prepare(
  `INSERT INTO continuity_issues
   (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const _insContinuityIssueFig = db.prepare(
  `INSERT INTO continuity_issue_figures (issue_id, fig_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`
);
const _insContinuityIssueCh = db.prepare(
  `INSERT INTO continuity_issue_chapters (issue_id, chapter_id, chapter_name, sort_order) VALUES (?, ?, ?, ?)`
);

/** Speichert einen Kontinuitäts-Check mit allen Issues als eigene Zeilen.
 *  issues: [{schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung,
 *            figuren:[Namen], kapitel:[Namen]}]
 *  figNameToId / chNameToId: Auflösungs-Maps (Name → fig_id / chapter_id).
 *  Gibt { checkId, normalizedIssues } zurück, wobei normalizedIssues die
 *  Frontend-Form mit fig_ids/chapter_ids enthält (kompatibel zur alten Antwort). */
function saveContinuityCheck(bookId, userEmail, summary, model, issues, figNameToId, chNameToId) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const now = new Date().toISOString();
  const normalizedIssues = [];
  let checkId = null;
  db.transaction(() => {
    const { lastInsertRowid: cid } = _insContinuityCheck.run(
      bookIdInt, email, now, summary || '', model || null,
    );
    checkId = cid;
    const issuesArr = Array.isArray(issues) ? issues : [];
    for (let i = 0; i < issuesArr.length; i++) {
      const it = issuesArr[i] || {};
      const { lastInsertRowid: issueId } = _insContinuityIssue.run(
        cid, bookIdInt, email,
        it.schwere || null, it.typ || null, it.beschreibung || null,
        it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
        i, now,
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
        _insContinuityIssueFig.run(issueId, fid, name, j);
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
        _insContinuityIssueCh.run(issueId, cidCh, name, j);
      });
      normalizedIssues.push({
        schwere: it.schwere || null, typ: it.typ || null,
        beschreibung: it.beschreibung || null,
        stelle_a: it.stelle_a || null, stelle_b: it.stelle_b || null,
        empfehlung: it.empfehlung || null,
        figuren: figNames, fig_ids,
        kapitel: chNames, chapter_ids,
      });
    }
  })();
  return { checkId, normalizedIssues };
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
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(row.id);
  const figRows = db.prepare(`
    SELECT issue_id, fig_id, figur_name FROM continuity_issue_figures
    WHERE issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY issue_id, sort_order
  `).all(row.id);
  const chRows = db.prepare(`
    SELECT issue_id, chapter_id, chapter_name FROM continuity_issue_chapters
    WHERE issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY issue_id, sort_order
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
    schwere: r.schwere, typ: r.typ, beschreibung: r.beschreibung,
    stelle_a: r.stelle_a, stelle_b: r.stelle_b, empfehlung: r.empfehlung,
    figuren: figByIssue.get(r.id)?.figuren || [],
    fig_ids: figByIssue.get(r.id)?.fig_ids || [],
    kapitel: chByIssue.get(r.id)?.kapitel || [],
    chapter_ids: chByIssue.get(r.id)?.chapter_ids || [],
  }));
  return { id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model };
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
  getUserToken:       tokens.getUserToken,
  setUserToken:       tokens.setUserToken,
  getAnyUserToken:    tokens.getAnyUserToken,
  getAllUserTokens:   tokens.getAllUserTokens,
  getTokenForRequest: tokens.getTokenForRequest,
  // local
  saveZeitstrahlEvents,
  saveOrteToDb,
  backfillLocationChaptersFromScenes,
  saveContinuityCheck,
  getLatestContinuityCheck,
  upsertUserLogin, getUser, updateUserSettings,
  touchUserLastSeen, addUserActivity,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  insertJobRun, startJobRun, endJobRun, cleanupStuckJobRuns,
  getBookSettings, getBookLocale, saveBookSettings,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
  loadFinetuneAiCache, saveFinetuneAiCache, deleteFinetuneAiCache,
};
