'use strict';

// Manuskript-Import: EIN Dokument (Word/ODT/AbiWord/Legacy-Word) wird anhand
// seiner Ueberschriften-Ebenen in Kapitel und Seiten zerlegt. Der User bestimmt
// pro Ebene die Rolle (h1 = Kapitel, h2 = Seite, …) — die Zuordnung ist der
// ganze Sinn des Features, denn es gibt keine Konvention, an der ein Parser
// erkennen koennte, ob ein h2 ein Unterkapitel oder eine Seite sein soll.
//
// Zwei Eintrittspunkte, EINE Zerlegungslogik (lib/import-parsers/manuscript-split):
//   POST /jobs/manuscript-import/preview  → synchron, schreibt nichts, liefert
//        die Gliederung + gefundene Ueberschriften-Verteilung. Kein KI-Call,
//        darum ausserhalb der Job-Queue (Muster wie /sources/lookup).
//   POST /jobs/manuscript-import          → Job-Queue, legt Kapitel + Seiten an.
//
// Der Dokument-Buffer landet beim POST in `manuscriptBuffers` und wird vom
// Worker konsumiert (Muster wie folder-import).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { parseImportFile, extOf, SUPPORTED_EXTS } = require('../../lib/import-parsers/dispatch');
const {
  splitManuscript, countHeadings, parseHeadingMap, serializeHeadingMap,
} = require('../../lib/import-parsers/manuscript-split');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const bookAccess = require('../../db/book-access');
const { getBookLocale } = require('../../db/schema');
const { db } = require('../../db/connection');
const logger = require('../../logger');

const router = express.Router();

const MAX_DOC_BYTES = 50 * 1024 * 1024;
const BUFFER_TTL_MS = 30 * 60 * 1000;
const PREVIEW_NODE_CAP = 400;

// jobId -> { buffer, filename }
const manuscriptBuffers = new Map();

function _scheduleBufferCleanup(jobId) {
  const t = setTimeout(() => manuscriptBuffers.delete(jobId), BUFFER_TTL_MS);
  t.unref?.();
}

// Namen fuer Seiten/Kapitel ohne eigene Ueberschrift. Buch-Locale entscheidet,
// nicht hartcodiert deutsch (gleiche Regel wie die Monatsnamen im Folder-Import).
function _fallbackNames(bookId, userEmail) {
  const en = bookId ? getBookLocale(bookId, userEmail).startsWith('en') : false;
  return en
    ? { untitledPage: 'Page', untitledChapter: 'Chapter' }
    : { untitledPage: 'Seite', untitledChapter: 'Kapitel' };
}

async function _parseDocument(filename, buffer) {
  const ext = extOf(filename);
  if (!SUPPORTED_EXTS.has(ext)) {
    const err = i18nError('job.error.unsupportedDocument');
    err.error_code = 'UNSUPPORTED_EXT';
    throw err;
  }
  const parsed = await parseImportFile(filename, buffer);
  if (!parsed) {
    const err = i18nError('job.error.unsupportedDocument');
    err.error_code = 'UNSUPPORTED_EXT';
    throw err;
  }
  return parsed;
}

// Gliederung fuer die Vorschau: nur Namen + Zeichenzahl, kein HTML (der Body
// eines Romans waere sonst zweimal ueber die Leitung).
function _outline(nodes, cap = { left: PREVIEW_NODE_CAP }) {
  const out = [];
  for (const n of nodes) {
    if (cap.left <= 0) break;
    cap.left -= 1;
    if (n.type === 'chapter') out.push({ type: 'chapter', name: n.name, children: _outline(n.children, cap) });
    else out.push({ type: 'page', name: n.name, chars: n.html.replace(/<[^>]*>/g, '').trim().length });
  }
  return out;
}

function _countOutline(nodes) {
  let n = 0;
  for (const x of nodes) {
    n += 1;
    if (x.children) n += _countOutline(x.children);
  }
  return n;
}

async function runManuscriptImportJob(jobId, { userEmail, mode, bookName, bookId, headingMap, keepHeadings }) {
  const log = makeJobLogger(jobId);
  const auditLog = [];
  const audit = (level, msg) => {
    auditLog.push({ level, msg, ts: new Date().toISOString() });
    if (level === 'warn') log.warn(msg); else log.info(msg);
  };
  try {
    const entry = manuscriptBuffers.get(jobId);
    if (!entry) throw i18nError('job.error.importBufferMissing');

    updateJob(jobId, { progress: 8, statusText: 'job.manuscript-import.parsing' });
    const parsed = await _parseDocument(entry.filename, entry.buffer);
    const docWarnings = parsed.warnings || [];
    for (const w of docWarnings) audit('warn', `parser: ${w.code}${w.message ? ` — ${w.message}` : ''}`);

    updateJob(jobId, { progress: 20, statusText: 'job.manuscript-import.splitting' });
    const names = _fallbackNames(mode === 'merge' ? bookId : null, userEmail);
    const split = splitManuscript(parsed.html, { headingMap, keepHeadings, ...names });
    audit('info', `Zuordnung ${serializeHeadingMap(headingMap)} → ${split.chapterCount} Kapitel, ${split.pageCount} Seiten`);
    for (const w of split.warnings) audit('warn', `split: ${w.code}${w.name ? ` (${w.name})` : ''}`);
    if (!split.pageCount) throw i18nError('job.error.noPagesFound');

    let effBookId = bookId;
    if (mode === 'new-book') {
      updateJob(jobId, { progress: 25, statusText: 'job.manuscript-import.creatingBook' });
      const created = await contentStore.createBook(
        { name: bookName, owner_email: userEmail },
        { session: { user: { email: userEmail } } },
      );
      effBookId = created.id;
      try {
        db.prepare('UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?')
          .run(userEmail, effBookId);
        bookAccess.grantAccess(effBookId, userEmail, 'owner', userEmail);
      } catch (gErr) {
        logger.warn(`Auto-Owner-Grant fuer book=${effBookId} fehlgeschlagen: ${gErr.message}`);
      }
      audit('info', `Buch erstellt: «${bookName}» id=${effBookId}`);
    }
    if (!effBookId) throw i18nError('job.error.bookMissing');
    setContext({ book: effBookId });

    const ctx = { session: { user: { email: userEmail } } };
    const totalNodes = _countOutline(split.nodes) || 1;
    let done = 0;
    let chaptersCreated = 0;
    let pagesCreated = 0;
    const failures = [];

    // Namens-Dedup unter GESCHWISTERN, nicht buchweit: zwei gleichnamige
    // Ueberschriften nebeneinander waeren im Organizer nicht unterscheidbar,
    // dieselbe Kapitel-Ueberschrift in zwei verschiedenen Teilen dagegen schon.
    // Kapitel und Seiten zaehlen getrennt — eine Seite traegt bewusst den Namen
    // ihres Kapitels, wenn das Dokument keine eigene Seiten-Ueberschrift hat.
    const uniqueName = (seen, type, raw) => {
      const base = raw || '—';
      const key = `${type}|${base}`;
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      return n ? `${base} (${n + 1})` : base;
    };

    const tick = (label) => {
      done += 1;
      updateJob(jobId, {
        progress: 30 + Math.round(62 * (done / totalNodes)),
        statusText: 'job.manuscript-import.creating',
        statusParams: { name: label, current: done, total: totalNodes },
      });
    };

    async function walk(nodes, parentChapterId, depth) {
      let position = 1;
      const seen = new Map();
      for (const node of nodes) {
        if (node.type === 'chapter') {
          tick(node.name);
          let chapterId = null;
          try {
            const ch = await contentStore.createChapter(
              { book_id: effBookId, name: uniqueName(seen, 'chapter', node.name), parent_chapter_id: parentChapterId, position },
              ctx,
            );
            chapterId = ch.id;
            chaptersCreated += 1;
          } catch (e) {
            audit('warn', `createChapter fail «${node.name}»: ${e.message}`);
            failures.push({ name: node.name, reason: 'CHAPTER_FAILED' });
          }
          position += 1;
          // Kapitel unterhalb MAX_CHAPTER_DEPTH=3 kann der Splitter nicht
          // liefern; der Guard bleibt trotzdem, damit ein spaeterer Rollen-
          // Zusatz nicht still eine vierte Ebene anlegt.
          await walk(node.children, chapterId ?? parentChapterId, depth + 1);
        } else {
          tick(node.name);
          try {
            await contentStore.createPage(
              { book_id: effBookId, chapter_id: parentChapterId, name: uniqueName(seen, 'page', node.name), html: node.html },
              ctx,
            );
            pagesCreated += 1;
          } catch (e) {
            audit('warn', `createPage fail «${node.name}»: ${e.message}`);
            failures.push({ name: node.name, reason: 'PAGE_FAILED' });
          }
        }
      }
    }
    await walk(split.nodes, null, 1);

    audit('info', `Import abgeschlossen: ${pagesCreated} Seiten, ${chaptersCreated} Kapitel, ${failures.length} Fehler`);

    if (pagesCreated > 0) {
      updateJob(jobId, { progress: 95, statusText: 'job.manuscript-import.syncing' });
      try {
        const { syncBook } = require('../sync');
        await syncBook(effBookId, ctx);
      } catch (e) {
        audit('warn', `Stats-Sync fail: ${e.message}`);
      }
    }

    completeJob(jobId, {
      bookId: effBookId,
      pagesCreated,
      chaptersCreated,
      headingMap: serializeHeadingMap(headingMap),
      headingCounts: split.headingCounts,
      outline: _outline(split.nodes),
      outlineTruncated: _countOutline(split.nodes) > PREVIEW_NODE_CAP,
      skipped: failures,
      warnings: [...docWarnings, ...split.warnings],
      auditLog,
    });
  } catch (e) {
    if (e?.name !== 'AbortError') log.error(`manuscript-import job ${jobId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    manuscriptBuffers.delete(jobId);
  }
}

const rawDocBody = express.raw({
  type: [
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text',
    'application/msword',
  ],
  limit: MAX_DOC_BYTES + 1,
});

// Body-Guards, die Preview und Import teilen. Liefert null, wenn die Antwort
// schon raus ist (Muster wie routes/research-acl.js).
function _guardBody(req, res) {
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error_code: 'EMPTY_BODY' });
    return null;
  }
  if (req.body.length > MAX_DOC_BYTES) {
    res.status(413).json({ error_code: 'DOCUMENT_TOO_LARGE' });
    return null;
  }
  const filename = String(req.query?.filename || '').trim();
  if (!SUPPORTED_EXTS.has(extOf(filename))) {
    res.status(400).json({ error_code: 'UNSUPPORTED_EXT' });
    return null;
  }
  return { filename, headingMap: parseHeadingMap(req.query?.map), keepHeadings: req.query?.keep_headings === '1' };
}

router.post('/manuscript-import/preview', rawDocBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  const guarded = _guardBody(req, res);
  if (!guarded) return;
  try {
    const parsed = await _parseDocument(guarded.filename, req.body);
    const split = splitManuscript(parsed.html, {
      headingMap: guarded.headingMap,
      keepHeadings: guarded.keepHeadings,
    });
    res.json({
      headingMap: serializeHeadingMap(guarded.headingMap),
      headingCounts: countHeadings(parsed.html),
      chapterCount: split.chapterCount,
      pageCount: split.pageCount,
      outline: _outline(split.nodes),
      outlineTruncated: _countOutline(split.nodes) > PREVIEW_NODE_CAP,
      warnings: [...(parsed.warnings || []), ...split.warnings],
    });
  } catch (e) {
    if (e.error_code) return res.status(400).json({ error_code: e.error_code });
    logger.warn(`manuscript-import preview fail: ${e.message}`);
    res.status(422).json({ error_code: 'PARSE_FAILED' });
  }
});

router.post('/manuscript-import', rawDocBody, async (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const mode = (req.query?.mode === 'merge') ? 'merge' : 'new-book';
  const bookName = String(req.query?.book_name || '').trim();
  const bookId = mode === 'merge' ? toIntId(req.query?.book_id) : null;

  if (mode === 'new-book' && !bookName) return res.status(400).json({ error_code: 'BOOK_NAME_REQUIRED' });
  if (mode === 'merge' && !bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });

  const guarded = _guardBody(req, res);
  if (!guarded) return;

  if (mode === 'merge') {
    setContext({ book: bookId });
    try { requireBookAccess(req, bookId, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }

  const dedupKey = mode === 'merge' ? `merge:${bookId}` : `new:${bookName}`;
  const existing = findActiveJobId('manuscript-import', dedupKey, userEmail);
  if (existing) return res.json({ jobId: existing, deduplicated: true });

  const jobId = createJob(
    'manuscript-import',
    bookId || 0,
    userEmail,
    'job.label.manuscriptImportBook',
    { name: bookName || `Book #${bookId}` },
    dedupKey,
  );
  manuscriptBuffers.set(jobId, { buffer: req.body, filename: guarded.filename });
  _scheduleBufferCleanup(jobId);

  enqueueJob(jobId, () => runManuscriptImportJob(jobId, {
    userEmail, mode, bookName, bookId,
    headingMap: guarded.headingMap,
    keepHeadings: guarded.keepHeadings,
  }));
  res.status(202).json({ jobId });
});

module.exports = { manuscriptImportRouter: router, runManuscriptImportJob, manuscriptBuffers };
