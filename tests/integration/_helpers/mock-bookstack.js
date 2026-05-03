'use strict';
// Stubs lib/bookstack via require.cache. Pre-load before any module that
// requires it. Tests call `setBook(...)` to seed canned book/chapter/page data.

const path = require('path');

let state = { chapters: [], pages: [], pageBodies: {}, books: [] };
const callCounts = { bsGet: 0, bsGetAll: 0, bsBatch: 0 };

function setBook({ chapters = [], pages = [], pageBodies = {}, books = [] } = {}) {
  state = { chapters, pages, pageBodies, books };
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
}

module.exports = { install, setBook, reset, callCounts };
