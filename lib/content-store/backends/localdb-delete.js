'use strict';
// Delete-Operationen fuer das localdb-Backend. Ausgelagert, damit localdb.js
// unter dem LOC-Cap bleibt.

const { db } = require('../../../db/connection');

function _nowIso() { return new Date().toISOString(); }

function _notFound(kind, id) {
  const e = new Error(`${kind} ${id} not found`);
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

async function deletePage(pageId, { deletedBy = null, deviceId = null } = {}) {
  const page = db.prepare('SELECT page_id, book_id, page_name, last_editor_device_id FROM pages WHERE page_id = ?').get(pageId);
  if (!page) throw _notFound('Page', pageId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM pages WHERE page_id = ?').run(pageId);
    db.prepare(`
      INSERT INTO page_deletions (book_id, page_id, page_name, deleted_at, deleted_by_email, device_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      page.book_id,
      page.page_id,
      page.page_name || '',
      _nowIso(),
      deletedBy || null,
      deviceId || page.last_editor_device_id || null
    );
  });
  tx();
  return { ok: true, bookId: page.book_id, pageName: page.page_name || '' };
}

module.exports = { deletePage };
