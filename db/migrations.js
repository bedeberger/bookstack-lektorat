const { db } = require('./connection');
const logger = require('../logger');

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

  CREATE TABLE IF NOT EXISTS figure_events (
    figure_id  INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
    datum      TEXT NOT NULL,
    ereignis   TEXT NOT NULL,
    bedeutung  TEXT,
    typ        TEXT DEFAULT 'persoenlich',
    sort_order INTEGER DEFAULT 0
  );

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

module.exports = { runMigrations };
