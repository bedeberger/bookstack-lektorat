const express = require('express');
const { db, reconcilePageIds, pruneStaleBookData, upsertBook } = require('../db/schema');
const logger = require('../logger');
const { runWithContext, getContext } = require('../lib/log-context');
const { aclParamGuard } = require('../lib/acl');
const { CHARS_PER_TOKEN } = require('../lib/ai');
const { toIntId } = require('../lib/validate');
const contentStore = require('../lib/content-store');
const { computePageIndex, writePageIndex, writeFigureMentionsForPageAllUsers, loadBookFiguresForMentions, tokenizeNamesForStopwords } = require('../lib/page-index');
const { invalidateBookPageCache } = require('./jobs/chat');
const { localIsoDate } = require('../lib/local-date');
const searchIndex = require('../lib/search');
const { htmlToPlainText, stripTableBlocks } = require('../lib/html-text');

const router = express.Router();
// Sync ist Write-Pfad (Pages-Upsert, Stats-Recompute) → editor+.
router.param('book_id', aclParamGuard('editor'));

const htmlToText = htmlToPlainText;

// undici-Fehler ("fetch failed") verstecken Ursache in e.cause. Helper packt
// code + nested cause-message aus, plus optional HTTP-status/bodyText.
function _errDetail(e) {
  const parts = [e.message];
  const cause = e.cause;
  if (cause) {
    const code = cause.code || cause.errno || cause.name;
    const msg = cause.message;
    parts.push(`cause: ${[code, msg].filter(Boolean).join(' — ')}`);
    if (cause.cause) {
      const c2 = cause.cause;
      parts.push(`cause.cause: ${[c2.code, c2.message].filter(Boolean).join(' — ')}`);
    }
  }
  if (e.status) parts.push(`status: ${e.status}`);
  if (e.bodyText) parts.push(`body: ${String(e.bodyText).slice(0, 200)}`);
  return parts.join(' | ');
}

// Event-Loop-Yield zwischen Backfill-Batches. Die Stats-/Preview-Schleifen lesen
// pro Seite synchron aus better-sqlite3 (`loadPage`); bei einem grossen Tagebuch
// (tausende Seiten) blockiert das sonst den single-threaded Server, sodass ein
// interaktiver Seiten-GET beim Buchwechsel bis zum 30s-Client-Timeout hinter dem
// Backfill ansteht. setImmediate gibt den Loop frei — ein blosses `await` yieldet
// nur Microtasks, lässt aber keine gequeueten HTTP-Requests durch (nur Macrotasks).
const _yield = () => new Promise((resolve) => setImmediate(resolve));

// Concurrent-Backfill-Coalescing: mehrere Tabs feuern beim Buchwechsel denselben
// Full-Backfill (/sync/pages + /sync/page-stats ohne ids) gleichzeitig → N-fache
// synchrone DB-Last auf demselben Buch. Läuft für ein Buch bereits ein Backfill,
// teilen sich Folge-Requests dessen Promise, statt die Arbeit zu doppeln.
const _inflightPagesCache = new Map(); // bookId -> Promise
const _inflightStatsFull = new Map();  // bookId -> Promise

function _coalesce(map, key, fn) {
  const running = map.get(key);
  if (running) return running;
  const p = (async () => {
    try { return await fn(); }
    finally { map.delete(key); }
  })();
  map.set(key, p);
  return p;
}

// Token-Schätzung: Text-Tokens (chars / CHARS_PER_TOKEN), gleiche Quelle wie
// chars. Hero und Sidebar-Σ zeigen damit ein konstantes Verhältnis. Nur
// Seiten-HTML zählt — Seiten- und Kapitelnamen fliessen nicht in den Umfang
// ein. Frontend nutzt dieselbe Formel in public/js/book/tree.js:_syncPageStatsAfterSave.
function computeStats(html) {
  const text = htmlToText(html || '');
  const wordList = text.trim() === '' ? [] : text.trim().split(/\s+/);
  const words = wordList.length;
  const chars = text.length;
  const tok = Math.round(chars / CHARS_PER_TOKEN);
  const sentences = text.trim() === '' ? 0 : text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  return { words, chars, tok, wordList, sentences };
}

const upsertPageStats = db.prepare(`
  INSERT INTO page_stats (page_id, book_id, tok, words, chars, updated_at, cached_at)
  VALUES (@page_id, @book_id, @tok, @words, @chars, @updated_at, @cached_at)
  ON CONFLICT(page_id) DO UPDATE SET
    book_id=excluded.book_id,
    tok=excluded.tok, words=excluded.words, chars=excluded.chars,
    updated_at=excluded.updated_at, cached_at=excluded.cached_at
`);

const upsertPageStatsMany = db.transaction((items) => {
  for (const item of items) upsertPageStats.run(item);
});

const _upsertPageCacheStmt = db.prepare(`
  INSERT INTO pages (page_id, book_id, page_name, chapter_id, updated_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(page_id) DO UPDATE SET
    book_id=excluded.book_id, page_name=excluded.page_name,
    chapter_id=excluded.chapter_id, updated_at=excluded.updated_at,
    last_seen_at=excluded.last_seen_at
`);

const _upsertChapterStmt = db.prepare(`
  INSERT INTO chapters (chapter_id, book_id, chapter_name, updated_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(chapter_id) DO UPDATE SET
    book_id=excluded.book_id, chapter_name=excluded.chapter_name,
    updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
`);

// Mig 75: chapter_extract_cache.chapter_id INTEGER FK; Rename invalidiert alle phases.
const _delChapterCacheByChapterId = db.prepare(
  'DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_id = ?'
);

// Leichtgewichtiger pages-Cache-Update (ohne Seiten-Inhalte laden).
// Wird sowohl von syncBook() als auch vom /sync/pages/:book_id-Endpunkt genutzt.
function _upsertPagesCache(bookId, pages, chapters) {
  // Kapitel-Umbenennungen erkennen → Extrakt-Cache für alle User invalidieren.
  const storedChapters = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
  const storedChMap = Object.fromEntries(storedChapters.map(c => [c.chapter_id, c.chapter_name]));
  for (const c of chapters) {
    if (storedChMap[c.id] !== undefined && storedChMap[c.id] !== c.name) {
      logger.info(`Kapitel ${c.id} (Buch ${bookId}) umbenannt: «${storedChMap[c.id]}» → «${c.name}» – Extrakt-Cache invalidiert.`);
      _delChapterCacheByChapterId.run(bookId, c.id);
    }
  }

  const seenAt = new Date().toISOString();
  db.transaction(() => {
    // Chapters VOR pages upsertten — pages.chapter_id ist FK auf chapters(chapter_id).
    for (const c of chapters) {
      _upsertChapterStmt.run(c.id, bookId, c.name, c.updated_at || null, seenAt);
    }
    for (const p of pages) {
      _upsertPageCacheStmt.run(
        p.id, bookId, p.name,
        p.chapter_id || null,
        // updated_at nie NULL schreiben — sonst blockiert die Row den Sync-Keyset-
        // Cursor (pagesChangedSince). seenAt als Fallback fuer Quellen ohne Stamp.
        p.updated_at || seenAt,
        seenAt
      );
    }
  })();

  // Gelöschte Seiten/Kapitel aus Cache + Historie entfernen.
  // Muss VOR reconcilePageIds() laufen, damit reconcile nicht versucht, verwaiste
  // Einträge anhand der (bereits gelöschten) Pages zu heilen.
  const pruned = pruneStaleBookData(bookId, pages.map(p => p.id), chapters.map(c => c.id));
  if (pruned.stale_pages || pruned.stale_chapters) {
    logger.info(`Prune Buch ${bookId}: ${pruned.stale_pages} Seiten, ${pruned.stale_chapters} Kapitel entfernt ` +
      `(page_checks=${pruned.page_checks}, page_stats=${pruned.page_stats}, chat_sessions=${pruned.chat_sessions}, ` +
      `chapter_reviews=${pruned.chapter_reviews}, chapter_extract_cache=${pruned.chapter_extract_cache}, ` +
      `figure_appearances=${pruned.figure_appearances}, location_chapters=${pruned.location_chapters}).`);
  }

  reconcilePageIds(bookId);

  // Buch-Chat-Page-Cache verwerfen, sonst antwortet Buch-Chat bis zu 10 Min
  // lang aus stale Seiten-Inhalten (z.B. nach manuellem /sync/pages oder
  // nächtlichem syncAllBooks).
  invalidateBookPageCache(bookId);
}

const PREVIEW_CHARS = 800;

async function syncPagesCache(bookId, ctx) {
  const [pages, chapters, bookMeta] = await Promise.all([
    contentStore.listPages(bookId, ctx),
    contentStore.listChapters(bookId, ctx),
    contentStore.loadBook(bookId, ctx).catch(() => null),
  ]);
  if (bookMeta) upsertBook(bookMeta);
  _upsertPagesCache(bookId, pages, chapters);

  // Vorschautexte nur für Seiten ohne gecachten Preview laden (neue Seiten oder nach Migration)
  const needsPreview = new Set(
    db.prepare('SELECT page_id FROM pages WHERE book_id = ? AND preview_text IS NULL')
      .all(bookId).map(r => r.page_id)
  );
  const toFetch = pages.filter(p => needsPreview.has(p.id));
  if (toFetch.length) {
    const stmtPrev = db.prepare('UPDATE pages SET preview_text = ? WHERE page_id = ?');
    const BATCH = 5;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      if (i > 0) await _yield();
      await Promise.allSettled(toFetch.slice(i, i + BATCH).map(async p => {
        try {
          const pd = await contentStore.loadPage(p.id, ctx);
          const text = htmlToText(pd.html || '').trim();
          stmtPrev.run(text ? text.slice(0, PREVIEW_CHARS) : null, p.id);
        } catch { /* einzelne Seite überspringen */ }
      }));
    }
  }

  logger.info(`pages-Cache Buch ${bookId}: ${pages.length} Seiten, ${toFetch.length} Vorschau(en) nachgeladen.`);
}

async function syncBook(bookId, ctx) {
  const [pages, book, chapters] = await Promise.all([
    contentStore.listPages(bookId, ctx),
    contentStore.loadBook(bookId, ctx),
    contentStore.listChapters(bookId, ctx),
  ]);
  const chapterCount = chapters.length;

  upsertBook(book);
  const bookName = book.name || '';
  // bookName lokal weiterhin fuer Logger; book_stats_history.book_name wurde
  // in Mig 78 entfernt — Anzeige laeuft jetzt ueber JOIN auf books(name).
  const now = new Date().toISOString();
  const BATCH = 5;
  const statsItems = [];
  const globalWordSet = new Set();
  let totalWords = 0, totalChars = 0, totalTok = 0, totalSentences = 0;

  // Bestehende content_sigs laden, um Seiten ohne inhaltliche Änderung zu überspringen
  // (Index-Berechnung ist teuer bei vielen Seiten, nur neu laufen lassen wenn nötig).
  const existingIndex = Object.fromEntries(
    db.prepare('SELECT page_id, content_sig, metrics_version FROM page_stats WHERE book_id = ?')
      .all(bookId).map(r => [r.page_id, r])
  );

  // Eigennamen aus Figuren + Schauplätzen + Szenen-Titeln dieses Buchs
  // (user-übergreifend, weil page_stats shared ist) → werden aus der
  // Wiederholungs-Metrik ausgeschlossen, damit "Anna" oder "Zürich" nicht als
  // Stil-Befund auftauchen.
  const nameSource = [
    ...db.prepare('SELECT name, kurzname FROM figures WHERE book_id = ?').all(bookId).flatMap(r => [r.name, r.kurzname]),
    ...db.prepare('SELECT name FROM locations WHERE book_id = ?').all(bookId).map(r => r.name),
    ...db.prepare('SELECT titel FROM figure_scenes WHERE book_id = ?').all(bookId).map(r => r.titel),
  ];
  const extraStopwords = tokenizeNamesForStopwords(nameSource);

  const previewItems = [];
  const indexItems = [];
  for (let i = 0; i < pages.length; i += BATCH) {
    if (i > 0) await _yield();
    const batch = pages.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async p => {
      const pd = await contentStore.loadPage(p.id, ctx);
      const text = htmlToText(pd.html || '');
      const { words, chars, tok, wordList, sentences } = computeStats(pd.html || '');
      const preview = text.trim().slice(0, PREVIEW_CHARS);
      // Zwei Textformen mit Absicht: `text` ist der Umfang (Tabellenzellen sind
      // geschriebener Inhalt und zaehlen in page_stats + Volltextindex),
      // `styleText` ist der Prosatext fuer die satzbasierten Stil-Metriken —
      // dort ist „1.2 Mio" kein Satz und verzerrt Satzlaenge, Satzanfaenge und
      // Flesch/LIX. Begruendung in lib/html-text.js#stripTableBlocks.
      const styleText = htmlToText(stripTableBlocks(pd.html || ''));
      return { page_id: p.id, book_id: bookId, tok, words, chars, updated_at: p.updated_at || null, cached_at: now, wordList, sentences, preview, fullText: text, styleText };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { wordList, sentences, preview, fullText, styleText, ...statsItem } = r.value;
        statsItems.push(statsItem);
        previewItems.push({ page_id: r.value.page_id, preview_text: preview || null });
        totalWords += r.value.words;
        totalChars += r.value.chars;
        totalTok += r.value.tok;
        totalSentences += sentences;
        for (const w of wordList) globalWordSet.add(w.toLowerCase());

        // Stil-Index auf dem Prosatext, Figuren-Erwaehnungen auf dem Volltext:
        // eine in einer Tabellenzelle genannte Figur ist genannt.
        const indexResult = computePageIndex(styleText, { extraStopwords });
        indexItems.push({ page_id: r.value.page_id, index: indexResult, fullText });
      }
    }
  }
  const uniqueWords = globalWordSet.size;
  const avgSentenceLen = totalSentences > 0 ? Math.round((totalWords / totalSentences) * 10) / 10 : null;

  // Buch-Level-Lesbarkeit: gewichteter Durchschnitt über alle Seiten (nach Wortzahl).
  // Eine aus gesamten Totals neu berechnete Kennzahl wäre mathematisch korrekter,
  // der gewichtete Durchschnitt liegt aber praktisch sehr nah daran und spart Aggregat-Spalten.
  const wordsByPage = Object.fromEntries(statsItems.map(s => [s.page_id, s.words]));
  let lixSum = 0, fleschSum = 0, lixWords = 0, fleschWords = 0;
  for (const item of indexItems) {
    const w = wordsByPage[item.page_id] || 0;
    if (w <= 0) continue;
    if (typeof item.index.lix === 'number') { lixSum += item.index.lix * w; lixWords += w; }
    if (typeof item.index.flesch_de === 'number') { fleschSum += item.index.flesch_de * w; fleschWords += w; }
  }
  const avgLix = lixWords > 0 ? Math.round((lixSum / lixWords) * 10) / 10 : null;
  const avgFleschDe = fleschWords > 0 ? Math.round((fleschSum / fleschWords) * 10) / 10 : null;

  // pages-Cache VOR page_stats: page_stats.page_id REFERENCES pages(page_id).
  // Bei Erst-Sync eines Buchs sind die pages-Rows sonst noch nicht da → FK-Fail.
  _upsertPagesCache(bookId, pages, chapters);
  upsertPageStatsMany(statsItems);

  if (previewItems.length) {
    const stmtPrev = db.prepare('UPDATE pages SET preview_text = ? WHERE page_id = ?');
    db.transaction(() => { for (const item of previewItems) stmtPrev.run(item.preview_text, item.page_id); })();
  }

  // Index-Felder (Pronomen, Dialog, Sätze, Content-Sig) schreiben —
  // muss nach upsertPageStatsMany laufen, weil es UPDATE auf existierende Rows nutzt.
  if (indexItems.length) {
    db.transaction(() => { for (const item of indexItems) writePageIndex(item.page_id, item.index); })();
  }

  // Figuren-Mentions mit Volltext neu berechnen (präziser als preview_text-Hook in saveFigurenToDb).
  // Läuft über alle User, die Figuren für dieses Buch haben (figure_id ist eindeutig pro User).
  // Figuren-Liste einmal pro Buch laden und durchreichen — die Query ist pro Seite identisch.
  const bookFigures = loadBookFiguresForMentions(bookId);
  for (const item of indexItems) {
    try { writeFigureMentionsForPageAllUsers(item.page_id, bookId, item.fullText, bookFigures); }
    catch (e) { logger.warn(`Figuren-Mentions für Seite ${item.page_id} fehlgeschlagen: ${e.message}`); }
  }

  // Volltext-Index nach Sync-Pull aktualisieren. Buch-Meta + Kapitel
  // werden ueber upsertBook/upsertChapters in _upsertPagesCache implizit
  // beruehrt; Seiten haben nach upsertPageStatsMany die neuen body_html-Werte.
  try {
    searchIndex.upsertBookMeta(bookId);
    for (const ch of chapters) searchIndex.upsertChapter(ch.id);
    for (const item of indexItems) searchIndex.upsertPage(item.page_id);
  } catch (e) {
    logger.warn(`Search-Index Sync Buch ${bookId} fehlgeschlagen: ${e.message}`);
  }

  // Buch-Totale = Σ Seiten-Stats. Seiten- und Kapitelnamen sind kein Teil
  // des Umfangs (siehe computeStats).
  const bookWords = totalWords, bookChars = totalChars, bookTok = totalTok;

  // Lokales Datum statt UTC: book_stats_history.recorded_at muss zur lokalen
  // User-Wahrnehmung passen. Frontend-Streak/Heute-Ring iteriert ebenfalls
  // lokal — beide Seiten in derselben TZ (process.env.TZ, default Europe/Zurich).
  const today = localIsoDate();
  db.prepare(`
    INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, recorded_at) DO UPDATE SET
      page_count=excluded.page_count,
      words=excluded.words, chars=excluded.chars, tok=excluded.tok,
      unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
      avg_sentence_len=excluded.avg_sentence_len,
      avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
  `).run(bookId, today, pages.length, bookWords, bookChars, bookTok, uniqueWords, chapterCount, avgSentenceLen, avgLix, avgFleschDe);

  logger.info(`Sync Buch ${bookId} (${bookName}): ${pages.length} Seiten, ${chapterCount} Kapitel, ${bookWords} Wörter, ${uniqueWords} einzigartige, Ø ${avgSentenceLen} W/Satz, LIX ${avgLix}, Flesch ${avgFleschDe}`);
  return { page_count: pages.length, words: bookWords, chars: bookChars, tok: bookTok, unique_words: uniqueWords, chapter_count: chapterCount, avg_sentence_len: avgSentenceLen, avg_lix: avgLix, avg_flesch_de: avgFleschDe };
}

async function _syncAllBooksInner() {
  const books = db.prepare('SELECT book_id FROM books ORDER BY book_id').all();
  if (!books.length) {
    logger.info('Sync: keine Buecher vorhanden.');
    return;
  }
  logger.info(`Sync: ${books.length} Buch/Buecher.`);
  for (const { book_id: bookId } of books) {
    await runWithContext({ ...getContext(), book: bookId }, async () => {
      try { await syncBook(bookId, null); }
      catch (e) { logger.error(`Sync Buch ${bookId} fehlgeschlagen: ${_errDetail(e)}`); }
    });
  }
}

async function syncAllBooks() {
  const t0 = Date.now();
  logger.info('Sync gestartet.');
  try {
    await _syncAllBooksInner();
  } finally {
    const s = Math.round((Date.now() - t0) / 1000);
    const dur = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    logger.info(`Sync beendet (${dur}).`);
  }
}

// POST /sync/pages/:book_id – leichtgewichtiger pages-Cache-Update (ohne Seiten-Inhalte)
router.post('/pages/:book_id', async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  if (req.query.source === 'manual') {
    logger.info(`«Seiten laden» geklickt (book=${bookId})`);
  } else if (req.query.source === 'bookSwitch') {
    logger.info(`Buch gewechselt (book=${bookId})`);
  }
  try {
    // Über mehrere Tabs/schnelle Buchwechsel coalescen — fire-and-forget Aufrufer
    // teilen sich einen laufenden Cache-Update statt ihn zu vervielfachen.
    await _coalesce(_inflightPagesCache, bookId, () => syncPagesCache(bookId, null));
    res.json({ ok: true });
  } catch (e) {
    logger.error('pages-Cache Sync Fehler: ' + _errDetail(e));
    res.status(500).json({ error: e.message });
  }
});

// Stats für veraltete/fehlende Seiten neu berechnen. `requestedSet` (Set|null)
// grenzt auf konkrete Seiten ein (Lazy-Pfad); null = alle. Yield zwischen Batches,
// damit der Backfill den Event-Loop nicht monopolisiert.
async function _recomputeStalePageStats(bookId, pages, requestedSet, ctx) {
  const existing = Object.fromEntries(
    db.prepare('SELECT page_id, updated_at FROM page_stats WHERE book_id = ?')
      .all(bookId).map(r => [r.page_id, r.updated_at])
  );
  const stale = pages.filter(p => {
    if (requestedSet && !requestedSet.has(p.id)) return false;
    const cur = existing[p.id];
    return cur === undefined || cur !== (p.updated_at || null);
  });

  const now = new Date().toISOString();
  const newItems = [];
  const BATCH = 10;
  for (let i = 0; i < stale.length; i += BATCH) {
    if (i > 0) await _yield();
    const slice = stale.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(async p => {
      const pd = await contentStore.loadPage(p.id, ctx);
      const { words, chars, tok } = computeStats(pd.html || '');
      return { page_id: p.id, book_id: bookId, tok, words, chars, updated_at: p.updated_at || null, cached_at: now };
    }));
    for (const r of results) if (r.status === 'fulfilled') newItems.push(r.value);
  }
  if (newItems.length) upsertPageStatsMany(newItems);
  return { computed: newItems.length, total: pages.length };
}

// Full-Backfill: vollwertiger pages-Cache-Update (Chapters, Prune, Reconcile) +
// Stats für alle veralteten Seiten. Wird beim Buchwechsel per Coalescing entzerrt.
async function _backfillPageStatsFull(bookId, ctx) {
  const pages = await contentStore.listPages(bookId, ctx);
  const chapters = await contentStore.listChapters(bookId, ctx);
  const bookMeta = await contentStore.loadBook(bookId, ctx).catch(() => null);
  if (bookMeta) upsertBook(bookMeta);
  _upsertPagesCache(bookId, pages, chapters);
  return _recomputeStalePageStats(bookId, pages, null, ctx);
}

// Lazy-Pfad (IntersectionObserver): nur die angefragten pages-Rows einsetzen,
// kein Chapter-/Prune-Aufwand — viewport-priorisiert, daher nicht coalesced.
async function _backfillPageStatsLazy(bookId, requestedIds, ctx) {
  const pages = await contentStore.listPages(bookId, ctx);
  const bookRow = db.prepare('SELECT 1 FROM books WHERE book_id = ?').get(bookId);
  if (!bookRow) {
    const bookMeta = await contentStore.loadBook(bookId, ctx).catch(() => null);
    if (bookMeta) upsertBook(bookMeta);
  }
  const stmt = db.prepare(`
    INSERT INTO pages (page_id, book_id, page_name, chapter_id, updated_at, last_seen_at)
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET
      book_id=excluded.book_id, page_name=excluded.page_name,
      updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
  `);
  const seenAt = new Date().toISOString();
  const want = new Set(requestedIds);
  db.transaction(() => {
    // updated_at nie NULL — sonst blockiert die Row den Sync-Keyset-Cursor.
    for (const p of pages) if (want.has(p.id)) stmt.run(p.id, bookId, p.name, p.updated_at || seenAt, seenAt);
  })();
  return _recomputeStalePageStats(bookId, pages, want, ctx);
}

// POST /sync/page-stats/:book_id – leichtgewichtiger Refresh nur der page_stats-Tabelle.
// Optional `{ ids: [page_id, …] }` priorisiert konkrete Seiten (IntersectionObserver-Lazy-Pfad);
// ohne ids werden alle Seiten mit fehlendem oder veraltetem stats-Eintrag gerechnet.
// Antwort: { stats: { [page_id]: { tok, words, chars, updated_at } }, computed, total }.
router.post('/page-stats/:book_id', express.json(), async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  const requestedIds = Array.isArray(req.body?.ids)
    ? Array.from(new Set(req.body.ids.map(toIntId).filter(Boolean)))
    : null;
  if (requestedIds && !requestedIds.length) {
    return res.json({ stats: {}, computed: 0, total: 0 });
  }

  try {
    // Full-Backfill über mehrere Tabs/schnelle Buchwechsel coalescen; Lazy-Pfad
    // bleibt eigenständig (klein + viewport-priorisiert).
    const result = requestedIds
      ? await _backfillPageStatsLazy(bookId, requestedIds, null)
      : await _coalesce(_inflightStatsFull, bookId, () => _backfillPageStatsFull(bookId, null));

    const map = {};
    if (requestedIds) {
      const placeholders = requestedIds.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT page_id, tok, words, chars, updated_at FROM page_stats
         WHERE book_id = ? AND page_id IN (${placeholders})`
      ).all(bookId, ...requestedIds);
      for (const r of rows) map[r.page_id] = { tok: r.tok, words: r.words, chars: r.chars, updated_at: r.updated_at };
    } else {
      const rows = db.prepare(
        'SELECT page_id, tok, words, chars, updated_at FROM page_stats WHERE book_id = ?'
      ).all(bookId);
      for (const r of rows) map[r.page_id] = { tok: r.tok, words: r.words, chars: r.chars, updated_at: r.updated_at };
    }

    logger.info(`page-stats Buch ${bookId}: ${result.computed} neu, ${result.total} total${requestedIds ? ' (lazy)' : ''}.`);
    res.json({ stats: map, computed: result.computed, total: result.total });
  } catch (e) {
    logger.error('page-stats Sync Fehler: ' + _errDetail(e));
    res.status(500).json({ error: e.message });
  }
});

// POST /sync/book/:book_id – manueller Trigger für ein Buch
router.post('/book/:book_id', async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  try {
    const result = await syncBook(bookId, null);
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error('Sync-Route Fehler: ' + _errDetail(e));
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, syncAllBooks, syncBook, syncPagesCache };
