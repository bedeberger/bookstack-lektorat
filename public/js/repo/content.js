// Frontend-Domain-Repository fuer Buch-/Kapitel-/Seiten-Inhalte.
//
// Caller (Editor, Lektorat, Chat, History, Tree) reden nur noch hierhin —
// nicht mehr direkt mit BookStack-Pfaden unter /api/*. Antwort-Shape ist das
// App-Domain-Shape aus lib/content-mapper.js.
//
// Diese Datei + lib/content-mapper.js + routes/content.js sind zusammen mit
// public/js/api-bookstack.js und lib/bookstack.js die EINZIGEN Stellen, an
// denen die BookStack-API noch erkennbar sein darf (Tripwire-Liste, siehe
// docs/bookstack-exit.md Schritt 6).

import { stripFocusArtefacts } from '../utils.js';
import { getDeviceId } from '../device-id.js';
import { EVT } from '../events.js';

const GET_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 90000;
const MAX_RETRY_429 = 3;

function _parseRetryAfter(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30000, Math.round(secs * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(30000, Math.max(0, date - Date.now()));
  return null;
}

async function _fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('content timeout')), timeoutMs);
  // Externes Signal (z.B. Buchwechsel-Abort vom Caller) mit Timeout-Signal mergen,
  // damit `_get`/`_write` von aussen unterbrochen werden können.
  const external = opts?.signal;
  let detach;
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else {
      const onAbort = () => ctrl.abort(external.reason);
      external.addEventListener('abort', onAbort, { once: true });
      detach = () => external.removeEventListener('abort', onAbort);
    }
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    detach?.();
  }
}

async function _errBody(r) {
  try { return await r.json(); } catch { return null; }
}

function _httpError(method, path, status, body) {
  const err = new Error(`${method} /content/${path} HTTP ${status}`);
  err.status = status;
  err.body = body || null;
  err.code = body?.error_code || null;
  err.detail = body?.detail || null;
  return err;
}

// SW-Cache-Invalidation nach Writes: ohne Bust serviert SWR auf Folge-Reads
// die alte Fassung — ein Read-Modify-Write-Pfad (Lektorat-Save, Chat-Vorschlag)
// ueberschreibt sonst frische Server-Edits mit Stale-Daten. Postmessage an
// public/sw.js#invalidate-content-Handler im CONTENT_CACHE-Namespace.
function _invalidateContentCache(paths) {
  if (typeof navigator === 'undefined') return;
  const ctrl = navigator.serviceWorker?.controller;
  if (!ctrl) return;
  const arr = Array.isArray(paths) ? paths : [paths];
  try { ctrl.postMessage({ type: 'invalidate-content', paths: arr }); } catch {}
}

async function _get(path, { fresh = false, signal } = {}) {
  // `?__fresh=1` umgeht den SW-CONTENT_CACHE — Pflicht fuer Read-Modify-Write-
  // Pfade (Editor-Open, Lektorat-Save) damit der nachfolgende PUT nicht frische
  // Server-Edits mit Stale-Daten ueberschreibt.
  const url = '/content/' + path + (fresh ? (path.includes('?') ? '&' : '?') + '__fresh=1' : '');
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const r = await _fetchWithTimeout(url, { signal }, GET_TIMEOUT_MS);
    if (r.ok) return r.json();
    if (r.status !== 429 || attempt === MAX_RETRY_429) {
      throw _httpError('GET', path, r.status, await _errBody(r));
    }
    const wait = _parseRetryAfter(r.headers.get('Retry-After'))
      ?? Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(rs => setTimeout(rs, wait));
  }
}

async function _write(method, path, body, invalidationPaths) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const r = await _fetchWithTimeout('/content/' + path, opts, WRITE_TIMEOUT_MS);
    if (r.ok) {
      _invalidateContentCache(invalidationPaths || path);
      return r.status === 204 ? null : r.json();
    }
    if (r.status !== 429 || attempt === MAX_RETRY_429) {
      throw _httpError(method, path, r.status, await _errBody(r));
    }
    const wait = _parseRetryAfter(r.headers.get('Retry-After'))
      ?? Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(rs => setTimeout(rs, wait));
  }
}

export const contentRepo = {
  // GET /content/books → [{id, name, slug, description, updated_at, created_at}]
  listBooks(opts)               { return _get('books', opts); },

  // GET /content/books/:id → einzelnes Buch (Domain-Shape).
  loadBook(id, opts)            { return _get('books/' + id, opts); },

  // GET /content/books/:id/tree → { chapters: [{...c, pages: [...]}], topPages: [...] }
  bookTree(id, opts)            { return _get('books/' + id + '/tree', opts); },

  // Sortier-SSoT.
  // GET → { tree, updated_at, updated_by }; PUT { order_json } setzt den
  // vollstaendigen Baum atomar (Validierung + Materialisierung in Tx).
  loadOrder(id, opts)           { return _get('books/' + id + '/order', opts); },
  saveOrder(id, tree) {
    return _write('PUT', 'books/' + id + '/order', { order_json: tree },
      ['books/' + id + '/order', 'books/' + id + '/tree']);
  },

  // GET /content/chapters/:id → einzelnes Kapitel.
  loadChapter(id, opts)         { return _get('chapters/' + id, opts); },

  // GET /content/pages/:id → Seite inkl. `html`.
  // `stripFocusArtefacts` haengt der Editor-Output an, der Repo-Read normalisiert
  // ihn weg — Caller bekommen niemals den Persistenz-Backup-Marker zu sehen.
  async loadPage(id, opts) {
    const page = await _get('pages/' + id, opts);
    if (page && typeof page.html === 'string') page.html = stripFocusArtefacts(page.html);
    return page;
  },

  // PUT /content/pages/:id mit `{ html?, name?, position?, chapter_id?, source? }`.
  // Server cleant html, mapped position→priority. Bei Body-Change schreibt die
  // content-store-Facade eine page_revisions-Row mit `source` (Default 'main') —
  // Frontend dispatcht danach `page-revisions:changed`, damit die Revisionsliste
  // sich aktualisiert ohne Page-Reload. SW-Invalidation muss neben der Page
  // auch die Revisionsliste umfassen, sonst liefert SWR beim folgenden Reload
  // der Liste den Stand vor dem Save.
  async savePage(id, body) {
    const hasHtml = typeof body?.html === 'string';
    // Geraet-Stempel nur bei Body-Change: macht den geraete-bewussten /changes-Feed
    // praezise (eigener Browser-Save wird ausgefiltert, andere Geraete nicht).
    const payload = hasHtml ? { ...body, device_id: getDeviceId() } : body;
    const inv = hasHtml ? ['pages/' + id, 'pages/' + id + '/revisions'] : ['pages/' + id];
    const out = await _write('PUT', 'pages/' + id, payload, inv);
    if (hasHtml && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVT.PAGE_REVISIONS_CHANGED, { detail: { pageId: id } }));
    }
    return out;
  },

  // POST /content/pages/:id/images — Manuskript-Bild hochladen. `file` ist ein
  // File/Blob; der Body sind die rohen Bytes (Server normalisiert via sharp).
  // Liefert { id, url, width, height, mime }. Kein SW-Cache-Bust noetig — das
  // Bild-BLOB liegt nicht im CONTENT_CACHE.
  async uploadPageImage(id, file) {
    const r = await _fetchWithTimeout('/content/pages/' + id + '/images', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }, WRITE_TIMEOUT_MS);
    if (!r.ok) throw _httpError('POST', 'pages/' + id + '/images', r.status, await _errBody(r));
    return r.json();
  },

  // Alias fuer Strukturoperationen (rename/move/reorder ohne Body-Change).
  async updatePage(id, body) {
    // Invalidiert auch das Buch-Tree-Listing, weil Rename/Move dort sichtbar wird.
    const inv = ['pages/' + id];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('PUT', 'pages/' + id, body, inv);
  },

  // POST /content/pages mit `{ book_id?, chapter_id?, name, html? }`.
  async createPage(body) {
    const inv = ['pages'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('POST', 'pages', body, inv);
  },

  // DELETE /content/pages/:id. Liefert null.
  async deletePage(id) {
    const deviceId = getDeviceId();
    const path = 'pages/' + id + (deviceId ? '?device_id=' + encodeURIComponent(deviceId) : '');
    return _write('DELETE', path);
  },

  // POST /content/pages/:id/move — Seite in anderes Buch verschieben.
  // body: { target_book_id, target_chapter_id? }. Invalidiert die Tree-Listings
  // BEIDER Buecher (Quelle via sourceBookId-Opt, Ziel via target_book_id).
  async movePage(id, body, { sourceBookId } = {}) {
    const inv = ['pages/' + id];
    if (sourceBookId) inv.push('books/' + sourceBookId + '/tree');
    if (body?.target_book_id) inv.push('books/' + body.target_book_id + '/tree');
    return _write('POST', 'pages/' + id + '/move', body, inv);
  },

  // POST /content/chapters mit `{ book_id, name, position?, description? }`.
  async createChapter(body) {
    const inv = ['chapters'];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('POST', 'chapters', body, inv);
  },

  async updateChapter(id, body) {
    const inv = ['chapters/' + id];
    if (body?.book_id) inv.push('books/' + body.book_id + '/tree');
    return _write('PUT', 'chapters/' + id, body, inv);
  },

  async deleteChapter(id) {
    return _write('DELETE', 'chapters/' + id);
  },

  // POST /content/books mit `{ name, description? }`. Server upserted lokale books-Row.
  async createBook(body) {
    return _write('POST', 'books', body, ['books']);
  },

  async updateBook(id, body) {
    return _write('PUT', 'books/' + id, body, ['books', 'books/' + id]);
  },

  async deleteBook(id) {
    return _write('DELETE', 'books/' + id, undefined, ['books', 'books/' + id]);
  },

  // GET /content/search?query=…&book_id=… → { hits: [Page-Meta] }
  async search(query, { bookId, count } = {}) {
    const params = new URLSearchParams({ query });
    if (bookId) params.set('book_id', String(bookId));
    if (count) params.set('count', String(count));
    return _get('search?' + params.toString());
  },
};
