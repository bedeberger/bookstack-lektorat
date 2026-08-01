'use strict';
// Content-Store-Facade über das localdb-Backend. Dünner Wrapper, der Schreib-
// Chokepoint für Page-Revisions und FTS-Index-Hooks bleibt und Tree-Overlay
// aus book_order anwendet.
//
// Konsumenten importieren `require('../lib/content-store')` — die Auflösung
// trifft `lib/content-store/index.js` (Node-Folder-Resolution).

const localdbBackend = require('./backends/localdb');
const pageRevisions = require('../../db/page-revisions');
const bookOrder = require('../../db/book-order');
const deviceTokens = require('../../db/device-tokens');
const { uaLabel } = require('../ua-label');
const logger = require('../../logger');

let _searchIndexCached = null;
function _searchIndex() {
  if (_searchIndexCached !== null) return _searchIndexCached;
  try { _searchIndexCached = require('../search'); }
  catch (e) {
    logger.warn(`[content-store] searchIndex nicht verfuegbar: ${e.message}`);
    _searchIndexCached = false;
  }
  return _searchIndexCached || null;
}

// Fund-Index der Quellen-Belege (source_citations). Lazy wie der FTS-Index,
// damit ein Ladefehler den Content-Store nicht mitnimmt.
let _citeIndexCached = null;
function _citeIndex() {
  if (_citeIndexCached !== null) return _citeIndexCached;
  try { _citeIndexCached = require('../cite-index'); }
  catch (e) {
    logger.warn(`[content-store] citeIndex nicht verfuegbar: ${e.message}`);
    _citeIndexCached = false;
  }
  return _citeIndexCached || null;
}

// Index der Querverweise (xref_links + xref_anchors). Lazy wie der Beleg-Index,
// damit ein Ladefehler den Content-Store nicht mitnimmt.
let _xrefIndexCached = null;
function _xrefIndex() {
  if (_xrefIndexCached !== null) return _xrefIndexCached;
  try { _xrefIndexCached = require('../xref-index'); }
  catch (e) {
    logger.warn(`[content-store] xrefIndex nicht verfuegbar: ${e.message}`);
    _xrefIndexCached = false;
  }
  return _xrefIndexCached || null;
}

// Extrahiert User-Email aus ctx, wenn es ein Express-Request ist. Sonst null
// (Cron-Jobs, Worker mit Token-only-ctx).
function _userEmailFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return ctx.session?.user?.email || null;
}

// Bekannte Plattform-Codes auf huebsche Schreibweise mappen; sonst erstes
// Zeichen gross. Gilt fuer den Request-Header und das statische Token-Feld
// gleichermassen, damit das Label konsistent aussieht.
const _PLATFORM_LABELS = {
  macos: 'macOS', ios: 'iOS', android: 'Android',
  windows: 'Windows', linux: 'Linux', web: 'Web',
};
function _prettyPlatform(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = p.trim();
  return _PLATFORM_LABELS[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1));
}

// Beschreibt den schreibenden Client fuer die Revision. Reihenfolge bei
// Device-Token-Auth:
//   1. Per-Request-Selbstidentifikation (X-Client-Device/-Platform, von
//      lib/device-auth auf session.user gelegt) — korrekt auch bei einem Token,
//      das auf mehreren Geraeten (Mac + Android) geteilt wird.
//   2. statische Token-Felder (device_name + platform) — sauberer Weg bei
//      „ein Token pro Geraet".
// Browser → User-Agent ("<Browser> · <OS>"). null fuer server-seitige Schreiber
// ohne Request-Kontext (Cron/Jobs).
function _clientFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const u = ctx.session?.user;
  if (u?.via === 'device_token') {
    const reqDevice = typeof u.clientDevice === 'string' && u.clientDevice.trim() ? u.clientDevice.trim() : null;
    const reqPlatform = _prettyPlatform(u.clientPlatform);
    if (reqDevice || reqPlatform) {
      if (reqDevice && reqPlatform) return `${reqDevice} · ${reqPlatform}`;
      return reqDevice || `${reqPlatform}-App`;
    }
    try {
      const dev = u.tokenId ? deviceTokens.getDeviceTokenById(u.tokenId) : null;
      const platform = _prettyPlatform(dev?.platform) || 'macOS';
      return dev?.device_name ? `${dev.device_name} · ${platform}` : `${platform}-App`;
    } catch { return 'macOS-App'; }
  }
  const ua = typeof ctx.get === 'function'
    ? ctx.get('user-agent')
    : (ctx.headers && ctx.headers['user-agent']) || null;
  return ua ? uaLabel(ua) : null;
}

// ── Books ────────────────────────────────────────────────────────────────────
async function listBooks(ctx)                 { return localdbBackend.listBooks(ctx); }
async function loadBook(bookId, ctx)          { return localdbBackend.loadBook(bookId, ctx); }
async function createBook(body, ctx) {
  const created = await localdbBackend.createBook(body, ctx);
  if (created?.id) _searchIndex()?.upsertBookMeta(created.id);
  return created;
}
async function updateBook(bookId, body, ctx) {
  const updated = await localdbBackend.updateBook(bookId, body, ctx);
  _searchIndex()?.upsertBookMeta(bookId);
  return updated;
}
async function deleteBook(bookId, ctx) {
  const result = await localdbBackend.deleteBook(bookId, ctx);
  _searchIndex()?.removeAllForBook(bookId);
  return result;
}

// ── Chapters ────────────────────────────────────────────────────────────────
async function listChapters(bookId, ctx)              { return localdbBackend.listChapters(bookId, ctx); }
async function loadChapter(chapterId, ctx)            { return localdbBackend.loadChapter(chapterId, ctx); }
async function createChapter(body, ctx) {
  const created = await localdbBackend.createChapter(body, ctx);
  if (created?.id) _searchIndex()?.upsertChapter(created.id);
  return created;
}
async function updateChapter(chapterId, body, ctx) {
  const updated = await localdbBackend.updateChapter(chapterId, body, ctx);
  _searchIndex()?.upsertChapter(chapterId);
  return updated;
}
async function deleteChapter(chapterId, ctx) {
  const result = await localdbBackend.deleteChapter(chapterId, ctx);
  _searchIndex()?.remove('chapter', chapterId);
  return result;
}

// ── Pages ────────────────────────────────────────────────────────────────────
async function listPages(bookId, ctx)         { return localdbBackend.listPages(bookId, ctx); }
async function loadPage(pageId, ctx)          { return localdbBackend.loadPage(pageId, ctx); }

const _SOURCE_FALLBACK = 'main';

async function savePage(pageId, body, ctx) {
  // Meta-Felder fuer Revision-Schreiben aus dem Body ziehen, bevor er ans
  // Backend geht — Backend ignoriert unbekannte Keys, aber wir wollen sie
  // erst gar nicht uebermitteln.
  const rawSource = body && typeof body === 'object' ? body.source : null;
  const source = pageRevisions.VALID_SOURCES.has(rawSource) ? rawSource : _SOURCE_FALLBACK;
  const summary = body && typeof body === 'object' && typeof body.summary === 'string'
    ? body.summary.slice(0, 500)
    : null;
  const cleanBody = { ...body };
  delete cleanBody.source;
  delete cleanBody.summary;

  const saved = await localdbBackend.savePage(pageId, cleanBody, ctx);

  // Revision nur schreiben, wenn der Save den Body geaendert hat. Reine
  // Rename- oder Reorder-Saves erzeugen keinen page_revisions-Eintrag —
  // sonst quillt die Tabelle bei Drag-Reorder ueber.
  if (typeof body?.html === 'string' && saved) {
    try {
      pageRevisions.insert({
        pageId,
        bookId: saved.book_id,
        bodyHtml: saved.html || '',
        source,
        userEmail: _userEmailFromCtx(ctx),
        client: _clientFromCtx(ctx),
        summary,
      });
    } catch (e) {
      // Revision-Failures duerfen den Save nicht abbrechen.
      logger.warn(`page_revisions insert fehlgeschlagen (page=${pageId}): ${e.message}`);
    }
  }

  if (saved?.id) _searchIndex()?.upsertPage(saved.id);

  // Belege der Seite neu indizieren — nur bei Body-Change (Rename/Reorder
  // aendern nichts an den Chips). Non-fatal wie der Revision-Insert.
  if (typeof body?.html === 'string' && saved?.id) {
    await _citeIndex()?.reindexPageCitationsSafe(saved.id, saved.html || '');
    await _xrefIndex()?.reindexPageXrefsSafe(saved.id, saved.html || '');
  }

  return saved;
}

async function createPage(body, ctx) {
  const created = await localdbBackend.createPage(body, ctx);
  if (created?.id) _searchIndex()?.upsertPage(created.id);
  // Neuanlage mit Belegen im HTML: Import, Blog-Pull, Snapshot-Restore und
  // Buch-Migration laufen hier durch, nicht ueber savePage.
  if (created?.id) await _citeIndex()?.reindexPageCitationsSafe(created.id, created.html || '');
  if (created?.id) await _xrefIndex()?.reindexPageXrefsSafe(created.id, created.html || '');
  return created;
}

// Fehlende data-bid auf einer bestehenden Seite nachziehen (additiv, ohne
// updated_at/Revision). Text-Inhalt bleibt gleich → kein FTS-Reindex noetig.
async function backfillBlockIds(pageId, ctx) {
  return localdbBackend.backfillBlockIds(pageId, ctx);
}

// Personenbezug eines geloeschten Kontos aus dem Seiten-Snapshot nehmen
// (`pages.last_editor_email`). Einziger Konsument: lib/account-delete.js.
// Synchron, weil es nur ein UPDATE ohne Index-/Revisions-Nachlauf ist.
function anonymizeUser(email) {
  return localdbBackend.anonymizeUser(email);
}
async function deletePage(pageId, ctx) {
  const result = await localdbBackend.deletePage(pageId, ctx);
  _searchIndex()?.remove('page', pageId);
  return result;
}

// Seite in ein anderes Buch verschieben (Re-Parent, page_id bleibt stabil). Die
// raw-DB-Mutation (inkl. FK-Kappen) liegt im Backend; hier werden die
// book_order-Overlays beider Buecher gegen den neuen Stand reconciled (SSoT) und
// der FTS-Index neu unter dem Zielbuch verankert.
async function movePage(pageId, body, ctx) {
  const result = await localdbBackend.movePage(pageId, body, ctx);
  try {
    bookOrder.ensureTree(result.sourceBookId);
    bookOrder.ensureTree(result.targetBookId);
  } catch (e) {
    logger.warn(`[content-store] movePage ensureTree fehlgeschlagen (page=${pageId}): ${e.message}`);
  }
  _searchIndex()?.upsertPage(pageId);
  // Buchwechsel: die Chips zeigen jetzt auf Quellen eines anderen Buchs. Der
  // Buch-Guard in replacePageCitations verwirft sie beim Reindex — die Seite
  // zeigt danach Belege ohne Ziel statt falscher Fundstellen im Zielbuch.
  // Dasselbe gilt fuer Querverweise: die Kapitel-Ziele liegen im alten Buch, der
  // Buch-Guard in replacePageXrefs verwirft sie beim Reindex. Die Anker der
  // Seite (ihre eigenen Abbildungen) wandern dagegen mit und bleiben gueltig.
  try {
    const page = await localdbBackend.loadPage(pageId, ctx);
    await _citeIndex()?.reindexPageCitationsSafe(pageId, page?.html || '');
    await _xrefIndex()?.reindexPageXrefsSafe(pageId, page?.html || '');
  } catch (e) {
    logger.warn(`[content-store] movePage Beleg-/Verweis-Reindex fehlgeschlagen (page=${pageId}): ${e.message}`);
  }
  return result;
}

// ── Higher-level helpers ────────────────────────────────────────────────────
// bookTree konsumiert raw-Daten und ordnet sie nach book_order (SSoT).
// Fehlt die Row, wird sie aus dem aktuellen position/priority-Stand
// initialisiert (Auto-Init).
async function bookTree(bookId, ctx) {
  const raw = await localdbBackend.bookTree(bookId, ctx);
  const ordered = bookOrder.ensureTree(bookId);
  if (!ordered?.tree?.length) return raw;
  return _applyOrder(raw, ordered.tree);
}

// Output-Format: chapters enthaelt nur Top-Level-Kapitel. Jedes Kapitel hat
// pages[] (direkt enthaltene Seiten) + subchapters[] (nested, gleiche Shape).
// Konsumenten, die alle Seiten flach brauchen, nutzen flattenTree().
function _applyOrder(raw, tree) {
  const chaptersById = new Map((raw.chapters || []).map(c => [c.id, c]));
  const pagesById = new Map();
  for (const c of (raw.chapters || [])) for (const p of (c.pages || [])) pagesById.set(p.id, p);
  for (const p of (raw.topPages || [])) pagesById.set(p.id, p);

  function buildChapter(entry) {
    const ch = chaptersById.get(entry.id);
    if (!ch) return null;
    const pages = [];
    const subchapters = [];
    for (const child of (entry.children || [])) {
      if (child.type === 'chapter') {
        const sub = buildChapter(child);
        if (sub) subchapters.push(sub);
      } else if (child.type === 'page') {
        const p = pagesById.get(child.id);
        if (p) pages.push({ ...p, chapter_id: ch.id });
      }
    }
    return { ...ch, pages, subchapters };
  }

  const chaptersOut = [];
  const topPages = [];
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      const built = buildChapter(entry);
      if (built) chaptersOut.push(built);
    } else if (entry.type === 'page') {
      const p = pagesById.get(entry.id);
      if (p) topPages.push({ ...p, chapter_id: null });
    }
  }
  return { chapters: chaptersOut, topPages };
}

// Flacht den bookTree-Output in eine depth-first-Liste { page, chapterId,
// chapterName, depth }-Records aus. chapterName ist das direkt umschliessende
// Kapitel (max-tiefe Vorfahr); fuer Top-Level-Seiten null.
function flattenTree(tree) {
  const out = [];
  function walkChapters(chapters, depth) {
    for (const c of chapters) {
      for (const p of (c.pages || [])) {
        out.push({ page: p, chapterId: c.id, chapterName: c.name, depth });
      }
      walkChapters(c.subchapters || [], depth + 1);
    }
  }
  walkChapters(tree.chapters || [], 1);
  for (const p of (tree.topPages || [])) {
    out.push({ page: p, chapterId: null, chapterName: null, depth: 0 });
  }
  return out;
}

// Iteriert alle Kapitel des Trees (Top-Level + Sub-Kapitel rekursiv).
function walkAllChapters(tree, cb) {
  function walk(chapters, depth) {
    for (const c of chapters) {
      cb(c, depth);
      walk(c.subchapters || [], depth + 1);
    }
  }
  walk(tree.chapters || [], 1);
}

async function loadPagesBatch(pageMetas, ctx, opts)   { return localdbBackend.loadPagesBatch(pageMetas, ctx, opts); }
async function searchPages(query, opts, ctx)          { return localdbBackend.searchPages(query, opts, ctx); }
function pagesChangedSince(bookId, cursor, limit)     { return localdbBackend.pagesChangedSince(bookId, cursor, limit); }

module.exports = {
  listBooks, loadBook, createBook, updateBook, deleteBook,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage, movePage, backfillBlockIds,
  anonymizeUser,
  bookTree, flattenTree, walkAllChapters, loadPagesBatch, searchPages, pagesChangedSince,
  _clientFromCtx,
};
