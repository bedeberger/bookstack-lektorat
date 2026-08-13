'use strict';
// SQLite-FTS5-Volltextsuche.
//
// Single Entry Point fuer Index-Mutationen + Query. Konsumenten rufen
// `upsertPage(pageId)` / `upsertChapter(chapterId)` / `upsertBookMeta(bookId)` /
// `upsertFigure(figureId)` / `upsertLocation(locId)` / `upsertScene(sceneId)` /
// `upsertIdea(ideaId)` auf — die Funktion liest die aktuelle Row aus der DB
// und schreibt sie in beide FTS5-Tabellen (Haupt-Index + Title-Trigram).
//
// Body-Felder werden mit dem identischen Tag-zu-Space-Replacement wie
// routes/sync.js (htmlToText) / db/page-revisions.js normalisiert
// (Pflicht-Konsistenz, sonst Drift zu page_stats).
//
// Failures werden als warn geloggt, niemals geworfen — Index-Schreiber sind
// Side-Effects der eigentlichen Mutation; ein Search-Fehler darf den Save
// nicht abbrechen.

const { db } = require('../db/connection');
const { NOW_ISO_SQL } = require('../db/now');
const logger = require('../logger');
const { htmlToPlainText } = require('./html-text');

const htmlToText = htmlToPlainText;

const VALID_KINDS = new Set([
  'book', 'chapter', 'page', 'figure', 'location', 'scene', 'idea', 'song', 'research',
]);

const _delIndex = db.prepare(
  'DELETE FROM search_index WHERE kind = ? AND entity_id = ?'
);
const _delTrigram = db.prepare(
  'DELETE FROM search_trigram WHERE kind = ? AND entity_id = ?'
);
const _insIndex = db.prepare(`
  INSERT INTO search_index (kind, entity_id, book_id, lang, title, body)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const _insTrigram = db.prepare(`
  INSERT INTO search_trigram (kind, entity_id, book_id, title)
  VALUES (?, ?, ?, ?)
`);

function _writeRow(kind, entityId, bookId, lang, title, body) {
  if (!VALID_KINDS.has(kind)) throw new Error(`searchIndex: invalid kind "${kind}"`);
  _delIndex.run(kind, entityId);
  _delTrigram.run(kind, entityId);
  const cleanTitle = (title || '').toString().trim();
  const cleanBody = (body || '').toString();
  if (!cleanTitle && !cleanBody) return;
  _insIndex.run(kind, entityId, bookId || null, lang || null, cleanTitle, cleanBody);
  if (cleanTitle) {
    _insTrigram.run(kind, entityId, bookId || null, cleanTitle);
  }
}

function _safe(fn, label) {
  return function (...args) {
    try { return fn(...args); }
    catch (e) {
      logger.warn(`searchIndex.${label}(${args.join(',')}) fehlgeschlagen: ${e.message}`);
      return null;
    }
  };
}

function remove(kind, entityId) {
  if (!VALID_KINDS.has(kind)) return;
  _delIndex.run(kind, entityId);
  _delTrigram.run(kind, entityId);
}

function _upsertPage(pageId) {
  const r = db.prepare(
    'SELECT page_id, book_id, page_name, body_html FROM pages WHERE page_id = ?'
  ).get(pageId);
  if (!r) { remove('page', pageId); return; }
  _writeRow('page', pageId, r.book_id, null, r.page_name || '', htmlToText(r.body_html));
}

function _upsertChapter(chapterId) {
  const r = db.prepare(
    'SELECT chapter_id, book_id, chapter_name FROM chapters WHERE chapter_id = ?'
  ).get(chapterId);
  if (!r) { remove('chapter', chapterId); return; }
  _writeRow('chapter', chapterId, r.book_id, null, r.chapter_name || '', '');
}

function _upsertBookMeta(bookId) {
  const r = db.prepare(
    'SELECT book_id, name, description FROM books WHERE book_id = ?'
  ).get(bookId);
  if (!r) { remove('book', bookId); return; }
  _writeRow('book', bookId, bookId, null, r.name || '', htmlToText(r.description));
}

function _upsertFigure(figureId) {
  const r = db.prepare(
    'SELECT id, book_id, name, beschreibung FROM figures WHERE id = ?'
  ).get(figureId);
  if (!r) { remove('figure', figureId); return; }
  _writeRow('figure', figureId, r.book_id, null, r.name || '', r.beschreibung || '');
}

function _upsertLocation(locId) {
  const r = db.prepare(
    'SELECT id, book_id, name, beschreibung FROM locations WHERE id = ?'
  ).get(locId);
  if (!r) { remove('location', locId); return; }
  _writeRow('location', locId, r.book_id, null, r.name || '', r.beschreibung || '');
}

function _upsertSong(songId) {
  const r = db.prepare(
    'SELECT id, book_id, titel, interpret, beschreibung FROM songs WHERE id = ?'
  ).get(songId);
  if (!r) { remove('song', songId); return; }
  const title = [r.titel, r.interpret].filter(Boolean).join(' — ');
  _writeRow('song', songId, r.book_id, null, title, r.beschreibung || '');
}

function _upsertScene(sceneId) {
  const r = db.prepare(
    'SELECT id, book_id, titel, kommentar FROM figure_scenes WHERE id = ?'
  ).get(sceneId);
  if (!r) { remove('scene', sceneId); return; }
  _writeRow('scene', sceneId, r.book_id, null, r.titel || '', r.kommentar || '');
}

function _upsertIdea(ideaId) {
  const r = db.prepare(
    'SELECT id, book_id, content FROM ideen WHERE id = ?'
  ).get(ideaId);
  if (!r) { remove('idea', ideaId); return; }
  // ideen.content ist Plain-Text. Erste Zeile als Titel, damit Trigram-Index +
  // bm25-title-Boost greifen.
  const text = (r.content || '').toString();
  const firstLine = text.split('\n')[0] || '';
  const title = firstLine.slice(0, 120);
  _writeRow('idea', ideaId, r.book_id, null, title, text);
}

function _upsertResearch(itemId) {
  const r = db.prepare(
    'SELECT id, book_id, kind, title, body, source, doc_name, doc_text FROM research_items WHERE id = ?'
  ).get(itemId);
  if (!r) { remove('research', itemId); return; }
  // URLs (mit optionalem Label) als eigene Kind-Tabelle indizieren.
  const urlText = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id')
    .all(itemId).map(u => [u.label, u.url].filter(Boolean).join(' ')).join('\n');
  // Plain-Text-Felder inkl. extrahiertem Dokument-Text. Titel-Fallback: erste
  // Body-Zeile bzw. Dokumentname (fuer Trigram + bm25-Boost).
  const body = [r.body, urlText, r.source, r.doc_name, r.doc_text].filter(Boolean).join('\n');
  const firstLine = (r.body || '').toString().split('\n')[0] || '';
  const title = (r.title && r.title.trim())
    ? r.title.trim()
    : (firstLine || r.doc_name || '').slice(0, 120);
  _writeRow('research', itemId, r.book_id, null, title, body);
}

// Buch-Loeschung: FTS5 unterstuetzt keine FKs/CASCADE — Caller ruft das nach
// books-DELETE.
function _removeAllForBook(bookId) {
  db.prepare('DELETE FROM search_index WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM search_trigram WHERE book_id = ?').run(bookId);
}

// figures/locations/scenes werden in saveFigurenToDb/saveOrteToDb/
// saveSzenenAndEvents als Full-Replace pro Buch persistiert. Identische
// Strategie im Index: vor dem Re-Upsert alle Eintraege dieser Kind/Buch-
// Kombination droppen.
function _removeKindForBook(kind, bookId) {
  if (!VALID_KINDS.has(kind)) return;
  db.prepare('DELETE FROM search_index WHERE kind = ? AND book_id = ?').run(kind, bookId);
  db.prepare('DELETE FROM search_trigram WHERE kind = ? AND book_id = ?').run(kind, bookId);
}

function _setMeta(key, value) {
  db.prepare(`
    INSERT INTO search_meta (key, value, updated_at)
    VALUES (?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

function _getMeta(key) {
  const r = db.prepare('SELECT value FROM search_meta WHERE key = ?').get(key);
  return r?.value ?? null;
}

function reindexAll() {
  const t0 = Date.now();
  db.prepare('DELETE FROM search_index').run();
  db.prepare('DELETE FROM search_trigram').run();
  const counts = { book: 0, chapter: 0, page: 0, figure: 0, location: 0, scene: 0, idea: 0, song: 0, research: 0 };
  for (const r of db.prepare('SELECT book_id FROM books').all()) { _upsertBookMeta(r.book_id); counts.book++; }
  for (const r of db.prepare('SELECT chapter_id FROM chapters').all()) { _upsertChapter(r.chapter_id); counts.chapter++; }
  for (const r of db.prepare('SELECT page_id FROM pages').all()) { _upsertPage(r.page_id); counts.page++; }
  for (const r of db.prepare('SELECT id FROM figures').all()) { _upsertFigure(r.id); counts.figure++; }
  for (const r of db.prepare('SELECT id FROM locations').all()) { _upsertLocation(r.id); counts.location++; }
  for (const r of db.prepare('SELECT id FROM figure_scenes').all()) { _upsertScene(r.id); counts.scene++; }
  for (const r of db.prepare('SELECT id FROM ideen').all()) { _upsertIdea(r.id); counts.idea++; }
  for (const r of db.prepare('SELECT id FROM songs').all()) { _upsertSong(r.id); counts.song++; }
  for (const r of db.prepare('SELECT id FROM research_items').all()) { _upsertResearch(r.id); counts.research++; }
  _setMeta('reindex_required', '0');
  _setMeta('last_reindex', new Date().toISOString());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info(`[search] Reindex abgeschlossen in ${Date.now() - t0}ms: ${total} Eintraege (${JSON.stringify(counts)}).`);
  return counts;
}

function reindexIfNeeded() {
  if (_getMeta('reindex_required') === '1') {
    try { reindexAll(); }
    catch (e) { logger.error(`[search] Initial-Reindex fehlgeschlagen: ${e.message}`); }
  }
}

function optimize() {
  try {
    db.prepare("INSERT INTO search_index(search_index) VALUES('optimize')").run();
    db.prepare("INSERT INTO search_trigram(search_trigram) VALUES('optimize')").run();
    _setMeta('last_optimize', new Date().toISOString());
  } catch (e) {
    logger.warn(`[search] optimize fehlgeschlagen: ${e.message}`);
  }
}

// Query-Parser. Akzeptiert:
//   "phrase"   - exakte Phrase
//   -word      - Negation
//   word*      - Prefix-Match
//   ein zwei   - AND (FTS5-Default)
// Spezialzeichen ausserhalb von Buchstaben/Zahlen/-/_ werden gestrippt, damit
// User-Input nicht in MATCH-Syntax-Errors einbricht.

const _NON_WORD = /[^\p{L}\p{N}_-]/gu;

function buildMatchQuery(input) {
  const raw = (input || '').toString().trim();
  if (!raw) return '';
  const tokens = [];
  const phraseRe = /"([^"]+)"/g;
  let rest = raw;
  let m;
  while ((m = phraseRe.exec(raw)) !== null) {
    const phrase = m[1].replace(/"/g, '');
    if (phrase.trim()) tokens.push('"' + phrase + '"');
    rest = rest.replace(m[0], ' ');
  }
  for (let part of rest.split(/\s+/)) {
    if (!part) continue;
    let neg = false;
    if (part.startsWith('-')) { neg = true; part = part.slice(1); }
    if (!part) continue;
    let prefix = false;
    if (part.endsWith('*')) { prefix = true; part = part.slice(0, -1); }
    const sanitized = part.replace(_NON_WORD, '');
    if (sanitized.length < 2) continue;
    const term = '"' + sanitized + '"' + (prefix ? '*' : '');
    tokens.push(neg ? '-' + term : term);
  }
  return tokens.join(' ');
}

const _HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function _escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => _HTML_ESC[c]); }
function _escSnippet(s, openSentinel, closeSentinel) {
  // HTML-escape User-Content, dann Sentinel-Marker zu `<mark>`-Tags ersetzen.
  // Reihenfolge zwingend: erst escape (sonst werden injizierte `<mark>` mit
  // escaped), dann Sentinel-Replace.
  const escaped = _escHtml(s);
  const openRe = new RegExp(openSentinel, 'g');
  const closeRe = new RegExp(closeSentinel, 'g');
  return escaped.replace(openRe, '<mark>').replace(closeRe, '</mark>');
}

// Seiten-Treffer mit dem Kapitelnamen anreichern (pages.chapter_id →
// chapters.chapter_name), damit die UI bei mehrseitigen Kapiteln zeigt, zu
// welchem Kapitel eine Seite gehoert. Display-Wert per JOIN zur Lesezeit,
// kein Snapshot. Mutiert die Rows in-place.
function _enrichPageChapters(rows) {
  const pageIds = rows.filter(r => r.kind === 'page').map(r => r.entity_id);
  if (!pageIds.length) return;
  const placeholders = pageIds.map(() => '?').join(',');
  let chRows;
  try {
    chRows = db.prepare(`
      SELECT p.page_id, c.chapter_name
        FROM pages p
        JOIN chapters c ON c.chapter_id = p.chapter_id
       WHERE p.page_id IN (${placeholders})
    `).all(...pageIds);
  } catch (e) {
    logger.warn(`[search] Kapitel-Anreicherung fehlgeschlagen: ${e.message}`);
    return;
  }
  const map = new Map(chRows.map(r => [r.page_id, r.chapter_name]));
  for (const r of rows) {
    if (r.kind === 'page' && map.has(r.entity_id)) r.chapter = map.get(r.entity_id);
  }
}

// Treffer mit der ID anreichern, unter der die OBERFLAECHE die Entitaet
// adressiert (`nav_id`). Der Index fuehrt in `entity_id` durchgehend den
// INTEGER-PK der Tabelle — daran haengen alle Server-Konsumenten (Motiv-Scan,
// Beat-Verankerung, semantische Fusion) und der FK-Bezug.
//
// Figuren und Schauplaetze fuehren nach aussen aber ihre TEXT-ID
// (`figures.fig_id` / `locations.loc_id`): die Katalog-Listen (`GET /figures`,
// `GET /locations`) liefern sie als `id`, die Karten vergleichen damit
// (`selectedOrtId === o.id`) und der Deep-Link-Hash traegt sie. Ohne diese
// Aufloesung oeffnet ein Klick auf einen Volltext-Treffer zwar die Karte und
// schreibt eine plausible URL, findet die Zeile dort aber nie.
//
// Alle uebrigen Arten (page/chapter/book/scene/idea/song/research) fuehren ihren
// PK oeffentlich — dort ist `nav_id` schlicht die `entity_id`. Mutiert in-place.
function attachNavIds(rows) {
  for (const r of rows) r.nav_id = r.entity_id;
  const PUBLIC_ID_COLS = { figure: ['figures', 'fig_id'], location: ['locations', 'loc_id'] };
  for (const [kind, [table, col]] of Object.entries(PUBLIC_ID_COLS)) {
    const ids = rows.filter(r => r.kind === kind).map(r => r.entity_id);
    if (!ids.length) continue;
    let idRows;
    try {
      idRows = db.prepare(
        `SELECT id, ${col} AS pub FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
    } catch (e) {
      logger.warn(`[search] nav_id-Aufloesung fehlgeschlagen (${kind}): ${e.message}`);
      continue;
    }
    const map = new Map(idRows.map(r => [r.id, r.pub]));
    for (const r of rows) {
      if (r.kind === kind && map.get(r.entity_id)) r.nav_id = map.get(r.entity_id);
    }
  }
  return rows;
}

function query(input, opts = {}) {
  const {
    allowedBookIds = null,
    kinds = null,
    bookId = null,
    limit = 50,
    offset = 0,
  } = opts;
  const match = buildMatchQuery(input);
  if (!match) return { hits: [], fallback: false };
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const whereParts = ['search_index MATCH ?'];
  const args = [match];
  if (Array.isArray(kinds) && kinds.length) {
    const filtered = kinds.filter(k => VALID_KINDS.has(k));
    if (!filtered.length) return { hits: [], fallback: false };
    whereParts.push(`kind IN (${filtered.map(() => '?').join(',')})`);
    args.push(...filtered);
  }
  if (bookId) {
    whereParts.push('book_id = ?');
    args.push(bookId);
  } else if (Array.isArray(allowedBookIds)) {
    if (!allowedBookIds.length) return { hits: [], fallback: false };
    whereParts.push(`book_id IN (${allowedBookIds.map(() => '?').join(',')})`);
    args.push(...allowedBookIds);
  }

  // Sentinel-Marker statt direkter <mark>-Tags, damit `body`-Inhalt mit
  // rohen HTML-Sonderzeichen (z.B. dekodierte Titel/Figurennamen) sicher
  // escaped werden kann, bevor das Frontend `snippet` per x-html rendert.
  const SNIP_OPEN = '';
  const SNIP_CLOSE = '';
  const sql = `
    SELECT kind, entity_id, book_id, title,
           snippet(search_index, 5, '${SNIP_OPEN}', '${SNIP_CLOSE}', '...', 12) AS snippet,
           bm25(search_index, 5.0, 1.0) AS rank
      FROM search_index
     WHERE ${whereParts.join(' AND ')}
     ORDER BY rank
     LIMIT ? OFFSET ?
  `;
  args.push(safeLimit, safeOffset);
  let rows;
  try {
    rows = db.prepare(sql).all(...args);
  } catch (e) {
    logger.warn(`[search] FTS-Query fehlgeschlagen ("${input}"): ${e.message}`);
    return { hits: [], fallback: false };
  }
  for (const r of rows) {
    if (typeof r.snippet === 'string') r.snippet = _escSnippet(r.snippet, SNIP_OPEN, SNIP_CLOSE);
  }
  if (rows.length) { _enrichPageChapters(rows); return { hits: rows, fallback: false }; }

  // Single-Word-Zero-Hit-Fallback: Trigram auf Titel.
  const words = (input || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return { hits: [], fallback: false };
  // Bindestriche/Unterstriche raus: im FTS5-MATCH ist `-` der NOT-Operator, ein
  // Term wie "A-L-E-X" bricht sonst die Query ("no such column: L"). Der
  // Trigram-Index matcht ohnehin Substrings; als Phrase gequotet bleibt der
  // Rest-Term literal.
  const single = words[0].replace(_NON_WORD, '').replace(/[-_]/g, '');
  if (single.length < 3) return { hits: [], fallback: false };

  const tWhere = ['search_trigram MATCH ?'];
  const tArgs = ['"' + single + '"'];
  if (Array.isArray(kinds) && kinds.length) {
    const filtered = kinds.filter(k => VALID_KINDS.has(k));
    if (!filtered.length) return { hits: [], fallback: false };
    tWhere.push(`kind IN (${filtered.map(() => '?').join(',')})`);
    tArgs.push(...filtered);
  }
  if (bookId) {
    tWhere.push('book_id = ?');
    tArgs.push(bookId);
  } else if (Array.isArray(allowedBookIds)) {
    tWhere.push(`book_id IN (${allowedBookIds.map(() => '?').join(',')})`);
    tArgs.push(...allowedBookIds);
  }
  const tSql = `
    SELECT kind, entity_id, book_id, title,
           '' AS snippet,
           0.0 AS rank
      FROM search_trigram
     WHERE ${tWhere.join(' AND ')}
     LIMIT ?
  `;
  tArgs.push(safeLimit);
  let tRows;
  try { tRows = db.prepare(tSql).all(...tArgs); }
  catch (e) {
    logger.warn(`[search] Trigram-Fallback fehlgeschlagen ("${input}"): ${e.message}`);
    return { hits: [], fallback: false };
  }
  _enrichPageChapters(tRows);
  return { hits: tRows, fallback: true };
}

// Anzahl indizierter Entitäten eines Buches (optional auf kinds gefiltert). Billiger
// COUNT über den abgeleiteten FTS-Index — dient dem Motiv-Scan zum buchgrössen-
// abhängigen Skalieren seines Fundstellen-Caps (TOP_K), ohne Buchinhalt zu laden.
function countEntities(bookId, kinds = null) {
  if (!bookId) return 0;
  const parts = ['book_id = ?'];
  const args = [bookId];
  if (Array.isArray(kinds) && kinds.length) {
    const filtered = kinds.filter(k => VALID_KINDS.has(k));
    if (!filtered.length) return 0;
    parts.push(`kind IN (${filtered.map(() => '?').join(',')})`);
    args.push(...filtered);
  }
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE ${parts.join(' AND ')}`).get(...args)?.n || 0;
  } catch (e) {
    logger.warn(`[search] countEntities fehlgeschlagen (book=${bookId}): ${e.message}`);
    return 0;
  }
}

module.exports = {
  upsertPage:     _safe(_upsertPage,     'upsertPage'),
  upsertChapter:  _safe(_upsertChapter,  'upsertChapter'),
  upsertBookMeta: _safe(_upsertBookMeta, 'upsertBookMeta'),
  upsertFigure:   _safe(_upsertFigure,   'upsertFigure'),
  upsertLocation: _safe(_upsertLocation, 'upsertLocation'),
  upsertScene:    _safe(_upsertScene,    'upsertScene'),
  upsertIdea:     _safe(_upsertIdea,     'upsertIdea'),
  upsertSong:     _safe(_upsertSong,     'upsertSong'),
  upsertResearch: _safe(_upsertResearch, 'upsertResearch'),
  remove,
  removeAllForBook: _safe(_removeAllForBook, 'removeAllForBook'),
  removeKindForBook: _safe(_removeKindForBook, 'removeKindForBook'),
  reindexAll,
  reindexIfNeeded,
  optimize,
  query,
  attachNavIds,
  countEntities,
  htmlToText,
  buildMatchQuery,
  VALID_KINDS,
};
