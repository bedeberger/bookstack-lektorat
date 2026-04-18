const express = require('express');
const { db, getAnyUserToken, getAllUserTokens, reconcilePageIds } = require('../db/schema'); // getAnyUserToken used in POST /book/:book_id
const logger = require('../logger');
const { CHARS_PER_TOKEN } = require('../lib/ai');
const { computePageIndex, writePageIndex, writeFigureMentionsForPageAllUsers, METRICS_VERSION } = require('../lib/page-index');

const router = express.Router();

const BOOKSTACK_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

const PROMPT_OVERHEAD = 3250; // SYSTEM_LEKTORAT + buildLektoratPrompt-Wrapper ≈ 3250 Zeichen Overhead

function authHeader(token) {
  return token ? `Token ${token.token_id}:${token.token_pw}` : '';
}

async function bsGet(path, token) {
  const resp = await fetch(`${BOOKSTACK_URL}/api/${path}`, {
    headers: { Authorization: authHeader(token) },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`BookStack /api/${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function bsGetAll(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await bsGet(`${path}${sep}count=500&offset=0`, token);
  let all = first.data || [];
  while (all.length < first.total) {
    const page = await bsGet(`${path}${sep}count=500&offset=${all.length}`, token);
    all = all.concat(page.data || []);
  }
  return all;
}

function htmlToText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function computeStats(html) {
  const text = htmlToText(html);
  const wordList = text.trim() === '' ? [] : text.trim().split(/\s+/);
  const words = wordList.length;
  const chars = text.length;
  const tok = Math.round((PROMPT_OVERHEAD + chars) / CHARS_PER_TOKEN);
  const sentences = text.trim() === '' ? 0 : text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  return { words, chars, tok, wordList, sentences };
}

const upsertPageStats = db.prepare(`
  INSERT INTO page_stats (page_id, book_id, tok, words, chars, updated_at, cached_at)
  VALUES (@page_id, @book_id, @tok, @words, @chars, @updated_at, @cached_at)
  ON CONFLICT(page_id) DO UPDATE SET
    tok=excluded.tok, words=excluded.words, chars=excluded.chars,
    updated_at=excluded.updated_at, cached_at=excluded.cached_at
`);

const upsertPageStatsMany = db.transaction((items) => {
  for (const item of items) upsertPageStats.run(item);
});

const _upsertPageCacheStmt = db.prepare(`
  INSERT INTO pages (page_id, book_id, page_name, chapter_id, chapter_name, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(page_id) DO UPDATE SET
    book_id=excluded.book_id, page_name=excluded.page_name,
    chapter_id=excluded.chapter_id, chapter_name=excluded.chapter_name,
    updated_at=excluded.updated_at
`);

const _upsertChapterStmt = db.prepare(`
  INSERT INTO chapters (chapter_id, book_id, chapter_name, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chapter_id, book_id) DO UPDATE SET
    chapter_name=excluded.chapter_name, updated_at=excluded.updated_at
`);

const _delChapterCacheByKey = db.prepare(
  'DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_key = ?'
);

// Leichtgewichtiger pages-Cache-Update (ohne Seiten-Inhalte laden).
// Wird sowohl von syncBook() als auch vom /sync/pages/:book_id-Endpunkt genutzt.
function _upsertPagesCache(bookId, pages, chapters) {
  const chMap = Object.fromEntries(chapters.map(c => [c.id, c.name]));

  // Kapitel-Umbenennungen erkennen → Extrakt-Cache für alle User invalidieren.
  const storedChapters = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookId);
  const storedChMap = Object.fromEntries(storedChapters.map(c => [c.chapter_id, c.chapter_name]));
  for (const c of chapters) {
    if (storedChMap[c.id] !== undefined && storedChMap[c.id] !== c.name) {
      logger.info(`Kapitel ${c.id} (Buch ${bookId}) umbenannt: «${storedChMap[c.id]}» → «${c.name}» – Extrakt-Cache invalidiert.`);
      _delChapterCacheByKey.run(bookId, String(c.id));
    }
  }

  db.transaction(() => {
    for (const p of pages) {
      _upsertPageCacheStmt.run(
        p.id, bookId, p.name,
        p.chapter_id || null,
        p.chapter_id ? (chMap[p.chapter_id] || null) : null,
        p.updated_at || null
      );
    }
    for (const c of chapters) {
      _upsertChapterStmt.run(c.id, bookId, c.name, c.updated_at || null);
    }
  })();
  reconcilePageIds();
}

const PREVIEW_CHARS = 800;

async function syncPagesCache(bookId, token) {
  const [pages, chapters] = await Promise.all([
    bsGetAll(`pages?book_id=${bookId}`, token),
    bsGetAll(`chapters?book_id=${bookId}`, token),
  ]);
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
      await Promise.allSettled(toFetch.slice(i, i + BATCH).map(async p => {
        try {
          const pd = await bsGet(`pages/${p.id}`, token);
          const text = htmlToText(pd.html || '').trim();
          stmtPrev.run(text ? text.slice(0, PREVIEW_CHARS) : null, p.id);
        } catch { /* einzelne Seite überspringen */ }
      }));
    }
  }

  logger.info(`pages-Cache Buch ${bookId}: ${pages.length} Seiten, ${toFetch.length} Vorschau(en) nachgeladen.`);
}

async function syncBook(bookId, token) {
  const [pages, book, chapters] = await Promise.all([
    bsGetAll(`pages?book_id=${bookId}`, token),
    bsGet(`books/${bookId}`, token),
    bsGetAll(`chapters?book_id=${bookId}`, token),
  ]);
  const chapterCount = chapters.length;

  const bookName = book.name || '';
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

  const previewItems = [];
  const indexItems = [];
  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async p => {
      const pd = await bsGet(`pages/${p.id}`, token);
      const text = htmlToText(pd.html || '');
      const { words, chars, tok, wordList, sentences } = computeStats(pd.html || '');
      const preview = text.trim().slice(0, 800);
      return { page_id: p.id, book_id: bookId, tok, words, chars, updated_at: p.updated_at || null, cached_at: now, wordList, sentences, preview, fullText: text };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { wordList, sentences, preview, fullText, ...statsItem } = r.value;
        statsItems.push(statsItem);
        previewItems.push({ page_id: r.value.page_id, preview_text: preview || null });
        totalWords += r.value.words;
        totalChars += r.value.chars;
        totalTok += r.value.tok;
        totalSentences += sentences;
        for (const w of wordList) globalWordSet.add(w.toLowerCase());

        const indexResult = computePageIndex(fullText);
        indexItems.push({ page_id: r.value.page_id, index: indexResult, fullText });
      }
    }
  }
  const uniqueWords = globalWordSet.size;
  const avgSentenceLen = totalSentences > 0 ? Math.round((totalWords / totalSentences) * 10) / 10 : null;

  upsertPageStatsMany(statsItems);
  _upsertPagesCache(bookId, pages, chapters);

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
  for (const item of indexItems) {
    try { writeFigureMentionsForPageAllUsers(item.page_id, bookId, item.fullText); }
    catch (e) { logger.warn(`Figuren-Mentions für Seite ${item.page_id} fehlgeschlagen: ${e.message}`); }
  }

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO book_stats_history (book_id, book_name, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, recorded_at) DO UPDATE SET
      book_name=excluded.book_name, page_count=excluded.page_count,
      words=excluded.words, chars=excluded.chars, tok=excluded.tok,
      unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
      avg_sentence_len=excluded.avg_sentence_len
  `).run(bookId, bookName, today, pages.length, totalWords, totalChars, totalTok, uniqueWords, chapterCount, avgSentenceLen);

  logger.info(`Sync Buch ${bookId} (${bookName}): ${pages.length} Seiten, ${chapterCount} Kapitel, ${totalWords} Wörter, ${uniqueWords} einzigartige, Ø ${avgSentenceLen} W/Satz`);
  return { page_count: pages.length, words: totalWords, chars: totalChars, tok: totalTok, unique_words: uniqueWords, chapter_count: chapterCount, avg_sentence_len: avgSentenceLen };
}

async function syncAllBooks() {
  const users = getAllUserTokens();
  if (!users.length) {
    logger.warn('Sync übersprungen: kein BookStack-Token in der Datenbank hinterlegt.');
    return;
  }

  // Bücherliste einmalig mit dem ersten verfügbaren Token holen (gleiche BookStack-Instanz für alle User)
  let books;
  for (const u of users) {
    try {
      books = await bsGetAll('books', u);
      break;
    } catch (e) {
      logger.warn(`Sync: Bücherliste mit Token von ${u.email} fehlgeschlagen – nächsten versuchen.`);
    }
  }
  if (!books) {
    logger.error('Sync abgebrochen: kein gültiger Token für Bücherliste gefunden.');
    return;
  }

  logger.info(`Sync: ${books.length} Buch/Bücher, ${users.length} User`);
  for (const book of books) {
    // Jeden User durchprobieren bis einer erfolgreich ist (Tokens können abgelaufen sein)
    let synced = false;
    for (const u of users) {
      try {
        await syncBook(book.id, u);
        synced = true;
        break;
      } catch (e) {
        logger.warn(`Sync Buch ${book.id} mit Token von ${u.email} fehlgeschlagen: ${e.message}`);
      }
    }
    if (!synced) logger.error(`Sync Buch ${book.id}: alle User-Tokens fehlgeschlagen.`);
  }
  logger.info('Sync abgeschlossen.');
}

// GET /sync/pages/:book_id – gecachte Seiten-Vorschautexte liefern
router.get('/pages/:book_id', (req, res) => {
  const rows = db.prepare(
    'SELECT page_id, preview_text, updated_at FROM pages WHERE book_id = ?'
  ).all(parseInt(req.params.book_id));
  const result = {};
  for (const r of rows) result[r.page_id] = { preview_text: r.preview_text, updated_at: r.updated_at };
  res.json(result);
});

// POST /sync/pages/:book_id – leichtgewichtiger pages-Cache-Update (ohne Seiten-Inhalte)
router.post('/pages/:book_id', async (req, res) => {
  const token = req.session?.bookstackToken
    ? { token_id: req.session.bookstackToken.id, token_pw: req.session.bookstackToken.pw }
    : getAnyUserToken();
  if (!token) return res.status(503).json({ error_code: 'NO_BOOKSTACK_TOKEN' });
  try {
    await syncPagesCache(parseInt(req.params.book_id), token);
    res.json({ ok: true });
  } catch (e) {
    logger.error('pages-Cache Sync Fehler: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /sync/book/:book_id – manueller Trigger für ein Buch
router.post('/book/:book_id', async (req, res) => {
  const token = req.session?.bookstackToken
    ? { token_id: req.session.bookstackToken.id, token_pw: req.session.bookstackToken.pw }
    : getAnyUserToken();
  if (!token) return res.status(503).json({ error_code: 'NO_BOOKSTACK_TOKEN' });
  try {
    const result = await syncBook(parseInt(req.params.book_id), token);
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error('Sync-Route Fehler: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /sync/all – alle Bücher
router.post('/all', async (_req, res) => {
  syncAllBooks().catch(e => logger.error('Sync /all Fehler: ' + e.message));
  res.json({ ok: true, message: 'Sync gestartet' });
});

module.exports = { router, syncAllBooks, syncBook, syncPagesCache };
