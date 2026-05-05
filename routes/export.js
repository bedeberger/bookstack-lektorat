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
const HTMLtoDOCX = require('@turbodocx/html-to-docx');
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
  docx: { upstream: null,        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
};

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildNavMapXml(chapters) {
  let play = 0;
  let openParent = false;
  let out = '<navMap>\n';
  chapters.forEach((c, i) => {
    const lvl = c.__level || 0;
    const id = `np_${i}`;
    const file = c.filename;
    const title = escXml(c.title);
    if (lvl === 0) {
      if (openParent) { out += '</navPoint>\n'; openParent = false; }
      const cls = c.__hasChildren ? 'part' : 'chapter';
      out += `<navPoint id="${id}" playOrder="${++play}" class="${cls}">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      if (c.__hasChildren) openParent = true;
      else out += '</navPoint>\n';
    } else {
      out += `<navPoint id="${id}" playOrder="${++play}" class="chapter">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      out += '</navPoint>\n';
    }
  });
  if (openParent) out += '</navPoint>\n';
  out += '</navMap>';
  return out;
}

function buildTocXhtmlBody(chapters, tocTitle) {
  let openParent = false;
  let out = `<h1 class="h1">${escXml(tocTitle)}</h1>\n<nav id="toc" epub:type="toc">\n<ol style="list-style: none">\n`;
  chapters.forEach(c => {
    const lvl = c.__level || 0;
    const file = c.filename;
    const title = escXml(c.title);
    if (lvl === 0) {
      if (openParent) { out += '</ol>\n</li>\n'; openParent = false; }
      if (c.__hasChildren) {
        out += `<li class="table-of-content"><a href="${file}">${title}</a>\n<ol style="list-style: none">\n`;
        openParent = true;
      } else {
        out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
      }
    } else {
      out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
    }
  });
  if (openParent) out += '</ol>\n</li>\n';
  out += '</ol>\n</nav>';
  return out;
}

async function loadBookContents(bookId, token) {
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

  const pageDetails = await Promise.all(
    sortedPages.map(p => bsGet('pages/' + p.id, token).catch(() => null))
  );
  const valid = sortedPages
    .map((p, i) => ({ p, pd: pageDetails[i] }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

  const groups = [];
  let cur = null;
  for (const x of valid) {
    if (x.p.chapter_id) {
      if (!cur || cur.chapterId !== x.p.chapter_id) {
        cur = {
          chapterId: x.p.chapter_id,
          chapter: sortedChapters.find(c => c.id === x.p.chapter_id) || null,
          pages: [],
        };
        groups.push(cur);
      }
      cur.pages.push(x);
    } else {
      groups.push({ chapterId: null, chapter: null, pages: [x] });
      cur = null;
    }
  }
  return { groups };
}

async function buildEpubBuffer(bookId, token, book) {
  const { groups } = await loadBookContents(bookId, token);

  // Materialisieren mit __level/__hasChildren + expliziten filenames.
  const epubChapters = [];
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const introHtml = ch
      ? (ch.description_html || (ch.description ? `<p>${escXml(ch.description)}</p>` : ''))
      : '';
    if (ch && g.pages.length > 1) {
      // Kapitel als Parent, Seiten als Kinder.
      epubChapters.push({
        title: ch.name,
        content: introHtml || `<h1>${escXml(ch.name)}</h1>`,
        filename: `chap_${gi}.xhtml`,
        __level: 0,
        __hasChildren: true,
      });
      g.pages.forEach((x, pi) => {
        epubChapters.push({
          title: x.p.name,
          content: x.pd.html,
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
        });
      });
    } else {
      // Flach: Single-Page-Kapitel oder Seite ohne Kapitel.
      const x = g.pages[0];
      const title = ch ? ch.name : x.p.name;
      const content = ch ? (introHtml + x.pd.html) : x.pd.html;
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: 0,
        __hasChildren: false,
      });
    }
  });

  const navMapXml = buildNavMapXml(epubChapters);
  const tocBody = buildTocXhtmlBody(epubChapters, 'Inhalt');
  const tocNCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="<%= id %>"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text><%= title %></text></docTitle>
<docAuthor><text><%= author.join(", ") %></text></docAuthor>
${navMapXml}
</ncx>`;
  const tocXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="<%- lang %>" lang="<%- lang %>">
<head>
<title><%= title %></title>
<meta charset="UTF-8" />
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${tocBody}
</body>
</html>`;

  const author = book.created_by?.name || book.owned_by?.name || '';
  const epub = new EPub(
    {
      title: book.name || `Book ${bookId}`,
      author: author || undefined,
      description: book.description || undefined,
      lang: 'de',
      tocTitle: 'Inhalt',
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    epubChapters,
  );
  return epub.genEpub();
}

async function buildDocxBuffer(bookId, token, book) {
  const { groups } = await loadBookContents(bookId, token);
  const author = book.created_by?.name || book.owned_by?.name || '';
  const bookTitle = book.name || `Book ${bookId}`;

  let body = `<h1 style="page-break-before: avoid; text-align: center;">${escXml(bookTitle)}</h1>\n`;
  if (author) body += `<p style="text-align: center;"><em>${escXml(author)}</em></p>\n`;
  if (book.description) body += `<p style="text-align: center;">${escXml(book.description)}</p>\n`;

  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const introHtml = ch
      ? (ch.description_html || (ch.description ? `<p>${escXml(ch.description)}</p>` : ''))
      : '';
    if (ch && g.pages.length > 1) {
      body += `<h1 style="page-break-before: always;">${escXml(ch.name)}</h1>\n`;
      if (introHtml) body += introHtml + '\n';
      g.pages.forEach((x) => {
        body += `<h2>${escXml(x.p.name)}</h2>\n`;
        body += x.pd.html + '\n';
      });
    } else {
      const x = g.pages[0];
      const title = ch ? ch.name : x.p.name;
      const breakStyle = gi === 0 ? '' : ' style="page-break-before: always;"';
      body += `<h1${breakStyle}>${escXml(title)}</h1>\n`;
      if (ch && introHtml) body += introHtml + '\n';
      body += x.pd.html + '\n';
    }
  });

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escXml(bookTitle)}</title></head><body>${body}</body></html>`;

  const buf = await HTMLtoDOCX(html, null, {
    title: bookTitle,
    creator: author || undefined,
    orientation: 'portrait',
    pageSize: { width: 11906, height: 16838 },
    pageNumber: true,
    font: 'Calibri',
    fontSize: 22,
    table: { row: { cantSplit: true } },
  });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
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

  if (fmt === 'epub' || fmt === 'docx') {
    let buf;
    try {
      buf = fmt === 'epub'
        ? await buildEpubBuffer(id, token, book)
        : await buildDocxBuffer(id, token, book);
    } catch (e) {
      if (e.code === 'BOOK_EMPTY') return res.status(400).json({ error_code: 'BOOK_EMPTY' });
      if (e.status === 401 || e.status === 403) return res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
      logger.error(`${fmt.toUpperCase()}-Build fehlgeschlagen (book=${id}): ${e.message}`);
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
