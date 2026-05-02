'use strict';
// Ideen pro Seite — User-isolierte Notizen für mögliche Fortsetzungen, Szenen,
// inhaltliche Anker. Werden im Seiten-Chat als Kontext eingespielt (nur offene).

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const MAX_LEN = 4000;

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

// Map page_id → Anzahl offener Ideen für ein Buch (für Tree-Indikatoren).
router.get('/counts', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT page_id, COUNT(*) AS n
    FROM ideen
    WHERE book_id = ? AND user_email = ? AND erledigt = 0
    GROUP BY page_id
  `).all(bookId, userEmail);
  const map = {};
  for (const r of rows) map[r.page_id] = r.n;
  res.json(map);
});

// Liste aller Ideen einer Seite (offen oben, dann erledigte; je Block neueste zuerst).
router.get('/', (req, res) => {
  const userEmail = userEmailOrNull(req);
  const pageId = toIntId(req.query.page_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!pageId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT id, book_id, page_id, page_name, content, erledigt, erledigt_at, created_at, updated_at
    FROM ideen
    WHERE page_id = ? AND user_email = ?
    ORDER BY erledigt ASC, created_at DESC
  `).all(pageId, userEmail);
  res.json(rows);
});

// Idee anlegen.
router.post('/', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const pageId = toIntId(req.body?.page_id);
  const pageName = (req.body?.page_name || '').toString().slice(0, 500) || null;
  const content = (req.body?.content || '').toString().trim();
  if (!bookId || !pageId) return res.status(400).json({ error_code: 'BOOKID_PAGEID_REQ' });
  if (!content)           return res.status(400).json({ error_code: 'CONTENT_REQ' });
  if (content.length > MAX_LEN) return res.status(400).json({ error_code: 'CONTENT_TOO_LONG' });

  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO ideen (book_id, page_id, page_name, user_email, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, pageId, pageName, userEmail, content, now, now);

  const row = db.prepare(
    'SELECT id, book_id, page_id, page_name, content, erledigt, erledigt_at, created_at, updated_at FROM ideen WHERE id = ?'
  ).get(result.lastInsertRowid);
  logger.info(`[ideen] create id=${row.id} page=${pageId} user=${userEmail}`);
  res.json(row);
});

// Content + erledigt-Flag aktualisieren (Felder optional einzeln).
router.patch('/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });

  const existing = db.prepare(
    'SELECT id, book_id, page_id, erledigt FROM ideen WHERE id = ? AND user_email = ?'
  ).get(id, userEmail);
  if (!existing) return res.status(404).json({ error_code: 'IDEE_NOT_FOUND' });

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
  let movedFrom = null, movedTo = null;
  if (typeof req.body?.page_id !== 'undefined') {
    const newPageId = toIntId(req.body.page_id);
    if (!newPageId) return res.status(400).json({ error_code: 'INVALID_PAGE_ID' });
    if (existing.erledigt) return res.status(400).json({ error_code: 'IDEE_DONE' });
    const targetPage = db.prepare('SELECT book_id FROM page_stats WHERE page_id = ?').get(newPageId);
    if (!targetPage || targetPage.book_id !== existing.book_id) {
      return res.status(400).json({ error_code: 'BOOK_MISMATCH' });
    }
    const newPageName = (req.body?.page_name || '').toString().slice(0, 500) || null;
    movedFrom = existing.page_id;
    movedTo = newPageId;
    sets.push('page_id = ?');   vals.push(newPageId);
    sets.push('page_name = ?'); vals.push(newPageName);
  }
  if (!sets.length) return res.status(400).json({ error_code: 'NO_FIELDS' });

  const now = new Date().toISOString();
  sets.push('updated_at = ?'); vals.push(now);
  vals.push(id, userEmail);
  db.prepare(`UPDATE ideen SET ${sets.join(', ')} WHERE id = ? AND user_email = ?`).run(...vals);

  const row = db.prepare(
    'SELECT id, book_id, page_id, page_name, content, erledigt, erledigt_at, created_at, updated_at FROM ideen WHERE id = ?'
  ).get(id);
  if (movedTo) logger.info(`[ideen] move id=${id} from=${movedFrom} to=${movedTo} user=${userEmail}`);
  res.json(row);
});

// Idee löschen.
router.delete('/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const r = db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, userEmail);
  if (!r.changes) return res.status(404).json({ error_code: 'IDEE_NOT_FOUND' });
  res.json({ ok: true });
});

module.exports = router;
