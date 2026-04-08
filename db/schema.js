const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const logger = require('../logger');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'lektorat.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS page_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id     INTEGER NOT NULL,
    page_name   TEXT,
    book_id     INTEGER,
    checked_at  TEXT NOT NULL,
    error_count INTEGER DEFAULT 0,
    errors_json TEXT,
    stilanalyse TEXT,
    fazit       TEXT,
    model       TEXT,
    saved       INTEGER DEFAULT 0,
    saved_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pc_page_id ON page_checks(page_id);
  CREATE INDEX IF NOT EXISTS idx_pc_book_id ON page_checks(book_id);

  CREATE TABLE IF NOT EXISTS book_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    reviewed_at TEXT NOT NULL,
    review_json TEXT,
    model       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_br_book_id ON book_reviews(book_id);

  -- Figuren: eine Zeile pro Figur, Kernfelder fix
  -- Neue Felder: per ALTER TABLE ADD COLUMN oder via meta (JSON)
  CREATE TABLE IF NOT EXISTS figures (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL,
    fig_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    kurzname     TEXT,
    typ          TEXT,
    geburtstag   TEXT,
    geschlecht   TEXT,
    beruf        TEXT,
    beschreibung TEXT,
    sort_order   INTEGER DEFAULT 0,
    meta         TEXT,
    updated_at   TEXT NOT NULL,
    UNIQUE(book_id, fig_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id);

  -- Eigenschaften/Tags: eine Zeile pro Eigenschaft
  CREATE TABLE IF NOT EXISTS figure_tags (
    figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL
  );

  -- Kapitelauftritte: eine Zeile pro Figur + Kapitel
  CREATE TABLE IF NOT EXISTS figure_appearances (
    figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    chapter_name TEXT NOT NULL,
    haeufigkeit  INTEGER DEFAULT 1
  );

  -- Lebensereignisse / Zeitstrahl: eine Zeile pro Ereignis
  CREATE TABLE IF NOT EXISTS figure_events (
    figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    bedeutung  TEXT,
    typ        TEXT DEFAULT 'persoenlich',
    sort_order INTEGER DEFAULT 0
  );

  -- Beziehungen: flat, typ ist Freitext -> neue Typen ohne Schemaänderung
  CREATE TABLE IF NOT EXISTS figure_relations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL,
    from_fig_id  TEXT NOT NULL,
    to_fig_id    TEXT NOT NULL,
    typ          TEXT NOT NULL,
    beschreibung TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_frel_book_id ON figure_relations(book_id);

  -- Seiten-Stats-Cache (für schnelles UI-Laden; wird vom Sync-Job befüllt)
  CREATE TABLE IF NOT EXISTS page_stats (
    page_id    INTEGER PRIMARY KEY,
    book_id    INTEGER NOT NULL,
    tok        INTEGER,
    words      INTEGER,
    chars      INTEGER,
    updated_at TEXT,
    cached_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ps_book_id ON page_stats(book_id);

  -- Tägliche Buchstatistik-Snapshots (für Zeitliniendiagramm)
  CREATE TABLE IF NOT EXISTS book_stats_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    recorded_at TEXT NOT NULL,
    page_count  INTEGER,
    words       INTEGER,
    chars       INTEGER,
    tok         INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bsh_book_date ON book_stats_history(book_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_bsh_book_id ON book_stats_history(book_id);

  -- Chat-Sessions: eine Session pro Seite + User (kann mehrere haben)
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id          INTEGER NOT NULL,
    book_name        TEXT,
    page_id          INTEGER NOT NULL,
    page_name        TEXT,
    user_email       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_message_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cs_page_id  ON chat_sessions(page_id, user_email);
  CREATE INDEX IF NOT EXISTS idx_cs_book_id  ON chat_sessions(book_id, user_email);

  -- Chat-Nachrichten: eine Zeile pro Nachricht (user + assistant)
  CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,   -- 'user' | 'assistant'
    content      TEXT NOT NULL,   -- Freitext der Antwort
    vorschlaege  TEXT,            -- JSON-Array | NULL (nur bei 'assistant')
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cm_session_id ON chat_messages(session_id);

  -- BookStack API-Tokens pro User (verknüpft mit Google-E-Mail)
  CREATE TABLE IF NOT EXISTS user_tokens (
    email      TEXT PRIMARY KEY,
    token_id   TEXT NOT NULL,
    token_pw   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Szenen: eine Zeile pro Szene (per-User, per-Buch, per-Kapitel)
  CREATE TABLE IF NOT EXISTS figure_scenes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL,
    user_email TEXT,
    kapitel    TEXT NOT NULL,
    seite      TEXT,
    titel      TEXT NOT NULL,
    wertung    TEXT,
    kommentar  TEXT,
    fig_ids    TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_fscene_book ON figure_scenes(book_id, user_email);

  -- Schauplätze: eine Zeile pro Ort (per-User, per-Buch)
  CREATE TABLE IF NOT EXISTS locations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id          INTEGER NOT NULL,
    loc_id           TEXT NOT NULL,
    name             TEXT NOT NULL,
    typ              TEXT,
    beschreibung     TEXT,
    erste_erwaehnung TEXT,
    stimmung         TEXT,
    figuren_json     TEXT,
    kapitel_json     TEXT,
    sort_order       INTEGER DEFAULT 0,
    user_email       TEXT,
    updated_at       TEXT NOT NULL,
    UNIQUE(book_id, loc_id, user_email)
  );
  CREATE INDEX IF NOT EXISTS idx_loc_book_id ON locations(book_id, user_email);

  -- Kontinuitätsprüfung-Ergebnisse
  CREATE TABLE IF NOT EXISTS continuity_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    user_email  TEXT,
    checked_at  TEXT NOT NULL,
    issues_json TEXT,
    summary     TEXT,
    model       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cc_book_id ON continuity_checks(book_id, user_email);

  -- Konsolidierter Zeitstrahl (persistiertes Ergebnis der KI-Konsolidierung)
  CREATE TABLE IF NOT EXISTS zeitstrahl_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    typ        TEXT DEFAULT 'persoenlich',
    bedeutung  TEXT,
    kapitel    TEXT,    -- JSON-Array der Kapitelnamen
    seiten     TEXT,    -- JSON-Array der Seitennamen
    figuren    TEXT,    -- JSON-Array [{id, name, typ}]
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);

  -- Checkpoint-Cache für unterbrechbare Multi-Pass-Jobs (Resume nach Server-Neustart)
  CREATE TABLE IF NOT EXISTS job_checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type   TEXT NOT NULL,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_type, book_id, user_email)
  );

  -- Seiten-Cache: stabile IDs für Kapiteln und Seiten (wird vom Sync befüllt)
  CREATE TABLE IF NOT EXISTS pages (
    page_id      INTEGER PRIMARY KEY,
    book_id      INTEGER NOT NULL,
    page_name    TEXT,
    chapter_id   INTEGER,
    chapter_name TEXT,
    updated_at   TEXT,
    preview_text TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pages_book_id    ON pages(book_id);
  CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id);

  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
`);

// Schema-Migrationen (versioniert)
function runMigrations() {
  const { version } = db.prepare('SELECT version FROM schema_version').get();
  if (version < 2) {
    db.exec('ALTER TABLE page_checks ADD COLUMN applied_errors_json TEXT');
    db.prepare('UPDATE schema_version SET version = 2').run();
    logger.info('DB-Migration auf Version 2 abgeschlossen.');
  }
  if (version < 3) {
    db.exec(`
      ALTER TABLE page_checks      ADD COLUMN user_email TEXT;
      ALTER TABLE book_reviews     ADD COLUMN user_email TEXT;
      ALTER TABLE figures          ADD COLUMN user_email TEXT;
      ALTER TABLE figure_relations ADD COLUMN user_email TEXT;
    `);
    db.prepare('UPDATE schema_version SET version = 3').run();
    logger.info('DB-Migration auf Version 3 abgeschlossen (user_email zu allen Datentabellen hinzugefügt).');
  }
  if (version < 4) {
    // UNIQUE(book_id, fig_id) → UNIQUE(book_id, fig_id, user_email)
    // SQLite erlaubt kein ALTER CONSTRAINT → Tabelle neu erstellen
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE figures_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id      INTEGER NOT NULL,
          fig_id       TEXT NOT NULL,
          name         TEXT NOT NULL,
          kurzname     TEXT,
          typ          TEXT,
          geburtstag   TEXT,
          geschlecht   TEXT,
          beruf        TEXT,
          beschreibung TEXT,
          sort_order   INTEGER DEFAULT 0,
          meta         TEXT,
          updated_at   TEXT NOT NULL,
          user_email   TEXT,
          UNIQUE(book_id, fig_id, user_email)
        );
        INSERT INTO figures_new
          SELECT id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht,
                 beruf, beschreibung, sort_order, meta, updated_at, user_email
          FROM figures;
        DROP TABLE figures;
        ALTER TABLE figures_new RENAME TO figures;
        CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id);
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.prepare('UPDATE schema_version SET version = 4').run();
    logger.info('DB-Migration auf Version 4 abgeschlossen (figures UNIQUE-Constraint auf (book_id, fig_id, user_email) erweitert).');
  }
  if (version < 5) {
    db.exec('ALTER TABLE page_checks ADD COLUMN selected_errors_json TEXT');
    db.prepare('UPDATE schema_version SET version = 5').run();
    logger.info('DB-Migration auf Version 5 abgeschlossen (selected_errors_json zu page_checks hinzugefügt).');
  }
  if (version < 6) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN context_info TEXT');
    db.prepare('UPDATE schema_version SET version = 6').run();
    logger.info('DB-Migration auf Version 6 abgeschlossen (context_info zu chat_messages hinzugefügt).');
  }
  if (version < 7) {
    // Spalte context_info ggf. nachrüsten (falls Version 6 via Fallback gesetzt wurde ohne ALTER TABLE)
    const cols = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols.includes('context_info')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN context_info TEXT');
      logger.info('DB-Migration auf Version 7: context_info-Spalte nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 7').run();
    logger.info('DB-Migration auf Version 7 abgeschlossen.');
  }
  if (version < 8) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN unique_words INTEGER');
    db.prepare('UPDATE schema_version SET version = 8').run();
    logger.info('DB-Migration auf Version 8 abgeschlossen (unique_words zu book_stats_history hinzugefügt).');
  }
  if (version < 9) {
    // Spalten ggf. nachrüsten (falls Fallback Version bereits auf 9 gesetzt hat)
    const bshCols = db.pragma('table_info(book_stats_history)').map(c => c.name);
    if (!bshCols.includes('chapter_count')) {
      db.exec('ALTER TABLE book_stats_history ADD COLUMN chapter_count INTEGER');
      logger.info('DB-Migration auf Version 9: chapter_count nachgerüstet.');
    }
    if (!bshCols.includes('avg_sentence_len')) {
      db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_sentence_len REAL');
      logger.info('DB-Migration auf Version 9: avg_sentence_len nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 9').run();
    logger.info('DB-Migration auf Version 9 abgeschlossen.');
  }
  if (version < 10) {
    // figure_events.typ nachrüsten (Tabelle existiert ggf. bereits ohne diese Spalte)
    const feCols = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols.includes('typ')) {
      db.exec("ALTER TABLE figure_events ADD COLUMN typ TEXT DEFAULT 'persoenlich'");
      logger.info('DB-Migration auf Version 10: figure_events.typ nachgerüstet.');
    }
    db.prepare('UPDATE schema_version SET version = 10').run();
    logger.info('DB-Migration auf Version 10 abgeschlossen.');
  }
  if (version < 11) {
    db.exec('ALTER TABLE page_checks ADD COLUMN szenen_json TEXT');
    db.prepare('UPDATE schema_version SET version = 11').run();
    logger.info('DB-Migration auf Version 11 abgeschlossen (szenen_json zu page_checks hinzugefügt).');
  }
  if (version < 12) {
    db.exec(`CREATE TABLE IF NOT EXISTS figure_scenes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id    INTEGER NOT NULL,
      user_email TEXT,
      kapitel    TEXT NOT NULL,
      seite      TEXT,
      titel      TEXT NOT NULL,
      wertung    TEXT,
      kommentar  TEXT,
      fig_ids    TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_fscene_book ON figure_scenes(book_id, user_email);`);
    db.prepare('UPDATE schema_version SET version = 12').run();
    logger.info('DB-Migration auf Version 12 abgeschlossen (figure_scenes Tabelle hinzugefügt).');
  }
  if (version < 13) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN updated_at TEXT');
    db.prepare('UPDATE schema_version SET version = 13').run();
    logger.info('DB-Migration auf Version 13 abgeschlossen (updated_at zu figure_scenes hinzugefügt).');
  }
  if (version < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS locations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL,
        loc_id           TEXT NOT NULL,
        name             TEXT NOT NULL,
        typ              TEXT,
        beschreibung     TEXT,
        erste_erwaehnung TEXT,
        stimmung         TEXT,
        figuren_json     TEXT,
        kapitel_json     TEXT,
        sort_order       INTEGER DEFAULT 0,
        user_email       TEXT,
        updated_at       TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_loc_book_id ON locations(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 14').run();
    logger.info('DB-Migration auf Version 14 abgeschlossen (locations Tabelle hinzugefügt).');
  }
  if (version < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        user_email  TEXT,
        checked_at  TEXT NOT NULL,
        issues_json TEXT,
        summary     TEXT,
        model       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cc_book_id ON continuity_checks(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 15').run();
    logger.info('DB-Migration auf Version 15 abgeschlossen (continuity_checks Tabelle hinzugefügt).');
  }
  if (version < 16) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_checkpoints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type   TEXT NOT NULL,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_type, book_id, user_email)
      )
    `);
    db.prepare('UPDATE schema_version SET version = 16').run();
    logger.info('DB-Migration auf Version 16 abgeschlossen (job_checkpoints Tabelle hinzugefügt).');
  }
  if (version < 17) {
    const feCols17 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols17.includes('kapitel')) db.exec('ALTER TABLE figure_events ADD COLUMN kapitel TEXT');
    if (!feCols17.includes('seite'))   db.exec('ALTER TABLE figure_events ADD COLUMN seite TEXT');
    db.prepare('UPDATE schema_version SET version = 17').run();
    logger.info('DB-Migration auf Version 17 abgeschlossen (figure_events kapitel + seite hinzugefügt).');
  }
  if (version < 18) {
    // figure_appearances: chapter_id für stabile Kapitel-Referenz
    const faCols = db.pragma('table_info(figure_appearances)').map(c => c.name);
    if (!faCols.includes('chapter_id')) db.exec('ALTER TABLE figure_appearances ADD COLUMN chapter_id INTEGER');
    // figure_events: chapter_id + page_id
    const feCols18 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols18.includes('chapter_id')) db.exec('ALTER TABLE figure_events ADD COLUMN chapter_id INTEGER');
    if (!feCols18.includes('page_id'))    db.exec('ALTER TABLE figure_events ADD COLUMN page_id INTEGER');
    // figure_scenes: chapter_id + page_id
    const fsCols = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (!fsCols.includes('chapter_id')) db.exec('ALTER TABLE figure_scenes ADD COLUMN chapter_id INTEGER');
    if (!fsCols.includes('page_id'))    db.exec('ALTER TABLE figure_scenes ADD COLUMN page_id INTEGER');
    db.prepare('UPDATE schema_version SET version = 18').run();
    logger.info('DB-Migration auf Version 18 abgeschlossen (chapter_id/page_id zu figure_appearances, figure_events, figure_scenes hinzugefügt).');
  }
  if (version < 21) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS zeitstrahl_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        typ        TEXT DEFAULT 'persoenlich',
        bedeutung  TEXT,
        kapitel    TEXT,
        seiten     TEXT,
        figuren    TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);
    `);
    db.prepare('UPDATE schema_version SET version = 21').run();
    logger.info('DB-Migration auf Version 21 abgeschlossen (zeitstrahl_events Tabelle hinzugefügt).');
  }
  if (version < 19) {
    const pagesCols = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols.includes('chapter_id'))   db.exec('ALTER TABLE pages ADD COLUMN chapter_id INTEGER');
    if (!pagesCols.includes('chapter_name')) db.exec('ALTER TABLE pages ADD COLUMN chapter_name TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)');
    db.prepare('UPDATE schema_version SET version = 19').run();
    logger.info('DB-Migration auf Version 19 abgeschlossen (pages: chapter_id + chapter_name hinzugefügt).');
  }
  if (version < 20) {
    const pagesCols20 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols20.includes('preview_text')) db.exec('ALTER TABLE pages ADD COLUMN preview_text TEXT');
    db.prepare('UPDATE schema_version SET version = 20').run();
    logger.info('DB-Migration auf Version 20 abgeschlossen (pages: preview_text hinzugefügt).');
  }
  // Unbedingter Spalten-Check für figure_events.typ
  const feColsCheck = db.pragma('table_info(figure_events)').map(c => c.name);
  if (feColsCheck.length > 0 && !feColsCheck.includes('typ')) {
    db.exec("ALTER TABLE figure_events ADD COLUMN typ TEXT DEFAULT 'persoenlich'");
    logger.info('figure_events.typ nachgerüstet.');
  }
  // Unbedingter Spalten-Check für v19 + v20 (falls Fallback Version gesetzt hat bevor Migration lief)
  const pagesCols20Check = db.pragma('table_info(pages)').map(c => c.name);
  if (pagesCols20Check.length > 0 && !pagesCols20Check.includes('chapter_id')) {
    db.exec('ALTER TABLE pages ADD COLUMN chapter_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)');
    logger.info('pages.chapter_id nachgerüstet.');
  }
  if (pagesCols20Check.length > 0 && !pagesCols20Check.includes('chapter_name')) {
    db.exec('ALTER TABLE pages ADD COLUMN chapter_name TEXT');
    logger.info('pages.chapter_name nachgerüstet.');
  }
  if (pagesCols20Check.length > 0 && !pagesCols20Check.includes('preview_text')) {
    db.exec('ALTER TABLE pages ADD COLUMN preview_text TEXT');
    logger.info('pages.preview_text nachgerüstet.');
  }
  // Unbedingter Spalten-Check für v18 figure_scenes (falls Fallback Version gesetzt hat bevor Migration lief)
  const fsColsCheck = db.pragma('table_info(figure_scenes)').map(c => c.name);
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('chapter_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN chapter_id INTEGER');
    logger.info('figure_scenes.chapter_id nachgerüstet.');
  }
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('page_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN page_id INTEGER');
    logger.info('figure_scenes.page_id nachgerüstet.');
  }
  // Unbedingter Spalten-Check für v9 (falls Fallback Version gesetzt hat bevor Migration lief)
  const bshColsCheck = db.pragma('table_info(book_stats_history)').map(c => c.name);
  if (!bshColsCheck.includes('chapter_count')) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN chapter_count INTEGER');
    logger.info('book_stats_history.chapter_count nachgerüstet.');
  }
  if (!bshColsCheck.includes('avg_sentence_len')) {
    db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_sentence_len REAL');
    logger.info('book_stats_history.avg_sentence_len nachgerüstet.');
  }
}
runMigrations();

// Figuren in DB schreiben (wird von PUT-Endpoint und JSON-Migration genutzt)
function saveFigurenToDb(bookId, figuren, userEmail, idMaps) {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (userEmail) {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
    } else {
      // Legacy: kein User-Kontext (Migration)
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email IS NULL').run(bookId);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS NULL').run(bookId);
    }

    const insFig = db.prepare(`
      INSERT INTO figures (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTag = db.prepare('INSERT INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insApp = db.prepare('INSERT INTO figure_appearances (figure_id, chapter_name, chapter_id, haeufigkeit) VALUES (?, ?, ?, ?)');
    const insEvt = db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, bedeutung, typ, kapitel, seite, chapter_id, page_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email) VALUES (?, ?, ?, ?, ?, ?)');

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.beschreibung || null, i, userEmail || null, now
      );
      for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
      for (const app of (f.kapitel || [])) insApp.run(fid, app.name, idMaps?.chNameToId?.[app.name] ?? null, app.haeufigkeit || 1);
      for (let j = 0; j < (f.lebensereignisse || []).length; j++) {
        const ev = f.lebensereignisse[j];
        insEvt.run(fid, ev.datum || '', ev.ereignis || '', ev.bedeutung || null, ev.typ || 'persoenlich', ev.kapitel || null, ev.seite || null, idMaps?.chNameToId?.[ev.kapitel] ?? null, idMaps?.pageNameToId?.[ev.seite] ?? null, j);
      }
      for (const bz of (f.beziehungen || [])) insRel.run(bookId, f.id, bz.figur_id, bz.typ, bz.beschreibung || null, userEmail || null);
    }
  })();
}

// Ersetzt alle Lebensereignisse für ein Buch/User anhand von fig_id-basierten Assignments.
// assignments: [{ fig_id: "fig_1", lebensereignisse: [...] }]
function updateFigurenEvents(bookId, assignments, userEmail, idMaps) {
  db.transaction(() => {
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email = ?'
    ).all(bookId, userEmail || null);
    if (!figRows.length) return;

    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const delEvt = db.prepare('DELETE FROM figure_events WHERE figure_id = ?');
    for (const row of figRows) delEvt.run(row.id);

    const insEvt = db.prepare('INSERT INTO figure_events (figure_id, datum, ereignis, bedeutung, typ, kapitel, seite, chapter_id, page_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const assignment of assignments) {
      const rowId = figIdToRowId[assignment.fig_id];
      if (!rowId) continue;
      for (let j = 0; j < (assignment.lebensereignisse || []).length; j++) {
        const ev = assignment.lebensereignisse[j];
        insEvt.run(rowId, ev.datum || '', ev.ereignis || '', ev.bedeutung || null, ev.typ || 'persoenlich', ev.kapitel || null, ev.seite || null, idMaps?.chNameToId?.[ev.kapitel] ?? null, idMaps?.pageNameToId?.[ev.seite] ?? null, j);
      }
    }
  })();
}

// Konsolidierten Zeitstrahl persistieren (ersetzt den gesamten Bestand für book/user).
// ereignisse: Array aus KI-Antwort [{datum, ereignis, typ, bedeutung, kapitel[], seiten[], figuren[]}]
function saveZeitstrahlEvents(bookId, userEmail, ereignisse) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
    const ins = db.prepare(`INSERT INTO zeitstrahl_events
      (book_id, user_email, datum, ereignis, typ, bedeutung, kapitel, seiten, figuren, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < ereignisse.length; i++) {
      const ev = ereignisse[i];
      ins.run(
        bookId, userEmail || '',
        ev.datum || '', ev.ereignis || '', ev.typ || 'persoenlich', ev.bedeutung || null,
        Array.isArray(ev.kapitel) ? JSON.stringify(ev.kapitel) : (ev.kapitel ? JSON.stringify([ev.kapitel]) : null),
        Array.isArray(ev.seiten)  ? JSON.stringify(ev.seiten)  : null,
        ev.figuren ? JSON.stringify(ev.figuren) : null,
        i, now
      );
    }
  })();
}

// Einmalige Migration von lektorat-history.json
function migrateFromJson() {
  const HISTORY_FILE = path.join(__dirname, '..', 'lektorat-history.json');
  if (!fs.existsSync(HISTORY_FILE)) return;

  const existing = db.prepare('SELECT COUNT(*) as c FROM page_checks').get();
  if (existing.c > 0) {
    logger.info('lektorat-history.json vorhanden, aber DB hat bereits Daten – Migration übersprungen.');
    return;
  }

  let h;
  try { h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch (e) { logger.error('Migration: JSON lesen fehlgeschlagen: ' + e.message); return; }

  const insCheck = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, saved, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReview = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model)
    VALUES (?, ?, ?, ?, ?)`);

  db.transaction(() => {
    for (const r of (h.page_checks || [])) {
      insCheck.run(r.page_id, r.page_name, r.book_id, r.checked_at,
        r.error_count || 0, JSON.stringify(r.errors_json || []),
        r.stilanalyse || null, r.fazit || null, r.model || null,
        r.saved ? 1 : 0, r.saved_at || null);
    }
    for (const r of (h.book_reviews || [])) {
      insReview.run(r.book_id, r.book_name, r.reviewed_at,
        JSON.stringify(r.review_json || null), r.model || null);
    }
    for (const [bookId, entry] of Object.entries(h.book_figures || {})) {
      if (entry?.figuren?.length) {
        saveFigurenToDb(parseInt(bookId), entry.figuren);
      }
    }
  })();

  fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.migrated');
  logger.info('Migration von lektorat-history.json abgeschlossen (Datei umbenannt zu .migrated).');
}
migrateFromJson();

// ── Seiten-ID-Reconciliation ──────────────────────────────────────────────────
// Wird nach jedem syncBook()-Aufruf aufgerufen. Befüllt chapter_id/page_id
// in den Figuren-Tabellen anhand der pages-Cache-Tabelle und heilt veraltete
// Namen bei Kapitel-/Seiten-Umbenennungen in BookStack.
function reconcilePageIds() {
  // 1. figure_appearances: chapter_id aus chapter_name befüllen (neue Einträge ohne ID)
  db.prepare(`
    UPDATE figure_appearances
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_appearances.figure_id
        AND p.chapter_name = figure_appearances.chapter_name
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
  `).run();

  // 2. figure_appearances: chapter_name per ID aktualisieren (Umbenennungen heilen)
  db.prepare(`
    UPDATE figure_appearances
    SET chapter_name = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_appearances.figure_id
        AND p.chapter_id = figure_appearances.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  // 3. figure_events: chapter_id aus kapitel befüllen
  db.prepare(`
    UPDATE figure_events
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.chapter_name = figure_events.kapitel
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND kapitel IS NOT NULL
  `).run();

  // 4. figure_events: page_id aus seite befüllen
  db.prepare(`
    UPDATE figure_events
    SET page_id = (
      SELECT p.page_id FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.page_name = figure_events.seite
      LIMIT 1
    )
    WHERE page_id IS NULL AND seite IS NOT NULL
  `).run();

  // 5. figure_events: kapitel per chapter_id aktualisieren
  db.prepare(`
    UPDATE figure_events
    SET kapitel = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN figures f ON f.book_id = p.book_id
      WHERE f.id = figure_events.figure_id
        AND p.chapter_id = figure_events.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  // 6. figure_events: seite per page_id aktualisieren
  db.prepare(`
    UPDATE figure_events
    SET seite = (
      SELECT p.page_name FROM pages p
      WHERE p.page_id = figure_events.page_id
      LIMIT 1
    )
    WHERE page_id IS NOT NULL
  `).run();

  // 7. figure_scenes: chapter_id aus kapitel befüllen
  db.prepare(`
    UPDATE figure_scenes
    SET chapter_id = (
      SELECT DISTINCT chapter_id FROM pages
      WHERE book_id = figure_scenes.book_id
        AND chapter_name = figure_scenes.kapitel
        AND chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND kapitel IS NOT NULL
  `).run();

  // 8. figure_scenes: page_id aus seite befüllen
  db.prepare(`
    UPDATE figure_scenes
    SET page_id = (
      SELECT page_id FROM pages
      WHERE book_id = figure_scenes.book_id
        AND page_name = figure_scenes.seite
      LIMIT 1
    )
    WHERE page_id IS NULL AND seite IS NOT NULL
  `).run();

  // 9. figure_scenes: kapitel per chapter_id aktualisieren
  db.prepare(`
    UPDATE figure_scenes
    SET kapitel = (
      SELECT DISTINCT chapter_name FROM pages
      WHERE book_id = figure_scenes.book_id
        AND chapter_id = figure_scenes.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  // 10. figure_scenes: seite per page_id aktualisieren
  db.prepare(`
    UPDATE figure_scenes
    SET seite = (
      SELECT page_name FROM pages
      WHERE page_id = figure_scenes.page_id
      LIMIT 1
    )
    WHERE page_id IS NOT NULL
  `).run();
}

// ── User-Token-Verwaltung ─────────────────────────────────────────────────────

const _getToken = db.prepare('SELECT token_id, token_pw FROM user_tokens WHERE email = ?');
const _upsertToken = db.prepare(`
  INSERT INTO user_tokens (email, token_id, token_pw, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    token_id=excluded.token_id, token_pw=excluded.token_pw, updated_at=excluded.updated_at
`);
const _getAnyToken = db.prepare('SELECT token_id, token_pw FROM user_tokens LIMIT 1');
const _getAllTokens = db.prepare('SELECT email, token_id, token_pw FROM user_tokens');

/** Gibt { token_id, token_pw } für eine E-Mail zurück, oder undefined. */
function getUserToken(email) { return _getToken.get(email); }

/** Speichert/aktualisiert den BookStack-Token für eine E-Mail. */
function setUserToken(email, tokenId, tokenPw) { _upsertToken.run(email, tokenId, tokenPw); }

/** Gibt irgendeinen gespeicherten Token zurück (für Cron-Jobs ohne Session-Kontext). */
function getAnyUserToken() { return _getAnyToken.get(); }

/** Gibt alle gespeicherten Tokens zurück (für User-iterierenden Sync). */
function getAllUserTokens() { return _getAllTokens.all(); }

// Orte in DB schreiben (wird von PUT-Endpoint und Job genutzt)
function saveOrteToDb(bookId, orte, userEmail) {
  const now = new Date().toISOString();
  db.transaction(() => {
    if (userEmail) {
      db.prepare('DELETE FROM locations WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
    } else {
      db.prepare('DELETE FROM locations WHERE book_id = ? AND user_email IS NULL').run(bookId);
    }
    const ins = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, stimmung,
        figuren_json, kapitel_json, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < orte.length; i++) {
      const o = orte[i];
      ins.run(
        bookId, o.id, o.name, o.typ || null, o.beschreibung || null,
        o.erste_erwaehnung || null, o.stimmung || null,
        JSON.stringify(o.figuren || []),
        JSON.stringify(o.kapitel || []),
        i, userEmail || null, now
      );
    }
  })();
}

// ── Job-Checkpoint-Verwaltung ─────────────────────────────────────────────────
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

module.exports = { db, saveFigurenToDb, updateFigurenEvents, saveZeitstrahlEvents, saveOrteToDb, reconcilePageIds, getUserToken, setUserToken, getAnyUserToken, getAllUserTokens, saveCheckpoint, loadCheckpoint, deleteCheckpoint };
