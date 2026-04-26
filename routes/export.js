'use strict';

// User-getriggerte Buch-Exports via BookStack /api/books/{id}/export/{fmt}.
// Eigene Route (kein purer Proxy), weil Filename mit Timestamp + Slug erzwungen
// wird — BookStack-Default-Disposition kennt keinen Timestamp.

const express = require('express');
const { Readable } = require('stream');
const logger = require('../logger');
const { getTokenForRequest } = require('../db/schema');
const { bsGet, BOOKSTACK_URL, authHeader } = require('../lib/bookstack');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');

const router = express.Router();

const FORMATS = {
  pdf:  { upstream: 'pdf',       mime: 'application/pdf' },
  html: { upstream: 'html',      mime: 'text/html; charset=utf-8' },
  txt:  { upstream: 'plaintext', mime: 'text/plain; charset=utf-8' },
  md:   { upstream: 'markdown',  mime: 'text/markdown; charset=utf-8' },
};

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

  const filename = buildExportFilename({ prefix: 'book', slug, ext: fmt, date: new Date() });
  res.setHeader('Content-Type', spec.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);

  Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;
