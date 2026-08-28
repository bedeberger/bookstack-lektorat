'use strict';
// Seiten-/Buch-Statistik: Stats-Cache lesen und im Batch schreiben, der
// Buchstatistik-Verlauf, die Staleness-Frage des Clients und die Stil-Karte
// (verdichtetes Kapitel-Raster + Drilldown pro Zelle).

const { db } = require('../../db/schema');
const { toIntId } = require('../../lib/validate');
const { ACLError, requireBookAccess } = require('../../lib/acl');
const logger = require('../../logger');
const { jsonBodyLarge } = require('./shared');
const { loadStyleRows, loadStyleSamples, chapterNameOf } = require('../../db/style-stats');
const { buildStilHeatmap, buildStilDetail, isSampleBucket, UNCAT } = require('../../lib/stil-heatmap');
const { METRICS_VERSION } = require('../../lib/page-index');

function register(router) {
  // Seiten-Stats-Cache: alle gecachten Stats für ein Buch (geteilter Cache, nicht user-spezifisch)
  router.get('/page-stats/:book_id', (req, res) => {
    const bookId = req.bookId;
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
    const bookId = req.bookId;
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
    const bookId = req.bookId;
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

  // Stil-Karte: Kapitel-Raster + Satzrhythmus + Satzanfaenge, fertig verdichtet.
  // Die Rohform ist eine Zeile PRO SEITE mit der vollstaendigen Satzlaengen-
  // Sequenz — bei einem grossen Buch zweistellige Megabytes fuer ein Raster mit
  // ein paar hundert Zeilen. Darum aggregiert der Server (Muster /fehler-heatmap);
  // die Beispielsaetze holt /style-samples pro aufgeklappter Zelle nach.
  router.get('/style-stats/:book_id', (req, res) => {
    const rows = loadStyleRows(req.bookId);
    res.json(buildStilHeatmap({ rows, metricsVersion: METRICS_VERSION }));
  });

  // Drilldown einer Heatmap-Zelle: die Treffer-Beispiele EINES Kapitels fuer EINEN
  // Eimer (filler|passive|adverb|repetition). `chapter` ist der Kapitel-Key der
  // Heatmap-Zeile; '__uncat__' meint die Seiten ohne Kapitel.
  router.get('/style-samples/:book_id', (req, res) => {
    const bucket = String(req.query.bucket || '');
    if (!isSampleBucket(bucket)) {
      return res.status(400).json({ error: 'Unbekannter Beispiel-Eimer.', error_code: 'INVALID_SAMPLE_BUCKET' });
    }
    const raw = String(req.query.chapter || '');
    const chapterId = (raw === UNCAT || raw === '') ? null : toIntId(raw);
    if (raw && raw !== UNCAT && !chapterId) {
      return res.status(400).json({ error: 'Ungueltige Kapitel-ID.', error_code: 'INVALID_CHAPTER_ID' });
    }
    const rows = loadStyleSamples(req.bookId, chapterId);
    res.json({
      chapterKey: chapterId == null ? UNCAT : String(chapterId),
      chapterName: chapterNameOf(req.bookId, chapterId),
      bucket,
      ...buildStilDetail({ rows, bucket }),
    });
  });
}

module.exports = { register };
