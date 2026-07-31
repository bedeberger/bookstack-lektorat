'use strict';
// Item-Modell des Recherche-Boards: Anlegen, Kind-Tabellen (URLs/Tags) und die
// Ausgabeform eines Fundstuecks samt Relationen.
//
// Warum als eigenes Modul und nicht in routes/research.js: seit der Browser-
// Erweiterung gibt es einen ZWEITEN Eintrittspunkt (routes/capture.js), der
// Fundstuecke anlegt. Ein zweiter Schreibpfad mit eigener Reihenfolge waere die
// klassische Drift-Stelle — ein Aufrufer vergisst `searchIndex.upsertResearch`
// und das Fundstueck ist unauffindbar, ein anderer vergisst die Tags. Darum
// liegt die Schreibsequenz hier einmal und wird von beiden Routen aufgerufen.
//
// `research_items` ist buchweit GETEILT: `user_email` ist Ersteller-Attribution,
// kein Sichtbarkeits-Scope. Die Zugriffsregeln liegen in den Routen (Buch-ACL).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { normalizeUrls, normalizeTags, RESEARCH_KINDS } = require('../lib/research-validate');
const { MAX_TEXT_CHARS } = require('../lib/pdf-extract');
const searchIndex = require('../lib/search');

// target_kind → { col, table, pk, nameCol, orderCol } für Validierung,
// Display-JOIN und Sortierung „nach verknüpfter Entität". orderCol ist die Spalte,
// nach der die Entität in ihrer eigenen Ansicht geordnet ist (Buch-Reihenfolge).
const LINK_TARGETS = {
  chapter:  { col: 'chapter_id',  table: 'chapters',      pk: 'chapter_id', nameCol: 'chapter_name', orderCol: 'position' },
  page:     { col: 'page_id',     table: 'pages',         pk: 'page_id',    nameCol: 'page_name',    orderCol: 'position' },
  figure:   { col: 'figure_id',   table: 'figures',       pk: 'id',         nameCol: 'name',         orderCol: 'sort_order' },
  location: { col: 'location_id', table: 'locations',     pk: 'id',         nameCol: 'name',         orderCol: 'sort_order' },
  scene:    { col: 'scene_id',    table: 'figure_scenes', pk: 'id',         nameCol: 'titel',        orderCol: 'sort_order' },
  beat:     { col: 'beat_id',     table: 'plot_beats',    pk: 'id',         nameCol: 'titel',        orderCol: 'sort_order' },
  thread:   { col: 'thread_id',   table: 'plot_threads',  pk: 'id',         nameCol: 'name',         orderCol: 'position' },
};

// Tags + URLs + Links für eine Menge Items nachladen und nach item_id gruppieren.
function attachRelations(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const ph = ids.map(() => '?').join(',');

  const tagRows = db.prepare(
    `SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${ph}) ORDER BY tag`
  ).all(...ids);
  const tagsByItem = new Map();
  for (const r of tagRows) {
    if (!tagsByItem.has(r.item_id)) tagsByItem.set(r.item_id, []);
    tagsByItem.get(r.item_id).push(r.tag);
  }

  const urlRows = db.prepare(
    `SELECT id AS url_id, item_id, url, label FROM research_item_urls
      WHERE item_id IN (${ph}) ORDER BY item_id, position, id`
  ).all(...ids);
  const urlsByItem = new Map();
  for (const r of urlRows) {
    if (!urlsByItem.has(r.item_id)) urlsByItem.set(r.item_id, []);
    urlsByItem.get(r.item_id).push({ url_id: r.url_id, url: r.url, label: r.label || '' });
  }

  // Links inkl. Display-Label per target_kind-spezifischem JOIN (ein Pass je Kind).
  const linksByItem = new Map();
  for (const [kind, t] of Object.entries(LINK_TARGETS)) {
    const rows = db.prepare(
      `SELECT l.id AS link_id, l.item_id, l.${t.col} AS target_id, e.${t.nameCol} AS label
         FROM research_item_links l
         JOIN ${t.table} e ON e.${t.pk} = l.${t.col}
        WHERE l.item_id IN (${ph}) AND l.target_kind = ?`
    ).all(...ids, kind);
    for (const r of rows) {
      if (!linksByItem.has(r.item_id)) linksByItem.set(r.item_id, []);
      linksByItem.get(r.item_id).push({
        link_id: r.link_id, target_kind: kind, target_id: r.target_id, label: r.label || '',
      });
    }
  }

  for (const it of items) {
    it.tags = tagsByItem.get(it.id) || [];
    it.urls = urlsByItem.get(it.id) || [];
    it.links = linksByItem.get(it.id) || [];
    it.has_image = !!it.image_mime;
    it.has_doc = !!it.doc_mime;
    // Der Extraktor deckelt den Volltext (lib/pdf-extract.js#MAX_TEXT_CHARS);
    // ohne dieses Flag verschwindet der Rest lautlos aus Suche und Index.
    it.doc_truncated = (it.doc_chars ?? 0) >= MAX_TEXT_CHARS;
    delete it.image_mime;
    delete it.doc_mime;
  }
  return items;
}

/** Ausgabeform eines Fundstuecks (ohne BLOBs, mit Relationen). */
function emitItem(id) {
  const row = db.prepare(
    `SELECT id, book_id, user_email, kind, title, body, source, image_mime,
            doc_mime, doc_name, doc_pages, doc_chars, pinned, archived, created_at, updated_at
       FROM research_items WHERE id = ?`
  ).get(id);
  if (!row) return null;
  attachRelations([row]);
  return row;
}

// urls → geordnete Kind-Tabelle. Normalisierung (http(s)-only, Dedup, Cap, Label)
// kommt aus lib/research-validate (geteilt mit dem Chat-Vorschlag).
function replaceUrls(itemId, urls) {
  db.prepare('DELETE FROM research_item_urls WHERE item_id = ?').run(itemId);
  const { urls: clean } = normalizeUrls(urls);
  if (!clean.length) return;
  const ins = db.prepare(
    `INSERT INTO research_item_urls (item_id, url, label, position, created_at)
     VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`
  );
  let pos = 0;
  for (const { url, label } of clean) ins.run(itemId, url, label || null, pos++);
}

function replaceTags(itemId, tags) {
  db.prepare('DELETE FROM research_item_tags WHERE item_id = ?').run(itemId);
  const clean = normalizeTags(tags);
  if (!clean.length) return;
  const ins = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id, tag) VALUES (?, ?)');
  for (const tag of clean) ins.run(itemId, tag);
}

/** Neues Fundstueck samt URLs, Tags und Suchindex. Erwartet BEREITS gepruefte
 *  Felder (Laengen/Kind) — die Eingangspruefung gehoert in die Route, die auch
 *  den 400 formulieren muss. Gibt die neue Id zurueck.
 *
 *  Als Transaktion, damit ein Fundstueck nie ohne seine URLs existiert: die URL
 *  ist bei einem aus dem Browser erfassten Link die einzige Substanz. */
const createItem = db.transaction(({ bookId, userEmail, kind, title, body, source, urls, tags }) => {
  const k = RESEARCH_KINDS.has(kind) ? kind : 'note';
  const result = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, body, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`
  ).run(bookId, userEmail, k, title || null, body || null, source || null);
  const id = result.lastInsertRowid;
  replaceUrls(id, urls || []);
  replaceTags(id, tags || []);
  searchIndex.upsertResearch(id);
  return id;
});

module.exports = {
  LINK_TARGETS,
  attachRelations,
  emitItem,
  replaceUrls,
  replaceTags,
  createItem,
};
