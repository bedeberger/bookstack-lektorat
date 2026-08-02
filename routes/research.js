'use strict';
// Recherche-/Wissensboard pro Buch — geteiltes Archiv fuer Notizen, Links,
// Zitate, Faktensplitter und Bilder. Buchweit GETEILT: alle Editoren des Buchs
// sehen dieselben Schnipsel; `user_email` ist reine Ersteller-Attribution, kein
// Sichtbarkeits-Scope (anders als routes/ideen.js). Rein kuratierend/rueckwaerts-
// gewandt — nie generativ im Buchtext.
//
// Jeder Schnipsel ist optional mit beliebig vielen Buch-Entitaeten verknuepfbar
// (Kapitel/Seite/Figur/Ort/Szene/Plot-Beat, Bridge-Tabelle research_item_links)
// und ueber freie Tags (research_item_tags) filterbar.

const express = require('express');
const { db } = require('../db/schema');
const {
  LINK_TARGETS, attachRelations, emitItem, replaceUrls, replaceTags, createItem, itemBookId,
} = require('../db/research-items');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const {
  RESEARCH_KINDS, LIST_FILTER_KINDS, TITLE_MAX, BODY_MAX, SOURCE_MAX, TAG_MAX, cleanStr,
  FTS_PREFILTER_LIMIT, CLIENT_LIST_LIMIT, clampListLimit, toClientItem,
} = require('../lib/research-validate');
const logger = require('../logger');
const { researchMediaRouter } = require('./research-media');

const router = express.Router();
const jsonBody = express.json();

// Medien-Wege (Bild + PDF-Upload, Auslieferung, Löschung) liegen in einem
// eigenen Modul — siehe routes/research-media.js. Mount unter '/' (kein Prefix),
// damit die Pfade /:id/image und /:id/doc aus der bisherigen Route identisch
// bleiben — der Client-Vertrag (docs/clients.md) ändert sich nicht.
router.use('/', researchMediaRouter);

// Item-Modell (Anlegen, Kind-Tabellen, Ausgabeform, LINK_TARGETS) liegt in
// db/research-items.js, weil routes/capture.js (Browser-Erweiterung) denselben
// Schreibpfad braucht. Aliase, damit die Aufrufstellen unveraendert bleiben.
const _attachRelations = attachRelations;
const _emitItem = emitItem;
const _replaceUrls = replaceUrls;
const _replaceTags = replaceTags;

// Erlaubte Sortier-Modi: feste Felder + „link:<dimension>" (nach verknüpfter Entität).
const FIXED_SORTS = {
  updated: 'ri.pinned DESC, ri.updated_at DESC',
  created: 'ri.pinned DESC, ri.created_at DESC',
  title:   "ri.pinned DESC, (ri.title IS NULL OR ri.title = ''), ri.title COLLATE NOCASE, ri.updated_at DESC",
  kind:    'ri.pinned DESC, ri.kind, ri.updated_at DESC',
};

// PATCH-Feld-Deskriptoren für PATCH /:id. Reihenfolge bestimmt die
// Validierungsreihenfolge (kind zuerst → early return bei INVALID_KIND, wie
// vorher). `validate` retourniert false für einen 400; `clean` konvertiert den
// Eingabewert in den SQL-Wert.
const PATCH_FIELDS = [
  { name: 'kind',     validate: (v) => RESEARCH_KINDS.has(v), error: 'INVALID_KIND' },
  { name: 'title',    clean: (v) => cleanStr(v, TITLE_MAX) },
  { name: 'body',     clean: (v) => cleanStr(v, BODY_MAX) },
  { name: 'source',   clean: (v) => cleanStr(v, SOURCE_MAX) },
  { name: 'pinned',   clean: (v) => v ? 1 : 0 },
  { name: 'archived', clean: (v) => v ? 1 : 0 },
];

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// ── Liste + Filter ─────────────────────────────────────────────────────────
// GET /research?book_id=&kind=&tag=&linked=figure:42&q=&limit=
//
// Zwei Konsumenten, EIN Lesepfad — die Filter sind fuer beide dieselben, nur die
// Ausgabeform unterscheidet sich:
//   Session (SPA)          volle Item-Form inkl. `body`, ohne LIMIT (das Board
//                          zeigt den ganzen Bestand).
//   Device-Token (Client)  reduzierte Form (lib/research-validate#toClientItem)
//                          und CLIENT_LIST_LIMIT als Default. Der `body` traegt
//                          bis zu 20 000 Zeichen Seitentext, den die Browser-
//                          Erweiterung selbst hochgeladen hat; sie fragt hier
//                          „kenne ich diese Seite schon", nicht nach dem Inhalt.
router.get('/', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;

  // Geraete-Token → Client-Form. Die ACL darueber ist dieselbe: `editor` auf dem
  // Buch, gleich ob Session oder Token (das Token loest auf den echten User auf).
  const asClient = req.session?.user?.via === 'device_token';
  const limit = clampListLimit(req.query.limit, asClient ? CLIENT_LIST_LIMIT : null);

  const where = ['ri.book_id = ?'];
  const vals = [bookId];

  // LIST_FILTER_KINDS statt RESEARCH_KINDS: 'document'/'image' entstehen nur ueber
  // die Upload-Routen, sind aber filterbare Bestandstypen (wie im Chat-Tool).
  const kind = String(req.query.kind || '').trim();
  if (LIST_FILTER_KINDS.has(kind)) { where.push('ri.kind = ?'); vals.push(kind); }

  if (String(req.query.archived || '') !== '1') where.push('ri.archived = 0');

  const tag = cleanStr(String(req.query.tag || ''), TAG_MAX);
  if (tag) {
    where.push('ri.id IN (SELECT item_id FROM research_item_tags WHERE tag = ?)');
    vals.push(tag);
  }

  // linked=figure:42 → nur Items, die mit dieser Entitaet verknuepft sind.
  const linked = String(req.query.linked || '').trim();
  if (linked) {
    const [lk, lidRaw] = linked.split(':');
    const t = LINK_TARGETS[lk];
    const lid = toIntId(lidRaw);
    if (t && lid) {
      where.push(`ri.id IN (SELECT item_id FROM research_item_links WHERE target_kind = ? AND ${t.col} = ?)`);
      vals.push(lk, lid);
    }
  }

  // q → FTS5-Vorfilter auf research-Kind dieses Buchs. Gedeckelt auf
  // FTS_PREFILTER_LIMIT Treffer: eine sehr breite Suche in einem sehr grossen
  // Buch sieht die Funde jenseits davon nicht (dokumentiert in docs/clients.md,
  // damit der Client die Grenze spiegeln kann).
  const q = String(req.query.q || '').trim();
  if (q) {
    try {
      const hits = searchIndex.query(q, { bookId, kinds: ['research'], limit: FTS_PREFILTER_LIMIT });
      const ids = (hits?.hits || []).map(h => h.entity_id).filter(Boolean);
      if (!ids.length) return res.json([]);
      where.push(`ri.id IN (${ids.map(() => '?').join(',')})`);
      vals.push(...ids);
    } catch (e) {
      logger.warn('[research] FTS-Vorfilter fehlgeschlagen: ' + e.message);
    }
  }

  // sort=updated|created|title|kind oder sort=link:<dimension> (nach verknüpfter
  // Entität, in deren Buch-Reihenfolge; Unverknüpfte ans Ende). Angeheftet bleibt
  // immer oben. Der Link-Sort braucht eine korrelierte Subquery, deren Platzhalter
  // VOR den WHERE-Werten gebunden wird → selectVals zuerst.
  const sortRaw = String(req.query.sort || 'updated').trim();
  let selectExtra = '';
  const selectVals = [];
  let orderBy = FIXED_SORTS.updated;
  const linkSort = /^link:(\w+)$/.exec(sortRaw);
  if (FIXED_SORTS[sortRaw]) {
    orderBy = FIXED_SORTS[sortRaw];
  } else if (linkSort && LINK_TARGETS[linkSort[1]]) {
    const t = LINK_TARGETS[linkSort[1]];
    selectExtra = `, (SELECT MIN(e.${t.orderCol}) FROM research_item_links l
                        JOIN ${t.table} e ON e.${t.pk} = l.${t.col}
                       WHERE l.item_id = ri.id AND l.target_kind = ?) AS link_rank`;
    selectVals.push(linkSort[1]);
    orderBy = 'ri.pinned DESC, (link_rank IS NULL), link_rank, ri.updated_at DESC';
  }

  const limitVals = limit ? [limit] : [];
  const rows = db.prepare(
    `SELECT ri.id, ri.book_id, ri.user_email, ri.kind, ri.title, ri.body,
            ri.source, ri.image_mime, ri.doc_mime, ri.doc_name, ri.doc_pages, ri.doc_chars,
            ri.pinned, ri.archived, ri.created_at, ri.updated_at${selectExtra}
       FROM research_items ri
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}${limit ? '\n      LIMIT ?' : ''}`
  ).all(...selectVals, ...vals, ...limitVals);
  for (const r of rows) delete r.link_rank;
  // attachRelations laeuft auch fuer die Client-Form: sie braucht die `urls`.
  const items = _attachRelations(rows);
  res.json(asClient ? items.map(toClientItem) : items);
});

// Tag-Pool des Buchs (mit Häufigkeit) für die Filter-Combobox.
router.get('/tags', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const rows = db.prepare(
    `SELECT t.tag AS tag, COUNT(*) AS n
       FROM research_item_tags t JOIN research_items ri ON ri.id = t.item_id
      WHERE ri.book_id = ?
      GROUP BY t.tag ORDER BY n DESC, t.tag ASC`
  ).all(bookId);
  res.json(rows);
});

// Verknüpfbare Entitäten des Buchs für den Link-Picker (book-shared).
router.get('/link-targets', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const userEmail = userEmailOrNull(req);
  const out = {};
  out.chapter = db.prepare(
    'SELECT chapter_id AS id, chapter_name AS label FROM chapters WHERE book_id = ? ORDER BY position, chapter_name'
  ).all(bookId);
  out.page = db.prepare(
    'SELECT page_id AS id, page_name AS label FROM pages WHERE book_id = ? ORDER BY position, page_name'
  ).all(bookId);
  // user-skopierte Welt-Entitäten: nur die des anfragenden Users anbieten.
  // Wo eine „Wichtigkeit" existiert, danach primär sortieren: Figuren nach
  // praesenz (Handlungsgewicht, zentral→randfigur), Beats nach intensitaet
  // (5→1). Orte/Szenen haben kein Wichtigkeits-Signal → kuratierte sort_order.
  out.figure = db.prepare(
    `SELECT id, name AS label FROM figures WHERE book_id = ? AND user_email = ?
      ORDER BY CASE praesenz WHEN 'zentral' THEN 0 WHEN 'regelmaessig' THEN 1
                             WHEN 'punktuell' THEN 2 WHEN 'randfigur' THEN 3
                             ELSE 4 END, sort_order, name`
  ).all(bookId, userEmail);
  out.location = db.prepare(
    'SELECT id, name AS label FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'
  ).all(bookId, userEmail);
  out.scene = db.prepare(
    'SELECT id, titel AS label FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'
  ).all(bookId, userEmail);
  out.beat = db.prepare(
    `SELECT id, titel AS label FROM plot_beats WHERE book_id = ? AND user_email = ?
      ORDER BY CASE WHEN intensitaet IS NULL THEN 1 ELSE 0 END, intensitaet DESC, sort_order, titel`
  ).all(bookId, userEmail);
  out.thread = db.prepare(
    'SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name'
  ).all(bookId, userEmail);
  res.json(out);
});

// Map page_id → Anzahl verknüpfter, nicht-archivierter Recherche-Items eines
// Buchs. Speist den Seiten-Indikator (Sidebar + Editor) wie /ideen/counts.
// Buchweit geteilt → kein user_email-Filter (anders als Ideen).
router.get('/page-counts', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const rows = db.prepare(
    `SELECT l.page_id AS page_id, COUNT(DISTINCT l.item_id) AS n
       FROM research_item_links l
       JOIN research_items ri ON ri.id = l.item_id
      WHERE ri.book_id = ? AND ri.archived = 0
        AND l.target_kind = 'page' AND l.page_id IS NOT NULL
      GROUP BY l.page_id`
  ).all(bookId);
  const map = {};
  for (const r of rows) map[r.page_id] = r.n;
  res.json(map);
});

// Map chapter_id → Anzahl verknüpfter, nicht-archivierter Recherche-Items eines
// Buchs. Speist den Kapitel-Indikator in der Sidebar (analog /page-counts).
// Buchweit geteilt → kein user_email-Filter (anders als Ideen).
router.get('/chapter-counts', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  const rows = db.prepare(
    `SELECT l.chapter_id AS chapter_id, COUNT(DISTINCT l.item_id) AS n
       FROM research_item_links l
       JOIN research_items ri ON ri.id = l.item_id
      WHERE ri.book_id = ? AND ri.archived = 0
        AND l.target_kind = 'chapter' AND l.chapter_id IS NOT NULL
      GROUP BY l.chapter_id`
  ).all(bookId);
  const map = {};
  for (const r of rows) map[r.chapter_id] = r.n;
  res.json(map);
});

// ── Anlegen ──────────────────────────────────────────────────────────────
router.post('/', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const kind = RESEARCH_KINDS.has(req.body?.kind) ? req.body.kind : 'note';
  const title = cleanStr(req.body?.title, TITLE_MAX);
  const body = cleanStr(req.body?.body, BODY_MAX);
  const source = cleanStr(req.body?.source, SOURCE_MAX);
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const hasUrl = urls.some(u => /^https?:\/\//i.test(String(typeof u === 'string' ? u : u?.url || '').trim()));
  if (!title && !body && !hasUrl) return res.status(400).json({ error_code: 'EMPTY' });

  const id = createItem({
    bookId, userEmail, kind, title, body, source, urls, tags: req.body?.tags,
  });
  logger.info(`[research] create id=${id} kind=${kind}`);
  res.json(_emitItem(id));
});

// ── Aktualisieren (Felder + pinned + archived + Tags optional einzeln) ──────
router.patch('/:id', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const sets = [];
  const vals = [];
  const b = req.body || {};
  for (const f of PATCH_FIELDS) {
    if (typeof b[f.name] === 'undefined') continue;
    if (f.validate && !f.validate(b[f.name])) {
      return res.status(400).json({ error_code: f.error || 'INVALID_FIELD' });
    }
    sets.push(`${f.name} = ?`);
    vals.push(f.clean ? f.clean(b[f.name]) : b[f.name]);
  }

  const hasTags = typeof b.tags !== 'undefined';
  const hasUrls = typeof b.urls !== 'undefined';
  if (!sets.length && !hasTags && !hasUrls) return res.status(400).json({ error_code: 'NO_FIELDS' });

  // urls sind Kerninhalt → updated_at auch dann bumpen, wenn nur sie sich ändern.
  if (sets.length || hasUrls) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    vals.push(id);
    db.prepare(`UPDATE research_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (hasUrls) _replaceUrls(id, b.urls);
  if (hasTags) _replaceTags(id, b.tags);
  searchIndex.upsertResearch(id);
  res.json(_emitItem(id));
});

// ── Löschen ────────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare('DELETE FROM research_items WHERE id = ?').run(id);
  searchIndex.remove('research', id);
  res.json({ ok: true });
});

// ── Verknüpfung hinzufügen ──────────────────────────────────────────────────
router.post('/:id/links', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const targetKind = String(req.body?.target_kind || '').trim();
  const targetId = toIntId(req.body?.target_id);
  const t = LINK_TARGETS[targetKind];
  if (!t || !targetId) return res.status(400).json({ error_code: 'INVALID_TARGET' });
  // Ziel muss zum Buch gehören.
  const owner = db.prepare(`SELECT book_id FROM ${t.table} WHERE ${t.pk} = ?`).get(targetId);
  if (!owner || owner.book_id !== bookId) return res.status(400).json({ error_code: 'BOOK_MISMATCH' });

  try {
    db.prepare(
      `INSERT INTO research_item_links (item_id, target_kind, ${t.col}, created_at)
       VALUES (?, ?, ?, ${NOW_ISO_SQL})`
    ).run(id, targetKind, targetId);
  } catch (e) {
    // UNIQUE-Verstoß = Verknüpfung existiert bereits → idempotent.
    if (!/UNIQUE/.test(e.message)) throw e;
  }
  res.json(_emitItem(id));
});

// ── Verknüpfung entfernen ────────────────────────────────────────────────────
router.delete('/:id/links/:linkId', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  const linkId = toIntId(req.params.linkId);
  if (!id || !linkId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = itemBookId(id);
  if (!bookId) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  db.prepare('DELETE FROM research_item_links WHERE id = ? AND item_id = ?').run(linkId, id);
  res.json(_emitItem(id));
});

module.exports = router;

