const express = require('express');
const { db } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Lektorat-Ergebnis speichern
router.post('/check', jsonBody, (req, res) => {
  const { page_id, page_name, book_id, error_count, errors_json, stilanalyse, fazit, model } = req.body;
  const user_email = req.session?.user?.email || null;
  const result = db.prepare(`
    INSERT INTO page_checks (page_id, page_name, book_id, checked_at, error_count, errors_json, stilanalyse, fazit, model, user_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    page_id, page_name, book_id,
    new Date().toISOString(),
    error_count || 0,
    JSON.stringify(errors_json || []),
    stilanalyse || null, fazit || null, model || null, user_email
  );
  res.json({ id: result.lastInsertRowid });
});

// Lauf als «in BookStack gespeichert» markieren (oder zurücksetzen)
router.patch('/check/:id/saved', jsonBody, (req, res) => {
  const saved = req.body?.saved !== undefined ? (req.body.saved ? 1 : 0) : 1;
  const saved_at = saved ? new Date().toISOString() : null;
  const applied = req.body?.applied_errors_json !== undefined
    ? JSON.stringify(req.body.applied_errors_json)
    : null;
  const selected = req.body?.selected_errors_json !== undefined
    ? JSON.stringify(req.body.selected_errors_json)
    : null;
  const user_email = req.session?.user?.email || null;
  const id = parseInt(req.params.id);

  // Erst Ownership prüfen (user_email-Scope), dann updaten. Verhindert ID-Raten
  // über Buch-/User-Grenzen und liefert verifizierte book_id für das Log.
  const row = db.prepare('SELECT page_id, page_name, book_id, chapter_id FROM page_checks WHERE id = ? AND user_email = ?').get(id, user_email);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });

  db.prepare('UPDATE page_checks SET saved = ?, saved_at = ?, applied_errors_json = COALESCE(?, applied_errors_json), selected_errors_json = COALESCE(?, selected_errors_json) WHERE id = ? AND user_email = ? AND book_id = ?')
    .run(saved, saved_at, applied, selected, id, user_email, row.book_id);

  if (saved) {
    const appliedErrors = req.body?.applied_errors_json;
    if (Array.isArray(appliedErrors)) {
      const counts = { rechtschreibung: 0, grammatik: 0, wiederholung: 0, stil: 0 };
      for (const f of appliedErrors) if (f.typ && counts[f.typ] !== undefined) counts[f.typ]++;
      const total = appliedErrors.length;
      logger.info(
        `Lektorat gespeichert: «${row.page_name}» (user=${user_email || '-'}, book=${row.book_id || '-'}, chap=${row.chapter_id || '-'}, page=${row.page_id}, ${total} Korrekturen: R=${counts.rechtschreibung} G=${counts.grammatik} W=${counts.wiederholung} S=${counts.stil})`
      );
    }
  }

  res.json({ ok: true });
});

// Letzte 20 Läufe für eine Seite
router.get('/page/:page_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT * FROM page_checks WHERE page_id = ? AND user_email = ?
    ORDER BY checked_at DESC LIMIT 20`).all(parseInt(req.params.page_id), user_email);
  res.json(rows.map(r => ({
    ...r,
    errors_json: JSON.parse(r.errors_json || '[]'),
    applied_errors_json: r.applied_errors_json ? JSON.parse(r.applied_errors_json) : null,
    selected_errors_json: r.selected_errors_json ? JSON.parse(r.selected_errors_json) : null,
    szenen_json: r.szenen_json ? JSON.parse(r.szenen_json) : null,
    saved: !!r.saved,
  })));
});

// Buchbewertung speichern
router.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name, review_json, model } = req.body;
  const user_email = req.session?.user?.email || null;
  const result = db.prepare(`
    INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    book_id, book_name,
    new Date().toISOString(),
    JSON.stringify(review_json || null),
    model || null, user_email
  );
  res.json({ id: result.lastInsertRowid });
});

// Lektorat-Prüfung löschen
router.delete('/check/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  db.prepare('DELETE FROM page_checks WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), user_email);
  res.json({ ok: true });
});

// Buchbewertung löschen
router.delete('/review/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  db.prepare('DELETE FROM book_reviews WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), user_email);
  res.json({ ok: true });
});

// Kompletter History-Reset für ein Buch: löscht page_checks, book_reviews und
// chat_sessions (inkl. Nachrichten via ON DELETE CASCADE) des eingeloggten Users.
router.delete('/book/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = parseInt(req.params.book_id);
  if (!Number.isFinite(book_id)) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  const delChecks     = db.prepare('DELETE FROM page_checks      WHERE book_id = ? AND user_email = ?');
  const delReviews    = db.prepare('DELETE FROM book_reviews     WHERE book_id = ? AND user_email = ?');
  const delChReviews  = db.prepare('DELETE FROM chapter_reviews  WHERE book_id = ? AND user_email = ?');
  const delSessions   = db.prepare('DELETE FROM chat_sessions    WHERE book_id = ? AND user_email = ?');

  const result = db.transaction(() => ({
    page_checks:      delChecks.run(book_id, user_email).changes,
    book_reviews:     delReviews.run(book_id, user_email).changes,
    chapter_reviews:  delChReviews.run(book_id, user_email).changes,
    chat_sessions:    delSessions.run(book_id, user_email).changes,
  }))();

  logger.info(
    `History-Reset: book=${book_id} user=${user_email} ` +
    `page_checks=${result.page_checks} book_reviews=${result.book_reviews} ` +
    `chapter_reviews=${result.chapter_reviews} chat_sessions=${result.chat_sessions}`
  );
  res.json({ ok: true, deleted: result });
});

// Letzte 10 Bewertungen für ein Buch
router.get('/review/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const rows = db.prepare(`
    SELECT * FROM book_reviews WHERE book_id = ? AND user_email = ?
    ORDER BY reviewed_at DESC LIMIT 10`).all(parseInt(req.params.book_id), user_email);
  res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
});

// Kapitel-Reviews: alle Einträge eines Buchs, gruppiert als { [chapter_id]: [entries] }.
// Max. 10 Einträge pro Kapitel (absteigend nach Datum).
router.get('/chapter-reviews/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const book_id = parseInt(req.params.book_id);
  const rows = db.prepare(`
    SELECT * FROM chapter_reviews WHERE book_id = ? AND user_email = ?
    ORDER BY chapter_id, reviewed_at DESC`).all(book_id, user_email);
  const byChapter = {};
  for (const r of rows) {
    const key = String(r.chapter_id);
    if (!byChapter[key]) byChapter[key] = [];
    if (byChapter[key].length < 10) {
      byChapter[key].push({ ...r, review_json: JSON.parse(r.review_json || 'null') });
    }
  }
  res.json(byChapter);
});

// Einzelnes Kapitel-Review löschen
router.delete('/chapter-review/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  db.prepare('DELETE FROM chapter_reviews WHERE id = ? AND user_email = ?')
    .run(parseInt(req.params.id), user_email);
  res.json({ ok: true });
});

// Seiten-Stats-Cache: alle gecachten Stats für ein Buch (geteilter Cache, nicht user-spezifisch)
router.get('/page-stats/:book_id', (req, res) => {
  const rows = db.prepare(
    'SELECT page_id, tok, words, chars, updated_at FROM page_stats WHERE book_id = ?'
  ).all(parseInt(req.params.book_id));
  const map = {};
  for (const r of rows) map[r.page_id] = { tok: r.tok, words: r.words, chars: r.chars, updated_at: r.updated_at };
  res.json(map);
});

// Seiten-Stats-Cache: Batch-Upsert (vom Frontend nach Token-Berechnung)
router.post('/page-stats/batch', express.json(), (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) return res.json({ ok: true, count: 0 });
  const stmt = db.prepare(`
    INSERT INTO page_stats (page_id, book_id, tok, words, chars, updated_at, cached_at)
    VALUES (@page_id, @book_id, @tok, @words, @chars, @updated_at, @cached_at)
    ON CONFLICT(page_id) DO UPDATE SET
      tok=excluded.tok, words=excluded.words, chars=excluded.chars,
      updated_at=excluded.updated_at, cached_at=excluded.cached_at
  `);
  const now = new Date().toISOString();
  db.transaction(() => { for (const s of items) stmt.run({ ...s, cached_at: now }); })();
  res.json({ ok: true, count: items.length });
});

// Buchstatistik-Verlauf für Zeitliniendiagramm (geteilter Cache, nicht user-spezifisch)
router.get('/book-stats/:book_id', (req, res) => {
  const rows = db.prepare(`
    SELECT id, book_id, book_name, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
    FROM book_stats_history WHERE book_id = ?
    ORDER BY recorded_at ASC
  `).all(parseInt(req.params.book_id));
  res.json(rows);
});

// Stil-Heatmap: alle Stil-Metriken pro Seite eines Buchs (inkl. Kapitel-Info).
// Frontend aggregiert nach Kapitel, erkennt noch nicht berechnete Seiten via metrics_version.
router.get('/style-stats/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const rows = db.prepare(`
    SELECT ps.page_id, p.page_name, p.chapter_id, p.chapter_name,
           ps.words, ps.chars, ps.sentences, ps.dialog_chars,
           ps.filler_count, ps.passive_count, ps.adverb_count,
           ps.avg_sentence_len, ps.sentence_len_p90, ps.repetition_data,
           ps.lix, ps.flesch_de, ps.style_samples, ps.metrics_version, ps.cached_at
    FROM page_stats ps
    JOIN pages p ON p.page_id = ps.page_id
    WHERE ps.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(bookId);
  // repetition_data / style_samples aus JSON-String parsen; defensiv, damit eine
  // korrupte Zeile die Antwort nicht kippt.
  const pages = rows.map(r => {
    let rep = null, samples = null;
    if (r.repetition_data) {
      try { rep = JSON.parse(r.repetition_data); } catch { rep = null; }
    }
    if (r.style_samples) {
      try { samples = JSON.parse(r.style_samples); } catch { samples = null; }
    }
    return { ...r, repetition_data: rep, style_samples: samples };
  });
  // Neuestes cached_at = letzter Sync-Zeitpunkt für dieses Buch.
  const lastUpdated = pages.reduce((max, p) => {
    if (!p.cached_at) return max;
    return (!max || p.cached_at > max) ? p.cached_at : max;
  }, null);
  res.json({ pages, last_updated: lastUpdated });
});

// Pro Seite: letzter Check-Zeitpunkt + Pending-Flag (user-spezifisch). Frontend
// berechnet Staleness/Edited-Since. "Pending" = jüngster Check hat Fehler, wurde
// aber weder geöffnet noch übernommen (saved_at NULL).
// Wenn Korrekturen aus einem Check übernommen wurden, zählt saved_at — sonst
// würde das anschliessende BookStack-updated_at die Seite sofort wieder auf
// "bearbeitet seit Lektorat" (warn) flippen.
router.get('/page-ages/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = parseInt(req.params.book_id);
  const rows = db.prepare(`
    WITH latest AS (
      SELECT page_id, checked_at, saved_at, error_count,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
      FROM page_checks
      WHERE book_id = ? AND user_email = ?
    )
    SELECT page_id,
           CASE WHEN saved_at IS NOT NULL AND saved_at > checked_at THEN saved_at ELSE checked_at END AS at,
           CASE WHEN saved_at IS NULL AND error_count > 0 THEN 1 ELSE 0 END AS pending
    FROM latest
    WHERE rn = 1
  `).all(bookId, user_email);
  const map = {};
  for (const r of rows) map[r.page_id] = { at: r.at, pending: !!r.pending };
  res.json(map);
});

// Lektorat-Abdeckung: wie viele Seiten eines Buchs wurden schon geprüft (user-spezifisch)
router.get('/coverage/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = parseInt(req.params.book_id);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM page_stats WHERE book_id = ?').get(bookId);
  const { checked } = db.prepare(
    'SELECT COUNT(DISTINCT page_id) as checked FROM page_checks WHERE book_id = ? AND user_email = ?'
  ).get(bookId, user_email);
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  res.json({ checked_pages: checked, total_pages: total, pct });
});

// Fehler-Heatmap: aggregiert Fehler-Typen × Kapitel aus dem jeweils jüngsten page_check pro Seite.
// mode=open     → Fehler aus errors_json, die nicht in applied_errors_json stehen (default)
// mode=applied  → nur applied_errors_json
// mode=all      → alle Fehler aus errors_json
router.get('/fehler-heatmap/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = parseInt(req.params.book_id);
  const mode = ['open', 'applied', 'all'].includes(req.query.mode) ? req.query.mode : 'open';

  const pages = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, p.chapter_name,
           COALESCE(ps.words, 0) AS words
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
  `).all(bookId);

  const checks = db.prepare(`
    WITH latest AS (
      SELECT page_id, errors_json, applied_errors_json,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
      FROM page_checks
      WHERE book_id = ? AND user_email = ?
    )
    SELECT page_id, errors_json, applied_errors_json
    FROM latest
    WHERE rn = 1
  `).all(bookId, user_email);

  const checkByPage = new Map();
  for (const c of checks) checkByPage.set(c.page_id, c);

  const parseArr = (s) => {
    if (!s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  };

  // Gruppiere nach Kapitel. chapter_id kann null sein → '__uncat__'.
  const chapters = new Map();
  for (const p of pages) {
    const key = p.chapter_id ?? '__uncat__';
    if (!chapters.has(key)) {
      chapters.set(key, {
        chapter_id: p.chapter_id,
        chapter_name: p.chapter_name || null,
        pages_total: 0,
        pages_checked: 0,
        words: 0,
        typen: {},      // { typ: { count, pages: Set<page_id> } }
        details: {},    // { typ: [{ page_id, page_name, count, samples }] }
      });
    }
    const ch = chapters.get(key);
    ch.pages_total++;
    ch.words += p.words;
    const check = checkByPage.get(p.page_id);
    if (!check) continue;
    ch.pages_checked++;

    const errs = parseArr(check.errors_json);
    const applied = parseArr(check.applied_errors_json);
    const appliedSet = new Set(applied.map(e => e?.original).filter(Boolean));

    let effective;
    if (mode === 'applied') effective = applied;
    else if (mode === 'all') effective = errs;
    else effective = errs.filter(e => e?.original && !appliedSet.has(e.original));

    const pageTypCounts = {};
    const pageTypSamples = {};
    for (const e of effective) {
      const typ = e?.typ;
      if (!typ) continue;
      pageTypCounts[typ] = (pageTypCounts[typ] || 0) + 1;
      if (!pageTypSamples[typ]) pageTypSamples[typ] = [];
      if (pageTypSamples[typ].length < 3) {
        pageTypSamples[typ].push({
          original: e.original || '',
          korrektur: e.korrektur || '',
          erklaerung: e.erklaerung || '',
        });
      }
    }

    for (const typ of Object.keys(pageTypCounts)) {
      if (!ch.typen[typ]) ch.typen[typ] = { count: 0, pages: new Set() };
      ch.typen[typ].count += pageTypCounts[typ];
      ch.typen[typ].pages.add(p.page_id);
      if (!ch.details[typ]) ch.details[typ] = [];
      ch.details[typ].push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: pageTypCounts[typ],
        samples: pageTypSamples[typ] || [],
      });
    }
  }

  // Sortierung: Kapitel mit numerischer ID zuerst (BookStack-Reihenfolge ist chapter_id),
  // unkategorisiert am Ende.
  const chaptersArr = [...chapters.values()].sort((a, b) => {
    if (a.chapter_id == null && b.chapter_id == null) return 0;
    if (a.chapter_id == null) return 1;
    if (b.chapter_id == null) return -1;
    return a.chapter_id - b.chapter_id;
  });

  // Matrix + Totals bauen
  const matrix = {};
  const totals = {};
  for (const ch of chaptersArr) {
    const key = ch.chapter_id ?? '__uncat__';
    matrix[key] = {};
    for (const [typ, v] of Object.entries(ch.typen)) {
      const per1k = ch.words > 0 ? Math.round((v.count / ch.words) * 1000 * 10) / 10 : 0;
      matrix[key][typ] = { count: v.count, per1k, pages: v.pages.size };
      totals[typ] = (totals[typ] || 0) + v.count;
    }
  }

  const detailsOut = {};
  for (const ch of chaptersArr) {
    const key = ch.chapter_id ?? '__uncat__';
    for (const [typ, arr] of Object.entries(ch.details)) {
      detailsOut[`${key}:${typ}`] = arr.sort((a, b) => b.count - a.count);
    }
  }

  res.json({
    mode,
    chapters: chaptersArr.map(c => ({
      chapter_id: c.chapter_id,
      chapter_name: c.chapter_name,
      pages_total: c.pages_total,
      pages_checked: c.pages_checked,
      words: c.words,
    })),
    matrix,
    totals,
    details: detailsOut,
  });
});

// Schreibzeit-Tracking: Heartbeat des Frontends (alle ~30 s, solange
// editMode || focusMode aktiv und Tab sichtbar). Pro (User, Buch, Tag)
// werden die Sekunden aufsummiert. Server-seitiges Clamping auf 1 h pro
// Ping verhindert Ausreisser (Uhrensprung, manipulierte Werte).
router.post('/writing-time', jsonBody, (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = parseInt(req.body?.book_id);
  const secondsRaw = Number(req.body?.seconds);
  if (!Number.isFinite(book_id) || book_id <= 0) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!Number.isFinite(secondsRaw) || secondsRaw <= 0) return res.json({ ok: true, added: 0 });
  const seconds = Math.min(Math.round(secondsRaw), 3600);
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO writing_time (user_email, book_id, date, seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, date) DO UPDATE SET seconds = seconds + excluded.seconds
  `).run(user_email, book_id, date, seconds);
  res.json({ ok: true, added: seconds });
});

// Aggregat + Tagesreihe der Schreibzeit pro Buch für den eingeloggten User.
// active_days = Tage mit seconds > 0 (für Durchschnitt pro aktivem Tag).
// daily liefert die Rohdaten für das Chart (nur Tage mit seconds > 0).
router.get('/writing-time/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = parseInt(req.params.book_id);
  const row = db.prepare(`
    SELECT COALESCE(SUM(seconds), 0) AS total_seconds,
           COUNT(*)                  AS active_days,
           MIN(date)                 AS first_date,
           MAX(date)                 AS last_date
    FROM writing_time
    WHERE user_email = ? AND book_id = ? AND seconds > 0
  `).get(user_email, book_id);
  const daily = db.prepare(`
    SELECT date, seconds FROM writing_time
    WHERE user_email = ? AND book_id = ? AND seconds > 0
    ORDER BY date ASC
  `).all(user_email, book_id);
  res.json({
    total_seconds: row?.total_seconds || 0,
    active_days:   row?.active_days   || 0,
    first_date:    row?.first_date    || null,
    last_date:     row?.last_date     || null,
    daily,
  });
});

module.exports = router;
