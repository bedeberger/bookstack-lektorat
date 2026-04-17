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
  CREATE INDEX IF NOT EXISTS idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pc_book_user      ON page_checks(book_id, user_email);

  CREATE TABLE IF NOT EXISTS book_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    reviewed_at TEXT NOT NULL,
    review_json TEXT,
    model       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_br_book_user_date ON book_reviews(book_id, user_email, reviewed_at DESC);

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
    figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (figure_id, tag)
  );

  -- Kapitelauftritte: eine Zeile pro Figur + Kapitel (chapter_id ist Primärschlüssel, chapter_name Label)
  CREATE TABLE IF NOT EXISTS figure_appearances (
    figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    UNIQUE(figure_id, chapter_id)
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
    role         TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content      TEXT NOT NULL,   -- Freitext der Antwort
    vorschlaege  TEXT,            -- JSON-Array | NULL (nur bei 'assistant')
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    created_at   TEXT NOT NULL,
    context_info TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at);

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
    sort_order INTEGER DEFAULT 0,
    chapter_id INTEGER,
    page_id    INTEGER,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fscene_book ON figure_scenes(book_id, user_email);

  -- Schauplätze: eine Zeile pro Ort (per-User, per-Buch)
  CREATE TABLE IF NOT EXISTS locations (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id                  INTEGER NOT NULL,
    loc_id                   TEXT NOT NULL,
    name                     TEXT NOT NULL,
    typ                      TEXT,
    beschreibung             TEXT,
    erste_erwaehnung         TEXT,
    erste_erwaehnung_page_id INTEGER,
    stimmung                 TEXT,
    sort_order               INTEGER DEFAULT 0,
    user_email               TEXT,
    updated_at               TEXT NOT NULL,
    UNIQUE(book_id, loc_id, user_email)
  );
  CREATE INDEX IF NOT EXISTS idx_loc_book_id ON locations(book_id, user_email);

  -- Junction: Figuren in Szenen (ersetzt figure_scenes.fig_ids JSON)
  CREATE TABLE IF NOT EXISTS scene_figures (
    scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
    fig_id   TEXT NOT NULL,
    PRIMARY KEY (scene_id, fig_id)
  );

  -- Junction: Figuren an Schauplätzen (ersetzt locations.figuren_json)
  CREATE TABLE IF NOT EXISTS location_figures (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    fig_id      TEXT NOT NULL,
    PRIMARY KEY (location_id, fig_id)
  );

  -- Junction: Szenen an Schauplätzen (neue Relation)
  CREATE TABLE IF NOT EXISTS scene_locations (
    scene_id    INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, location_id)
  );

  -- Junction: Kapitel eines Schauplatzs (chapter_id ist Primärschlüssel, chapter_name Label)
  CREATE TABLE IF NOT EXISTS location_chapters (
    location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    PRIMARY KEY (location_id, chapter_id)
  );

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
    kapitel     TEXT,    -- JSON-Array der Kapitelnamen (Label)
    chapter_ids TEXT,    -- JSON-Array der chapter_ids (stabile Referenz)
    seiten      TEXT,    -- JSON-Array der Seitennamen
    figuren     TEXT,    -- JSON-Array [{id, name, typ}]
    sort_order  INTEGER DEFAULT 0,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);

  -- Delta-Cache: Phase-1-Extraktionsergebnisse pro Kapitel (komplett-analyse).
  -- Ungültig sobald sich updated_at einer Seite im Kapitel ändert (pages_sig-Vergleich).
  CREATE TABLE IF NOT EXISTS chapter_extract_cache (
    book_id     INTEGER NOT NULL,
    user_email  TEXT NOT NULL DEFAULT '',
    chapter_key TEXT NOT NULL,
    pages_sig   TEXT NOT NULL,
    extract_json TEXT NOT NULL,
    cached_at   TEXT NOT NULL,
    PRIMARY KEY (book_id, user_email, chapter_key)
  );

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

  -- Job-Laufzeiten: persistente Aufzeichnung aller Job-Durchläufe
  CREATE TABLE IF NOT EXISTS job_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL,
    book_id     INTEGER,
    user_email  TEXT,
    label       TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',
    queued_at   TEXT NOT NULL,
    started_at  TEXT,
    ended_at    TEXT,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    error       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jr_book ON job_runs(book_id);
  CREATE INDEX IF NOT EXISTS idx_jr_user ON job_runs(user_email);

  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);

  -- Kanonische Kapitel-Tabelle: eine Zeile pro Kapitel pro Buch
  CREATE TABLE IF NOT EXISTS chapters (
    chapter_id   INTEGER NOT NULL,
    book_id      INTEGER NOT NULL,
    chapter_name TEXT    NOT NULL,
    updated_at   TEXT,
    PRIMARY KEY (chapter_id, book_id)
  );

  -- Sprach- und Regionkonfiguration pro Buch
  CREATE TABLE IF NOT EXISTS book_settings (
    book_id    INTEGER PRIMARY KEY,
    language   TEXT NOT NULL DEFAULT 'de',
    region     TEXT NOT NULL DEFAULT 'CH',
    updated_at TEXT NOT NULL
  );

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
    const cols6 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols6.includes('context_info')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN context_info TEXT');
    }
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
    const fsCols13 = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (!fsCols13.includes('updated_at')) db.exec('ALTER TABLE figure_scenes ADD COLUMN updated_at TEXT');
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
  if (version < 22) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scene_figures (
        scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        fig_id   TEXT NOT NULL,
        PRIMARY KEY (scene_id, fig_id)
      );
      CREATE TABLE IF NOT EXISTS location_figures (
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        fig_id      TEXT NOT NULL,
        PRIMARY KEY (location_id, fig_id)
      );
      CREATE TABLE IF NOT EXISTS scene_locations (
        scene_id    INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        PRIMARY KEY (scene_id, location_id)
      );
    `);
    // Bestandsdaten: scene_figures aus figure_scenes.fig_ids befüllen (Spalte ggf. nicht mehr vorhanden)
    const fsCols22 = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (fsCols22.includes('fig_ids')) {
      const sceneRows22 = db.prepare('SELECT id, fig_ids FROM figure_scenes WHERE fig_ids IS NOT NULL').all();
      const insSf22 = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, fig_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const sc of sceneRows22) {
          let ids; try { ids = JSON.parse(sc.fig_ids); } catch { ids = []; }
          if (Array.isArray(ids)) for (const fid of ids) if (fid) insSf22.run(sc.id, fid);
        }
      })();
    }
    // Bestandsdaten: location_figures aus locations.figuren_json befüllen (Spalte ggf. nicht mehr vorhanden)
    const locCols22 = db.pragma('table_info(locations)').map(c => c.name);
    if (locCols22.includes('figuren_json')) {
      const locRows22 = db.prepare('SELECT id, figuren_json FROM locations WHERE figuren_json IS NOT NULL').all();
      const insLf22 = db.prepare('INSERT OR IGNORE INTO location_figures (location_id, fig_id) VALUES (?, ?)');
      db.transaction(() => {
        for (const loc of locRows22) {
          let fids; try { fids = JSON.parse(loc.figuren_json); } catch { fids = []; }
          if (Array.isArray(fids)) for (const fid of fids) if (fid) insLf22.run(loc.id, fid);
        }
      })();
    }
    db.prepare('UPDATE schema_version SET version = 22').run();
    logger.info('DB-Migration auf Version 22 abgeschlossen (scene_figures, location_figures, scene_locations + Datenmigration).');
  }

  if (version < 23) {
    // erste_erwaehnung_page_id zu locations hinzufügen
    const locCols23 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols23.includes('erste_erwaehnung_page_id')) {
      db.exec('ALTER TABLE locations ADD COLUMN erste_erwaehnung_page_id INTEGER');
    }
    // location_chapters Junction-Tabelle anlegen
    db.exec(`
      CREATE TABLE IF NOT EXISTS location_chapters (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        chapter_name TEXT NOT NULL,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_name)
      );
    `);
    // Bestandsdaten: location_chapters aus locations.kapitel_json befüllen (Spalte ggf. nicht mehr vorhanden)
    const locColsKap = db.pragma('table_info(locations)').map(c => c.name);
    if (locColsKap.includes('kapitel_json')) {
      const locRows23 = db.prepare('SELECT id, kapitel_json FROM locations WHERE kapitel_json IS NOT NULL').all();
      const insLc23 = db.prepare('INSERT OR IGNORE INTO location_chapters (location_id, chapter_name, haeufigkeit) VALUES (?, ?, ?)');
      db.transaction(() => {
        for (const loc of locRows23) {
          let kaps; try { kaps = JSON.parse(loc.kapitel_json); } catch { kaps = []; }
          if (Array.isArray(kaps)) {
            for (const k of kaps) {
              const name = typeof k === 'string' ? k : k?.name;
              const hf   = typeof k === 'object' ? (k?.haeufigkeit || 1) : 1;
              if (name) insLc23.run(loc.id, name, hf);
            }
          }
        }
      })();
    }
    // Bestandsdaten: erste_erwaehnung_page_id aus pages-Cache befüllen
    db.prepare(`
      UPDATE locations
      SET erste_erwaehnung_page_id = (
        SELECT p.page_id FROM pages p
        WHERE p.book_id = locations.book_id
          AND p.page_name = locations.erste_erwaehnung
        LIMIT 1
      )
      WHERE erste_erwaehnung_page_id IS NULL AND erste_erwaehnung IS NOT NULL
    `).run();
    db.prepare('UPDATE schema_version SET version = 23').run();
    logger.info('DB-Migration auf Version 23 abgeschlossen (location_chapters + erste_erwaehnung_page_id).');
  }

  if (version < 24) {
    // figure_tags: PRIMARY KEY (figure_id, tag) hinzufügen – verhindert doppelte Tags
    const hasTagPK = db.pragma('table_info(figure_tags)').some(c => c.pk > 0);
    if (!hasTagPK) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE figure_tags_new (
            figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            tag       TEXT NOT NULL,
            PRIMARY KEY (figure_id, tag)
          );
          INSERT OR IGNORE INTO figure_tags_new SELECT figure_id, tag FROM figure_tags;
          DROP TABLE figure_tags;
          ALTER TABLE figure_tags_new RENAME TO figure_tags;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 24').run();
    logger.info('DB-Migration auf Version 24 abgeschlossen (figure_tags PRIMARY KEY hinzugefügt).');
  }

  if (version < 25) {
    // figure_appearances: UNIQUE(figure_id, chapter_name) – verhindert Duplikate, ermöglicht INSERT OR REPLACE
    const hasAppUnique = db.pragma('index_list(figure_appearances)').some(i => i.unique === 1);
    if (!hasAppUnique) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE figure_appearances_new (
            figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            chapter_name TEXT NOT NULL,
            haeufigkeit  INTEGER DEFAULT 1,
            chapter_id   INTEGER,
            UNIQUE(figure_id, chapter_name)
          );
          INSERT OR IGNORE INTO figure_appearances_new (figure_id, chapter_name, haeufigkeit, chapter_id)
            SELECT figure_id, chapter_name, SUM(haeufigkeit), MAX(chapter_id)
            FROM figure_appearances
            GROUP BY figure_id, chapter_name;
          DROP TABLE figure_appearances;
          ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 25').run();
    logger.info('DB-Migration auf Version 25 abgeschlossen (figure_appearances UNIQUE-Constraint hinzugefügt).');
  }

  if (version < 26) {
    // Veraltete JSON-Spalten entfernen – Daten leben jetzt ausschliesslich in den Junction-Tabellen
    const fsCols26  = db.pragma('table_info(figure_scenes)').map(c => c.name);
    const locCols26 = db.pragma('table_info(locations)').map(c => c.name);
    if (fsCols26.includes('fig_ids'))       db.exec('ALTER TABLE figure_scenes DROP COLUMN fig_ids');
    if (locCols26.includes('figuren_json')) db.exec('ALTER TABLE locations DROP COLUMN figuren_json');
    if (locCols26.includes('kapitel_json')) db.exec('ALTER TABLE locations DROP COLUMN kapitel_json');
    db.prepare('UPDATE schema_version SET version = 26').run();
    logger.info('DB-Migration auf Version 26 abgeschlossen (veraltete JSON-Spalten fig_ids / figuren_json / kapitel_json entfernt).');
  }

  if (version < 27) {
    // job_runs.book_id: TEXT → INTEGER (war Tippfehler, alle anderen book_id-Spalten sind INTEGER)
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE job_runs_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id      TEXT NOT NULL UNIQUE,
          type        TEXT NOT NULL,
          book_id     INTEGER,
          user_email  TEXT,
          label       TEXT,
          status      TEXT NOT NULL DEFAULT 'queued',
          queued_at   TEXT NOT NULL,
          started_at  TEXT,
          ended_at    TEXT,
          tokens_in   INTEGER DEFAULT 0,
          tokens_out  INTEGER DEFAULT 0,
          error       TEXT
        );
        INSERT INTO job_runs_new
          SELECT id, job_id, type, CAST(book_id AS INTEGER), user_email, label, status,
                 queued_at, started_at, ended_at, tokens_in, tokens_out, error
          FROM job_runs;
        DROP TABLE job_runs;
        ALTER TABLE job_runs_new RENAME TO job_runs;
        CREATE INDEX IF NOT EXISTS idx_jr_book ON job_runs(book_id);
        CREATE INDEX IF NOT EXISTS idx_jr_user ON job_runs(user_email);
      `);
    })();
    db.pragma('foreign_keys = ON');
    db.prepare('UPDATE schema_version SET version = 27').run();
    logger.info('DB-Migration auf Version 27 abgeschlossen (job_runs.book_id TEXT → INTEGER).');
  }

  if (version < 28) {
    // chat_messages.role: CHECK-Constraint hinzufügen
    const cmSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'").get()?.sql || '';
    if (!cmSql.includes('CHECK')) {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE chat_messages_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role         TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content      TEXT NOT NULL,
            vorschlaege  TEXT,
            tokens_in    INTEGER,
            tokens_out   INTEGER,
            created_at   TEXT NOT NULL,
            context_info TEXT
          );
          INSERT INTO chat_messages_new
            SELECT id, session_id, role, content, vorschlaege, tokens_in, tokens_out, created_at, context_info
            FROM chat_messages;
          DROP TABLE chat_messages;
          ALTER TABLE chat_messages_new RENAME TO chat_messages;
          CREATE INDEX IF NOT EXISTS idx_cm_session_id ON chat_messages(session_id);
        `);
      })();
      db.pragma('foreign_keys = ON');
    }
    db.prepare('UPDATE schema_version SET version = 28').run();
    logger.info('DB-Migration auf Version 28 abgeschlossen (chat_messages.role CHECK-Constraint hinzugefügt).');
  }
  if (version < 29) {
    db.exec('ALTER TABLE job_runs ADD COLUMN tokens_per_sec REAL');
    db.prepare('UPDATE schema_version SET version = 29').run();
    logger.info('DB-Migration auf Version 29 abgeschlossen (job_runs.tokens_per_sec hinzugefügt).');
  }
  if (version < 30) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_settings (
        book_id    INTEGER PRIMARY KEY,
        language   TEXT NOT NULL DEFAULT 'de',
        region     TEXT NOT NULL DEFAULT 'CH',
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare('UPDATE schema_version SET version = 30').run();
    logger.info('DB-Migration auf Version 30 abgeschlossen (book_settings Tabelle hinzugefügt).');
  }

  if (version < 31) {
    const figCols31  = db.pragma('table_info(figures)').map(c => c.name);
    const frelCols31 = db.pragma('table_info(figure_relations)').map(c => c.name);
    if (!figCols31.includes('sozialschicht'))    db.exec('ALTER TABLE figures ADD COLUMN sozialschicht TEXT');
    if (!frelCols31.includes('machtverhaltnis')) db.exec('ALTER TABLE figure_relations ADD COLUMN machtverhaltnis INTEGER');
    db.prepare('UPDATE schema_version SET version = 31').run();
    logger.info('DB-Migration auf Version 31 abgeschlossen (figures.sozialschicht + figure_relations.machtverhaltnis hinzugefügt).');
  }

  if (version < 32) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS character_arcs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL,
        fig_id          TEXT NOT NULL,
        user_email      TEXT,
        arc_typ         TEXT,
        ausgangszustand TEXT,
        endzustand      TEXT,
        gesamtbogen     TEXT,
        updated_at      TEXT NOT NULL,
        UNIQUE(book_id, fig_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_carc_book ON character_arcs(book_id, user_email);
      CREATE TABLE IF NOT EXISTS arc_stages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        arc_id           INTEGER NOT NULL REFERENCES character_arcs(id) ON DELETE CASCADE,
        sort_order       INTEGER DEFAULT 0,
        kapitel          TEXT,
        soziale_position TEXT,
        innere_haltung   TEXT,
        beziehungsstatus TEXT,
        wendepunkt       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_astage_arc ON arc_stages(arc_id);
    `);
    db.prepare('UPDATE schema_version SET version = 32').run();
    logger.info('DB-Migration auf Version 32 abgeschlossen (character_arcs + arc_stages Tabellen hinzugefügt).');
  }
  if (version < 33) {
    const cols33 = db.pragma('table_info(arc_stages)').map(c => c.name);
    if (!cols33.includes('chapter_id')) {
      db.exec('ALTER TABLE arc_stages ADD COLUMN chapter_id INTEGER');
    }
    db.prepare('UPDATE schema_version SET version = 33').run();
    logger.info('DB-Migration auf Version 33 abgeschlossen (arc_stages.chapter_id hinzugefügt).');
  }
  if (version < 34) {
    const cols34 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cols34.includes('tps')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN tps REAL');
    }
    db.prepare('UPDATE schema_version SET version = 34').run();
    logger.info('DB-Migration auf Version 34 abgeschlossen (chat_messages.tps hinzugefügt).');
  }
  if (version < 35) {
    db.exec(`
      DROP TABLE IF EXISTS arc_stages;
      DROP TABLE IF EXISTS character_arcs;
    `);
    db.prepare('UPDATE schema_version SET version = 35').run();
    logger.info('DB-Migration auf Version 35 abgeschlossen (character_arcs + arc_stages entfernt).');
  }
  if (version < 36) {
    const bsCols36 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols36.includes('buchtyp'))     db.exec('ALTER TABLE book_settings ADD COLUMN buchtyp TEXT');
    if (!bsCols36.includes('buch_kontext')) db.exec('ALTER TABLE book_settings ADD COLUMN buch_kontext TEXT');
    db.prepare('UPDATE schema_version SET version = 36').run();
    logger.info('DB-Migration auf Version 36 abgeschlossen (book_settings.buchtyp + buch_kontext hinzugefügt).');
  }
  if (version < 37) {
    db.exec('ALTER TABLE page_checks ADD COLUMN chapter_id INTEGER');
    db.prepare('UPDATE schema_version SET version = 37').run();
    logger.info('DB-Migration auf Version 37 abgeschlossen (page_checks.chapter_id hinzugefügt).');
  }
  if (version < 38) {
    db.exec(`CREATE TABLE IF NOT EXISTS chapters (
      chapter_id   INTEGER NOT NULL,
      book_id      INTEGER NOT NULL,
      chapter_name TEXT    NOT NULL,
      updated_at   TEXT,
      PRIMARY KEY (chapter_id, book_id)
    )`);
    db.prepare('UPDATE schema_version SET version = 38').run();
    logger.info('DB-Migration auf Version 38 abgeschlossen (chapters-Tabelle hinzugefügt).');
  }
  if (version < 39) {
    // Schritt 1: chapter_id in figure_appearances befüllen (Bestandsdaten)
    db.exec(`
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
    `);
    // Schritt 2: chapter_id in location_chapters befüllen (Bestandsdaten)
    db.exec(`
      UPDATE location_chapters
      SET chapter_id = (
        SELECT DISTINCT p.chapter_id FROM pages p
        JOIN locations l ON l.id = location_chapters.location_id
        WHERE p.book_id = l.book_id
          AND p.chapter_name = location_chapters.chapter_name
          AND p.chapter_id IS NOT NULL
        LIMIT 1
      )
      WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
    `);
    // Schritt 3: figure_appearances neu anlegen – UNIQUE auf chapter_id statt chapter_name
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE figure_appearances_v39 (
        figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        haeufigkeit  INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT OR IGNORE INTO figure_appearances_v39 (figure_id, chapter_id, chapter_name, haeufigkeit)
        SELECT figure_id, chapter_id, chapter_name, haeufigkeit
        FROM figure_appearances WHERE chapter_id IS NOT NULL;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_v39 RENAME TO figure_appearances;
    `);
    db.pragma('foreign_keys = ON');
    // Schritt 4: location_chapters neu anlegen – PRIMARY KEY auf chapter_id statt chapter_name
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE location_chapters_v39 (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT OR IGNORE INTO location_chapters_v39 (location_id, chapter_id, chapter_name, haeufigkeit)
        SELECT location_id, chapter_id, chapter_name, haeufigkeit
        FROM location_chapters WHERE chapter_id IS NOT NULL;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_v39 RENAME TO location_chapters;
    `);
    db.pragma('foreign_keys = ON');
    // Schritt 5: chapter_ids-Spalte zu zeitstrahl_events hinzufügen
    const zeCols = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols.includes('chapter_ids')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN chapter_ids TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 39').run();
    logger.info('DB-Migration auf Version 39 abgeschlossen (chapter_id als PK in figure_appearances + location_chapters; chapter_ids in zeitstrahl_events).');
  }
  if (version < 40) {
    // Composite-Indizes für häufige Query-Muster (page_checks History, book_reviews History,
    // chat_messages-Sortierung). Alte Single-Column-Indizes werden durch die neuen ersetzt.
    db.exec(`
      DROP INDEX IF EXISTS idx_pc_page_id;
      DROP INDEX IF EXISTS idx_pc_book_id;
      DROP INDEX IF EXISTS idx_br_book_id;
      DROP INDEX IF EXISTS idx_cm_session_id;
      CREATE INDEX IF NOT EXISTS idx_pc_page_user_date  ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pc_book_user       ON page_checks(book_id, user_email);
      CREATE INDEX IF NOT EXISTS idx_br_book_user_date  ON book_reviews(book_id, user_email, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at);
    `);
    db.prepare('UPDATE schema_version SET version = 40').run();
    logger.info('DB-Migration auf Version 40 abgeschlossen (Composite-Indizes für page_checks, book_reviews, chat_messages).');
  }

  // ── Schutzchecks: kompensieren DBs, bei denen durch frühere Versions-Bugs
  //    einzelne Migrationen übersprungen wurden (z.B. v21 vor v19/v20 gesetzt).
  //    Diese Checks sind idempotent und laufen bei jedem Start.
  const feColsCheck = db.pragma('table_info(figure_events)').map(c => c.name);
  if (feColsCheck.length > 0 && !feColsCheck.includes('typ')) {
    db.exec("ALTER TABLE figure_events ADD COLUMN typ TEXT DEFAULT 'persoenlich'");
    logger.info('figure_events.typ nachgerüstet.');
  }
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
  const fsColsCheck = db.pragma('table_info(figure_scenes)').map(c => c.name);
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('chapter_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN chapter_id INTEGER');
    logger.info('figure_scenes.chapter_id nachgerüstet.');
  }
  if (fsColsCheck.length > 0 && !fsColsCheck.includes('page_id')) {
    db.exec('ALTER TABLE figure_scenes ADD COLUMN page_id INTEGER');
    logger.info('figure_scenes.page_id nachgerüstet.');
  }
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
      INSERT INTO figures (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung, sozialschicht, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insApp = db.prepare('INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, chapter_name, haeufigkeit) VALUES (?, ?, ?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)');

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.beschreibung || null, f.sozialschicht || null, i, userEmail || null, now
      );
      for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
      for (const app of (f.kapitel || [])) {
        const chapId = idMaps?.chNameToId?.[app.name] ?? null;
        if (chapId != null) insApp.run(fid, chapId, app.name, app.haeufigkeit || 1);
      }
      for (const bz of (f.beziehungen || [])) insRel.run(bookId, f.id, bz.figur_id, bz.typ, bz.beschreibung || null, bz.machtverhaltnis ?? null, userEmail || null);
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

  // 11. location_chapters: chapter_id aus chapter_name befüllen
  db.prepare(`
    UPDATE location_chapters
    SET chapter_id = (
      SELECT DISTINCT p.chapter_id FROM pages p
      JOIN locations l ON l.id = location_chapters.location_id
      WHERE p.book_id = l.book_id
        AND p.chapter_name = location_chapters.chapter_name
        AND p.chapter_id IS NOT NULL
      LIMIT 1
    )
    WHERE chapter_id IS NULL AND chapter_name IS NOT NULL
  `).run();

  // 12. location_chapters: chapter_name per chapter_id aktualisieren (Umbenennungen heilen)
  db.prepare(`
    UPDATE location_chapters
    SET chapter_name = (
      SELECT DISTINCT p.chapter_name FROM pages p
      JOIN locations l ON l.id = location_chapters.location_id
      WHERE p.book_id = l.book_id
        AND p.chapter_id = location_chapters.chapter_id
      LIMIT 1
    )
    WHERE chapter_id IS NOT NULL
  `).run();

  // 13. locations: erste_erwaehnung_page_id aus erste_erwaehnung befüllen / aktualisieren
  db.prepare(`
    UPDATE locations
    SET erste_erwaehnung_page_id = (
      SELECT p.page_id FROM pages p
      WHERE p.book_id = locations.book_id
        AND p.page_name = locations.erste_erwaehnung
      LIMIT 1
    )
    WHERE erste_erwaehnung IS NOT NULL
  `).run();
}

// ── User-Token-Verwaltung ─────────────────────────────────────────────────────

const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');

const _getToken = db.prepare('SELECT token_id, token_pw FROM user_tokens WHERE email = ?');
const _upsertToken = db.prepare(`
  INSERT INTO user_tokens (email, token_id, token_pw, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    token_id=excluded.token_id, token_pw=excluded.token_pw, updated_at=excluded.updated_at
`);
const _getAnyToken = db.prepare('SELECT token_id, token_pw FROM user_tokens LIMIT 1');
const _getAllTokens = db.prepare('SELECT email, token_id, token_pw FROM user_tokens');

/** Entschlüsselt ein Token-Row-Objekt. Migriert Klartext automatisch zu verschlüsselt. */
function _decryptRow(row, email) {
  if (!row) return row;
  const needsMigration = !isEncrypted(row.token_id) || !isEncrypted(row.token_pw);
  const plainId = decrypt(row.token_id);
  const plainPw = decrypt(row.token_pw);
  if (needsMigration && email) {
    _upsertToken.run(email, encrypt(plainId), encrypt(plainPw));
  }
  return { token_id: plainId, token_pw: plainPw };
}

/** Gibt { token_id, token_pw } für eine E-Mail zurück, oder undefined. */
function getUserToken(email) { return _decryptRow(_getToken.get(email), email); }

/** Speichert/aktualisiert den BookStack-Token für eine E-Mail (verschlüsselt). */
function setUserToken(email, tokenId, tokenPw) { _upsertToken.run(email, encrypt(tokenId), encrypt(tokenPw)); }

/** Gibt irgendeinen gespeicherten Token zurück (für Cron-Jobs ohne Session-Kontext). */
function getAnyUserToken() {
  const row = _getAnyToken.get();
  return row ? { token_id: decrypt(row.token_id), token_pw: decrypt(row.token_pw) } : undefined;
}

/** Gibt alle gespeicherten Tokens zurück (für User-iterierenden Sync). */
function getAllUserTokens() {
  return _getAllTokens.all().map(row => ({
    email: row.email,
    token_id: decrypt(row.token_id),
    token_pw: decrypt(row.token_pw),
  }));
}

// Orte in DB schreiben (wird von PUT-Endpoint und Job genutzt).
// Verwendet UPSERT by loc_id statt Delete+Re-Insert, damit bestehende
// scene_locations-Einträge (ON DELETE CASCADE) erhalten bleiben.
// chNameToId: optionaler Map Kapitelname → chapter_id. Wird nicht übergeben,
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
    // Bestehende loc_ids (mit ihren integer IDs) holen
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
        // Existierende Zeile aktualisieren – integer id (und scene_locations) bleibt erhalten
        upd.run(o.name, o.typ || null, o.beschreibung || null,
          o.erste_erwaehnung || null, o.stimmung || null,
          i, now, locDbId);
        delLf.run(locDbId);
        delLc.run(locDbId);
      } else {
        // Neue Zeile einfügen
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

// ── Buch-Einstellungen (Sprache + Region) ─────────────────────────────────────

const _getBookSettings = db.prepare('SELECT language, region, buchtyp, buch_kontext FROM book_settings WHERE book_id = ?');
const _upsertBookSettings = db.prepare(`
  INSERT INTO book_settings (book_id, language, region, buchtyp, buch_kontext, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    language=excluded.language, region=excluded.region,
    buchtyp=excluded.buchtyp, buch_kontext=excluded.buch_kontext,
    updated_at=excluded.updated_at
`);

/** Gibt {language, region, buchtyp, buch_kontext} für ein Buch zurück. */
function getBookSettings(bookId) {
  return _getBookSettings.get(parseInt(bookId)) || { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null };
}

/** Locale-Key für ein Buch: z.B. "de-CH", "en-US". */
function getBookLocale(bookId) {
  const { language, region } = getBookSettings(bookId);
  return `${language}-${region}`;
}

/** Speichert/aktualisiert Sprache, Region, Buchtyp und Buchkontext für ein Buch. */
function saveBookSettings(bookId, language, region, buchtyp, buchKontext) {
  _upsertBookSettings.run(
    parseInt(bookId), language, region,
    buchtyp || null, buchKontext || null,
    new Date().toISOString()
  );
}

// Sozialschicht + Machtverhältnis für bestehende Figuren/Beziehungen nachträglich setzen.
// figurenSoziogramm: [{ fig_id, sozialschicht }]
// beziehungenMacht:  [{ from_fig_id, to_fig_id, machtverhaltnis }]
function updateFigurenSoziogramm(bookId, figurenSoziogramm, beziehungenMacht, userEmail) {
  db.transaction(() => {
    const updFig = db.prepare(
      'UPDATE figures SET sozialschicht = ? WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    );
    for (const f of (figurenSoziogramm || [])) {
      updFig.run(f.sozialschicht || null, bookId, f.fig_id, userEmail || null);
    }
    const updRel = db.prepare(
      'UPDATE figure_relations SET machtverhaltnis = ? WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ? AND user_email IS ?'
    );
    for (const bz of (beziehungenMacht || [])) {
      updRel.run(bz.machtverhaltnis ?? null, bookId, bz.from_fig_id, bz.to_fig_id, userEmail || null);
    }
  })();
}

/** Fügt kapitelübergreifende Beziehungen zur figure_relations-Tabelle hinzu,
 *  ohne bestehende zu löschen. Dedupliziert: überspringe wenn identisches Paar
 *  (from_fig_id, to_fig_id, typ) oder die umgekehrte Richtung bereits existiert. */
function addFigurenBeziehungen(bookId, beziehungen, userEmail) {
  const DIRECTED = new Set(['elternteil', 'kind', 'mentor', 'schuetzling', 'patronage']);
  const check = db.prepare(
    'SELECT COUNT(*) as cnt FROM figure_relations WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ? AND typ = ? AND user_email IS ?'
  );
  const ins = db.prepare(
    'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const bz of beziehungen) {
      if (!bz.von || !bz.zu || !bz.typ) continue;
      const em = userEmail || null;
      const fwd = check.get(bookId, bz.von, bz.zu, bz.typ, em)?.cnt > 0;
      const bwd = !DIRECTED.has(bz.typ) && check.get(bookId, bz.zu, bz.von, bz.typ, em)?.cnt > 0;
      if (!fwd && !bwd) {
        ins.run(bookId, bz.von, bz.zu, bz.typ, bz.beschreibung || null, bz.machtverhaltnis ?? null, em);
      }
    }
  })();
}

/** Figuren eines Kapitels laden (via figure_appearances).
 *  Fallback: alle Buchfiguren, wenn keine Kapitelzuordnung existiert.
 *  Gibt kompakte Objekte zurück: { name, kurzname, geschlecht, beruf, beschreibung, typ } */
function getChapterFigures(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const cols = 'f.name, f.kurzname, f.geschlecht, f.beruf, f.beschreibung, f.typ';
  // Versuch 1: Figuren mit Kapitelauftritt
  if (chapterId) {
    const rows = db.prepare(`
      SELECT ${cols} FROM figures f
      JOIN figure_appearances fa ON fa.figure_id = f.id
      WHERE f.book_id = ? AND fa.chapter_id = ? AND f.user_email IS ?
      ORDER BY fa.haeufigkeit DESC, f.sort_order, f.id
    `).all(bookId, chapterId, userEmail || null);
    if (rows.length > 0) return rows;
  }
  // Fallback: alle Buchfiguren
  return db.prepare(`
    SELECT ${cols} FROM figures f
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY f.sort_order, f.id
  `).all(bookId, userEmail || null);
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

module.exports = { db, saveFigurenToDb, addFigurenBeziehungen, updateFigurenEvents, updateFigurenSoziogramm, saveZeitstrahlEvents, saveOrteToDb, reconcilePageIds, getUserToken, setUserToken, getAnyUserToken, getAllUserTokens, saveCheckpoint, loadCheckpoint, deleteCheckpoint, insertJobRun, startJobRun, endJobRun, getBookSettings, getBookLocale, saveBookSettings, loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache, cleanupStuckJobRuns, getChapterFigures };
