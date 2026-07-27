'use strict';
// localdb-Variante der Content-Store-Facade. Liest/Schreibt ausschliesslich lokale SQLite-Tabellen
// (books/chapters/pages). Vertrag identisch zu backends/bookstack.js.
//
// Domain-Shape spiegelt content-mapper.js (SSoT): Felder `id`, `name`, `html`,
// `position`, `chapter_id`, `book_id`, `slug`, `book_slug`, `updated_at`,
// `created_at` exakt wie aus BookStack.
//
// Sentinel-Werte: page_id=0 fuer Buch-Scope-Sessions wird respektiert; localdb
// vergibt fuer Neu-Items IDs >= 1_000_001 dank Wasserzeichen aus Migration 106.
//
// **ctx**-Argument wird ignoriert (kein Token noetig). Akzeptiert fuer
// API-Symmetrie mit backends/bookstack.js.

const { db } = require('../../../db/connection');
const { cleanPageHtml, ensureBlockIds } = require('../../html-clean');

// Page-HTML wird vor dem Write sanitisiert UND mit stabilen Block-IDs versehen
// (data-bid, Basis für lib/block-merge.js). Block-IDs nur auf gespeichertem
// Page-Body — nicht in cleanPageHtml, sonst landen sie auch in Export/WP-Sync.
function _cleanHtmlSafe(html) {
  try { return ensureBlockIds(cleanPageHtml(html)); }
  catch { return html; }
}

function _nowIso() { return new Date().toISOString(); }

// Nicht-NULL-Fallback fuer den effektiven Page-Timestamp im Sync-Keyset-Cursor.
// Legacy-/Seed-Rows ohne updated_at sortieren damit ans Anfangsende, OHNE dass
// der Antwort-Cursor je NULL werden kann (siehe pagesChangedSince).
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

function _notFound(kind, id) {
  const e = new Error(`${kind} ${id} not found`);
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

function _bookRow(r, bookSlug = null) {
  if (!r) return null;
  return {
    id: r.book_id,
    name: r.name || '',
    slug: r.slug || null,
    description: r.description || '',
    updated_at: r.updated_at || null,
    created_at: r.created_at || null,
  };
}

function _chapterRow(r) {
  if (!r) return null;
  return {
    id: r.chapter_id,
    book_id: r.book_id,
    name: r.chapter_name || '',
    slug: r.slug || null,
    book_slug: r._book_slug || null,
    position: r.position ?? r.priority ?? null,
    parent_chapter_id: r.parent_chapter_id ?? null,
    excluded: !!r.excluded,
    updated_at: r.updated_at || null,
    created_at: r.updated_at || null,
  };
}

function _pageMetaRow(r) {
  if (!r) return null;
  return {
    id: r.page_id,
    book_id: r.book_id,
    chapter_id: r.chapter_id || null,
    name: r.page_name || '',
    slug: r.slug || null,
    book_slug: r._book_slug || null,
    position: r.position ?? r.priority ?? null,
    updated_at: r.local_updated_at || r.updated_at || null,
    created_at: r.updated_at || null,
    preview_text: r.preview_text ?? null,
    draft: false,
    template: false,
  };
}

function _pageRow(r) {
  const meta = _pageMetaRow(r);
  if (!meta) return null;
  return {
    ...meta,
    html: r.body_html || '',
    raw_html: null,
    revision_count: null,
    last_editor_email: r.last_editor_email || null,
    updated_by_name: r._last_editor_display || r.last_editor_email || null,
    // Push-getriebener „Zuletzt bearbeitet von <Geraet>"-Hint. device_name ist
    // nur fuer eigene Geraete des Anfragers gefuellt (Join-Scope in loadPage),
    // sonst NULL. is_current_device entscheidet das Frontend per getDeviceId().
    last_editor: {
      device_id: r.last_editor_device_id || null,
      device_name: r._last_editor_device_name || null,
      updated_at: meta.updated_at,
    },
  };
}

// ── Books ────────────────────────────────────────────────────────────────────

async function listBooks(_ctx) {
  const rows = db.prepare(`
    SELECT book_id, name, slug, description, created_at, updated_at, owner_email
      FROM books
     ORDER BY name COLLATE NOCASE
  `).all();
  return rows.map(r => _bookRow(r));
}

async function loadBook(bookId, _ctx) {
  const r = db.prepare(`
    SELECT book_id, name, slug, description, created_at, updated_at, owner_email
      FROM books WHERE book_id = ?
  `).get(bookId);
  if (!r) throw _notFound('Book', bookId);
  return _bookRow(r);
}

async function createBook({ name, description, owner_email = null }, _ctx) {
  const now = _nowIso();
  const result = db.prepare(`
    INSERT INTO books (name, description, owner_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, description || null, owner_email, now, now);
  return loadBook(result.lastInsertRowid);
}

async function updateBook(bookId, body, _ctx) {
  const sets = [];
  const args = [];
  if (typeof body?.name === 'string')        { sets.push('name = ?');        args.push(body.name); }
  if (typeof body?.description === 'string') { sets.push('description = ?'); args.push(body.description); }
  if (!sets.length) {
    const err = new Error('updateBook called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  sets.push('updated_at = ?'); args.push(_nowIso());
  args.push(bookId);
  const result = db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE book_id = ?`).run(...args);
  if (!result.changes) throw _notFound('Book', bookId);
  return loadBook(bookId);
}

async function deleteBook(bookId, _ctx) {
  const result = db.prepare(`DELETE FROM books WHERE book_id = ?`).run(bookId);
  if (!result.changes) throw _notFound('Book', bookId);
  return { ok: true };
}

// ── Chapters ────────────────────────────────────────────────────────────────

const _chaptersByBookStmt = db.prepare(`
  SELECT c.chapter_id, c.book_id, c.chapter_name, c.slug,
         c.position, c.priority, c.parent_chapter_id, c.excluded, c.updated_at, b.slug AS _book_slug
    FROM chapters c
    LEFT JOIN books b ON b.book_id = c.book_id
   WHERE c.book_id = ?
   ORDER BY COALESCE(c.position, c.priority, 0), c.chapter_name COLLATE NOCASE
`);

async function listChapters(bookId, _ctx) {
  return _chaptersByBookStmt.all(bookId).map(r => _chapterRow(r));
}

async function loadChapter(chapterId, _ctx) {
  const r = db.prepare(`
    SELECT c.chapter_id, c.book_id, c.chapter_name, c.slug,
           c.position, c.priority, c.parent_chapter_id, c.excluded, c.updated_at, b.slug AS _book_slug
      FROM chapters c
      LEFT JOIN books b ON b.book_id = c.book_id
     WHERE c.chapter_id = ?
  `).get(chapterId);
  if (!r) throw _notFound('Chapter', chapterId);
  return _chapterRow(r);
}

async function createChapter({ book_id, name, position, parent_chapter_id }, _ctx) {
  const now = _nowIso();
  let pos = Number.isFinite(position) ? position : null;
  if (pos === null) {
    // Position-Scope: bei Sub-Chapter innerhalb des Parents zaehlen, sonst
    // top-level Kapitel des Buches.
    const r = parent_chapter_id
      ? db.prepare(
          'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM chapters WHERE book_id = ? AND parent_chapter_id = ?'
        ).get(book_id, parent_chapter_id)
      : db.prepare(
          'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM chapters WHERE book_id = ? AND parent_chapter_id IS NULL'
        ).get(book_id);
    pos = (r?.m || 0) + 1;
  }
  const result = db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, priority, parent_chapter_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    book_id,
    name,
    pos,
    pos,
    Number.isFinite(parent_chapter_id) ? parent_chapter_id : null,
    now,
  );
  return loadChapter(result.lastInsertRowid);
}

async function updateChapter(chapterId, body, _ctx) {
  const sets = [];
  const args = [];
  if (typeof body?.name === 'string')        { sets.push('chapter_name = ?'); args.push(body.name); }
  if (Number.isFinite(body?.position)) {
    sets.push('position = ?'); args.push(body.position);
    sets.push('priority = ?'); args.push(body.position);
  }
  if (typeof body?.excluded === 'boolean') { sets.push('excluded = ?'); args.push(body.excluded ? 1 : 0); }
  if (!sets.length) {
    const err = new Error('updateChapter called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  sets.push('updated_at = ?'); args.push(_nowIso());
  args.push(chapterId);
  const result = db.prepare(`UPDATE chapters SET ${sets.join(', ')} WHERE chapter_id = ?`).run(...args);
  if (!result.changes) throw _notFound('Chapter', chapterId);
  return loadChapter(chapterId);
}

async function deleteChapter(chapterId, _ctx) {
  const result = db.prepare(`DELETE FROM chapters WHERE chapter_id = ?`).run(chapterId);
  if (!result.changes) throw _notFound('Chapter', chapterId);
  return { ok: true };
}

// ── Pages ────────────────────────────────────────────────────────────────────

const _pagesByBookStmt = db.prepare(`
  SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
         p.position, p.priority, p.updated_at, p.local_updated_at,
         p.preview_text,
         b.slug AS _book_slug
    FROM pages p
    LEFT JOIN books b ON b.book_id = p.book_id
   WHERE p.book_id = ?
   ORDER BY COALESCE(p.position, p.priority, 0), p.page_name COLLATE NOCASE
`);

async function listPages(bookId, _ctx) {
  return _pagesByBookStmt.all(bookId).map(r => _pageMetaRow(r));
}

async function loadPage(pageId, _ctx) {
  // Geraete-Label nur fuer die EIGENEN Geraete des anfragenden Users joinen
  // (app_users_devices.user_email = reqEmail). Editierte eine andere Person die
  // Seite zuletzt, bleibt _last_editor_device_name NULL → kein Leak fremder
  // Geraetenamen. Fehlt die Session (Export/Sync/Job-Pfade ohne User) → reqEmail
  // null → ebenfalls kein Match. Push-getrieben: das Label stammt aus dem letzten
  // Save (Browser-UA-Label bzw. nativer Mac-Client), nicht aus Live-Presence.
  const reqEmail = _ctx?.session?.user?.email || null;
  const r = db.prepare(`
    SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
           p.position, p.priority, p.updated_at, p.local_updated_at,
           p.body_html, p.last_editor_email,
           p.last_editor_device_id,
           b.slug AS _book_slug,
           u.display_name AS _last_editor_display,
           d.label AS _last_editor_device_name
      FROM pages p
      LEFT JOIN books b ON b.book_id = p.book_id
      LEFT JOIN app_users u ON u.email = p.last_editor_email
      LEFT JOIN app_users_devices d
             ON d.device_id = p.last_editor_device_id AND d.user_email = ?
     WHERE p.page_id = ?
  `).get(reqEmail, pageId);
  if (!r) throw _notFound('Page', pageId);
  return _pageRow(r);
}

function _conflictError(pageId, currentUpdatedAt, currentEditorEmail, currentEditorDisplay, currentEditorDevice) {
  const e = new Error(`Page ${pageId} updated by another writer`);
  e.code = 'PAGE_CONFLICT';
  e.status = 409;
  e.serverUpdatedAt = currentUpdatedAt;
  e.serverEditorEmail = currentEditorEmail;
  e.serverEditorDisplay = currentEditorDisplay;
  e.serverEditorDevice = currentEditorDevice || null;
  return e;
}

async function savePage(pageId, body, ctx) {
  const sets = [];
  const args = [];
  const hasHtml = typeof body?.html === 'string';
  if (hasHtml)                                { sets.push('body_html = ?');     args.push(_cleanHtmlSafe(body.html)); }
  if (typeof body?.name === 'string')        { sets.push('page_name = ?');     args.push(body.name); }
  if (Number.isFinite(body?.position)) {
    sets.push('position = ?'); args.push(body.position);
    sets.push('priority = ?'); args.push(body.position);
  }
  if (body?.chapter_id !== undefined)        { sets.push('chapter_id = ?');    args.push(body.chapter_id || null); }
  if (!sets.length) {
    const err = new Error('savePage called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }

  // Editor-Email nur bei Body-Change setzen — reine Rename/Reorder bewahren
  // den letzten Body-Autor (sonst springt der Tree-/History-Hinweis bei jedem
  // Drag-Drop um). userEmail kommt aus ctx.session, sonst null.
  const userEmail = ctx?.session?.user?.email || null;
  if (hasHtml) {
    sets.push('last_editor_email = ?'); args.push(userEmail);
    // Geraet, das den Body-Edit schrieb (fuer den geraete-bewussten /changes-Feed).
    // Nur bei Body-Change; Server-/Job-Pfade liefern kein device_id → NULL (zaehlt
    // im Collab-Feed dann als Nicht-eigenes-Browser-Geraet, wird wie heute via
    // E-Mail-Match ausgefiltert). FK-Integritaet sichert der Route-Handler durch
    // vorheriges upsertDevice.
    const deviceId = typeof body?.device_id === 'string' && body.device_id ? body.device_id : null;
    sets.push('last_editor_device_id = ?'); args.push(deviceId);
  }

  const now = _nowIso();
  sets.push('local_updated_at = ?'); args.push(now);
  sets.push('updated_at = ?');       args.push(now);
  // last_seen_at = Discovery-Marker fuer pruneStaleByAge. Sync setzt das ueblicherweise
  // naechtlich; bei Edit-aktiven Pages auch hier refreshen, damit ein ausgesetzter Sync
  // sie nicht nach 7 Tagen als stale loescht.
  sets.push('last_seen_at = ?');     args.push(now);

  // Optimistic-Concurrency-Guard: wenn der Caller einen Snapshot-Zeitstempel
  // mitliefert, MUSS die DB-Row noch genau diesen Stand haben. Sonst hat ein
  // anderer User dazwischen gespeichert → 409, kein Overwrite. Atomar via
  // WHERE im UPDATE, kein TOCTOU-Fenster zwischen Pre-Check und Write.
  const expectedUpdatedAt = body?.expected_updated_at || null;
  let sql;
  if (expectedUpdatedAt) {
    sql = `UPDATE pages SET ${sets.join(', ')} WHERE page_id = ? AND updated_at = ?`;
    args.push(pageId, expectedUpdatedAt);
  } else {
    sql = `UPDATE pages SET ${sets.join(', ')} WHERE page_id = ?`;
    args.push(pageId);
  }
  const result = db.prepare(sql).run(...args);
  if (!result.changes) {
    // Existiert die Page ueberhaupt? Wenn ja und Stamp passte nicht → Conflict.
    // Geraete-Label wie in loadPage nur fuer eigene Geraete joinen — die
    // Konfliktmeldung nennt dann „auf <Geraet> geaendert" statt eines fremden
    // Usernamens, wenn der Kollisions-Save vom eigenen Zweit-Geraet kam.
    const cur = db.prepare(`
      SELECT p.updated_at, p.last_editor_email, u.display_name AS display,
             d.label AS device_label
        FROM pages p
        LEFT JOIN app_users u ON u.email = p.last_editor_email
        LEFT JOIN app_users_devices d ON d.device_id = p.last_editor_device_id
                                     AND d.user_email = ?
       WHERE p.page_id = ?
    `).get(userEmail, pageId);
    if (cur && expectedUpdatedAt) {
      throw _conflictError(pageId, cur.updated_at, cur.last_editor_email, cur.display, cur.device_label);
    }
    throw _notFound('Page', pageId);
  }
  return loadPage(pageId);
}

async function createPage({ book_id, chapter_id, name, html }, _ctx) {
  if (!book_id) {
    const err = new Error('createPage: book_id required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const now = _nowIso();
  const cleanHtml = _cleanHtmlSafe(typeof html === 'string' ? html : '<p></p>');
  const r = db.prepare(
    'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM pages WHERE book_id = ?'
  ).get(book_id);
  const pos = (r?.m || 0) + 1;
  const result = db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(book_id, chapter_id || null, name || '', cleanHtml, pos, pos, now, now, now);
  return loadPage(result.lastInsertRowid);
}

async function deletePage(pageId, _ctx) {
  const result = db.prepare(`DELETE FROM pages WHERE page_id = ?`).run(pageId);
  if (!result.changes) throw _notFound('Page', pageId);
  return { ok: true };
}

// Verschiebt eine Seite in ein anderes Buch — Re-Parent unter Beibehaltung der
// stabilen page_id (kein Copy+Delete). Damit folgen alle page_id-getragenen
// Daten automatisch (Revisionen, Stats, Kommentare, Share-Links).
//
// Modell:
//   - Seiten-intrinsische Daten (Revisionen/Stats/Lektorat-Befunde/Schreibzeit/
//     Seiten-Chat/Page-Share) ZIEHEN MIT → book_id nachfuehren.
//   - Buchwelt-Analyse der Quelle (Figuren-Erwaehnungen, Zeitstrahl-Links,
//     Erst-Erwaehnungen, Szenen/Events-Anker, Recherche-Links, Lektorat-Cache)
//     wird GEKAPPT — sie referenziert Entitaeten des Quellbuchs und wird im
//     Zielbuch bei der naechsten Komplettanalyse neu aufgebaut.
//   - Integrations-Spiegel (Blog/HubSpot) gehoeren zur Quell-Connection → loeschen.
//   - Ephemere Zustaende (Locks/Presence) → loeschen.
// book_order beider Buecher pflegt der Facade-Wrapper via ensureTree/reconcile
// (gleiche Konvention wie createPage/deletePage: Tree-Overlay heilt beim Read).
async function movePage(pageId, { targetBookId, targetChapterId = null } = {}, _ctx) {
  const tBook = parseInt(targetBookId, 10);
  if (!Number.isInteger(tBook) || tBook <= 0) {
    const err = new Error('movePage: targetBookId required');
    err.code = 'BAD_REQUEST';
    err.status = 400;
    throw err;
  }
  const pageRow = db.prepare('SELECT page_id, book_id FROM pages WHERE page_id = ?').get(pageId);
  if (!pageRow) throw _notFound('Page', pageId);
  const sBook = pageRow.book_id;
  if (sBook === tBook) {
    const err = new Error('movePage: source and target book identical');
    err.code = 'SAME_BOOK';
    err.status = 400;
    throw err;
  }
  if (!db.prepare('SELECT 1 FROM books WHERE book_id = ?').get(tBook)) {
    const err = new Error(`movePage: target book ${tBook} not found`);
    err.code = 'TARGET_BOOK_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  let tChap = null;
  if (targetChapterId != null && targetChapterId !== '' && targetChapterId !== 0) {
    tChap = parseInt(targetChapterId, 10);
    const chRow = db.prepare('SELECT book_id FROM chapters WHERE chapter_id = ?').get(tChap);
    if (!chRow || chRow.book_id !== tBook) {
      const err = new Error(`movePage: chapter ${tChap} not in target book ${tBook}`);
      err.code = 'CHAPTER_NOT_IN_TARGET';
      err.status = 400;
      throw err;
    }
  }

  const now = _nowIso();
  const tx = db.transaction(() => {
    const pr = db.prepare(
      'SELECT COALESCE(MAX(COALESCE(position, priority)), 0) AS m FROM pages WHERE book_id = ?'
    ).get(tBook);
    const pos = (pr?.m || 0) + 1;
    db.prepare(`
      UPDATE pages
         SET book_id = ?, chapter_id = ?, position = ?, priority = ?,
             updated_at = ?, local_updated_at = ?, last_seen_at = ?
       WHERE page_id = ?
    `).run(tBook, tChap, pos, pos, now, now, now, pageId);

    // Seiten-intrinsisch → mitziehen.
    db.prepare('UPDATE page_revisions SET book_id = ? WHERE page_id = ?').run(tBook, pageId);
    db.prepare('UPDATE page_stats     SET book_id = ? WHERE page_id = ?').run(tBook, pageId);
    db.prepare('UPDATE lektorat_time  SET book_id = ? WHERE page_id = ?').run(tBook, pageId);
    db.prepare('UPDATE page_checks    SET book_id = ?, chapter_id = ? WHERE page_id = ?').run(tBook, tChap, pageId);
    db.prepare('UPDATE share_links    SET book_id = ? WHERE page_id = ?').run(tBook, pageId);
    db.prepare('UPDATE chat_sessions  SET book_id = ? WHERE page_id = ?').run(tBook, pageId);

    // Buchwelt-Analyse der Quelle kappen.
    db.prepare('DELETE FROM page_figure_mentions   WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM zeitstrahl_event_pages WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM research_item_links    WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM lektorat_cache         WHERE page_id = ?').run(pageId);
    db.prepare('UPDATE figure_events SET page_id = NULL, chapter_id = NULL WHERE page_id = ?').run(pageId);
    db.prepare('UPDATE figure_scenes SET page_id = NULL, chapter_id = NULL WHERE page_id = ?').run(pageId);
    db.prepare('UPDATE ideen         SET page_id = NULL, chapter_id = NULL WHERE page_id = ?').run(pageId);
    db.prepare('UPDATE figures   SET erste_erwaehnung_page_id = NULL WHERE erste_erwaehnung_page_id = ?').run(pageId);
    db.prepare('UPDATE locations SET erste_erwaehnung_page_id = NULL WHERE erste_erwaehnung_page_id = ?').run(pageId);
    db.prepare('UPDATE songs     SET erste_erwaehnung_page_id = NULL WHERE erste_erwaehnung_page_id = ?').run(pageId);

    // Integrations-Spiegel (Quell-Connection) + Ephemeres.
    db.prepare('DELETE FROM blog_page_links    WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM hubspot_page_links WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM page_locks         WHERE page_id = ?').run(pageId);
    db.prepare('DELETE FROM page_presence      WHERE page_id = ?').run(pageId);
    db.prepare('UPDATE book_presence SET page_id = NULL WHERE page_id = ?').run(pageId);
  });
  tx();

  const page = await loadPage(pageId);
  return { ok: true, sourceBookId: sBook, targetBookId: tBook, page };
}

// ── Higher-level helpers ────────────────────────────────────────────────────

async function bookTree(bookId, _ctx) {
  const chapters = await listChapters(bookId);
  const pages = await listPages(bookId);
  const byChapter = new Map(chapters.map(c => [c.id, { ...c, pages: [] }]));
  const topPages = [];
  for (const p of pages) {
    const bucket = p.chapter_id ? byChapter.get(p.chapter_id) : null;
    if (bucket) bucket.pages.push(p);
    else topPages.push(p);
  }
  return { chapters: Array.from(byChapter.values()), topPages };
}

// Inkrementeller Delta-Pull fuer native Offline-Clients (Mac-Focus-Writer).
// Liefert NUR Metadaten (id, updated_at) der seit dem Cursor geaenderten/neuen
// Seiten — vollen Body laedt der Aufrufer per loadPagesBatch nach. Keyset-Cursor
// (updated_at, page_id), damit Seiten mit identischem Timestamp an der Limit-
// Grenze nicht verlorengehen. `cursor` = { since, sinceId } oder null (Voll-Pull).
// effektives updated_at = COALESCE(local_updated_at, updated_at, EPOCH), identisch
// zu dem, was loadPage als `updated_at` exponiert (modulo EPOCH-Fallback). Der
// EPOCH-Fallback ist Pflicht: ohne ihn sortiert eine Legacy-Row mit NULL-Timestamp
// als erste Zeile nach vorne und der Antwort-Cursor `since` (= letzter Wert) bliebe
// NULL → der Client kann den Cursor nie vorruecken (Endlos-Baseline-Replay). Der
// COALESCE-Ausdruck steht deshalb IDENTISCH in SELECT, WHERE und ORDER BY.
function pagesChangedSince(bookId, cursor, limit = 200) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const since = cursor && cursor.since && !Number.isNaN(Date.parse(cursor.since)) ? cursor.since : null;
  const sinceId = cursor && Number.isFinite(Number(cursor.sinceId)) ? parseInt(cursor.sinceId, 10) : 0;
  const rows = db.prepare(`
    SELECT page_id AS id, COALESCE(local_updated_at, updated_at, ?) AS updated_at
      FROM pages
     WHERE book_id = ?
       AND (
         ? IS NULL
         OR COALESCE(local_updated_at, updated_at, ?) > ?
         OR (COALESCE(local_updated_at, updated_at, ?) = ? AND page_id > ?)
       )
     ORDER BY COALESCE(local_updated_at, updated_at, ?) ASC, page_id ASC
     LIMIT ?
  `).all(EPOCH_ISO, bookId, since, EPOCH_ISO, since, EPOCH_ISO, since, sinceId, EPOCH_ISO, lim);
  return rows;
}

async function loadPagesBatch(pageMetas, _ctx, _opts = {}) {
  // Lokale Reads sind synchron + billig — kein Concurrency-Cap noetig.
  // onError-Hook bleibt fuer API-Symmetrie: missing Page → null statt throw.
  const { onError = null } = _opts;
  const out = [];
  for (const p of pageMetas) {
    try {
      out.push(await loadPage(p.id));
    } catch (e) {
      if (onError) {
        const fallback = onError(p, e);
        if (fallback) out.push(fallback);
      } else throw e;
    }
  }
  return out;
}

// ── Search ──────────────────────────────────────────────────────────────────
// Simple Substring-Suche auf page_name + body_html als Fallback;
// die echte Volltextsuche laeuft ueber FTS5 in lib/search.js.
// ACL via book_id-Param (Caller filtert separat).

async function searchPages(query, { bookId, count = 20 } = {}, _ctx) {
  const q = (query || '').toString().trim();
  if (q.length < 2) return [];
  const safeCount = Math.min(Math.max(parseInt(count, 10) || 20, 1), 100);
  const pattern = `%${q.replace(/[%_]/g, ch => `\\${ch}`)}%`;
  const sql = bookId
    ? `SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
              p.position, p.priority, p.updated_at, p.local_updated_at,
              b.slug AS _book_slug
         FROM pages p
         LEFT JOIN books b ON b.book_id = p.book_id
        WHERE p.book_id = ?
          AND (p.page_name LIKE ? ESCAPE '\\' OR p.body_html LIKE ? ESCAPE '\\')
        LIMIT ?`
    : `SELECT p.page_id, p.book_id, p.chapter_id, p.page_name, p.slug,
              p.position, p.priority, p.updated_at, p.local_updated_at,
              b.slug AS _book_slug
         FROM pages p
         LEFT JOIN books b ON b.book_id = p.book_id
        WHERE p.page_name LIKE ? ESCAPE '\\' OR p.body_html LIKE ? ESCAPE '\\'
        LIMIT ?`;
  const args = bookId
    ? [bookId, pattern, pattern, safeCount]
    : [pattern, pattern, safeCount];
  return db.prepare(sql).all(...args).map(r => _pageMetaRow(r));
}

// Vergibt fehlende data-bid auf einer bestehenden Seite — rein additiv, OHNE
// updated_at-Bump, Revision oder FTS-Reindex (Text-Inhalt aendert sich nicht,
// nur Block-Attribute). Idempotent: hat die Seite schon data-bid, No-op. Basis
// fuer Verankerung (Share-Anker / Block-Merge) auf Legacy-/Import-Seiten, die nie
// ueber den Editor-Write-Chokepoint liefen. Bewusst nur ensureBlockIds (kein
// cleanPageHtml), damit der Backfill keine sichtbare Content-Normalisierung
// ausloest.
function backfillBlockIds(pageId) {
  const row = db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(pageId);
  if (!row || !row.body_html || row.body_html.includes('data-bid')) return { changed: false };
  const next = ensureBlockIds(row.body_html);
  if (next === row.body_html) return { changed: false };
  db.prepare('UPDATE pages SET body_html = ? WHERE page_id = ?').run(next, pageId);
  return { changed: true };
}

module.exports = {
  listBooks, loadBook, createBook, updateBook, deleteBook,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage, movePage,
  bookTree, loadPagesBatch, searchPages, pagesChangedSince,
  backfillBlockIds,
};
