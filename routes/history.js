const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { localIsoDate, localHour } = require('../lib/local-date');
const { ACLError, aclParamGuard, guardBook, requireBookAccess } = require('../lib/acl');
const { resolvePageBookId } = require('../lib/content-ownership');
const { buildRueckblickCoverage } = require('./jobs/rueckblick-dates');
const snapshots = require('../db/book-snapshots');
const logger = require('../logger');

const router = express.Router();
// Reads (Lektoratverlauf, Reviews, Stats, Heatmap) sind viewer+.
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json();
// Grosser Limit fuer Routen, deren Body mit der Seitenzahl waechst: stats-stale
// traegt die vollstaendige { id, updated_at }-Liste (Tagebuecher haben tausende
// Seiten → Default-100-KB sprengt das mit 413), page-stats/batch ist der
// gleichfoermige Batch-Write-Endpunkt. Das Limit ist nur eine Obergrenze, kein
// Vorab-Alloc — kleine Bodies kosten nichts.
const jsonBodyLarge = express.json({ limit: '25mb' });

// Zwei aufeinanderfolgende writing-time-Pings gelten als dieselbe Schreib-Session,
// solange zwischen ihnen hoechstens so viele Sekunden liegen. Der Heartbeat kommt
// alle ~30 s; eine Pause laenger als 15 min zaehlt als Session-Ende.
const SESSION_GAP_SECONDS = 900;

// Buch-Guard fuer die Body-/Query-Routen dieses Routers kommt aus
// lib/acl.js#guardBook; die `:book_id`-Routen deckt der router.param-Guard ab.

// Lauf als gespeichert markieren (oder zurücksetzen).
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
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });

  // Erst Ownership prüfen (user_email-Scope), dann updaten. Verhindert ID-Raten
  // über Buch-/User-Grenzen und liefert verifizierte book_id für das Log.
  const row = db.prepare(`
    SELECT pc.page_id, p.page_name, pc.book_id, pc.chapter_id
    FROM page_checks pc
    LEFT JOIN pages p ON p.page_id = pc.page_id
    WHERE pc.id = ? AND pc.user_email = ?
  `).get(id, user_email);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!row.book_id) return res.status(400).json({ error_code: 'CHECK_HAS_NO_BOOK' });
  if (!guardBook(req, res, row.book_id, 'lektor')) return;

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

// Letzte 20 Läufe für eine Seite (Listenansicht – ohne grosse JSON-Felder).
// JSON-Daten (errors_json/szenen_json/applied/selected) lädt das Frontend
// lazy via /check/:id/details, sobald der User einen Eintrag öffnet. Spart
// 20× JSON.parse pro Aufruf, auch wenn keiner expandiert wird.
router.get('/page/:page_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = resolvePageBookId(pageId);
  if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const rows = db.prepare(`
    SELECT pc.id, pc.page_id, p.page_name, pc.book_id, pc.chapter_id, pc.checked_at,
           pc.error_count, pc.stilanalyse, pc.fazit, pc.model, pc.saved, pc.saved_at
    FROM page_checks pc
    LEFT JOIN pages p ON p.page_id = pc.page_id
    WHERE pc.page_id = ? AND pc.user_email = ?
    ORDER BY pc.checked_at DESC LIMIT 20`).all(pageId, user_email);
  res.json(rows.map(r => ({ ...r, saved: !!r.saved })));
});

// JSON-Detail eines page_check (errors/szenen/applied/selected).
// Wird vom Frontend bei Klick auf einen History-Eintrag nachgeladen.
router.get('/check/:id/details', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const r = db.prepare(`
    SELECT book_id, errors_json, applied_errors_json, selected_errors_json, szenen_json
    FROM page_checks WHERE id = ? AND user_email = ?`).get(id, user_email);
  if (!r) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (r.book_id && !guardBook(req, res, r.book_id, 'viewer')) return;
  res.json({
    errors_json: JSON.parse(r.errors_json || '[]'),
    applied_errors_json: r.applied_errors_json ? JSON.parse(r.applied_errors_json) : null,
    selected_errors_json: r.selected_errors_json ? JSON.parse(r.selected_errors_json) : null,
    szenen_json: r.szenen_json ? JSON.parse(r.szenen_json) : null,
  });
});

// Lektorat-Prüfung löschen
router.delete('/check/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM page_checks WHERE id = ? AND user_email = ?')
    .run(id, user_email);
  res.json({ ok: true });
});

// Buchbewertung löschen
router.delete('/review/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM book_reviews WHERE id = ? AND user_email = ?')
    .run(id, user_email);
  res.json({ ok: true });
});

// Tagebuch-Rückblick (History-Eintrag) löschen
router.delete('/rueckblick/:id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM tagebuch_rueckblicke WHERE id = ? AND user_email = ?')
    .run(id, user_email);
  res.json({ ok: true });
});

// Kompletter History-Reset für ein Buch: löscht page_checks, book_reviews und
// chat_sessions (inkl. Nachrichten via ON DELETE CASCADE) des eingeloggten Users.
router.delete('/book/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.params.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  const delChecks     = db.prepare('DELETE FROM page_checks      WHERE book_id = ? AND user_email = ?');
  const delReviews    = db.prepare('DELETE FROM book_reviews     WHERE book_id = ? AND user_email = ?');
  const delChReviews  = db.prepare('DELETE FROM chapter_reviews  WHERE book_id = ? AND user_email = ?');
  const delSessions   = db.prepare('DELETE FROM chat_sessions    WHERE book_id = ? AND user_email = ?');
  const delWerkRuns   = db.prepare('DELETE FROM werkstatt_runs   WHERE book_id = ? AND user_email = ?');
  const delRueckblicke = db.prepare('DELETE FROM tagebuch_rueckblicke WHERE book_id = ? AND user_email = ?');

  const result = db.transaction(() => ({
    page_checks:      delChecks.run(book_id, user_email).changes,
    book_reviews:     delReviews.run(book_id, user_email).changes,
    chapter_reviews:  delChReviews.run(book_id, user_email).changes,
    chat_sessions:    delSessions.run(book_id, user_email).changes,
    werkstatt_runs:   delWerkRuns.run(book_id, user_email).changes,
    rueckblicke:      delRueckblicke.run(book_id, user_email).changes,
  }))();

  logger.info(
    `History-Reset: book=${book_id} user=${user_email} ` +
    `page_checks=${result.page_checks} book_reviews=${result.book_reviews} ` +
    `chapter_reviews=${result.chapter_reviews} chat_sessions=${result.chat_sessions} ` +
    `werkstatt_runs=${result.werkstatt_runs} rueckblicke=${result.rueckblicke}`
  );
  res.json({ ok: true, deleted: result });
});

// Letzte 10 Bewertungen für ein Buch
router.get('/review/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    SELECT br.*, b.name AS book_name FROM book_reviews br
    LEFT JOIN books b ON b.book_id = br.book_id
    WHERE br.book_id = ? AND br.user_email = ?
    ORDER BY br.reviewed_at DESC LIMIT 10`).all(bookId, user_email);
  res.json(rows.map(r => ({ ...r, review_json: JSON.parse(r.review_json || 'null') })));
});

// Tagebuch-Rückblicke: letzte 20 generierte Rückblicke eines Buchs (re-öffenbar).
router.get('/rueckblick/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    SELECT id, zeitraum, result_json, model, entry_count, created_at
    FROM tagebuch_rueckblicke
    WHERE book_id = ? AND user_email = ?
    ORDER BY created_at DESC LIMIT 20`).all(bookId, user_email);
  // Pro-Zeile parsen: eine einzelne kaputte result_json-Zeile darf nicht die
  // ganze Liste 500en (sonst lädt die History gar nicht → Rückblick-Karte bleibt
  // leer). Fehlerhafte Zeile → result_json: null (Frontend blendet sie aus).
  res.json(rows.map(r => {
    let result_json = null;
    try { result_json = JSON.parse(r.result_json || 'null'); }
    catch (e) { logger.warn(`[history/rueckblick] kaputte result_json in Zeile id=${r.id}: ${e.message}`); }
    return { ...r, result_json };
  }));
});

// Rückblick-Heatmap-Coverage: aggregiert datierte Seiten (Monats-/Jahres-Buckets)
// + vorhandene KI-Rückblicke des Users zu fertigen Buckets fürs Overview-Tile.
// Liest nur Metadaten (page_name/page_id) zur Datums-Aggregation — kein Buch-
// Inhalt (folgt der Praxis von /fehler-heatmap, /style-stats). Kein KI-Call.
router.get('/rueckblick-coverage/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const pages = db.prepare('SELECT page_id, page_name FROM pages WHERE book_id = ?').all(bookId);
  // Jüngster Rückblick je Zeitraum (user-spezifisch — tagebuch_rueckblicke ist persönlich).
  const rbRows = db.prepare(`
    WITH ranked AS (
      SELECT id, zeitraum, created_at,
             ROW_NUMBER() OVER (PARTITION BY zeitraum ORDER BY created_at DESC, id DESC) AS rn
      FROM tagebuch_rueckblicke
      WHERE book_id = ? AND user_email = ?
    )
    SELECT id, zeitraum, created_at FROM ranked WHERE rn = 1
  `).all(bookId, user_email);
  res.json(buildRueckblickCoverage(pages, rbRows));
});

// Kapitel-Reviews: alle Einträge eines Buchs, gruppiert als { [chapter_id]: [entries] }.
// Max. 10 Einträge pro Kapitel (absteigend nach Datum).
router.get('/chapter-reviews/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const book_id = toIntId(req.params.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    SELECT cr.*, b.name AS book_name FROM chapter_reviews cr
    LEFT JOIN books b ON b.book_id = cr.book_id
    WHERE cr.book_id = ? AND cr.user_email = ?
    ORDER BY cr.chapter_id, cr.reviewed_at DESC`).all(book_id, user_email);
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
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM chapter_reviews WHERE id = ? AND user_email = ?')
    .run(id, user_email);
  res.json({ ok: true });
});

// Seiten-Stats-Cache: alle gecachten Stats für ein Buch (geteilter Cache, nicht user-spezifisch)
router.get('/page-stats/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(
    'SELECT page_id, tok, words, chars, updated_at FROM page_stats WHERE book_id = ?'
  ).all(bookId);
  const map = {};
  for (const r of rows) map[r.page_id] = { tok: r.tok, words: r.words, chars: r.chars, updated_at: r.updated_at };
  res.json(map);
});

// Seiten-Stats-Cache: Batch-Upsert (vom Frontend nach Token-Berechnung).
// Vor dem INSERT prüfen, dass (page_id, book_id) konsistent zu `pages` ist —
// page_stats hat FK auf pages(page_id) UND books(book_id); ein Mismatch
// (z.B. stale Frontend-State nach Buchwechsel/Page-Löschung) wuerde sonst die
// ganze Transaktion abreissen. Skipped Rows werden geloggt, Restliche gehen durch.
router.post('/page-stats/batch', jsonBodyLarge, (req, res) => {
  const items = req.body;
  if (!Array.isArray(items) || !items.length) return res.json({ ok: true, count: 0 });

  const pageIds = Array.from(new Set(
    items.map(s => toIntId(s?.page_id)).filter(Boolean)
  ));
  if (!pageIds.length) {
    logger.warn(`page-stats/batch: ${items.length} Rows ohne gueltige page_id verworfen.`);
    return res.json({ ok: true, count: 0, skipped: items.length });
  }
  const placeholders = pageIds.map(() => '?').join(',');
  const ownerByPage = new Map(
    db.prepare(`SELECT page_id, book_id FROM pages WHERE page_id IN (${placeholders})`)
      .all(...pageIds)
      .map(r => [r.page_id, r.book_id])
  );

  // ACL: nur Buecher, fuer die der User Editor-Zugriff hat. page_stats ist ein
  // geteilter Cache — ohne diese Pruefung koennte jeder eingeloggte User die
  // Statistik fremder Buecher ueberschreiben (IDOR, body-supplied book_id).
  // Nur die Rechte-Absage (ACLError) ist ein erwarteter Ausgang. Ein blosses
  // `catch {}` liess jeden anderen Fehler wie "kein Zugriff" aussehen und
  // verwarf still JEDE Zeile JEDES Users — der Grund muss sichtbar bleiben.
  const allowedBooks = new Set();
  const deniedBooks = new Map();
  for (const ownerBook of new Set(ownerByPage.values())) {
    try { requireBookAccess(req, ownerBook, 'editor'); allowedBooks.add(ownerBook); }
    catch (e) {
      deniedBooks.set(ownerBook, e instanceof ACLError ? e.code : 'ACL_CHECK_FAILED');
      if (!(e instanceof ACLError)) logger.error(`page-stats/batch: ACL-Pruefung Buch ${ownerBook}: ${e.message}`);
    }
  }

  const stmt = db.prepare(`
    INSERT INTO page_stats (page_id, book_id, tok, words, chars, updated_at, cached_at)
    VALUES (@page_id, @book_id, @tok, @words, @chars, @updated_at, @cached_at)
    ON CONFLICT(page_id) DO UPDATE SET
      tok=excluded.tok, words=excluded.words, chars=excluded.chars,
      updated_at=excluded.updated_at, cached_at=excluded.cached_at
  `);
  const now = new Date().toISOString();
  const skipped = [];
  let written = 0;
  db.transaction(() => {
    for (const s of items) {
      const pageId = toIntId(s?.page_id);
      const bookId = toIntId(s?.book_id);
      const ownerBook = pageId ? ownerByPage.get(pageId) : null;
      // Genau ein Grund pro Zeile: stale Frontend-State und fehlende Buchrolle
      // haben verschiedene Ursachen und duerfen im Log nicht unter einer
      // Sammelbezeichnung verschwinden.
      const reason = !pageId ? 'INVALID_PAGE_ID'
        : !bookId ? 'INVALID_BOOK_ID'
        : !ownerBook ? 'PAGE_NOT_FOUND'
        : ownerBook !== bookId ? 'BOOK_MISMATCH'
        : !allowedBooks.has(ownerBook) ? (deniedBooks.get(ownerBook) || 'NO_BOOK_ACCESS')
        : null;
      if (reason) {
        skipped.push({ page_id: s?.page_id, book_id: s?.book_id, owner_book: ownerBook ?? null, reason });
        continue;
      }
      stmt.run({ ...s, page_id: pageId, book_id: bookId, cached_at: now });
      written += 1;
    }
  })();
  const byReason = skipped.reduce((acc, r) => ((acc[r.reason] ||= []).push(r), acc), {});
  for (const [reason, rows] of Object.entries(byReason)) {
    logger.warn(`page-stats/batch: ${rows.length} Row(s) verworfen (${reason}): ${JSON.stringify(rows)}`);
  }
  res.json({ ok: true, count: written, skipped: skipped.length });
});

// Buchstatistik-Verlauf für Zeitliniendiagramm (geteilter Cache, nicht user-spezifisch)
router.get('/book-stats/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    SELECT bsh.id, bsh.book_id, b.name AS book_name, bsh.recorded_at,
           bsh.page_count, bsh.words, bsh.chars, bsh.tok, bsh.unique_words,
           bsh.chapter_count, bsh.avg_sentence_len, bsh.avg_lix, bsh.avg_flesch_de
    FROM book_stats_history bsh
    LEFT JOIN books b ON b.book_id = bsh.book_id
    WHERE bsh.book_id = ?
    ORDER BY bsh.recorded_at ASC
  `).all(bookId);
  res.json(rows);
});

// Stats-Staleness: hat sich der Buchstand seit dem letzten Sync (page_stats +
// book_stats_history) geändert? Der Client schickt seine autoritative Seitenliste
// ({ id, updated_at } aus dem Content-Store); die Server-`pages`-Tabelle ist nur
// ein fire-and-forget-aktualisierter Cache und taugt hier nicht als Wahrheit.
// Antwort { stale, reason } — bei `stale` synct der Client im Hintergrund nach.
// Drei Signale (SSoT, ersetzt die frühere Client-Heuristik a/b/c):
//   (a) page-edited  — eine Seite hat kein/veraltetes page_stats (updated_at ≠).
//   (b) new-day      — jüngste Seitenaktivität liegt nach dem letzten Snapshot-Tag.
//   (c) char-growth  — Σ page_stats.chars weicht > Toleranz vom Snapshot ab
//                       (Mehrfach-Edits am selben Tag; Tagesgranularität von (b) blind).
router.post('/stats-stale/:book_id', jsonBodyLarge, (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
  if (!pages.length) return res.json({ stale: false, reason: 'no-pages' });

  const statsRows = db.prepare(
    'SELECT page_id, chars, updated_at FROM page_stats WHERE book_id = ?'
  ).all(bookId);
  const stats = new Map(statsRows.map(r => [r.page_id, r]));

  // (a) per-Seite-Diff gegen die autoritative Client-Liste.
  for (const p of pages) {
    const id = toIntId(p?.id);
    if (!id) continue;
    const c = stats.get(id);
    if (!c || c.updated_at !== (p.updated_at || null)) {
      return res.json({ stale: true, reason: 'page-edited' });
    }
  }

  const lastSnapshot = db.prepare(
    'SELECT recorded_at, chars FROM book_stats_history WHERE book_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(bookId);
  if (!lastSnapshot) return res.json({ stale: true, reason: 'no-snapshot' });

  // (b) jüngster Aktivitätstag > letzter Snapshot-Tag.
  let latestPageDay = null;
  for (const p of pages) {
    const d = p?.updated_at ? String(p.updated_at).slice(0, 10) : null;
    if (d && (!latestPageDay || d > latestPageDay)) latestPageDay = d;
  }
  if (latestPageDay && latestPageDay > lastSnapshot.recorded_at) {
    return res.json({ stale: true, reason: 'new-day' });
  }

  // (c) Σ page_stats.chars (nur Seiten der Client-Liste) vs Snapshot.chars.
  let sumChars = 0;
  for (const p of pages) {
    const c = stats.get(toIntId(p?.id));
    if (c) sumChars += Number(c.chars) || 0;
  }
  const snapChars = Number(lastSnapshot.chars) || 0;
  if (sumChars > 0 && snapChars > 0) {
    const tolerance = Math.max(50, snapChars * 0.005);
    if (Math.abs(sumChars - snapChars) > tolerance) {
      return res.json({ stale: true, reason: 'char-growth' });
    }
  }
  res.json({ stale: false });
});

// Stil-Heatmap: alle Stil-Metriken pro Seite eines Buchs (inkl. Kapitel-Info).
// Frontend aggregiert nach Kapitel, erkennt noch nicht berechnete Seiten via metrics_version.
router.get('/style-stats/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    SELECT ps.page_id, p.page_name, p.chapter_id, c.chapter_name,
           ps.words, ps.chars, ps.sentences, ps.dialog_chars,
           ps.filler_count, ps.passive_count, ps.adverb_count,
           ps.avg_sentence_len, ps.sentence_len_p90, ps.repetition_data,
           ps.lix, ps.flesch_de, ps.style_samples, ps.metrics_version, ps.cached_at,
           ps.sentence_lens, ps.opener_counts
    FROM page_stats ps
    JOIN pages p ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ?
    ORDER BY p.chapter_id, p.page_id
  `).all(bookId);
  // JSON-Spalten parsen; defensiv, damit eine korrupte Zeile die Antwort nicht kippt.
  // `sentence_lens` steht in LESERICHTUNG — die Reihenfolge der Zeilen (chapter_id,
  // page_id) und die Reihenfolge innerhalb des Arrays tragen zusammen den Rhythmus.
  const pages = rows.map(r => {
    let rep = null, samples = null, lens = null, openers = null;
    if (r.repetition_data) {
      try { rep = JSON.parse(r.repetition_data); } catch { rep = null; }
    }
    if (r.style_samples) {
      try { samples = JSON.parse(r.style_samples); } catch { samples = null; }
    }
    if (r.sentence_lens) {
      try { lens = JSON.parse(r.sentence_lens); } catch { lens = null; }
    }
    if (r.opener_counts) {
      try { openers = JSON.parse(r.opener_counts); } catch { openers = null; }
    }
    return {
      ...r,
      repetition_data: rep,
      style_samples: samples,
      sentence_lens: Array.isArray(lens) ? lens : null,
      opener_counts: (openers && typeof openers === 'object') ? openers : null,
    };
  });
  // Neuestes cached_at = letzter Sync-Zeitpunkt für dieses Buch.
  const lastUpdated = pages.reduce((max, p) => {
    if (!p.cached_at) return max;
    return (!max || p.cached_at > max) ? p.cached_at : max;
  }, null);
  res.json({ pages, last_updated: lastUpdated });
});

// Pro Seite: letzter Check-Zeitpunkt + Pending-Flag. Cross-User — alle Editoren
// mit Buchzugriff sehen denselben Status, damit Co-Editoren wissen, was schon
// geprüft ist. Findings/Reviews bleiben weiterhin user-spezifisch.
// "Pending" = jüngster Check hat Fehler, wurde weder geöffnet noch übernommen.
// Wenn Korrekturen aus einem Check übernommen wurden, zählt saved_at — sonst
// würde das anschliessende BookStack-updated_at die Seite sofort wieder auf
// "bearbeitet seit Lektorat" (warn) flippen.
// `by` enthält die E-Mail des Editors, der den jüngsten Check gemacht hat
// (oder null) — Frontend zeigt das als „geprüft von …" im Tooltip.
router.get('/page-ages/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const rows = db.prepare(`
    WITH latest AS (
      SELECT page_id, checked_at, saved_at, error_count, user_email,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
      FROM page_checks
      WHERE book_id = ?
    )
    SELECT page_id,
           CASE WHEN saved_at IS NOT NULL AND saved_at > checked_at THEN saved_at ELSE checked_at END AS at,
           CASE WHEN saved_at IS NULL AND error_count > 0 THEN 1 ELSE 0 END AS pending,
           user_email AS by_email
    FROM latest
    WHERE rn = 1
  `).all(bookId);
  const map = {};
  for (const r of rows) map[r.page_id] = { at: r.at, pending: !!r.pending, by: r.by_email || null };
  res.json(map);
});

// Lektorat-Abdeckung: wie viele Seiten eines Buchs wurden schon geprüft. Cross-User.
router.get('/coverage/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const { total } = db.prepare('SELECT COUNT(*) as total FROM page_stats WHERE book_id = ?').get(bookId);
  const { checked } = db.prepare(
    'SELECT COUNT(DISTINCT page_id) as checked FROM page_checks WHERE book_id = ?'
  ).get(bookId);
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  res.json({ checked_pages: checked, total_pages: total, pct });
});

// Fehler-Heatmap: aggregiert Fehler-Typen × Kapitel aus dem jeweils jüngsten page_check pro Seite.
// mode=open     → Fehler aus errors_json, die nicht in applied_errors_json stehen (default)
// mode=applied  → nur applied_errors_json
// mode=all      → alle Fehler aus errors_json
router.get('/fehler-heatmap/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const mode = ['open', 'applied', 'all'].includes(req.query.mode) ? req.query.mode : 'open';

  const pages = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name,
           COALESCE(ps.words, 0) AS words
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
  `).all(bookId);

  // errors_json kommt aus dem jüngsten Check pro Seite (aktueller Findings-Stand).
  const checks = db.prepare(`
    WITH latest AS (
      SELECT page_id, errors_json,
             ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
      FROM page_checks
      WHERE book_id = ? AND user_email = ?
    )
    SELECT page_id, errors_json
    FROM latest
    WHERE rn = 1
  `).all(bookId, user_email);

  // applied_errors_json wird über ALLE Checks der Seite akkumuliert (Union per
  // `original`) — angenommene Korrekturen sind kumulativ und dürfen nicht
  // verschwinden, sobald die Seite erneut lektoriert wird (neuer Check ohne applied).
  const appliedRows = db.prepare(`
    SELECT page_id, applied_errors_json
    FROM page_checks
    WHERE book_id = ? AND user_email = ? AND applied_errors_json IS NOT NULL
  `).all(bookId, user_email);

  const checkByPage = new Map();
  for (const c of checks) checkByPage.set(c.page_id, c);

  const parseArr = (s) => {
    if (!s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  };

  // page_id → Map<original, finding> (dedupliziert die Union über alle Checks).
  const appliedByPage = new Map();
  for (const row of appliedRows) {
    let m = appliedByPage.get(row.page_id);
    if (!m) { m = new Map(); appliedByPage.set(row.page_id, m); }
    for (const e of parseArr(row.applied_errors_json)) {
      if (e?.original && !m.has(e.original)) m.set(e.original, e);
    }
  }

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
    const appliedMap = appliedByPage.get(p.page_id) || new Map();
    const applied = [...appliedMap.values()];
    const appliedSet = new Set(appliedMap.keys());

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

// Fehlerdichte-Trend über die Fassungen: pro book_snapshots-Zeile die verdichtete
// Lektorat-Kennzahl (offen/angenommen/alle je Typ) + Wörter-Nenner, aufsteigend
// nach seq. Die Fehler-Heatmap-Karte zeichnet daraus den Verlauf. Momentaufnahme-
// Metrik pro Meilenstein — keine Live-Aggregation (die liefert /fehler-heatmap).
router.get('/fehler-trend/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  const rows = snapshots.listLektoratTrend(bookId);
  const versions = rows.map((r) => {
    let metrics = null;
    if (r.lektorat_metrics) {
      try { metrics = JSON.parse(r.lektorat_metrics); } catch { metrics = null; }
    }
    return {
      seq: r.seq,
      label: r.label || null,
      words: r.words || 0,
      created_at: r.created_at,
      published: !!r.published_at,
      metrics, // { open, applied, all } je { total, byTyp } — oder null (keine Lektorat-Daten)
    };
  });
  res.json({ versions });
});

// Schreibzeit-Tracking: Heartbeat des Frontends (alle ~30 s, solange
// editMode || focusMode aktiv und Tab sichtbar). Pro (User, Buch, Tag)
// werden die Sekunden aufsummiert. Server-seitiges Clamping auf 1 h pro
// Ping verhindert Ausreisser (Uhrensprung, manipulierte Werte).
router.post('/writing-time', jsonBody, (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.body?.book_id);
  const secondsRaw = Number(req.body?.seconds);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!guardBook(req, res, book_id, 'viewer')) return;
  if (!Number.isFinite(secondsRaw) || secondsRaw <= 0) return res.json({ ok: true, added: 0 });
  const seconds = Math.min(Math.round(secondsRaw), 3600);
  const date = localIsoDate();
  db.prepare(`
    INSERT INTO writing_time (user_email, book_id, date, seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, date) DO UPDATE SET seconds = seconds + excluded.seconds
  `).run(user_email, book_id, date, seconds);
  // Tageszeit-Histogramm (writing_hour): denselben Delta der aktuellen lokalen
  // Stunde zuschlagen. Lebenslang aggregiert, ohne Datums-Dimension.
  db.prepare(`
    INSERT INTO writing_hour (user_email, book_id, hour, seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, hour) DO UPDATE SET seconds = seconds + excluded.seconds
  `).run(user_email, book_id, localHour(), seconds);
  // Schreib-Session ableiten: die juengste Session dieses (User, Buch) verlaengern,
  // wenn ihr Ende hoechstens SESSION_GAP_SECONDS zurueckliegt; sonst neue Session.
  // started_at des neuen Abschnitts = jetzt minus die gerade gemeldeten Sekunden.
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const last = db.prepare(`
    SELECT id, ended_at FROM writing_session
    WHERE user_email = ? AND book_id = ? ORDER BY ended_at DESC LIMIT 1
  `).get(user_email, book_id);
  if (last && (nowMs - Date.parse(last.ended_at)) <= SESSION_GAP_SECONDS * 1000) {
    db.prepare('UPDATE writing_session SET ended_at = ?, seconds = seconds + ? WHERE id = ?')
      .run(nowIso, seconds, last.id);
  } else {
    const startIso = new Date(nowMs - seconds * 1000).toISOString();
    db.prepare(`
      INSERT INTO writing_session (user_email, book_id, date, started_at, ended_at, seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user_email, book_id, date, startIso, nowIso, seconds);
  }
  res.json({ ok: true, added: seconds });
});

// Aggregat + Tagesreihe der Schreibzeit pro Buch für den eingeloggten User.
// active_days = Tage mit seconds > 0 (für Durchschnitt pro aktivem Tag).
// daily liefert die Rohdaten für das Chart (nur Tage mit seconds > 0).
router.get('/writing-time/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.params.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
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

// Diktat-Tracking (STT): Heartbeat solange das Mikrofon aufnimmt und der Tab
// sichtbar ist. Pro (User, Buch, Tag) werden Sekunden UND diktierte Zeichen
// aufsummiert. seconds: Server-Clamp auf 1 h/Ping (Uhrensprung-Schutz). chars:
// Clamp auf 100k/Ping (defensiv gegen manipulierte Werte). Buchweit wie
// writing-time — STT laeuft nur im Notebook-Editor.
router.post('/stt-time', jsonBody, (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.body?.book_id);
  const secondsRaw = Number(req.body?.seconds);
  const charsRaw = Number(req.body?.chars);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!guardBook(req, res, book_id, 'viewer')) return;
  const seconds = Number.isFinite(secondsRaw) && secondsRaw > 0 ? Math.min(Math.round(secondsRaw), 3600) : 0;
  const chars = Number.isFinite(charsRaw) && charsRaw > 0 ? Math.min(Math.round(charsRaw), 100000) : 0;
  if (seconds <= 0 && chars <= 0) return res.json({ ok: true, added_seconds: 0, added_chars: 0 });
  const date = localIsoDate();
  db.prepare(`
    INSERT INTO stt_time (user_email, book_id, date, seconds, chars)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, date) DO UPDATE SET
      seconds = seconds + excluded.seconds,
      chars   = chars   + excluded.chars
  `).run(user_email, book_id, date, seconds, chars);
  res.json({ ok: true, added_seconds: seconds, added_chars: chars });
});

// Aggregat + Tagesreihe der Diktat-Nutzung pro Buch fuer den eingeloggten User.
// daily liefert pro Tag seconds + chars fuer das BookStats-Chart (nur Tage mit
// Aktivitaet). active_days = Tage mit seconds > 0 ODER chars > 0.
router.get('/stt-time/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.params.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const row = db.prepare(`
    SELECT COALESCE(SUM(seconds), 0) AS total_seconds,
           COALESCE(SUM(chars),   0) AS total_chars,
           COUNT(*)                  AS active_days,
           MIN(date)                 AS first_date,
           MAX(date)                 AS last_date
    FROM stt_time
    WHERE user_email = ? AND book_id = ? AND (seconds > 0 OR chars > 0)
  `).get(user_email, book_id);
  const daily = db.prepare(`
    SELECT date, seconds, chars FROM stt_time
    WHERE user_email = ? AND book_id = ? AND (seconds > 0 OR chars > 0)
    ORDER BY date ASC
  `).all(user_email, book_id);
  res.json({
    total_seconds: row?.total_seconds || 0,
    total_chars:   row?.total_chars   || 0,
    active_days:   row?.active_days   || 0,
    first_date:    row?.first_date    || null,
    last_date:     row?.last_date     || null,
    daily,
  });
});

// Lektoratszeit-Tracking: Heartbeat solange checkDone (Prüfmodus) aktiv und
// Tab sichtbar. Pro (User, Buch, Seite, Tag) aufsummiert. Server-Clamp auf 1 h.
router.post('/lektorat-time', jsonBody, (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.body?.book_id);
  const page_id = toIntId(req.body?.page_id);
  const secondsRaw = Number(req.body?.seconds);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (!page_id) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
  if (!guardBook(req, res, book_id, 'viewer')) return;
  if (resolvePageBookId(page_id) !== book_id) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
  if (!Number.isFinite(secondsRaw) || secondsRaw <= 0) return res.json({ ok: true, added: 0 });
  const seconds = Math.min(Math.round(secondsRaw), 3600);
  const date = localIsoDate();
  db.prepare(`
    INSERT INTO lektorat_time (user_email, book_id, page_id, date, seconds)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_email, book_id, page_id, date) DO UPDATE SET seconds = seconds + excluded.seconds
  `).run(user_email, book_id, page_id, date, seconds);
  res.json({ ok: true, added: seconds });
});

// Aggregat + Tagesreihe + Per-Page-Aufschlüsselung der Lektoratszeit.
router.get('/lektorat-time/:book_id', (req, res) => {
  const user_email = req.session?.user?.email || null;
  if (!user_email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const book_id = toIntId(req.params.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const row = db.prepare(`
    SELECT COALESCE(SUM(seconds), 0) AS total_seconds,
           COUNT(DISTINCT date)      AS active_days,
           MIN(date)                 AS first_date,
           MAX(date)                 AS last_date
    FROM lektorat_time
    WHERE user_email = ? AND book_id = ? AND seconds > 0
  `).get(user_email, book_id);
  const daily = db.prepare(`
    SELECT date, SUM(seconds) AS seconds FROM lektorat_time
    WHERE user_email = ? AND book_id = ? AND seconds > 0
    GROUP BY date
    ORDER BY date ASC
  `).all(user_email, book_id);
  const per_page = db.prepare(`
    SELECT lt.page_id, COALESCE(p.page_name, '') AS page_name, SUM(lt.seconds) AS seconds
    FROM lektorat_time lt
    LEFT JOIN pages p ON p.page_id = lt.page_id
    WHERE lt.user_email = ? AND lt.book_id = ? AND lt.seconds > 0
    GROUP BY lt.page_id
    ORDER BY seconds DESC
  `).all(user_email, book_id);
  // per_chapter: aggregiert über chapter_id der pages-Zeile, Zeichen/Wörter aus
  // page_stats (gleiche Skala wie die anderen Kapitel-Tiles in der Overview).
  // Seiten ohne chapter_id (lose Seiten direkt im Buch) werden unter NULL/'' gruppiert.
  const per_chapter = db.prepare(`
    SELECT
      p.chapter_id                     AS chapter_id,
      COALESCE(c.chapter_name, '')     AS chapter_name,
      SUM(lt.seconds)                  AS seconds,
      COUNT(DISTINCT lt.page_id)       AS pages_count,
      COALESCE(SUM(ps.chars), 0)       AS chars,
      COALESCE(SUM(ps.words), 0)       AS words
    FROM lektorat_time lt
    LEFT JOIN pages p       ON p.page_id      = lt.page_id
    LEFT JOIN chapters c    ON c.chapter_id   = p.chapter_id AND c.book_id = p.book_id
    LEFT JOIN page_stats ps ON ps.page_id     = lt.page_id
    WHERE lt.user_email = ? AND lt.book_id = ? AND lt.seconds > 0
    GROUP BY p.chapter_id, c.chapter_name
    ORDER BY seconds DESC
  `).all(user_email, book_id);
  res.json({
    total_seconds: row?.total_seconds || 0,
    active_days:   row?.active_days   || 0,
    first_date:    row?.first_date    || null,
    last_date:     row?.last_date     || null,
    daily,
    per_page,
    per_chapter,
  });
});

module.exports = router;
