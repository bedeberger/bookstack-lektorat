'use strict';
// Ideen pro Seite ODER pro Kapitel — User-isolierte Notizen für mögliche
// Fortsetzungen, Szenen, inhaltliche Anker. Werden im Seiten-Chat als Kontext
// eingespielt (nur offene; Seite + umliegendes Kapitel).
//
// Scope-Modell: jede Idee gehört entweder zu einer Seite ODER zu einem Kapitel
// (XOR-CHECK im Schema). Cross-Kind-Move ist nicht erlaubt — Page-Idee bleibt
// Page-Idee, Chapter-Idee bleibt Chapter-Idee.

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../lib/acl');
const { resolvePageBookId, resolveChapterBookId } = require('../lib/content-ownership');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const MAX_LEN = 4000;

const SELECT_ROW = `
  SELECT i.id, i.book_id, i.page_id, p.page_name,
         i.chapter_id, c.chapter_name,
         i.content, i.erledigt, i.erledigt_at, i.created_at, i.updated_at
  FROM ideen i
  LEFT JOIN pages    p ON p.page_id    = i.page_id
  LEFT JOIN chapters c ON c.chapter_id = i.chapter_id
`;

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// Map page_id ODER chapter_id → Anzahl offener Ideen für ein Buch.
// `kind=page` (Default) zaehlt Seiten-Ideen; `kind=chapter` zaehlt Kapitel-Ideen.
router.get('/counts', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  const kind = req.query.kind === 'chapter' ? 'chapter' : 'page';
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const col = kind === 'chapter' ? 'chapter_id' : 'page_id';
  const rows = db.prepare(`
    SELECT ${col} AS scope_id, COUNT(*) AS n
    FROM ideen
    WHERE book_id = ? AND user_email = ? AND erledigt = 0 AND ${col} IS NOT NULL
    GROUP BY ${col}
  `).all(bookId, userEmail);
  const map = {};
  for (const r of rows) map[r.scope_id] = r.n;
  res.json(map);
});

// Liste aller Ideen einer Seite ODER eines Kapitels (offen oben, dann erledigte;
// je Block neueste zuerst). Genau ein Scope-Parameter ist erforderlich.
router.get('/', (req, res) => {
  const userEmail = sessionEmail(req);
  const pageId = toIntId(req.query.page_id);
  const chapterId = toIntId(req.query.chapter_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if ((!pageId && !chapterId) || (pageId && chapterId)) {
    return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  }

  let bookId;
  let rows;
  if (pageId) {
    bookId = resolvePageBookId(pageId);
    if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
    if (!_guard(req, res, bookId, 'editor')) return;
    rows = db.prepare(`
      ${SELECT_ROW}
      WHERE i.page_id = ? AND i.user_email = ?
      ORDER BY i.erledigt ASC, i.created_at DESC
    `).all(pageId, userEmail);
  } else {
    bookId = resolveChapterBookId(chapterId);
    if (!bookId) return res.status(404).json({ error_code: 'CHAPTER_NOT_FOUND' });
    if (!_guard(req, res, bookId, 'editor')) return;
    rows = db.prepare(`
      ${SELECT_ROW}
      WHERE i.chapter_id = ? AND i.user_email = ?
      ORDER BY i.erledigt ASC, i.created_at DESC
    `).all(chapterId, userEmail);
  }
  res.json(rows);
});

// Idee anlegen (XOR page_id / chapter_id).
router.post('/', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const pageId = toIntId(req.body?.page_id);
  const chapterId = toIntId(req.body?.chapter_id);
  const content = (req.body?.content || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if ((!pageId && !chapterId) || (pageId && chapterId)) {
    return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  }
  if (!content)                 return res.status(400).json({ error_code: 'CONTENT_REQ' });
  if (content.length > MAX_LEN) return res.status(400).json({ error_code: 'CONTENT_TOO_LONG' });
  if (!_guard(req, res, bookId, 'editor')) return;

  // Cross-Check: page/chapter muss zum Buch gehoeren.
  if (pageId) {
    if (resolvePageBookId(pageId) !== bookId) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
  } else {
    if (resolveChapterBookId(chapterId) !== bookId) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
  }

  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, pageId || null, chapterId || null, userEmail, content, now, now);

  const row = db.prepare(`${SELECT_ROW} WHERE i.id = ?`).get(result.lastInsertRowid);
  searchIndex.upsertIdea(row.id);
  logger.info(`[ideen] create id=${row.id} ${pageId ? 'page=' + pageId : 'chapter=' + chapterId}`);
  res.json(row);
});

// Content + erledigt-Flag + Move aktualisieren (Felder optional einzeln).
// Move bleibt within-kind: Page-Idee kann nur auf andere Seite, Chapter-Idee
// nur auf anderes Kapitel.
router.patch('/:id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });

  const existing = db.prepare(
    'SELECT id, book_id, page_id, chapter_id, erledigt FROM ideen WHERE id = ? AND user_email = ?'
  ).get(id, userEmail);
  if (!existing) return res.status(404).json({ error_code: 'IDEE_NOT_FOUND' });
  if (!_guard(req, res, existing.book_id, 'editor')) return;

  const sets = [];
  const vals = [];
  if (typeof req.body?.content === 'string') {
    const c = req.body.content.trim();
    if (!c) return res.status(400).json({ error_code: 'CONTENT_REQ' });
    if (c.length > MAX_LEN) return res.status(400).json({ error_code: 'CONTENT_TOO_LONG' });
    sets.push('content = ?'); vals.push(c);
  }
  if (typeof req.body?.erledigt !== 'undefined') {
    const flag = req.body.erledigt ? 1 : 0;
    sets.push('erledigt = ?');    vals.push(flag);
    sets.push('erledigt_at = ?'); vals.push(flag ? new Date().toISOString() : null);
  }
  let movedFrom = null, movedTo = null, movedKind = null;
  const hasPageMove    = typeof req.body?.page_id    !== 'undefined';
  const hasChapterMove = typeof req.body?.chapter_id !== 'undefined';
  if (hasPageMove && hasChapterMove) return res.status(400).json({ error_code: 'INVALID_SCOPE' });
  if (hasPageMove) {
    const newPageId = toIntId(req.body.page_id);
    if (!newPageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (existing.erledigt) return res.status(400).json({ error_code: 'IDEE_DONE' });
    if (existing.page_id === null) return res.status(400).json({ error_code: 'KIND_MISMATCH' });
    if (resolvePageBookId(newPageId) !== existing.book_id) {
      return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
    }
    movedFrom = existing.page_id;
    movedTo = newPageId;
    movedKind = 'page';
    sets.push('page_id = ?'); vals.push(newPageId);
  } else if (hasChapterMove) {
    const newChapterId = toIntId(req.body.chapter_id);
    if (!newChapterId) return res.status(400).json({ error_code: 'INVALID_CHAPTER_ID' });
    if (existing.erledigt) return res.status(400).json({ error_code: 'IDEE_DONE' });
    if (existing.chapter_id === null) return res.status(400).json({ error_code: 'KIND_MISMATCH' });
    if (resolveChapterBookId(newChapterId) !== existing.book_id) {
      return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
    }
    movedFrom = existing.chapter_id;
    movedTo = newChapterId;
    movedKind = 'chapter';
    sets.push('chapter_id = ?'); vals.push(newChapterId);
  }
  if (!sets.length) return res.status(400).json({ error_code: 'NO_FIELDS' });

  const now = new Date().toISOString();
  sets.push('updated_at = ?'); vals.push(now);
  vals.push(id, userEmail);
  db.prepare(`UPDATE ideen SET ${sets.join(', ')} WHERE id = ? AND user_email = ?`).run(...vals);

  const row = db.prepare(`${SELECT_ROW} WHERE i.id = ?`).get(id);
  searchIndex.upsertIdea(id);
  if (movedTo) logger.info(`[ideen] move id=${id} kind=${movedKind} from=${movedFrom} to=${movedTo}`);
  res.json(row);
});

// Idee löschen.
router.delete('/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const existing = db.prepare('SELECT book_id FROM ideen WHERE id = ? AND user_email = ?').get(id, userEmail);
  if (!existing) return res.status(404).json({ error_code: 'IDEE_NOT_FOUND' });
  if (!_guard(req, res, existing.book_id, 'editor')) return;
  db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, userEmail);
  searchIndex.remove('idea', id);
  res.json({ ok: true });
});

module.exports = router;
