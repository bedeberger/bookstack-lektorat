const fs = require('fs');
const path = require('path');
const { db, DB_FILE } = require('./connection');
const logger = require('../logger');
const { SQUASHED_SCHEMA, SQUASHED_VERSION } = require('./squashed-schema');

// Fresh-DB fast path: skip 119-step legacy migration chain by installing the
// squashed final schema as a single SQL batch. Detection: schema_version table
// is missing iff this is a brand-new install (legacy initial block always
// creates it). On legacy installs we fall through to the unchanged top-level
// skeleton (idempotent IF NOT EXISTS) plus runMigrations() chain.
//
// Drift between SQUASHED_SCHEMA and the legacy chain is gated by
// tests/unit/squash-drift.test.mjs.
const _hasSchemaVersion = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
).get();
// FORCE_LEGACY_MIGRATIONS=1 makes the squash-drift test exercise the legacy
// migration chain even on a fresh DB. Never set in production.
const IS_FRESH_INSTALL =
  !_hasSchemaVersion && process.env.FORCE_LEGACY_MIGRATIONS !== '1';

if (IS_FRESH_INSTALL) {
  db.exec(SQUASHED_SCHEMA);
  logger.info(`DB frisch initialisiert via Schema-Squash (Version ${SQUASHED_VERSION}).`);
}

// Serialisiert parallele Migrations-Runner (z.B. node --test --test-concurrency
// mit geteiltem DB_PATH). Ohne Lock racen mehrere Worker auf ALTER TABLE und
// laufen in "duplicate column"-Fehler, weil Pragma-Reads vor dem Write
// stattfinden. Lock haelt nur den Migrations-Scope, kein Runtime-Block.
function _withMigrationLock(fn) {
  const lockPath = `${DB_FILE}.migration-lock`;
  const start = Date.now();
  let fd;
  while (true) {
    try { fd = fs.openSync(lockPath, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > 30000) throw new Error(`Migration lock timeout: ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

if (!IS_FRESH_INSTALL) db.exec(`
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

  CREATE TABLE IF NOT EXISTS book_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    book_name   TEXT,
    reviewed_at TEXT NOT NULL,
    review_json TEXT,
    model       TEXT
  );

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
    wohnadresse  TEXT,
    beschreibung TEXT,
    sort_order   INTEGER DEFAULT 0,
    meta         TEXT,
    updated_at   TEXT NOT NULL,
    UNIQUE(book_id, fig_id)
  );
  CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id);

  CREATE TABLE IF NOT EXISTS figure_tags (
    figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (figure_id, tag)
  );

  CREATE TABLE IF NOT EXISTS figure_appearances (
    figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    UNIQUE(figure_id, chapter_id)
  );
  -- chapter_name wird in Migration 70 entfernt; bleibt im initial-Schema, damit
  -- Daten-Migrationen 39-69 (UPDATE figure_appearances SET chapter_id ...
  -- WHERE chapter_name = ...) auf frischer DB durchlaufen.

  CREATE TABLE IF NOT EXISTS figure_events (
    figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    bedeutung  TEXT,
    typ        TEXT DEFAULT 'persoenlich',
    sort_order INTEGER DEFAULT 0
  );
  -- kapitel/seite/chapter_id/page_id werden via spätere ALTER/Migration ergänzt;
  -- kapitel und seite in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS figure_relations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id      INTEGER NOT NULL,
    from_fig_id  TEXT NOT NULL,
    to_fig_id    TEXT NOT NULL,
    typ          TEXT NOT NULL,
    beschreibung TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_frel_book_id ON figure_relations(book_id);

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

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id           INTEGER NOT NULL,
    book_name         TEXT,
    kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
    page_id           INTEGER,
    page_name         TEXT,
    user_email        TEXT    NOT NULL,
    created_at        TEXT    NOT NULL,
    last_message_at   TEXT    NOT NULL,
    opening_page_text TEXT,
    CHECK ((kind = 'page' AND page_id IS NOT NULL)
        OR (kind = 'book' AND page_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_cs_page_id ON chat_sessions(page_id, user_email);
  CREATE INDEX IF NOT EXISTS idx_cs_book_id ON chat_sessions(book_id, user_email);
  -- idx_cs_book_singleton (partial UNIQUE on kind='book') wird in Migration 69 angelegt

  CREATE TABLE IF NOT EXISTS chat_messages (
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
  CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS user_tokens (
    email      TEXT PRIMARY KEY,
    token_id   TEXT NOT NULL,
    token_pw   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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
  -- kapitel/seite werden in Migration 70 entfernt.

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

  CREATE TABLE IF NOT EXISTS location_chapters (
    location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    chapter_id   INTEGER NOT NULL,
    chapter_name TEXT,
    haeufigkeit  INTEGER DEFAULT 1,
    PRIMARY KEY (location_id, chapter_id)
  );
  -- chapter_name wird in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS continuity_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL,
    user_email  TEXT,
    checked_at  TEXT NOT NULL,
    summary     TEXT,
    model       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cc_book_id ON continuity_checks(book_id, user_email);

  CREATE TABLE IF NOT EXISTS continuity_issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL,
    user_email   TEXT,
    schwere      TEXT,
    typ          TEXT,
    beschreibung TEXT,
    stelle_a     TEXT,
    stelle_b     TEXT,
    empfehlung   TEXT,
    sort_order   INTEGER DEFAULT 0,
    updated_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ci_check ON continuity_issues(check_id);
  CREATE INDEX IF NOT EXISTS idx_ci_book  ON continuity_issues(book_id, user_email);

  CREATE TABLE IF NOT EXISTS continuity_issue_figures (
    issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
    fig_id     TEXT,
    figur_name TEXT,
    sort_order INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cif_issue ON continuity_issue_figures(issue_id);

  CREATE TABLE IF NOT EXISTS continuity_issue_chapters (
    issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
    chapter_id   INTEGER,
    chapter_name TEXT,
    sort_order   INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cic_issue ON continuity_issue_chapters(issue_id);
  -- chapter_name wird in Migration 70 entfernt.

  CREATE TABLE IF NOT EXISTS zeitstrahl_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    typ        TEXT DEFAULT 'persoenlich',
    bedeutung  TEXT,
    kapitel     TEXT,
    chapter_ids TEXT,
    seiten      TEXT,
    figuren     TEXT,
    sort_order  INTEGER DEFAULT 0,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ze_book_id ON zeitstrahl_events(book_id, user_email);

  CREATE TABLE IF NOT EXISTS chapter_extract_cache (
    book_id     INTEGER NOT NULL,
    user_email  TEXT NOT NULL DEFAULT '',
    chapter_key TEXT NOT NULL,
    pages_sig   TEXT NOT NULL,
    extract_json TEXT NOT NULL,
    cached_at   TEXT NOT NULL,
    PRIMARY KEY (book_id, user_email, chapter_key)
  );

  CREATE TABLE IF NOT EXISTS job_checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type   TEXT NOT NULL,
    book_id    INTEGER NOT NULL,
    user_email TEXT NOT NULL DEFAULT '',
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_type, book_id, user_email)
  );

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

  CREATE TABLE IF NOT EXISTS chapters (
    chapter_id   INTEGER NOT NULL,
    book_id      INTEGER NOT NULL,
    chapter_name TEXT    NOT NULL,
    updated_at   TEXT,
    PRIMARY KEY (chapter_id, book_id)
  );

  CREATE TABLE IF NOT EXISTS book_settings (
    book_id    INTEGER PRIMARY KEY,
    language   TEXT NOT NULL DEFAULT 'de',
    region     TEXT NOT NULL DEFAULT 'CH',
    updated_at TEXT NOT NULL
  );

`);

function runMigrations() {
  return _withMigrationLock(_runMigrationsLocked);
}

function _runMigrationsLocked() {
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
      CREATE INDEX IF NOT EXISTS idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pc_book_user      ON page_checks(book_id, user_email);
      CREATE INDEX IF NOT EXISTS idx_br_book_user_date ON book_reviews(book_id, user_email, reviewed_at DESC);
    `);
    db.prepare('UPDATE schema_version SET version = 3').run();
    logger.info('DB-Migration auf Version 3 abgeschlossen (user_email zu allen Datentabellen hinzugefügt).');
  }
  if (version < 4) {
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
    const faCols = db.pragma('table_info(figure_appearances)').map(c => c.name);
    if (!faCols.includes('chapter_id')) db.exec('ALTER TABLE figure_appearances ADD COLUMN chapter_id INTEGER');
    const feCols18 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols18.includes('chapter_id')) db.exec('ALTER TABLE figure_events ADD COLUMN chapter_id INTEGER');
    if (!feCols18.includes('page_id'))    db.exec('ALTER TABLE figure_events ADD COLUMN page_id INTEGER');
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
    const locCols23 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols23.includes('erste_erwaehnung_page_id')) {
      db.exec('ALTER TABLE locations ADD COLUMN erste_erwaehnung_page_id INTEGER');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS location_chapters (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        chapter_name TEXT NOT NULL,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_name)
      );
    `);
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
    const fsCols26  = db.pragma('table_info(figure_scenes)').map(c => c.name);
    const locCols26 = db.pragma('table_info(locations)').map(c => c.name);
    if (fsCols26.includes('fig_ids'))       db.exec('ALTER TABLE figure_scenes DROP COLUMN fig_ids');
    if (locCols26.includes('figuren_json')) db.exec('ALTER TABLE locations DROP COLUMN figuren_json');
    if (locCols26.includes('kapitel_json')) db.exec('ALTER TABLE locations DROP COLUMN kapitel_json');
    db.prepare('UPDATE schema_version SET version = 26').run();
    logger.info('DB-Migration auf Version 26 abgeschlossen (veraltete JSON-Spalten fig_ids / figuren_json / kapitel_json entfernt).');
  }

  if (version < 27) {
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
    const zeCols = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols.includes('chapter_ids')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN chapter_ids TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 39').run();
    logger.info('DB-Migration auf Version 39 abgeschlossen (chapter_id als PK in figure_appearances + location_chapters; chapter_ids in zeitstrahl_events).');
  }
  if (version < 40) {
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
  if (version < 41) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email            TEXT PRIMARY KEY,
        name             TEXT,
        created_at       TEXT NOT NULL,
        last_login_at    TEXT,
        locale           TEXT,
        theme            TEXT,
        default_buchtyp  TEXT,
        default_language TEXT,
        default_region   TEXT
      );
      INSERT OR IGNORE INTO users (email, created_at)
      SELECT email, datetime('now') FROM user_tokens;
    `);
    db.prepare('UPDATE schema_version SET version = 41').run();
    logger.info('DB-Migration auf Version 41 abgeschlossen (users-Tabelle).');
  }
  if (version < 42) {
    const psCols42 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols42.includes('sentences'))       db.exec('ALTER TABLE page_stats ADD COLUMN sentences INTEGER');
    if (!psCols42.includes('dialog_chars'))    db.exec('ALTER TABLE page_stats ADD COLUMN dialog_chars INTEGER');
    if (!psCols42.includes('pronoun_counts'))  db.exec('ALTER TABLE page_stats ADD COLUMN pronoun_counts TEXT');
    if (!psCols42.includes('metrics_version')) db.exec('ALTER TABLE page_stats ADD COLUMN metrics_version INTEGER DEFAULT 0');
    if (!psCols42.includes('content_sig'))     db.exec('ALTER TABLE page_stats ADD COLUMN content_sig TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS page_figure_mentions (
        page_id      INTEGER NOT NULL,
        figure_id    INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (page_id, figure_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pfm_figure ON page_figure_mentions(figure_id);
      CREATE INDEX IF NOT EXISTS idx_pfm_page   ON page_figure_mentions(page_id);
    `);
    db.prepare('UPDATE schema_version SET version = 42').run();
    logger.info('DB-Migration auf Version 42 abgeschlossen (page_stats-Index-Felder + page_figure_mentions).');
  }
  if (version < 43) {
    const healed = db.prepare(`
      UPDATE page_stats
      SET book_id = (SELECT p.book_id FROM pages p WHERE p.page_id = page_stats.page_id)
      WHERE EXISTS (SELECT 1 FROM pages p WHERE p.page_id = page_stats.page_id)
        AND book_id <> (SELECT p.book_id FROM pages p WHERE p.page_id = page_stats.page_id)
    `).run();
    db.prepare('UPDATE schema_version SET version = 43').run();
    logger.info(`DB-Migration auf Version 43 abgeschlossen (page_stats.book_id für ${healed.changes} verschobene Seiten geheilt).`);
  }
  if (version < 44) {
    const figCols44 = db.pragma('table_info(figures)').map(c => c.name);
    const addCol = (name, def) => {
      if (!figCols44.includes(name)) db.exec(`ALTER TABLE figures ADD COLUMN ${name} ${def}`);
    };
    addCol('praesenz',                 'TEXT');
    addCol('rolle',                    'TEXT');
    addCol('motivation',               'TEXT');
    addCol('konflikt',                 'TEXT');
    addCol('entwicklung',              'TEXT');
    addCol('erste_erwaehnung',         'TEXT');
    addCol('erste_erwaehnung_page_id', 'INTEGER');
    addCol('schluesselzitate',         'TEXT');
    const bf = db.prepare(`
      UPDATE figures SET praesenz = CASE
        WHEN typ = 'hauptfigur' THEN 'zentral'
        WHEN (SELECT COUNT(*) FROM figure_appearances WHERE figure_id = figures.id) >= 5 THEN 'zentral'
        WHEN COALESCE((SELECT SUM(haeufigkeit) FROM figure_appearances WHERE figure_id = figures.id), 0) >= 20 THEN 'zentral'
        WHEN typ IN ('antagonist','mentor') THEN 'regelmaessig'
        WHEN (SELECT COUNT(*) FROM figure_appearances WHERE figure_id = figures.id) >= 2 THEN 'regelmaessig'
        WHEN COALESCE((SELECT SUM(haeufigkeit) FROM figure_appearances WHERE figure_id = figures.id), 0) >= 3 THEN 'punktuell'
        ELSE 'randfigur'
      END
      WHERE praesenz IS NULL
    `).run();
    db.prepare('UPDATE schema_version SET version = 44').run();
    logger.info(`DB-Migration auf Version 44 abgeschlossen (figures-Anreicherung: praesenz/rolle/motivation/konflikt/entwicklung/erste_erwaehnung/schluesselzitate; ${bf.changes} Figuren praesenz-gebackfillt).`);
  }
  if (version < 45) {
    const frelCols45 = db.pragma('table_info(figure_relations)').map(c => c.name);
    if (!frelCols45.includes('belege')) db.exec('ALTER TABLE figure_relations ADD COLUMN belege TEXT');
    db.prepare('UPDATE schema_version SET version = 45').run();
    logger.info('DB-Migration auf Version 45 abgeschlossen (figure_relations.belege hinzugefügt).');
  }
  if (version < 46) {
    const psCols46 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols46.includes('filler_count'))      db.exec('ALTER TABLE page_stats ADD COLUMN filler_count INTEGER');
    if (!psCols46.includes('passive_count'))     db.exec('ALTER TABLE page_stats ADD COLUMN passive_count INTEGER');
    if (!psCols46.includes('adverb_count'))      db.exec('ALTER TABLE page_stats ADD COLUMN adverb_count INTEGER');
    if (!psCols46.includes('avg_sentence_len'))  db.exec('ALTER TABLE page_stats ADD COLUMN avg_sentence_len REAL');
    if (!psCols46.includes('sentence_len_p90'))  db.exec('ALTER TABLE page_stats ADD COLUMN sentence_len_p90 INTEGER');
    if (!psCols46.includes('repetition_data'))   db.exec('ALTER TABLE page_stats ADD COLUMN repetition_data TEXT');
    if (!psCols46.includes('lix'))               db.exec('ALTER TABLE page_stats ADD COLUMN lix REAL');
    if (!psCols46.includes('flesch_de'))         db.exec('ALTER TABLE page_stats ADD COLUMN flesch_de REAL');
    const bshCols46 = db.pragma('table_info(book_stats_history)').map(c => c.name);
    if (!bshCols46.includes('avg_lix'))          db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_lix REAL');
    if (!bshCols46.includes('avg_flesch_de'))    db.exec('ALTER TABLE book_stats_history ADD COLUMN avg_flesch_de REAL');
    db.prepare('UPDATE schema_version SET version = 46').run();
    logger.info('DB-Migration auf Version 46 abgeschlossen (Stil-Heatmap + Lesbarkeit: page_stats + book_stats_history).');
  }
  if (version < 47) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_reviews (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        book_name    TEXT,
        chapter_id   INTEGER NOT NULL,
        chapter_name TEXT,
        reviewed_at  TEXT NOT NULL,
        review_json  TEXT,
        model        TEXT,
        user_email   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cr_book_chapter_user_date
        ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC);
    `);
    db.prepare('UPDATE schema_version SET version = 47').run();
    logger.info('DB-Migration auf Version 47 abgeschlossen (chapter_reviews für Kapitel-Makroreviews).');
  }
  if (version < 48) {
    const psCols48 = db.pragma('table_info(page_stats)').map(c => c.name);
    if (!psCols48.includes('style_samples')) db.exec('ALTER TABLE page_stats ADD COLUMN style_samples TEXT');
    db.prepare('UPDATE schema_version SET version = 48').run();
    logger.info('DB-Migration auf Version 48 abgeschlossen (page_stats.style_samples für Stil-Heatmap-Drilldown).');
  }
  if (version < 49) {
    const bsCols49 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols49.includes('erzaehlperspektive')) db.exec('ALTER TABLE book_settings ADD COLUMN erzaehlperspektive TEXT');
    if (!bsCols49.includes('erzaehlzeit'))        db.exec('ALTER TABLE book_settings ADD COLUMN erzaehlzeit TEXT');
    db.prepare('UPDATE schema_version SET version = 49').run();
    logger.info('DB-Migration auf Version 49 abgeschlossen (book_settings.erzaehlperspektive + erzaehlzeit für Lektorat-Kontext).');
  }
  if (version < 50) {
    db.exec('CREATE TABLE IF NOT EXISTS writing_time (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, book_id INTEGER NOT NULL, date TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_user_book_date ON writing_time(user_email, book_id, date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wt_book ON writing_time(book_id)');
    db.prepare('UPDATE schema_version SET version = 50').run();
    logger.info('DB-Migration auf Version 50 abgeschlossen (writing_time für Edit-/Fokus-Zeit-Tracking).');
  }
  if (version < 51) {
    const zeCols51 = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols51.includes('page_ids')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN page_ids TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 51').run();
    logger.info('DB-Migration auf Version 51 abgeschlossen (page_ids in zeitstrahl_events für robusten Klick-Link auf Seiten).');
  }
  if (version < 52) {
    const userCols52 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols52.includes('last_seen_at')) {
      db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_email TEXT NOT NULL,
        date       TEXT NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0,
        first_at   TEXT,
        last_at    TEXT,
        PRIMARY KEY (user_email, date)
      );
      CREATE INDEX IF NOT EXISTS idx_ua_date ON user_activity(date);
    `);
    db.prepare('UPDATE schema_version SET version = 52').run();
    logger.info('DB-Migration auf Version 52 abgeschlossen (users.last_seen_at + user_activity für Session-Aktivitätszeit).');
  }
  if (version < 53) {
    // Szenen-Seite: historisch hat die KI die Markdown-Header wortwörtlich kopiert
    // («### Was macht Adrian?» statt nur «Was macht Adrian?»), sodass der
    // page_id-Lookup im Komplettanalyse-Save immer null ergeben hat. Jetzt
    // strippen wir den Präfix einmalig und holen fehlende page_ids aus
    // pages (unser lokaler BookStack-Cache), gescoped auf book_id + chapter_id.
    const stripped = db.prepare(`
      UPDATE figure_scenes
      SET seite = TRIM(SUBSTR(seite, 5))
      WHERE seite LIKE '### %'
    `).run().changes;
    const strippedH2 = db.prepare(`
      UPDATE figure_scenes
      SET seite = TRIM(SUBSTR(seite, 4))
      WHERE seite LIKE '## %'
    `).run().changes;
    const backfilled = db.prepare(`
      UPDATE figure_scenes
      SET page_id = (
        SELECT p.page_id FROM pages p
        WHERE p.book_id = figure_scenes.book_id
          AND ((p.chapter_id IS NULL AND figure_scenes.chapter_id IS NULL)
               OR p.chapter_id = figure_scenes.chapter_id)
          AND p.page_name = figure_scenes.seite
        LIMIT 1
      )
      WHERE page_id IS NULL AND seite IS NOT NULL AND seite != ''
    `).run().changes;
    db.prepare('UPDATE schema_version SET version = 53').run();
    logger.info(`DB-Migration auf Version 53 abgeschlossen (figure_scenes.seite: ${stripped + strippedH2} Präfix-Strips, ${backfilled} page_id-Backfills).`);
  }
  if (version < 54) {
    // job_runs.book_id enthielt für page-/session-scoped Jobs (check, chat,
    // book-chat, synonym) bisher die Dedup-Entity-ID (page_id / session_id /
    // entityKey) statt der echten book_id. Dadurch fehlten diese Jobs in der
    // per-Buch-Statistik. Ab jetzt speichert createJob die echte book_id und
    // trennt Dedup über dedupId; historische Zeilen werden hier gebackfillt.
    const checkBack = db.prepare(`
      UPDATE job_runs
      SET book_id = (SELECT p.book_id FROM pages p WHERE p.page_id = job_runs.book_id LIMIT 1)
      WHERE type = 'check'
        AND EXISTS (SELECT 1 FROM pages p WHERE p.page_id = job_runs.book_id)
    `).run().changes;
    const chatBack = db.prepare(`
      UPDATE job_runs
      SET book_id = (SELECT cs.book_id FROM chat_sessions cs WHERE cs.id = job_runs.book_id LIMIT 1)
      WHERE type IN ('chat', 'book-chat')
        AND EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = job_runs.book_id)
    `).run().changes;
    // Synonym-entityKey hatte Format "<bookId>|wort|satz"; erstes Segment extrahieren.
    const synBack = db.prepare(`
      UPDATE job_runs
      SET book_id = CAST(SUBSTR(book_id, 1, INSTR(book_id, '|') - 1) AS INTEGER)
      WHERE type = 'synonym' AND INSTR(CAST(book_id AS TEXT), '|') > 0
    `).run().changes;
    db.prepare('UPDATE schema_version SET version = 54').run();
    logger.info(`DB-Migration auf Version 54 abgeschlossen (job_runs.book_id Backfill: check=${checkBack}, chat/book-chat=${chatBack}, synonym=${synBack}).`);
  }

  if (version < 55) {
    // Hot-Path-Indexes für Lookups, die bisher Full-Scans waren.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lc_chapter_id  ON location_chapters(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fa_chapter_id  ON figure_appearances(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_fscene_page    ON figure_scenes(page_id);
      CREATE INDEX IF NOT EXISTS idx_jr_status      ON job_runs(status);
      CREATE INDEX IF NOT EXISTS idx_jr_queued_at   ON job_runs(queued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_frel_from      ON figure_relations(from_fig_id);
      CREATE INDEX IF NOT EXISTS idx_frel_to        ON figure_relations(to_fig_id);
    `);
    db.prepare('UPDATE schema_version SET version = 55').run();
    logger.info('DB-Migration auf Version 55 abgeschlossen (Hot-Path-Indexes für location_chapters, figure_appearances, figure_scenes, job_runs, figure_relations).');
  }

  if (version < 56) {
    // reconcilePageIds() filtert jetzt per book_id; ohne diesen Index landen die
    // Korrelations-Subqueries (chapter_name -> chapter_id) auf einem Full-Scan.
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_book_chapter_name ON pages(book_id, chapter_name)');
    db.prepare('UPDATE schema_version SET version = 56').run();
    logger.info('DB-Migration auf Version 56 abgeschlossen (Index pages(book_id, chapter_name) fuer reconcilePageIds).');
  }

  if (version < 57) {
    const figCols57 = db.pragma('table_info(figures)').map(c => c.name);
    if (!figCols57.includes('wohnadresse')) {
      db.exec('ALTER TABLE figures ADD COLUMN wohnadresse TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 57').run();
    logger.info('DB-Migration auf Version 57 abgeschlossen (figures.wohnadresse).');
  }

  if (version < 58) {
    const csCols58 = db.pragma('table_info(chat_sessions)').map(c => c.name);
    if (!csCols58.includes('opening_page_text')) {
      db.prepare('ALTER TABLE chat_sessions ADD COLUMN opening_page_text TEXT').run();
    }
    db.prepare('UPDATE schema_version SET version = 58').run();
    logger.info('DB-Migration auf Version 58 abgeschlossen (chat_sessions.opening_page_text).');
  }

  if (version < 59) {
    // continuity_checks.issues_json (JSON-Blob) → eigene Tabelle continuity_issues + Bridge-Tabellen.
    // Vorbild: figure_scenes mit scene_figures/scene_locations.
    db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_issues (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
        book_id      INTEGER NOT NULL,
        user_email   TEXT,
        schwere      TEXT,
        typ          TEXT,
        beschreibung TEXT,
        stelle_a     TEXT,
        stelle_b     TEXT,
        empfehlung   TEXT,
        sort_order   INTEGER DEFAULT 0,
        updated_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ci_check ON continuity_issues(check_id);
      CREATE INDEX IF NOT EXISTS idx_ci_book  ON continuity_issues(book_id, user_email);

      CREATE TABLE IF NOT EXISTS continuity_issue_figures (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        fig_id     TEXT,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cif_issue ON continuity_issue_figures(issue_id);

      CREATE TABLE IF NOT EXISTS continuity_issue_chapters (
        issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        chapter_name TEXT,
        sort_order   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cic_issue ON continuity_issue_chapters(issue_id);
    `);

    const ccCols59 = db.pragma('table_info(continuity_checks)').map(c => c.name);
    if (ccCols59.includes('issues_json')) {
      const insIssue = db.prepare(`INSERT INTO continuity_issues
        (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insIssueFig = db.prepare(`INSERT INTO continuity_issue_figures
        (issue_id, fig_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`);
      const insIssueCh = db.prepare(`INSERT INTO continuity_issue_chapters
        (issue_id, chapter_id, chapter_name, sort_order) VALUES (?, ?, ?, ?)`);
      const figByName = db.prepare('SELECT fig_id FROM figures WHERE book_id = ? AND name = ? LIMIT 1');
      const chByName  = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ? AND chapter_name = ? LIMIT 1');

      const rows = db.prepare('SELECT id, book_id, user_email, checked_at, issues_json FROM continuity_checks WHERE issues_json IS NOT NULL').all();
      let migrated = 0;
      db.transaction(() => {
        for (const r of rows) {
          let issues;
          try { issues = JSON.parse(r.issues_json); } catch { continue; }
          if (!Array.isArray(issues)) continue;
          for (let i = 0; i < issues.length; i++) {
            const it = issues[i] || {};
            const { lastInsertRowid: issueId } = insIssue.run(
              r.id, r.book_id, r.user_email,
              it.schwere || null, it.typ || null, it.beschreibung || null,
              it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
              i, r.checked_at,
            );
            // Namen sind authoritativ — das alte normalizedProbleme.fig_ids/chapter_ids
            // war .filter(Boolean) und damit positional NICHT mehr alignt. Daher per
            // chapter_name/figur_name in chapters/figures nachschlagen.
            const figNames = Array.isArray(it.figuren) ? it.figuren : [];
            const seenFig = new Set();
            for (let j = 0; j < figNames.length; j++) {
              const name = typeof figNames[j] === 'string' ? figNames[j].trim() : null;
              if (!name || seenFig.has(name)) continue;
              seenFig.add(name);
              const fid = figByName.get(r.book_id, name)?.fig_id || null;
              insIssueFig.run(issueId, fid, name, j);
            }
            const chNames = Array.isArray(it.kapitel) ? it.kapitel : [];
            const seenCh = new Set();
            for (let j = 0; j < chNames.length; j++) {
              const name = typeof chNames[j] === 'string' ? chNames[j].trim() : null;
              if (!name || seenCh.has(name)) continue;
              seenCh.add(name);
              const cid = chByName.get(r.book_id, name)?.chapter_id ?? null;
              insIssueCh.run(issueId, cid, name, j);
            }
            migrated++;
          }
        }
      })();
      db.exec('ALTER TABLE continuity_checks DROP COLUMN issues_json');
      logger.info(`DB-Migration auf Version 59: ${migrated} Kontinuitäts-Issues aus issues_json migriert; Spalte gedroppt.`);
    } else {
      logger.info('DB-Migration auf Version 59: continuity_checks.issues_json nicht vorhanden — Backfill übersprungen.');
    }
    db.prepare('UPDATE schema_version SET version = 59').run();
    logger.info('DB-Migration auf Version 59 abgeschlossen (continuity_issues + Bridge-Tabellen).');
  }

  if (version < 60) {
    // Korrektur: v59-Backfill alignte chapter_ids/fig_ids positional zu kapitel/figuren,
    // aber das alte normalizedProbleme-Format filterte unaufgelöste IDs raus
    // (positional alignment falsch). Hier neu auflösen anhand chapter_name/figur_name.
    const fixCh = db.prepare(`
      UPDATE continuity_issue_chapters
      SET chapter_id = (
        SELECT c.chapter_id FROM chapters c
        JOIN continuity_issues i ON i.id = continuity_issue_chapters.issue_id
        WHERE c.book_id = i.book_id AND c.chapter_name = continuity_issue_chapters.chapter_name
        LIMIT 1
      )
      WHERE chapter_name IS NOT NULL
    `);
    const fixFig = db.prepare(`
      UPDATE continuity_issue_figures
      SET fig_id = (
        SELECT f.fig_id FROM figures f
        JOIN continuity_issues i ON i.id = continuity_issue_figures.issue_id
        WHERE f.book_id = i.book_id AND f.name = continuity_issue_figures.figur_name
        LIMIT 1
      )
      WHERE figur_name IS NOT NULL
    `);
    const chFixed = fixCh.run().changes;
    const figFixed = fixFig.run().changes;
    db.prepare('UPDATE schema_version SET version = 60').run();
    logger.info(`DB-Migration auf Version 60: ${chFixed} chapter_id- / ${figFixed} fig_id-Verknüpfungen neu aufgelöst.`);
  }

  if (version < 61) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ideen (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        page_id     INTEGER NOT NULL,
        page_name   TEXT,
        user_email  TEXT NOT NULL,
        content     TEXT NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ideen_page_user ON ideen(page_id, user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ideen_book_user ON ideen(book_id, user_email)').run();
    db.prepare('UPDATE schema_version SET version = 61').run();
    logger.info('DB-Migration auf Version 61 abgeschlossen (ideen-Tabelle).');
  }

  if (version < 62) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS finetune_ai_cache (
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        scope      TEXT NOT NULL,
        scope_key  TEXT NOT NULL,
        sig        TEXT NOT NULL,
        version    TEXT NOT NULL,
        result_json TEXT NOT NULL,
        cached_at  TEXT NOT NULL,
        PRIMARY KEY (book_id, user_email, scope, scope_key, version)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ftai_book_user ON finetune_ai_cache(book_id, user_email)').run();
    db.prepare('UPDATE schema_version SET version = 62').run();
    logger.info('DB-Migration auf Version 62 abgeschlossen (finetune_ai_cache).');
  }
  if (version < 63) {
    const userCols63 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols63.includes('focus_granularity')) {
      db.exec("ALTER TABLE users ADD COLUMN focus_granularity TEXT");
    }
    db.prepare('UPDATE schema_version SET version = 63').run();
    logger.info('DB-Migration auf Version 63 abgeschlossen (users.focus_granularity).');
  }
  if (version < 64) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_feature_usage (
        user_email   TEXT NOT NULL,
        feature_key  TEXT NOT NULL,
        last_used    INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, feature_key)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ufu_user_lastused ON user_feature_usage(user_email, last_used DESC)').run();
    db.prepare('UPDATE schema_version SET version = 64').run();
    logger.info('DB-Migration auf Version 64 abgeschlossen (user_feature_usage).');
  }
  if (version < 65) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_page_usage (
        user_email   TEXT NOT NULL,
        page_id      INTEGER NOT NULL,
        book_id      INTEGER NOT NULL,
        last_used    INTEGER NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, page_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_upu_user_book_lastused ON user_page_usage(user_email, book_id, last_used DESC)').run();
    db.prepare('UPDATE schema_version SET version = 65').run();
    logger.info('DB-Migration auf Version 65 abgeschlossen (user_page_usage).');
  }

  if (version < 66) {
    const cols = db.pragma('table_info(page_checks)').map(c => c.name);
    if (!cols.includes('stilkorrektur_log')) {
      db.exec('ALTER TABLE page_checks ADD COLUMN stilkorrektur_log TEXT');
    }
    db.prepare('UPDATE schema_version SET version = 66').run();
    logger.info('DB-Migration auf Version 66 abgeschlossen (stilkorrektur_log zu page_checks).');
  }

  if (version < 67) {
    db.exec('CREATE TABLE IF NOT EXISTS lektorat_time (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT NOT NULL, book_id INTEGER NOT NULL, page_id INTEGER NOT NULL, date TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lt_book ON lektorat_time(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lt_page ON lektorat_time(page_id)');
    db.prepare('UPDATE schema_version SET version = 67').run();
    logger.info('DB-Migration auf Version 67 abgeschlossen (lektorat_time für Prüfmodus-Zeit-Tracking).');
  }

  if (version < 68) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pdf_export_profile (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        config_json  TEXT    NOT NULL,
        cover_image  BLOB,
        cover_mime   TEXT,
        is_default   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        UNIQUE (book_id, user_email, name)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pdf_profile_book_user ON pdf_export_profile (book_id, user_email)').run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS font_cache (
        family       TEXT NOT NULL,
        weight       INTEGER NOT NULL,
        style        TEXT NOT NULL,
        ttf          BLOB NOT NULL,
        fetched_at   INTEGER NOT NULL,
        PRIMARY KEY (family, weight, style)
      )
    `).run();
    db.prepare('UPDATE schema_version SET version = 68').run();
    logger.info('DB-Migration auf Version 68 abgeschlossen (pdf_export_profile + font_cache).');
  }

  if (version < 69) {
    // chat_sessions: Sentinel page_name='__book__' + page_id=0 durch
    // explizite kind-Spalte ersetzen. Voraussetzung fuer FK auf pages(page_id):
    // page_id darf bei Buch-Chat NULL sein, statt einen FK-blockierenden Sentinel
    // zu tragen. Recreate-Pattern, weil page_id von NOT NULL auf NULLABLE wechselt.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS chat_sessions_new;
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        book_name         TEXT,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER,
        page_name         TEXT,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new
        (id, book_id, book_name, kind, page_id, page_name,
         user_email, created_at, last_message_at, opening_page_text)
      SELECT id, book_id, book_name,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN 'book' ELSE 'page' END,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN NULL ELSE page_id END,
             CASE WHEN page_name = '__book__' OR page_id IS NULL OR page_id = 0
                  THEN NULL ELSE page_name END,
             user_email, created_at, last_message_at, opening_page_text
      FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);
    `);
    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 69: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 69').run();
    logger.info('DB-Migration auf Version 69 abgeschlossen (chat_sessions kind-Spalte, Sentinel __book__ aufgeloest).');
  }

  if (version < 70) {
    // Snapshot-Spalten in user-kuratierten Tabellen droppen. Display-Werte
    // (chapter_name, kapitel, seite, page_name) werden zur Lese-Zeit per JOIN
    // auf chapters/pages gewonnen. Vorteile:
    //   - keine Stale-Snapshots bei Kapitel-/Seiten-Rename in BookStack
    //   - reconcilePageIds()-Heilung (~180 SQL-Zeilen) entfaellt
    //   - Voraussetzung fuer FK auf chapters(chapter_id) und pages(page_id)
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS figure_appearances_new;
      DROP TABLE IF EXISTS figure_events_new;
      DROP TABLE IF EXISTS figure_scenes_new;
      DROP TABLE IF EXISTS location_chapters_new;
      DROP TABLE IF EXISTS continuity_issue_chapters_new;

      CREATE TABLE figure_appearances_new (
        figure_id   INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL,
        haeufigkeit INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT INTO figure_appearances_new (figure_id, chapter_id, haeufigkeit)
        SELECT figure_id, chapter_id, haeufigkeit FROM figure_appearances;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
      CREATE INDEX idx_fa_chapter_id ON figure_appearances(chapter_id);

      CREATE TABLE figure_events_new (
        figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER,
        page_id    INTEGER
      );
      INSERT INTO figure_events_new
        (figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id)
        SELECT figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id
        FROM figure_events;
      DROP TABLE figure_events;
      ALTER TABLE figure_events_new RENAME TO figure_events;
      CREATE INDEX idx_fe_chapter ON figure_events(chapter_id);
      CREATE INDEX idx_fe_page    ON figure_events(page_id);

      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT,
        titel      TEXT NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER,
        page_id    INTEGER,
        updated_at TEXT
      );
      INSERT INTO figure_scenes_new
        (id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at)
        SELECT id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at
        FROM figure_scenes;
      DROP TABLE figure_scenes;
      ALTER TABLE figure_scenes_new RENAME TO figure_scenes;
      CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email);
      CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX idx_fscene_page    ON figure_scenes(page_id);

      CREATE TABLE location_chapters_new (
        location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        chapter_id   INTEGER NOT NULL,
        haeufigkeit  INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT INTO location_chapters_new (location_id, chapter_id, haeufigkeit)
        SELECT location_id, chapter_id, haeufigkeit FROM location_chapters;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_new RENAME TO location_chapters;
      CREATE INDEX idx_lc_chapter_id ON location_chapters(chapter_id);

      CREATE TABLE continuity_issue_chapters_new (
        issue_id     INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id   INTEGER,
        sort_order   INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_chapters_new (issue_id, chapter_id, sort_order)
        SELECT issue_id, chapter_id, sort_order FROM continuity_issue_chapters
        WHERE chapter_id IS NOT NULL;
      DROP TABLE continuity_issue_chapters;
      ALTER TABLE continuity_issue_chapters_new RENAME TO continuity_issue_chapters;
      CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id);
      CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id);
    `);
    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 70: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 70').run();
    logger.info('DB-Migration auf Version 70 abgeschlossen (Snapshot-Spalten chapter_name/kapitel/seite entfernt).');
  }

  if (version < 71) {
    // FK-Anreicherung: harte Refs auf chapters(chapter_id) und pages(page_id).
    //   - CASCADE fuer reine Caches/Aggregationen (page_stats, page_checks,
    //     page_figure_mentions, lektorat_time, chat_sessions[kind=page],
    //     chapter_reviews, chapter_extract_cache, figure_appearances,
    //     location_chapters).
    //   - SET NULL fuer user-kuratierte Refs (figure_events, figure_scenes,
    //     locations.erste_erwaehnung_page_id, continuity_issue_chapters,
    //     page_checks.chapter_id, ideen.page_id, pages.chapter_id).
    // Vorbedingung: UNIQUE INDEX auf chapters(chapter_id) (composite PK reicht
    // nicht als FK-Target). chapter_extract_cache.chapter_key TEXT wird zu
    // chapter_id INTEGER konvertiert.

    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: Orphans (chapter_id/page_id auf nicht-existente Eltern) nullen,
    // damit FK-Migration nicht crasht. SET NULL passt fuer alle SET-NULL-Targets;
    // CASCADE-Targets bekommen die orphans direkt geloescht.
    db.exec(`
      DELETE FROM page_stats           WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM page_checks          WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM page_figure_mentions WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM lektorat_time        WHERE page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM chat_sessions        WHERE kind = 'page' AND page_id NOT IN (SELECT page_id FROM pages);
      DELETE FROM chapter_reviews      WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      DELETE FROM figure_appearances   WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      DELETE FROM location_chapters    WHERE chapter_id NOT IN (SELECT chapter_id FROM chapters);
      -- chapter_extract_cache bleibt String-keyed (kein FK), weil Sub-Phase-Keys
      -- ('13:figuren', '13:orte', '__singlepass__') noch existieren. Cache wird
      -- weiterhin manuell beim Kapitel-Drop in pruneStaleBookData invalidiert.

      UPDATE pages                     SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_events             SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_events             SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
      UPDATE figure_scenes             SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE figure_scenes             SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
      UPDATE locations                 SET erste_erwaehnung_page_id = NULL
        WHERE erste_erwaehnung_page_id IS NOT NULL
          AND erste_erwaehnung_page_id NOT IN (SELECT page_id FROM pages);
      UPDATE continuity_issue_chapters SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE page_checks               SET chapter_id = NULL WHERE chapter_id IS NOT NULL AND chapter_id NOT IN (SELECT chapter_id FROM chapters);
      UPDATE ideen                     SET page_id    = NULL WHERE page_id    IS NOT NULL AND page_id    NOT IN (SELECT page_id    FROM pages);
    `);

    db.exec(`
      DROP TABLE IF EXISTS chapters_new;
      DROP TABLE IF EXISTS pages_new;
      DROP TABLE IF EXISTS page_stats_new;
      DROP TABLE IF EXISTS page_checks_new;
      DROP TABLE IF EXISTS page_figure_mentions_new;
      DROP TABLE IF EXISTS lektorat_time_new;
      DROP TABLE IF EXISTS chat_sessions_new;
      DROP TABLE IF EXISTS ideen_new;
      DROP TABLE IF EXISTS chapter_reviews_new;
      DROP TABLE IF EXISTS chapter_extract_cache_new;
      DROP TABLE IF EXISTS figure_appearances_new;
      DROP TABLE IF EXISTS figure_events_new;
      DROP TABLE IF EXISTS figure_scenes_new;
      DROP TABLE IF EXISTS location_chapters_new;
      DROP TABLE IF EXISTS continuity_issue_chapters_new;
      DROP TABLE IF EXISTS locations_new;

      -- 1) chapters: composite PK + UNIQUE auf chapter_id alleine
      CREATE TABLE chapters_new (
        chapter_id   INTEGER NOT NULL,
        book_id      INTEGER NOT NULL,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        PRIMARY KEY (chapter_id, book_id),
        UNIQUE (chapter_id)
      );
      INSERT INTO chapters_new SELECT chapter_id, book_id, chapter_name, updated_at FROM chapters;
      DROP TABLE chapters;
      ALTER TABLE chapters_new RENAME TO chapters;

      -- 2) pages.chapter_id → FK SET NULL
      CREATE TABLE pages_new (
        page_id      INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL,
        page_name    TEXT,
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        chapter_name TEXT,
        updated_at   TEXT,
        preview_text TEXT
      );
      INSERT INTO pages_new SELECT page_id, book_id, page_name, chapter_id, chapter_name, updated_at, preview_text FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;
      CREATE INDEX idx_pages_book_id    ON pages(book_id);
      CREATE INDEX idx_pages_chapter_id ON pages(chapter_id);

      -- 3) page_stats → CASCADE
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL,
        tok              INTEGER,
        words            INTEGER,
        chars            INTEGER,
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER,
        dialog_chars     INTEGER,
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER,
        passive_count    INTEGER,
        adverb_count     INTEGER,
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER,
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      );
      INSERT INTO page_stats_new SELECT
        page_id, book_id, tok, words, chars, updated_at, cached_at,
        sentences, dialog_chars, pronoun_counts, metrics_version, content_sig,
        filler_count, passive_count, adverb_count, avg_sentence_len, sentence_len_p90,
        repetition_data, lix, flesch_de, style_samples FROM page_stats;
      DROP TABLE page_stats;
      ALTER TABLE page_stats_new RENAME TO page_stats;
      CREATE INDEX idx_ps_book_id ON page_stats(book_id);

      -- 4) page_checks → page_id CASCADE, chapter_id SET NULL
      CREATE TABLE page_checks_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        page_name            TEXT,
        book_id              INTEGER,
        checked_at           TEXT NOT NULL,
        error_count          INTEGER DEFAULT 0,
        errors_json          TEXT,
        stilanalyse          TEXT,
        fazit                TEXT,
        model                TEXT,
        saved                INTEGER DEFAULT 0,
        saved_at             TEXT,
        applied_errors_json  TEXT,
        user_email           TEXT,
        selected_errors_json TEXT,
        szenen_json          TEXT,
        chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        stilkorrektur_log    TEXT
      );
      INSERT INTO page_checks_new SELECT
        id, page_id, page_name, book_id, checked_at, error_count, errors_json,
        stilanalyse, fazit, model, saved, saved_at, applied_errors_json,
        user_email, selected_errors_json, szenen_json, chapter_id, stilkorrektur_log
        FROM page_checks;
      DROP TABLE page_checks;
      ALTER TABLE page_checks_new RENAME TO page_checks;
      CREATE INDEX idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC);
      CREATE INDEX idx_pc_book_user      ON page_checks(book_id, user_email);

      -- 5) page_figure_mentions → page_id CASCADE (figure_id hatte schon FK)
      CREATE TABLE page_figure_mentions_new (
        page_id      INTEGER NOT NULL REFERENCES pages(page_id)  ON DELETE CASCADE,
        figure_id    INTEGER NOT NULL REFERENCES figures(id)     ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (page_id, figure_id)
      );
      INSERT INTO page_figure_mentions_new SELECT page_id, figure_id, count, first_offset FROM page_figure_mentions;
      DROP TABLE page_figure_mentions;
      ALTER TABLE page_figure_mentions_new RENAME TO page_figure_mentions;
      CREATE INDEX idx_pfm_figure ON page_figure_mentions(figure_id);
      CREATE INDEX idx_pfm_page   ON page_figure_mentions(page_id);

      -- 6) lektorat_time → CASCADE
      CREATE TABLE lektorat_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        book_id    INTEGER NOT NULL,
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO lektorat_time_new SELECT id, user_email, book_id, page_id, date, seconds FROM lektorat_time;
      DROP TABLE lektorat_time;
      ALTER TABLE lektorat_time_new RENAME TO lektorat_time;
      CREATE UNIQUE INDEX idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date);
      CREATE INDEX idx_lt_book ON lektorat_time(book_id);
      CREATE INDEX idx_lt_page ON lektorat_time(page_id);

      -- 7) chat_sessions.page_id → CASCADE (kind='page'). kind='book' hat page_id NULL.
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        book_name         TEXT,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        page_name         TEXT,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new SELECT
        id, book_id, book_name, kind, page_id, page_name,
        user_email, created_at, last_message_at, opening_page_text FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);

      -- 8) ideen.page_id → SET NULL (war NOT NULL, jetzt nullable)
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        page_name   TEXT,
        user_email  TEXT NOT NULL,
        content     TEXT NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      INSERT INTO ideen_new SELECT id, book_id, page_id, page_name, user_email, content,
        erledigt, erledigt_at, created_at, updated_at FROM ideen;
      DROP TABLE ideen;
      ALTER TABLE ideen_new RENAME TO ideen;
      CREATE INDEX idx_ideen_page_user ON ideen(page_id, user_email);
      CREATE INDEX idx_ideen_book_user ON ideen(book_id, user_email);

      -- 9) chapter_reviews → CASCADE
      CREATE TABLE chapter_reviews_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL,
        book_name    TEXT,
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        chapter_name TEXT,
        reviewed_at  TEXT NOT NULL,
        review_json  TEXT,
        model        TEXT,
        user_email   TEXT
      );
      INSERT INTO chapter_reviews_new SELECT
        id, book_id, book_name, chapter_id, chapter_name, reviewed_at, review_json, model, user_email
        FROM chapter_reviews;
      DROP TABLE chapter_reviews;
      ALTER TABLE chapter_reviews_new RENAME TO chapter_reviews;
      CREATE INDEX idx_cr_book_chapter_user_date
        ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC);

      -- 10) figure_appearances → CASCADE auf chapters
      CREATE TABLE figure_appearances_new (
        figure_id   INTEGER NOT NULL REFERENCES figures(id)            ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)   ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        UNIQUE(figure_id, chapter_id)
      );
      INSERT INTO figure_appearances_new SELECT figure_id, chapter_id, haeufigkeit FROM figure_appearances;
      DROP TABLE figure_appearances;
      ALTER TABLE figure_appearances_new RENAME TO figure_appearances;
      CREATE INDEX idx_fa_chapter_id ON figure_appearances(chapter_id);

      -- 12) figure_events → SET NULL chapter_id + page_id (User-kuratiert)
      CREATE TABLE figure_events_new (
        figure_id  INTEGER NOT NULL REFERENCES figures(id)         ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id)         ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)               ON DELETE SET NULL
      );
      INSERT INTO figure_events_new SELECT
        figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id FROM figure_events;
      DROP TABLE figure_events;
      ALTER TABLE figure_events_new RENAME TO figure_events;
      CREATE INDEX idx_fe_chapter ON figure_events(chapter_id);
      CREATE INDEX idx_fe_page    ON figure_events(page_id);

      -- 13) figure_scenes → SET NULL chapter_id + page_id
      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT,
        titel      TEXT NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)       ON DELETE SET NULL,
        updated_at TEXT
      );
      INSERT INTO figure_scenes_new SELECT
        id, book_id, user_email, titel, wertung, kommentar, sort_order, chapter_id, page_id, updated_at
        FROM figure_scenes;
      DROP TABLE figure_scenes;
      ALTER TABLE figure_scenes_new RENAME TO figure_scenes;
      CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email);
      CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id);
      CREATE INDEX idx_fscene_page    ON figure_scenes(page_id);

      -- 14) location_chapters → CASCADE (PK enthaelt chapter_id, kein NULL moeglich)
      CREATE TABLE location_chapters_new (
        location_id INTEGER NOT NULL REFERENCES locations(id)         ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)  ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        PRIMARY KEY (location_id, chapter_id)
      );
      INSERT INTO location_chapters_new SELECT location_id, chapter_id, haeufigkeit FROM location_chapters;
      DROP TABLE location_chapters;
      ALTER TABLE location_chapters_new RENAME TO location_chapters;
      CREATE INDEX idx_lc_chapter_id ON location_chapters(chapter_id);

      -- 15) continuity_issue_chapters → SET NULL
      CREATE TABLE continuity_issue_chapters_new (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id)  ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)   ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_chapters_new SELECT issue_id, chapter_id, sort_order FROM continuity_issue_chapters;
      DROP TABLE continuity_issue_chapters;
      ALTER TABLE continuity_issue_chapters_new RENAME TO continuity_issue_chapters;
      CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id);
      CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id);

      -- 16) locations.erste_erwaehnung_page_id → SET NULL
      CREATE TABLE locations_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL,
        loc_id                   TEXT NOT NULL,
        name                     TEXT NOT NULL,
        typ                      TEXT,
        beschreibung             TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        stimmung                 TEXT,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      );
      INSERT INTO locations_new SELECT
        id, book_id, loc_id, name, typ, beschreibung, erste_erwaehnung, erste_erwaehnung_page_id,
        stimmung, sort_order, user_email, updated_at FROM locations;
      DROP TABLE locations;
      ALTER TABLE locations_new RENAME TO locations;
      CREATE INDEX idx_loc_book_id ON locations(book_id, user_email);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 71: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 71').run();
    logger.info('DB-Migration auf Version 71 abgeschlossen (FK CASCADE/SET NULL fuer pages/chapters-Refs).');
  }

  if (version < 72) {
    // figure_relations: TEXT-Refs (from_fig_id/to_fig_id auf figures.fig_id)
    // durch INTEGER-FK auf figures.id (PK) ersetzen. Spalten bleiben namens-
    // gleich (from_fig_id/to_fig_id), Typ ändert sich auf INTEGER + FK CASCADE.
    // Aufrufer (Reads/Writes) übersetzen TEXT-fig_id ↔ INTEGER-id über JOIN.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: orphans entfernen (rows ohne figures-Match)
    db.exec(`
      DELETE FROM figure_relations
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f
        WHERE f.book_id = figure_relations.book_id
          AND f.fig_id  = figure_relations.from_fig_id
          AND (f.user_email IS figure_relations.user_email
               OR (f.user_email IS NULL AND figure_relations.user_email IS NULL))
      )
      OR NOT EXISTS (
        SELECT 1 FROM figures f
        WHERE f.book_id = figure_relations.book_id
          AND f.fig_id  = figure_relations.to_fig_id
          AND (f.user_email IS figure_relations.user_email
               OR (f.user_email IS NULL AND figure_relations.user_email IS NULL))
      );
    `);

    db.exec(`
      DROP TABLE IF EXISTS figure_relations_new;
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        typ             TEXT NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT
      );
      INSERT INTO figure_relations_new
        (id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege)
      SELECT
        fr.id, fr.book_id,
        (SELECT f.id FROM figures f WHERE f.book_id = fr.book_id AND f.fig_id = fr.from_fig_id
           AND (f.user_email IS fr.user_email OR (f.user_email IS NULL AND fr.user_email IS NULL))),
        (SELECT f.id FROM figures f WHERE f.book_id = fr.book_id AND f.fig_id = fr.to_fig_id
           AND (f.user_email IS fr.user_email OR (f.user_email IS NULL AND fr.user_email IS NULL))),
        fr.typ, fr.beschreibung, fr.user_email, fr.machtverhaltnis, fr.belege
      FROM figure_relations fr;
      DROP TABLE figure_relations;
      ALTER TABLE figure_relations_new RENAME TO figure_relations;
      CREATE INDEX idx_frel_book_id ON figure_relations(book_id);
      CREATE INDEX idx_frel_from    ON figure_relations(from_fig_id);
      CREATE INDEX idx_frel_to      ON figure_relations(to_fig_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 72: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 72').run();
    logger.info('DB-Migration auf Version 72 abgeschlossen (figure_relations.from/to_fig_id INTEGER + FK CASCADE auf figures.id).');
  }

  if (version < 73) {
    // scene_figures, location_figures, continuity_issue_figures:
    // TEXT-fig_id (BookStack-fig_id-String) → INTEGER figure_id (figures.id PK)
    // mit FK. CASCADE für scene_figures/location_figures (Junction-Tabellen ohne
    // eigenen Display-State). SET NULL für continuity_issue_figures
    // (figur_name bleibt als Snapshot, falls KI fig_id=null hatte).
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: orphans entfernen (rows ohne figures-Match via book_id+fig_id+user_email)
    db.exec(`
      DELETE FROM scene_figures
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f JOIN figure_scenes fs ON fs.id = scene_figures.scene_id
        WHERE f.book_id = fs.book_id AND f.fig_id = scene_figures.fig_id
          AND (f.user_email IS fs.user_email OR (f.user_email IS NULL AND fs.user_email IS NULL))
      );
      DELETE FROM location_figures
      WHERE NOT EXISTS (
        SELECT 1 FROM figures f JOIN locations l ON l.id = location_figures.location_id
        WHERE f.book_id = l.book_id AND f.fig_id = location_figures.fig_id
          AND (f.user_email IS l.user_email OR (f.user_email IS NULL AND l.user_email IS NULL))
      );
      -- continuity_issue_figures.fig_id NULLABLE: NULL erlaubt (KI lieferte keinen ID-Match);
      -- nicht-NULL ohne figures-Match -> auf NULL setzen (figur_name bleibt als Snapshot).
      UPDATE continuity_issue_figures
      SET fig_id = NULL
      WHERE fig_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM figures f JOIN continuity_issues ci ON ci.id = continuity_issue_figures.issue_id
          WHERE f.book_id = ci.book_id AND f.fig_id = continuity_issue_figures.fig_id
            AND (f.user_email IS ci.user_email OR (f.user_email IS NULL AND ci.user_email IS NULL))
        );
    `);

    db.exec(`
      DROP TABLE IF EXISTS scene_figures_new;
      DROP TABLE IF EXISTS location_figures_new;
      DROP TABLE IF EXISTS continuity_issue_figures_new;

      -- scene_figures
      CREATE TABLE scene_figures_new (
        scene_id  INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        figure_id INTEGER NOT NULL REFERENCES figures(id)       ON DELETE CASCADE,
        PRIMARY KEY (scene_id, figure_id)
      );
      INSERT OR IGNORE INTO scene_figures_new (scene_id, figure_id)
      SELECT sf.scene_id,
             (SELECT f.id FROM figures f JOIN figure_scenes fs ON fs.id = sf.scene_id
              WHERE f.book_id = fs.book_id AND f.fig_id = sf.fig_id
                AND (f.user_email IS fs.user_email OR (f.user_email IS NULL AND fs.user_email IS NULL)))
      FROM scene_figures sf;
      DROP TABLE scene_figures;
      ALTER TABLE scene_figures_new RENAME TO scene_figures;
      CREATE INDEX idx_sf_figure ON scene_figures(figure_id);

      -- location_figures
      CREATE TABLE location_figures_new (
        location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        figure_id   INTEGER NOT NULL REFERENCES figures(id)   ON DELETE CASCADE,
        PRIMARY KEY (location_id, figure_id)
      );
      INSERT OR IGNORE INTO location_figures_new (location_id, figure_id)
      SELECT lf.location_id,
             (SELECT f.id FROM figures f JOIN locations l ON l.id = lf.location_id
              WHERE f.book_id = l.book_id AND f.fig_id = lf.fig_id
                AND (f.user_email IS l.user_email OR (f.user_email IS NULL AND l.user_email IS NULL)))
      FROM location_figures lf;
      DROP TABLE location_figures;
      ALTER TABLE location_figures_new RENAME TO location_figures;
      CREATE INDEX idx_lf_figure ON location_figures(figure_id);

      -- continuity_issue_figures: figure_id NULLABLE + SET NULL; figur_name bleibt
      CREATE TABLE continuity_issue_figures_new (
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      INSERT INTO continuity_issue_figures_new (issue_id, figure_id, figur_name, sort_order)
      SELECT cif.issue_id,
             CASE WHEN cif.fig_id IS NULL THEN NULL ELSE
               (SELECT f.id FROM figures f JOIN continuity_issues ci ON ci.id = cif.issue_id
                WHERE f.book_id = ci.book_id AND f.fig_id = cif.fig_id
                  AND (f.user_email IS ci.user_email OR (f.user_email IS NULL AND ci.user_email IS NULL)))
             END,
             cif.figur_name, cif.sort_order
      FROM continuity_issue_figures cif;
      DROP TABLE continuity_issue_figures;
      ALTER TABLE continuity_issue_figures_new RENAME TO continuity_issue_figures;
      CREATE INDEX idx_cif_issue  ON continuity_issue_figures(issue_id);
      CREATE INDEX idx_cif_figure ON continuity_issue_figures(figure_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 73: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 73').run();
    logger.info('DB-Migration auf Version 73 abgeschlossen (scene_figures/location_figures/continuity_issue_figures fig_id INTEGER + FK).');
  }

  if (version < 74) {
    // zeitstrahl_events: JSON-Spalten (kapitel, chapter_ids, seiten, page_ids,
    // figuren) durch Junction-Tabellen mit FK ersetzen. Display-Werte (Namen)
    // werden zur Lese-Zeit aus chapters/pages/figures gejoined.
    db.pragma('foreign_keys = OFF');

    db.exec(`
      DROP TABLE IF EXISTS zeitstrahl_event_chapters;
      DROP TABLE IF EXISTS zeitstrahl_event_pages;
      DROP TABLE IF EXISTS zeitstrahl_event_figures;

      CREATE TABLE zeitstrahl_event_chapters (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zec_event   ON zeitstrahl_event_chapters(event_id);
      CREATE INDEX idx_zec_chapter ON zeitstrahl_event_chapters(chapter_id);

      CREATE TABLE zeitstrahl_event_pages (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        page_id    INTEGER          REFERENCES pages(page_id)        ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zep_event ON zeitstrahl_event_pages(event_id);
      CREATE INDEX idx_zep_page  ON zeitstrahl_event_pages(page_id);

      CREATE TABLE zeitstrahl_event_figures (
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_zef_event  ON zeitstrahl_event_figures(event_id);
      CREATE INDEX idx_zef_figure ON zeitstrahl_event_figures(figure_id);
    `);

    // JSON in JS parsen und in Junction-Tabellen einfuegen.
    const events = db.prepare(
      'SELECT id, book_id, user_email, kapitel, chapter_ids, seiten, page_ids, figuren FROM zeitstrahl_events'
    ).all();
    const insZec = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, ?)');
    const insZep = db.prepare('INSERT INTO zeitstrahl_event_pages    (event_id, page_id, sort_order)    VALUES (?, ?, ?)');
    const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures  (event_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)');
    const validChapters = new Set(db.prepare('SELECT chapter_id FROM chapters').all().map(r => r.chapter_id));
    const validPages    = new Set(db.prepare('SELECT page_id FROM pages').all().map(r => r.page_id));
    const _safeJson = (s) => { if (!s) return []; try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
    for (const ev of events) {
      const chapIds = _safeJson(ev.chapter_ids).map(x => Number(x)).filter(Number.isInteger);
      let i = 0;
      for (const cid of chapIds) {
        insZec.run(ev.id, validChapters.has(cid) ? cid : null, i++);
      }
      const pageIds = _safeJson(ev.page_ids).map(x => Number(x)).filter(Number.isInteger);
      i = 0;
      for (const pid of pageIds) {
        insZep.run(ev.id, validPages.has(pid) ? pid : null, i++);
      }
      // figuren: [{id, name, typ}] oder ["Name"]. id ist TEXT-fig_id → INTEGER lookup
      // pro book/user_email Scope.
      const figs = _safeJson(ev.figuren);
      if (figs.length) {
        const figRows = db.prepare(
          'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
        ).all(ev.book_id, ev.user_email || null);
        const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
        i = 0;
        for (const f of figs) {
          if (!f) continue;
          if (typeof f === 'string') {
            const name = f.trim();
            if (name) insZef.run(ev.id, null, name, i++);
            continue;
          }
          if (typeof f === 'object') {
            const name = (f.name || f.kurzname || '').trim() || null;
            const figIdText = f.id ? String(f.id) : null;
            const rowId = figIdText ? (figIdToRowId[figIdText] ?? null) : null;
            insZef.run(ev.id, rowId, name, i++);
          }
        }
      }
    }

    // Recreate zeitstrahl_events ohne JSON-Spalten
    db.exec(`
      DROP TABLE IF EXISTS zeitstrahl_events_new;
      CREATE TABLE zeitstrahl_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL,
        user_email TEXT NOT NULL DEFAULT '',
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        typ        TEXT DEFAULT 'persoenlich',
        bedeutung  TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      );
      INSERT INTO zeitstrahl_events_new (id, book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at)
      SELECT id, book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at FROM zeitstrahl_events;
      DROP TABLE zeitstrahl_events;
      ALTER TABLE zeitstrahl_events_new RENAME TO zeitstrahl_events;
      CREATE INDEX idx_ze_book_id ON zeitstrahl_events(book_id, user_email);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 74: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 74').run();
    logger.info('DB-Migration auf Version 74 abgeschlossen (zeitstrahl_events JSON-Spalten -> Junction-Tabellen mit FK).');
  }

  if (version < 75) {
    // chapter_extract_cache: chapter_key TEXT (Mix aus chapter_id, sub-chunks und
    // sub-pass-suffixes) -> chapter_id INTEGER FK + phase TEXT. Buch-Level-Cache
    // (chapter_key='__singlepass__') wandert in eigene Tabelle book_extract_cache
    // (FK auf book_id nicht moeglich — keine lokale books-Tabelle).
    //
    // Format chapter_key: <chapter_id>(__sub<N>)?(:phase)?
    // Mapping: chapter_id := numerischer Praefix, phase := __sub<N>(:figuren|:orte)?
    db.pragma('foreign_keys = OFF');

    db.exec(`
      DROP TABLE IF EXISTS chapter_extract_cache_new;
      DROP TABLE IF EXISTS book_extract_cache;

      CREATE TABLE chapter_extract_cache_new (
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL DEFAULT '',
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      );

      CREATE TABLE book_extract_cache (
        book_id      INTEGER NOT NULL,
        user_email   TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      );
    `);

    const oldRows = db.prepare(
      'SELECT book_id, user_email, chapter_key, pages_sig, extract_json, cached_at FROM chapter_extract_cache'
    ).all();
    const validChapters = new Set(db.prepare('SELECT chapter_id FROM chapters').all().map(r => r.chapter_id));
    const insChapter = db.prepare(`
      INSERT OR REPLACE INTO chapter_extract_cache_new
        (book_id, user_email, chapter_id, phase, pages_sig, extract_json, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insBook = db.prepare(`
      INSERT OR REPLACE INTO book_extract_cache
        (book_id, user_email, pages_sig, extract_json, cached_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    let migratedChapter = 0, migratedBook = 0, dropped = 0;
    for (const r of oldRows) {
      const key = r.chapter_key;
      if (key === '__singlepass__') {
        insBook.run(r.book_id, r.user_email || '', r.pages_sig, r.extract_json, r.cached_at);
        migratedBook++;
        continue;
      }
      const m = String(key).match(/^(\d+)(__sub\d+)?(?::(.+))?$/);
      if (!m) { dropped++; continue; }
      const chapterId = parseInt(m[1]);
      if (!validChapters.has(chapterId)) { dropped++; continue; }
      const sub = m[2] ? m[2].slice(2) : '';
      const phaseSuffix = m[3] || '';
      const phase = sub ? (phaseSuffix ? `${sub}:${phaseSuffix}` : sub) : phaseSuffix;
      insChapter.run(r.book_id, r.user_email || '', chapterId, phase, r.pages_sig, r.extract_json, r.cached_at);
      migratedChapter++;
    }
    logger.info(`Migration 75: chapter_extract_cache migriert: ${migratedChapter} chapter, ${migratedBook} book, ${dropped} verworfen.`);

    db.exec(`
      DROP TABLE chapter_extract_cache;
      ALTER TABLE chapter_extract_cache_new RENAME TO chapter_extract_cache;
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 75: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 75').run();
    logger.info('DB-Migration auf Version 75 abgeschlossen (chapter_extract_cache split + FK CASCADE auf chapters).');
  }

  if (version < 76) {
    // CHECK-Constraints fuer server-kontrollierte Spalten:
    //   job_runs.status: festes Enum (5 Zustaende vom Job-Lifecycle).
    //   page_stats.{tok,words,chars,sentences,dialog_chars,filler_count,
    //                passive_count,adverb_count,sentence_len_p90}: NULL OK, sonst >= 0.
    // Spalten von KI-Output (figures.geschlecht, continuity_issues.schwere etc.)
    // bleiben constraint-frei — KI kann atypische Werte liefern.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: ungueltige status-Werte (defensive — sollte nicht vorkommen).
    db.exec(`
      UPDATE job_runs SET status = 'error'
      WHERE status NOT IN ('queued','running','done','error','cancelled');
      UPDATE page_stats SET tok = NULL WHERE tok < 0;
      UPDATE page_stats SET words = NULL WHERE words < 0;
      UPDATE page_stats SET chars = NULL WHERE chars < 0;
      UPDATE page_stats SET sentences = NULL WHERE sentences < 0;
      UPDATE page_stats SET dialog_chars = NULL WHERE dialog_chars < 0;
      UPDATE page_stats SET filler_count = NULL WHERE filler_count < 0;
      UPDATE page_stats SET passive_count = NULL WHERE passive_count < 0;
      UPDATE page_stats SET adverb_count = NULL WHERE adverb_count < 0;
      UPDATE page_stats SET sentence_len_p90 = NULL WHERE sentence_len_p90 < 0;
    `);

    db.exec(`
      DROP TABLE IF EXISTS job_runs_new;
      CREATE TABLE job_runs_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT NOT NULL UNIQUE,
        type           TEXT NOT NULL,
        book_id        INTEGER,
        user_email     TEXT,
        label          TEXT,
        status         TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','error','cancelled')),
        queued_at      TEXT NOT NULL,
        started_at     TEXT,
        ended_at       TEXT,
        tokens_in      INTEGER DEFAULT 0,
        tokens_out     INTEGER DEFAULT 0,
        error          TEXT,
        tokens_per_sec REAL
      );
      INSERT INTO job_runs_new
        (id, job_id, type, book_id, user_email, label, status, queued_at, started_at, ended_at, tokens_in, tokens_out, error, tokens_per_sec)
      SELECT
        id, job_id, type, book_id, user_email, label, status, queued_at, started_at, ended_at, tokens_in, tokens_out, error, tokens_per_sec
      FROM job_runs;
      DROP TABLE job_runs;
      ALTER TABLE job_runs_new RENAME TO job_runs;
      CREATE INDEX idx_jr_book      ON job_runs(book_id);
      CREATE INDEX idx_jr_user      ON job_runs(user_email);
      CREATE INDEX idx_jr_status    ON job_runs(status);
      CREATE INDEX idx_jr_queued_at ON job_runs(queued_at DESC);

      DROP TABLE IF EXISTS page_stats_new;
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL,
        tok              INTEGER CHECK (tok IS NULL OR tok >= 0),
        words            INTEGER CHECK (words IS NULL OR words >= 0),
        chars            INTEGER CHECK (chars IS NULL OR chars >= 0),
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER CHECK (sentences IS NULL OR sentences >= 0),
        dialog_chars     INTEGER CHECK (dialog_chars IS NULL OR dialog_chars >= 0),
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER CHECK (filler_count IS NULL OR filler_count >= 0),
        passive_count    INTEGER CHECK (passive_count IS NULL OR passive_count >= 0),
        adverb_count     INTEGER CHECK (adverb_count IS NULL OR adverb_count >= 0),
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER CHECK (sentence_len_p90 IS NULL OR sentence_len_p90 >= 0),
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      );
      INSERT INTO page_stats_new SELECT
        page_id, book_id, tok, words, chars, updated_at, cached_at,
        sentences, dialog_chars, pronoun_counts, metrics_version, content_sig,
        filler_count, passive_count, adverb_count, avg_sentence_len, sentence_len_p90,
        repetition_data, lix, flesch_de, style_samples FROM page_stats;
      DROP TABLE page_stats;
      ALTER TABLE page_stats_new RENAME TO page_stats;
      CREATE INDEX idx_ps_book_id ON page_stats(book_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors = db.pragma('foreign_key_check');
    if (fkErrors.length) {
      throw new Error(`Migration 76: foreign_key_check meldet ${fkErrors.length} Verstoesse: ${JSON.stringify(fkErrors.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 76').run();
    logger.info('DB-Migration auf Version 76 abgeschlossen (CHECK-Constraints: job_runs.status enum, page_stats numeric >= 0).');
  }

  if (version < 77) {
    // Lokale `books`-Tabelle als FK-Target. `bookstack_book_id` ist der
    // BookStack-externe Identifier (UNIQUE). Bestehende `book_id`-Spalten in
    // den 26+ Tabellen behalten ihren Wert; FK-Constraints auf
    // books(bookstack_book_id) folgen tabellenweise in spaeteren Migrationen.
    //
    // Backfill: DISTINCT book_ids aus allen bekannten Tabellen + juengste
    // bekannte Namen aus Snapshot-Spalten (book_stats_history,
    // chat_sessions, book_reviews, chapter_reviews). Sentinel-Zeile
    // (bookstack_book_id=0) fuer pdf_export_profile.book_id=0
    // (User-Default-Vorlagen).
    db.prepare(
      'CREATE TABLE IF NOT EXISTS books ('
      + ' id                INTEGER PRIMARY KEY AUTOINCREMENT,'
      + ' bookstack_book_id INTEGER NOT NULL UNIQUE,'
      + ' name              TEXT    NOT NULL,'
      + ' slug              TEXT,'
      + ' created_at        TEXT    NOT NULL,'
      + ' updated_at        TEXT    NOT NULL'
      + ')'
    ).run();

    const nowIso77 = new Date().toISOString();

    db.prepare(
      "INSERT OR IGNORE INTO books (bookstack_book_id, name, created_at, updated_at) VALUES (0, '__user_default__', ?, ?)"
    ).run(nowIso77, nowIso77);

    // Juengsten bekannten Namen pro book_id aus Snapshot-Spalten sammeln.
    // Reihenfolge nach Frische: book_stats_history (taeglicher Cron) >
    // chat_sessions (Session-Erstellung) > book_reviews / chapter_reviews
    // (Job-Ergebnisse). Erste Eintragung gewinnt — daher frischeste zuerst.
    const nameByBook77 = new Map();
    const collect77 = (sql) => {
      for (const r of db.prepare(sql).all()) {
        if (!r.book_id || r.book_id === 0) continue;
        if (!r.book_name) continue;
        if (!nameByBook77.has(r.book_id)) nameByBook77.set(r.book_id, r.book_name);
      }
    };
    const knownTables77 = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    );
    if (knownTables77.has('book_stats_history')) collect77("SELECT book_id, book_name FROM book_stats_history WHERE book_name IS NOT NULL ORDER BY recorded_at DESC");
    if (knownTables77.has('chat_sessions'))      collect77("SELECT book_id, book_name FROM chat_sessions       WHERE book_name IS NOT NULL ORDER BY created_at  DESC");
    if (knownTables77.has('book_reviews'))       collect77("SELECT book_id, book_name FROM book_reviews        WHERE book_name IS NOT NULL ORDER BY reviewed_at DESC");
    if (knownTables77.has('chapter_reviews'))    collect77("SELECT book_id, book_name FROM chapter_reviews     WHERE book_name IS NOT NULL ORDER BY reviewed_at DESC");

    // Alle DISTINCT book_ids aus allen book_id-tragenden Tabellen sammeln.
    // Tabellen, die auf einer alten DB evtl. fehlen, werden uebersprungen.
    const bookIdTables77 = [
      'figures', 'figure_relations', 'page_stats', 'book_stats_history',
      'chat_sessions', 'figure_scenes', 'locations', 'continuity_checks',
      'continuity_issues', 'pages', 'chapters', 'job_runs', 'job_checkpoints',
      'book_settings', 'page_checks', 'book_reviews', 'zeitstrahl_events',
      'character_arcs', 'chapter_extract_cache', 'book_extract_cache',
      'ideen', 'finetune_ai_cache', 'writing_time', 'lektorat_time',
      'user_page_usage', 'pdf_export_profile', 'chapter_reviews',
    ];
    const bookIds77 = new Set();
    for (const t of bookIdTables77) {
      if (!knownTables77.has(t)) continue;
      const rows = db.prepare(`SELECT DISTINCT book_id FROM ${t} WHERE book_id IS NOT NULL AND book_id > 0`).all();
      for (const r of rows) bookIds77.add(r.book_id);
    }

    const insBook77 = db.prepare(
      'INSERT OR IGNORE INTO books (bookstack_book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    let inserted77 = 0;
    db.transaction(() => {
      for (const bsId of bookIds77) {
        const name = nameByBook77.get(bsId) || `Buch ${bsId}`;
        const r = insBook77.run(bsId, name, nowIso77, nowIso77);
        if (r.changes) inserted77++;
      }
    })();

    const fkErrors77 = db.pragma('foreign_key_check');
    if (fkErrors77.length) {
      throw new Error(`Migration 77: foreign_key_check meldet ${fkErrors77.length} Verstoesse: ${JSON.stringify(fkErrors77.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 77').run();
    logger.info(`DB-Migration auf Version 77 abgeschlossen (books-Tabelle + Backfill: ${inserted77} Buecher aus ${bookIds77.size} bekannten BookStack-IDs).`);
  }

  if (version < 78) {
    // Snapshot-Spalten in user-kuratierten und Cache-Tabellen entfernen.
    // Wahrheit lebt nur in pages.page_name (BookStack-Tree-Cache) und
    // chapters.chapter_name (BookStack-Cache). Display-Werte zur Lese-Zeit
    // per JOIN.
    //
    // Index pages(book_id, chapter_name) ist seit Mig 70 tot (reconcilePageIds
    // braucht ihn nicht mehr) und blockiert DROP COLUMN — daher zuerst weg.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP INDEX IF EXISTS idx_pages_book_chapter_name').run();
    db.prepare('ALTER TABLE pages           DROP COLUMN chapter_name').run();
    db.prepare('ALTER TABLE page_checks     DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE chat_sessions   DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE ideen           DROP COLUMN page_name').run();
    db.prepare('ALTER TABLE chapter_reviews DROP COLUMN chapter_name').run();
    db.pragma('foreign_keys = ON');
    const fkErrors78 = db.pragma('foreign_key_check');
    if (fkErrors78.length) {
      throw new Error(`Migration 78: foreign_key_check meldet ${fkErrors78.length} Verstoesse: ${JSON.stringify(fkErrors78.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 78').run();
    logger.info('DB-Migration auf Version 78 abgeschlossen (Snapshot-Spalten page_name/chapter_name aus user-kuratierten Tabellen entfernt; Display per JOIN auf pages/chapters).');
  }

  if (version < 79) {
    // book_name-Snapshot-Spalten entfernen — Wahrheit lebt seit Mig 77 in
    // books(name). Display-Werte zur Lese-Zeit per JOIN auf
    // books.bookstack_book_id. Spalten haben keine Indexe oder Constraints,
    // ALTER TABLE DROP COLUMN reicht (kein Recreate-Pattern noetig).
    db.pragma('foreign_keys = OFF');
    db.prepare('ALTER TABLE chat_sessions      DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE book_stats_history DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE book_reviews       DROP COLUMN book_name').run();
    db.prepare('ALTER TABLE chapter_reviews    DROP COLUMN book_name').run();
    db.pragma('foreign_keys = ON');
    const fkErrors79 = db.pragma('foreign_key_check');
    if (fkErrors79.length) {
      throw new Error(`Migration 79: foreign_key_check meldet ${fkErrors79.length} Verstoesse: ${JSON.stringify(fkErrors79.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 79').run();
    logger.info('DB-Migration auf Version 79 abgeschlossen (Snapshot-Spalte book_name aus 4 Tabellen entfernt; Display per JOIN auf books(name)).');
  }

  if (version < 80) {
    // last_seen_at: Discovery-Marker, wird bei jedem Sync (BookStack-Discovery)
    // auf jetzt gesetzt. Cron prunt Eintraege deren last_seen_at aelter als
    // STALE_DAYS — zeitbasierte Bereinigung obendrein zur bestehenden
    // presence-basierten pruneStaleBookData.
    // Backfill auf jetzt: alle Bestandseintraege bekommen frische Schonfrist.
    const now80 = new Date().toISOString();
    db.prepare('ALTER TABLE books    ADD COLUMN last_seen_at TEXT').run();
    db.prepare('ALTER TABLE chapters ADD COLUMN last_seen_at TEXT').run();
    db.prepare('ALTER TABLE pages    ADD COLUMN last_seen_at TEXT').run();
    db.prepare('UPDATE books    SET last_seen_at = ?').run(now80);
    db.prepare('UPDATE chapters SET last_seen_at = ?').run(now80);
    db.prepare('UPDATE pages    SET last_seen_at = ?').run(now80);
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen    ON books(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_last_seen    ON pages(last_seen_at)').run();
    const fkErrors80 = db.pragma('foreign_key_check');
    if (fkErrors80.length) {
      throw new Error(`Migration 80: foreign_key_check meldet ${fkErrors80.length} Verstoesse: ${JSON.stringify(fkErrors80.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 80').run();
    logger.info('DB-Migration auf Version 80 abgeschlossen (last_seen_at + Indexe fuer books/chapters/pages; Backfill auf jetzt).');
  }

  if (version < 81) {
    // FK-Anreicherung: book_id -> books(bookstack_book_id) fuer 15
    // nicht-strukturelle Tabellen (Caches, Stats, Logs, Konfigurations-
    // Singletons, Job-Tracking). Strukturelle Tabellen (chat_sessions,
    // book_reviews, chapter_reviews, ideen, page_checks, locations,
    // figure_scenes, pages, chapters, figures, figure_relations) folgen.
    //
    // Default ON DELETE CASCADE — Inhalt ist an die BookStack-Buchexistenz
    // gebunden und ohne Buch sinnlos. Ausnahme: job_runs.book_id (nullable;
    // System-Jobs ohne Buchkontext erlaubt) -> SET NULL.
    //
    // Pre-Cleanup: book_ids ohne Eintrag in books loeschen (sollten dank
    // Mig 77-Backfill keine sein, Schutz gegen post-77-Inserts ohne
    // upsertBook-Hook).
    db.pragma('foreign_keys = OFF');

    const cleanupTables81 = [
      'chapter_extract_cache', 'book_extract_cache', 'finetune_ai_cache',
      'page_stats', 'book_stats_history', 'lektorat_time', 'writing_time',
      'user_page_usage', 'continuity_checks', 'continuity_issues',
      'zeitstrahl_events', 'pdf_export_profile', 'book_settings',
      'job_checkpoints',
    ];
    let orphans81 = 0;
    for (const t of cleanupTables81) {
      const r = db.prepare(`DELETE FROM ${t} WHERE book_id NOT IN (SELECT bookstack_book_id FROM books)`).run();
      orphans81 += r.changes;
    }
    // job_runs: book_id nullable, SET NULL fuer Orphans statt Loeschen.
    const jrSetNull = db.prepare(
      'UPDATE job_runs SET book_id = NULL WHERE book_id IS NOT NULL AND book_id NOT IN (SELECT bookstack_book_id FROM books)'
    ).run();
    if (orphans81 || jrSetNull.changes) {
      logger.info(`Mig 81 Pre-Cleanup: ${orphans81} Orphan-Rows geloescht, ${jrSetNull.changes} job_runs.book_id genullt.`);
    }

    // Helper: Recreate-Pattern in einer Funktion buendeln. createSql muss
    // Tabelle als `<table>_new` benennen.
    const _recreate81 = (table, createSql, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    // 1) chapter_extract_cache (FK chapter_id bleibt; book_id wird FK)
    _recreate81('chapter_extract_cache', `
      CREATE TABLE chapter_extract_cache_new (
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL DEFAULT '',
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      )
    `, []);

    // 2) book_extract_cache
    _recreate81('book_extract_cache', `
      CREATE TABLE book_extract_cache_new (
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      )
    `, []);

    // 3) finetune_ai_cache
    _recreate81('finetune_ai_cache', `
      CREATE TABLE finetune_ai_cache_new (
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        scope       TEXT    NOT NULL,
        scope_key   TEXT    NOT NULL,
        sig         TEXT    NOT NULL,
        version     TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, scope, scope_key, version)
      )
    `, [
      'CREATE INDEX idx_ftai_book_user ON finetune_ai_cache(book_id, user_email)',
    ]);

    // 4) page_stats (FK page_id bleibt; book_id wird FK; CHECK aus Mig 76 bleiben)
    _recreate81('page_stats', `
      CREATE TABLE page_stats_new (
        page_id          INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id          INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        tok              INTEGER CHECK (tok IS NULL OR tok >= 0),
        words            INTEGER CHECK (words IS NULL OR words >= 0),
        chars            INTEGER CHECK (chars IS NULL OR chars >= 0),
        updated_at       TEXT,
        cached_at        TEXT,
        sentences        INTEGER CHECK (sentences IS NULL OR sentences >= 0),
        dialog_chars     INTEGER CHECK (dialog_chars IS NULL OR dialog_chars >= 0),
        pronoun_counts   TEXT,
        metrics_version  INTEGER DEFAULT 0,
        content_sig      TEXT,
        filler_count     INTEGER CHECK (filler_count IS NULL OR filler_count >= 0),
        passive_count    INTEGER CHECK (passive_count IS NULL OR passive_count >= 0),
        adverb_count     INTEGER CHECK (adverb_count IS NULL OR adverb_count >= 0),
        avg_sentence_len REAL,
        sentence_len_p90 INTEGER CHECK (sentence_len_p90 IS NULL OR sentence_len_p90 >= 0),
        repetition_data  TEXT,
        lix              REAL,
        flesch_de        REAL,
        style_samples    TEXT
      )
    `, [
      'CREATE INDEX idx_ps_book_id ON page_stats(book_id)',
    ]);

    // 5) book_stats_history
    _recreate81('book_stats_history', `
      CREATE TABLE book_stats_history_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        recorded_at      TEXT    NOT NULL,
        page_count       INTEGER,
        words            INTEGER,
        chars            INTEGER,
        tok              INTEGER,
        unique_words     INTEGER,
        chapter_count    INTEGER,
        avg_sentence_len REAL,
        avg_lix          REAL,
        avg_flesch_de    REAL
      )
    `, [
      'CREATE UNIQUE INDEX idx_bsh_book_date ON book_stats_history(book_id, recorded_at)',
      'CREATE INDEX idx_bsh_book_id ON book_stats_history(book_id)',
    ]);

    // 6) lektorat_time
    _recreate81('lektorat_time', `
      CREATE TABLE lektorat_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      )
    `, [
      'CREATE UNIQUE INDEX idx_lt_user_book_page_date ON lektorat_time(user_email, book_id, page_id, date)',
      'CREATE INDEX idx_lt_book ON lektorat_time(book_id)',
      'CREATE INDEX idx_lt_page ON lektorat_time(page_id)',
    ]);

    // 7) writing_time
    _recreate81('writing_time', `
      CREATE TABLE writing_time_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      )
    `, [
      'CREATE UNIQUE INDEX idx_wt_user_book_date ON writing_time(user_email, book_id, date)',
      'CREATE INDEX idx_wt_book ON writing_time(book_id)',
    ]);

    // 8) user_page_usage
    _recreate81('user_page_usage', `
      CREATE TABLE user_page_usage_new (
        user_email TEXT    NOT NULL,
        page_id    INTEGER NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        last_used  INTEGER NOT NULL,
        use_count  INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, page_id)
      )
    `, [
      'CREATE INDEX idx_upu_user_book_lastused ON user_page_usage(user_email, book_id, last_used DESC)',
    ]);

    // 9) continuity_checks (continuity_issues.check_id FK auf id bleibt valide nach RENAME)
    _recreate81('continuity_checks', `
      CREATE TABLE continuity_checks_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT,
        checked_at TEXT NOT NULL,
        summary    TEXT,
        model      TEXT
      )
    `, [
      'CREATE INDEX idx_cc_book_id ON continuity_checks(book_id, user_email)',
    ]);

    // 10) continuity_issues (FK check_id bleibt; book_id wird FK)
    _recreate81('continuity_issues', `
      CREATE TABLE continuity_issues_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id     INTEGER NOT NULL REFERENCES continuity_checks(id) ON DELETE CASCADE,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email   TEXT,
        schwere      TEXT,
        typ          TEXT,
        beschreibung TEXT,
        stelle_a     TEXT,
        stelle_b     TEXT,
        empfehlung   TEXT,
        sort_order   INTEGER DEFAULT 0,
        updated_at   TEXT
      )
    `, [
      'CREATE INDEX idx_ci_check ON continuity_issues(check_id)',
      'CREATE INDEX idx_ci_book  ON continuity_issues(book_id, user_email)',
    ]);

    // 11) zeitstrahl_events
    _recreate81('zeitstrahl_events', `
      CREATE TABLE zeitstrahl_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT    NOT NULL DEFAULT '',
        datum      TEXT    NOT NULL,
        ereignis   TEXT    NOT NULL,
        typ        TEXT    DEFAULT 'persoenlich',
        bedeutung  TEXT,
        sort_order INTEGER DEFAULT 0,
        updated_at TEXT
      )
    `, [
      'CREATE INDEX idx_ze_book_id ON zeitstrahl_events(book_id, user_email)',
    ]);

    // 12) pdf_export_profile (Sentinel book_id=0 hat books-Zeile aus Mig 77)
    _recreate81('pdf_export_profile', `
      CREATE TABLE pdf_export_profile_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        cover_image BLOB,
        cover_mime  TEXT,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (book_id, user_email, name)
      )
    `, [
      'CREATE INDEX idx_pdf_profile_book_user ON pdf_export_profile (book_id, user_email)',
    ]);

    // 13) book_settings (PK = FK auf books)
    _recreate81('book_settings', `
      CREATE TABLE book_settings_new (
        book_id            INTEGER PRIMARY KEY REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        language           TEXT    NOT NULL DEFAULT 'de',
        region             TEXT    NOT NULL DEFAULT 'CH',
        updated_at         TEXT    NOT NULL,
        buchtyp            TEXT,
        buch_kontext       TEXT,
        erzaehlperspektive TEXT,
        erzaehlzeit        TEXT
      )
    `, []);

    // 14) job_checkpoints
    _recreate81('job_checkpoints', `
      CREATE TABLE job_checkpoints_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type   TEXT    NOT NULL,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT    NOT NULL DEFAULT '',
        data       TEXT    NOT NULL,
        updated_at TEXT    NOT NULL,
        UNIQUE(job_type, book_id, user_email)
      )
    `, []);

    // 15) job_runs (book_id nullable -> SET NULL bei Buchloeschung;
    //     System-Jobs ohne Buchkontext bleiben erhalten)
    _recreate81('job_runs', `
      CREATE TABLE job_runs_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id         TEXT    NOT NULL UNIQUE,
        type           TEXT    NOT NULL,
        book_id        INTEGER REFERENCES books(bookstack_book_id) ON DELETE SET NULL,
        user_email     TEXT,
        label          TEXT,
        status         TEXT    NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','error','cancelled')),
        queued_at      TEXT    NOT NULL,
        started_at     TEXT,
        ended_at       TEXT,
        tokens_in      INTEGER DEFAULT 0,
        tokens_out     INTEGER DEFAULT 0,
        error          TEXT,
        tokens_per_sec REAL
      )
    `, [
      'CREATE INDEX idx_jr_book      ON job_runs(book_id)',
      'CREATE INDEX idx_jr_user      ON job_runs(user_email)',
      'CREATE INDEX idx_jr_status    ON job_runs(status)',
      'CREATE INDEX idx_jr_queued_at ON job_runs(queued_at DESC)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors81 = db.pragma('foreign_key_check');
    if (fkErrors81.length) {
      throw new Error(`Migration 81: foreign_key_check meldet ${fkErrors81.length} Verstoesse: ${JSON.stringify(fkErrors81.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 81').run();
    logger.info('DB-Migration auf Version 81 abgeschlossen (FK book_id -> books fuer 15 Tabellen: Caches, Stats, Logs, book_settings, job_runs, job_checkpoints, pdf_export_profile, continuity_*, zeitstrahl_events).');
  }

  if (version < 82) {
    // FK-Anreicherung: book_id -> books(bookstack_book_id) fuer
    // strukturelle Tabellen — chat_sessions, book_reviews, chapter_reviews,
    // ideen, page_checks, locations, figure_scenes, pages, chapters, figures,
    // figure_relations. Alle CASCADE — Inhalt ist an Buchexistenz gebunden.
    //
    // pages, chapters, figures sind FK-Targets fuer andere Tabellen
    // (page_stats, chapter_extract_cache, figure_relations etc). Mit
    // foreign_keys=OFF waehrend Recreate sind die Child-FKs unkritisch:
    // SQLite bindet FK-Refs an den Tabellennamen, der nach RENAME _new wieder
    // valid ist. fk_check am Ende verifiziert.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: Orphan-book_ids loeschen. Mit foreign_keys=OFF kein Cascade —
    // pro Tabelle manuell. Reihenfolge egal, kein Dependency-Cleanup noetig.
    const cleanupTables82 = [
      'chat_sessions', 'book_reviews', 'chapter_reviews', 'ideen',
      'page_checks', 'locations', 'figure_scenes', 'pages', 'chapters',
      'figures', 'figure_relations',
    ];
    let orphans82 = 0;
    for (const t of cleanupTables82) {
      const r = db.prepare(`DELETE FROM ${t} WHERE book_id NOT IN (SELECT bookstack_book_id FROM books)`).run();
      orphans82 += r.changes;
    }
    if (orphans82) logger.info(`Mig 82 Pre-Cleanup: ${orphans82} Orphan-Rows entfernt.`);

    const _recreate82 = (table, createSql, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    // 1) chat_sessions (page_id-FK + kind-CHECK + page-CHECK bleiben)
    _recreate82('chat_sessions', `
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      )
    `, [
      'CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email)',
      'CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email)',
      'CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind)',
    ]);

    // 2) book_reviews
    _recreate82('book_reviews', `
      CREATE TABLE book_reviews_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        reviewed_at TEXT    NOT NULL,
        review_json TEXT,
        model       TEXT,
        user_email  TEXT
      )
    `, [
      'CREATE INDEX idx_br_book_user_date ON book_reviews(book_id, user_email, reviewed_at DESC)',
    ]);

    // 3) chapter_reviews (chapter_id-FK CASCADE bleibt; book_id wird FK)
    _recreate82('chapter_reviews', `
      CREATE TABLE chapter_reviews_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        reviewed_at TEXT    NOT NULL,
        review_json TEXT,
        model       TEXT,
        user_email  TEXT
      )
    `, [
      'CREATE INDEX idx_cr_book_chapter_user_date ON chapter_reviews(book_id, chapter_id, user_email, reviewed_at DESC)',
    ]);

    // 4) ideen (page_id-FK SET NULL bleibt; book_id wird FK CASCADE)
    _recreate82('ideen', `
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        user_email  TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      )
    `, [
      'CREATE INDEX idx_ideen_page_user ON ideen(page_id, user_email)',
      'CREATE INDEX idx_ideen_book_user ON ideen(book_id, user_email)',
    ]);

    // 5) page_checks (page_id-FK CASCADE + chapter_id-FK SET NULL bleiben;
    //    book_id war NULLABLE — bleibt nullable mit FK SET NULL, sonst gehen
    //    historische Eintraege verloren, wenn book_id mal vergessen wurde.)
    _recreate82('page_checks', `
      CREATE TABLE page_checks_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id              INTEGER REFERENCES books(bookstack_book_id) ON DELETE SET NULL,
        checked_at           TEXT NOT NULL,
        error_count          INTEGER DEFAULT 0,
        errors_json          TEXT,
        stilanalyse          TEXT,
        fazit                TEXT,
        model                TEXT,
        saved                INTEGER DEFAULT 0,
        saved_at             TEXT,
        applied_errors_json  TEXT,
        user_email           TEXT,
        selected_errors_json TEXT,
        szenen_json          TEXT,
        chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        stilkorrektur_log    TEXT
      )
    `, [
      'CREATE INDEX idx_pc_page_user_date ON page_checks(page_id, user_email, checked_at DESC)',
      'CREATE INDEX idx_pc_book_user      ON page_checks(book_id, user_email)',
    ]);

    // 6) locations (FK erste_erwaehnung_page_id SET NULL bleibt; UNIQUE bleibt)
    _recreate82('locations', `
      CREATE TABLE locations_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        loc_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        typ                      TEXT,
        beschreibung             TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        stimmung                 TEXT,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, loc_id, user_email)
      )
    `, [
      'CREATE INDEX idx_loc_book_id ON locations(book_id, user_email)',
    ]);

    // 7) figure_scenes (FK chapter_id, page_id SET NULL bleiben)
    _recreate82('figure_scenes', `
      CREATE TABLE figure_scenes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        user_email TEXT,
        titel      TEXT    NOT NULL,
        wertung    TEXT,
        kommentar  TEXT,
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)       ON DELETE SET NULL,
        updated_at TEXT
      )
    `, [
      'CREATE INDEX idx_fscene_book    ON figure_scenes(book_id, user_email)',
      'CREATE INDEX idx_fscene_chapter ON figure_scenes(chapter_id)',
      'CREATE INDEX idx_fscene_page    ON figure_scenes(page_id)',
    ]);

    // 8) pages (FK chapter_id SET NULL bleibt; last_seen_at aus Mig 80 bleibt)
    _recreate82('pages', `
      CREATE TABLE pages_new (
        page_id      INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        page_name    TEXT,
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        updated_at   TEXT,
        preview_text TEXT,
        last_seen_at TEXT
      )
    `, [
      'CREATE INDEX idx_pages_book_id    ON pages(book_id)',
      'CREATE INDEX idx_pages_chapter_id ON pages(chapter_id)',
      'CREATE INDEX idx_pages_last_seen  ON pages(last_seen_at)',
    ]);

    // 9) chapters (composite PK + UNIQUE(chapter_id) bleiben — UNIQUE
    //    notwendig, weil pages.chapter_id, chapter_reviews.chapter_id,
    //    chapter_extract_cache.chapter_id u.a. auf chapters(chapter_id)
    //    referenzieren; FK-Target braucht entweder PK oder UNIQUE.)
    _recreate82('chapters', `
      CREATE TABLE chapters_new (
        chapter_id   INTEGER NOT NULL,
        book_id      INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT,
        PRIMARY KEY (chapter_id, book_id),
        UNIQUE (chapter_id)
      )
    `, [
      'CREATE INDEX idx_chapters_last_seen ON chapters(last_seen_at)',
    ]);

    // 10) figures (UNIQUE(book_id, fig_id, user_email) bleibt)
    _recreate82('figures', `
      CREATE TABLE figures_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        fig_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        kurzname                 TEXT,
        typ                      TEXT,
        geburtstag               TEXT,
        geschlecht               TEXT,
        beruf                    TEXT,
        beschreibung             TEXT,
        sort_order               INTEGER DEFAULT 0,
        meta                     TEXT,
        updated_at               TEXT    NOT NULL,
        user_email               TEXT,
        sozialschicht            TEXT,
        praesenz                 TEXT,
        rolle                    TEXT,
        motivation               TEXT,
        konflikt                 TEXT,
        entwicklung              TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER,
        schluesselzitate         TEXT,
        wohnadresse              TEXT,
        UNIQUE(book_id, fig_id, user_email)
      )
    `, [
      'CREATE INDEX idx_fig_book_id ON figures(book_id)',
    ]);

    // 11) figure_relations (FK from/to_fig_id CASCADE auf figures.id bleiben)
    _recreate82('figure_relations', `
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        typ             TEXT    NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT
      )
    `, [
      'CREATE INDEX idx_frel_book_id ON figure_relations(book_id)',
      'CREATE INDEX idx_frel_from    ON figure_relations(from_fig_id)',
      'CREATE INDEX idx_frel_to      ON figure_relations(to_fig_id)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors82 = db.pragma('foreign_key_check');
    if (fkErrors82.length) {
      throw new Error(`Migration 82: foreign_key_check meldet ${fkErrors82.length} Verstoesse: ${JSON.stringify(fkErrors82.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 82').run();
    logger.info('DB-Migration auf Version 82 abgeschlossen (FK book_id -> books fuer 11 strukturelle Tabellen: chat_sessions, book_reviews, chapter_reviews, ideen, page_checks, locations, figure_scenes, pages, chapters, figures, figure_relations).');
  }

  if (version < 83) {
    // Sentinel-Aufloesung pdf_export_profile.book_id=0 (User-Default-Vorlagen).
    // Analog zur chat_sessions-Sentinel-Aufloesung in Mig 69:
    //   book_id IS NULL  + kind='user_default'  → User-Default-Vorlage
    //   book_id NOT NULL + kind='book'          → Buch-spezifisches Profil
    // CHECK-Constraint erzwingt Konsistenz.
    //
    // UNIQUE(book_id, user_email, name) wird durch zwei partial UNIQUEs ersetzt
    // (NULL waere in normalen UNIQUEs nicht-vergleichbar):
    //   - book-scope:    UNIQUE(book_id, user_email, name) WHERE kind='book'
    //   - default-scope: UNIQUE(user_email, name)          WHERE kind='user_default'
    //
    // Nach der Datenmigration wird die books-Sentinel-Zeile (bookstack_book_id=0,
    // name='__user_default__') aus Mig 77 geloescht — sie ist nun unbenutzt.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS pdf_export_profile_new').run();
    db.prepare(`
      CREATE TABLE pdf_export_profile_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER REFERENCES books(bookstack_book_id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL DEFAULT 'book' CHECK(kind IN ('book','user_default')),
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        cover_image BLOB,
        cover_mime  TEXT,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        CHECK ((kind = 'book' AND book_id IS NOT NULL)
            OR (kind = 'user_default' AND book_id IS NULL))
      )
    `).run();
    db.prepare(`
      INSERT INTO pdf_export_profile_new
        (id, book_id, kind, user_email, name, config_json, cover_image, cover_mime, is_default, created_at, updated_at)
      SELECT id,
             CASE WHEN book_id = 0 THEN NULL ELSE book_id END,
             CASE WHEN book_id = 0 THEN 'user_default' ELSE 'book' END,
             user_email, name, config_json, cover_image, cover_mime, is_default, created_at, updated_at
        FROM pdf_export_profile
    `).run();
    db.prepare('DROP TABLE pdf_export_profile').run();
    db.prepare('ALTER TABLE pdf_export_profile_new RENAME TO pdf_export_profile').run();
    db.prepare(
      'CREATE UNIQUE INDEX idx_pdf_profile_book_name        ON pdf_export_profile(book_id, user_email, name) WHERE kind = \'book\''
    ).run();
    db.prepare(
      'CREATE UNIQUE INDEX idx_pdf_profile_userdefault_name ON pdf_export_profile(user_email, name)          WHERE kind = \'user_default\''
    ).run();
    db.prepare(
      'CREATE INDEX idx_pdf_profile_book_user ON pdf_export_profile(book_id, user_email)'
    ).run();

    // Pre-Cleanup vor DELETE der Sentinel-Zeile: Mit foreign_keys=OFF
    // triggert der DELETE keine FK-Cascades, daher explizit alle book_id=0
    // Refs aufloesen.
    //   - job_runs.book_id (nullable, Mig 81 SET NULL): → NULL
    // Andere book_id-Spalten sind NOT NULL und Pre-Cleanups in Mig 81/82
    // haetten 0-Werte bereits geloescht (NOT IN books); 0 selbst war jedoch
    // in books. Daher hier expliziter Sentinel-Cleanup.
    const jr0_83 = db.prepare('UPDATE job_runs SET book_id = NULL WHERE book_id = 0').run();
    if (jr0_83.changes) logger.info(`Mig 83: ${jr0_83.changes} job_runs.book_id=0 → NULL.`);

    // Sentinel-books-Zeile entfernen — keine Refs mehr.
    db.prepare("DELETE FROM books WHERE bookstack_book_id = 0").run();

    db.pragma('foreign_keys = ON');
    const fkErrors83 = db.pragma('foreign_key_check');
    if (fkErrors83.length) {
      throw new Error(`Migration 83: foreign_key_check meldet ${fkErrors83.length} Verstoesse: ${JSON.stringify(fkErrors83.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 83').run();
    logger.info('DB-Migration auf Version 83 abgeschlossen (pdf_export_profile.book_id Sentinel 0 -> NULL + kind-Spalte; books-Sentinel-Zeile entfernt).');
  }

  if (version < 84) {
    // PDF-Export-Profile sind ab jetzt user-scoped (nicht mehr buch-scoped).
    // Bestehende kind='book'-Eintraege werden zu kind='user_default' migriert.
    // Bei Namens-Kollision (z.B. zwei Buecher haben dasselbe Profil 'A4 Print')
    // wird der Buchname als Suffix angehaengt, damit der UNIQUE-Index
    // (user_email, name) WHERE kind='user_default' nicht bricht.
    const bookProfiles = db.prepare(
      `SELECT p.id, p.user_email, p.name, COALESCE(b.name, '') AS book_name, p.book_id
         FROM pdf_export_profile p
         LEFT JOIN books b ON b.bookstack_book_id = p.book_id
        WHERE p.kind = 'book'`
    ).all();

    const existingNames = new Map(); // userEmail → Set<name>
    db.prepare(
      `SELECT user_email, name FROM pdf_export_profile WHERE kind = 'user_default'`
    ).all().forEach(r => {
      if (!existingNames.has(r.user_email)) existingNames.set(r.user_email, new Set());
      existingNames.get(r.user_email).add(r.name);
    });

    const updateStmt = db.prepare(
      `UPDATE pdf_export_profile
          SET kind = 'user_default', book_id = NULL, name = ?, is_default = 0, updated_at = ?
        WHERE id = ?`
    );

    let migrated = 0;
    db.transaction(() => {
      for (const p of bookProfiles) {
        const userSet = existingNames.get(p.user_email) || new Set();
        let newName = p.name;
        if (userSet.has(newName)) {
          const base = p.book_name ? `${p.name} (${p.book_name})` : `${p.name} (Buch ${p.book_id})`;
          newName = base;
          let i = 2;
          while (userSet.has(newName)) {
            newName = `${base} #${i++}`;
          }
        }
        userSet.add(newName);
        existingNames.set(p.user_email, userSet);
        updateStmt.run(newName, Date.now(), p.id);
        migrated++;
      }
    })();

    db.prepare('UPDATE schema_version SET version = 84').run();
    logger.info(`DB-Migration auf Version 84 abgeschlossen (pdf_export_profile: ${migrated} kind='book' -> 'user_default' migriert).`);
  }

  if (version < 85) {
    // books-PK-Konsolidierung: bookstack_book_id wird zum PRIMARY KEY (analog
    // pages.page_id und chapters.chapter_id, die ebenfalls die externe
    // BookStack-ID direkt als PK nutzen). Surrogate `books.id` AUTOINCREMENT-PK
    // wird entfernt — war intern ungenutzt.
    //
    // Schritt 1: RENAME COLUMN bookstack_book_id -> book_id. SQLite >= 3.25
    // cascadiert FK-Refs in allen child-Tabellen automatisch (REFERENCES
    // books(bookstack_book_id) -> REFERENCES books(book_id)).
    // Schritt 2: Recreate books mit book_id als PK, surrogate `id` entfernt.
    db.pragma('foreign_keys = OFF');

    db.prepare('ALTER TABLE books RENAME COLUMN bookstack_book_id TO book_id').run();

    db.prepare('DROP TABLE IF EXISTS books_new').run();
    db.prepare(`
      CREATE TABLE books_new (
        book_id      INTEGER PRIMARY KEY,
        name         TEXT    NOT NULL,
        slug         TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        last_seen_at TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO books_new (book_id, name, slug, created_at, updated_at, last_seen_at)
      SELECT book_id, name, slug, created_at, updated_at, last_seen_at FROM books
    `).run();
    db.prepare('DROP TABLE books').run();
    db.prepare('ALTER TABLE books_new RENAME TO books').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen ON books(last_seen_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors85 = db.pragma('foreign_key_check');
    if (fkErrors85.length) {
      throw new Error(`Migration 85: foreign_key_check meldet ${fkErrors85.length} Verstoesse: ${JSON.stringify(fkErrors85.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 85').run();
    logger.info('DB-Migration auf Version 85 abgeschlossen (books.bookstack_book_id -> book_id PK; surrogate id-Spalte entfernt; FK-Refs in child-Tabellen cascadiert).');
  }

  if (version < 86) {
    // job_runs.error_params (JSON-TEXT) — speichert die i18n-Params zum error-Key,
    // damit /jobs/runs (book-settings Run-History) die Meldung mit eingesetzten
    // Platzhaltern rendern kann. Vorher: nur error-Key persistiert, UI zeigte
    // literal {count}/{details}.
    db.prepare('ALTER TABLE job_runs ADD COLUMN error_params TEXT').run();
    const fkErrors86 = db.pragma('foreign_key_check');
    if (fkErrors86.length) {
      throw new Error(`Migration 86: foreign_key_check meldet ${fkErrors86.length} Verstoesse: ${JSON.stringify(fkErrors86.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 86').run();
    logger.info('DB-Migration auf Version 86 abgeschlossen (job_runs.error_params).');
  }

  if (version < 87) {
    // users.daily_goal_chars — Zielwert für Heute-Ring auf der Buch-Übersicht.
    // 1500 Zeichen ≈ 1 Normseite. NULL = User hat kein eigenes Ziel gesetzt
    // → Frontend nutzt 1500 als Fallback.
    const userCols87 = db.pragma('table_info(users)').map(c => c.name);
    if (!userCols87.includes('daily_goal_chars')) {
      db.prepare('ALTER TABLE users ADD COLUMN daily_goal_chars INTEGER').run();
    }
    const fkErrors87 = db.pragma('foreign_key_check');
    if (fkErrors87.length) {
      throw new Error(`Migration 87: foreign_key_check meldet ${fkErrors87.length} Verstoesse: ${JSON.stringify(fkErrors87.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 87').run();
    logger.info('DB-Migration auf Version 87 abgeschlossen (users.daily_goal_chars).');
  }

  if (version < 88) {
    // book_settings.is_finished — markiert Buch als abgeschlossen.
    // Wenn 1, blendet die Buch-Übersicht die "wie viel pro Tag geschrieben"-Kacheln
    // (Trend-Sparkline, 7-Tage-Balken, Heute-Ring, Streak-Heatmap) aus, da bei
    // einem fertigen Buch nicht mehr aktiv geschrieben wird.
    const bsCols88 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols88.includes('is_finished')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN is_finished INTEGER NOT NULL DEFAULT 0').run();
    }
    const fkErrors88 = db.pragma('foreign_key_check');
    if (fkErrors88.length) {
      throw new Error(`Migration 88: foreign_key_check meldet ${fkErrors88.length} Verstoesse: ${JSON.stringify(fkErrors88.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 88').run();
    logger.info('DB-Migration auf Version 88 abgeschlossen (book_settings.is_finished).');
  }

  if (version < 89) {
    // Token-Verbrauch pro Provider/Modell tracken (Cache-Hits trennen).
    // job_runs: alle Hintergrund-Jobs (Lektorat, Review, Komplett, Synonyme, …).
    // chat_messages: Seiten-Chat (läuft nicht über Job-Queue, eigener Pfad).
    // cache_read_in / cache_creation_in nur Claude (lokale Modelle: 0).
    const jrCols89 = db.pragma('table_info(job_runs)').map(c => c.name);
    if (!jrCols89.includes('provider'))          db.prepare('ALTER TABLE job_runs ADD COLUMN provider TEXT').run();
    if (!jrCols89.includes('model'))             db.prepare('ALTER TABLE job_runs ADD COLUMN model TEXT').run();
    if (!jrCols89.includes('cache_read_in'))     db.prepare('ALTER TABLE job_runs ADD COLUMN cache_read_in INTEGER DEFAULT 0').run();
    if (!jrCols89.includes('cache_creation_in')) db.prepare('ALTER TABLE job_runs ADD COLUMN cache_creation_in INTEGER DEFAULT 0').run();

    const cmCols89 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols89.includes('provider'))          db.prepare('ALTER TABLE chat_messages ADD COLUMN provider TEXT').run();
    if (!cmCols89.includes('model'))             db.prepare('ALTER TABLE chat_messages ADD COLUMN model TEXT').run();
    if (!cmCols89.includes('cache_read_in'))     db.prepare('ALTER TABLE chat_messages ADD COLUMN cache_read_in INTEGER DEFAULT 0').run();
    if (!cmCols89.includes('cache_creation_in')) db.prepare('ALTER TABLE chat_messages ADD COLUMN cache_creation_in INTEGER DEFAULT 0').run();

    db.prepare('CREATE INDEX IF NOT EXISTS idx_jr_user_day ON job_runs(user_email, queued_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cm_created_at ON chat_messages(created_at)').run();

    const fkErrors89 = db.pragma('foreign_key_check');
    if (fkErrors89.length) {
      throw new Error(`Migration 89: foreign_key_check meldet ${fkErrors89.length} Verstoesse: ${JSON.stringify(fkErrors89.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 89').run();
    logger.info('DB-Migration auf Version 89 abgeschlossen (provider/model + cache_read_in/cache_creation_in in job_runs + chat_messages).');
  }

  if (version < 90) {
    // draft_figures: Figuren-Werkstatt (vorwärts-entwickelte Figuren als
    // Mindmap, isoliert von der figures-Tabelle, kein Promotion-Pfad).
    // mindmap_json hält die jsMind-Baumstruktur direkt.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS draft_figures (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        archetype    TEXT,
        mindmap_json TEXT    NOT NULL,
        notes        TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_df_book_user ON draft_figures(book_id, user_email)').run();

    const fkErrors90 = db.pragma('foreign_key_check');
    if (fkErrors90.length) {
      throw new Error(`Migration 90: foreign_key_check meldet ${fkErrors90.length} Verstoesse: ${JSON.stringify(fkErrors90.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 90').run();
    logger.info('DB-Migration auf Version 90 abgeschlossen (draft_figures).');
  }

  if (version < 91) {
    // user_tokens.email als FK auf users(email) ON DELETE CASCADE.
    // Token ohne User-Eintrag ist wertlos — sauberer Cascade-Delete.
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM user_tokens WHERE email NOT IN (SELECT email FROM users)').run();

    db.prepare('DROP TABLE IF EXISTS user_tokens_new').run();
    db.prepare(`
      CREATE TABLE user_tokens_new (
        email      TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        token_id   TEXT NOT NULL,
        token_pw   TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run();
    db.prepare('INSERT INTO user_tokens_new SELECT email, token_id, token_pw, updated_at FROM user_tokens').run();
    db.prepare('DROP TABLE user_tokens').run();
    db.prepare('ALTER TABLE user_tokens_new RENAME TO user_tokens').run();

    db.pragma('foreign_keys = ON');
    const fkErrors91 = db.pragma('foreign_key_check');
    if (fkErrors91.length) {
      throw new Error(`Migration 91: foreign_key_check meldet ${fkErrors91.length} Verstoesse: ${JSON.stringify(fkErrors91.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 91').run();
    logger.info('DB-Migration auf Version 91 abgeschlossen (user_tokens.email FK auf users(email) ON DELETE CASCADE).');
  }

  if (version < 92) {
    // figures.erste_erwaehnung_page_id: FK auf pages(page_id) ON DELETE SET NULL.
    // Analog locations.erste_erwaehnung_page_id (gleiche Semantik). Page-Delete
    // hinterlaesst sonst dangling Refs.
    db.pragma('foreign_keys = OFF');
    const orphans92 = db.prepare(`
      UPDATE figures SET erste_erwaehnung_page_id = NULL
       WHERE erste_erwaehnung_page_id IS NOT NULL
         AND erste_erwaehnung_page_id NOT IN (SELECT page_id FROM pages)
    `).run().changes;
    if (orphans92) logger.info(`Mig 92 Pre-Cleanup: ${orphans92} dangling figures.erste_erwaehnung_page_id genullt.`);

    db.prepare('DROP TABLE IF EXISTS figures_new').run();
    db.prepare(`
      CREATE TABLE figures_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        fig_id                   TEXT    NOT NULL,
        name                     TEXT    NOT NULL,
        kurzname                 TEXT,
        typ                      TEXT,
        geburtstag               TEXT,
        geschlecht               TEXT,
        beruf                    TEXT,
        beschreibung             TEXT,
        sort_order               INTEGER DEFAULT 0,
        meta                     TEXT,
        updated_at               TEXT    NOT NULL,
        user_email               TEXT,
        sozialschicht            TEXT,
        praesenz                 TEXT,
        rolle                    TEXT,
        motivation               TEXT,
        konflikt                 TEXT,
        entwicklung              TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        schluesselzitate         TEXT,
        wohnadresse              TEXT,
        UNIQUE(book_id, fig_id, user_email)
      )
    `).run();
    db.prepare(`
      INSERT INTO figures_new
        (id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order, meta, updated_at, user_email, sozialschicht, praesenz, rolle, motivation,
         konflikt, entwicklung, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, wohnadresse)
      SELECT
         id, book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order, meta, updated_at, user_email, sozialschicht, praesenz, rolle, motivation,
         konflikt, entwicklung, erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, wohnadresse
      FROM figures
    `).run();
    db.prepare('DROP TABLE figures').run();
    db.prepare('ALTER TABLE figures_new RENAME TO figures').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fig_book_id ON figures(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fig_eepage  ON figures(erste_erwaehnung_page_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors92 = db.pragma('foreign_key_check');
    if (fkErrors92.length) {
      throw new Error(`Migration 92: foreign_key_check meldet ${fkErrors92.length} Verstoesse: ${JSON.stringify(fkErrors92.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 92').run();
    logger.info('DB-Migration auf Version 92 abgeschlossen (figures.erste_erwaehnung_page_id FK auf pages(page_id) ON DELETE SET NULL).');
  }

  if (version < 93) {
    // chapters: PRIMARY KEY (chapter_id, book_id) + UNIQUE(chapter_id) ist redundant.
    // chapter_id allein ist global eindeutig (BookStack-ID). PK auf chapter_id reduziert,
    // Composite-UNIQUE entfernt — kein Konsument verlaesst sich auf composite-FK.
    db.pragma('foreign_keys = OFF');

    const dupes93 = db.prepare(`
      SELECT chapter_id, COUNT(*) AS c FROM chapters GROUP BY chapter_id HAVING c > 1
    `).all();
    if (dupes93.length) {
      throw new Error(`Migration 93: ${dupes93.length} chapter_ids mit mehrfachen Eintraegen; manuelle Bereinigung noetig.`);
    }

    db.prepare('DROP TABLE IF EXISTS chapters_new').run();
    db.prepare(`
      CREATE TABLE chapters_new (
        chapter_id   INTEGER PRIMARY KEY,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO chapters_new (chapter_id, book_id, chapter_name, updated_at, last_seen_at)
      SELECT chapter_id, book_id, chapter_name, updated_at, last_seen_at FROM chapters
    `).run();
    db.prepare('DROP TABLE chapters').run();
    db.prepare('ALTER TABLE chapters_new RENAME TO chapters').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors93 = db.pragma('foreign_key_check');
    if (fkErrors93.length) {
      throw new Error(`Migration 93: foreign_key_check meldet ${fkErrors93.length} Verstoesse: ${JSON.stringify(fkErrors93.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 93').run();
    logger.info('DB-Migration auf Version 93 abgeschlossen (chapters PK auf chapter_id reduziert; Composite-UNIQUE entfernt).');
  }

  if (version < 94) {
    // chat_messages: Spaltenreihenfolge konsolidieren. Mehrere ALTERs haben tps/provider/model/
    // cache_read_in/cache_creation_in ans Ende gehaengt — kosmetisch, aber Drift-Indikator.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS chat_messages_new').run();
    db.prepare(`
      CREATE TABLE chat_messages_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id        INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role              TEXT    NOT NULL CHECK(role IN ('user','assistant')),
        content           TEXT    NOT NULL,
        vorschlaege       TEXT,
        context_info      TEXT,
        provider          TEXT,
        model             TEXT,
        tokens_in         INTEGER,
        tokens_out        INTEGER,
        cache_read_in     INTEGER DEFAULT 0,
        cache_creation_in INTEGER DEFAULT 0,
        tps               REAL,
        created_at        TEXT NOT NULL
      )
    `).run();
    db.prepare(`
      INSERT INTO chat_messages_new
        (id, session_id, role, content, vorschlaege, context_info, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, tps, created_at)
      SELECT
         id, session_id, role, content, vorschlaege, context_info, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, tps, created_at
      FROM chat_messages
    `).run();
    db.prepare('DROP TABLE chat_messages').run();
    db.prepare('ALTER TABLE chat_messages_new RENAME TO chat_messages').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cm_session_created ON chat_messages(session_id, created_at)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors94 = db.pragma('foreign_key_check');
    if (fkErrors94.length) {
      throw new Error(`Migration 94: foreign_key_check meldet ${fkErrors94.length} Verstoesse: ${JSON.stringify(fkErrors94.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 94').run();
    logger.info('DB-Migration auf Version 94 abgeschlossen (chat_messages Spaltenreihenfolge konsolidiert).');
  }

  if (version < 95) {
    // figure_relations: UNIQUE(book_id, from_fig_id, to_fig_id, typ, user_email)
    // als Defensive-Schicht. Beide Schreibpfade machen bereits Programm-Dedup
    // (saveFigurenToDb: Full-Replace; addFigurenBeziehungen: ungerichteter Pair-Check).
    // Constraint laesst kuenftige Bugs hart scheitern statt Doppel-Edges entstehen.
    db.pragma('foreign_keys = OFF');

    const dedup95 = db.prepare(`
      DELETE FROM figure_relations
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM figure_relations
          GROUP BY book_id, from_fig_id, to_fig_id, typ, COALESCE(user_email,'')
       )
    `).run().changes;
    if (dedup95) logger.info(`Mig 95 Pre-Cleanup: ${dedup95} Duplikat-Relations entfernt.`);

    db.prepare('DROP TABLE IF EXISTS figure_relations_new').run();
    db.prepare(`
      CREATE TABLE figure_relations_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        from_fig_id     INTEGER NOT NULL REFERENCES figures(id)    ON DELETE CASCADE,
        to_fig_id       INTEGER NOT NULL REFERENCES figures(id)    ON DELETE CASCADE,
        typ             TEXT    NOT NULL,
        beschreibung    TEXT,
        user_email      TEXT,
        machtverhaltnis INTEGER,
        belege          TEXT,
        UNIQUE(book_id, from_fig_id, to_fig_id, typ, user_email)
      )
    `).run();
    db.prepare(`
      INSERT INTO figure_relations_new
        (id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege)
      SELECT
         id, book_id, from_fig_id, to_fig_id, typ, beschreibung, user_email, machtverhaltnis, belege
      FROM figure_relations
    `).run();
    db.prepare('DROP TABLE figure_relations').run();
    db.prepare('ALTER TABLE figure_relations_new RENAME TO figure_relations').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_book_id ON figure_relations(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_from    ON figure_relations(from_fig_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_to      ON figure_relations(to_fig_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors95 = db.pragma('foreign_key_check');
    if (fkErrors95.length) {
      throw new Error(`Migration 95: foreign_key_check meldet ${fkErrors95.length} Verstoesse: ${JSON.stringify(fkErrors95.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 95').run();
    logger.info('DB-Migration auf Version 95 abgeschlossen (figure_relations UNIQUE + Dedup).');
  }

  if (version < 96) {
    // Bridge-Tabellen ohne PK -> Surrogate id INTEGER PRIMARY KEY AUTOINCREMENT.
    // Erlaubt Update/Delete einzelner Zeilen; entlastet Schreibpfade von
    // Tupel-WHERE-Klauseln. Composite-PK ginge nicht (nullable Refs in den
    // meisten Bruecken wegen ON DELETE SET NULL).
    db.pragma('foreign_keys = OFF');

    const _recreate96 = (table, createSql, insertCols, indexSqls) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(`INSERT INTO ${table}_new (${insertCols}) SELECT ${insertCols} FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexSqls) db.prepare(ix).run();
    };

    _recreate96('continuity_issue_figures', `
      CREATE TABLE continuity_issue_figures_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `, 'issue_id, figure_id, figur_name, sort_order', [
      'CREATE INDEX idx_cif_issue  ON continuity_issue_figures(issue_id)',
      'CREATE INDEX idx_cif_figure ON continuity_issue_figures(figure_id)',
    ]);

    _recreate96('continuity_issue_chapters', `
      CREATE TABLE continuity_issue_chapters_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id   INTEGER NOT NULL REFERENCES continuity_issues(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'issue_id, chapter_id, sort_order', [
      'CREATE INDEX idx_cic_issue   ON continuity_issue_chapters(issue_id)',
      'CREATE INDEX idx_cic_chapter ON continuity_issue_chapters(chapter_id)',
    ]);

    _recreate96('zeitstrahl_event_chapters', `
      CREATE TABLE zeitstrahl_event_chapters_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        chapter_id INTEGER          REFERENCES chapters(chapter_id)  ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, chapter_id, sort_order', [
      'CREATE INDEX idx_zec_event   ON zeitstrahl_event_chapters(event_id)',
      'CREATE INDEX idx_zec_chapter ON zeitstrahl_event_chapters(chapter_id)',
    ]);

    _recreate96('zeitstrahl_event_pages', `
      CREATE TABLE zeitstrahl_event_pages_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        page_id    INTEGER          REFERENCES pages(page_id)        ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, page_id, sort_order', [
      'CREATE INDEX idx_zep_event ON zeitstrahl_event_pages(event_id)',
      'CREATE INDEX idx_zep_page  ON zeitstrahl_event_pages(page_id)',
    ]);

    _recreate96('zeitstrahl_event_figures', `
      CREATE TABLE zeitstrahl_event_figures_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id   INTEGER NOT NULL REFERENCES zeitstrahl_events(id) ON DELETE CASCADE,
        figure_id  INTEGER          REFERENCES figures(id)            ON DELETE SET NULL,
        figur_name TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `, 'event_id, figure_id, figur_name, sort_order', [
      'CREATE INDEX idx_zef_event  ON zeitstrahl_event_figures(event_id)',
      'CREATE INDEX idx_zef_figure ON zeitstrahl_event_figures(figure_id)',
    ]);

    _recreate96('figure_events', `
      CREATE TABLE figure_events_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id  INTEGER NOT NULL REFERENCES figures(id)         ON DELETE CASCADE,
        datum      TEXT NOT NULL,
        ereignis   TEXT NOT NULL,
        bedeutung  TEXT,
        typ        TEXT DEFAULT 'persoenlich',
        sort_order INTEGER DEFAULT 0,
        chapter_id INTEGER REFERENCES chapters(chapter_id)         ON DELETE SET NULL,
        page_id    INTEGER REFERENCES pages(page_id)               ON DELETE SET NULL
      )
    `, 'figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id', [
      'CREATE INDEX idx_fe_chapter ON figure_events(chapter_id)',
      'CREATE INDEX idx_fe_page    ON figure_events(page_id)',
    ]);

    db.pragma('foreign_keys = ON');
    const fkErrors96 = db.pragma('foreign_key_check');
    if (fkErrors96.length) {
      throw new Error(`Migration 96: foreign_key_check meldet ${fkErrors96.length} Verstoesse: ${JSON.stringify(fkErrors96.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 96').run();
    logger.info('DB-Migration auf Version 96 abgeschlossen (Surrogate-PK fuer 6 Bridge-Tabellen: continuity_issue_figures/chapters, zeitstrahl_event_chapters/pages/figures, figure_events).');
  }

  if (version < 97) {
    // draft_figures.source_figure_id: Referenz auf Quell-Figur (figures.id),
    // wenn Werkstatt-Draft via Import aus dem Figuren-Katalog erzeugt wurde.
    // ON DELETE SET NULL: User-kuratierte Mindmap-Arbeit bleibt erhalten,
    // wenn die Quell-Figur (z.B. durch Komplettanalyse-Reextraktion) verschwindet.
    // FK in SQLite via ALTER TABLE ADD CONSTRAINT nicht möglich → Recreate-Pattern.
    db.pragma('foreign_keys = OFF');

    db.prepare('DROP TABLE IF EXISTS draft_figures_new').run();
    db.prepare(`
      CREATE TABLE draft_figures_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email       TEXT    NOT NULL,
        name             TEXT    NOT NULL,
        archetype        TEXT,
        mindmap_json     TEXT    NOT NULL,
        notes            TEXT,
        source_figure_id INTEGER REFERENCES figures(id) ON DELETE SET NULL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      )
    `).run();
    db.prepare(`
      INSERT INTO draft_figures_new
        (id, book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at)
      SELECT id, book_id, user_email, name, archetype, mindmap_json, notes, created_at, updated_at
      FROM draft_figures
    `).run();
    db.prepare('DROP TABLE draft_figures').run();
    db.prepare('ALTER TABLE draft_figures_new RENAME TO draft_figures').run();
    db.prepare('CREATE INDEX idx_df_book_user ON draft_figures(book_id, user_email)').run();
    db.prepare('CREATE INDEX idx_df_source ON draft_figures(source_figure_id)').run();

    db.pragma('foreign_keys = ON');
    const fkErrors97 = db.pragma('foreign_key_check');
    if (fkErrors97.length) {
      throw new Error(`Migration 97: foreign_key_check meldet ${fkErrors97.length} Verstoesse: ${JSON.stringify(fkErrors97.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 97').run();
    logger.info('DB-Migration auf Version 97 abgeschlossen (draft_figures.source_figure_id FK).');
  }

  if (version < 98) {
    // werkstatt_runs: KI-Lauf-Historie für Figuren-Werkstatt (Brainstorm +
    // Consistency). Pro Lauf eine Zeile mit Result-JSON; Frontend zeigt zwei
    // klappbare Sektionen pro Draft. ON DELETE CASCADE: Run-Historie stirbt
    // mit dem Draft (lose Runs ohne Draft hätten keinen Owner mehr).
    // book_id für History-Reset-Pfad (DELETE WHERE book_id = ? AND user_email = ?).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS werkstatt_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id    INTEGER NOT NULL REFERENCES draft_figures(id) ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('brainstorm','consistency')),
        created_at  TEXT    NOT NULL,
        knoten_id   TEXT,
        knoten_pfad TEXT,
        result_json TEXT    NOT NULL,
        model       TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_wr_draft_kind_date ON werkstatt_runs(draft_id, kind, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_wr_book_user       ON werkstatt_runs(book_id, user_email)').run();
    const fkErrors98 = db.pragma('foreign_key_check');
    if (fkErrors98.length) {
      throw new Error(`Migration 98: foreign_key_check meldet ${fkErrors98.length} Verstoesse: ${JSON.stringify(fkErrors98.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 98').run();
    logger.info('DB-Migration auf Version 98 abgeschlossen (werkstatt_runs).');
  }

  if (version < 99) {
    // tok-Semantik-Wechsel: page_stats.tok und book_stats_history.tok bedeuten
    // ab sofort Text-Tokens (chars / CHARS_PER_TOKEN), nicht mehr Lektorat-
    // Prompt-Tokens. Hero und Sparkline sollen ohne Sprung weiterlaufen, also
    // bestehende Rows recomputen. CHARS_PER_TOKEN aus Provider abgeleitet
    // (Claude=3, sonst=1.5; ENV-Override zieht).
    const provider = (process.env.API_PROVIDER || 'claude').toLowerCase();
    const cptDefault = provider === 'claude' ? 3 : 1.5;
    const cpt = parseFloat(process.env.CHARS_PER_TOKEN) || cptDefault;
    db.prepare('UPDATE page_stats SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt);
    db.prepare('UPDATE book_stats_history SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt);
    const fkErrors99 = db.pragma('foreign_key_check');
    if (fkErrors99.length) {
      throw new Error(`Migration 99: foreign_key_check meldet ${fkErrors99.length} Verstoesse: ${JSON.stringify(fkErrors99.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 99').run();
    logger.info(`DB-Migration auf Version 99 abgeschlossen (tok = chars/${cpt} in page_stats + book_stats_history).`);
  }

  if (version < 100) {
    // chat_sessions: Snapshot-Spalten book_name + page_name fallen weg. Display-
    // Werte werden zur Lese-Zeit per JOIN auf books.name bzw. pages.page_name
    // gezogen (CLAUDE.md «Snapshot-Spalten verboten»). Gleichzeitig book_id zur
    // FK auf books(book_id) härten (DB relational integrity).
    db.pragma('foreign_keys = OFF');
    // Orphan-Cleanup: chat_sessions ohne zugehöriges Buch entfernen
    // (chat_messages folgen via CASCADE).
    db.prepare('DELETE FROM chat_sessions WHERE book_id NOT IN (SELECT book_id FROM books)').run();
    const runStmt100 = (sql) => db.prepare(sql).run();
    runStmt100('DROP TABLE IF EXISTS chat_sessions_new');
    runStmt100(`
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind = 'book' AND page_id IS NULL))
      )
    `);
    runStmt100(`
      INSERT INTO chat_sessions_new
        (id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text)
      SELECT
        id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text
      FROM chat_sessions
    `);
    runStmt100('DROP TABLE chat_sessions');
    runStmt100('ALTER TABLE chat_sessions_new RENAME TO chat_sessions');
    runStmt100('CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email)');
    runStmt100('CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email)');
    runStmt100('CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind)');
    db.pragma('foreign_keys = ON');
    const fkErrors100 = db.pragma('foreign_key_check');
    if (fkErrors100.length) {
      throw new Error(`Migration 100: foreign_key_check meldet ${fkErrors100.length} Verstoesse: ${JSON.stringify(fkErrors100.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 100').run();
    logger.info('DB-Migration auf Version 100 abgeschlossen (chat_sessions: book_name + page_name gedroppt, book_id FK auf books).');
  }

  if (version < 101) {
    // CHARS_PER_TOKEN-Default für non-Claude Provider wurde von 1.5 auf 4
    // angehoben (realistischer für SentencePiece-Tokenizer von Mistral/Llama auf
    // deutschem Fliesstext). Bestehende page_stats.tok / book_stats_history.tok
    // wurden in Migration 99 mit dem alten Wert berechnet – jetzt neu rechnen,
    // damit Hero/Sparkline ohne Sprung weiterlaufen.
    const provider101 = (process.env.API_PROVIDER || 'claude').toLowerCase();
    const cpt101Default = provider101 === 'claude' ? 3 : 4;
    const cpt101 = parseFloat(process.env.CHARS_PER_TOKEN) || cpt101Default;
    db.prepare('UPDATE page_stats SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt101);
    db.prepare('UPDATE book_stats_history SET tok = ROUND(chars / ?) WHERE chars IS NOT NULL').run(cpt101);
    const fkErrors101 = db.pragma('foreign_key_check');
    if (fkErrors101.length) {
      throw new Error(`Migration 101: foreign_key_check meldet ${fkErrors101.length} Verstoesse: ${JSON.stringify(fkErrors101.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 101').run();
    logger.info(`DB-Migration auf Version 101 abgeschlossen (tok = chars/${cpt101} in page_stats + book_stats_history; non-Claude default 1.5 → 4).`);
  }

  if (version < 102) {
    // Delta-Cache für Buch-Review (analog chapter_extract_cache / book_extract_cache
    // aus Komplettanalyse). Spart bei grossen Büchern den Kapitelanalyse-Call,
    // wenn pages_sig + Prompt-Vars unverändert sind.
    const mig102 = `
      CREATE TABLE IF NOT EXISTS chapter_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        phase       TEXT    NOT NULL DEFAULT '',
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase)
      );
      CREATE INDEX IF NOT EXISTS idx_crc_book_user
        ON chapter_review_cache(book_id, user_email);

      CREATE TABLE IF NOT EXISTS book_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_brc_book_user
        ON book_review_cache(book_id, user_email);
    `;
    db.exec(mig102);
    const fkErrors102 = db.pragma('foreign_key_check');
    if (fkErrors102.length) {
      throw new Error(`Migration 102: foreign_key_check meldet ${fkErrors102.length} Verstoesse: ${JSON.stringify(fkErrors102.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 102').run();
    logger.info('DB-Migration auf Version 102 abgeschlossen (chapter_review_cache + book_review_cache für Buch-Review Delta-Caching).');
  }

  if (version < 103) {
    // Delta-Caches für Kapitel-Bewertung, Synonym-Suche, Seiten-Lektorat.
    // Analog zu chapter_extract_cache: pages_sig/ctx_sig identisch → HIT.
    const mig103 = `
      CREATE TABLE IF NOT EXISTS chapter_macro_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cmrc_book_user
        ON chapter_macro_review_cache(book_id, user_email);

      CREATE TABLE IF NOT EXISTS synonym_cache (
        user_email  TEXT    NOT NULL DEFAULT '',
        key_hash    TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (user_email, key_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_sc_user ON synonym_cache(user_email);

      CREATE TABLE IF NOT EXISTS lektorat_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL DEFAULT '',
        page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        ctx_sig     TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, page_id)
      );
      CREATE INDEX IF NOT EXISTS idx_lc_book_user ON lektorat_cache(book_id, user_email);
    `;
    db.exec(mig103);
    const fkErrors103 = db.pragma('foreign_key_check');
    if (fkErrors103.length) {
      throw new Error(`Migration 103: foreign_key_check meldet ${fkErrors103.length} Verstoesse: ${JSON.stringify(fkErrors103.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 103').run();
    logger.info('DB-Migration auf Version 103 abgeschlossen (chapter_macro_review_cache + synonym_cache + lektorat_cache).');
  }

  if (version < 104) {
    // Idempotency-Key für Chat-Send: client_msg_id (UUID) + job_id-Backreferenz.
    // Verhindert Doppel-Inserts bei Connection-Loss-Retry (siehe chat.js _handleChatPost).
    const cmCols104 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols104.includes('client_msg_id')) {
      db.prepare('ALTER TABLE chat_messages ADD COLUMN client_msg_id TEXT').run();
    }
    if (!cmCols104.includes('job_id')) {
      db.prepare('ALTER TABLE chat_messages ADD COLUMN job_id TEXT').run();
    }
    const mig104 = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cm_session_clientmsg
        ON chat_messages(session_id, client_msg_id)
        WHERE client_msg_id IS NOT NULL;
    `;
    db.exec(mig104);
    const fkErrors104 = db.pragma('foreign_key_check');
    if (fkErrors104.length) {
      throw new Error(`Migration 104: foreign_key_check meldet ${fkErrors104.length} Verstoesse: ${JSON.stringify(fkErrors104.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 104').run();
    logger.info('DB-Migration auf Version 104 abgeschlossen (chat_messages.client_msg_id + job_id für Idempotency).');
  }

  if (version < 105) {
    // Additives Schema-Skelett fuer pages/chapters/books — Body, Order, Owner,
    // Slug, Dirty-Flag fuer Sync-Worker.
    //
    // pages.body_html/body_markdown: lokale Wahrheit im localdb-Backend; im
    //   bookstack-Mode Cache, der beim Backfill gefuellt wird.
    // pages/chapters.position/priority: Sortierung; position lokal, priority
    //   spiegelt BookStack-`priority` im bookstack-Mode.
    // pages.local_updated_at/remote_updated_at/dirty: Konflikterkennung beim
    //   Sync-Pull (bookstack-Mode).
    // books.owner_email: Erst-Backfiller; Sharing-Regel via book_access.
    // books.cover_image: BLOB, optional.
    const pagesCols105 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols105.includes('body_html'))         db.prepare('ALTER TABLE pages ADD COLUMN body_html TEXT').run();
    if (!pagesCols105.includes('body_markdown'))     db.prepare('ALTER TABLE pages ADD COLUMN body_markdown TEXT').run();
    if (!pagesCols105.includes('position'))          db.prepare('ALTER TABLE pages ADD COLUMN position INTEGER').run();
    if (!pagesCols105.includes('priority'))          db.prepare('ALTER TABLE pages ADD COLUMN priority INTEGER').run();
    if (!pagesCols105.includes('slug'))              db.prepare('ALTER TABLE pages ADD COLUMN slug TEXT').run();
    if (!pagesCols105.includes('local_updated_at'))  db.prepare('ALTER TABLE pages ADD COLUMN local_updated_at TEXT').run();
    if (!pagesCols105.includes('remote_updated_at')) db.prepare('ALTER TABLE pages ADD COLUMN remote_updated_at TEXT').run();
    if (!pagesCols105.includes('dirty'))             db.prepare('ALTER TABLE pages ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0').run();

    const chapCols105 = db.pragma('table_info(chapters)').map(c => c.name);
    if (!chapCols105.includes('position'))    db.prepare('ALTER TABLE chapters ADD COLUMN position INTEGER').run();
    if (!chapCols105.includes('priority'))    db.prepare('ALTER TABLE chapters ADD COLUMN priority INTEGER').run();
    if (!chapCols105.includes('slug'))        db.prepare('ALTER TABLE chapters ADD COLUMN slug TEXT').run();
    if (!chapCols105.includes('description')) db.prepare('ALTER TABLE chapters ADD COLUMN description TEXT').run();

    const booksCols105 = db.pragma('table_info(books)').map(c => c.name);
    if (!booksCols105.includes('description')) db.prepare('ALTER TABLE books ADD COLUMN description TEXT').run();
    if (!booksCols105.includes('cover_image')) db.prepare('ALTER TABLE books ADD COLUMN cover_image BLOB').run();
    if (!booksCols105.includes('owner_email')) db.prepare('ALTER TABLE books ADD COLUMN owner_email TEXT').run();
    // books.created_at existiert bereits seit Migration 85 — kein ALTER.

    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_owner_email ON books(owner_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_dirty       ON pages(dirty) WHERE dirty = 1').run();

    const fkErrors105 = db.pragma('foreign_key_check');
    if (fkErrors105.length) {
      throw new Error(`Migration 105: foreign_key_check meldet ${fkErrors105.length} Verstoesse: ${JSON.stringify(fkErrors105.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 105').run();
    logger.info('DB-Migration auf Version 105 abgeschlossen (Schema-Skelett: pages/chapters/books additive Spalten fuer Body, Order, Owner, Dirty-Flag).');
  }

  if (version < 106) {
    // books/chapters/pages auf INTEGER PRIMARY KEY AUTOINCREMENT umstellen.
    // Wasserzeichen >= 1_000_000, damit `localdb`-Mode frische IDs ausserhalb
    // des BookStack-Range vergibt.
    //
    // Bestandsrows behalten ihre BookStack-IDs (INSERT SELECT preserve), alle
    // ~40 FK-Spalten (figures.book_id, page_revisions.page_id, …) bleiben
    // gueltig — keine ID-Map noetig.
    //
    // Recreate-Pattern aus CLAUDE.md: foreign_keys=OFF -> CREATE _new -> INSERT
    // SELECT -> DROP old -> RENAME -> recreate indexes -> foreign_keys=ON ->
    // foreign_key_check. Reihenfolge: books -> chapters -> pages (FK-Kette).
    db.pragma('foreign_keys = OFF');

    // 1) books
    db.prepare('DROP TABLE IF EXISTS books_new').run();
    db.prepare(`
      CREATE TABLE books_new (
        book_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT    NOT NULL,
        slug         TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        last_seen_at TEXT,
        description  TEXT,
        cover_image  BLOB,
        owner_email  TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO books_new (book_id, name, slug, created_at, updated_at, last_seen_at, description, cover_image, owner_email)
      SELECT                book_id, name, slug, created_at, updated_at, last_seen_at, description, cover_image, owner_email
        FROM books
    `).run();
    db.prepare('DROP TABLE books').run();
    db.prepare('ALTER TABLE books_new RENAME TO books').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_last_seen   ON books(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_books_owner_email ON books(owner_email)').run();

    // 2) chapters
    db.prepare('DROP TABLE IF EXISTS chapters_new').run();
    db.prepare(`
      CREATE TABLE chapters_new (
        chapter_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        chapter_name TEXT    NOT NULL,
        updated_at   TEXT,
        last_seen_at TEXT,
        position     INTEGER,
        priority     INTEGER,
        slug         TEXT,
        description  TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO chapters_new (chapter_id, book_id, chapter_name, updated_at, last_seen_at, position, priority, slug, description)
      SELECT                   chapter_id, book_id, chapter_name, updated_at, last_seen_at, position, priority, slug, description
        FROM chapters
    `).run();
    db.prepare('DROP TABLE chapters').run();
    db.prepare('ALTER TABLE chapters_new RENAME TO chapters').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_last_seen ON chapters(last_seen_at)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_book_id   ON chapters(book_id)').run();

    // 3) pages
    db.prepare('DROP TABLE IF EXISTS pages_new').run();
    db.prepare(`
      CREATE TABLE pages_new (
        page_id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL,
        page_name         TEXT,
        chapter_id        INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        updated_at        TEXT,
        preview_text      TEXT,
        last_seen_at      TEXT,
        body_html         TEXT,
        body_markdown     TEXT,
        position          INTEGER,
        priority          INTEGER,
        slug              TEXT,
        local_updated_at  TEXT,
        remote_updated_at TEXT,
        dirty             INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    db.prepare(`
      INSERT INTO pages_new (page_id, book_id, page_name, chapter_id, updated_at, preview_text, last_seen_at,
                             body_html, body_markdown, position, priority, slug, local_updated_at, remote_updated_at, dirty)
      SELECT                page_id, book_id, page_name, chapter_id, updated_at, preview_text, last_seen_at,
                             body_html, body_markdown, position, priority, slug, local_updated_at, remote_updated_at, dirty
        FROM pages
    `).run();
    db.prepare('DROP TABLE pages').run();
    db.prepare('ALTER TABLE pages_new RENAME TO pages').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id     ON pages(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id  ON pages(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_dirty       ON pages(dirty) WHERE dirty = 1').run();

    // Wasserzeichen: nextID >= MAX(1_000_000, MAX(existing_id)). Trennt
    // localdb-Range (>=1_000_001) sauber vom BookStack-Range (<100k typisch).
    //
    // sqlite_sequence hat keinen UNIQUE-Constraint auf `name` — INSERT OR REPLACE
    // wuerde Duplikate erzeugen, weil das INSERT INTO ... SELECT oben bereits
    // automatisch eine Row mit dem alten max(rowid) angelegt hat. Erst DELETE,
    // dann INSERT, damit pro Tabelle genau eine Wasserzeichen-Row entsteht.
    const WATERMARK = 1_000_000;
    const maxBook    = db.prepare('SELECT COALESCE(MAX(book_id),    0) AS m FROM books').get().m;
    const maxChapter = db.prepare('SELECT COALESCE(MAX(chapter_id), 0) AS m FROM chapters').get().m;
    const maxPage    = db.prepare('SELECT COALESCE(MAX(page_id),    0) AS m FROM pages').get().m;
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('books','chapters','pages')`).run();
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('books',    ?)`).run(Math.max(WATERMARK, maxBook));
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('chapters', ?)`).run(Math.max(WATERMARK, maxChapter));
    db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('pages',    ?)`).run(Math.max(WATERMARK, maxPage));

    db.pragma('foreign_keys = ON');
    const fkErrors106 = db.pragma('foreign_key_check');
    if (fkErrors106.length) {
      throw new Error(`Migration 106: foreign_key_check meldet ${fkErrors106.length} Verstoesse: ${JSON.stringify(fkErrors106.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 106').run();
    logger.info('DB-Migration auf Version 106 abgeschlossen (books/chapters/pages auf AUTOINCREMENT umgestellt, sqlite_sequence Wasserzeichen >= 1_000_000).');
  }

  if (version < 107) {
    // App-eigene User-DB.
    // Drei neue Tabellen: app_users (Identity + Role + Status), user_invites
    // (Token-Workflow), user_sessions_audit (Login-Events fuer Admin).
    //
    // Bestehende `users`-Tabelle (Profil/Settings, seit Mig 41) bleibt — sie
    // wird hier nur um eine FK auf app_users(email) ON DELETE CASCADE erweitert,
    // damit beim Hard-Delete eines App-Users (selten; Default ist Soft-Delete
    // via status='deleted') auch Profile/Tokens kaskadieren.
    //
    // Backfill: alle distinct user_email-Werte aus users + job_runs +
    // chat_sessions + user_tokens + page_checks bekommen app_users-Rows mit
    // status='active', global_role='user'. ADMIN_EMAIL-Bootstrap laeuft NICHT
    // hier (Migration ist data-frei), sondern beim Server-Start (separater
    // Helper, damit ENV-Wechsel ohne Re-Migration wirkt).
    db.pragma('foreign_keys = OFF');

    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        email            TEXT NOT NULL UNIQUE,
        display_name     TEXT,
        avatar_url       TEXT,
        global_role      TEXT NOT NULL DEFAULT 'user'
                              CHECK(global_role IN ('admin','user')),
        status           TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('invited','active','suspended','deleted')),
        language         TEXT DEFAULT 'de',
        model_override   TEXT,
        can_invite_users INTEGER NOT NULL DEFAULT 1,
        first_seen_at    TEXT,
        last_seen_at     TEXT,
        invited_by       TEXT,
        invited_at       TEXT,
        created_at       TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users(status)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_invites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        email        TEXT NOT NULL,
        global_role  TEXT NOT NULL DEFAULT 'user'
                          CHECK(global_role IN ('admin','user')),
        invite_token TEXT NOT NULL UNIQUE,
        invited_by   TEXT NOT NULL,
        invited_at   TEXT DEFAULT (datetime('now')),
        expires_at   TEXT NOT NULL,
        accepted_at  TEXT,
        revoked_at   TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_invites_token ON user_invites(invite_token)').run();
    // Partial UNIQUE: nur aktive Invites blockieren erneutes Senden.
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_active_email
        ON user_invites(email)
        WHERE revoked_at IS NULL AND accepted_at IS NULL
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_sessions_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated','role-changed','deleted')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();

    // Bestandsbackfill: distinct user_email aus allen user-scoped Tabellen.
    const sources = [
      "SELECT email AS email, name AS display_name, created_at, last_seen_at FROM users",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM job_runs WHERE user_email IS NOT NULL AND user_email <> ''",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM chat_sessions WHERE user_email IS NOT NULL AND user_email <> ''",
      "SELECT email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM user_tokens WHERE email IS NOT NULL AND email <> ''",
      "SELECT DISTINCT user_email AS email, NULL AS display_name, NULL AS created_at, NULL AS last_seen_at FROM page_checks WHERE user_email IS NOT NULL AND user_email <> ''",
    ];
    const insUser = db.prepare(`
      INSERT INTO app_users (email, display_name, status, global_role, first_seen_at, last_seen_at, created_at)
      VALUES (?, ?, 'active', 'user', ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        display_name  = COALESCE(app_users.display_name, excluded.display_name),
        first_seen_at = COALESCE(app_users.first_seen_at, excluded.first_seen_at),
        last_seen_at  = COALESCE(app_users.last_seen_at, excluded.last_seen_at)
    `);
    const seen = new Set();
    db.transaction(() => {
      for (const sql of sources) {
        const tableOk = (() => {
          try { return db.prepare(sql + ' LIMIT 0').all() !== undefined; }
          catch { return false; }
        })();
        if (!tableOk) continue;
        const rows = db.prepare(sql).all();
        for (const r of rows) {
          if (!r.email) continue;
          if (seen.has(r.email)) continue;
          seen.add(r.email);
          const nowIso = new Date().toISOString();
          insUser.run(
            r.email,
            r.display_name || null,
            r.created_at || nowIso,
            r.last_seen_at || null,
            r.created_at || nowIso,
          );
        }
      }
    })();
    if (seen.size > 0) logger.info(`Migration 107: ${seen.size} distinct user_email(s) nach app_users gespiegelt.`);

    // FK-Recreate `users`: email REFERENCES app_users(email) ON DELETE CASCADE.
    // Spalten-Reihenfolge entspricht aktuellem Stand (Mig 41 + 52 + 63 + 87).
    db.prepare('DELETE FROM users WHERE email NOT IN (SELECT email FROM app_users)').run();

    db.prepare('DROP TABLE IF EXISTS users_new').run();
    db.prepare(`
      CREATE TABLE users_new (
        email             TEXT PRIMARY KEY REFERENCES app_users(email) ON DELETE CASCADE,
        name              TEXT,
        created_at        TEXT NOT NULL,
        last_login_at     TEXT,
        locale            TEXT,
        theme             TEXT,
        default_buchtyp   TEXT,
        default_language  TEXT,
        default_region    TEXT,
        last_seen_at      TEXT,
        focus_granularity TEXT,
        daily_goal_chars  INTEGER
      )
    `).run();
    db.prepare(`
      INSERT INTO users_new (email, name, created_at, last_login_at, locale, theme,
                             default_buchtyp, default_language, default_region,
                             last_seen_at, focus_granularity, daily_goal_chars)
      SELECT                 email, name, created_at, last_login_at, locale, theme,
                             default_buchtyp, default_language, default_region,
                             last_seen_at, focus_granularity, daily_goal_chars
        FROM users
    `).run();
    db.prepare('DROP TABLE users').run();
    db.prepare('ALTER TABLE users_new RENAME TO users').run();

    db.pragma('foreign_keys = ON');
    const fkErrors107 = db.pragma('foreign_key_check');
    if (fkErrors107.length) {
      throw new Error(`Migration 107: foreign_key_check meldet ${fkErrors107.length} Verstoesse: ${JSON.stringify(fkErrors107.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 107').run();
    logger.info('DB-Migration auf Version 107 abgeschlossen (App-User-DB: app_users + user_invites + user_sessions_audit, users.email FK auf app_users).');
  }

  if (version < 108) {
    // app_settings als Runtime-Config-Store. Auth-/KI-Provider-/Storage-Backend-/Job-Tuning-/
    // Cron-/PDF-A-Werte wandern aus `.env` in die DB; ENV bleibt nur fuer
    // Boot-Layer (PORT, DB_PATH, APP_URL, SESSION_SECRET, ADMIN_EMAIL/PASSWORD,
    // TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN).
    //
    // `encrypted=1` markiert Felder mit AES-GCM-verschluesseltem value_json
    // (lib/crypto.js, `enc:v1:`-Prefix). lib/app-settings.js liest sie
    // transparent.
    //
    // app_settings_audit haelt Vor-/Nachwert-Hash + updated_by — kein
    // Klartext-Secret in der Audit-Tabelle.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        encrypted  INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_settings_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL,
        old_hash    TEXT,
        new_hash    TEXT,
        updated_by  TEXT NOT NULL,
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_app_settings_audit_key ON app_settings_audit(key, updated_at DESC)').run();

    const fkErrors108 = db.pragma('foreign_key_check');
    if (fkErrors108.length) {
      throw new Error(`Migration 108: foreign_key_check meldet ${fkErrors108.length} Verstoesse: ${JSON.stringify(fkErrors108.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 108').run();
    logger.info('DB-Migration auf Version 108 abgeschlossen (app_settings + app_settings_audit).');
  }

  if (version < 109) {
    // Book-ACL + Sharing.
    //
    // book_access ist SSoT fuer "wer darf was am Buch". Vier Rollen (Hierarchie
    // absteigend): owner > editor > lektor > viewer. Buchlisten + alle
    // book-scoped Routen filtern strikt darueber; Admin ohne Share-Row sieht
    // leeres Array. PK (book_id, user_email).
    //
    // book_share_invites speichert eingehende Sharing-Einladungen mit
    // accepted_at/revoked_at-Lifecycle (vorerst Auto-Accept; Hooks fuer
    // explizite Annahme bleiben).
    //
    // page_locks blockt waehrend einer Lektorat-Session konkurrierende
    // Free-Text-Edits auf derselben Seite (Heartbeat 30 min). Verhindert
    // Range-Drift in Findings-Positionen.
    //
    // book_settings.allow_lektor_book_chat: Opt-In pro Buch, ob Lektor den
    // Buch-Chat triggern darf (Default 0, Token-Kosten-Vermeidung).
    //
    // Backfill: jede books-Row mit owner_email != NULL bekommt einen owner-
    // Eintrag in book_access. BookStack-Permission-Discovery (Mehrfachzugriff
    // auf geteilte BookStack-Buecher) erfolgt separat ueber CLI bei Bedarf.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_access (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email)     ON DELETE CASCADE,
        role        TEXT    NOT NULL CHECK(role IN ('owner','editor','lektor','viewer')),
        granted_at  TEXT    DEFAULT (datetime('now')),
        granted_by  TEXT,
        PRIMARY KEY (book_id, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_access_user ON book_access(user_email)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_share_invites (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        invitee_email TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK(role IN ('editor','lektor','viewer')),
        invited_by    TEXT    NOT NULL,
        invited_at    TEXT    DEFAULT (datetime('now')),
        accepted_at   TEXT,
        revoked_at    TEXT,
        UNIQUE(book_id, invitee_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_share_invites_book ON book_share_invites(book_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_locks (
        page_id           INTEGER PRIMARY KEY REFERENCES pages(page_id)     ON DELETE CASCADE,
        book_id           INTEGER NOT NULL    REFERENCES books(book_id)     ON DELETE CASCADE,
        locked_by_email   TEXT    NOT NULL    REFERENCES app_users(email)   ON DELETE CASCADE,
        reason            TEXT    NOT NULL CHECK(reason IN ('lektorat')),
        acquired_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at        TEXT    NOT NULL,
        last_heartbeat_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_book    ON page_locks(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_user    ON page_locks(locked_by_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_expires ON page_locks(expires_at)').run();

    // book_settings.allow_lektor_book_chat (additiv).
    const bsCols109 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (bsCols109.length > 0 && !bsCols109.includes('allow_lektor_book_chat')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN allow_lektor_book_chat INTEGER NOT NULL DEFAULT 0').run();
    }

    // Owner-Backfill aus books.owner_email. Nur Bücher mit existierendem
    // app_users-Eintrag — sonst verletzt FK ON DELETE CASCADE. Bücher ohne
    // owner_email oder mit unbekannter Email bleiben im "herrenlos"-Zustand
    // (Admin-Hint sichtbar in BookAccessCard).
    const ownerInsert = db.prepare(`
      INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_by)
      SELECT b.book_id, b.owner_email, 'owner', 'migration-109'
        FROM books b
       WHERE b.owner_email IS NOT NULL
         AND b.owner_email <> ''
         AND EXISTS (SELECT 1 FROM app_users u WHERE u.email = b.owner_email)
    `);
    const ownerRows = ownerInsert.run().changes;
    if (ownerRows > 0) {
      logger.info(`Migration 109: ${ownerRows} Owner-Row(s) aus books.owner_email nach book_access gespiegelt.`);
    }

    const fkErrors109 = db.pragma('foreign_key_check');
    if (fkErrors109.length) {
      throw new Error(`Migration 109: foreign_key_check meldet ${fkErrors109.length} Verstoesse: ${JSON.stringify(fkErrors109.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 109').run();
    logger.info('DB-Migration auf Version 109 abgeschlossen (Book-ACL: book_access + book_share_invites + page_locks + book_settings.allow_lektor_book_chat).');
  }

  if (version < 110) {
    // Token-Budget pro User.
    //
    // monthly_budget_usd = NULL => kein numerisches Limit (nur sinnvoll mit
    //   mode != 'none').
    // budget_mode 'none' deaktiviert Pruefung komplett — Default fuer Neu-User,
    //   damit Bestandsdeployments nicht ploetzlich blocken. 'soft' warnt
    //   (Frontend-Banner + Admin-Markierung), 'hard' blockt Job-/Chat-POSTs
    //   mit HTTP 429 BUDGET_EXCEEDED.
    //
    // Cost wird zur Lese-Zeit aus (provider, model, tokens_*) via
    // lib/pricing.js#costUsd berechnet — keine Materialisierung in job_runs
    // /chat_messages, damit Preis-PRs rueckwirkend wirken.
    const appUserCols = db.pragma('table_info(app_users)').map(c => c.name);
    if (!appUserCols.includes('monthly_budget_usd')) {
      db.prepare('ALTER TABLE app_users ADD COLUMN monthly_budget_usd REAL').run();
    }
    if (!appUserCols.includes('budget_mode')) {
      db.prepare(`ALTER TABLE app_users ADD COLUMN budget_mode TEXT NOT NULL DEFAULT 'none'
                    CHECK(budget_mode IN ('none','soft','hard'))`).run();
    }

    // Audit-CHECK erweitern: 'budget-changed' (Admin setzt Limit/Mode),
    // 'usage-viewed' (Admin liest Usage-Dashboard — Privacy-Boundary-Nachweis).
    // SQLite kann CHECK nur via Table-Recreate aendern.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS user_sessions_audit_new').run();
    db.prepare(`
      CREATE TABLE user_sessions_audit_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated',
                        'role-changed','deleted','budget-changed','usage-viewed')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO user_sessions_audit_new (id, user_email, event, ip, user_agent, meta_json, created_at)
      SELECT id, user_email, event, ip, user_agent, meta_json, created_at FROM user_sessions_audit
    `).run();
    db.prepare('DROP TABLE user_sessions_audit').run();
    db.prepare('ALTER TABLE user_sessions_audit_new RENAME TO user_sessions_audit').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors110 = db.pragma('foreign_key_check');
    if (fkErrors110.length) {
      throw new Error(`Migration 110: foreign_key_check meldet ${fkErrors110.length} Verstoesse: ${JSON.stringify(fkErrors110.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 110').run();
    logger.info('DB-Migration auf Version 110 abgeschlossen (Token-Budget: app_users.monthly_budget_usd + budget_mode).');
  }

  if (version < 111) {
    // Public-Landing + Request-Register. Frische Besucher koennen Zugang anfordern; Admin
    // moderiert via AdminUsersCard. Partial UNIQUE blockiert nur pending-
    // Requests pro Email — abgelehnte / abgelaufene erlauben neuen Antrag.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS registration_requests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL,
        display_name  TEXT,
        message       TEXT,
        ip            TEXT,
        user_agent    TEXT,
        status        TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','approved','denied','expired')),
        created_at    TEXT    DEFAULT (datetime('now')),
        reviewed_at   TEXT,
        reviewed_by   TEXT,
        review_reason TEXT,
        invite_id     INTEGER,
        FOREIGN KEY (invite_id) REFERENCES user_invites(id) ON DELETE SET NULL
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reg_req_status ON registration_requests(status, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reg_req_invite_id ON registration_requests(invite_id)').run();
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reg_req_pending_email
        ON registration_requests(email)
        WHERE status = 'pending'
    `).run();

    const fkErrors111 = db.pragma('foreign_key_check');
    if (fkErrors111.length) {
      throw new Error(`Migration 111: foreign_key_check meldet ${fkErrors111.length} Verstoesse: ${JSON.stringify(fkErrors111.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 111').run();
    logger.info('DB-Migration auf Version 111 abgeschlossen (Public Landing + Request-Register: registration_requests).');
  }

  if (version < 112) {
    // Eigene Page-Revisions.
    // Jeder Save-Pfad ueber die content-store-Facade schreibt eine Revision
    // vor dem Backend-Write. source-Tag unterscheidet Editor/Focus/Chat-Apply
    // /Lektorat-Apply/Sync/Import/Conflict-Pfade. Retention: tiered GFS
    // (Tag/Woche/Monat/Jahr, aelteste pro Bucket) plus Floor aus
    // app.page_revision_limit (Default 50 juengste pro Seite) — Cleanup-Hook
    // in lib/cache-cleanup.js POLICIES → db/page-revisions.js#pruneTiered.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_revisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        body_markdown TEXT,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                          ('focus','main','chat-apply','lektorat-apply',
                           'bookstack-sync','import','conflict')),
        user_email    TEXT,
        created_at    TEXT DEFAULT (datetime('now')),
        summary       TEXT
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, created_at DESC)'
    ).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_page_revisions_book ON page_revisions(book_id, created_at DESC)'
    ).run();

    const fkErrors112 = db.pragma('foreign_key_check');
    if (fkErrors112.length) {
      throw new Error(`Migration 112: foreign_key_check meldet ${fkErrors112.length} Verstoesse: ${JSON.stringify(fkErrors112.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 112').run();
    logger.info('DB-Migration auf Version 112 abgeschlossen (page_revisions).');
  }

  if (version < 113) {
    // auth.allowed_emails entfernt: Zugriff wird ausschliesslich ueber
    // app_users (Invite/Approval/Status) gesteuert. Stale-Setting purgen.
    db.prepare("DELETE FROM app_settings WHERE key = 'auth.allowed_emails'").run();
    db.prepare('UPDATE schema_version SET version = 113').run();
    logger.info('DB-Migration auf Version 113 abgeschlossen (auth.allowed_emails entfernt).');
  }

  if (version < 114) {
    // Eigene Sortierung.
    // book_order ist SSoT fuer Buch-Hierarchie (Kapitel + Seiten, inkl.
    // Top-Level-Seiten). pages.position/chapters.position/pages.chapter_id
    // werden vom PUT-Hook aus order_json materialisiert (fuer Querys/JOINs).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_order (
        book_id    INTEGER PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
        order_json TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      )
    `).run();

    const fkErrors114 = db.pragma('foreign_key_check');
    if (fkErrors114.length) {
      throw new Error(`Migration 114: foreign_key_check meldet ${fkErrors114.length} Verstoesse: ${JSON.stringify(fkErrors114.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 114').run();
    logger.info('DB-Migration auf Version 114 abgeschlossen (book_order).');
  }

  if (version < 115) {
    // Kategorien + Tags.
    // book_categories: hierarchisch (parent_id), admin-verwaltet, global.
    // book_tags: flach, jeder Auth-User darf erzeugen, admin loescht.
    // book_tag_assignments: M:N-Bridge zwischen books und book_tags.
    // books.category_id: optional. SET NULL beim Loeschen einer Kategorie.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_categories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id   INTEGER REFERENCES book_categories(id) ON DELETE SET NULL,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        color       TEXT,
        position    INTEGER DEFAULT 0,
        created_by  TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_book_categories_parent ON book_categories(parent_id)'
    ).run();

    // books.category_id: ALTER TABLE ADD COLUMN unterstuetzt FK-Inline-Form
    // in SQLite. Bestandsrows behalten NULL.
    const bookCols115 = db.pragma('table_info(books)').map(c => c.name);
    if (!bookCols115.includes('category_id')) {
      db.prepare('ALTER TABLE books ADD COLUMN category_id INTEGER REFERENCES book_categories(id) ON DELETE SET NULL').run();
    }
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_books_category ON books(category_id)'
    ).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_tags (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        slug        TEXT NOT NULL UNIQUE,
        color       TEXT,
        created_by  TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_tag_assignments (
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        tag_id       INTEGER NOT NULL REFERENCES book_tags(id) ON DELETE CASCADE,
        assigned_at  TEXT DEFAULT (datetime('now')),
        assigned_by  TEXT,
        PRIMARY KEY (book_id, tag_id)
      )
    `).run();
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_bta_tag ON book_tag_assignments(tag_id)'
    ).run();

    const fkErrors115 = db.pragma('foreign_key_check');
    if (fkErrors115.length) {
      throw new Error(`Migration 115: foreign_key_check meldet ${fkErrors115.length} Verstoesse: ${JSON.stringify(fkErrors115.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 115').run();
    logger.info('DB-Migration auf Version 115 abgeschlossen (book_categories, book_tags, book_tag_assignments).');
  }

  if (version < 116) {
    // SQLite-FTS5-Volltextsuche.
    // search_index   – Haupt-Index (BM25, Titel 5x staerker als Body), Unicode61
    //                  mit remove_diacritics=2 (Umlaut-Folding DE+EN), tokenchars
    //                  '-_' fuer Bindestrich-Woerter.
    // search_trigram – Titel-only Trigram-Index (Typo-Toleranz, Single-Word-Fallback).
    // search_meta    – key/value-Store fuer last_optimize/last_reindex/reindex_required.
    // Initialer Reindex: Marker `reindex_required=1` setzen, server.js startet
    // searchIndex.reindexIfNeeded() in setImmediate nach dem Boot.
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        lang UNINDEXED,
        title,
        body,
        tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
      )
    `).run();
    db.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_trigram USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        title,
        tokenize="trigram"
      )
    `).run();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS search_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(
      `INSERT OR REPLACE INTO search_meta (key, value, updated_at) VALUES ('reindex_required', '1', datetime('now'))`
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO search_meta (key, value) VALUES ('last_optimize', NULL)`
    ).run();

    const fkErrors116 = db.pragma('foreign_key_check');
    if (fkErrors116.length) {
      throw new Error(`Migration 116: foreign_key_check meldet ${fkErrors116.length} Verstoesse: ${JSON.stringify(fkErrors116.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 116').run();
    logger.info('DB-Migration auf Version 116 abgeschlossen (FTS5 search_index + search_trigram + search_meta).');
  }

  if (version < 117) {
    // Per-User-AI-Provider-Override.
    // 1) app_users.ai_provider_override (NULL = follows global ai.provider).
    // 2) provider-Spalte in alle 7 KI-Caches. Verhindert, dass Claude-Output an
    //    Ollama-User ausgeliefert wird (oder umgekehrt). Teil des PRIMARY KEY.
    // Backfill: bestehende Cache-Eintraege bekommen den aktuellen Globalwert
    //   `ai.provider` aus app_settings.
    const auCols117 = db.pragma('table_info(app_users)').map(c => c.name);
    if (!auCols117.includes('ai_provider_override')) {
      db.prepare(`
        ALTER TABLE app_users ADD COLUMN ai_provider_override TEXT
          CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL)
      `).run();
    }

    let defaultProvider117 = 'claude';
    try {
      const row = db.prepare("SELECT value_json FROM app_settings WHERE key = 'ai.provider'").get();
      if (row && row.value_json) {
        const parsed = JSON.parse(row.value_json);
        if (typeof parsed === 'string' && ['claude','ollama','llama'].includes(parsed)) {
          defaultProvider117 = parsed;
        }
      }
    } catch { /* leave default */ }

    db.pragma('foreign_keys = OFF');

    const recreate117 = (table, createSql, copySql, indexSql) => {
      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.prepare(createSql).run();
      db.prepare(copySql).run(defaultProvider117);
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      if (indexSql) db.prepare(indexSql).run();
    };

    recreate117(
      'chapter_extract_cache',
      `CREATE TABLE chapter_extract_cache_new (
         book_id      INTEGER NOT NULL,
         user_email   TEXT    NOT NULL DEFAULT '',
         chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         phase        TEXT    NOT NULL DEFAULT '',
         provider     TEXT    NOT NULL DEFAULT '',
         pages_sig    TEXT    NOT NULL,
         extract_json TEXT    NOT NULL,
         cached_at    TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, phase, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_extract_cache_new
         (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
       SELECT book_id, user_email, chapter_id, phase, ?, pages_sig, extract_json, cached_at
         FROM chapter_extract_cache`,
      null,
    );

    recreate117(
      'book_extract_cache',
      `CREATE TABLE book_extract_cache_new (
         book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email   TEXT    NOT NULL DEFAULT '',
         provider     TEXT    NOT NULL DEFAULT '',
         pages_sig    TEXT    NOT NULL,
         extract_json TEXT    NOT NULL,
         cached_at    TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, provider)
       )`,
      `INSERT OR REPLACE INTO book_extract_cache_new
         (book_id, user_email, provider, pages_sig, extract_json, cached_at)
       SELECT book_id, user_email, ?, pages_sig, extract_json, cached_at
         FROM book_extract_cache`,
      null,
    );

    recreate117(
      'chapter_review_cache',
      `CREATE TABLE chapter_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         phase       TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, phase, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_review_cache_new
         (book_id, user_email, chapter_id, phase, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, chapter_id, phase, ?, pages_sig, review_json, cached_at
         FROM chapter_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_crc_book_user ON chapter_review_cache(book_id, user_email)`,
    );

    recreate117(
      'book_review_cache',
      `CREATE TABLE book_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, provider)
       )`,
      `INSERT OR REPLACE INTO book_review_cache_new
         (book_id, user_email, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, ?, pages_sig, review_json, cached_at
         FROM book_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_brc_book_user ON book_review_cache(book_id, user_email)`,
    );

    recreate117(
      'chapter_macro_review_cache',
      `CREATE TABLE chapter_macro_review_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
         provider    TEXT    NOT NULL DEFAULT '',
         pages_sig   TEXT    NOT NULL,
         review_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, chapter_id, provider)
       )`,
      `INSERT OR REPLACE INTO chapter_macro_review_cache_new
         (book_id, user_email, chapter_id, provider, pages_sig, review_json, cached_at)
       SELECT book_id, user_email, chapter_id, ?, pages_sig, review_json, cached_at
         FROM chapter_macro_review_cache`,
      `CREATE INDEX IF NOT EXISTS idx_cmrc_book_user ON chapter_macro_review_cache(book_id, user_email)`,
    );

    recreate117(
      'synonym_cache',
      `CREATE TABLE synonym_cache_new (
         user_email  TEXT    NOT NULL DEFAULT '',
         provider    TEXT    NOT NULL DEFAULT '',
         key_hash    TEXT    NOT NULL,
         result_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (user_email, provider, key_hash)
       )`,
      `INSERT OR REPLACE INTO synonym_cache_new
         (user_email, provider, key_hash, result_json, cached_at)
       SELECT user_email, ?, key_hash, result_json, cached_at
         FROM synonym_cache`,
      `CREATE INDEX IF NOT EXISTS idx_sc_user ON synonym_cache(user_email)`,
    );

    recreate117(
      'lektorat_cache',
      `CREATE TABLE lektorat_cache_new (
         book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
         user_email  TEXT    NOT NULL DEFAULT '',
         page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
         provider    TEXT    NOT NULL DEFAULT '',
         ctx_sig     TEXT    NOT NULL,
         result_json TEXT    NOT NULL,
         cached_at   TEXT    NOT NULL,
         PRIMARY KEY (book_id, user_email, page_id, provider)
       )`,
      `INSERT OR REPLACE INTO lektorat_cache_new
         (book_id, user_email, page_id, provider, ctx_sig, result_json, cached_at)
       SELECT book_id, user_email, page_id, ?, ctx_sig, result_json, cached_at
         FROM lektorat_cache`,
      `CREATE INDEX IF NOT EXISTS idx_lc_book_user ON lektorat_cache(book_id, user_email)`,
    );

    db.pragma('foreign_keys = ON');
    const fkErrors117 = db.pragma('foreign_key_check');
    if (fkErrors117.length) {
      throw new Error(`Migration 117: foreign_key_check meldet ${fkErrors117.length} Verstoesse: ${JSON.stringify(fkErrors117.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 117').run();
    logger.info(`DB-Migration auf Version 117 abgeschlossen (ai_provider_override + provider-Spalte in 7 KI-Caches; Backfill auf '${defaultProvider117}').`);
  }

  if (version < 118) {
    // Backfill setzte books.owner_email aber legte
    // keine book_access-Row an. Migration 109 spiegelte einmalig die damals
    // existenten Owner; alle danach via Backfill angelegten Buecher fielen
    // durch — /content/books filtert strikt ueber book_access und liefert
    // leere Liste. Mirror erneut ausfuehren (idempotent, INSERT OR IGNORE).
    const ownerInsert118 = db.prepare(`
      INSERT OR IGNORE INTO book_access (book_id, user_email, role, granted_by)
      SELECT b.book_id, b.owner_email, 'owner', 'migration-118'
        FROM books b
       WHERE b.owner_email IS NOT NULL
         AND b.owner_email <> ''
         AND EXISTS (SELECT 1 FROM app_users u WHERE u.email = b.owner_email)
    `);
    const ownerRows118 = ownerInsert118.run().changes;
    if (ownerRows118 > 0) {
      logger.info(`Migration 118: ${ownerRows118} Owner-Row(s) aus books.owner_email nach book_access nachgespiegelt.`);
    }

    const fkErrors118 = db.pragma('foreign_key_check');
    if (fkErrors118.length) {
      throw new Error(`Migration 118: foreign_key_check meldet ${fkErrors118.length} Verstoesse: ${JSON.stringify(fkErrors118.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 118').run();
    logger.info('DB-Migration auf Version 118 abgeschlossen (Re-Mirror books.owner_email -> book_access fuer Backfill-Buecher).');
  }

  if (version < 119) {
    // 'ai-provider-changed' im user_sessions_audit-Event-CHECK aufnehmen.
    // Migration 110 hatte 'budget-changed' + 'usage-viewed' ergaenzt; hier
    // kommt der naechste Eintrag fuer Override-Aenderungen via AdminUsersCard.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS user_sessions_audit_new').run();
    db.prepare(`
      CREATE TABLE user_sessions_audit_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT NOT NULL,
        event      TEXT NOT NULL CHECK(event IN
                       ('login','logout','login-denied','suspended','reactivated',
                        'role-changed','deleted','budget-changed','usage-viewed',
                        'ai-provider-changed')),
        ip         TEXT,
        user_agent TEXT,
        meta_json  TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO user_sessions_audit_new (id, user_email, event, ip, user_agent, meta_json, created_at)
      SELECT id, user_email, event, ip, user_agent, meta_json, created_at FROM user_sessions_audit
    `).run();
    db.prepare('DROP TABLE user_sessions_audit').run();
    db.prepare('ALTER TABLE user_sessions_audit_new RENAME TO user_sessions_audit').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_audit_user ON user_sessions_audit(user_email, created_at DESC)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors119 = db.pragma('foreign_key_check');
    if (fkErrors119.length) {
      throw new Error(`Migration 119: foreign_key_check meldet ${fkErrors119.length} Verstoesse: ${JSON.stringify(fkErrors119.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 119').run();
    logger.info(`DB-Migration auf Version 119 abgeschlossen (audit-Event 'ai-provider-changed').`);
  }

  if (version < 120) {
    // BookStack-Backend entfernt — Cleanup:
    // 1. user_tokens-Tabelle droppen (BookStack-API-Tokens pro User).
    // 2. pages.remote_updated_at + pages.dirty droppen (Sync-Conflict-Detection).
    // 3. page_revisions.source-CHECK ohne 'bookstack-sync' neu setzen.
    // 4. app_settings: app.backend + app.migrate.source_readonly + app.bookstack.base_url loeschen.
    db.pragma('foreign_keys = OFF');

    db.prepare('DROP TABLE IF EXISTS user_tokens').run();

    // pages: Spalten remote_updated_at + dirty entfernen via Recreate.
    const pagesCols = db.pragma('table_info(pages)').map(c => c.name);
    if (pagesCols.includes('remote_updated_at') || pagesCols.includes('dirty')) {
      db.prepare('DROP INDEX IF EXISTS idx_pages_dirty').run();
      db.prepare('DROP TABLE IF EXISTS pages_new').run();
      db.prepare(`
        CREATE TABLE pages_new (
          page_id        INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id        INTEGER NOT NULL,
          page_name      TEXT,
          chapter_id     INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
          updated_at     TEXT,
          preview_text   TEXT,
          last_seen_at   TEXT,
          body_html      TEXT,
          body_markdown  TEXT,
          position       INTEGER,
          priority       INTEGER,
          slug           TEXT,
          local_updated_at TEXT
        )
      `).run();
      db.prepare(`
        INSERT INTO pages_new (page_id, book_id, page_name, chapter_id, updated_at, last_seen_at,
                               preview_text, body_html, body_markdown, position, priority, slug, local_updated_at)
        SELECT page_id, book_id, page_name, chapter_id, updated_at, last_seen_at,
               preview_text, body_html, body_markdown, position, priority, slug, local_updated_at
        FROM pages
      `).run();
      db.prepare('DROP TABLE pages').run();
      db.prepare('ALTER TABLE pages_new RENAME TO pages').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id ON pages(book_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)').run();
      // Wasserzeichen wiederherstellen: AUTOINCREMENT-Counter min. 1_000_000,
      // damit neue localdb-IDs >= 1_000_001 vergeben werden (Phase-0-Garantie).
      const existing = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pages'").get();
      if (existing) {
        if (existing.seq < 1000000) {
          db.prepare("UPDATE sqlite_sequence SET seq = 1000000 WHERE name = 'pages'").run();
        }
      } else {
        db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('pages', 1000000)").run();
      }
    }

    // page_revisions: CHECK-Constraint ohne 'bookstack-sync' setzen.
    const prCols = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (prCols.length > 0) {
      db.prepare('DROP TABLE IF EXISTS page_revisions_new').run();
      db.prepare(`
        CREATE TABLE page_revisions_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
          book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
          body_html     TEXT NOT NULL,
          body_markdown TEXT,
          chars         INTEGER,
          words         INTEGER,
          tok           INTEGER,
          source        TEXT NOT NULL CHECK(source IN
                          ('focus','main','chat-apply','lektorat-apply','import','conflict')),
          user_email    TEXT,
          summary       TEXT,
          created_at    TEXT DEFAULT (datetime('now'))
        )
      `).run();
      // 'bookstack-sync' auf 'import' mappen (semantisch naechstes Aequivalent).
      db.prepare(`
        INSERT INTO page_revisions_new (id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at)
        SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok,
               CASE source WHEN 'bookstack-sync' THEN 'import' ELSE source END,
               user_email, summary, created_at
        FROM page_revisions
      `).run();
      db.prepare('DROP TABLE page_revisions').run();
      db.prepare('ALTER TABLE page_revisions_new RENAME TO page_revisions').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_page ON page_revisions(page_id, created_at DESC)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_book ON page_revisions(book_id, created_at DESC)').run();
    }

    // BookStack-spezifische app_settings entfernen.
    db.prepare(`DELETE FROM app_settings WHERE key IN ('app.backend','app.migrate.source_readonly','app.bookstack.base_url')`).run();

    db.pragma('foreign_keys = ON');

    const fkErrors120 = db.pragma('foreign_key_check');
    if (fkErrors120.length) {
      throw new Error(`Migration 120: foreign_key_check meldet ${fkErrors120.length} Verstoesse: ${JSON.stringify(fkErrors120.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 120').run();
    logger.info('DB-Migration auf Version 120 abgeschlossen (BookStack-Backend entfernt).');
  }

  if (version < 121) {
    // Fix: Migration 120 (initial) hatte chars/words/tok in page_revisions
    // versehentlich nicht mit-recreatet. Nachruesten via ALTER ADD COLUMN.
    const prCols = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (!prCols.includes('chars')) db.prepare('ALTER TABLE page_revisions ADD COLUMN chars INTEGER').run();
    if (!prCols.includes('words')) db.prepare('ALTER TABLE page_revisions ADD COLUMN words INTEGER').run();
    if (!prCols.includes('tok'))   db.prepare('ALTER TABLE page_revisions ADD COLUMN tok INTEGER').run();
    db.prepare('UPDATE schema_version SET version = 121').run();
    logger.info('DB-Migration auf Version 121 abgeschlossen (page_revisions chars/words/tok nachgeruestet).');
  }

  if (version < 122) {
    // Ideen pro Kapitel: chapter_id FK + XOR-CHECK (entweder page_id oder
    // chapter_id, nicht beides/keins). Recreate-Pattern, weil SQLite weder
    // FK noch CHECK via ALTER nachruestet.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS ideen_new').run();
    db.prepare(`
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_id     INTEGER          REFERENCES pages(page_id)       ON DELETE SET NULL,
        chapter_id  INTEGER          REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        user_email  TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        erledigt    INTEGER NOT NULL DEFAULT 0,
        erledigt_at TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        CHECK ((page_id IS NOT NULL AND chapter_id IS NULL)
            OR (page_id IS NULL AND chapter_id IS NOT NULL))
      )
    `).run();
    db.prepare(`
      INSERT INTO ideen_new (id, book_id, page_id, chapter_id, user_email, content,
                             erledigt, erledigt_at, created_at, updated_at)
      SELECT id, book_id, page_id, NULL, user_email, content,
             erledigt, erledigt_at, created_at, updated_at
      FROM ideen
      WHERE page_id IS NOT NULL
    `).run();
    db.prepare('DROP TABLE ideen').run();
    db.prepare('ALTER TABLE ideen_new RENAME TO ideen').run();
    db.prepare('CREATE INDEX idx_ideen_page_user    ON ideen(page_id, user_email)').run();
    db.prepare('CREATE INDEX idx_ideen_chapter_user ON ideen(chapter_id, user_email)').run();
    db.prepare('CREATE INDEX idx_ideen_book_user    ON ideen(book_id, user_email)').run();
    db.pragma('foreign_keys = ON');

    const fkErrors122 = db.pragma('foreign_key_check');
    if (fkErrors122.length) {
      throw new Error(`Migration 122: foreign_key_check meldet ${fkErrors122.length} Verstoesse: ${JSON.stringify(fkErrors122.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 122').run();
    logger.info('DB-Migration auf Version 122 abgeschlossen (ideen.chapter_id FK + XOR-CHECK).');
  }

  if (version < 123) {
    // pages.last_editor_email: Wer hat zuletzt diese Seite geschrieben.
    // Quelle fuer Tree-/Toast-Hinweise „andere User hat editiert" sowie fuer
    // den /content/books/:id/changes-Endpoint (Phase 3). Nullable, kein FK
    // auf app_users (Display-Truth lebt in page_revisions; Email reicht als
    // Anzeige-Hint, Drop eines Users soll den Save-Pfad nicht brechen).
    const pagesCols123 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pagesCols123.includes('last_editor_email')) {
      db.prepare('ALTER TABLE pages ADD COLUMN last_editor_email TEXT').run();
    }
    // Backfill aus juengster page_revisions-Row (best effort).
    db.prepare(`
      UPDATE pages
         SET last_editor_email = (
           SELECT user_email FROM page_revisions r
            WHERE r.page_id = pages.page_id
              AND r.user_email IS NOT NULL
            ORDER BY r.created_at DESC LIMIT 1
         )
       WHERE last_editor_email IS NULL
    `).run();

    const fkErrors123 = db.pragma('foreign_key_check');
    if (fkErrors123.length) {
      throw new Error(`Migration 123: foreign_key_check meldet ${fkErrors123.length} Verstoesse: ${JSON.stringify(fkErrors123.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 123').run();
    logger.info('DB-Migration auf Version 123 abgeschlossen (pages.last_editor_email).');
  }

  if (version < 124) {
    // budget_alerts: Dedup-Tabelle fuer Budget-Overrun-Mails. Pro
    // (email, period='YYYY-MM') hoechstens ein Eintrag => Mail wird exakt einmal
    // pro Monat verschickt. ON DELETE CASCADE: geloeschter User raeumt seine
    // Alerts gleich mit.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS budget_alerts (
        email   TEXT NOT NULL,
        period  TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (email, period),
        FOREIGN KEY (email) REFERENCES app_users(email) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_budget_alerts_period ON budget_alerts(period)').run();

    const fkErrors124 = db.pragma('foreign_key_check');
    if (fkErrors124.length) {
      throw new Error(`Migration 124: foreign_key_check meldet ${fkErrors124.length} Verstoesse: ${JSON.stringify(fkErrors124.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 124').run();
    logger.info('DB-Migration auf Version 124 abgeschlossen (budget_alerts).');
  }

  if (version < 125) {
    // page_presence: Live-Heartbeat fuer „X editiert gerade Seite Y".
    // Client pingt waehrend Edit-Mode alle 30s; Server filtert Stale-Eintraege
    // (>90s) bei jedem List-Read. Pure Ephemeral-Tabelle, kein Audit-Wert.
    // CASCADE auf pages/app_users: geloeschte Seite/User raeumt die Pings mit.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_presence (
        page_id     INTEGER NOT NULL REFERENCES pages(page_id)    ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email)  ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        last_ping_at TEXT   NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (page_id, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_book ON page_presence(book_id, last_ping_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_ping ON page_presence(last_ping_at)').run();

    const fkErrors125 = db.pragma('foreign_key_check');
    if (fkErrors125.length) {
      throw new Error(`Migration 125: foreign_key_check meldet ${fkErrors125.length} Verstoesse: ${JSON.stringify(fkErrors125.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 125').run();
    logger.info('DB-Migration auf Version 125 abgeschlossen (page_presence).');
  }

  if (version < 126) {
    // page_locks.reason: 'edit' als zweiter Reason-Wert. Soft-Lock fuer den
    // Free-Edit-Pfad (startEdit acquired ihn, anderer User sieht „X editiert
    // bis HH:MM"). 'lektorat' bleibt Hard-Lock (blockt PUT mit 423); 'edit'
    // wird beim PUT als advisory behandelt (kein 423, nur UI-Signal).
    // CHECK-Constraint erweitert via Table-Recreate (SQLite-Pflicht).
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS page_locks_new').run();
    db.prepare(`
      CREATE TABLE page_locks_new (
        page_id           INTEGER PRIMARY KEY REFERENCES pages(page_id)     ON DELETE CASCADE,
        book_id           INTEGER NOT NULL    REFERENCES books(book_id)     ON DELETE CASCADE,
        locked_by_email   TEXT    NOT NULL    REFERENCES app_users(email)   ON DELETE CASCADE,
        reason            TEXT    NOT NULL CHECK(reason IN ('lektorat','edit')),
        acquired_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at        TEXT    NOT NULL,
        last_heartbeat_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO page_locks_new (page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at)
      SELECT page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at
        FROM page_locks
    `).run();
    db.prepare('DROP TABLE page_locks').run();
    db.prepare('ALTER TABLE page_locks_new RENAME TO page_locks').run();
    db.pragma('foreign_keys = ON');

    const fkErrors126 = db.pragma('foreign_key_check');
    if (fkErrors126.length) {
      throw new Error(`Migration 126: foreign_key_check meldet ${fkErrors126.length} Verstoesse: ${JSON.stringify(fkErrors126.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 126').run();
    logger.info('DB-Migration auf Version 126 abgeschlossen (page_locks.reason+edit).');
  }

  if (version < 127) {
    // Musikbibliothek: songs/song_figures/song_chapters/song_scenes, parallel
    // zu locations. songs hält Titel + Interpret + Genre + kontext_typ
    // (hört/spielt/erwähnt/leitmotiv/diegetisch). UNIQUE(book_id, song_uid,
    // user_email) erlaubt UPSERT-Pattern aus saveSongsToDb.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS songs (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                  INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        song_uid                 TEXT    NOT NULL,
        titel                    TEXT    NOT NULL,
        interpret                TEXT,
        genre                    TEXT,
        kontext_typ              TEXT,
        beschreibung             TEXT,
        stimmung                 TEXT,
        erste_erwaehnung         TEXT,
        erste_erwaehnung_page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        sort_order               INTEGER DEFAULT 0,
        user_email               TEXT,
        updated_at               TEXT NOT NULL,
        UNIQUE(book_id, song_uid, user_email)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_songs_book_id ON songs(book_id, user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_songs_erste_page ON songs(erste_erwaehnung_page_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_figures (
        song_id     INTEGER NOT NULL REFERENCES songs(id)    ON DELETE CASCADE,
        figure_id   INTEGER NOT NULL REFERENCES figures(id)  ON DELETE CASCADE,
        kontext_typ TEXT,
        PRIMARY KEY (song_id, figure_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sf_figure ON song_figures(figure_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_chapters (
        song_id     INTEGER NOT NULL REFERENCES songs(id)             ON DELETE CASCADE,
        chapter_id  INTEGER NOT NULL REFERENCES chapters(chapter_id)  ON DELETE CASCADE,
        haeufigkeit INTEGER DEFAULT 1,
        PRIMARY KEY (song_id, chapter_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sc_chapter_id ON song_chapters(chapter_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS song_scenes (
        scene_id INTEGER NOT NULL REFERENCES figure_scenes(id) ON DELETE CASCADE,
        song_id  INTEGER NOT NULL REFERENCES songs(id)         ON DELETE CASCADE,
        PRIMARY KEY (scene_id, song_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_song_scenes_song ON song_scenes(song_id)').run();

    const fkErrors127 = db.pragma('foreign_key_check');
    if (fkErrors127.length) {
      throw new Error(`Migration 127: foreign_key_check meldet ${fkErrors127.length} Verstoesse: ${JSON.stringify(fkErrors127.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 127').run();
    logger.info('DB-Migration auf Version 127 abgeschlossen (songs, song_figures, song_chapters, song_scenes).');
  }

  if (version < 128) {
    // page_locks-Recreate in Migration 126 hat die Indexe (idx_page_locks_book,
    // idx_page_locks_user, idx_page_locks_expires) verloren — SQLite verwirft
    // Indexe beim DROP TABLE. Neu anlegen, damit FK-Lookups (book_id,
    // locked_by_email) und Expire-Sweeps wieder einen Index haben.
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_book    ON page_locks(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_user    ON page_locks(locked_by_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_locks_expires ON page_locks(expires_at)').run();

    const fkErrors128 = db.pragma('foreign_key_check');
    if (fkErrors128.length) {
      throw new Error(`Migration 128: foreign_key_check meldet ${fkErrors128.length} Verstoesse: ${JSON.stringify(fkErrors128.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 128').run();
    logger.info('DB-Migration auf Version 128 abgeschlossen (page_locks-Indexe wiederhergestellt).');
  }

  if (version < 129) {
    // users-Tabelle in app_users einfalten. Beide hielten parallel Profil-/Identitaets-
    // daten — users diente nur als Settings-Satellit (locale/theme/focus_granularity/
    // daily_goal_chars/default_*) mit FK app_users(email) CASCADE. Spalten wandern
    // nach app_users, users wird gedropt.
    const auCols = db.pragma('table_info(app_users)').map(c => c.name);
    const addCol = (name, decl) => {
      if (!auCols.includes(name)) db.exec(`ALTER TABLE app_users ADD COLUMN ${name} ${decl}`);
    };
    addCol('last_login_at',     'TEXT');
    addCol('theme',             'TEXT');
    addCol('default_buchtyp',   'TEXT');
    addCol('default_language',  'TEXT');
    addCol('default_region',    'TEXT');
    addCol('focus_granularity', 'TEXT');
    addCol('daily_goal_chars',  'INTEGER');

    const usersExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'"
    ).get();
    if (usersExists) {
      db.exec(`
        UPDATE app_users
           SET last_login_at     = (SELECT u.last_login_at     FROM users u WHERE u.email = app_users.email),
               theme             = (SELECT u.theme             FROM users u WHERE u.email = app_users.email),
               default_buchtyp   = (SELECT u.default_buchtyp   FROM users u WHERE u.email = app_users.email),
               default_language  = (SELECT u.default_language  FROM users u WHERE u.email = app_users.email),
               default_region    = (SELECT u.default_region    FROM users u WHERE u.email = app_users.email),
               focus_granularity = (SELECT u.focus_granularity FROM users u WHERE u.email = app_users.email),
               daily_goal_chars  = (SELECT u.daily_goal_chars  FROM users u WHERE u.email = app_users.email)
         WHERE email IN (SELECT email FROM users);
      `);
      db.exec(`
        UPDATE app_users
           SET language = (SELECT u.locale FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (SELECT 1 FROM users u WHERE u.email = app_users.email AND u.locale IS NOT NULL);
      `);
      db.exec(`
        UPDATE app_users
           SET display_name = (SELECT u.name FROM users u WHERE u.email = app_users.email)
         WHERE display_name IS NULL
           AND EXISTS (SELECT 1 FROM users u WHERE u.email = app_users.email AND u.name IS NOT NULL);
      `);
      db.exec(`
        UPDATE app_users
           SET last_seen_at = (SELECT u.last_seen_at FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.email = app_users.email
              AND u.last_seen_at IS NOT NULL
              AND (app_users.last_seen_at IS NULL OR u.last_seen_at > app_users.last_seen_at)
         );
      `);
      db.exec(`
        UPDATE app_users
           SET created_at = (SELECT u.created_at FROM users u WHERE u.email = app_users.email)
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.email = app_users.email
              AND u.created_at IS NOT NULL
              AND (app_users.created_at IS NULL OR u.created_at < app_users.created_at)
         );
      `);
      db.exec('DROP TABLE users');
    }

    const fkErrors129 = db.pragma('foreign_key_check');
    if (fkErrors129.length) {
      throw new Error(`Migration 129: foreign_key_check meldet ${fkErrors129.length} Verstoesse: ${JSON.stringify(fkErrors129.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 129').run();
    logger.info('DB-Migration auf Version 129 abgeschlossen (users in app_users konsolidiert, DROP users).');
  }

  if (version < 130) {
    // FK-Hardening: 33 Tabellen mit `user_email` bekommen einen FK auf
    // app_users(email). Strategie pro Tabelle:
    //   - CASCADE: Caches/Logs/User-spezifische Daten, deren Wert ohne User wegfaellt.
    //   - SET NULL: inhaltliche Daten (Figuren, Orte, Songs, ...), die als anonyme
    //     Spur erhalten bleiben sollen. Voraussetzung: user_email-Spalte nullable.
    //
    // Vorab-Cleanup: Rows mit user_email='' oder unbekannter Email werden
    // bereinigt — CASCADE-Tabellen geloescht, SET-NULL-Tabellen genullt — damit
    // der spaetere foreign_key_check sauber durchgeht.

    db.pragma('foreign_keys = OFF');

    const CASCADE_TABLES = [
      'book_extract_cache', 'book_review_cache', 'chapter_extract_cache',
      'chapter_macro_review_cache', 'chapter_review_cache', 'chat_sessions',
      'draft_figures', 'finetune_ai_cache', 'ideen', 'job_checkpoints',
      'lektorat_cache', 'lektorat_time', 'pdf_export_profile', 'synonym_cache',
      'user_activity', 'user_feature_usage', 'user_page_usage',
      'werkstatt_runs', 'writing_time', 'zeitstrahl_events',
    ];
    // user_sessions_audit absichtlich ausgenommen: enthaelt auch Events vor
    // User-Existenz (login-denied, role-changed bei Approval-Vorgaengen) und
    // braucht daher keinen FK auf app_users(email). Anonymisierung beim
    // User-Loeschen geschieht ueber softDeleteUser-Workflow, nicht via CASCADE.
    const SET_NULL_TABLES = [
      'book_reviews', 'chapter_reviews', 'continuity_checks', 'continuity_issues',
      'figure_relations', 'figure_scenes', 'figures', 'job_runs', 'locations',
      'page_checks', 'page_revisions', 'songs',
    ];

    let cleanupDeleted = 0;
    for (const t of CASCADE_TABLES) {
      const r = db.prepare(
        `DELETE FROM ${t} WHERE user_email = '' OR user_email IS NULL OR user_email NOT IN (SELECT email FROM app_users)`
      ).run();
      cleanupDeleted += r.changes;
    }
    let cleanupNulled = 0;
    for (const t of SET_NULL_TABLES) {
      const r = db.prepare(
        `UPDATE ${t} SET user_email = NULL WHERE user_email = '' OR (user_email IS NOT NULL AND user_email NOT IN (SELECT email FROM app_users))`
      ).run();
      cleanupNulled += r.changes;
    }
    if (cleanupDeleted || cleanupNulled) {
      logger.info(`Mig 130 Pre-Cleanup: ${cleanupDeleted} Orphan-Rows geloescht, ${cleanupNulled} user_email genullt.`);
    }

    // Dynamischer Recreate-Helper: zieht das aktuelle CREATE TABLE aus
    // sqlite_master, haengt die FK-Klausel an, recreated die Tabelle mit
    // Datenkopie + Index-Wiederherstellung.
    const _addUserFk = (table, onDelete) => {
      const orig = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table);
      if (!orig || !orig.sql) {
        throw new Error(`Migration 130: Tabelle ${table} nicht gefunden`);
      }
      const indexes = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table);

      // CREATE TABLE "<name>" → CREATE TABLE <name>_new
      const nameRe = new RegExp('CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?' + table + '"?', 'i');
      let newSql = orig.sql.replace(nameRe, 'CREATE TABLE ' + table + '_new');

      // FK-Klausel vor schliessender ) einhaengen.
      const fkClause = `,\n        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE ${onDelete}\n      `;
      const lastParen = newSql.lastIndexOf(')');
      if (lastParen < 0) throw new Error(`Migration 130: kein ) in CREATE fuer ${table}`);
      newSql = newSql.slice(0, lastParen) + fkClause + newSql.slice(lastParen);

      db.prepare(`DROP TABLE IF EXISTS ${table}_new`).run();
      db.exec(newSql);
      db.prepare(`INSERT INTO ${table}_new SELECT * FROM ${table}`).run();
      db.prepare(`DROP TABLE ${table}`).run();
      db.prepare(`ALTER TABLE ${table}_new RENAME TO ${table}`).run();
      for (const ix of indexes) db.exec(ix.sql);
    };

    for (const t of CASCADE_TABLES) _addUserFk(t, 'CASCADE');
    for (const t of SET_NULL_TABLES) _addUserFk(t, 'SET NULL');

    // Index auf jede FK-Spalte (Pflicht laut CLAUDE.md: jede FK-Spalte hat Index).
    // Ausgenommen: Tabellen, deren PRIMARY KEY user_email als ERSTES Feld
    // fuehrt — der PK-Index deckt user_email-Lookups bereits ab. Composite-
    // PKs, die mit book_id (o.ae.) starten, decken user_email NICHT ab und
    // brauchen einen eigenen Index.
    const PK_LEADS_WITH_USER_EMAIL = new Set([
      'user_activity', 'user_feature_usage', 'user_page_usage', 'synonym_cache',
    ]);
    const NEEDS_USER_INDEX = [...CASCADE_TABLES, ...SET_NULL_TABLES]
      .filter(t => !PK_LEADS_WITH_USER_EMAIL.has(t));
    for (const t of NEEDS_USER_INDEX) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_user_email ON ${t}(user_email)`);
    }

    db.pragma('foreign_keys = ON');

    const fkErrors130 = db.pragma('foreign_key_check');
    if (fkErrors130.length) {
      throw new Error(`Migration 130: foreign_key_check meldet ${fkErrors130.length} Verstoesse: ${JSON.stringify(fkErrors130.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 130').run();
    logger.info(`DB-Migration auf Version 130 abgeschlossen (FK-Hardening: ${CASCADE_TABLES.length} CASCADE + ${SET_NULL_TABLES.length} SET NULL Tabellen auf app_users(email)).`);
  }

  if (version < 131) {
    // Rename app_setting key cron.timezone -> app.timezone. Setting deckt jetzt
    // Cron, Server-Datums-Buckets (lib/local-date.js) und Frontend-Display-
    // Formatter ab (GUI-Zeit muss zur Server-Zeit passen, unabhaengig vom
    // Browser-Standort des Users).
    const oldRow = db.prepare("SELECT value_json, encrypted, updated_by FROM app_settings WHERE key = 'cron.timezone'").get();
    const hasNew = db.prepare("SELECT 1 FROM app_settings WHERE key = 'app.timezone'").get();
    if (oldRow && !hasNew) {
      db.prepare(`
        INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
        VALUES ('app.timezone', @value_json, @encrypted, datetime('now'), @updated_by)
      `).run({ value_json: oldRow.value_json, encrypted: oldRow.encrypted, updated_by: oldRow.updated_by || 'migration-131' });
    }
    db.prepare("DELETE FROM app_settings WHERE key = 'cron.timezone'").run();

    const fkErrors131 = db.pragma('foreign_key_check');
    if (fkErrors131.length) {
      throw new Error(`Migration 131: foreign_key_check meldet ${fkErrors131.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 131').run();
    logger.info('DB-Migration auf Version 131 abgeschlossen (rename cron.timezone -> app.timezone).');
  }

  if (version < 132) {
    // Composite-Index fuer /history/page-ages/:book_id (cross-user). Bestehender
    // (book_id, user_email)-Index taugt nur als Left-Prefix fuer WHERE book_id=?,
    // zwingt SQLite aber bei ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY
    // checked_at DESC) zum Extra-Sort. (book_id, page_id, checked_at DESC)
    // deckt Filter + PARTITION BY + ORDER BY ab.
    db.exec('CREATE INDEX IF NOT EXISTS idx_pc_book_page_date ON page_checks(book_id, page_id, checked_at DESC)');

    const fkErrors132 = db.pragma('foreign_key_check');
    if (fkErrors132.length) {
      throw new Error(`Migration 132: foreign_key_check meldet ${fkErrors132.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 132').run();
    logger.info('DB-Migration auf Version 132 abgeschlossen (Index idx_pc_book_page_date fuer page-ages-Query).');
  }

  if (version < 133) {
    // SQLite-`datetime('now')` liefert "YYYY-MM-DD HH:MM:SS" (UTC ohne TZ-Marker).
    // JS `new Date("...")` parsed das als lokale Browser-Zeit statt UTC; das UI
    // zeigt dann die UTC-Uhr unter app.timezone-Label (CEST: 2 h zu frueh).
    // Code-Pfade schreiben jetzt ISO+Z via `NOW_ISO_SQL` (db/now.js). Backfill
    // alle Spalten, die von Default oder Inline-`datetime('now')` gefuellt
    // wurden: GLOB matched genau die "YYYY-MM-DD HH:MM:SS"-Form,
    // `strftime('%Y-%m-%dT%H:%M:%fZ', value)` parst die als UTC und liefert
    // die ISO+Z-Form.
    const tsCols = [
      ['app_settings', 'updated_at'],
      ['app_settings_audit', 'updated_at'],
      ['app_users', 'created_at'],
      ['app_users', 'first_seen_at'],
      ['app_users', 'last_seen_at'],
      ['app_users', 'last_login_at'],
      ['app_users', 'invited_at'],
      ['book_access', 'granted_at'],
      ['book_categories', 'created_at'],
      ['book_order', 'updated_at'],
      ['book_share_invites', 'invited_at'],
      ['book_share_invites', 'accepted_at'],
      ['book_share_invites', 'revoked_at'],
      ['book_tag_assignments', 'assigned_at'],
      ['book_tags', 'created_at'],
      ['budget_alerts', 'sent_at'],
      ['page_locks', 'acquired_at'],
      ['page_locks', 'last_heartbeat_at'],
      ['page_presence', 'last_ping_at'],
      ['page_revisions', 'created_at'],
      ['registration_requests', 'created_at'],
      ['registration_requests', 'reviewed_at'],
      ['search_meta', 'updated_at'],
      ['user_invites', 'invited_at'],
      ['user_invites', 'accepted_at'],
      ['user_invites', 'revoked_at'],
      ['user_sessions_audit', 'created_at'],
    ];
    for (const [tbl, col] of tsCols) {
      db.prepare(
        `UPDATE ${tbl}
            SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col})
          WHERE ${col} IS NOT NULL
            AND ${col} GLOB '????-??-?? ??:??:??'`
      ).run();
    }

    const fkErrors133 = db.pragma('foreign_key_check');
    if (fkErrors133.length) {
      throw new Error(`Migration 133: foreign_key_check meldet ${fkErrors133.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 133').run();
    logger.info('DB-Migration auf Version 133 abgeschlossen (Timestamp-Backfill UTC-no-Z -> ISO+Z).');
  }

  if (version < 134) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS blog_connections (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
        base_url               TEXT    NOT NULL,
        username               TEXT    NOT NULL,
        password_enc           BLOB    NOT NULL,
        default_status         TEXT    NOT NULL DEFAULT 'draft' CHECK(default_status IN ('draft','publish','private')),
        initial_import_done_at TEXT,
        last_pull_at           TEXT,
        last_push_at           TEXT,
        created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS blog_page_links (
        page_id         INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        blog_id         INTEGER NOT NULL    REFERENCES blog_connections(id) ON DELETE CASCADE,
        wp_post_id      INTEGER NOT NULL,
        wp_modified_at  TEXT    NOT NULL,
        wp_status       TEXT,
        wp_slug         TEXT,
        last_pulled_at  TEXT,
        last_pushed_at  TEXT,
        conflict_state  TEXT    CHECK(conflict_state IN ('detected','resolved-app','resolved-wp')),
        UNIQUE(blog_id, wp_post_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_blog_page_links_blog ON blog_page_links(blog_id)').run();

    const fkErrors134 = db.pragma('foreign_key_check');
    if (fkErrors134.length) {
      throw new Error(`Migration 134: foreign_key_check meldet ${fkErrors134.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 134').run();
    logger.info('DB-Migration auf Version 134 abgeschlossen (blog_connections + blog_page_links).');
  }

  if (version < 135) {
    const chaptersCols135 = db.pragma('table_info(chapters)').map(c => c.name);
    if (!chaptersCols135.includes('parent_chapter_id')) {
      db.prepare('ALTER TABLE chapters ADD COLUMN parent_chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_chapter_id)').run();

    const fkErrors135 = db.pragma('foreign_key_check');
    if (fkErrors135.length) {
      throw new Error(`Migration 135: foreign_key_check meldet ${fkErrors135.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 135').run();
    logger.info('DB-Migration auf Version 135 abgeschlossen (chapters.parent_chapter_id fuer Hierarchie).');
  }

  if (version < 136) {
    // Tagesziel wandert vom User-Profil aufs Buch. Pro-Buch-Konfiguration
    // passt besser, weil ein Autor mehrere Bücher parallel betreut und das
    // Zielvolumen pro Projekt unterschiedlich ist.
    const bsCols136 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols136.includes('daily_goal_chars')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN daily_goal_chars INTEGER').run();
    }
    // Backfill: existierende book_settings-Zeilen erben den daily_goal_chars
    // ihres Buch-Owners (best effort). NULL bleibt NULL — Frontend fällt auf
    // 1500 zurück (eine Normseite).
    db.prepare(`
      UPDATE book_settings
         SET daily_goal_chars = (
           SELECT au.daily_goal_chars
             FROM books b
             JOIN app_users au ON au.email = b.owner_email
            WHERE b.book_id = book_settings.book_id
              AND au.daily_goal_chars IS NOT NULL
         )
       WHERE daily_goal_chars IS NULL
    `).run();

    // app_users.daily_goal_chars entfällt (Recreate-Pattern).
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS app_users_new');
    db.exec(`
      CREATE TABLE app_users_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        email            TEXT NOT NULL UNIQUE,
        display_name     TEXT,
        avatar_url       TEXT,
        global_role      TEXT NOT NULL DEFAULT 'user'
                              CHECK(global_role IN ('admin','user')),
        status           TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('invited','active','suspended','deleted')),
        language         TEXT DEFAULT 'de',
        model_override   TEXT,
        can_invite_users INTEGER NOT NULL DEFAULT 1,
        first_seen_at    TEXT,
        last_seen_at     TEXT,
        invited_by       TEXT,
        invited_at       TEXT,
        created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        monthly_budget_usd REAL,
        budget_mode      TEXT NOT NULL DEFAULT 'none'
                              CHECK(budget_mode IN ('none','soft','hard')),
        ai_provider_override TEXT
                              CHECK(ai_provider_override IN ('claude','ollama','llama') OR ai_provider_override IS NULL),
        last_login_at    TEXT,
        theme            TEXT,
        default_buchtyp  TEXT,
        default_language TEXT,
        default_region   TEXT,
        focus_granularity TEXT
      )
    `);
    db.exec(`
      INSERT INTO app_users_new (id, email, display_name, avatar_url, global_role, status,
                                 language, model_override, can_invite_users, first_seen_at,
                                 last_seen_at, invited_by, invited_at, created_at,
                                 monthly_budget_usd, budget_mode, ai_provider_override,
                                 last_login_at, theme, default_buchtyp, default_language,
                                 default_region, focus_granularity)
      SELECT id, email, display_name, avatar_url, global_role, status,
             language, model_override, can_invite_users, first_seen_at,
             last_seen_at, invited_by, invited_at, created_at,
             monthly_budget_usd, budget_mode, ai_provider_override,
             last_login_at, theme, default_buchtyp, default_language,
             default_region, focus_granularity
        FROM app_users
    `);
    db.exec('DROP TABLE app_users');
    db.exec('ALTER TABLE app_users_new RENAME TO app_users');
    db.pragma('foreign_keys = ON');

    const fkErrors136 = db.pragma('foreign_key_check');
    if (fkErrors136.length) {
      throw new Error(`Migration 136: foreign_key_check meldet ${fkErrors136.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 136').run();
    logger.info('DB-Migration auf Version 136 abgeschlossen (Tagesziel pro Buch: book_settings.daily_goal_chars hinzugefuegt, app_users.daily_goal_chars entfernt).');
  }

  if (version < 137) {
    db.exec(`
      DROP INDEX IF EXISTS idx_bta_tag;
      DROP TABLE IF EXISTS book_tag_assignments;
      DROP TABLE IF EXISTS book_tags;
    `);
    const fkErrors137 = db.pragma('foreign_key_check');
    if (fkErrors137.length) {
      throw new Error(`Migration 137: foreign_key_check meldet ${fkErrors137.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 137').run();
    logger.info('DB-Migration auf Version 137 abgeschlossen (Tags-Feature entfernt: book_tags + book_tag_assignments gedroppt).');
  }

  if (version < 138) {
    // Stilkorrektur-Feature entfernt: page_checks.stilkorrektur_log war seit Mig 66
    // angelegt, aber nie vom Frontend befuellt (Spalte immer NULL). Recreate-Pattern,
    // weil SQLite DROP COLUMN nicht zuverlaessig FK-Constraints beibehaelt.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS page_checks_new');
    db.exec(
      'CREATE TABLE page_checks_new (' +
      '  id                   INTEGER PRIMARY KEY AUTOINCREMENT,' +
      '  page_id              INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,' +
      '  book_id              INTEGER REFERENCES books(book_id) ON DELETE SET NULL,' +
      '  checked_at           TEXT NOT NULL,' +
      '  error_count          INTEGER DEFAULT 0,' +
      '  errors_json          TEXT,' +
      '  stilanalyse          TEXT,' +
      '  fazit                TEXT,' +
      '  model                TEXT,' +
      '  saved                INTEGER DEFAULT 0,' +
      '  saved_at             TEXT,' +
      '  applied_errors_json  TEXT,' +
      '  user_email           TEXT REFERENCES app_users(email) ON DELETE SET NULL,' +
      '  selected_errors_json TEXT,' +
      '  szenen_json          TEXT,' +
      '  chapter_id           INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL' +
      ')'
    );
    db.exec(
      'INSERT INTO page_checks_new (' +
      '  id, page_id, book_id, checked_at, error_count, errors_json,' +
      '  stilanalyse, fazit, model, saved, saved_at, applied_errors_json,' +
      '  user_email, selected_errors_json, szenen_json, chapter_id' +
      ') SELECT' +
      '  id, page_id, book_id, checked_at, error_count, errors_json,' +
      '  stilanalyse, fazit, model, saved, saved_at, applied_errors_json,' +
      '  user_email, selected_errors_json, szenen_json, chapter_id' +
      ' FROM page_checks'
    );
    db.exec('DROP TABLE page_checks');
    db.exec('ALTER TABLE page_checks_new RENAME TO page_checks');
    db.exec('CREATE INDEX idx_pc_book_page_date  ON page_checks(book_id, page_id, checked_at DESC)');
    db.exec('CREATE INDEX idx_pc_book_user       ON page_checks(book_id, user_email)');
    db.exec('CREATE INDEX idx_pc_page_user_date  ON page_checks(page_id, user_email, checked_at DESC)');
    db.exec('CREATE INDEX idx_page_checks_user_email ON page_checks(user_email)');
    db.pragma('foreign_keys = ON');
    const fkErrors138 = db.pragma('foreign_key_check');
    if (fkErrors138.length) {
      throw new Error(`Migration 138: foreign_key_check meldet ${fkErrors138.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 138').run();
    logger.info('DB-Migration auf Version 138 abgeschlossen (page_checks.stilkorrektur_log entfernt — Feature nie aktiv).');
  }

  if (version < 139) {
    // page_revisions.source-CHECK erweitern um 'book' (Bucheditor-Saves).
    // JS-VALID_SOURCES kennt 'book' seit Bucheditor-Einfuehrung, CHECK nicht →
    // Inserts liefen still in CHECK-Verletzung und wurden im content-store
    // weggeloggt; Bucheditor-Edits erzeugten 0 Revisionen.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS page_revisions_new').run();
    db.prepare(`
      CREATE TABLE page_revisions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        body_markdown TEXT,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                        ('focus','main','book','chat-apply','lektorat-apply','import','conflict')),
        user_email    TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        summary       TEXT,
        created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO page_revisions_new (id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at)
      SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at
        FROM page_revisions
    `).run();
    db.prepare('DROP TABLE page_revisions').run();
    db.prepare('ALTER TABLE page_revisions_new RENAME TO page_revisions').run();
    db.prepare('CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC)').run();
    db.prepare('CREATE INDEX idx_page_revisions_book ON page_revisions(book_id, created_at DESC)').run();
    db.pragma('foreign_keys = ON');
    const fkErrors139 = db.pragma('foreign_key_check');
    if (fkErrors139.length) {
      throw new Error(`Migration 139: foreign_key_check meldet ${fkErrors139.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 139').run();
    logger.info("DB-Migration auf Version 139 abgeschlossen (page_revisions.source-CHECK um 'book' erweitert).");
  }

  if (version < 140) {
    // Index auf page_revisions.user_email — FK auf app_users.email lief bisher
    // ohne Index. Reverse-Lookup "alle Revisionen von User X" und FK-Integrity-
    // Checks beim Löschen eines Users (ON DELETE SET NULL) scannen sonst die
    // gesamte Tabelle.
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_user ON page_revisions(user_email)').run();
    const fkErrors140 = db.pragma('foreign_key_check');
    if (fkErrors140.length) {
      throw new Error(`Migration 140: foreign_key_check meldet ${fkErrors140.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 140').run();
    logger.info('DB-Migration auf Version 140 abgeschlossen (idx_page_revisions_user).');
  }

  if (version < 141) {
    // LanguageTool-Cache pro Page + User-Custom-Dictionary (Phase-2-Features).
    // page_languagetool_cache: PK = (page_id, content_hash, lang, picky) --
    // mehrere Eintraege pro Page moeglich (Sprachwechsel, Picky-Toggle). FK
    // CASCADE; Cache-Eintrag fuer geloeschte Page macht keinen Sinn.
    // user_dictionary: User-spezifisches Woerterbuch. book_id=0 = global,
    // sonst pro Buch. lang='*' = alle Sprachen, sonst LT-Locale-Tag.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS page_languagetool_cache (
        page_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        lang TEXT NOT NULL,
        picky INTEGER NOT NULL DEFAULT 0,
        matches_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (page_id, content_hash, lang, picky),
        FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_lt_cache_created ON page_languagetool_cache(created_at)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS user_dictionary (
        user_email TEXT NOT NULL,
        book_id INTEGER NOT NULL DEFAULT 0,
        word TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT '*',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (user_email, book_id, word, lang),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_dictionary_user ON user_dictionary(user_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_user_dictionary_book ON user_dictionary(book_id)').run();

    const fkErrors141 = db.pragma('foreign_key_check');
    if (fkErrors141.length) {
      throw new Error(`Migration 141: foreign_key_check meldet ${fkErrors141.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 141').run();
    logger.info('DB-Migration auf Version 141 abgeschlossen (page_languagetool_cache, user_dictionary).');
  }

  if (version < 142) {
    // user_dictionary.lang='auto' normalisieren auf '*': 'auto' war kein
    // gueltiger LT-Locale-Tag — Lookup `lang='*' OR lang=:current` matched
    // bei Page-Locale 'de-CH' nie. Eintraege waren tote Daten + UI-Display
    // zeigte sinnlose "Nur dieses Buch: auto"-Zeile.
    db.prepare("UPDATE OR IGNORE user_dictionary SET lang='*' WHERE lang='auto'").run();
    db.prepare("DELETE FROM user_dictionary WHERE lang='auto'").run();
    const fkErrors142 = db.pragma('foreign_key_check');
    if (fkErrors142.length) {
      throw new Error(`Migration 142: foreign_key_check meldet ${fkErrors142.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 142').run();
    logger.info('DB-Migration auf Version 142 abgeschlossen (user_dictionary.lang auto -> *).');
  }

  if (version < 143) {
    // page_languagetool_cache einmalig leeren: Vor Migration 142 wurden
    // user_dictionary-Eintraege mit lang='auto' gespeichert; der LT-Filter-
    // Lookup matchte nie und schrieb unfiltered Matches in den Cache. Diese
    // Rows leben weiter, bis ihr content_hash invalidiert wird. Pauschaler
    // Wipe erzwingt frische, korrekt gefilterte Caches.
    const cleared = db.prepare('DELETE FROM page_languagetool_cache').run();
    const fkErrors143 = db.pragma('foreign_key_check');
    if (fkErrors143.length) {
      throw new Error(`Migration 143: foreign_key_check meldet ${fkErrors143.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 143').run();
    logger.info(`DB-Migration auf Version 143 abgeschlossen (page_languagetool_cache geleert, ${cleared.changes} Rows).`);
  }

  if (version < 144) {
    // Invite-Click- und Reminder-Tracking. Admin-Tab "Eingeladene Benutzer"
    // sieht so, ob der User den Link geoeffnet hat und kann Erinnerungen senden.
    const uiCols = db.pragma('table_info(user_invites)').map(c => c.name);
    if (!uiCols.includes('last_clicked_at')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN last_clicked_at TEXT').run();
    }
    if (!uiCols.includes('click_count')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!uiCols.includes('last_reminder_at')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN last_reminder_at TEXT').run();
    }
    if (!uiCols.includes('reminder_count')) {
      db.prepare('ALTER TABLE user_invites ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0').run();
    }
    const fkErrors144 = db.pragma('foreign_key_check');
    if (fkErrors144.length) {
      throw new Error(`Migration 144: foreign_key_check meldet ${fkErrors144.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 144').run();
    logger.info('DB-Migration auf Version 144 abgeschlossen (user_invites: Click+Reminder-Tracking).');
  }

  if (version < 145) {
    // Share-Links: opaque Tokens, mit denen Owner einzelne Seiten oder
    // Kapitel an externe Reader ohne Account verschicken kann. CHECK-Constraint
    // erzwingt, dass je nach `kind` genau eine der Spalten page_id/chapter_id
    // gesetzt ist. owner_last_seen_at trackt Unread-Kommentare in der Owner-UI.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS share_links (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('page','chapter')),
        page_id INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        owner_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        intro TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        view_count INTEGER NOT NULL DEFAULT 0,
        owner_last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind='page' AND page_id IS NOT NULL AND chapter_id IS NULL) OR
          (kind='chapter' AND chapter_id IS NOT NULL AND page_id IS NULL)
        )
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_book ON share_links(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_page ON share_links(page_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_links_chapter ON share_links(chapter_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS share_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
        reader_name TEXT,
        body TEXT NOT NULL,
        ip_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_share_comments_token ON share_comments(share_token)').run();

    const fkErrors145 = db.pragma('foreign_key_check');
    if (fkErrors145.length) {
      throw new Error(`Migration 145: foreign_key_check meldet ${fkErrors145.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 145').run();
    logger.info('DB-Migration auf Version 145 abgeschlossen (share_links, share_comments).');
  }

  if (version < 146) {
    // api_tokens: Bearer-Tokens fuer externe Metrics-Scraper (Prometheus/HA/Grafana).
    // Plain-Token wird nur einmal beim Create zurueckgegeben; in der DB lebt nur der
    // SHA-256-Hash. scopes als kommaseparierte Liste (aktuell nur 'metrics:read').
    db.prepare(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_email   TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        token_hash    TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        scopes        TEXT NOT NULL DEFAULT 'metrics:read',
        last_used_at  TEXT,
        last_used_ip  TEXT,
        expires_at    TEXT,
        revoked_at    TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_api_tokens_admin ON api_tokens(admin_email)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)').run();

    const fkErrors146 = db.pragma('foreign_key_check');
    if (fkErrors146.length) {
      throw new Error(`Migration 146: foreign_key_check meldet ${fkErrors146.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 146').run();
    logger.info('DB-Migration auf Version 146 abgeschlossen (api_tokens fuer Prometheus-Scraper).');
  }

  if (version < 147) {
    // HubSpot-Sync: pro Buch eine Connection (Token verschluesselt via lib/crypto.js,
    // Blog-ID + Author-ID als Fix-Wahl beim Connect). Pro gepushter Page ein Link auf
    // den HubSpot-Post. Push erstellt ausschliesslich DRAFTs; Re-Push ist UI- und
    // Backend-blockiert (Existenz des Links).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS hubspot_connections (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
        token_enc              BLOB NOT NULL,
        blog_id                TEXT NOT NULL,
        author_id              TEXT NOT NULL,
        initial_import_done_at TEXT,
        last_import_at         TEXT,
        last_push_at           TEXT,
        created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hubspot_conn_book ON hubspot_connections(book_id)').run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS hubspot_page_links (
        page_id            INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        hub_id             INTEGER NOT NULL REFERENCES hubspot_connections(id) ON DELETE CASCADE,
        hubspot_post_id    TEXT NOT NULL,
        hubspot_state      TEXT,
        hubspot_created_at TEXT,
        last_pushed_at     TEXT,
        UNIQUE(hub_id, hubspot_post_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hubspot_links_hub ON hubspot_page_links(hub_id)').run();

    const fkErrors147 = db.pragma('foreign_key_check');
    if (fkErrors147.length) {
      throw new Error(`Migration 147: foreign_key_check meldet ${fkErrors147.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 147').run();
    logger.info('DB-Migration auf Version 147 abgeschlossen (hubspot_connections + hubspot_page_links).');
  }

  if (version < 148) {
    // Multi-Device-Presence: jedes Geraet (Browser/localStorage-UUID) bekommt
    // einen eigenen Heartbeat-Slot. PK auf page_presence wird um device_id
    // erweitert. Neue Tabelle app_users_devices haelt Label + UA pro Device
    // (Schema bereit fuer kuenftige Settings-UI).
    db.pragma('foreign_keys = OFF');

    db.prepare(`
      CREATE TABLE IF NOT EXISTS app_users_devices (
        device_id     TEXT PRIMARY KEY,
        user_email    TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        label         TEXT,
        user_agent    TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_app_users_devices_user ON app_users_devices(user_email)').run();

    // page_presence: PK auf (page_id, user_email, device_id) erweitern.
    // Recreate-Pattern. Alte Rows haben keinen device_id — Drop akzeptiert
    // (90s-Stale-Filter laufen sie eh aus, kein Audit-Wert).
    db.prepare('DROP TABLE IF EXISTS page_presence_new').run();
    db.prepare(`
      CREATE TABLE page_presence_new (
        page_id      INTEGER NOT NULL REFERENCES pages(page_id)            ON DELETE CASCADE,
        user_email   TEXT    NOT NULL REFERENCES app_users(email)          ON DELETE CASCADE,
        device_id    TEXT    NOT NULL REFERENCES app_users_devices(device_id) ON DELETE CASCADE,
        book_id      INTEGER NOT NULL REFERENCES books(book_id)            ON DELETE CASCADE,
        last_ping_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (page_id, user_email, device_id)
      )
    `).run();
    // Alte Rows ohne device_id absichtlich nicht kopieren — neue Pings
    // legen frische Eintraege binnen 30s wieder an.
    db.prepare('DROP TABLE page_presence').run();
    db.prepare('ALTER TABLE page_presence_new RENAME TO page_presence').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_book ON page_presence(book_id, last_ping_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_presence_ping ON page_presence(last_ping_at)').run();

    db.pragma('foreign_keys = ON');

    const fkErrors148 = db.pragma('foreign_key_check');
    if (fkErrors148.length) {
      throw new Error(`Migration 148: foreign_key_check meldet ${fkErrors148.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 148').run();
    logger.info('DB-Migration auf Version 148 abgeschlossen (app_users_devices + page_presence Multi-Device-PK).');
  }

  if (version < 149) {
    // HubSpot: absolute Post-URL aus createPost-Response persistieren, damit
    // der Editor-Header einen "In HubSpot oeffnen"-Link anbieten kann (analog
    // WordPress-Blog-Sync). Bestehende Links bleiben ohne URL, neuer Push und
    // Initial-Import fuellen das Feld.
    const hubLinksCols = db.pragma('table_info(hubspot_page_links)').map(c => c.name);
    if (!hubLinksCols.includes('hubspot_url')) {
      db.prepare('ALTER TABLE hubspot_page_links ADD COLUMN hubspot_url TEXT').run();
    }

    const fkErrors149 = db.pragma('foreign_key_check');
    if (fkErrors149.length) {
      throw new Error(`Migration 149: foreign_key_check meldet ${fkErrors149.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 149').run();
    logger.info('DB-Migration auf Version 149 abgeschlossen (hubspot_page_links.hubspot_url).');
  }

  if (version < 150) {
    // HubSpot: portalId aus /account-info/v3/details persistieren. Wird beim
    // Connect via me() ermittelt; ermoeglicht das Bauen der Editor-URL fuer
    // Drafts (https://app.hubspot.com/blog/<portalId>/editor/<postId>/content).
    // Bestehende Connections haben NULL bis zum naechsten Connect/Re-Save.
    const hubConnCols = db.pragma('table_info(hubspot_connections)').map(c => c.name);
    if (!hubConnCols.includes('portal_id')) {
      db.prepare('ALTER TABLE hubspot_connections ADD COLUMN portal_id TEXT').run();
    }

    const fkErrors150 = db.pragma('foreign_key_check');
    if (fkErrors150.length) {
      throw new Error(`Migration 150: foreign_key_check meldet ${fkErrors150.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 150').run();
    logger.info('DB-Migration auf Version 150 abgeschlossen (hubspot_connections.portal_id).');
  }

  if (version < 151) {
    // pages.book_id wird FK auf books(book_id) ON DELETE CASCADE. Vorher fehlte
    // die Constraint komplett — geloeschte Buecher hinterliessen orphan-pages,
    // deren last_seen_at einfror, weil _syncAllBooksInner ueber `books` iteriert
    // und sie nie touched. Startup-Stale-Cleanup (pruneStaleByAge) loescht solche
    // Rows dann massenhaft, sobald 7 Tage abgelaufen sind.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup: orphan-pages entfernen (book_id zeigt auf nicht existierendes
    // Buch). Sonst kippt foreign_key_check am Ende. page_stats / page_revisions /
    // figure_events.page_id etc. haengen via FK CASCADE/SET NULL bereits dran.
    const orphanCount = db.prepare(
      'SELECT COUNT(*) AS n FROM pages WHERE book_id NOT IN (SELECT book_id FROM books)'
    ).get().n;
    if (orphanCount > 0) {
      db.prepare('DELETE FROM pages WHERE book_id NOT IN (SELECT book_id FROM books)').run();
      logger.info(`Migration 151: ${orphanCount} orphan-pages vorab entfernt (book_id ohne books-Row).`);
    }

    db.prepare('DROP TABLE IF EXISTS pages_new').run();
    db.prepare(`
      CREATE TABLE pages_new (
        page_id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_name         TEXT,
        chapter_id        INTEGER          REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        updated_at        TEXT,
        preview_text      TEXT,
        last_seen_at      TEXT,
        body_html         TEXT,
        body_markdown     TEXT,
        position          INTEGER,
        priority          INTEGER,
        slug              TEXT,
        local_updated_at  TEXT,
        last_editor_email TEXT
      )
    `).run();
    db.prepare(`
      INSERT INTO pages_new (page_id, book_id, page_name, chapter_id, updated_at,
                             preview_text, last_seen_at, body_html, body_markdown,
                             position, priority, slug, local_updated_at, last_editor_email)
      SELECT page_id, book_id, page_name, chapter_id, updated_at,
             preview_text, last_seen_at, body_html, body_markdown,
             position, priority, slug, local_updated_at, last_editor_email
        FROM pages
    `).run();
    db.prepare('DROP TABLE pages').run();
    db.prepare('ALTER TABLE pages_new RENAME TO pages').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id    ON pages(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_chapter_id ON pages(chapter_id)').run();

    // Wasserzeichen wiederherstellen (Phase-0-Garantie aus Mig 122):
    // AUTOINCREMENT-Counter min. 1_000_000, damit neue localdb-IDs >= 1_000_001 sind.
    const existing151 = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pages'").get();
    if (existing151) {
      if (existing151.seq < 1000000) {
        db.prepare("UPDATE sqlite_sequence SET seq = 1000000 WHERE name = 'pages'").run();
      }
    } else {
      db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('pages', 1000000)").run();
    }

    db.pragma('foreign_keys = ON');

    const fkErrors151 = db.pragma('foreign_key_check');
    if (fkErrors151.length) {
      throw new Error(`Migration 151: foreign_key_check meldet ${fkErrors151.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 151').run();
    logger.info('DB-Migration auf Version 151 abgeschlossen (pages.book_id FK auf books CASCADE).');
  }

  if (version < 152) {
    // user_dictionary.book_id wird nullable FK auf books(book_id) ON DELETE
    // CASCADE. Vorher: lose INTEGER-Spalte mit Sentinel book_id=0 (= user-global)
    // und keiner Constraint -> geloeschte Buecher hinterliessen orphan-Eintraege.
    // Neu: NULL = user-global, book_id > 0 cascadet bei Buchloeschung.
    db.pragma('foreign_keys = OFF');

    // Orphan-Diagnose vor dem Copy: book_id zeigt auf geloeschtes Buch (Sentinel
    // 0 ausgenommen). Solche Rows werden NICHT mitkopiert -- nicht zu NULL machen,
    // sonst wuerden sie faelschlich zu user-globalen Woertern. Genau der Muell,
    // den die FK kuenftig verhindert.
    const dictOrphans = db.prepare(
      'SELECT COUNT(*) AS n FROM user_dictionary WHERE book_id != 0 AND book_id NOT IN (SELECT book_id FROM books)'
    ).get().n;
    if (dictOrphans > 0) {
      logger.info(`Migration 152: ${dictOrphans} orphan-Dictionary-Eintraege werden verworfen (book_id ohne books-Row).`);
    }

    db.prepare('DROP TABLE IF EXISTS user_dictionary_new').run();
    db.prepare(`
      CREATE TABLE user_dictionary_new (
        user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id    INTEGER REFERENCES books(book_id) ON DELETE CASCADE,
        word       TEXT NOT NULL,
        lang       TEXT NOT NULL DEFAULT '*',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    // Sentinel 0 -> NULL waehrend des Copy (alte Spalte ist NOT NULL, NULL erst
    // in der neuen nullable Spalte moeglich). Orphans (book_id != 0 ohne books-Row)
    // fallen via WHERE raus.
    db.prepare(`
      INSERT INTO user_dictionary_new (user_email, book_id, word, lang, created_at)
      SELECT user_email,
             CASE WHEN book_id = 0 THEN NULL ELSE book_id END,
             word, lang, created_at
        FROM user_dictionary
       WHERE book_id = 0 OR book_id IN (SELECT book_id FROM books)
    `).run();
    db.prepare('DROP TABLE user_dictionary').run();
    db.prepare('ALTER TABLE user_dictionary_new RENAME TO user_dictionary').run();

    // Dedup-Constraint via partielle Unique-Indexe statt PK: NULL in einem
    // PK-Bestandteil gilt in SQLite als distinct -> wuerde doppelte user-globale
    // Eintraege zulassen. Zwei Teil-Indexe decken global (book_id IS NULL) und
    // buch-scoped (book_id IS NOT NULL) sauber ab.
    db.prepare(`
      CREATE UNIQUE INDEX idx_user_dictionary_global
        ON user_dictionary(user_email, word, lang) WHERE book_id IS NULL
    `).run();
    db.prepare(`
      CREATE UNIQUE INDEX idx_user_dictionary_scoped
        ON user_dictionary(user_email, book_id, word, lang) WHERE book_id IS NOT NULL
    `).run();
    db.prepare('CREATE INDEX idx_user_dictionary_user ON user_dictionary(user_email)').run();
    db.prepare('CREATE INDEX idx_user_dictionary_book ON user_dictionary(book_id)').run();

    db.pragma('foreign_keys = ON');

    const fkErrors152 = db.pragma('foreign_key_check');
    if (fkErrors152.length) {
      throw new Error(`Migration 152: foreign_key_check meldet ${fkErrors152.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 152').run();
    logger.info('DB-Migration auf Version 152 abgeschlossen (user_dictionary.book_id nullable FK auf books CASCADE).');
  }

  if (version < 153) {
    // Block-Level-Merge-Telemetrie: globale, kumulierte Counter (lifetime),
    // gescraped via /metrics. Name-gekeyt, keine Entity-Refs -> kein FK noetig.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS merge_telemetry (
        name       TEXT PRIMARY KEY,
        value      INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();

    const fkErrors153 = db.pragma('foreign_key_check');
    if (fkErrors153.length) {
      throw new Error(`Migration 153: foreign_key_check meldet ${fkErrors153.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 153').run();
    logger.info('DB-Migration auf Version 153 abgeschlossen (merge_telemetry-Counter-Tabelle).');
  }

  if (version < 154) {
    // Book-Level-Presence: leichter Heartbeat pro Geraet, sobald ein Buch offen
    // ist (nicht nur im Edit-Mode wie page_presence). Dient als Bootstrap fuer
    // die Multi-Device-Erkennung: zeigt book_presence >1 eigenes Geraet, startet
    // der Client den teuren 5s-Collab-Poll auch fuer Einzel-Owner-Buecher —
    // sonst sieht der User sein eigenes Zweit-Geraet nie. Ephemeral wie
    // page_presence (90s-Stale-Filter beim Read, kein Aufraeum-Cron).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS book_presence (
        book_id      INTEGER NOT NULL REFERENCES books(book_id)               ON DELETE CASCADE,
        user_email   TEXT    NOT NULL REFERENCES app_users(email)             ON DELETE CASCADE,
        device_id    TEXT    NOT NULL REFERENCES app_users_devices(device_id) ON DELETE CASCADE,
        last_ping_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, device_id)
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_presence_book ON book_presence(book_id, last_ping_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_presence_ping ON book_presence(last_ping_at)').run();

    const fkErrors154 = db.pragma('foreign_key_check');
    if (fkErrors154.length) {
      throw new Error(`Migration 154: foreign_key_check meldet ${fkErrors154.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 154').run();
    logger.info('DB-Migration auf Version 154 abgeschlossen (book_presence fuer Multi-Device-Erkennung).');
  }

  if (version < 155) {
    // Presence page-scoped: jedes Geraet meldet zusaetzlich die aktuell offene
    // Seite. So startet der teure 5s-Collab-Poll nur, wenn DIESELBE Seite auf
    // mehreren eigenen Geraeten offen ist — nicht schon bei irgendeinem
    // Zweit-Geraet am selben Buch (zwei Geraete auf verschiedenen Seiten haben
    // keinen Seitenkonflikt). page_id nullable (Geraet kann ohne offene Seite am
    // Buch sein, z.B. Buch-Overview); ON DELETE SET NULL (Geraet bleibt praesent,
    // nur seine Seite verschwand).
    const bpCols = db.pragma('table_info(book_presence)').map(c => c.name);
    if (!bpCols.includes('page_id')) {
      db.prepare('ALTER TABLE book_presence ADD COLUMN page_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL').run();
    }
    db.prepare('CREATE INDEX IF NOT EXISTS idx_book_presence_page ON book_presence(page_id, user_email, last_ping_at DESC)').run();

    const fkErrors155 = db.pragma('foreign_key_check');
    if (fkErrors155.length) {
      throw new Error(`Migration 155: foreign_key_check meldet ${fkErrors155.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 155').run();
    logger.info('DB-Migration auf Version 155 abgeschlossen (book_presence.page_id, page-scoped Presence).');
  }

  if (version < 156) {
    // Ereignisse-Ausbau Phase 1: strukturierte Datum-Felder + Subtyp + Storylines.
    //   - Neue Tabelle `storylines` (Plot-Stränge) — UNIQUE(book_id, name).
    //   - `zeitstrahl_events` + `figure_events` bekommen:
    //       * datum_year/month/day  (Punkt-Datum strukturiert)
    //       * datum_ende_year/month/day  (Spannen-Ende)
    //       * datum_label TEXT  (Original-String, user-/AI-lesbar)
    //       * story_tag INT  (relative Story-Zeit, falls kein realer Kalender)
    //       * subtyp TEXT DEFAULT 'sonstiges'  (geburt|tod|reise|… Whitelist)
    //       * storyline_id INT NULL REFERENCES storylines(id) ON DELETE SET NULL
    //       * manually_edited INT NOT NULL DEFAULT 0  (Schutz vor Re-Run-Overwrite)
    //   - Datums-Parser läuft einmalig über alle Bestands-`datum`-Werte und füllt
    //     die strukturierten Felder. Original-String wandert nach `datum_label`.
    //   - storyline_id FK braucht Recreate (SQLite kann ALTER ADD CONSTRAINT nicht).
    const { parseDatum } = require('../lib/datum-parse');

    db.pragma('foreign_keys = OFF');

    db.exec(`
      CREATE TABLE IF NOT EXISTS storylines (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        farbe       TEXT,
        sort_order  INTEGER DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(book_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_storylines_book ON storylines(book_id, sort_order);
    `);

    db.exec(`
      DROP TABLE IF EXISTS zeitstrahl_events_new;
      CREATE TABLE zeitstrahl_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email      TEXT NOT NULL DEFAULT '' REFERENCES app_users(email) ON DELETE CASCADE,
        datum           TEXT NOT NULL,
        datum_label     TEXT,
        datum_year      INTEGER,
        datum_month     INTEGER,
        datum_day       INTEGER,
        datum_ende_year INTEGER,
        datum_ende_month INTEGER,
        datum_ende_day  INTEGER,
        story_tag       INTEGER,
        ereignis        TEXT NOT NULL,
        typ             TEXT DEFAULT 'persoenlich',
        subtyp          TEXT DEFAULT 'sonstiges',
        bedeutung       TEXT,
        storyline_id    INTEGER REFERENCES storylines(id) ON DELETE SET NULL,
        manually_edited INTEGER NOT NULL DEFAULT 0,
        sort_order      INTEGER DEFAULT 0,
        updated_at      TEXT
      );
    `);

    // Daten kopieren + parsen
    const zeRows = db.prepare(
      'SELECT id, book_id, user_email, datum, ereignis, typ, bedeutung, sort_order, updated_at FROM zeitstrahl_events'
    ).all();
    const insZe = db.prepare(`
      INSERT INTO zeitstrahl_events_new
        (id, book_id, user_email, datum, datum_label,
         datum_year, datum_month, datum_day,
         story_tag, ereignis, typ, subtyp, bedeutung, sort_order, updated_at)
      VALUES (@id, @book_id, @user_email, @datum, @datum_label,
              @datum_year, @datum_month, @datum_day,
              @story_tag, @ereignis, @typ, @subtyp, @bedeutung, @sort_order, @updated_at)
    `);
    for (const r of zeRows) {
      const p = parseDatum(r.datum);
      insZe.run({
        id: r.id, book_id: r.book_id, user_email: r.user_email,
        datum: r.datum, datum_label: p.label || r.datum,
        datum_year:  p.year  ?? null,
        datum_month: p.month ?? null,
        datum_day:   p.day   ?? null,
        story_tag:   p.story_tag ?? null,
        ereignis: r.ereignis, typ: r.typ || 'persoenlich', subtyp: 'sonstiges',
        bedeutung: r.bedeutung, sort_order: r.sort_order ?? 0, updated_at: r.updated_at,
      });
    }

    db.exec(`
      DROP TABLE zeitstrahl_events;
      ALTER TABLE zeitstrahl_events_new RENAME TO zeitstrahl_events;
      CREATE INDEX idx_ze_book_id              ON zeitstrahl_events(book_id, user_email);
      CREATE INDEX idx_zeitstrahl_events_user_email ON zeitstrahl_events(user_email);
      CREATE INDEX idx_ze_storyline            ON zeitstrahl_events(storyline_id);
      CREATE INDEX idx_ze_year                 ON zeitstrahl_events(datum_year);
    `);

    db.exec(`
      DROP TABLE IF EXISTS figure_events_new;
      CREATE TABLE figure_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id       INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        datum           TEXT NOT NULL,
        datum_label     TEXT,
        datum_year      INTEGER,
        datum_month     INTEGER,
        datum_day       INTEGER,
        datum_ende_year INTEGER,
        datum_ende_month INTEGER,
        datum_ende_day  INTEGER,
        story_tag       INTEGER,
        ereignis        TEXT NOT NULL,
        bedeutung       TEXT,
        typ             TEXT DEFAULT 'persoenlich',
        subtyp          TEXT DEFAULT 'sonstiges',
        storyline_id    INTEGER REFERENCES storylines(id) ON DELETE SET NULL,
        manually_edited INTEGER NOT NULL DEFAULT 0,
        sort_order      INTEGER DEFAULT 0,
        chapter_id      INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        page_id         INTEGER REFERENCES pages(page_id)       ON DELETE SET NULL
      );
    `);

    const feRows = db.prepare(
      'SELECT rowid AS rid, figure_id, datum, ereignis, bedeutung, typ, sort_order, chapter_id, page_id FROM figure_events'
    ).all();
    const insFe = db.prepare(`
      INSERT INTO figure_events_new
        (figure_id, datum, datum_label,
         datum_year, datum_month, datum_day,
         story_tag, ereignis, bedeutung, typ, subtyp, sort_order, chapter_id, page_id)
      VALUES (@figure_id, @datum, @datum_label,
              @datum_year, @datum_month, @datum_day,
              @story_tag, @ereignis, @bedeutung, @typ, @subtyp, @sort_order, @chapter_id, @page_id)
    `);
    for (const r of feRows) {
      const p = parseDatum(r.datum);
      insFe.run({
        figure_id: r.figure_id, datum: r.datum, datum_label: p.label || r.datum,
        datum_year:  p.year  ?? null,
        datum_month: p.month ?? null,
        datum_day:   p.day   ?? null,
        story_tag:   p.story_tag ?? null,
        ereignis: r.ereignis, bedeutung: r.bedeutung, typ: r.typ || 'persoenlich',
        subtyp: 'sonstiges', sort_order: r.sort_order ?? 0,
        chapter_id: r.chapter_id, page_id: r.page_id,
      });
    }

    db.exec(`
      DROP TABLE figure_events;
      ALTER TABLE figure_events_new RENAME TO figure_events;
      CREATE INDEX idx_fe_chapter   ON figure_events(chapter_id);
      CREATE INDEX idx_fe_page      ON figure_events(page_id);
      CREATE INDEX idx_fe_storyline ON figure_events(storyline_id);
    `);

    db.pragma('foreign_keys = ON');
    const fkErrors156 = db.pragma('foreign_key_check');
    if (fkErrors156.length) {
      throw new Error(`Migration 156: foreign_key_check meldet ${fkErrors156.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 156').run();
    logger.info(`DB-Migration auf Version 156 abgeschlossen (storylines + strukturierte Datum-Felder; ${zeRows.length} zeitstrahl_events / ${feRows.length} figure_events migriert).`);
  }

  if (version < 157) {
    // Entity-Linking-Feature pro Buch ein-/ausschaltbar (siehe
    // docs/ideen/figuren-orte-im-text.md). Default aus. Schaltet im
    // Notebook-Editor Inline-Highlights fuer Figuren/Orte + Seiten-Panel
    // fuer Szenen/Ereignisse. Liegt in book_settings (konsistent mit
    // is_finished / allow_lektor_book_chat / daily_goal_chars).
    const bsCols = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols.includes('entities_enabled')) {
      db.prepare('ALTER TABLE book_settings ADD COLUMN entities_enabled INTEGER NOT NULL DEFAULT 0').run();
    }

    const fkErrors157 = db.pragma('foreign_key_check');
    if (fkErrors157.length) {
      throw new Error(`Migration 157: foreign_key_check meldet ${fkErrors157.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 157').run();
    logger.info('DB-Migration auf Version 157 abgeschlossen (book_settings.entities_enabled).');
  }

  if (version < 158) {
    // Kontinuitaets-Issues als "erledigt" markierbar. Gueltig bis zur naechsten
    // Komplettanalyse: jeder Lauf legt frische continuity_issues-Zeilen mit
    // resolved=0 an und nur der juengste Check wird angezeigt -> Status resettet
    // automatisch, ohne Issue-Matching ueber Laeufe hinweg.
    const ciCols158 = db.pragma('table_info(continuity_issues)').map(c => c.name);
    if (!ciCols158.includes('resolved')) {
      db.prepare('ALTER TABLE continuity_issues ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!ciCols158.includes('resolved_at')) {
      db.prepare('ALTER TABLE continuity_issues ADD COLUMN resolved_at TEXT').run();
    }

    const fkErrors158 = db.pragma('foreign_key_check');
    if (fkErrors158.length) {
      throw new Error(`Migration 158: foreign_key_check meldet ${fkErrors158.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 158').run();
    logger.info('DB-Migration auf Version 158 abgeschlossen (continuity_issues.resolved).');
  }

  if (version < 159) {
    // Client-seitige JS-Fehler. Vom Browser via /telemetry/js-error gemeldet,
    // im Admin durchsuchbar. Diagnostik — user_email SET NULL, damit die Fehler-
    // Historie eine User-Loeschung ueberlebt. Zeilen-Cap in db/js-errors.js.
    db.exec(`
      CREATE TABLE IF NOT EXISTS js_errors (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        user_email  TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        kind        TEXT NOT NULL DEFAULT 'error',
        message     TEXT NOT NULL,
        stack       TEXT,
        source      TEXT,
        line        INTEGER,
        col         INTEGER,
        page_url    TEXT,
        user_agent  TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_js_errors_created_at ON js_errors(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_js_errors_user_email ON js_errors(user_email)');

    const fkErrors159 = db.pragma('foreign_key_check');
    if (fkErrors159.length) {
      throw new Error(`Migration 159: foreign_key_check meldet ${fkErrors159.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 159').run();
    logger.info('DB-Migration auf Version 159 abgeschlossen (js_errors).');
  }

  if (version < 160) {
    // Autorfoto fuer die "Ueber den Autor"-Seite im PDF-Export. BLOB direkt im
    // Profil (analog cover_image). Additive Spalten, kein FK noetig.
    const pepCols160 = db.pragma('table_info(pdf_export_profile)').map(c => c.name);
    if (!pepCols160.includes('author_image')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN author_image BLOB').run();
    }
    if (!pepCols160.includes('author_image_mime')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN author_image_mime TEXT').run();
    }

    const fkErrors160 = db.pragma('foreign_key_check');
    if (fkErrors160.length) {
      throw new Error(`Migration 160: foreign_key_check meldet ${fkErrors160.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 160').run();
    logger.info('DB-Migration auf Version 160 abgeschlossen (pdf_export_profile.author_image).');
  }

  if (version < 161) {
    // Welt-Fakten: deklaratives Buch-Wissen (Magiesystem-Regeln, Geografie, Daten,
    // etablierte Aussagen), bisher nur transient fuer den Kontinuitaets-Check gebaut
    // und danach verworfen. Persistiert macht es der Buch-Chat ueber list_world_facts
    // abfragbar. Regenerierter KI-Cache (kein manuelles Edit) → ON DELETE CASCADE.
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_facts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kategorie   TEXT,
        subjekt     TEXT,
        fakt        TEXT NOT NULL,
        seite_label TEXT,
        sort_order  INTEGER DEFAULT 0,
        user_email  TEXT,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_world_facts_book ON world_facts(book_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_fact_chapters (
        fact_id    INTEGER NOT NULL REFERENCES world_facts(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        PRIMARY KEY (fact_id, chapter_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wfc_chapter ON world_fact_chapters(chapter_id)');

    const fkErrors161 = db.pragma('foreign_key_check');
    if (fkErrors161.length) {
      throw new Error(`Migration 161: foreign_key_check meldet ${fkErrors161.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 161').run();
    logger.info('DB-Migration auf Version 161 abgeschlossen (world_facts + world_fact_chapters).');
  }

  if (version < 162) {
    // Orte-Karte: pro Buch konfigurierbar, ob Schauplaetze reale (geocodierbare)
    // Orte sind. Nur dann blendet die Orte-Karte den Geo-Karten-Tab ein.
    // lat/lng nullbar pro Ort — User-kuratiert (Nominatim-Vorschlag + Pin-Drag).
    const bsCols162 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols162.includes('orte_real')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN orte_real INTEGER NOT NULL DEFAULT 0');
    }
    const locCols162 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols162.includes('lat')) db.exec('ALTER TABLE locations ADD COLUMN lat REAL');
    if (!locCols162.includes('lng')) db.exec('ALTER TABLE locations ADD COLUMN lng REAL');

    const fkErrors162 = db.pragma('foreign_key_check');
    if (fkErrors162.length) {
      throw new Error(`Migration 162: foreign_key_check meldet ${fkErrors162.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 162').run();
    logger.info('DB-Migration auf Version 162 abgeschlossen (book_settings.orte_real + locations.lat/lng).');
  }

  if (version < 163) {
    // Schauplatz-Verortung kontextbewusst: Haupt-Schauplatzland pro Buch
    // (ISO-3166-1-alpha-2, z.B. 'ch') biast Geocoding + dient als Land-Fallback
    // bei der Extraktion. Pro Ort optionales `land` (gleiche ISO-2-Notation),
    // von der KI extrahiert bzw. vom User per Karte gepflegt.
    const bsCols163 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols163.includes('schauplatz_land')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN schauplatz_land TEXT');
    }
    const locCols163 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols163.includes('land')) db.exec('ALTER TABLE locations ADD COLUMN land TEXT');

    const fkErrors163 = db.pragma('foreign_key_check');
    if (fkErrors163.length) {
      throw new Error(`Migration 163: foreign_key_check meldet ${fkErrors163.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 163').run();
    logger.info('DB-Migration auf Version 163 abgeschlossen (book_settings.schauplatz_land + locations.land).');
  }

  if (version < 164) {
    // Figuren-Tiefe (Claude-Komplettanalyse): körperliche Erscheinung, Sprechweise,
    // Vorgeschichte + strukturierter Entwicklungsbogen. `arc` als JSON-TEXT
    // ({typ, anfang, wendepunkte[], ende}), analog zur schluesselzitate-Konvention.
    // Der flache `entwicklung`-String bleibt als Anzeige-Fallback (aus arc abgeleitet).
    const figCols164 = db.pragma('table_info(figures)').map(c => c.name);
    const addCol164 = (name, def) => {
      if (!figCols164.includes(name)) db.exec(`ALTER TABLE figures ADD COLUMN ${name} ${def}`);
    };
    addCol164('aeusseres',   'TEXT');
    addCol164('stimme',      'TEXT');
    addCol164('hintergrund', 'TEXT');
    addCol164('arc',         'TEXT');

    const fkErrors164 = db.pragma('foreign_key_check');
    if (fkErrors164.length) {
      throw new Error(`Migration 164: foreign_key_check meldet ${fkErrors164.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 164').run();
    logger.info('DB-Migration auf Version 164 abgeschlossen (figures.aeusseres/stimme/hintergrund/arc).');
  }

  if (version < 165) {
    // Rückseiten-Bild fuer das separate Umschlag-PDF (Phase 4 druckfertiger
    // PDF-Export). BLOB direkt im Profil, analog cover_image/author_image.
    // Additive Spalten, kein FK noetig.
    const pepCols165 = db.pragma('table_info(pdf_export_profile)').map(c => c.name);
    if (!pepCols165.includes('back_cover_image')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN back_cover_image BLOB').run();
    }
    if (!pepCols165.includes('back_cover_image_mime')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN back_cover_image_mime TEXT').run();
    }

    const fkErrors165 = db.pragma('foreign_key_check');
    if (fkErrors165.length) {
      throw new Error(`Migration 165: foreign_key_check meldet ${fkErrors165.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 165').run();
    logger.info('DB-Migration auf Version 165 abgeschlossen (pdf_export_profile.back_cover_image).');
  }

  if (version < 166) {
    // Buch-weite Publikations-Metadaten (1:1 zu books). Cover/Autorfoto +
    // Titelei (ISBN/Subtitle/Jahr/Widmung/Impressum/Copyright/Frontmatter/Bio)
    // werden hier geteilt erfasst und von PDF- UND EPUB-Export gelesen — statt
    // render-profil-gebunden. Sprache bleibt SSoT in book_settings.language.
    // EPUB-spezifische Reflow-Toggles (css-Stil, Blocksatz, TOC-Titel) hier mit.
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_publication (
        book_id            INTEGER PRIMARY KEY REFERENCES books(book_id) ON DELETE CASCADE,
        cover_image        BLOB,
        cover_mime         TEXT,
        author_image       BLOB,
        author_image_mime  TEXT,
        isbn               TEXT,
        subtitle           TEXT,
        year               TEXT,
        dedication         TEXT,
        imprint            TEXT,
        copyright          TEXT,
        frontmatter        TEXT,
        author_bio         TEXT,
        epub_css_style     TEXT NOT NULL DEFAULT 'serif',
        epub_justify       INTEGER NOT NULL DEFAULT 1,
        epub_toc_title     TEXT,
        created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    // Seed: pro Buch das Gewinner-PDF-Profil (is_default, sonst zuletzt
    // aktualisiert) → book_publication. Metadaten aus config_json.extras,
    // Cover/Autorfoto-BLOBs direkt. Verhindert Daten-Doppel beim spaeteren
    // Umzug des PDF-Render-Lesepfads.
    const profRows = db.prepare(`
      SELECT book_id, config_json, cover_image, cover_mime, author_image, author_image_mime,
             is_default, updated_at
        FROM pdf_export_profile
       WHERE book_id IS NOT NULL
    `).all();
    const winnerByBook = new Map();
    for (const r of profRows) {
      const cur = winnerByBook.get(r.book_id);
      const better = !cur
        || (r.is_default && !cur.is_default)
        || (!!r.is_default === !!cur.is_default && (r.updated_at || 0) > (cur.updated_at || 0));
      if (better) winnerByBook.set(r.book_id, r);
    }
    const insPub = db.prepare(`
      INSERT INTO book_publication
        (book_id, cover_image, cover_mime, author_image, author_image_mime,
         isbn, subtitle, year, dedication, imprint, copyright, frontmatter, author_bio,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(book_id) DO NOTHING
    `);
    let seeded = 0;
    for (const [bookId, r] of winnerByBook) {
      let ex = {};
      try { ex = (JSON.parse(r.config_json || '{}').extras) || {}; } catch { ex = {}; }
      const nn = v => (v && String(v).trim()) ? String(v) : null;
      insPub.run(
        bookId,
        r.cover_image || null, r.cover_mime || null,
        r.author_image || null, r.author_image_mime || null,
        nn(ex.isbn), nn(ex.subtitle), nn(ex.year), nn(ex.dedication),
        nn(ex.imprint), nn(ex.copyright), nn(ex.frontMatter), nn(ex.authorBio),
      );
      seeded += 1;
    }

    const fkErrors166 = db.pragma('foreign_key_check');
    if (fkErrors166.length) {
      throw new Error(`Migration 166: foreign_key_check meldet ${fkErrors166.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 166').run();
    logger.info(`DB-Migration auf Version 166 abgeschlossen (book_publication, ${seeded} Buch/Buecher geseedet).`);
  }

  if (version < 167) {
    // Buchhandels-Metadaten fuer den EPUB-Export (OPF): eigene Klappentext-
    // Beschreibung, Verlag, Reihe + Reihen-Position, Schlagwoerter (dc:subject).
    // Additiv — keine FK-Aenderung. description ist eigene Quelle, faellt im
    // Builder auf books.description zurueck wenn leer.
    const pubCols = db.pragma('table_info(book_publication)').map(c => c.name);
    const addPubCol = (name, ddl) => {
      if (!pubCols.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${ddl}`);
    };
    addPubCol('description', 'description TEXT');
    addPubCol('publisher', 'publisher TEXT');
    addPubCol('series', 'series TEXT');
    addPubCol('series_index', 'series_index TEXT');
    addPubCol('keywords', 'keywords TEXT');

    const fkErrors167 = db.pragma('foreign_key_check');
    if (fkErrors167.length) {
      throw new Error(`Migration 167: foreign_key_check meldet ${fkErrors167.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 167').run();
    logger.info('DB-Migration auf Version 167 abgeschlossen (book_publication: Buchhandels-Metadaten).');
  }

  if (version < 168) {
    // Erweiterte EPUB-Export-Optionen (book_publication): Typografie (Schriftgrad,
    // Zeilenhoehe, Absatzstil, Einzug, Silbentrennung), Struktur (Kapitelumbruch,
    // Initiale, Szenentrenner, TOC-Seitenverschachtelung, Titelseiten-Modus) und
    // OPF-Metadaten (Rechte, Erscheinungsdatum, Mitwirkende, UUID). Additiv.
    const pubCols = db.pragma('table_info(book_publication)').map(c => c.name);
    const addPubCol = (name, ddl) => {
      if (!pubCols.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${ddl}`);
    };
    addPubCol('epub_font_size',       "epub_font_size TEXT DEFAULT 'normal'");
    addPubCol('epub_line_height',     "epub_line_height TEXT DEFAULT 'normal'");
    addPubCol('epub_paragraph_style', "epub_paragraph_style TEXT DEFAULT 'indent'");
    addPubCol('epub_indent_size',     "epub_indent_size TEXT DEFAULT 'medium'");
    addPubCol('epub_hyphenation',     'epub_hyphenation INTEGER DEFAULT 0');
    addPubCol('epub_chapter_pagebreak', 'epub_chapter_pagebreak INTEGER DEFAULT 1');
    addPubCol('epub_drop_caps',       'epub_drop_caps INTEGER DEFAULT 0');
    addPubCol('epub_nest_pages_in_toc', 'epub_nest_pages_in_toc INTEGER DEFAULT 1');
    addPubCol('epub_scene_separator', "epub_scene_separator TEXT DEFAULT 'line'");
    addPubCol('epub_titlepage_mode',  "epub_titlepage_mode TEXT DEFAULT 'generated'");
    addPubCol('epub_rights',          'epub_rights TEXT');
    addPubCol('epub_pubdate',         'epub_pubdate TEXT');
    addPubCol('epub_translator',      'epub_translator TEXT');
    addPubCol('epub_illustrator',     'epub_illustrator TEXT');
    addPubCol('epub_editor_name',     'epub_editor_name TEXT');
    addPubCol('epub_uuid',            'epub_uuid TEXT');

    const fkErrors168 = db.pragma('foreign_key_check');
    if (fkErrors168.length) {
      throw new Error(`Migration 168: foreign_key_check meldet ${fkErrors168.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 168').run();
    logger.info('DB-Migration auf Version 168 abgeschlossen (book_publication: erweiterte EPUB-Optionen).');
  }

  if (version < 169) {
    // Autor-Anzeigename (book_publication): Pseudonym/Publikationsname, der den
    // Account-Namen (books.created_by) als Author in PDF/EPUB uebersteuert.
    const pubCols = db.pragma('table_info(book_publication)').map(c => c.name);
    if (!pubCols.includes('author_name')) {
      db.exec('ALTER TABLE book_publication ADD COLUMN author_name TEXT');
    }

    const fkErrors169 = db.pragma('foreign_key_check');
    if (fkErrors169.length) {
      throw new Error(`Migration 169: foreign_key_check meldet ${fkErrors169.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 169').run();
    logger.info('DB-Migration auf Version 169 abgeschlossen (book_publication.author_name).');
  }

  if (version < 170) {
    // Provider `llama` (llama.cpp/OpenAI-kompatibel) umbenannt nach `openai-compat`,
    // weil der Call-Pfad ohnehin gegen /v1/chat/completions geht und jetzt auch
    // gehostete OpenAI-kompatible Endpoints (vLLM/LiteLLM/OpenAI) mit Bearer-Token
    // bedient. Reines Daten-Rename: app_settings-Keys + -Wert, Per-User-Override,
    // provider-Spalten in Caches + Verlauf. Keine Schemaaenderung.

    // 1) app_settings-Keys `ai.llama.*` → `ai.openai-compat.*` (PK = key; nur
    //    umziehen, wenn das Ziel noch nicht existiert — sonst PK-Kollision).
    const llamaKeys = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'ai.llama.%'").all();
    const renameKey = db.prepare('UPDATE app_settings SET key = ? WHERE key = ?');
    const keyExists = db.prepare('SELECT 1 FROM app_settings WHERE key = ?');
    for (const { key } of llamaKeys) {
      const newKey = key.replace(/^ai\.llama\./, 'ai.openai-compat.');
      if (!keyExists.get(newKey)) renameKey.run(newKey, key);
    }

    // 2) Aktiver Provider-Wert (value_json ist JSON-encoded).
    db.prepare("UPDATE app_settings SET value_json = '\"openai-compat\"' WHERE key = 'ai.provider' AND value_json = '\"llama\"'").run();

    // 3) Per-User-Override: CHECK-Constraint erlaubt nur claude/ollama/llama —
    //    Recreate-Pattern, um 'llama' durch 'openai-compat' zu ersetzen (sowohl im
    //    CHECK als auch im Datenwert). Andere Spalten unveraendert uebernommen.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS app_users_new');
    db.exec(`
      CREATE TABLE app_users_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        email            TEXT NOT NULL UNIQUE,
        display_name     TEXT,
        avatar_url       TEXT,
        global_role      TEXT NOT NULL DEFAULT 'user'
                              CHECK(global_role IN ('admin','user')),
        status           TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('invited','active','suspended','deleted')),
        language         TEXT DEFAULT 'de',
        model_override   TEXT,
        can_invite_users INTEGER NOT NULL DEFAULT 1,
        first_seen_at    TEXT,
        last_seen_at     TEXT,
        invited_by       TEXT,
        invited_at       TEXT,
        created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        monthly_budget_usd REAL,
        budget_mode      TEXT NOT NULL DEFAULT 'none'
                              CHECK(budget_mode IN ('none','soft','hard')),
        ai_provider_override TEXT
                              CHECK(ai_provider_override IN ('claude','ollama','openai-compat') OR ai_provider_override IS NULL),
        last_login_at    TEXT,
        theme            TEXT,
        default_buchtyp  TEXT,
        default_language TEXT,
        default_region   TEXT,
        focus_granularity TEXT
      )
    `);
    db.exec(`
      INSERT INTO app_users_new (id, email, display_name, avatar_url, global_role, status,
                                 language, model_override, can_invite_users, first_seen_at,
                                 last_seen_at, invited_by, invited_at, created_at,
                                 monthly_budget_usd, budget_mode, ai_provider_override,
                                 last_login_at, theme, default_buchtyp, default_language,
                                 default_region, focus_granularity)
      SELECT id, email, display_name, avatar_url, global_role, status,
             language, model_override, can_invite_users, first_seen_at,
             last_seen_at, invited_by, invited_at, created_at,
             monthly_budget_usd, budget_mode,
             CASE WHEN ai_provider_override = 'llama' THEN 'openai-compat' ELSE ai_provider_override END,
             last_login_at, theme, default_buchtyp, default_language,
             default_region, focus_granularity
        FROM app_users
    `);
    db.exec('DROP TABLE app_users');
    db.exec('ALTER TABLE app_users_new RENAME TO app_users');
    db.pragma('foreign_keys = ON');

    // 4) provider-Spalten in Cache- + Verlaufs-Tabellen (Cache-PK enthaelt provider —
    //    da 'openai-compat' noch nirgends vorkommt, keine Kollision moeglich).
    const providerTables = [
      'chapter_extract_cache', 'book_extract_cache',
      'chapter_review_cache', 'book_review_cache', 'chapter_macro_review_cache',
      'synonym_cache', 'lektorat_cache',
      'chat_messages', 'job_runs',
    ];
    for (const tbl of providerTables) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(tbl);
      if (exists) db.prepare(`UPDATE ${tbl} SET provider = 'openai-compat' WHERE provider = 'llama'`).run();
    }

    const fkErrors170 = db.pragma('foreign_key_check');
    if (fkErrors170.length) {
      throw new Error(`Migration 170: foreign_key_check meldet ${fkErrors170.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 170').run();
    logger.info('DB-Migration auf Version 170 abgeschlossen (Provider llama → openai-compat).');
  }

  if (version < 171) {
    // Kapitel-Numerierung im EPUB-Export (book_publication): Format
    // (none|arabic|roman|word) + Modus (flat|nested). Pendant zur PDF-Option —
    // das Label wird dem Kapiteltitel im Inhaltsverzeichnis und in der
    // Kapitelueberschrift vorangestellt. Additiv.
    const pubCols = db.pragma('table_info(book_publication)').map(c => c.name);
    const addPubCol = (name, ddl) => {
      if (!pubCols.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${ddl}`);
    };
    addPubCol('epub_chapter_numbering',      "epub_chapter_numbering TEXT DEFAULT 'none'");
    addPubCol('epub_chapter_numbering_mode', "epub_chapter_numbering_mode TEXT DEFAULT 'nested'");

    const fkErrors171 = db.pragma('foreign_key_check');
    if (fkErrors171.length) {
      throw new Error(`Migration 171: foreign_key_check meldet ${fkErrors171.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 171').run();
    logger.info('DB-Migration auf Version 171 abgeschlossen (book_publication: EPUB-Kapitelnumerierung).');
  }

  if (version < 172) {
    // chapters.description (Legacy-BookStack-Kapitelintro) entfernt — Feature
    // wird nicht genutzt. Export-/PDF-Builder rendern Kapitel nur noch mit
    // Ueberschrift. Reiner Spalten-Drop, keine FK-/Index-Beruehrung.
    const chapCols172 = db.pragma('table_info(chapters)').map(c => c.name);
    if (chapCols172.includes('description')) {
      db.exec('ALTER TABLE chapters DROP COLUMN description');
    }
    const fkErrors172 = db.pragma('foreign_key_check');
    if (fkErrors172.length) {
      throw new Error(`Migration 172: foreign_key_check meldet ${fkErrors172.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 172').run();
    logger.info('DB-Migration auf Version 172 abgeschlossen (chapters.description entfernt).');
  }

  if (version < 173) {
    // stt_time: Diktat-Nutzung pro (User, Buch, Tag) — analog writing_time, aber
    // mit zusaetzlicher chars-Spalte fuer die diktierten Zeichen. Sekunden kommen
    // aus dem Frontend-Heartbeat (Mic aktiv + Tab sichtbar), chars aus der Laenge
    // der eingefuegten Transkript-Segmente. Buchweit (keine page_id), weil STT nur
    // im Notebook-Editor laeuft und die Auswertung als Tagesreihe im BookStats-
    // Chart erscheint. FK auf books + app_users (CASCADE) wie writing_time.
    db.exec(`CREATE TABLE IF NOT EXISTS stt_time (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0,
        chars      INTEGER NOT NULL DEFAULT 0
      )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_stt_user_book_date ON stt_time(user_email, book_id, date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_stt_book ON stt_time(book_id)');
    const fkErrors173 = db.pragma('foreign_key_check');
    if (fkErrors173.length) {
      throw new Error(`Migration 173: foreign_key_check meldet ${fkErrors173.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 173').run();
    logger.info('DB-Migration auf Version 173 abgeschlossen (stt_time für Diktat-Tracking).');
  }

  if (version < 174) {
    // tagebuch_rueckblick_cache: Endergebnis-Cache des KI-Rückblicks pro
    // (Buch, User, Zeitraum, Provider). zeitraum ist 'YYYY' oder 'YYYY-MM'.
    // pages_sig (page_id:updated_at sortiert + zeitraum + cacheVersion) macht den
    // Cache selbst-invalidierend bei Eintrags-Änderung. provider im PK gegen
    // Cross-Provider-Bleeding (Muster der Review-/Extract-Caches). Pro User, weil
    // Tagebuch persönlich ist; CASCADE mit dem Buch. result_json = SCHEMA_RUECKBLICK.
    db.exec(`CREATE TABLE IF NOT EXISTS tagebuch_rueckblick_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        zeitraum    TEXT    NOT NULL,
        provider    TEXT    NOT NULL,
        pages_sig   TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, zeitraum, provider)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tagebuch_rueckblick_book ON tagebuch_rueckblick_cache(book_id)');
    const fkErrors174 = db.pragma('foreign_key_check');
    if (fkErrors174.length) {
      throw new Error(`Migration 174: foreign_key_check meldet ${fkErrors174.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 174').run();
    logger.info('DB-Migration auf Version 174 abgeschlossen (tagebuch_rueckblick_cache).');
  }

  if (version < 175) {
    // tagebuch_rueckblicke: dauerhafte History generierter Rückblicke (analog
    // book_reviews zum book_review_cache). Pro „Erstellen"-Lauf eine Zeile —
    // re-öffenbar + löschbar. Bewusst NICHT im cache-cleanup-TTL (wie book_reviews),
    // damit alte Rückblicke nicht stillschweigend verschwinden. result_json =
    // SCHEMA_RUECKBLICK. FK auf books (CASCADE).
    db.exec(`CREATE TABLE IF NOT EXISTS tagebuch_rueckblicke (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        zeitraum    TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        model       TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tagebuch_rueckblicke_book ON tagebuch_rueckblicke(book_id, user_email)');
    const fkErrors175 = db.pragma('foreign_key_check');
    if (fkErrors175.length) {
      throw new Error(`Migration 175: foreign_key_check meldet ${fkErrors175.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 175').run();
    logger.info('DB-Migration auf Version 175 abgeschlossen (tagebuch_rueckblicke History).');
  }

  if (version < 176) {
    // books.cover_image (BLOB) entfernen: tote Spalte ohne Lese-/Schreibpfad.
    // Der publikations-relevante Cover lebt in book_publication.cover_image
    // (SSoT fuer PDF- und EPUB-Export). Reines DROP COLUMN — die Spalte ist Teil
    // keines FK/Index/Constraints, daher kein Recreate-Pattern noetig.
    const booksCols176 = db.pragma('table_info(books)').map(c => c.name);
    if (booksCols176.includes('cover_image')) {
      db.exec('ALTER TABLE books DROP COLUMN cover_image');
    }
    const fkErrors176 = db.pragma('foreign_key_check');
    if (fkErrors176.length) {
      throw new Error(`Migration 176: foreign_key_check meldet ${fkErrors176.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 176').run();
    logger.info('DB-Migration auf Version 176 abgeschlossen (books.cover_image entfernt).');
  }

  if (version < 177) {
    // book_publication.epub_unnumbered_chapter_ids: Kapitel-IDs, die im EPUB OHNE
    // Nummer im Titel + Inhaltsverzeichnis erscheinen (Pendant zur PDF-Option
    // chapter.unnumberedChapterIds). Bewusst als JSON-Array in einer TEXT-Spalte
    // (kein FK): es ist eine Konfig-Liste analog zum PDF-Profil-config-Blob, kein
    // relationaler Verweis — verwaiste IDs nach Kapitel-Loeschung sind harmlos
    // (matchen beim Render schlicht kein Kapitel). Additiver ALTER, kein Recreate.
    const bpCols177 = db.pragma('table_info(book_publication)').map(c => c.name);
    if (!bpCols177.includes('epub_unnumbered_chapter_ids')) {
      db.exec(`ALTER TABLE book_publication ADD COLUMN epub_unnumbered_chapter_ids TEXT NOT NULL DEFAULT '[]'`);
    }
    const fkErrors177 = db.pragma('foreign_key_check');
    if (fkErrors177.length) {
      throw new Error(`Migration 177: foreign_key_check meldet ${fkErrors177.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 177').run();
    logger.info('DB-Migration auf Version 177 abgeschlossen (book_publication.epub_unnumbered_chapter_ids).');
  }

  if (version < 178) {
    // book_publication: Selfpublishing-Belletristik-Felder.
    //  - author_file_as: Sortiername des Hauptautors (z.B. "Beispiel, Anna") fuer
    //    Buchhandels-/Reader-Katalog-Sortierung (EPUB-OPF file-as auf #creator).
    //  - co_authors: JSON-Array [{name, file_as}] — Schreib-Duos als zusaetzliche
    //    dc:creator (Rolle aut) im OPF.
    //  - extra_sections: JSON-Array [{placement, title, body, link_url, link_label,
    //    toc}] — freie Vor-/Nachsatz-Seiten (Newsletter-CTA, Auch-von, Rezensions-
    //    Bitte, Leseprobe, Danksagung, Content-Warnungen). co_authors/extra_sections
    //    sind Konfig-Blobs analog epub_unnumbered_chapter_ids (kein FK). Additiv.
    const bpCols178 = db.pragma('table_info(book_publication)').map(c => c.name);
    const addPubCol178 = (name, ddl) => {
      if (!bpCols178.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${ddl}`);
    };
    addPubCol178('author_file_as', 'author_file_as TEXT');
    addPubCol178('co_authors',     "co_authors TEXT NOT NULL DEFAULT '[]'");
    addPubCol178('extra_sections', "extra_sections TEXT NOT NULL DEFAULT '[]'");

    const fkErrors178 = db.pragma('foreign_key_check');
    if (fkErrors178.length) {
      throw new Error(`Migration 178: foreign_key_check meldet ${fkErrors178.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 178').run();
    logger.info('DB-Migration auf Version 178 abgeschlossen (book_publication: Selfpublishing-Belletristik-Felder).');
  }

  if (version < 179) {
    // book_publication: weitere EPUB-Export-Optionen als Pendants zu PDF-Profil-
    // Feldern (pdf_export_profile.config) — Impressum-Position (front/back),
    // Kapiteltitel-Stil + dekorative Striche, separater Heading-Font + -Skala,
    // Sub-Kapitel-Umbruch, Cover-Fit, Ziffernstil, TOC-Schalter + -Tiefe. Additiv.
    const bpCols179 = db.pragma('table_info(book_publication)').map(c => c.name);
    const addPubCol179 = (name, ddl) => {
      if (!bpCols179.includes(name)) db.exec(`ALTER TABLE book_publication ADD COLUMN ${ddl}`);
    };
    addPubCol179('epub_imprint_position',    "epub_imprint_position TEXT DEFAULT 'front'");
    addPubCol179('epub_chapter_title_style', "epub_chapter_title_style TEXT DEFAULT 'centered-large'");
    addPubCol179('epub_heading_font',        "epub_heading_font TEXT DEFAULT 'match'");
    addPubCol179('epub_heading_scale',       "epub_heading_scale TEXT DEFAULT 'normal'");
    addPubCol179('epub_cover_fit',           "epub_cover_fit TEXT DEFAULT 'contain'");
    addPubCol179('epub_numerals',            "epub_numerals TEXT DEFAULT 'default'");
    addPubCol179('epub_subchapter_pagebreak', 'epub_subchapter_pagebreak INTEGER DEFAULT 0');
    addPubCol179('epub_chapter_rule',        'epub_chapter_rule INTEGER DEFAULT 0');
    addPubCol179('epub_page_rule',           'epub_page_rule INTEGER DEFAULT 0');
    addPubCol179('epub_toc_enabled',         'epub_toc_enabled INTEGER DEFAULT 1');
    addPubCol179('epub_toc_depth',           'epub_toc_depth INTEGER DEFAULT 2');

    const fkErrors179 = db.pragma('foreign_key_check');
    if (fkErrors179.length) {
      throw new Error(`Migration 179: foreign_key_check meldet ${fkErrors179.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 179').run();
    logger.info('DB-Migration auf Version 179 abgeschlossen (book_publication: weitere EPUB-Optionen).');
  }

  if (version < 180) {
    // book_publication: Strich-Trenner zwischen Kapitelnummer und Titel in der
    // gestapelten, numerierten EPUB-Ueberschrift abschaltbar (epub-chapter-rule
    // ———). Default 1 = an, damit bestehende Buecher unveraendert rendern. Additiv.
    const bpCols180 = db.pragma('table_info(book_publication)').map(c => c.name);
    if (!bpCols180.includes('epub_chapter_number_divider')) {
      db.exec('ALTER TABLE book_publication ADD COLUMN epub_chapter_number_divider INTEGER DEFAULT 1');
    }

    const fkErrors180 = db.pragma('foreign_key_check');
    if (fkErrors180.length) {
      throw new Error(`Migration 180: foreign_key_check meldet ${fkErrors180.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 180').run();
    logger.info('DB-Migration auf Version 180 abgeschlossen (book_publication.epub_chapter_number_divider).');
  }

  if (version < 181) {
    // Geocode-Resolve-Cache pro Ort: `geo_query` haelt den von der KI aufgeloesten
    // realen Toponym (z.B. «Badi Olten» → «Olten»), `geo_land` den Ziel-Laendercode
    // (ISO-3166-1-alpha-2) fuer den Geocoder-Bias. So skippt ein erneuter
    // «Alle verorten»-Lauf die KI fuer schon aufgeloeste Labels. Semantik von
    // geo_query: NULL = nie aufgeloest; '' = aufgeloest, aber kein realer Anker
    // (rein fiktiv) → kein Geocoder-Call; sonst = Toponym fuer den Lookup. Bewusst
    // getrennt von `land` (User-/Komplettanalyse-kuratiertes Ort-Land). Bei einer
    // Umbenennung wird der Cache im Schreibpfad (saveOrteToDb) genullt. Additiv.
    const locCols181 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols181.includes('geo_query')) db.exec('ALTER TABLE locations ADD COLUMN geo_query TEXT');
    if (!locCols181.includes('geo_land'))  db.exec('ALTER TABLE locations ADD COLUMN geo_land TEXT');

    const fkErrors181 = db.pragma('foreign_key_check');
    if (fkErrors181.length) {
      throw new Error(`Migration 181: foreign_key_check meldet ${fkErrors181.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 181').run();
    logger.info('DB-Migration auf Version 181 abgeschlossen (locations.geo_query + locations.geo_land).');
  }

  if (version < 182) {
    // datum_unsicher pro Event: markiert ein datum_year, das die KI aus dem
    // Kontext abgeleitet hat (relative Zeitangabe, Lebensspanne, Epoche) statt
    // es explizit im Text belegt zu finden. 0 = explizit belegt (oder kein Jahr),
    // 1 = abgeleitet/geschätzt. Frontend rendert abgeleitete Jahre mit «ca.»-
    // Prefix. Additiv (ADD COLUMN, kein FK-Recreate).
    const feCols182 = db.pragma('table_info(figure_events)').map(c => c.name);
    if (!feCols182.includes('datum_unsicher')) {
      db.exec('ALTER TABLE figure_events ADD COLUMN datum_unsicher INTEGER NOT NULL DEFAULT 0');
    }
    const zeCols182 = db.pragma('table_info(zeitstrahl_events)').map(c => c.name);
    if (!zeCols182.includes('datum_unsicher')) {
      db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN datum_unsicher INTEGER NOT NULL DEFAULT 0');
    }

    const fkErrors182 = db.pragma('foreign_key_check');
    if (fkErrors182.length) {
      throw new Error(`Migration 182: foreign_key_check meldet ${fkErrors182.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 182').run();
    logger.info('DB-Migration auf Version 182 abgeschlossen (figure_events.datum_unsicher + zeitstrahl_events.datum_unsicher).');
  }

  if (version < 183) {
    // 1h-TTL-Anteil der Cache-Writes (Claude): 1h-Writes kosten 2x Input statt
    // 1.25x (5min). cache_creation_in bleibt das TTL-uebergreifende Total;
    // cache_creation_1h_in ist die Teilmenge davon mit 1h-TTL (Buchtext-Block
    // der Komplettanalyse/Kontinuitaet, Stable-Block des Buch-Chats).
    // lib/pricing.js#costUsd rechnet den Split; Rows ohne Aufschluesselung (0)
    // laufen zum 5-min-Satz. Additiv (ADD COLUMN, kein FK-Recreate).
    const jrCols183 = db.pragma('table_info(job_runs)').map(c => c.name);
    if (!jrCols183.includes('cache_creation_1h_in')) {
      db.exec('ALTER TABLE job_runs ADD COLUMN cache_creation_1h_in INTEGER DEFAULT 0');
    }
    const cmCols183 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols183.includes('cache_creation_1h_in')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN cache_creation_1h_in INTEGER DEFAULT 0');
    }

    const fkErrors183 = db.pragma('foreign_key_check');
    if (fkErrors183.length) {
      throw new Error(`Migration 183: foreign_key_check meldet ${fkErrors183.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 183').run();
    logger.info('DB-Migration auf Version 183 abgeschlossen (job_runs.cache_creation_1h_in + chat_messages.cache_creation_1h_in).');
  }

  if (version < 184) {
    // Plot-Werkstatt (Beat-Board): planendes Pendant zur rückwärtsgewandten
    // Szenen-/Ereignis-Analyse. Der User skizziert die Handlung als Spalten
    // (plot_acts = Akte/Phasen) mit Karten darin (plot_beats = einzelne
    // Handlungspunkte). KI assistiert ausschliesslich planend/überwachend
    // (Brainstorm + Consistency gegen Buchrealität), schreibt nie in den Text.
    // Pro Buch + User skopiert.
    db.exec(`CREATE TABLE IF NOT EXISTS plot_acts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        farbe       TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_acts_book ON plot_acts(book_id, user_email)');

    // status: geplant → entwurf → im_buch (Nachhalten „schon geschrieben?"),
    // verworfen = ausgemustert, bleibt für Nachvollziehbarkeit. chapter_id
    // (SET NULL) verknüpft einen Beat mit dem Kapitel, in dem er landet.
    db.exec(`CREATE TABLE IF NOT EXISTS plot_beats (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        act_id       INTEGER NOT NULL REFERENCES plot_acts(id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL,
        titel        TEXT    NOT NULL,
        beschreibung TEXT,
        status       TEXT    NOT NULL DEFAULT 'geplant' CHECK(status IN ('geplant','entwurf','im_buch','verworfen')),
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_act ON plot_beats(act_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_book ON plot_beats(book_id, user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_chapter ON plot_beats(chapter_id)');

    // M:M Beat ↔ Figur. Welche Figuren ein Handlungspunkt involviert.
    db.exec(`CREATE TABLE IF NOT EXISTS plot_beat_figures (
        beat_id   INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        PRIMARY KEY (beat_id, figure_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_figures_figure ON plot_beat_figures(figure_id)');

    const fkErrors184 = db.pragma('foreign_key_check');
    if (fkErrors184.length) {
      throw new Error(`Migration 184: foreign_key_check meldet ${fkErrors184.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 184').run();
    logger.info('DB-Migration auf Version 184 abgeschlossen (plot_acts + plot_beats + plot_beat_figures).');
  }

  if (version < 185) {
    // M:M Beat ↔ Werkstatt-Figur (draft_figures). Parallel zu plot_beat_figures,
    // aber auf den vorwärts-entwickelten Figuren-Werkstatt-Drafts: ein Beat kann
    // sowohl Katalog-Figuren (figures) als auch noch-nicht-im-Manuskript-Figuren
    // aus der Werkstatt involvieren. CASCADE auf beide Seiten — verschwindet der
    // Beat oder der Draft, geht auch der Link.
    db.exec(`CREATE TABLE IF NOT EXISTS plot_beat_draft_figures (
        beat_id         INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        draft_figure_id INTEGER NOT NULL REFERENCES draft_figures(id) ON DELETE CASCADE,
        PRIMARY KEY (beat_id, draft_figure_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_draft_figures_draft ON plot_beat_draft_figures(draft_figure_id)');

    const fkErrors185 = db.pragma('foreign_key_check');
    if (fkErrors185.length) {
      throw new Error(`Migration 185: foreign_key_check meldet ${fkErrors185.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 185').run();
    logger.info('DB-Migration auf Version 185 abgeschlossen (plot_beat_draft_figures).');
  }

  if (version < 186) {
    // Spannungs-/Intensitätswert pro Beat (1–5), optional. Speist den
    // Spannungsbogen (Tension-Arc) über das Board. NULL = nicht gesetzt;
    // verworfene Beats fliessen nicht in den Bogen. Additiv (ADD COLUMN).
    const beatCols = db.pragma('table_info(plot_beats)').map(c => c.name);
    if (!beatCols.includes('intensitaet')) {
      db.exec('ALTER TABLE plot_beats ADD COLUMN intensitaet INTEGER CHECK(intensitaet IS NULL OR (intensitaet BETWEEN 1 AND 5))');
    }
    const fkErrors186 = db.pragma('foreign_key_check');
    if (fkErrors186.length) {
      throw new Error(`Migration 186: foreign_key_check meldet ${fkErrors186.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 186').run();
    logger.info('DB-Migration auf Version 186 abgeschlossen (plot_beats.intensitaet).');
  }

  if (version < 187) {
    // Handlungsstränge (Swimlanes) für die Plot-Werkstatt: zweite Ordnungsachse
    // neben den Akten. Das Board wird zum Raster Akte (Spalten) × Stränge (Zeilen);
    // ein Beat sitzt in der Zelle (act_id, thread_id). thread_id NULL = „ohne
    // Strang"-Lane (= heutiges flaches Board bei null Strängen). Strang optional
    // an eine Katalog- ODER Werkstatt-Figur gebunden (Hauptfigur-Strang).
    db.exec(`CREATE TABLE IF NOT EXISTS plot_threads (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email      TEXT NOT NULL,
        name            TEXT NOT NULL,
        farbe           TEXT,
        figure_id       INTEGER REFERENCES figures(id) ON DELETE SET NULL,
        draft_figure_id INTEGER REFERENCES draft_figures(id) ON DELETE SET NULL,
        position        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_threads_book ON plot_threads(book_id, user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_threads_figure ON plot_threads(figure_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_threads_draft_figure ON plot_threads(draft_figure_id)');

    // thread_id auf plot_beats (SET NULL — Strang löschen lässt die Beats stehen,
    // sie fallen in die „ohne Strang"-Lane). Additiv: nullable FK ohne Default,
    // kein Recreate nötig (analog chapters.parent_chapter_id, Migration 135).
    const beatCols187 = db.pragma('table_info(plot_beats)').map(c => c.name);
    if (!beatCols187.includes('thread_id')) {
      db.exec('ALTER TABLE plot_beats ADD COLUMN thread_id INTEGER REFERENCES plot_threads(id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_thread ON plot_beats(thread_id)');

    const fkErrors187 = db.pragma('foreign_key_check');
    if (fkErrors187.length) {
      throw new Error(`Migration 187: foreign_key_check meldet ${fkErrors187.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 187').run();
    logger.info('DB-Migration auf Version 187 abgeschlossen (plot_threads + plot_beats.thread_id).');
  }

  if (version < 188) {
    // Device-Tokens fuer native Clients (Mac-Focus-Writer): per-User-Bearer-Token,
    // damit ein Offline-Client sich ohne interaktiven OIDC-Flow authentifizieren
    // kann. Getrennt von api_tokens (admin-scoped, Metrics) — diese hier loesen auf
    // den echten User + dessen echte Rolle auf. Plain-Token nur einmal beim Create
    // ausgegeben; DB haelt ausschliesslich den SHA-256-Hash. Format `swd_<hex>`.
    db.exec(`CREATE TABLE IF NOT EXISTS device_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email   TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        device_name  TEXT NOT NULL,
        platform     TEXT,
        scopes       TEXT NOT NULL DEFAULT 'content:read,content:write',
        last_used_at TEXT,
        last_used_ip TEXT,
        expires_at   TEXT,
        revoked_at   TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_email)');

    const fkErrors188 = db.pragma('foreign_key_check');
    if (fkErrors188.length) {
      throw new Error(`Migration 188: foreign_key_check meldet ${fkErrors188.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 188').run();
    logger.info('DB-Migration auf Version 188 abgeschlossen (device_tokens).');
  }

  if (version < 189) {
    // Backfill: Legacy-/Seed-Seiten ohne updated_at bekommen einen Nicht-NULL-Wert.
    // Eine NULL-updated_at-Seite sortiert im Sync-Keyset-Cursor (pagesChangedSince)
    // ganz nach vorne, der Antwort-Cursor `since` bleibt NULL → der Offline-Client
    // (Mac-Focus-Writer) kann den Cursor nie vorruecken und zieht bei jedem Poll
    // erneut den kompletten Baseline-Pull. local_updated_at als beste Quelle, sonst
    // EPOCH (statisch, damit die Seite ans Anfangsende sortiert ohne NULL zu sein).
    db.prepare(`
      UPDATE pages
         SET updated_at = COALESCE(updated_at, local_updated_at, '1970-01-01T00:00:00.000Z')
       WHERE updated_at IS NULL
    `).run();

    const fkErrors189 = db.pragma('foreign_key_check');
    if (fkErrors189.length) {
      throw new Error(`Migration 189: foreign_key_check meldet ${fkErrors189.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 189').run();
    logger.info('DB-Migration auf Version 189 abgeschlossen (pages.updated_at-Backfill).');
  }

  if (version < 190) {
    // page_revisions.source-CHECK erweitern um 'macapp' (Offline-Mac-Focus-Writer).
    // JS-VALID_SOURCES kennt 'macapp', CHECK nicht → Inserts vom Mac-Client liefen
    // still in CHECK-Verletzung und wurden im content-store weggeloggt; Mac-Edits
    // erzeugten 0 Revisionen.
    db.pragma('foreign_keys = OFF');
    db.prepare('DROP TABLE IF EXISTS page_revisions_new').run();
    db.prepare(`
      CREATE TABLE page_revisions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        body_markdown TEXT,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                        ('focus','main','book','chat-apply','lektorat-apply','import','conflict','macapp')),
        user_email    TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        summary       TEXT,
        created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run();
    db.prepare(`
      INSERT INTO page_revisions_new (id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at)
      SELECT id, page_id, book_id, body_html, body_markdown, chars, words, tok, source, user_email, summary, created_at
        FROM page_revisions
    `).run();
    db.prepare('DROP TABLE page_revisions').run();
    db.prepare('ALTER TABLE page_revisions_new RENAME TO page_revisions').run();
    db.prepare('CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC)').run();
    db.prepare('CREATE INDEX idx_page_revisions_book ON page_revisions(book_id, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_page_revisions_user ON page_revisions(user_email)').run();
    db.pragma('foreign_keys = ON');
    const fkErrors190 = db.pragma('foreign_key_check');
    if (fkErrors190.length) {
      throw new Error(`Migration 190: foreign_key_check meldet ${fkErrors190.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 190').run();
    logger.info("DB-Migration auf Version 190 abgeschlossen (page_revisions.source-CHECK um 'macapp' erweitert).");
  }

  if (version < 191) {
    // plot_consistency_runs: Historie der Plot-Konsistenz-Prüfungen. Pro Lauf
    // eine Zeile mit Result-JSON (konflikte + fazit); Frontend zeigt eine
    // klappbare Verlaufs-Liste pro Buch. Anders als werkstatt_runs ist Plot
    // pro (Buch, User) skopiert (kein Draft-Owner) → book_id ist die Bezugs-
    // entität. ON DELETE CASCADE: Historie stirbt mit dem Buch.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS plot_consistency_runs (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id        INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email     TEXT    NOT NULL,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        konflikt_count INTEGER NOT NULL DEFAULT 0,
        result_json    TEXT    NOT NULL,
        model          TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pcr_book_user_date ON plot_consistency_runs(book_id, user_email, created_at DESC)').run();
    const fkErrors191 = db.pragma('foreign_key_check');
    if (fkErrors191.length) {
      throw new Error(`Migration 191: foreign_key_check meldet ${fkErrors191.length} Verstoesse: ${JSON.stringify(fkErrors191.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 191').run();
    logger.info('DB-Migration auf Version 191 abgeschlossen (plot_consistency_runs).');
  }

  if (version < 192) {
    // plot_threads.chapter_id: ein Handlungsstrang kann zusätzlich zur Hauptfigur
    // ein Zielkapitel binden. Beats der Strang-Lane erben Figur + Kapitel implizit
    // (live, nicht gespeichert) — der Beat überschreibt das Kapitel nur mit einem
    // eigenen chapter_id. Additiv: nullable FK ohne Default, SET NULL (Kapitel
    // löschen entkoppelt nur die Bindung), kein Recreate nötig (analog Mig. 187).
    const threadCols192 = db.pragma('table_info(plot_threads)').map(c => c.name);
    if (!threadCols192.includes('chapter_id')) {
      db.exec('ALTER TABLE plot_threads ADD COLUMN chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_threads_chapter ON plot_threads(chapter_id)');

    const fkErrors192 = db.pragma('foreign_key_check');
    if (fkErrors192.length) {
      throw new Error(`Migration 192: foreign_key_check meldet ${fkErrors192.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 192').run();
    logger.info('DB-Migration auf Version 192 abgeschlossen (plot_threads.chapter_id).');
  }

  if (version < 193) {
    // Hybrid-Akte: ein Handlungsstrang kann optional eine EIGENE Aktstruktur haben
    // (statt der geteilten Akte). plot_acts.thread_id NULL = geteilter Akt (Default,
    // flaches Board + alle Stränge ohne eigene Akte); thread_id = T = Akt gehört nur
    // Strang T. „Eigene Akte" wird aus der Existenz strang-eigener Akte abgeleitet
    // (kein Flag). ON DELETE CASCADE: Strang löschen entfernt seine eigenen Akte —
    // die zugehörigen Beats werden in routes/db VOR dem Löschen auf geteilte Akte
    // umgehängt (Invariante „Strang löschen ≠ Beats löschen"). Additiv: nullable FK
    // ohne Default, kein Recreate nötig (analog plot_beats.thread_id, Migration 187).
    const actCols193 = db.pragma('table_info(plot_acts)').map(c => c.name);
    if (!actCols193.includes('thread_id')) {
      db.exec('ALTER TABLE plot_acts ADD COLUMN thread_id INTEGER REFERENCES plot_threads(id) ON DELETE CASCADE');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_acts_thread ON plot_acts(thread_id)');

    const fkErrors193 = db.pragma('foreign_key_check');
    if (fkErrors193.length) {
      throw new Error(`Migration 193: foreign_key_check meldet ${fkErrors193.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 193').run();
    logger.info('DB-Migration auf Version 193 abgeschlossen (plot_acts.thread_id — Hybrid-Akte pro Strang).');
  }

  if (version < 194) {
    // pages.last_editor_device_id: welches Geraet (app_users_devices) den letzten
    // Body-Edit geschrieben hat. Macht den Collab-/changes-Feed geraete-bewusst:
    // eigene Edits VON EINEM ANDEREN Geraet desselben Users (z.B. nativer
    // Mac-Focus-Client) werden im Browser jetzt als Remote-Change erkannt, waehrend
    // der Echo des EIGENEN Browsers (gleiche device_id) weiter ausgefiltert bleibt.
    // Additiv: nullable FK ohne Default (ON DELETE SET NULL — Geraet widerrufen
    // entkoppelt die Page-Zuordnung), kein Recreate noetig (analog Migration 193).
    const pageCols194 = db.pragma('table_info(pages)').map(c => c.name);
    if (!pageCols194.includes('last_editor_device_id')) {
      db.exec('ALTER TABLE pages ADD COLUMN last_editor_device_id TEXT REFERENCES app_users_devices(device_id) ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_pages_last_editor_device ON pages(last_editor_device_id)');

    const fkErrors194 = db.pragma('foreign_key_check');
    if (fkErrors194.length) {
      throw new Error(`Migration 194: foreign_key_check meldet ${fkErrors194.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 194').run();
    logger.info('DB-Migration auf Version 194 abgeschlossen (pages.last_editor_device_id — geraete-bewusster Collab-Feed).');
  }

  if (version < 195) {
    // Mac-Client-Telemetrie auf device_tokens: client_version (vom Client per
    // X-Client-Version-Header gemeldet, beim Token-Touch persistiert) + use_count
    // (Gesamtzahl authentifizierter Device-Token-Requests, bei jedem Touch +1).
    // Speist den Admin-Tab „Geräte" (installierte Client-Version + Nutzung pro
    // Gerät, abgleichbar gegen das neueste GitHub-Release). Additiv: zwei Spalten
    // ohne FK, kein Recreate nötig.
    const dtCols195 = db.pragma('table_info(device_tokens)').map(c => c.name);
    if (!dtCols195.includes('client_version')) {
      db.exec('ALTER TABLE device_tokens ADD COLUMN client_version TEXT');
    }
    if (!dtCols195.includes('use_count')) {
      db.exec('ALTER TABLE device_tokens ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0');
    }

    const fkErrors195 = db.pragma('foreign_key_check');
    if (fkErrors195.length) {
      throw new Error(`Migration 195: foreign_key_check meldet ${fkErrors195.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 195').run();
    logger.info('DB-Migration auf Version 195 abgeschlossen (device_tokens.client_version + use_count — Mac-Client-Telemetrie).');
  }

  if (version < 196) {
    // Persistentes Kosten-Ledger: eine Zeile pro abgerechnetem KI-Call mit zur
    // Schreib-Zeit EINGEFRORENER USD-Kosten. Entkoppelt die Kostenhistorie von
    // der Job-Wegwerf-Historie — job_runs wird nach 30 Tagen geprunt
    // (lib/cache-cleanup.js), wodurch jede zur Lese-Zeit re-computete Kosten-
    // Aggregation ueber aeltere Zeitraeume schrumpfte. Das Ledger wird NIE
    // geprunt; Aggregate (Admin-Usage, Budget, Daily-Usage, /metrics) lesen
    // daraus. Quelltabellen (job_runs/chat_messages) bleiben SSoT fuer die
    // operativen Detail-Listen.
    //
    // source_ref ist ein opaker Trace-/Idempotenz-Schluessel ('job:<job_id>' |
    // 'chatmsg:<id>'), bewusst KEIN Integer-FK — er muss den Prune der
    // Quellzeile ueberleben. UNIQUE verhindert Doppel-Inserts bei Re-Entry.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_cost_ledger (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                   TEXT    NOT NULL,
        user_email           TEXT,
        source               TEXT    NOT NULL CHECK(source IN ('job','chat')),
        type                 TEXT,
        book_id              INTEGER REFERENCES books(book_id) ON DELETE SET NULL,
        provider             TEXT,
        model                TEXT,
        tokens_in            INTEGER NOT NULL DEFAULT 0,
        tokens_out           INTEGER NOT NULL DEFAULT 0,
        cache_read_in        INTEGER NOT NULL DEFAULT 0,
        cache_creation_in    INTEGER NOT NULL DEFAULT 0,
        cache_creation_1h_in INTEGER NOT NULL DEFAULT 0,
        usd                  REAL    NOT NULL DEFAULT 0,
        source_ref           TEXT    UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_ts   ON ai_cost_ledger(ts);
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_user ON ai_cost_ledger(user_email);
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_book ON ai_cost_ledger(book_id);
    `);

    // Backfill: noch vorhandene Quelldaten (job_runs: letzte ~30 Tage nach Prune;
    // chat_messages: ungeprunt) ins Ledger uebernehmen, damit Aggregate ab Deploy
    // nahtlos weiterlaufen. usd wird mit den AKTUELLEN Tarifen eingefroren — fuer
    // historische Rows die beste verfuegbare Naeherung. Chat-Job-Typen aus
    // job_runs ausgeschlossen (Verbrauch lebt in chat_messages), sonst Doppel-
    // zaehlung. INSERT OR IGNORE haelt den Backfill idempotent gegen source_ref.
    const { costUsd: _costUsd } = require('../lib/pricing');
    const _insLedger = db.prepare(`
      INSERT OR IGNORE INTO ai_cost_ledger
        (ts, user_email, source, type, book_id, provider, model,
         tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in, usd, source_ref)
      VALUES (@ts, @user_email, @source, @type, @book_id, @provider, @model,
              @tokens_in, @tokens_out, @cache_read_in, @cache_creation_in, @cache_creation_1h_in, @usd, @source_ref)
    `);
    const _backfill = db.transaction((rows, source, refPrefix) => {
      for (const r of rows) {
        _insLedger.run({
          ts: r.ts || new Date().toISOString(),
          user_email: r.user_email || null,
          source,
          type: r.type || null,
          book_id: r.book_id || null,
          provider: r.provider || null,
          model: r.model || null,
          tokens_in: r.tokens_in || 0,
          tokens_out: r.tokens_out || 0,
          cache_read_in: r.cache_read_in || 0,
          cache_creation_in: r.cache_creation_in || 0,
          cache_creation_1h_in: r.cache_creation_1h_in || 0,
          usd: _costUsd({
            provider: r.provider, model: r.model,
            tokensIn: r.tokens_in, tokensOut: r.tokens_out,
            cacheReadIn: r.cache_read_in, cacheCreationIn: r.cache_creation_in,
            cacheCreation1hIn: r.cache_creation_1h_in,
          }),
          source_ref: `${refPrefix}${r.ref}`,
        });
      }
    });
    const _jobRows = db.prepare(`
      SELECT job_id AS ref, ended_at AS ts, user_email, type, book_id, provider, model,
             tokens_in, tokens_out, cache_read_in, cache_creation_in, cache_creation_1h_in
        FROM job_runs
       WHERE type NOT IN ('chat','book-chat') AND ended_at IS NOT NULL
    `).all();
    _backfill(_jobRows, 'job', 'job:');
    const _chatRows = db.prepare(`
      SELECT cm.id AS ref, cm.created_at AS ts, cs.user_email AS user_email, cs.kind AS type,
             cs.book_id AS book_id, cm.provider, cm.model,
             cm.tokens_in, cm.tokens_out, cm.cache_read_in, cm.cache_creation_in, cm.cache_creation_1h_in
        FROM chat_messages cm
        JOIN chat_sessions cs ON cs.id = cm.session_id
       WHERE cm.role = 'assistant'
    `).all();
    _backfill(_chatRows, 'chat', 'chatmsg:');

    const fkErrors196 = db.pragma('foreign_key_check');
    if (fkErrors196.length) {
      throw new Error(`Migration 196: foreign_key_check meldet ${fkErrors196.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 196').run();
    logger.info(`DB-Migration auf Version 196 abgeschlossen (ai_cost_ledger + Backfill: ${_jobRows.length} Job- / ${_chatRows.length} Chat-Rows).`);
  }

  if (version < 197) {
    // Tageszeit-Histogramm der Schreibzeit: Sekunden je (User, Buch, Stunde 0-23),
    // lebenslang aggregiert (KEINE Datums-Dimension — „wann am Tag schreibst du"
    // ist eine Rhythmus-Frage, kein Zeitraum-Wert). Gegenstueck zu writing_time
    // (das auf Tagesebene aggregiert); der Heartbeat-Handler schreibt beide.
    // Wird erst ab Deploy befuellt — historische writing_time-Rows haben keine
    // Uhrzeit. PK (user_email, book_id, hour) = ein Bucket je Stunde/Buch/User.
    db.exec(`
      CREATE TABLE IF NOT EXISTS writing_hour (
        user_email TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        hour       INTEGER NOT NULL CHECK(hour >= 0 AND hour <= 23),
        seconds    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_email, book_id, hour)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_writing_hour_book ON writing_hour(book_id)');

    const fkErrors197 = db.pragma('foreign_key_check');
    if (fkErrors197.length) {
      throw new Error(`Migration 197: foreign_key_check meldet ${fkErrors197.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 197').run();
    logger.info('DB-Migration auf Version 197 abgeschlossen (writing_hour — Tageszeit-Histogramm der Schreibzeit).');
  }

  if (version < 198) {
    // Persoenliches Tages-Schreibziel in Minuten (app_users.daily_goal_minutes).
    // NULL/0 = kein Ziel gesetzt. Treibt den Fortschrittsbalken + die
    // Ziel-Erreichungs-Quote in „Meine Statistik". Additiv: nullable Spalte ohne
    // FK, kein Recreate noetig.
    const userCols198 = db.pragma('table_info(app_users)').map(c => c.name);
    if (!userCols198.includes('daily_goal_minutes')) {
      db.exec('ALTER TABLE app_users ADD COLUMN daily_goal_minutes INTEGER');
    }

    const fkErrors198 = db.pragma('foreign_key_check');
    if (fkErrors198.length) {
      throw new Error(`Migration 198: foreign_key_check meldet ${fkErrors198.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 198').run();
    logger.info('DB-Migration auf Version 198 abgeschlossen (app_users.daily_goal_minutes — persoenliches Tagesziel).');
  }

  if (version < 199) {
    // Buch-Schreibziel mit Deadline: Zielzeichenzahl (gesamt) + Abgabedatum
    // (ISO YYYY-MM-DD). Treibt die Deadline-Projektion in der Buch-Uebersicht
    // ("bei deinem Schnitt fertig am ..."). Beide NULL = kein Ziel gesetzt.
    // Additiv: nullable Spalten ohne FK, kein Recreate noetig.
    const bsCols199 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols199.includes('goal_target_chars')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN goal_target_chars INTEGER');
    }
    if (!bsCols199.includes('goal_deadline')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN goal_deadline TEXT');
    }

    const fkErrors199 = db.pragma('foreign_key_check');
    if (fkErrors199.length) {
      throw new Error(`Migration 199: foreign_key_check meldet ${fkErrors199.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 199').run();
    logger.info('DB-Migration auf Version 199 abgeschlossen (book_settings.goal_target_chars + goal_deadline — Schreibziel mit Deadline).');
  }

  if (version < 200) {
    // Beta-Leser-Feedback: share_comments wird von flachem Kommentarstrom zu
    // verankerten Threads ausgebaut.
    //   parent_id    — Self-FK: NULL = Root-Kommentar, sonst Antwort auf Root
    //                  (Threads sind eine Ebene tief; Antworten erben den Anker).
    //   anchor_bid   — data-bid des Blocks, an dem die Textstelle haengt
    //                  (NULL = allgemeine Anmerkung, altes Verhalten).
    //   anchor_quote — markierter Text (Re-Anchor bei Live-Editieren + Anzeige).
    //   anchor_start/_end — Offset-Hinweis im Block-Text.
    //   author_email — gesetzt, wenn der Buch-Owner antwortet (vs. reader_name
    //                  beim anonymen Leser). Identitaets-Quelle ist im Code
    //                  exklusiv (entweder author_email ODER reader_*-Pfad).
    //   resolved_at  — Owner markiert einen Root-Thread als erledigt.
    //   reader_token — opaker Per-Browser-Token (localStorage), damit ein Leser
    //                  seine eigenen Anmerkungen wiedererkennt + der Name vorbefuellt.
    // Additiv: alle Spalten nullable, FKs mit Default NULL — kein Recreate noetig.
    const scCols200 = db.pragma('table_info(share_comments)').map(c => c.name);
    if (scCols200.length > 0) {
      if (!scCols200.includes('parent_id'))    db.exec('ALTER TABLE share_comments ADD COLUMN parent_id INTEGER REFERENCES share_comments(id) ON DELETE CASCADE');
      if (!scCols200.includes('anchor_bid'))   db.exec('ALTER TABLE share_comments ADD COLUMN anchor_bid TEXT');
      if (!scCols200.includes('anchor_quote')) db.exec('ALTER TABLE share_comments ADD COLUMN anchor_quote TEXT');
      if (!scCols200.includes('anchor_start')) db.exec('ALTER TABLE share_comments ADD COLUMN anchor_start INTEGER');
      if (!scCols200.includes('anchor_end'))   db.exec('ALTER TABLE share_comments ADD COLUMN anchor_end INTEGER');
      if (!scCols200.includes('author_email')) db.exec('ALTER TABLE share_comments ADD COLUMN author_email TEXT REFERENCES app_users(email) ON DELETE SET NULL');
      if (!scCols200.includes('resolved_at'))  db.exec('ALTER TABLE share_comments ADD COLUMN resolved_at TEXT');
      if (!scCols200.includes('reader_token')) db.exec('ALTER TABLE share_comments ADD COLUMN reader_token TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_share_comments_parent ON share_comments(parent_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_share_comments_author ON share_comments(author_email)');
    }

    const fkErrors200 = db.pragma('foreign_key_check');
    if (fkErrors200.length) {
      throw new Error(`Migration 200: foreign_key_check meldet ${fkErrors200.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 200').run();
    logger.info('DB-Migration auf Version 200 abgeschlossen (share_comments — verankerte Beta-Leser-Threads).');
  }

  if (version < 201) {
    // Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3") als
    // selbsttragende Momentaufnahme. Im Gegensatz zu page_revisions (write-heavy,
    // aggressiv geprunt, pro Seite) sind Snapshots sparse + user-initiiert + ohne
    // Pruning. `content_json` = buildBookJson-Output ({ book, tree:[node…] }) mit
    // Seiten-HTML inline → unabhaengig von spaeteren Seiten-Loeschungen.
    // `extras_json` = collectExtras (Analyse + Lektorat) fuer spaeteren Restore.
    // Reine Lese-/Diff-Daten → ON DELETE CASCADE am book_id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        label        TEXT,
        description  TEXT,
        content_json TEXT NOT NULL,
        extras_json  TEXT,
        chars        INTEGER NOT NULL DEFAULT 0,
        words        INTEGER NOT NULL DEFAULT 0,
        pages        INTEGER NOT NULL DEFAULT 0,
        chapters     INTEGER NOT NULL DEFAULT 0,
        user_email   TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_book_snapshots_book ON book_snapshots(book_id, created_at DESC);
    `);

    const fkErrors201 = db.pragma('foreign_key_check');
    if (fkErrors201.length) {
      throw new Error(`Migration 201: foreign_key_check meldet ${fkErrors201.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 201').run();
    logger.info('DB-Migration auf Version 201 abgeschlossen (book_snapshots — Manuskript-Meilensteine / Fassungen).');
  }

  if (version < 202) {
    // Namens-/Konsistenz-Waechter: Ignore-Liste fuer akzeptierte Schreibvarianten.
    // Der Waechter erkennt buchweite Tippfehler/Varianten von Eigennamen regelbasiert
    // (lib/name-guard.js, kein KI-Call); was der User als „gewollt“ markiert, landet
    // hier und wird bei kuenftigen Laeufen unterdrueckt. Pro Buch + User. Rein
    // kuratierte Lese-Daten → ON DELETE CASCADE am book_id. `variant` ist der
    // unterdrueckte Treffer, `canonical` der zugehoerige Stammname (Display/Kontext).
    db.exec(`
      CREATE TABLE IF NOT EXISTS name_guard_ignores (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email TEXT,
        canonical  TEXT NOT NULL,
        variant    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(book_id, user_email, variant)
      );
      CREATE INDEX IF NOT EXISTS idx_name_guard_ignores_book ON name_guard_ignores(book_id, user_email);
    `);

    const fkErrors202 = db.pragma('foreign_key_check');
    if (fkErrors202.length) {
      throw new Error(`Migration 202: foreign_key_check meldet ${fkErrors202.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 202').run();
    logger.info('DB-Migration auf Version 202 abgeschlossen (name_guard_ignores — Namens-Waechter Ignore-Liste).');
  }

  if (version < 203) {
    // Recherche-/Wissensboard: geteiltes Buch-Archiv fuer Notizen, Links, Zitate,
    // Faktensplitter und Bilder. Buchweit geteilt (alle Editoren sehen dieselben
    // Schnipsel; `user_email` ist reine Ersteller-Attribution, KEIN Sichtbarkeits-
    // Scope — anders als `ideen`). Rein rueckwaertsgewandt/kuratierend, nie
    // generativ im Buchtext. Schnipsel-Loeschung beim Buch → ON DELETE CASCADE.
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        kind        TEXT    NOT NULL DEFAULT 'note'
                      CHECK(kind IN ('note','link','quote','fact','image')),
        title       TEXT,
        body        TEXT,
        url         TEXT,
        source      TEXT,
        image       BLOB,
        image_mime  TEXT,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_research_items_book ON research_items(book_id);

      CREATE TABLE IF NOT EXISTS research_item_tags (
        item_id INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
        tag     TEXT    NOT NULL,
        PRIMARY KEY (item_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_research_tags_tag ON research_item_tags(tag);

      CREATE TABLE IF NOT EXISTS research_item_links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id     INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
        target_kind TEXT    NOT NULL
                      CHECK(target_kind IN ('chapter','page','figure','location','scene','beat')),
        chapter_id  INTEGER REFERENCES chapters(chapter_id)   ON DELETE CASCADE,
        page_id     INTEGER REFERENCES pages(page_id)         ON DELETE CASCADE,
        figure_id   INTEGER REFERENCES figures(id)            ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations(id)          ON DELETE CASCADE,
        scene_id    INTEGER REFERENCES figure_scenes(id)      ON DELETE CASCADE,
        beat_id     INTEGER REFERENCES plot_beats(id)         ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        -- Genau ein *_id passend zu target_kind gesetzt, alle anderen NULL
        -- (sentinel-frei; eine Zeile = genau eine Verknuepfung).
        CHECK (
          (target_kind='chapter'  AND chapter_id  IS NOT NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL) OR
          (target_kind='page'     AND page_id     IS NOT NULL AND chapter_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL) OR
          (target_kind='figure'   AND figure_id   IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL) OR
          (target_kind='location' AND location_id IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND scene_id IS NULL AND beat_id IS NULL) OR
          (target_kind='scene'    AND scene_id    IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND beat_id IS NULL) OR
          (target_kind='beat'     AND beat_id     IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_research_links_item     ON research_item_links(item_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_chapter  ON research_item_links(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_page     ON research_item_links(page_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_figure   ON research_item_links(figure_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_location ON research_item_links(location_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_scene    ON research_item_links(scene_id);
      CREATE INDEX IF NOT EXISTS idx_research_links_beat     ON research_item_links(beat_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_research_links_unique ON research_item_links(
        item_id, target_kind,
        COALESCE(chapter_id,0), COALESCE(page_id,0), COALESCE(figure_id,0),
        COALESCE(location_id,0), COALESCE(scene_id,0), COALESCE(beat_id,0)
      );
    `);

    const fkErrors203 = db.pragma('foreign_key_check');
    if (fkErrors203.length) {
      throw new Error(`Migration 203: foreign_key_check meldet ${fkErrors203.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 203').run();
    logger.info('DB-Migration auf Version 203 abgeschlossen (research_items/research_item_links/research_item_tags — Recherche-Board).');
  }

  if (version < 204) {
    // plot_brainstorm_runs: Historie der Plot-Brainstorm-Laeufe, pro (Buch, User)
    // skopiert — analog plot_consistency_runs, aber zusaetzlich pro Akt/Strang
    // (act_id/thread_id). Beide FK SET NULL: ein geloeschter Akt/Strang entkoppelt
    // den Lauf nur, der Name kommt zur Lesezeit per JOIN (kein Snapshot). book_id
    // CASCADE — die Historie stirbt mit dem Buch. result_json = { vorschlaege[] }.
    db.prepare(`
      CREATE TABLE IF NOT EXISTS plot_brainstorm_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        user_email      TEXT    NOT NULL,
        act_id          INTEGER REFERENCES plot_acts(id)              ON DELETE SET NULL,
        thread_id       INTEGER REFERENCES plot_threads(id)           ON DELETE SET NULL,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        vorschlag_count INTEGER NOT NULL DEFAULT 0,
        result_json     TEXT    NOT NULL,
        model           TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pbr_book_user_date ON plot_brainstorm_runs(book_id, user_email, created_at DESC)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pbr_act ON plot_brainstorm_runs(act_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pbr_thread ON plot_brainstorm_runs(thread_id)').run();
    const fkErrors204 = db.pragma('foreign_key_check');
    if (fkErrors204.length) {
      throw new Error(`Migration 204: foreign_key_check meldet ${fkErrors204.length} Verstoesse: ${JSON.stringify(fkErrors204.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 204').run();
    logger.info('DB-Migration auf Version 204 abgeschlossen (plot_brainstorm_runs).');
  }

  if (version < 206) {
    // Index-Hygiene: deckende Indexe fuer FK-Spalten, die bislang ohne Index
    // liefen. Zwei Klassen: (a) heiss gelesene Eltern-FKs (pages/chapters per
    // book_id, zeitstrahl_events per book_id/storyline_id, figure_events per
    // figure_id/chapter_id/page_id) und (b) CASCADE/SET-NULL-Kinder, deren
    // Parent-Loeschung (Buch/Kapitel/Seite/Figur/Event/Issue) sonst pro
    // Kind-Tabelle einen Full-Scan zum Aufloesen der Referenz kostet. Rein
    // additiv (CREATE INDEX), kein Tabellen-Recreate.

    // (a) Heiss gelesene Eltern-FKs
    db.prepare('CREATE INDEX IF NOT EXISTS idx_pages_book_id ON pages(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zeitstrahl_events_book_id ON zeitstrahl_events(book_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zeitstrahl_events_storyline ON zeitstrahl_events(storyline_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fe_figure ON figure_events(figure_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fe_chapter ON figure_events(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_fe_page ON figure_events(page_id)').run();

    // (b) Bruecken-/Detail-Kinder (Parent-Delete-Scan vermeiden)
    db.prepare('CREATE INDEX IF NOT EXISTS idx_figapp_chapter ON figure_appearances(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_from ON figure_relations(from_fig_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_frel_to ON figure_relations(to_fig_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zec_event ON zeitstrahl_event_chapters(event_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zec_chapter ON zeitstrahl_event_chapters(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zep_event ON zeitstrahl_event_pages(event_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zep_page ON zeitstrahl_event_pages(page_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zef_event ON zeitstrahl_event_figures(event_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_zef_figure ON zeitstrahl_event_figures(figure_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cic_issue ON continuity_issue_chapters(issue_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cic_chapter ON continuity_issue_chapters(chapter_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cif_issue ON continuity_issue_figures(issue_id)').run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cif_figure ON continuity_issue_figures(figure_id)').run();

    const fkErrors206 = db.pragma('foreign_key_check');
    if (fkErrors206.length) {
      throw new Error(`Migration 206: foreign_key_check meldet ${fkErrors206.length} Verstoesse: ${JSON.stringify(fkErrors206.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 206').run();
    logger.info('DB-Migration auf Version 206 abgeschlossen (FK-Index-Hygiene, 20 Indexe).');
  }

  if (version < 207) {
    // Recherche-Verknuepfung um Handlungsstrang (plot_threads) erweitern: neue
    // Spalte thread_id + target_kind- und Storage-XOR-CHECK angepasst. SQLite
    // kann CHECK nicht via ALTER aendern → Recreate-Pattern.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS research_item_links_new');
    db.exec(`
      CREATE TABLE research_item_links_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id     INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
        target_kind TEXT    NOT NULL
                      CHECK(target_kind IN ('chapter','page','figure','location','scene','beat','thread')),
        chapter_id  INTEGER REFERENCES chapters(chapter_id)   ON DELETE CASCADE,
        page_id     INTEGER REFERENCES pages(page_id)         ON DELETE CASCADE,
        figure_id   INTEGER REFERENCES figures(id)            ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations(id)          ON DELETE CASCADE,
        scene_id    INTEGER REFERENCES figure_scenes(id)      ON DELETE CASCADE,
        beat_id     INTEGER REFERENCES plot_beats(id)         ON DELETE CASCADE,
        thread_id   INTEGER REFERENCES plot_threads(id)       ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        -- Genau ein *_id passend zu target_kind gesetzt, alle anderen NULL
        -- (sentinel-frei; eine Zeile = genau eine Verknuepfung).
        CHECK (
          (target_kind='chapter'  AND chapter_id  IS NOT NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL AND thread_id IS NULL) OR
          (target_kind='page'     AND page_id     IS NOT NULL AND chapter_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL AND thread_id IS NULL) OR
          (target_kind='figure'   AND figure_id   IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL AND thread_id IS NULL) OR
          (target_kind='location' AND location_id IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND scene_id IS NULL AND beat_id IS NULL AND thread_id IS NULL) OR
          (target_kind='scene'    AND scene_id    IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND beat_id IS NULL AND thread_id IS NULL) OR
          (target_kind='beat'     AND beat_id     IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND thread_id IS NULL) OR
          (target_kind='thread'   AND thread_id   IS NOT NULL AND chapter_id IS NULL AND page_id IS NULL AND figure_id IS NULL AND location_id IS NULL AND scene_id IS NULL AND beat_id IS NULL)
        )
      );
    `);
    db.exec(`INSERT INTO research_item_links_new
        (id, item_id, target_kind, chapter_id, page_id, figure_id, location_id, scene_id, beat_id, thread_id, created_at)
        SELECT id, item_id, target_kind, chapter_id, page_id, figure_id, location_id, scene_id, beat_id, NULL, created_at
          FROM research_item_links`);
    db.exec('DROP TABLE research_item_links');
    db.exec('ALTER TABLE research_item_links_new RENAME TO research_item_links');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_item     ON research_item_links(item_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_chapter  ON research_item_links(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_page     ON research_item_links(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_figure   ON research_item_links(figure_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_location ON research_item_links(location_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_scene    ON research_item_links(scene_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_beat     ON research_item_links(beat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_links_thread   ON research_item_links(thread_id)');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_research_links_unique ON research_item_links(
        item_id, target_kind,
        COALESCE(chapter_id,0), COALESCE(page_id,0), COALESCE(figure_id,0),
        COALESCE(location_id,0), COALESCE(scene_id,0), COALESCE(beat_id,0), COALESCE(thread_id,0)
      )`);
    db.pragma('foreign_keys = ON');
    const fkErrors207 = db.pragma('foreign_key_check');
    if (fkErrors207.length) {
      throw new Error(`Migration 207: foreign_key_check meldet ${fkErrors207.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 207').run();
    logger.info('DB-Migration auf Version 207 abgeschlossen (research_item_links.thread_id — Handlungsstrang verknuepfbar).');
  }

  if (version < 208) {
    // body_markdown faellt weg: einzige Write-Path-Wahrheit fuer den Seiten-Body
    // ist body_html (am html-clean-Chokepoint bereinigt). Der Markdown-Export
    // leitet jetzt immer aus body_html ab. Rein additiv-loeschend (DROP COLUMN);
    // keine Indexe/Trigger/Views referenzieren die Spalte.
    const pagesCols208 = db.pragma('table_info(pages)').map(c => c.name);
    if (pagesCols208.includes('body_markdown')) {
      db.exec('ALTER TABLE pages DROP COLUMN body_markdown');
    }
    const revCols208 = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (revCols208.includes('body_markdown')) {
      db.exec('ALTER TABLE page_revisions DROP COLUMN body_markdown');
    }
    const fkErrors208 = db.pragma('foreign_key_check');
    if (fkErrors208.length) {
      throw new Error(`Migration 208: foreign_key_check meldet ${fkErrors208.length} Verstoesse: ${JSON.stringify(fkErrors208.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 208').run();
    logger.info('DB-Migration auf Version 208 abgeschlossen (pages/page_revisions.body_markdown entfernt).');
  }

  if (version < 209) {
    // Recherche-Board: Dokument-Upload (PDF). Neue Spalten doc/doc_mime/doc_name/
    // doc_text/doc_pages am research_items + neuer kind 'document'. Das Original-PDF
    // liegt als BLOB (doc), der extrahierte Plain-Text (doc_text) speist FTS-Suche
    // und KI-Verknuepfung. SQLite kann die kind-CHECK-Constraint nicht via ALTER
    // erweitern → Recreate-Pattern. Die FK-Kinder (research_item_tags/_links)
    // referenzieren research_items(id) und bleiben ueber den id-erhaltenden
    // Recreate intakt.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS research_items_new');
    db.exec(`
      CREATE TABLE research_items_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        kind        TEXT    NOT NULL DEFAULT 'note'
                      CHECK(kind IN ('note','link','quote','fact','image','document')),
        title       TEXT,
        body        TEXT,
        url         TEXT,
        source      TEXT,
        image       BLOB,
        image_mime  TEXT,
        doc         BLOB,
        doc_mime    TEXT,
        doc_name    TEXT,
        doc_text    TEXT,
        doc_pages   INTEGER,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.exec(`INSERT INTO research_items_new
        (id, book_id, user_email, kind, title, body, url, source, image, image_mime, pinned, archived, created_at, updated_at)
        SELECT id, book_id, user_email, kind, title, body, url, source, image, image_mime, pinned, archived, created_at, updated_at
          FROM research_items`);
    db.exec('DROP TABLE research_items');
    db.exec('ALTER TABLE research_items_new RENAME TO research_items');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_items_book ON research_items(book_id)');
    db.pragma('foreign_keys = ON');
    const fkErrors209 = db.pragma('foreign_key_check');
    if (fkErrors209.length) {
      throw new Error(`Migration 209: foreign_key_check meldet ${fkErrors209.length} Verstoesse: ${JSON.stringify(fkErrors209.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 209').run();
    logger.info('DB-Migration auf Version 209 abgeschlossen (research_items: Dokument-Upload doc/doc_text + kind document).');
  }

  if (version < 210) {
    // Stilprofil pro Buch: KI-destilliertes, editierbares Autorenstil-Profil.
    // Wird in text-erzeugende Prompts (Lektorat/Synonym/Chat) als Imitations-
    // Referenz und in Buch-/Kapitel-Review als Massstab fuer Stimmen-Treue
    // injiziert. Additive Spalte → ADD COLUMN reicht.
    const bsCols210 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols210.includes('stilprofil')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN stilprofil TEXT');
    }
    const fkErrors210 = db.pragma('foreign_key_check');
    if (fkErrors210.length) {
      throw new Error(`Migration 210: foreign_key_check meldet ${fkErrors210.length} Verstoesse: ${JSON.stringify(fkErrors210.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 210').run();
    logger.info('DB-Migration auf Version 210 abgeschlossen (book_settings.stilprofil).');
  }

  if (version < 211) {
    // Beat-Status entkoppelt: die fruehere lineare 4-Wege-Reihe
    // (geplant→entwurf→im_buch→verworfen) vermischte zwei Achsen. Status ist jetzt
    // BINAER (geplant ↔ im_buch = „Idee vs. eingearbeitet"); „verworfen" wird ein
    // eigenes Flag (orthogonale Verwerfen-Achse, bleibt bei Status-Wechsel erhalten).
    // SQLite kann die status-CHECK nicht via ALTER aendern → Recreate-Pattern.
    // Datenabbildung:
    //   entwurf   → status=geplant, verworfen=0  (Zwischenstufe faellt auf Idee)
    //   verworfen → status=geplant, verworfen=1  (alter Realisierungsstand verloren)
    //   geplant/im_buch unveraendert, verworfen=0
    // FK-Kinder (plot_beat_figures/_draft_figures) referenzieren plot_beats(id) und
    // bleiben ueber den id-erhaltenden Recreate intakt.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS plot_beats_new');
    db.exec(`
      CREATE TABLE plot_beats_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        act_id       INTEGER NOT NULL REFERENCES plot_acts(id) ON DELETE CASCADE,
        thread_id    INTEGER REFERENCES plot_threads(id) ON DELETE SET NULL,
        user_email   TEXT    NOT NULL,
        titel        TEXT    NOT NULL,
        beschreibung TEXT,
        status       TEXT    NOT NULL DEFAULT 'geplant' CHECK(status IN ('geplant','im_buch')),
        verworfen    INTEGER NOT NULL DEFAULT 0 CHECK(verworfen IN (0,1)),
        chapter_id   INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL,
        intensitaet  INTEGER CHECK(intensitaet IS NULL OR (intensitaet BETWEEN 1 AND 5)),
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.exec(`INSERT INTO plot_beats_new
        (id, book_id, act_id, thread_id, user_email, titel, beschreibung, status, verworfen, chapter_id, intensitaet, sort_order, created_at, updated_at)
        SELECT id, book_id, act_id, thread_id, user_email, titel, beschreibung,
               CASE WHEN status = 'im_buch' THEN 'im_buch' ELSE 'geplant' END,
               CASE WHEN status = 'verworfen' THEN 1 ELSE 0 END,
               chapter_id, intensitaet, sort_order, created_at, updated_at
          FROM plot_beats`);
    db.exec('DROP TABLE plot_beats');
    db.exec('ALTER TABLE plot_beats_new RENAME TO plot_beats');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_act ON plot_beats(act_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_book ON plot_beats(book_id, user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_chapter ON plot_beats(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beats_thread ON plot_beats(thread_id)');
    db.pragma('foreign_keys = ON');
    const fkErrors211 = db.pragma('foreign_key_check');
    if (fkErrors211.length) {
      throw new Error(`Migration 211: foreign_key_check meldet ${fkErrors211.length} Verstoesse: ${JSON.stringify(fkErrors211.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 211').run();
    logger.info('DB-Migration auf Version 211 abgeschlossen (plot_beats: Status binaer geplant/im_buch + verworfen-Flag).');
  }

  if (version < 212) {
    // "Echte Zeitlinie": kennzeichnet Romane mit realer, kalendarischer
    // Chronologie (analog orte_real fuer reale Schauplaetze). Gate fuer die
    // Jahres-Anzeige in der Zeitstrahl-Ansicht.
    const bsCols212 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols212.includes('zeitlinie_real')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN zeitlinie_real INTEGER NOT NULL DEFAULT 0');
    }
    const fkErrors212 = db.pragma('foreign_key_check');
    if (fkErrors212.length) {
      throw new Error(`Migration 212: foreign_key_check meldet ${fkErrors212.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 212').run();
    logger.info('DB-Migration auf Version 212 abgeschlossen (book_settings.zeitlinie_real).');
  }

  if (version < 213) {
    // Share-Links auch auf Buch-Ebene: kind erhaelt 'book' (ganzes Buch teilen,
    // page_id + chapter_id beide NULL). Da die kind-CHECK-Constraint geaendert
    // wird, via Recreate-Pattern (SQLite kann CHECKs nicht via ALTER aendern).
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS share_links_new');
    db.exec(`
      CREATE TABLE share_links_new (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('page','chapter','book')),
        page_id INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        book_id INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        owner_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        intro TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        view_count INTEGER NOT NULL DEFAULT 0,
        owner_last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind='page'    AND page_id IS NOT NULL AND chapter_id IS NULL) OR
          (kind='chapter' AND chapter_id IS NOT NULL AND page_id IS NULL) OR
          (kind='book'    AND page_id IS NULL AND chapter_id IS NULL)
        )
      )
    `);
    db.exec(`
      INSERT INTO share_links_new
        (token, kind, page_id, chapter_id, book_id, owner_email, intro,
         expires_at, revoked_at, view_count, owner_last_seen_at, created_at)
      SELECT token, kind, page_id, chapter_id, book_id, owner_email, intro,
         expires_at, revoked_at, view_count, owner_last_seen_at, created_at
      FROM share_links
    `);
    db.exec('DROP TABLE share_links');
    db.exec('ALTER TABLE share_links_new RENAME TO share_links');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_links_book ON share_links(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_links_owner ON share_links(owner_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_links_page ON share_links(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_links_chapter ON share_links(chapter_id)');
    db.pragma('foreign_keys = ON');
    const fkErrors213 = db.pragma('foreign_key_check');
    if (fkErrors213.length) {
      throw new Error(`Migration 213: foreign_key_check meldet ${fkErrors213.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 213').run();
    logger.info('DB-Migration auf Version 213 abgeschlossen (share_links.kind erweitert um book).');
  }

  if (version < 214) {
    // Custom-Word-Export-Profile (Pendant zu pdf_export_profile, ohne Cover-/
    // Druck-BLOBs — DOCX ist reflowbar). scope = (kind, book_id) analog PDF.
    db.exec(`
      CREATE TABLE IF NOT EXISTS docx_export_profile (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER REFERENCES books(book_id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL DEFAULT 'book' CHECK(kind IN ('book','user_default')),
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        config_json TEXT    NOT NULL,
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK ((kind = 'book' AND book_id IS NOT NULL)
            OR (kind = 'user_default' AND book_id IS NULL))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_docx_profile_book ON docx_export_profile(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_docx_profile_user ON docx_export_profile(user_email)');
    const fkErrors214 = db.pragma('foreign_key_check');
    if (fkErrors214.length) {
      throw new Error(`Migration 214: foreign_key_check meldet ${fkErrors214.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 214').run();
    logger.info('DB-Migration auf Version 214 abgeschlossen (docx_export_profile angelegt).');
  }

  if (version < 215) {
    // Optionales Inhaltsverzeichnis im Reader-View bei Buch-/Kapitel-Shares.
    // Additiv (kein Recreate) — Default 0 (aus, Live-Verhalten unverändert).
    const slCols215 = db.pragma('table_info(share_links)').map(c => c.name);
    if (!slCols215.includes('show_toc')) {
      db.exec('ALTER TABLE share_links ADD COLUMN show_toc INTEGER NOT NULL DEFAULT 0');
    }
    const fkErrors215 = db.pragma('foreign_key_check');
    if (fkErrors215.length) {
      throw new Error(`Migration 215: foreign_key_check meldet ${fkErrors215.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 215').run();
    logger.info('DB-Migration auf Version 215 abgeschlossen (share_links.show_toc).');
  }

  if (version < 216) {
    // Im Buch-Chat generierte Bilder (Weltaufbau-/Chat-Visualisierung, NIE im
    // Manuskript). An die Chat-Session gebunden; CASCADE mit der Session, da das
    // Bild ohne seinen Verlauf keinen Bezug mehr hat. BLOB inline, da klein und
    // selten (kein Cover-/Asset-Volumen wie beim PDF-Export).
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_images (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        prompt      TEXT    NOT NULL DEFAULT '',
        mime        TEXT    NOT NULL DEFAULT 'image/png',
        size        TEXT    NOT NULL DEFAULT '',
        image       BLOB    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_images_session ON chat_images(session_id)');
    const fkErrors216 = db.pragma('foreign_key_check');
    if (fkErrors216.length) {
      throw new Error(`Migration 216: foreign_key_check meldet ${fkErrors216.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 216').run();
    logger.info('DB-Migration auf Version 216 abgeschlossen (chat_images angelegt).');
  }

  if (version < 217) {
    // Bessere Reviewer↔Autor-Zusammenarbeit auf Share-Links:
    //  - reader_email: optionale Leser-Mailadresse (Reader hat keinen Account),
    //    damit der Autor per Mail antworten-Benachrichtigung den Reviewer
    //    zurueckholen kann. Nullable, kein FK (Leser ist kein app_user).
    //  - edited_at: gesetzt, wenn der Leser seinen eigenen Kommentar nachtraeglich
    //    bearbeitet hat (Transparenz „bearbeitet"-Hinweis).
    // Additiv (kein Recreate), Default NULL — bestehendes Verhalten unveraendert.
    const scCols217 = db.pragma('table_info(share_comments)').map(c => c.name);
    if (!scCols217.includes('reader_email')) {
      db.exec('ALTER TABLE share_comments ADD COLUMN reader_email TEXT');
    }
    if (!scCols217.includes('edited_at')) {
      db.exec('ALTER TABLE share_comments ADD COLUMN edited_at TEXT');
    }
    const fkErrors217 = db.pragma('foreign_key_check');
    if (fkErrors217.length) {
      throw new Error(`Migration 217: foreign_key_check meldet ${fkErrors217.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 217').run();
    logger.info('DB-Migration auf Version 217 abgeschlossen (share_comments.reader_email + edited_at).');
  }

  if (version < 218) {
    // page_revisions.client: womit wurde der Save gemacht — Browser+OS
    // ("Chrome · macOS", via User-Agent) bzw. nativer macOS-Client
    // (Geraetename + Plattform aus dem Device-Token). NULL fuer server-seitige
    // Schreiber ohne Request-Kontext (Cron/Jobs). Zeigt die Revisionsliste neben
    // Quelle/Autor an. Additiv: nullable Spalte ohne FK, kein Recreate noetig.
    const prCols218 = db.pragma('table_info(page_revisions)').map(c => c.name);
    if (!prCols218.includes('client')) {
      db.exec('ALTER TABLE page_revisions ADD COLUMN client TEXT');
    }

    const fkErrors218 = db.pragma('foreign_key_check');
    if (fkErrors218.length) {
      throw new Error(`Migration 218: foreign_key_check meldet ${fkErrors218.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 218').run();
    logger.info('DB-Migration auf Version 218 abgeschlossen (page_revisions.client — Browser/OS bzw. nativer Client pro Revision).');
  }

  if (version < 219) {
    // figures.stale: 1 = im letzten Komplettanalyse-Lauf NICHT mehr erkannt.
    // saveFigurenToDb reconciled Figuren jetzt in-place (UPDATE statt DELETE+INSERT),
    // damit figures.id stabil bleibt und FK-Referenzen (plot_beat_figures,
    // research_item_links, figure_events mit manually_edited=1 etc.) Re-Analysen
    // ueberleben. Verschwundene Figuren werden statt geloescht als stale markiert
    // (Referenzen bleiben erhalten); ihre fig_id wird auf 'orphan_<id>' umgeschrieben,
    // damit der 'fig_N'-Namespace fuer den naechsten Lauf kollisionsfrei bleibt.
    // Additiv: nicht-nullable Spalte mit Default, kein Recreate noetig.
    const figCols219 = db.pragma('table_info(figures)').map(c => c.name);
    if (!figCols219.includes('stale')) {
      db.exec('ALTER TABLE figures ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
    }

    const fkErrors219 = db.pragma('foreign_key_check');
    if (fkErrors219.length) {
      throw new Error(`Migration 219: foreign_key_check meldet ${fkErrors219.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 219').run();
    logger.info('DB-Migration auf Version 219 abgeschlossen (figures.stale — Reconcile-Markierung verschwundener Figuren).');
  }

  if (version < 220) {
    // chat_sessions.kind bekommt den dritten Wert 'research' fuer den Recherche-Chat
    // (Claude-only, agentisch, mit Web-Suche; buchweit wie kind='book', page_id IS NULL).
    // SQLite kann den CHECK nicht per ALTER aendern → Recreate-Pattern.
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS chat_sessions_new;
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book','research')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind IN ('book','research') AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new
        (id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text)
      SELECT id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text
      FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);
    `);
    db.pragma('foreign_keys = ON');
    const fkErrors220 = db.pragma('foreign_key_check');
    if (fkErrors220.length) {
      throw new Error(`Migration 220: foreign_key_check meldet ${fkErrors220.length} Verstoesse: ${JSON.stringify(fkErrors220.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 220').run();
    logger.info("DB-Migration auf Version 220 abgeschlossen (chat_sessions.kind erlaubt 'research' — Recherche-Chat).");
  }

  if (version < 221) {
    // web_searches: Anzahl der Anthropic-Web-Suchen (server_tool_use 'web_search')
    // pro Assistant-Nachricht. Anthropic bepreist Web-Suche als separates
    // Server-Tool (~$10/1'000) ZUSAETZLICH zu den Tokens — bisher gezaehlt
    // (context_info), aber nie in die USD-Kosten eingerechnet. Spalte in
    // chat_messages (Quelle) + ai_cost_ledger (eingefrorene Kostenkomponente).
    // Nur der Recherche-Chat fuellt sie; alle anderen Pfade bleiben bei 0.
    const cmCols221 = db.pragma('table_info(chat_messages)').map(c => c.name);
    if (!cmCols221.includes('web_searches')) {
      db.prepare('ALTER TABLE chat_messages ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0').run();
    }
    const lgCols221 = db.pragma('table_info(ai_cost_ledger)').map(c => c.name);
    if (!lgCols221.includes('web_searches')) {
      db.prepare('ALTER TABLE ai_cost_ledger ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0').run();
    }
    const fkErrors221 = db.pragma('foreign_key_check');
    if (fkErrors221.length) {
      throw new Error(`Migration 221: foreign_key_check meldet ${fkErrors221.length} Verstoesse: ${JSON.stringify(fkErrors221.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 221').run();
    logger.info('DB-Migration auf Version 221 abgeschlossen (web_searches in chat_messages + ai_cost_ledger — Web-Such-Kosten).');
  }

  if (version < 222) {
    // title: KI-zusammengefasster Titel für den History-Eintrag einer Chat-Session
    // (Seiten-/Buch-/Recherche-Chat). Wird einmal pro Session aus der ersten Runde
    // generiert; NULL → Frontend fällt auf die Vorschau (erste Nachricht) zurück.
    const csCols222 = db.pragma('table_info(chat_sessions)').map(c => c.name);
    if (!csCols222.includes('title')) {
      db.prepare('ALTER TABLE chat_sessions ADD COLUMN title TEXT').run();
    }
    const fkErrors222 = db.pragma('foreign_key_check');
    if (fkErrors222.length) {
      throw new Error(`Migration 222: foreign_key_check meldet ${fkErrors222.length} Verstoesse: ${JSON.stringify(fkErrors222.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 222').run();
    logger.info('DB-Migration auf Version 222 abgeschlossen (chat_sessions.title — KI-Titel für History-Einträge).');
  }

  if (version < 223) {
    // Recherche-Board: mehrere URLs pro Eintrag (je mit optionalem Label) statt
    // der einzelnen url-Spalte. Neue Kind-Tabelle research_item_urls (analog
    // research_item_tags/_links). Bestehende Einzel-URLs wandern als position=0
    // ein, danach faellt die url-Spalte via Recreate-Pattern weg (eine Wahrheit).
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_item_urls (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id     INTEGER NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
        url         TEXT    NOT NULL,
        label       TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_urls_item ON research_item_urls(item_id)');
    db.exec(`INSERT INTO research_item_urls (item_id, url, position, created_at)
               SELECT id, trim(url), 0, created_at FROM research_items
                WHERE url IS NOT NULL AND trim(url) != ''`);

    // url-Spalte droppen → Recreate-Pattern. Die FK-Kinder (research_item_tags/
    // _links/_urls) referenzieren research_items(id) und bleiben ueber den
    // id-erhaltenden Recreate intakt.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS research_items_new');
    db.exec(`
      CREATE TABLE research_items_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        kind        TEXT    NOT NULL DEFAULT 'note'
                      CHECK(kind IN ('note','link','quote','fact','image','document')),
        title       TEXT,
        body        TEXT,
        source      TEXT,
        image       BLOB,
        image_mime  TEXT,
        doc         BLOB,
        doc_mime    TEXT,
        doc_name    TEXT,
        doc_text    TEXT,
        doc_pages   INTEGER,
        pinned      INTEGER NOT NULL DEFAULT 0,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.exec(`INSERT INTO research_items_new
        (id, book_id, user_email, kind, title, body, source, image, image_mime, doc, doc_mime, doc_name, doc_text, doc_pages, pinned, archived, created_at, updated_at)
        SELECT id, book_id, user_email, kind, title, body, source, image, image_mime, doc, doc_mime, doc_name, doc_text, doc_pages, pinned, archived, created_at, updated_at
          FROM research_items`);
    db.exec('DROP TABLE research_items');
    db.exec('ALTER TABLE research_items_new RENAME TO research_items');
    db.exec('CREATE INDEX IF NOT EXISTS idx_research_items_book ON research_items(book_id)');
    db.pragma('foreign_keys = ON');
    const fkErrors223 = db.pragma('foreign_key_check');
    if (fkErrors223.length) {
      throw new Error(`Migration 223: foreign_key_check meldet ${fkErrors223.length} Verstoesse: ${JSON.stringify(fkErrors223.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 223').run();
    logger.info('DB-Migration auf Version 223 abgeschlossen (research_item_urls — mehrere URLs je Recherche-Eintrag, url-Spalte entfernt).');
  }

  if (version < 224) {
    // locations.stale / figure_scenes.stale: 1 = im letzten Komplettanalyse-Lauf
    // NICHT mehr erkannt. saveOrteToDb / saveSzenenAndEvents reconcilen jetzt
    // in-place (Match per Name bzw. Kapitel+Titel, UPDATE statt DELETE+INSERT),
    // damit locations.id / figure_scenes.id stabil bleiben und FK-Referenzen
    // (research_item_links.location_id/scene_id, scene_locations, location_figures)
    // Re-Analysen ueberleben. Verschwundene Eintraege werden als stale=1 markiert
    // statt geloescht (Referenzen bleiben erhalten). Spiegelt figures.stale (Mig 219).
    // Additiv: nicht-nullable Spalte mit Default, kein Recreate noetig.
    const locCols224 = db.pragma('table_info(locations)').map(c => c.name);
    if (!locCols224.includes('stale')) {
      db.exec('ALTER TABLE locations ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
    }
    const fsCols224 = db.pragma('table_info(figure_scenes)').map(c => c.name);
    if (!fsCols224.includes('stale')) {
      db.exec('ALTER TABLE figure_scenes ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
    }
    const fkErrors224 = db.pragma('foreign_key_check');
    if (fkErrors224.length) {
      throw new Error(`Migration 224: foreign_key_check meldet ${fkErrors224.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 224').run();
    logger.info('DB-Migration auf Version 224 abgeschlossen (locations.stale + figure_scenes.stale — Reconcile-Markierung verschwundener Orte/Szenen).');
  }

  if (version < 225) {
    // book_settings.exclude_from_stats: 1 = Buch vollstaendig aus der
    // persoenlichen Statistik ("Meine Statistik", /me/profile-stats*) ausnehmen
    // (z.B. Testbuecher). Pro-Buch-Flag, im BookSettings-Kontext-Tab schaltbar.
    // Additiv: nicht-nullable Spalte mit Default, kein Recreate noetig.
    const bsCols225 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols225.includes('exclude_from_stats')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN exclude_from_stats INTEGER NOT NULL DEFAULT 0');
    }
    const fkErrors225 = db.pragma('foreign_key_check');
    if (fkErrors225.length) {
      throw new Error(`Migration 225: foreign_key_check meldet ${fkErrors225.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 225').run();
    logger.info('DB-Migration auf Version 225 abgeschlossen (book_settings.exclude_from_stats — Buch aus persoenlicher Statistik ausnehmen).');
  }

  if (version < 226) {
    // chapters.excluded: 1 = Kapitel bleibt im Buch und voll editierbar (Lektorat,
    // Fassungen/Snapshots), wird aber aus Custom-PDF/EPUB/DOCX-Export, Buchbewertung
    // und Komplettanalyse (Figuren/Orte/Szenen/Ereignisse/Zeitstrahl/Kontinuitaet)
    // herausgefiltert. Ausschluss kaskadiert auf Unterkapitel. Pro-Kapitel-Flag,
    // im Sidebar-Kontextmenue schaltbar.
    // Additiv: nicht-nullable Spalte mit Default, kein Recreate noetig.
    const chCols226 = db.pragma('table_info(chapters)').map(c => c.name);
    if (!chCols226.includes('excluded')) {
      db.exec('ALTER TABLE chapters ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
    }
    const fkErrors226 = db.pragma('foreign_key_check');
    if (fkErrors226.length) {
      throw new Error(`Migration 226: foreign_key_check meldet ${fkErrors226.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 226').run();
    logger.info('DB-Migration auf Version 226 abgeschlossen (chapters.excluded — Kapitel aus Export/Bewertung/Komplettanalyse ausschliessen).');
  }

  if (version < 227) {
    // Kapitel-Erzählprofil (neue Komplettanalyse-Phase): pro Kapitel die aus dem Text
    // erkannte Erzählperspektive/-zeit + Erzähler-/Fokusfigur (Abgleich gegen die in
    // book_settings deklarierte Soll-Perspektive → pov_abweichung), die Spannungs-
    // Intensitaet (1–5, Pacing-Kurve) und ein 1-Satz-Erzählfokus. Themen/Motive/Symbole
    // pro Kapitel in der Kind-Tabelle (n:1). Aggregat-Cache der Komplettanalyse →
    // CASCADE bei Buch- und Kapitel-Loeschung (kein user-kuratierter Inhalt).
    // erzaehler_figur: figure_id-FK (SET NULL) mit Klarnamen-Fallback fuer nicht
    // aufloesbare KI-Namen — analog continuity_issue_figures (Snapshot nur bei
    // nullbarer FK, wenn kein ID-Mapping moeglich war).
    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_narrative_profile (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id                 INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        user_email              TEXT             REFERENCES app_users(email)  ON DELETE SET NULL,
        chapter_id              INTEGER          REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        perspektive             TEXT,
        erzaehlzeit             TEXT,
        erzaehler_figur_id      INTEGER          REFERENCES figures(id)       ON DELETE SET NULL,
        erzaehler_figur         TEXT,
        pov_konfidenz           REAL,
        pov_beleg               TEXT,
        pov_abweichung          INTEGER NOT NULL DEFAULT 0,
        intensitaet             INTEGER,
        intensitaet_begruendung TEXT,
        zusammenfassung         TEXT,
        sort_order              INTEGER NOT NULL DEFAULT 0,
        updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cnp_book       ON chapter_narrative_profile(book_id, user_email);
      CREATE INDEX IF NOT EXISTS idx_cnp_chapter    ON chapter_narrative_profile(chapter_id);
      CREATE INDEX IF NOT EXISTS idx_cnp_figure     ON chapter_narrative_profile(erzaehler_figur_id);
      CREATE INDEX IF NOT EXISTS idx_cnp_user_email ON chapter_narrative_profile(user_email);

      CREATE TABLE IF NOT EXISTS chapter_narrative_themes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES chapter_narrative_profile(id) ON DELETE CASCADE,
        thema      TEXT NOT NULL,
        typ        TEXT,
        beleg      TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cnt_profile ON chapter_narrative_themes(profile_id);
    `);
    const fkErrors227 = db.pragma('foreign_key_check');
    if (fkErrors227.length) {
      throw new Error(`Migration 227: foreign_key_check meldet ${fkErrors227.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 227').run();
    logger.info('DB-Migration auf Version 227 abgeschlossen (chapter_narrative_profile + chapter_narrative_themes — Kapitel-Erzählprofil-Phase).');
  }

  if (version < 228) {
    // Themen/Motive tragen jetzt mehrere Belege (JSON-Array wörtlicher Zitate,
    // wie figure_relations.belege) statt eines einzelnen beleg-Strings.
    db.exec('ALTER TABLE chapter_narrative_themes RENAME COLUMN beleg TO belege');
    // Bestehende Einzel-Belege ins Array heben; leere/NULL bleiben leer.
    db.exec("UPDATE chapter_narrative_themes SET belege = json_array(belege) WHERE belege IS NOT NULL AND belege <> ''");
    db.exec("UPDATE chapter_narrative_themes SET belege = NULL WHERE belege = ''");
    const fkErrors228 = db.pragma('foreign_key_check');
    if (fkErrors228.length) {
      throw new Error(`Migration 228: foreign_key_check meldet ${fkErrors228.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 228').run();
    logger.info('DB-Migration auf Version 228 abgeschlossen (chapter_narrative_themes.beleg → belege, JSON-Array mehrerer Zitate).');
  }

  if (version < 229) {
    // KI-Dach-Befund (Autoren-Befund) der Erzählprofil-Karte: eine priorisierte,
    // an den deterministischen Struktur-Befunden verankerte Synthese pro (Buch, User).
    // Als JSON persistiert (Job erzeugt es, Karte liest es); 1 Zeile je Buch+User.
    db.exec(`
      CREATE TABLE IF NOT EXISTS narrative_report (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT             REFERENCES app_users(email) ON DELETE SET NULL,
        report_json TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(book_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_narrative_report_book ON narrative_report(book_id);
    `);
    const fkErrors229 = db.pragma('foreign_key_check');
    if (fkErrors229.length) {
      throw new Error(`Migration 229: foreign_key_check meldet ${fkErrors229.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 229').run();
    logger.info('DB-Migration auf Version 229 abgeschlossen (narrative_report — KI-Dach-Befund/Autoren-Befund der Erzählprofil-Karte).');
  }

  if (version < 230) {
    // FK-Spalte narrative_report.user_email braucht einen eigenen Index (Performance-Falle).
    // Der UNIQUE(book_id, user_email) deckt user_email allein nicht ab (Prefix book_id).
    db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_report_user ON narrative_report(user_email);');
    const fkErrors230 = db.pragma('foreign_key_check');
    if (fkErrors230.length) {
      throw new Error(`Migration 230: foreign_key_check meldet ${fkErrors230.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 230').run();
    logger.info('DB-Migration auf Version 230 abgeschlossen (Index auf narrative_report.user_email).');
  }

  if (version < 231) {
    // entry_count: Snapshot der Anzahl datierter Einträge des Zeitraums zum
    // Generierungszeitpunkt. Die Client-Neugenerierungs-Sperre vergleicht ihn mit
    // der aktuellen Anzahl, damit ein reiner Lösch-Vorgang (Eintrag entfernt, aber
    // keine Seite jünger als der Rückblick) die Sperre wieder löst. Legacy-Zeilen:
    // NULL → Sperre fällt auf die reine mtime-Prüfung zurück (altes Verhalten).
    const rbCols = db.pragma('table_info(tagebuch_rueckblicke)').map(c => c.name);
    if (!rbCols.includes('entry_count')) {
      db.exec('ALTER TABLE tagebuch_rueckblicke ADD COLUMN entry_count INTEGER');
    }
    const fkErrors231 = db.pragma('foreign_key_check');
    if (fkErrors231.length) {
      throw new Error(`Migration 231: foreign_key_check meldet ${fkErrors231.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 231').run();
    logger.info('DB-Migration auf Version 231 abgeschlossen (tagebuch_rueckblicke.entry_count).');
  }

  if (version < 232) {
    // Schreib-Sessions: eine Zeile je zusammenhaengendem Schreibabschnitt pro
    // (User, Buch). Aus dem writing-time-Heartbeat abgeleitet — ein Ping innerhalb
    // von SESSION_GAP_SECONDS nach der letzten Aktivitaet verlaengert die laufende
    // Session, sonst beginnt eine neue. Basis fuer Session-Kennzahlen (Anzahl,
    // Durchschnittslaenge, laengste Session) in „Meine Statistik". `date` = lokales
    // ISO-Datum des Session-Starts (Zeitraum-Filter im Frontend).
    db.exec(`
      CREATE TABLE IF NOT EXISTS writing_session (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        date       TEXT    NOT NULL,
        started_at TEXT    NOT NULL,
        ended_at   TEXT    NOT NULL,
        seconds    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ws_user_book ON writing_session(user_email, book_id);
      CREATE INDEX IF NOT EXISTS idx_ws_book ON writing_session(book_id);
      CREATE INDEX IF NOT EXISTS idx_ws_user_date ON writing_session(user_email, date);
    `);
    const fkErrors232 = db.pragma('foreign_key_check');
    if (fkErrors232.length) {
      throw new Error(`Migration 232: foreign_key_check meldet ${fkErrors232.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 232').run();
    logger.info('DB-Migration auf Version 232 abgeschlossen (writing_session — Schreib-Session-Tracking fuer Meine Statistik).');
  }

  if (version < 233) {
    // Vom User im Notebook-Editor eingefuegte Manuskript-Bilder. An die Seite
    // gebunden; CASCADE mit der Seite, da das Bild ohne seinen Seiten-Kontext
    // (das referenzierende <img> im Page-HTML) keinen Bezug mehr hat. BLOB inline
    // wie chat_images — pro Seite wenige, sharp-normalisierte Bilder. Owner-/ACL-
    // Check der Serve-Route laeuft ueber JOIN page_id → pages.book_id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS page_images (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        mime        TEXT    NOT NULL DEFAULT 'image/jpeg',
        width       INTEGER,
        height      INTEGER,
        size        INTEGER NOT NULL DEFAULT 0,
        image       BLOB    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_page_images_page ON page_images(page_id)');
    const fkErrors233 = db.pragma('foreign_key_check');
    if (fkErrors233.length) {
      throw new Error(`Migration 233: foreign_key_check meldet ${fkErrors233.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 233').run();
    logger.info('DB-Migration auf Version 233 abgeschlossen (page_images — Manuskript-Bilder im Notebook-Editor).');
  }

  if (version < 234) {
    // Buchruecken-Bild fuer das separate Umschlag-PDF (druckfertiger PDF-Export).
    // BLOB direkt im Profil, analog cover_image/author_image/back_cover_image.
    // Erlaubt ein durchgehendes Motiv als Front/Ruecken/Rueckseite-Panels.
    // Additive Spalten, kein FK noetig.
    const pepCols234 = db.pragma('table_info(pdf_export_profile)').map(c => c.name);
    if (!pepCols234.includes('spine_image')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN spine_image BLOB').run();
    }
    if (!pepCols234.includes('spine_image_mime')) {
      db.prepare('ALTER TABLE pdf_export_profile ADD COLUMN spine_image_mime TEXT').run();
    }

    const fkErrors234 = db.pragma('foreign_key_check');
    if (fkErrors234.length) {
      throw new Error(`Migration 234: foreign_key_check meldet ${fkErrors234.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 234').run();
    logger.info('DB-Migration auf Version 234 abgeschlossen (pdf_export_profile.spine_image).');
  }

  if (version < 235) {
    // Eingefrorene Publikations-Metadaten pro Fassung: selbsttragende Kopie von
    // book_publication (Titelei-Texte + epub_*-Optionen + Cover/Autorfoto als
    // base64) zum Capture-Zeitpunkt. Fassungs-Export nutzt diese Kopie statt der
    // Live-Daten, Restore schreibt sie zurueck. Additive Spalte, kein FK noetig.
    const bsCols235 = db.pragma('table_info(book_snapshots)').map(c => c.name);
    if (!bsCols235.includes('publication_json')) {
      db.prepare('ALTER TABLE book_snapshots ADD COLUMN publication_json TEXT').run();
    }

    const fkErrors235 = db.pragma('foreign_key_check');
    if (fkErrors235.length) {
      throw new Error(`Migration 235: foreign_key_check meldet ${fkErrors235.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 235').run();
    logger.info('DB-Migration auf Version 235 abgeschlossen (book_snapshots.publication_json).');
  }

  if (version < 236) {
    // Fassung als veroeffentlichte Auflage markieren: published_at = Zeitpunkt der
    // Markierung (NULL = nicht veroeffentlicht). Kennzeichnet die Fassung, die als
    // Auflage erschienen ist (Publikations-Anker), und schuetzt sie vor dem
    // versehentlichen Loeschen. Additive Spalte, kein FK noetig.
    const bsCols236 = db.pragma('table_info(book_snapshots)').map(c => c.name);
    if (!bsCols236.includes('published_at')) {
      db.prepare('ALTER TABLE book_snapshots ADD COLUMN published_at TEXT').run();
    }

    const fkErrors236 = db.pragma('foreign_key_check');
    if (fkErrors236.length) {
      throw new Error(`Migration 236: foreign_key_check meldet ${fkErrors236.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 236').run();
    logger.info('DB-Migration auf Version 236 abgeschlossen (book_snapshots.published_at).');
  }

  if (version < 237) {
    // Share-Link-Zugriffsstatistik: eine Zeile pro Aufruf der SSR-Leseansicht.
    // ip_hash (SHA-256 + Server-Salt, gleiche Logik wie share_comments) traegt
    // eindeutige Besucher, ohne Klartext-IP zu speichern; duration_ms wird per
    // sendBeacon aus dem Reader nachgetragen (NULL = nie eingetroffen, z.B. Bot
    // ohne JS). view_count auf share_links bleibt der schnelle Gesamtzaehler.
    db.exec(`
      CREATE TABLE IF NOT EXISTS share_views (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
        ip_hash     TEXT,
        duration_ms INTEGER,
        viewed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_views_token ON share_views(share_token)');

    const fkErrors237 = db.pragma('foreign_key_check');
    if (fkErrors237.length) {
      throw new Error(`Migration 237: foreign_key_check meldet ${fkErrors237.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 237').run();
    logger.info('DB-Migration auf Version 237 abgeschlossen (share_views).');
  }

  if (version < 238) {
    // Share-Reader: Lesetiefe + Gesamt-Fazit.
    // (a) max_scroll_pct auf share_views — wie weit (0-100 %) ein Aufruf durch den
    //     geteilten Inhalt gescrollt ist (per Beacon nachgetragen, MAX-Merge).
    // (b) share_view_sections — pro Aufruf + Kapitel die erreichte Lesetiefe
    //     (0-100 %), Basis fuer die Kapitel-Drop-off-Kurve des Autors. chapter_id
    //     ist ein echter FK (kein Snapshot); Kapitelname kommt per JOIN.
    // (c) share_feedback — einmaliges Gesamt-Fazit pro Leser (reader_token):
    //     Sternewertung 1-5 + optionaler Freitext. UPSERT ueber (token, reader_token).
    const svCols = db.pragma('table_info(share_views)').map(c => c.name);
    if (!svCols.includes('max_scroll_pct')) {
      db.exec('ALTER TABLE share_views ADD COLUMN max_scroll_pct INTEGER');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS share_view_sections (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        view_id    INTEGER NOT NULL REFERENCES share_views(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        depth_pct  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(view_id, chapter_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_view_sections_view ON share_view_sections(view_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_view_sections_chapter ON share_view_sections(chapter_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS share_feedback (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        share_token  TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
        reader_token TEXT,
        reader_name  TEXT,
        rating       INTEGER NOT NULL,
        body         TEXT,
        ip_hash      TEXT,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(share_token, reader_token)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_feedback_token ON share_feedback(share_token)');

    const fkErrors238 = db.pragma('foreign_key_check');
    if (fkErrors238.length) {
      throw new Error(`Migration 238: foreign_key_check meldet ${fkErrors238.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 238').run();
    logger.info('DB-Migration auf Version 238 abgeschlossen (share_view_sections, share_feedback, max_scroll_pct).');
  }

  if (version < 239) {
    // Fehlerdichte-Trend über Fassungen: book_snapshots trägt beim Capture eine
    // verdichtete Lektorat-Kennzahl (offene/angenommene/alle Findings je Typ),
    // damit die Fehler-Heatmap-Karte den Verlauf über die Fassungen zeichnen kann,
    // ohne den MB-grossen extras_json-Blob auszuliefern.
    const bsCols = db.pragma('table_info(book_snapshots)').map(c => c.name);
    if (!bsCols.includes('lektorat_metrics')) {
      db.exec('ALTER TABLE book_snapshots ADD COLUMN lektorat_metrics TEXT');
    }

    // Backfill: die bestehenden Fassungen frieren die page_checks bereits in
    // extras_json ein → daraus dieselbe Kennzahl rückwirkend berechnen. Fassungen
    // ohne Lektorat-Extras bleiben NULL.
    const { computeLektoratMetrics } = require('../lib/lektorat-metrics');
    const snaps = db.prepare(
      'SELECT id, extras_json FROM book_snapshots WHERE extras_json IS NOT NULL AND lektorat_metrics IS NULL'
    ).all();
    const setMetrics = db.prepare('UPDATE book_snapshots SET lektorat_metrics = ? WHERE id = ?');
    let backfilled = 0;
    for (const s of snaps) {
      let checks;
      try { checks = JSON.parse(s.extras_json)?.lektorat?.pageChecks; }
      catch { continue; }
      if (!Array.isArray(checks) || !checks.length) continue;
      setMetrics.run(JSON.stringify(computeLektoratMetrics(checks)), s.id);
      backfilled += 1;
    }

    const fkErrors239 = db.pragma('foreign_key_check');
    if (fkErrors239.length) {
      throw new Error(`Migration 239: foreign_key_check meldet ${fkErrors239.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 239').run();
    logger.info(`DB-Migration auf Version 239 abgeschlossen (book_snapshots.lektorat_metrics, ${backfilled} Fassungen backfilled).`);
  }

  if (version < 240) {
    // Semantische Suche (Embeddings): pro Buch werden Seiten/Szenen/Figuren in
    // Chunks embeddet und als Float32-Vektor abgelegt. Reiner Ableitungs-Index —
    // jederzeit aus den Quelltabellen neu berechenbar (wie search_index/FTS),
    // darum ist entity_id polymorph nach `kind` (kein einzelner FK möglich); die
    // Aufräumung läuft explizit über db/semantic-chunks.js#remove beim Entity-
    // Delete, plus book_id-CASCADE als Netz beim Buch-Delete. content_hash trägt
    // den Delta-Cache (unveränderter Chunk → kein erneuter Embedding-Call), model
    // hält Mehr-Modell-Koexistenz beim Umstellen (Query filtert aufs aktive).
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL CHECK(kind IN ('page','scene','figure')),
        entity_id    INTEGER NOT NULL,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        chunk_ix     INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        model        TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        vector       BLOB NOT NULL,
        text         TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(kind, entity_id, chunk_ix, model)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_book ON semantic_chunks(book_id, kind)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_entity ON semantic_chunks(kind, entity_id)');

    const fkErrors240 = db.pragma('foreign_key_check');
    if (fkErrors240.length) {
      throw new Error(`Migration 240: foreign_key_check meldet ${fkErrors240.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 240').run();
    logger.info('DB-Migration auf Version 240 abgeschlossen (semantic_chunks).');
  }

  if (version < 241) {
    // Onboarding-Fortschritt pro User: app_users.onboarding_state (JSON-Blob).
    // Haelt nur den persistierten Teil — { welcomeDismissed, completed }; die
    // eigentlichen Checklisten-Schritte (Buch/Seite/Analyse/Teilen) werden
    // serverseitig aus echtem State abgeleitet (nicht hier gespeichert), damit
    // sie self-healing bleiben. Additiv: nullable Spalte, kein FK, kein Recreate.
    const auCols241 = db.pragma('table_info(app_users)').map(c => c.name);
    if (!auCols241.includes('onboarding_state')) {
      db.exec('ALTER TABLE app_users ADD COLUMN onboarding_state TEXT');
    }

    const fkErrors241 = db.pragma('foreign_key_check');
    if (fkErrors241.length) {
      throw new Error(`Migration 241: foreign_key_check meldet ${fkErrors241.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 241').run();
    logger.info('DB-Migration auf Version 241 abgeschlossen (app_users.onboarding_state).');
  }

  if (version < 242) {
    // Weltfakten-Realitätscheck: Opt-in pro Buch (book_settings.weltfakten_real_pruefen)
    // + Beleg-URL pro Kontinuitäts-Befund (continuity_issues.quelle). Das Flag ist bewusst
    // getrennt von zeitlinie_real — ein Buch kann eine reale Kalender-Chronologie haben,
    // seine Welt-Fakten aber bewusst fiktiv setzen (Alternate History). quelle hält die vom
    // Faktencheck zitierte Beleg-URL (Web-Suche); NULL bei allen anderen Befund-Typen.
    // Beides additiv: nullable/Default-0-Spalte, kein FK, kein Recreate.
    const bsCols242 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols242.includes('weltfakten_real_pruefen')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN weltfakten_real_pruefen INTEGER DEFAULT 0');
    }
    const ciCols242 = db.pragma('table_info(continuity_issues)').map(c => c.name);
    if (!ciCols242.includes('quelle')) {
      db.exec('ALTER TABLE continuity_issues ADD COLUMN quelle TEXT');
    }

    const fkErrors242 = db.pragma('foreign_key_check');
    if (fkErrors242.length) {
      throw new Error(`Migration 242: foreign_key_check meldet ${fkErrors242.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 242').run();
    logger.info('DB-Migration auf Version 242 abgeschlossen (book_settings.weltfakten_real_pruefen + continuity_issues.quelle).');
  }

  if (version < 243) {
    // Motiv-Werkstatt: planendes + überwachendes Pendant zur Themen-/Motivarbeit.
    // Der User katalogisiert Themen (Cluster) und Motive (die konkrete Nabe) und
    // verknüpft ein Motiv mit Figuren, Plot-Beats, Kapiteln und Seiten (Soll).
    // Eine KI-Motiverkennung (Job motif-scan) findet die tatsächlichen Fundstellen
    // im Text (Ist) → motif_occurrences. KI assistiert ausschliesslich planend/
    // überwachend, schreibt nie in den Text. Pro Buch + User skopiert.

    // Thema: abstrakter Cluster (Schuld & Vergebung, Preis der Freiheit).
    db.exec(`CREATE TABLE IF NOT EXISTS themes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        beschreibung TEXT,
        farbe        TEXT,
        position     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_themes_book ON themes(book_id, user_email)');

    // Motiv: die zentrale Nabe. theme_id SET NULL — ein Thema löschen lässt seine
    // Motive stehen (sie fallen in „ohne Thema"). trigger_terms hält als JSON-Array
    // wörtliche Trigger-Begriffe (Motiv „Wasser" → Regen, Fluss, ertrinken) für den
    // FTS-Teil der Erkennung; NULL/[] = rein semantisch.
    db.exec(`CREATE TABLE IF NOT EXISTS motifs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email    TEXT    NOT NULL,
        theme_id      INTEGER REFERENCES themes(id) ON DELETE SET NULL,
        name          TEXT    NOT NULL,
        beschreibung  TEXT,
        trigger_terms TEXT,
        farbe         TEXT,
        position      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motifs_book ON motifs(book_id, user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_motifs_theme ON motifs(theme_id)');

    // Motiv ↔ Motiv: gerichtete Beziehung mit Freitext-Typ (verstärkt/kontrastiert/
    // spiegelt) — die Kanten der Motiv-Konstellation. UNIQUE verhindert Duplikate.
    db.exec(`CREATE TABLE IF NOT EXISTS motif_relations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_motif_id INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        to_motif_id   INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        typ           TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (from_motif_id, to_motif_id, typ)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_relations_from ON motif_relations(from_motif_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_relations_to ON motif_relations(to_motif_id)');

    // Soll-Verknüpfungen: wo ein Motiv laut Plan auftauchen soll. Vier M:M-Bridges
    // auf Figur / Beat / Kapitel / Seite, alle CASCADE auf beiden Seiten (reiner Link).
    db.exec(`CREATE TABLE IF NOT EXISTS motif_figures (
        motif_id  INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        figure_id INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        PRIMARY KEY (motif_id, figure_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_figures_figure ON motif_figures(figure_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS motif_beats (
        motif_id INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        beat_id  INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        PRIMARY KEY (motif_id, beat_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_beats_beat ON motif_beats(beat_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS motif_chapters (
        motif_id   INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        chapter_id INTEGER NOT NULL REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        PRIMARY KEY (motif_id, chapter_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_chapters_chapter ON motif_chapters(chapter_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS motif_pages (
        motif_id INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        page_id  INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        PRIMARY KEY (motif_id, page_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_pages_page ON motif_pages(page_id)');

    // Ist (abgeleiteter Fund-Index): wo die Motiverkennung ein Motiv real im Text
    // gefunden hat. Voller Full-Replace pro Motiv bei jedem Scan (kein content_hash —
    // die Erkennung nutzt den bereits vorhandenen Embedding-/FTS-Index, ist billig).
    // kind + genau eine gesetzte Ref via CHECK (sentinel-frei). source: semantic
    // (Embedding-Cosinus) oder trigger (wörtlicher FTS-Treffer).
    db.exec(`CREATE TABLE IF NOT EXISTS motif_occurrences (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        motif_id   INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind       TEXT    NOT NULL CHECK(kind IN ('page','scene')),
        page_id    INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        scene_id   INTEGER REFERENCES figure_scenes(id) ON DELETE CASCADE,
        score      REAL,
        snippet    TEXT,
        source     TEXT    NOT NULL CHECK(source IN ('semantic','trigger')),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind = 'page'  AND page_id IS NOT NULL AND scene_id IS NULL) OR
          (kind = 'scene' AND scene_id IS NOT NULL AND page_id IS NULL)
        )
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_occurrences_motif ON motif_occurrences(motif_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_occurrences_book ON motif_occurrences(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_occurrences_page ON motif_occurrences(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_occurrences_scene ON motif_occurrences(scene_id)');

    const fkErrors243 = db.pragma('foreign_key_check');
    if (fkErrors243.length) {
      throw new Error(`Migration 243: foreign_key_check meldet ${fkErrors243.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 243').run();
    logger.info('DB-Migration auf Version 243 abgeschlossen (Motiv-Werkstatt: themes + motifs + motif_relations + 4 Bridges + motif_occurrences).');
  }

  if (version < 244) {
    // Motiv-Werkstatt: manuelle Knoten-Positionen der Konstellation persistieren.
    // Reine View-Präferenz (pro Buch + User): ein von Hand gezogenes Layout soll
    // über Reload/Datenänderung hinweg erhalten bleiben. Kein Row-pro-Knoten —
    // node_id ist ein Render-Token wie "m12"/"t3" (kein FK-fähiges Entitäts-Ziel),
    // darum ein JSON-Blob node_id → {x,y} je (book_id, user_email). Keine losen
    // *_id-Spalten; book_id ist der einzige Ref und via FK gebunden (CASCADE).
    db.exec(`CREATE TABLE IF NOT EXISTS motif_graph_layout (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id        INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email     TEXT    NOT NULL,
        positions_json TEXT    NOT NULL DEFAULT '{}',
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (book_id, user_email)
      )`);
    // UNIQUE(book_id, user_email) indiziert book_id bereits (Präfix) → kein Extra-Index.

    const fkErrors244 = db.pragma('foreign_key_check');
    if (fkErrors244.length) {
      throw new Error(`Migration 244: foreign_key_check meldet ${fkErrors244.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 244').run();
    logger.info('DB-Migration auf Version 244 abgeschlossen (Motiv-Werkstatt: motif_graph_layout).');
  }

  if (version < 245) {
    // Motiv-Werkstatt: fünfte Soll-Brücke Motiv ↔ Werkstatt-Figur (draft_figures).
    // Neben den Komplettanalyse-Figuren (motif_figures → figures) sollen auch die
    // in der Plot-/Figuren-Werkstatt gebrainstormten Figuren als Soll-Ziel eines
    // Motivs verknüpfbar sein. Eigene M:M-Brücke (draft_figures ist eine eigene
    // Tabelle, kein figures-Eintrag), beidseitig CASCADE wie die vier bestehenden.
    db.exec(`CREATE TABLE IF NOT EXISTS motif_draft_figures (
        motif_id        INTEGER NOT NULL REFERENCES motifs(id) ON DELETE CASCADE,
        draft_figure_id INTEGER NOT NULL REFERENCES draft_figures(id) ON DELETE CASCADE,
        PRIMARY KEY (motif_id, draft_figure_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_motif_draft_figures_draft ON motif_draft_figures(draft_figure_id)');

    const fkErrors245 = db.pragma('foreign_key_check');
    if (fkErrors245.length) {
      throw new Error(`Migration 245: foreign_key_check meldet ${fkErrors245.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 245').run();
    logger.info('DB-Migration auf Version 245 abgeschlossen (Motiv-Werkstatt: motif_draft_figures).');
  }

  if (version < 246) {
    // Motiv-Werkstatt: Historie der KI-Brainstorm-Laeufe, pro (Buch, User)
    // skopiert — analog plot_consistency_runs. Der Motiv-Brainstorm ist buchweit
    // (schlaegt neue Motive/Themen vor, haengt an keinem einzelnen Motiv), darum
    // kein Sub-Scope. book_id CASCADE — die Historie stirbt mit dem Buch.
    // result_json = { vorschlaege[] }; vorschlag_count denormalisiert fuers Listen-
    // Rendering (Liste kommt ohne result_json).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS motif_brainstorm_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email      TEXT    NOT NULL,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        vorschlag_count INTEGER NOT NULL DEFAULT 0,
        result_json     TEXT    NOT NULL,
        model           TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_mbr_book_user_date ON motif_brainstorm_runs(book_id, user_email, created_at DESC)').run();

    const fkErrors246 = db.pragma('foreign_key_check');
    if (fkErrors246.length) {
      throw new Error(`Migration 246: foreign_key_check meldet ${fkErrors246.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 246').run();
    logger.info('DB-Migration auf Version 246 abgeschlossen (Motiv-Werkstatt: motif_brainstorm_runs).');
  }

  if (version < 247) {
    // Plot-Werkstatt: abgeleiteter Ist-Index der Beat-Verankerung — wo ein geplan-
    // ter Beat semantisch/woertlich im Buchtext auftaucht. Pendant zu
    // motif_occurrences: Full-Replace pro Beat je Anchor-Lauf (kein content_hash,
    // die Erkennung nutzt den bestehenden Embedding-/FTS-Index und ist billig).
    // Rein rueckwaertsgewandt — Ableitung, nie generativ. beat_id CASCADE (stirbt
    // mit dem Beat), book_id CASCADE. kind page/scene sentinel-frei via CHECK.
    db.exec(`CREATE TABLE IF NOT EXISTS plot_beat_occurrences (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        beat_id    INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind       TEXT    NOT NULL CHECK(kind IN ('page','scene')),
        page_id    INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        scene_id   INTEGER REFERENCES figure_scenes(id) ON DELETE CASCADE,
        score      REAL,
        snippet    TEXT,
        source     TEXT    NOT NULL CHECK(source IN ('semantic','trigger')),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind = 'page'  AND page_id IS NOT NULL AND scene_id IS NULL) OR
          (kind = 'scene' AND scene_id IS NOT NULL AND page_id IS NULL)
        )
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_occ_beat ON plot_beat_occurrences(beat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_occ_book ON plot_beat_occurrences(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_occ_page ON plot_beat_occurrences(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_occ_scene ON plot_beat_occurrences(scene_id)');

    const fkErrors247 = db.pragma('foreign_key_check');
    if (fkErrors247.length) {
      throw new Error(`Migration 247: foreign_key_check meldet ${fkErrors247.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 247').run();
    logger.info('DB-Migration auf Version 247 abgeschlossen (Plot-Werkstatt: plot_beat_occurrences).');
  }

  if (version < 248) {
    // Motiv-Werkstatt: Delta-Cache fuer den KI-Brainstorm (umfangreicher callAI-
    // Pfad). Analog chapter_extract_cache/book_extract_cache: pro Chunk der rohe
    // Modell-Output, keyed auf pages_sig (page_id:updated_at + Buch-Settings +
    // Kapitelname + Modell/Prompt-Version). Ein Re-Run liest nur Kapitel neu,
    // deren Signatur sich aenderte. pages_sig ist bewusst NICHT Teil des PK →
    // INSERT OR REPLACE ueberschreibt die Chunk-Zeile bei Aenderung (keine
    // Akkumulation). chunk_key ist eine opake Cache-Adresse ('<chapter_id>' |
    // '<chapter_id>__sub<N>' | '__ungrouped__' | '__singlepass__'), kein Domaenen-
    // Diskriminator. Roher Output (VOR seen-Dedup) → die Dedup gegen Katalog +
    // Cross-Chunk laeuft jeden Lauf frisch, unabhaengig davon welche Chunks HIT
    // sind. book_id CASCADE (Cache stirbt mit dem Buch). Provider im PK →
    // kein Cross-Provider-Bleeding.
    db.exec(`CREATE TABLE IF NOT EXISTS motif_brainstorm_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        provider    TEXT    NOT NULL DEFAULT '',
        chunk_key   TEXT    NOT NULL,
        pages_sig   TEXT    NOT NULL,
        result_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, provider, chunk_key)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mbc_book_user ON motif_brainstorm_cache(book_id, user_email)');

    const fkErrors248 = db.pragma('foreign_key_check');
    if (fkErrors248.length) {
      throw new Error(`Migration 248: foreign_key_check meldet ${fkErrors248.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 248').run();
    logger.info('DB-Migration auf Version 248 abgeschlossen (Motiv-Werkstatt: motif_brainstorm_cache).');
  }

  if (version < 249) {
    // Plot-Werkstatt: gerichtete Beat-zu-Beat-Beziehungen (Kausalitaet + Setup/
    // Payoff). Kante from_beat --typ--> to_beat; `typ` ist Freitext (kuratierte
    // Vorschlaege im Frontend, analog figure_relations.typ). So werden Kausalketten
    // und Tschechows-Gewehr-Paare explizit modellierbar — der Consistency-Check
    // liest sie als Kontext (haengender Setup ohne Payoff, Wirkung vor Ursache,
    // im_buch-Beat, der auf einen noch geplanten Beat baut). book_id CASCADE (stirbt
    // mit dem Buch); from/to CASCADE (Kante stirbt mit einem der Beats). UNIQUE
    // verhindert Duplikat-Kanten gleichen Typs. Pro Buch + User skopiert (user_email).
    db.exec(`CREATE TABLE IF NOT EXISTS plot_beat_relations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL,
        from_beat_id INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        to_beat_id   INTEGER NOT NULL REFERENCES plot_beats(id) ON DELETE CASCADE,
        typ          TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (from_beat_id, to_beat_id, typ)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_rel_book ON plot_beat_relations(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_rel_from ON plot_beat_relations(from_beat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plot_beat_rel_to ON plot_beat_relations(to_beat_id)');

    const fkErrors249 = db.pragma('foreign_key_check');
    if (fkErrors249.length) {
      throw new Error(`Migration 249: foreign_key_check meldet ${fkErrors249.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 249').run();
    logger.info('DB-Migration auf Version 249 abgeschlossen (Plot-Werkstatt: plot_beat_relations).');
  }

  if (version < 250) {
    // Zwei lose *_id-Spalten nachgeruestet (harte Regel „Relationale Integritaet"):
    // beide waren NOT NULL und Teil des PK, aber ohne REFERENCES. SQLite kennt kein
    // ALTER TABLE ADD CONSTRAINT → Recreate-Pattern.
    //
    // user_page_usage.page_id → pages CASCADE: die Zeile ist eine reine Ableitung
    // (Recency-Sortierung der Command-Palette) und gehoert der Seite. Ohne FK
    // ueberlebt sie deren Loeschung und liefert einen Palette-Eintrag ins Nichts;
    // gedeckt war nur der Buch-Delete (book_id CASCADE).
    // chapter_extract_cache.book_id → books CASCADE: Cache gehoert dem Buch. Gedeckt
    // war er nur transitiv ueber chapter_id, also nicht fuer Pfade, die Buch-Zeilen
    // ohne zugehoerige Kapitel-Zeilen entfernen.
    db.pragma('foreign_keys = OFF');

    // Pre-Cleanup, sonst schlaegt der foreign_key_check am Blockende fehl.
    db.exec('DELETE FROM user_page_usage WHERE page_id NOT IN (SELECT page_id FROM pages)');
    db.exec('DELETE FROM chapter_extract_cache WHERE book_id NOT IN (SELECT book_id FROM books)');

    db.exec('DROP TABLE IF EXISTS user_page_usage_new');
    db.exec(`
      CREATE TABLE user_page_usage_new (
        user_email TEXT    NOT NULL,
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        last_used  INTEGER NOT NULL,
        use_count  INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_email, page_id),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      );
    `);
    db.exec(`INSERT INTO user_page_usage_new (user_email, page_id, book_id, last_used, use_count)
               SELECT user_email, page_id, book_id, last_used, use_count FROM user_page_usage`);
    db.exec('DROP TABLE user_page_usage');
    db.exec('ALTER TABLE user_page_usage_new RENAME TO user_page_usage');
    db.exec('CREATE INDEX IF NOT EXISTS idx_upu_user_book_lastused ON user_page_usage(user_email, book_id, last_used DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_upu_page ON user_page_usage(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_upu_book ON user_page_usage(book_id)');

    db.exec('DROP TABLE IF EXISTS chapter_extract_cache_new');
    db.exec(`
      CREATE TABLE chapter_extract_cache_new (
        book_id      INTEGER NOT NULL REFERENCES books(book_id)          ON DELETE CASCADE,
        user_email   TEXT    NOT NULL DEFAULT '',
        chapter_id   INTEGER NOT NULL REFERENCES chapters(chapter_id)    ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        provider     TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL,
        PRIMARY KEY (book_id, user_email, chapter_id, phase, provider),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      );
    `);
    db.exec(`INSERT INTO chapter_extract_cache_new
        (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
        SELECT book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at
          FROM chapter_extract_cache`);
    db.exec('DROP TABLE chapter_extract_cache');
    db.exec('ALTER TABLE chapter_extract_cache_new RENAME TO chapter_extract_cache');

    db.pragma('foreign_keys = ON');

    // FK-Spalten ohne jede Index-Deckung: ein Parent-Delete musste das Kind voll
    // scannen, um CASCADE/SET NULL anzuwenden.
    db.exec('CREATE INDEX IF NOT EXISTS idx_page_checks_chapter ON page_checks(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_locations_erste_page ON locations(erste_erwaehnung_page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_songs_erste_page ON songs(erste_erwaehnung_page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_share_comments_author ON share_comments(author_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_regreq_invite ON registration_requests(invite_id)');

    // FK-Spalten, die nur an nicht-fuehrender Position eines Composite-PK lagen —
    // fuer den Index unbrauchbar. Nachgezogen werden die Kanten, die bei
    // alltaeglichen Inhalts-Loeschungen (Seite, Kapitel, Ort, Figur, Geraet)
    // cascaden. Die verbleibenden user_email-Kanten bleiben bewusst unindiziert:
    // sie greifen nur beim Loeschen eines Users (Admin-Einzelfall) und die Spalte
    // ist so niedrig-kardinal, dass ein Index dort nichts spart.
    db.exec('CREATE INDEX IF NOT EXISTS idx_cec_chapter ON chapter_extract_cache(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_crc_chapter ON chapter_review_cache(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cmrc_chapter ON chapter_macro_review_cache(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chapter_reviews_chapter ON chapter_reviews(chapter_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_lektorat_cache_page ON lektorat_cache(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_checkpoints_book ON job_checkpoints(book_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_scene_locations_location ON scene_locations(location_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_song_figures_figure ON song_figures(figure_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_page_presence_device ON page_presence(device_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_book_presence_device ON book_presence(device_id)');

    const fkErrors250 = db.pragma('foreign_key_check');
    if (fkErrors250.length) {
      throw new Error(`Migration 250: foreign_key_check meldet ${fkErrors250.length} Verstoesse: ${JSON.stringify(fkErrors250.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 250').run();
    logger.info('DB-Migration auf Version 250 abgeschlossen (FK user_page_usage.page_id + chapter_extract_cache.book_id, 15 fehlende FK-Indexe).');
  }

  if (version < 251) {
    // semantic_chunks referenziert seine Quell-Entitaet jetzt DB-erzwungen. Die
    // Tabelle ist mit Abstand der groesste Ableitungs-Index des Schemas; die
    // Referenz hing bisher an einer untypisierten entity_id ohne REFERENCES,
    // durchgesetzt allein von der Disziplin des embed-index-Jobs.
    //
    // Modelliert nach motif_occurrences: `kind` als Diskriminator, dazu drei
    // typisierte nullable Spalten mit CASCADE-FK und ein CHECK, der genau die zu
    // `kind` passende Spalte verlangt (sentinel-frei, siehe CLAUDE.md
    // „Sentinel-freie Modellierung"). Ein Seiten-/Szenen-/Figuren-Delete raeumt
    // seine Vektoren damit selbst auf.
    //
    // entity_id bleibt als VIRTUAL GENERATED COLUMN (COALESCE der drei) erhalten:
    // die Lesepfade in db/semantic-chunks.js fragen polymorph ab (WHERE kind = ?
    // AND entity_id = ?, COUNT(DISTINCT entity_id), JOIN figures ON f.id =
    // sc.entity_id) und bleiben unveraendert gueltig, waehrend Schreibzugriffe
    // ueber die typisierten Spalten laufen. Die Spalte ist damit abgeleitet statt
    // dupliziert — sie kann nicht von den FK-Spalten abdriften. UNIQUE sitzt als
    // benannter Index auf der generierten Spalte (Table-Constraints koennen keine
    // generierte Spalte referenzieren).
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS semantic_chunks_new');
    db.exec(`
      CREATE TABLE semantic_chunks_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT    NOT NULL CHECK(kind IN ('page','scene','figure')),
        book_id      INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_id      INTEGER REFERENCES pages(page_id)                ON DELETE CASCADE,
        scene_id     INTEGER REFERENCES figure_scenes(id)             ON DELETE CASCADE,
        figure_id    INTEGER REFERENCES figures(id)                   ON DELETE CASCADE,
        entity_id    INTEGER GENERATED ALWAYS AS (COALESCE(page_id, scene_id, figure_id)) VIRTUAL,
        chunk_ix     INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT    NOT NULL,
        model        TEXT    NOT NULL,
        dim          INTEGER NOT NULL,
        vector       BLOB    NOT NULL,
        text         TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind = 'page'   AND page_id   IS NOT NULL AND scene_id IS NULL AND figure_id IS NULL) OR
          (kind = 'scene'  AND scene_id  IS NOT NULL AND page_id  IS NULL AND figure_id IS NULL) OR
          (kind = 'figure' AND figure_id IS NOT NULL AND page_id  IS NULL AND scene_id  IS NULL)
        )
      );
    `);
    // Fan-out der bisherigen entity_id in die typisierte Spalte. Die WHERE-Klausel
    // ist gleichzeitig das Pre-Cleanup: Chunks ohne existierende Quell-Entitaet
    // fallen weg. Verlustfrei, weil der Index jederzeit per embed-index-Job neu
    // berechenbar ist.
    db.exec(`INSERT INTO semantic_chunks_new
        (id, kind, book_id, page_id, scene_id, figure_id, chunk_ix, content_hash, model, dim, vector, text, created_at)
        SELECT id, kind, book_id,
               CASE WHEN kind = 'page'   THEN entity_id END,
               CASE WHEN kind = 'scene'  THEN entity_id END,
               CASE WHEN kind = 'figure' THEN entity_id END,
               chunk_ix, content_hash, model, dim, vector, text, created_at
          FROM semantic_chunks
         WHERE (kind = 'page'   AND entity_id IN (SELECT page_id FROM pages))
            OR (kind = 'scene'  AND entity_id IN (SELECT id FROM figure_scenes))
            OR (kind = 'figure' AND entity_id IN (SELECT id FROM figures))`);
    const scDropped = db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks').get().n
                    - db.prepare('SELECT COUNT(*) AS n FROM semantic_chunks_new').get().n;
    db.exec('DROP TABLE semantic_chunks');
    db.exec('ALTER TABLE semantic_chunks_new RENAME TO semantic_chunks');

    // idx_semchunk_entity (kind, entity_id) entfaellt: der UNIQUE-Index hat
    // dieselbe fuehrende Spaltenfolge und deckt jede Abfrage darauf mit ab.
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_semchunk_uniq ON semantic_chunks(kind, entity_id, chunk_ix, model)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_book ON semantic_chunks(book_id, kind)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_page ON semantic_chunks(page_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_scene ON semantic_chunks(scene_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_semchunk_figure ON semantic_chunks(figure_id)');

    db.pragma('foreign_keys = ON');
    const fkErrors251 = db.pragma('foreign_key_check');
    if (fkErrors251.length) {
      throw new Error(`Migration 251: foreign_key_check meldet ${fkErrors251.length} Verstoesse: ${JSON.stringify(fkErrors251.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 251').run();
    logger.info(`DB-Migration auf Version 251 abgeschlossen (semantic_chunks: typisierte FK-Spalten + kind-CHECK, entity_id generiert; ${scDropped} verwaiste Chunks entfernt).`);
  }

  if (version < 252) {
    // Quellenverzeichnis (wissenschaftliche Arbeiten + Blog mit Belegen).
    //
    // book_sources: die Quelle selbst, buchweit GETEILT (wie research_items) —
    // `user_email` ist reine Ersteller-Attribution, kein Sichtbarkeits-Scope.
    // Zwingend so: der Beleg-Marker lebt im Seiten-HTML und ist damit fuer alle
    // Editoren des Buchs sichtbar; eine user-private Quelle wuerde bei einem
    // Co-Autor als Beleg ohne Ziel erscheinen.
    //
    // Feldschnitt an CSL-JSON angelehnt (csl_type + authors/editors als JSON-
    // Array [{family,given}|{literal}]). Damit sind BibTeX-/RIS-Import, DOI-
    // Lookup und ein Zitierstil-Wechsel reine Mappings statt Schema-Aenderungen.
    // `year` ist TEXT, nicht INTEGER: Literaturangaben tragen 'o. J.',
    // '2019/2021' oder 'im Druck'. citekey ist nullable + UNIQUE pro Buch
    // (SQLite zaehlt NULLs in UNIQUE als verschieden → beliebig viele ohne Key).
    db.exec(`CREATE TABLE IF NOT EXISTS book_sources (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id         INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email      TEXT    NOT NULL,
        csl_type        TEXT    NOT NULL DEFAULT 'book'
                          CHECK(csl_type IN ('book','chapter','article','website','thesis',
                                             'report','legal','interview','film','dataset','other')),
        citekey         TEXT,
        authors         TEXT    NOT NULL DEFAULT '[]',
        editors         TEXT    NOT NULL DEFAULT '[]',
        title           TEXT,
        container_title TEXT,
        publisher       TEXT,
        place           TEXT,
        year            TEXT,
        edition         TEXT,
        volume          TEXT,
        issue           TEXT,
        pages           TEXT,
        doi             TEXT,
        isbn            TEXT,
        issn            TEXT,
        url             TEXT,
        accessed_at     TEXT,
        note            TEXT,
        archived        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_book_sources_book ON book_sources(book_id, archived)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_book_sources_citekey ON book_sources(book_id, citekey)');

    // source_citations: reiner Ableitungs-Index „welche Quelle wird auf welcher
    // Seite belegt". Wahrheit ist der Marker im Seiten-HTML; diese Tabelle wird
    // pro Seiten-Write per Full-Replace neu geschrieben (Muster
    // page_figure_mentions / motif_occurrences). Beide FKs CASCADE — der Index
    // ist jederzeit aus dem Seiten-HTML neu berechenbar.
    //
    // Kein book_id: der Schreibpfad arbeitet pro Seite (DELETE … WHERE page_id),
    // Buch-Abfragen laufen ueber den JOIN auf book_sources. Eine zweite
    // Buch-Referenz koennte von source_id abdriften.
    db.exec(`CREATE TABLE IF NOT EXISTS source_citations (
        source_id    INTEGER NOT NULL REFERENCES book_sources(id) ON DELETE CASCADE,
        page_id      INTEGER NOT NULL REFERENCES pages(page_id)   ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (source_id, page_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_source_citations_page ON source_citations(page_id)');

    // Verzeichnis-Einstellungen pro Buch — bewusst in book_settings und NICHT im
    // Exportprofil: Zitierstil und Verzeichnis gelten fuer alle Ausgabewege
    // (PDF, DOCX, WordPress, HubSpot) gleichzeitig. Ein Buch darf nicht je
    // Exportprofil anders zitieren.
    //   citation_style       apa7 | chicago-ad | numeric
    //   bibliography_scope   cited = nur belegte Quellen | all = auch unzitierte
    //   bibliography_in_blog Verzeichnis an Blog-/HubSpot-Posts anhaengen
    //                        (dort ist die gerenderte Einheit die Seite = ein Post)
    // Alles additiv: nullable bzw. NOT NULL DEFAULT, kein FK, kein Recreate.
    const bsCols252 = db.pragma('table_info(book_settings)').map(c => c.name);
    if (!bsCols252.includes('citation_style')) {
      db.exec("ALTER TABLE book_settings ADD COLUMN citation_style TEXT DEFAULT 'apa7'");
    }
    if (!bsCols252.includes('bibliography_enabled')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN bibliography_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!bsCols252.includes('bibliography_title')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN bibliography_title TEXT');
    }
    if (!bsCols252.includes('bibliography_scope')) {
      db.exec("ALTER TABLE book_settings ADD COLUMN bibliography_scope TEXT DEFAULT 'cited'");
    }
    if (!bsCols252.includes('bibliography_in_blog')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN bibliography_in_blog INTEGER NOT NULL DEFAULT 0');
    }

    const fkErrors252 = db.pragma('foreign_key_check');
    if (fkErrors252.length) {
      throw new Error(`Migration 252: foreign_key_check meldet ${fkErrors252.length} Verstoesse.`);
    }
    db.prepare('UPDATE schema_version SET version = 252').run();
    logger.info('DB-Migration auf Version 252 abgeschlossen (Quellenverzeichnis: book_sources + source_citations + book_settings.citation_*/bibliography_*).');
  }

  if (version < 253) {
    // Quellen werden zur persoenlichen Bibliothek: User-Pool + M:N-Bruecke ans Buch.
    //
    // Warum: eine Literaturbibliothek ist personen-, nicht werkgebunden. Wer drei
    // Arbeiten mit ueberlappender Literatur schreibt, gibt dieselbe Quelle sonst
    // dreimal ein und pflegt sie dreimal. Dasselbe Muster faehrt die App schon
    // beim Kategorie-Pool (book_categories); Quellen brauchen zusaetzlich eine
    // Bruecke, weil ein Buch viele Pool-Quellen nutzt.
    //
    //   sources             die Quelle, EINMAL pro User (`owner_email`)
    //   book_source_links   welches Buch nutzt welche Quelle (M:N)
    //
    // `owner_email` ist echter Besitz-Scope (nicht bloss Attribution wie zuvor
    // `book_sources.user_email`): geschrieben wird eine Quelle nur vom Besitzer,
    // sonst aendert ein Co-Autor sie in dessen anderen Buechern mit. Lesen und
    // Ver-/Entknuepfen bleiben an der Buch-ACL — der Quellen-Marker im Seiten-HTML
    // muss fuer jeden Editor des Buchs aufloesbar bleiben.
    //
    // Bewusst KEIN FK auf app_users(email): E-Mail-Spalten sind in diesem Schema
    // durchgehend FK-frei (pdf_export_profile.user_email, research_items.user_email,
    // book_sources.user_email zuvor). Ein CASCADE haette hier ausserdem die
    // Bibliothek eines geloeschten Users samt aller Buch-Verknuepfungen
    // mitgerissen, auch in Buechern von Co-Autoren.
    db.exec(`CREATE TABLE IF NOT EXISTS sources (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_email     TEXT    NOT NULL,
        csl_type        TEXT    NOT NULL DEFAULT 'book'
                          CHECK(csl_type IN ('book','chapter','article','website','thesis',
                                             'report','legal','interview','film','dataset','other')),
        citekey         TEXT,
        authors         TEXT    NOT NULL DEFAULT '[]',
        editors         TEXT    NOT NULL DEFAULT '[]',
        title           TEXT,
        container_title TEXT,
        publisher       TEXT,
        place           TEXT,
        year            TEXT,
        edition         TEXT,
        volume          TEXT,
        issue           TEXT,
        pages           TEXT,
        doi             TEXT,
        isbn            TEXT,
        issn            TEXT,
        url             TEXT,
        accessed_at     TEXT,
        note            TEXT,
        archived        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`);

    // Bruecke Buch ↔ Pool-Quelle. `added_by` ist reine Attribution (wer hat die
    // Quelle diesem Buch hinzugefuegt) und deshalb ohne FK — siehe oben.
    db.exec(`CREATE TABLE IF NOT EXISTS book_source_links (
        book_id    INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        source_id  INTEGER NOT NULL REFERENCES sources(id)    ON DELETE CASCADE,
        added_by   TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, source_id)
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_book_source_links_source ON book_source_links(source_id)');

    // Umzug der Bestandsdaten. `id` wird BEWUSST uebernommen: der Quellen-Marker
    // im Seiten-HTML traegt sie als `data-src`, und source_citations.source_id
    // zeigt darauf. Eine Neuvergabe wuerde jeden bereits gesetzten Beleg ins
    // Leere zeigen lassen.
    const hasOld253 = db.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='book_sources'"
    ).get();
    let moved253 = 0;
    if (hasOld253) {
      const cols253 = [
        'csl_type', 'citekey', 'authors', 'editors', 'title', 'container_title',
        'publisher', 'place', 'year', 'edition', 'volume', 'issue', 'pages',
        'doi', 'isbn', 'issn', 'url', 'accessed_at', 'note', 'archived',
        'created_at', 'updated_at',
      ].join(', ');
      moved253 = db.prepare(
        `INSERT INTO sources (id, owner_email, ${cols253})
         SELECT id, user_email, ${cols253} FROM book_sources`
      ).run().changes;
      db.exec(`INSERT INTO book_source_links (book_id, source_id, added_by, created_at)
               SELECT book_id, id, user_email, created_at FROM book_sources`);
    }

    // Der Zitierschluessel war pro BUCH eindeutig und wird pro POOL eindeutig.
    // Wer denselben Key in zwei Buechern benutzt hat, haette sonst einen
    // UNIQUE-Verstoss — der spaetere Eintrag verliert den Key statt die Quelle.
    db.exec(`
      UPDATE sources SET citekey = NULL
       WHERE citekey IS NOT NULL
         AND id NOT IN (SELECT MIN(id) FROM sources
                         WHERE citekey IS NOT NULL GROUP BY owner_email, citekey)
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources(owner_email, archived)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_citekey ON sources(owner_email, citekey)');

    // source_citations zeigte auf book_sources — FK umhaengen via Recreate.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE IF EXISTS source_citations_new');
    db.exec(`CREATE TABLE source_citations_new (
        source_id    INTEGER NOT NULL REFERENCES sources(id)   ON DELETE CASCADE,
        page_id      INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        count        INTEGER NOT NULL DEFAULT 0,
        first_offset INTEGER,
        PRIMARY KEY (source_id, page_id)
      )`);
    db.exec(`INSERT INTO source_citations_new (source_id, page_id, count, first_offset)
             SELECT sc.source_id, sc.page_id, sc.count, sc.first_offset
               FROM source_citations sc
               JOIN sources s ON s.id = sc.source_id`);
    db.exec('DROP TABLE source_citations');
    db.exec('ALTER TABLE source_citations_new RENAME TO source_citations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_source_citations_page ON source_citations(page_id)');

    if (hasOld253) db.exec('DROP TABLE book_sources');
    db.pragma('foreign_keys = ON');

    const fkErrors253 = db.pragma('foreign_key_check');
    if (fkErrors253.length) {
      throw new Error(`Migration 253: foreign_key_check meldet ${fkErrors253.length} Verstoesse: ${JSON.stringify(fkErrors253.slice(0, 5))}`);
    }
    db.prepare('UPDATE schema_version SET version = 253').run();
    logger.info(`DB-Migration auf Version 253 abgeschlossen (Quellen als User-Pool: sources + book_source_links; ${moved253} Quelle(n) uebernommen).`);
  }

  // Schutzchecks: idempotent bei jedem Start.
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

module.exports = { runMigrations };
