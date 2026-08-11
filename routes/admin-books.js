'use strict';
// Admin-Verwaltung fuer Buecher: Owner-Zuweisung fuer Buecher ohne Owner
// (entstanden z.B. nach Backend-Switch, wenn das BookStack-Token-User nicht
// im app_users-Verzeichnis lebt). Fuer Buecher mit existierendem Owner geht
// die Reassignment ueber den normalen Transfer-Flow (Owner → Admin macht sich
// selbst zum Editor → neuer Owner → transferOwnership).

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const { setContext } = require('../lib/log-context');
const appUsers = require('../db/app-users');
const bookAccess = require('../db/book-access');
const { db } = require('../db/connection');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
router.use(requireAdmin);

function _normEmail(e) { return (e || '').toString().trim().toLowerCase(); }

// --- DB-Groesse pro Buch (Naeherung) ---------------------------------------
// Summiert die UTF-8-Bytegroesse (LENGTH(CAST(col AS BLOB))) ALLER Spalten jeder
// Tabelle mit book_id-Spalte, plus der nur indirekt (ueber chat_sessions) am Buch
// haengenden Chat-Tabellen (chat_messages, chat_images mit BLOBs). Die Tabellen-
// und Spaltenliste wird dynamisch aus sqlite_master/pragma_table_info gebaut, damit
// neue buch-skopierte Tabellen/Spalten automatisch mitzaehlen (kein manuelles
// Nachpflegen). Dazu kommt der FTS5-Volltextindex (_addFtsBytes): dessen
// Backing-Tabellen (Content-Kopie + Invertindex) sind nicht direkt pro Buch
// trennbar und werden daher proportional zum indexierten Textanteil jedes Buchs
// verteilt. Rest-Overhead (B-Tree-Indizes, Page-Fragmentierung, WAL, freelist)
// ist nicht enthalten — die Summe liegt daher unter der echten Dateigroesse.
const _IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function _sumColsExpr(cols, alias) {
  return cols.map(c => `COALESCE(LENGTH(CAST(${alias}."${c}" AS BLOB)),0)`).join(' + ') || '0';
}

function _colsOf(table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);
}

let _bookBytesSql = null;
function _bookSizeSql() {
  if (_bookBytesSql) return _bookBytesSql;

  // Direkt buch-skopierte Tabellen (book_id-Spalte), ohne FTS5-Virtual-Tables.
  const direct = db.prepare(`
    SELECT m.name FROM sqlite_master m
     WHERE m.type = 'table'
       AND m.name NOT LIKE 'sqlite_%'
       AND m.sql NOT LIKE 'CREATE VIRTUAL%'
       AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) ti WHERE ti.name = 'book_id')
  `).all().map(r => r.name).filter(n => _IDENT.test(n));

  const parts = direct.map(t =>
    `COALESCE((SELECT SUM(${_sumColsExpr(_colsOf(t), 's')}) FROM "${t}" s WHERE s.book_id = b.book_id), 0)`);

  // Indirekt ueber chat_sessions.book_id haengend (keine eigene book_id-Spalte).
  for (const { table, fk } of [{ table: 'chat_messages', fk: 'session_id' },
                               { table: 'chat_images', fk: 'session_id' }]) {
    parts.push(`COALESCE((SELECT SUM(${_sumColsExpr(_colsOf(table), 'x')})
                            FROM "${table}" x JOIN chat_sessions cs ON cs.id = x.${fk}
                           WHERE cs.book_id = b.book_id), 0)`);
  }

  _bookBytesSql = parts.join('\n          + ');
  return _bookBytesSql;
}

// Verteilt den Footprint EINES FTS5-Index proportional auf die Buecher.
// vtab: Virtual-Table-Name; weightExpr: indexierte Spalten als Gewicht pro Buch.
// Liefert Map book_id -> zugeteilte Bytes (Summe == realer Index-Footprint).
function _ftsPairBytes(vtab, weightExpr) {
  if (!_IDENT.test(vtab)) return new Map();
  const present = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(vtab);
  if (!present) return new Map();

  // Footprint = Bytegroesse aller Backing-Tabellen (<vtab>_data/_idx/_content/_docsize/_config).
  const backing = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`)
    .all(vtab.replace(/_/g, '\\_') + '\\_%').map(r => r.name).filter(n => _IDENT.test(n));
  let total = 0;
  for (const t of backing) {
    total += db.prepare(`SELECT COALESCE(SUM(${_sumColsExpr(_colsOf(t), 't')}), 0) AS s FROM "${t}" t`).get().s;
  }
  if (!total) return new Map();

  const weights = db.prepare(
    `SELECT book_id AS bid, COALESCE(SUM(${weightExpr}), 0) AS w FROM "${vtab}" GROUP BY book_id`).all();
  const weightTotal = weights.reduce((a, r) => a + (r.w || 0), 0);
  const out = new Map();
  if (!weightTotal) return out;
  for (const r of weights) {
    if (r.bid != null && r.w) out.set(r.bid, total * r.w / weightTotal);
  }
  return out;
}

// Addiert die proportional verteilten FTS-Index-Bytes auf row.bytes (in place).
function _addFtsBytes(rows) {
  const idx = _ftsPairBytes('search_index', 'LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(body AS BLOB))');
  const tri = _ftsPairBytes('search_trigram', 'LENGTH(CAST(title AS BLOB))');
  for (const r of rows) {
    r.bytes += Math.round((idx.get(r.book_id) || 0) + (tri.get(r.book_id) || 0));
  }
}

// GET /admin/books — Liste aller Buecher mit Owner-Info + ACL-Count + Umfang +
// DB-Grosse-Naeherung ueber alle buch-skopierten Tabellen + FTS-Index (s.o.).
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT b.book_id, b.name, b.owner_email,
           (SELECT COUNT(*) FROM book_access ba WHERE ba.book_id = b.book_id) AS acl_count,
           (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.book_id) AS chapter_count,
           (SELECT COUNT(*) FROM pages p WHERE p.book_id = b.book_id) AS page_count,
           COALESCE((SELECT SUM(chars) FROM page_stats ps WHERE ps.book_id = b.book_id), 0) AS chars,
           (${_bookSizeSql()}) AS bytes
      FROM books b
     ORDER BY b.name COLLATE NOCASE
  `).all();
  _addFtsBytes(rows);
  res.json({ books: rows });
});

// POST /admin/books/:book_id/assign-owner { email }
// Nur fuer Buecher ohne Owner. Setzt books.owner_email und legt book_access-
// Row als 'owner' an (idempotent — bestehende Rolle wird auf owner gehoben).
router.post('/:book_id/assign-owner', express.json({ limit: '4kb' }), (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  setContext({ book: bookId });

  const target = _normEmail(req.body?.email);
  if (!target) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });

  const book = db.prepare('SELECT book_id, owner_email FROM books WHERE book_id = ?').get(bookId);
  if (!book) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
  if (book.owner_email) {
    return res.status(409).json({
      error_code: 'BOOK_HAS_OWNER',
      detail: 'Use /books/:id/transfer-ownership for reassignment',
      current_owner: book.owner_email,
    });
  }

  const user = appUsers.getUser(target);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });
  if (user.status !== 'active') {
    return res.status(400).json({ error_code: 'USER_NOT_ACTIVE', detail: { status: user.status } });
  }

  const performedBy = sessionEmail(req) || 'admin';
  try {
    db.transaction(() => {
      db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(target, bookId);
      bookAccess.grantAccess(bookId, target, 'owner', performedBy);
    })();
    logger.info(`Admin assign-owner: book=${bookId} owner=${target} by ${performedBy}`);
    res.json({ ok: true, book_id: bookId, owner_email: target });
  } catch (e) {
    logger.error(`POST /admin/books/:id/assign-owner: ${e.message}`);
    res.status(500).json({ error_code: 'ASSIGN_FAILED', detail: e.message });
  }
});

module.exports = router;
