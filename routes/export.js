'use strict';

// User-getriggerte Buch-Exports via BookStack /api/books/{id}/export/{fmt}.
// Eigene Route (kein purer Proxy), weil Filename mit Timestamp + Slug erzwungen
// wird — BookStack-Default-Disposition kennt keinen Timestamp.
//
// EPUB ist BookStack-fremd (BookStack kennt nur pdf/html/plaintext/markdown):
// wir bauen das EPUB serverseitig aus dem Kapitel-/Seiten-Tree zusammen und
// verpacken es mit `epub-gen-memory`.

const express = require('express');
const { Readable } = require('stream');
const { EPub } = require('epub-gen-memory');
const logger = require('../logger');
const { getTokenForRequest } = require('../db/schema');
const { bsGet, bsGetAll, BOOKSTACK_URL, authHeader } = require('../lib/bookstack');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');

const router = express.Router();

const FORMATS = {
  pdf:  { upstream: 'pdf',       mime: 'application/pdf' },
  html: { upstream: 'html',      mime: 'text/html; charset=utf-8' },
  txt:  { upstream: 'plaintext', mime: 'text/plain; charset=utf-8' },
  md:   { upstream: 'markdown',  mime: 'text/markdown; charset=utf-8' },
  epub: { upstream: null,        mime: 'application/epub+zip' },
};

async function buildEpubBuffer(bookId, token, book) {
  const [chapters, pages] = await Promise.all([
    bsGetAll('chapters?filter[book_id]=' + bookId, token),
    bsGetAll('pages?filter[book_id]=' + bookId, token),
  ]);
  if (!pages.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

  const sortedChapters = [...chapters].sort((a, b) => a.priority - b.priority);
  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const sortedPages = [...pages].sort((a, b) => {
    const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
    const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
    if (aO !== bO) return aO - bO;
    return a.priority - b.priority;
  });

  // Pro Seite das gerenderte HTML laden (`/api/pages/{id}` liefert `html`).
  const pageDetails = await Promise.all(
    sortedPages.map(p => bsGet('pages/' + p.id, token).catch(() => null))
  );

  const epubChapters = [];
  let lastChapterId = Symbol('none');
  for (let i = 0; i < sortedPages.length; i++) {
    const p = sortedPages[i];
    const pd = pageDetails[i];
    if (!pd || !pd.html) continue;

    // Kapitel-Trenner-Eintrag, sobald wir auf eine neue Chapter-ID stossen.
    if (p.chapter_id && p.chapter_id !== lastChapterId) {
      const ch = sortedChapters.find(c => c.id === p.chapter_id);
      if (ch) {
        const intro = ch.description_html || (ch.description ? `<p>${ch.description}</p>` : '');
        epubChapters.push({
          title: ch.name,
          content: intro || `<h1>${ch.name}</h1>`,
          excludeFromToc: false,
          beforeToc: false,
        });
      }
      lastChapterId = p.chapter_id;
    } else if (!p.chapter_id) {
      lastChapterId = Symbol('none');
    }

    epubChapters.push({
      title: p.name,
      content: pd.html,
    });
  }

  const author = book.created_by?.name || book.owned_by?.name || '';
  const epub = new EPub(
    {
      title: book.name || `Book ${bookId}`,
      author: author || undefined,
      description: book.description || undefined,
      lang: 'de',
      tocTitle: 'Inhalt',
      ignoreFailedDownloads: true,
    },
    epubChapters,
  );
  return epub.genEpub();
}

router.get('/book/:id/:fmt', async (req, res) => {
  const id = toIntId(req.params.id);
  const fmt = String(req.params.fmt || '').toLowerCase();
  const spec = FORMATS[fmt];
  if (!id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!spec) return res.status(400).json({ error_code: 'BAD_FORMAT' });

  const token = getTokenForRequest(req);
  if (!token) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });

  let book;
  try {
    book = await bsGet(`books/${id}`, token);
  } catch (e) {
    if (e.status === 401 || e.status === 403) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
    if (e.status === 404) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
    logger.error(`Export-Metadata fehlgeschlagen (book=${id}): ${e.message}`);
    return res.status(502).json({ error_code: 'BOOKSTACK_UNREACHABLE' });
  }
  const slug = book.slug || book.name || `book${id}`;
  const filename = buildExportFilename({ prefix: 'book', slug, ext: fmt, date: new Date() });

  if (fmt === 'epub') {
    let buf;
    try {
      buf = await buildEpubBuffer(id, token, book);
    } catch (e) {
      if (e.code === 'BOOK_EMPTY') return res.status(400).json({ error_code: 'BOOK_EMPTY' });
      if (e.status === 401 || e.status === 403) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
      logger.error(`EPUB-Build fehlgeschlagen (book=${id}): ${e.message}`);
      return res.status(502).json({ error_code: 'EXPORT_FAILED' });
    }
    res.setHeader('Content-Type', spec.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  }

  let upstream;
  try {
    upstream = await fetch(`${BOOKSTACK_URL}/api/books/${id}/export/${spec.upstream}`, {
      headers: { Authorization: authHeader(token) },
    });
  } catch (e) {
    logger.error(`Export-Fetch fehlgeschlagen (book=${id}, fmt=${fmt}): ${e.message}`);
    return res.status(502).json({ error_code: 'BOOKSTACK_UNREACHABLE' });
  }
  if (!upstream.ok) {
    if (upstream.statusCode === 401 || upstream.status === 401) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
    return res.status(upstream.status).json({ error_code: 'EXPORT_FAILED' });
  }

  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);

  Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;
