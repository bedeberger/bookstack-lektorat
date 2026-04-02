const express = require('express');
const { db } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();

const BOOKSTACK_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

// ~4-Zeichen-Heuristik: SYSTEM_LEKTORAT + buildLektoratPrompt-Wrapper ≈ 3250 Zeichen Overhead
const PROMPT_OVERHEAD = 3250;

function authHeader() {
  return `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
}

async function bsGet(path) {
  const resp = await fetch(`${BOOKSTACK_URL}/api/${path}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`BookStack /api/${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function bsGetAll(path) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await bsGet(`${path}${sep}count=500&offset=0`);
  let all = first.data || [];
  while (all.length < first.total) {
    const page = await bsGet(`${path}${sep}count=500&offset=${all.length}`);
    all = all.concat(page.data || []);
  }
  return all;
}

function htmlToText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function computeStats(html) {
  const text = htmlToText(html);
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  const chars = text.length;
  const tok = Math.round((PROMPT_OVERHEAD + chars + html.length) / 4);
  return { words, chars, tok };
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

async function syncBook(bookId) {
  const [pages, book] = await Promise.all([
    bsGetAll(`pages?book_id=${bookId}`),
    bsGet(`books/${bookId}`),
  ]);

  const bookName = book.name || '';
  const now = new Date().toISOString();
  const BATCH = 5;
  const statsItems = [];
  let totalWords = 0, totalChars = 0, totalTok = 0;

  for (let i = 0; i < pages.length; i += BATCH) {
    const batch = pages.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async p => {
      const pd = await bsGet(`pages/${p.id}`);
      const { words, chars, tok } = computeStats(pd.html || '');
      return { page_id: p.id, book_id: bookId, tok, words, chars, updated_at: p.updated_at || null, cached_at: now };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        statsItems.push(r.value);
        totalWords += r.value.words;
        totalChars += r.value.chars;
        totalTok += r.value.tok;
      }
    }
  }

  upsertPageStatsMany(statsItems);

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO book_stats_history (book_id, book_name, recorded_at, page_count, words, chars, tok)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id, recorded_at) DO UPDATE SET
      book_name=excluded.book_name, page_count=excluded.page_count,
      words=excluded.words, chars=excluded.chars, tok=excluded.tok
  `).run(bookId, bookName, today, pages.length, totalWords, totalChars, totalTok);

  logger.info(`Sync Buch ${bookId} (${bookName}): ${pages.length} Seiten, ${totalWords} Wörter, ${totalChars} Zeichen`);
  return { page_count: pages.length, words: totalWords, chars: totalChars, tok: totalTok };
}

async function syncAllBooks() {
  const books = await bsGetAll('books');
  logger.info(`Sync: ${books.length} Buch/Bücher`);
  for (const book of books) {
    try {
      await syncBook(book.id);
    } catch (e) {
      logger.error(`Sync Buch ${book.id} fehlgeschlagen: ${e.message}`);
    }
  }
  logger.info('Sync abgeschlossen.');
}

// POST /sync/book/:book_id – manueller Trigger für ein Buch
router.post('/book/:book_id', async (req, res) => {
  try {
    const result = await syncBook(parseInt(req.params.book_id));
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

module.exports = { router, syncAllBooks, syncBook };
