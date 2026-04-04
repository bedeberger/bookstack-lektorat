const express = require('express');
const { db, getAnyUserToken, getAllUserTokens } = require('../db/schema'); // getAnyUserToken used in POST /book/:book_id
const logger = require('../logger');

const router = express.Router();

const BOOKSTACK_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

// ~4-Zeichen-Heuristik: SYSTEM_LEKTORAT + buildLektoratPrompt-Wrapper ≈ 3250 Zeichen Overhead
const PROMPT_OVERHEAD = 3250;

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

async function syncBook(bookId, token) {
  const [pages, book] = await Promise.all([
    bsGetAll(`pages?book_id=${bookId}`, token),
    bsGet(`books/${bookId}`, token),
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

// POST /sync/book/:book_id – manueller Trigger für ein Buch
router.post('/book/:book_id', async (req, res) => {
  const token = req.session?.bookstackToken
    ? { token_id: req.session.bookstackToken.id, token_pw: req.session.bookstackToken.pw }
    : getAnyUserToken();
  if (!token) return res.status(503).json({ error: 'Kein BookStack-Token verfügbar.' });
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

module.exports = { router, syncAllBooks, syncBook };
