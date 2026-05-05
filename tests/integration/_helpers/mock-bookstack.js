'use strict';
// Stubs lib/bookstack via require.cache. Pre-load before any module that
// requires it. Tests call `setBook(...)` to seed canned book/chapter/page data.

const path = require('path');

let state = { chapters: [], pages: [], pageBodies: {}, books: [] };
const callCounts = { bsGet: 0, bsGetAll: 0, bsBatch: 0 };

// Seeding chapters/pages/books tables in SQLite is required since migration 71+
// added FKs across many tables. Migration 81 in particular added FK
// book_id -> books(bookstack_book_id) on 15 tables (caches, stats, job_runs,
// continuity_*, ...). FK enforcement is on; missing parent rows fail INSERTs.
function _seedDb({ chapters, pages, books = [] }) {
  let db;
  try { ({ db } = require('../../../db/connection')); } catch (_) { return; }
  const insBook = db.prepare(
    "INSERT OR IGNORE INTO books (bookstack_book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)"
  );
  const insChap = db.prepare(
    'INSERT OR IGNORE INTO chapters (chapter_id, book_id, chapter_name, updated_at) VALUES (?, ?, ?, ?)'
  );
  const insPage = db.prepare(
    'INSERT OR IGNORE INTO pages (page_id, book_id, page_name, chapter_id, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  const chIds = new Set();
  db.transaction(() => {
    const bookIds = new Set();
    for (const c of chapters) if (c.book_id) bookIds.add(c.book_id);
    for (const p of pages) if (p.book_id) bookIds.add(p.book_id);
    for (const b of books) if (b && b.id) bookIds.add(b.id);
    const nowIso = new Date().toISOString();
    for (const bid of bookIds) {
      insBook.run(bid, `Test-Book-${bid}`, nowIso, nowIso);
    }
    for (const c of chapters) {
      insChap.run(c.id, c.book_id, c.name || '', c.updated_at || '');
      chIds.add(c.id);
    }
    for (const p of pages) {
      // Tests sometimes use chapter_id values that do not exist in the seed
      // (filter-test fixtures). pages.chapter_id has FK SET NULL → store NULL
      // for unknown chapter references so the FK does not block the insert.
      const knownCh = p.chapter_id && chIds.has(p.chapter_id) ? p.chapter_id : null;
      insPage.run(p.id, p.book_id, p.name || '', knownCh, p.updated_at || '');
    }
  })();
}

function _wipeDb() {
  let db;
  try { ({ db } = require('../../../db/connection')); } catch (_) { return; }
  db.transaction(() => {
    db.prepare('DELETE FROM pages').run();
    db.prepare('DELETE FROM chapters').run();
    // CASCADE on FK book_id -> books(bookstack_book_id) clears the 15 child
    // tables added in mig 81 (caches, stats, continuity_*, job_runs, ...).
    // Sentinel row (bookstack_book_id=0) stays for pdf_export_profile defaults.
    db.prepare('DELETE FROM books WHERE bookstack_book_id != 0').run();
  })();
}

function setBook({ chapters = [], pages = [], pageBodies = {}, books = [] } = {}) {
  state = { chapters, pages, pageBodies, books };
  _seedDb({ chapters, pages });
}

function _matchListPath(path, key) {
  if (path === key) return true;
  if (path.startsWith(`${key}?`)) return true;
  return false;
}

async function bsGet(reqPath, _token) {
  callCounts.bsGet++;
  const m = reqPath.match(/^pages\/(\d+)$/);
  if (m) {
    const id = parseInt(m[1]);
    const body = state.pageBodies[id];
    if (!body) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    const page = state.pages.find(p => p.id === id) || { id, name: 'Unknown' };
    return { id, html: body, name: page.name };
  }
  throw new Error(`mock-bookstack bsGet: unhandled ${reqPath}`);
}

async function bsGetAll(reqPath, _token) {
  callCounts.bsGetAll++;
  if (_matchListPath(reqPath, 'chapters') || reqPath.startsWith('chapters?')) {
    const bookFilter = reqPath.match(/book_id=(\d+)/);
    const bid = bookFilter ? parseInt(bookFilter[1]) : null;
    return bid ? state.chapters.filter(c => c.book_id === bid) : state.chapters;
  }
  if (_matchListPath(reqPath, 'pages') || reqPath.startsWith('pages?')) {
    const bookFilter = reqPath.match(/book_id=(\d+)/);
    const bid = bookFilter ? parseInt(bookFilter[1]) : null;
    return bid ? state.pages.filter(p => p.book_id === bid) : state.pages;
  }
  if (_matchListPath(reqPath, 'books')) return state.books;
  throw new Error(`mock-bookstack bsGetAll: unhandled ${reqPath}`);
}

async function bsBatch(items, mapper, opts = {}) {
  callCounts.bsBatch++;
  const { batchSize = 15, onBatch = null, signal = null } = opts;
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (onBatch) onBatch(i, items.length);
    const batch = items.slice(i, i + batchSize);
    const ctl = new AbortController();
    const results = await Promise.allSettled(batch.map(it => mapper(it, ctl.signal)));
    for (const r of results) if (r.status === 'fulfilled' && r.value != null) out.push(r.value);
  }
  return out;
}

function authHeader() { return 'Token mock:mock'; }

function install() {
  const bsPath = path.resolve(__dirname, '..', '..', '..', 'lib', 'bookstack.js');
  const stub = { bsGet, bsGetAll, bsBatch, authHeader, BOOKSTACK_URL: 'http://mock' };
  require.cache[require.resolve(bsPath)] = {
    id: bsPath,
    filename: bsPath,
    loaded: true,
    exports: stub,
    children: [],
    paths: [],
  };
}

function reset() {
  state = { chapters: [], pages: [], pageBodies: {}, books: [] };
  callCounts.bsGet = 0;
  callCounts.bsGetAll = 0;
  callCounts.bsBatch = 0;
  _wipeDb();
}

module.exports = { install, setBook, reset, callCounts };
