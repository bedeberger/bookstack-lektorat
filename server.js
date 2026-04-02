require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const Database = require('better-sqlite3');

const LOG_FILE = path.join(__dirname, 'lektorat.log');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE, maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
    new winston.transports.Console(),
  ],
});

const app = express();
const PORT = process.env.PORT || 3737;
const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// --- SQLite DB ---
const DB_FILE = path.join(__dirname, 'lektorat.db');
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

  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
`);

// Schema-Migrationen (versioniert)
const CURRENT_SCHEMA_VERSION = 1;
function runMigrations() {
  const { version } = db.prepare('SELECT version FROM schema_version').get();
  // Beispiel für zukünftige Migration auf Version 2:
  // if (version < 2) {
  //   db.exec('ALTER TABLE figures ADD COLUMN wohnort TEXT');
  //   db.prepare('UPDATE schema_version SET version = 2').run();
  //   logger.info('DB-Migration auf Version 2 abgeschlossen.');
  // }
  if (version < CURRENT_SCHEMA_VERSION) {
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
  }
}
runMigrations();

// Einmalige Migration von lektorat-history.json
function migrateFromJson() {
  const HISTORY_FILE = path.join(__dirname, 'lektorat-history.json');
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
        _saveFigurenToDb(parseInt(bookId), entry.figuren);
      }
    }
  })();

  fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.migrated');
  logger.info('Migration von lektorat-history.json abgeschlossen (Datei umbenannt zu .migrated).');
}
migrateFromJson();

// Figuren in DB schreiben (wird von PUT-Endpoint und Migration genutzt)
function _saveFigurenToDb(bookId, figuren) {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM figures WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM figure_relations WHERE book_id = ?').run(bookId);

    const insFig = db.prepare(`
      INSERT INTO figures (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insTag = db.prepare('INSERT INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insApp = db.prepare('INSERT INTO figure_appearances (figure_id, chapter_name, haeufigkeit) VALUES (?, ?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung) VALUES (?, ?, ?, ?, ?)');

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.beschreibung || null, i, now
      );
      for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
      for (const app of (f.kapitel || [])) insApp.run(fid, app.name, app.haeufigkeit || 1);
      for (const bz of (f.beziehungen || [])) insRel.run(bookId, f.id, bz.figur_id, bz.typ, bz.beschreibung || null);
    }
  })();
}

// ---

const jsonBody = express.json();

// --- Request-Logging ---
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// --- Config ---
app.get('/config', (_req, res) => {
  res.json({
    tokenId: process.env.TOKEN_ID || '',
    tokenPw: process.env.TOKEN_KENNWORT || '',
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    claudeMaxTokens: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6'
  });
});

// --- History: Seitenlektorat ---
app.post('/history/check', jsonBody, (req, res) => {
  const { page_id, page_name, book_id, error_count, errors_json, stilanalyse, fazit, model } = req.body;
  const result = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    page_id, page_name, book_id,
    new Date().toISOString(),
    error_count || 0,
    JSON.stringify(errors_json || []),
    stilanalyse || null, fazit || null, model || null
  );
  res.json({ id: result.lastInsertRowid });
});

app.patch('/history/check/:id/saved', jsonBody, (req, res) => {
  db.prepare('UPDATE page_checks SET saved = 1, saved_at = ? WHERE id = ?')
    .run(new Date().toISOString(), parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/history/page/:page_id', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM page_checks WHERE page_id = ?
    ORDER BY checked_at DESC LIMIT 20`).all(parseInt(req.params.page_id));
  res.json(rows.map(r => ({ ...r, errors_json: JSON.parse(r.errors_json || '[]'), saved: !!r.saved })));
});

// --- History: Buchbewertung ---
app.post('/history/review', jsonBody, (req, res) => {
  const { book_id, book_name, review_json, model } = req.body;
  const result = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model)
    VALUES (?, ?, ?, ?, ?)`).run(
    book_id, book_name,
    new Date().toISOString(),
    JSON.stringify(review_json || null),
    model || null
  );
  res.json({ id: result.lastInsertRowid });
});

app.get('/history/review/:book_id', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM book_reviews WHERE book_id = ?
    ORDER BY reviewed_at DESC LIMIT 10`).all(parseInt(req.params.book_id));
  res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
});

// --- Figuren ---
app.get('/figures/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const figs = db.prepare('SELECT * FROM figures WHERE book_id = ? ORDER BY sort_order, id').all(bookId);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id WHERE f.book_id = ?`).all(bookId);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_name, fa.haeufigkeit FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id WHERE f.book_id = ?`).all(bookId);
  const rels = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ, beschreibung FROM figure_relations WHERE book_id = ?'
  ).all(bookId);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const relMap = {};
  for (const r of rels) (relMap[r.from_fig_id] ??= []).push({ figur_id: r.to_fig_id, typ: r.typ, beschreibung: r.beschreibung });

  const figuren = figs.map(f => ({
    id: f.fig_id,
    name: f.name,
    kurzname: f.kurzname,
    typ: f.typ,
    geburtstag: f.geburtstag,
    geschlecht: f.geschlecht,
    beruf: f.beruf,
    beschreibung: f.beschreibung,
    eigenschaften: tagMap[f.id] || [],
    kapitel: appMap[f.id] || [],
    beziehungen: relMap[f.fig_id] || [],
  }));

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

app.put('/figures/:book_id', jsonBody, (req, res) => {
  _saveFigurenToDb(parseInt(req.params.book_id), req.body.figuren || []);
  res.json({ ok: true });
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Proxy /claude → api.anthropic.com (SSE-Streaming) ---
app.post('/claude', jsonBody, async (req, res) => {
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...req.body, stream: true }),
    });
    const model = req.body.model || '?';
    if (!upstream.ok) {
      const err = await upstream.json();
      logger.error(`Claude upstream ${upstream.status} (model=${model}): ${JSON.stringify(err)}`);
      return res.status(upstream.status).json(err);
    }
    logger.info(`Claude call model=${model} max_tokens=${req.body.max_tokens || '?'}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    logger.error('Claude proxy error: ' + err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Claude nicht erreichbar: ' + err.message });
    else res.end();
  }
});

// --- Proxy /api/* → BookStack ---
app.use('/api', createProxyMiddleware({
  target: BOOKSTACK_URL,
  changeOrigin: true,
  pathRewrite: { '^/': '/api/' },
  on: {
    proxyRes: (proxyRes, _req, res) => {
      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
        proxyRes.destroy();
        res.status(401).json({ error: 'BookStack: Nicht authentifiziert – Token ungültig oder abgelaufen.' });
      }
    },
    error: (err, _req, res) => {
      logger.error('BookStack proxy error: ' + err.message);
      res.status(502).json({ error: 'BookStack nicht erreichbar: ' + err.message });
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  logger.info(`BookStack Ziel: ${BOOKSTACK_URL}`);
});
