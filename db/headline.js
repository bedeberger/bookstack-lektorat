'use strict';
// Titel-Werkstatt: Dachzeile / Titel / Lead / Teaser als Metadata der Seite,
// dazu die Varianten daneben.
//
// Der geltende Stand (`page_headline`) und die Kandidaten
// (`page_headline_variants`) sind getrennte Tabellen — Begruendung in Migration
// 269. Diese Datei ist die einzige Stelle, die beide zusammen liest und die
// Uebernahme einer Variante ausfuehrt.
//
// KEINE ZEICHENLIMITS HIER. Die leben in public/js/headline/channels.js und sind
// eine Anzeige, keine Validierung: ein zu langer Titel ist ein unfertiger Titel,
// kein Fehler. Der Server speichert, was der Autor schreibt. Bewusst kein
// CJS-Spiegel der Limits — es gibt serverseitig nichts, was sie brauchen wuerde.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

/** Deckungsgleich mit HEADLINE_FIELDS in public/js/headline/channels.js und mit
 *  dem CHECK-Constraint von `page_headline_variants.feld`. CJS-Spiegel, weil die
 *  Schreibpfade synchron validieren. Gegated durch
 *  tests/unit/headline-drift.test.mjs. */
const HEADLINE_FIELDS = ['dachzeile', 'titel', 'lead', 'teaser'];

/** Deckungsgleich mit dem CHECK auf `herkunft`. */
const HEADLINE_HERKUNFT = ['user', 'ki'];

/** Deckel je Feld. Das ist KEIN Kanal-Limit, sondern der Schutz davor, dass
 *  jemand einen ganzen Artikel ins Titelfeld kippt — deshalb so grosszuegig,
 *  dass keine redaktionelle Formulierung je anschlaegt. */
const MAX_LEN = { dachzeile: 300, titel: 400, lead: 2000, teaser: 1200 };

function isValidHeadlineField(v) {
  return typeof v === 'string' && HEADLINE_FIELDS.includes(v);
}

/** Eingabe-Normalisierung: getrimmt, Zeilenumbrueche und Mehrfach-Leerzeichen
 *  zu einem Leerzeichen, leer wird null. Eine Dachzeile mit hartem Umbruch aus
 *  einem Paste waere sonst in jeder Ausspielung ein anderes Ding. */
function _clean(v, feld) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, MAX_LEN[feld] || 400);
}

const _stmtGet = db.prepare(
  'SELECT page_id, dachzeile, titel, lead, teaser, updated_by, updated_at FROM page_headline WHERE page_id = ?',
);
const _stmtListForBook = db.prepare(
  'SELECT page_id, dachzeile, titel, lead, teaser, updated_by, updated_at FROM page_headline WHERE book_id = ?',
);
const _stmtUpsert = db.prepare(`
  INSERT INTO page_headline (page_id, book_id, dachzeile, titel, lead, teaser, updated_by, updated_at)
  VALUES (@page_id, @book_id, @dachzeile, @titel, @lead, @teaser, @updated_by, ${NOW_ISO_SQL})
  ON CONFLICT(page_id) DO UPDATE SET
    book_id    = excluded.book_id,
    dachzeile  = excluded.dachzeile,
    titel      = excluded.titel,
    lead       = excluded.lead,
    teaser     = excluded.teaser,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
`);
const _stmtDelete = db.prepare('DELETE FROM page_headline WHERE page_id = ?');

/** Geltender Stand einer Seite oder null. */
function getHeadline(pageId) {
  return _stmtGet.get(parseInt(pageId)) || null;
}

/** Alle Titel-Saetze eines Buchs als { [page_id]: row }. */
function listBookHeadlines(bookId) {
  const out = {};
  for (const r of _stmtListForBook.all(parseInt(bookId))) out[String(r.page_id)] = r;
  return out;
}

/**
 * Setzt die uebergebenen Felder. NUR die uebergebenen: ein fehlender Schluessel
 * laesst den bisherigen Wert stehen, ein uebergebenes `null`/`''` loescht ihn.
 * Ohne diese Unterscheidung koennte die Karte kein Einzelfeld speichern, ohne
 * die drei anderen mitzuschicken — und ein Teil-PUT aus einer alten Tab-Sitzung
 * wuerde die inzwischen woanders gesetzten Felder leeren.
 *
 * Sind am Ende alle vier leer, faellt die Zeile ganz weg: eine Seite ohne
 * Titel-Werkstatt soll keine leere Zeile hinterlassen (die Kennzahl „wie viele
 * Beitraege haben schon einen Titel" zaehlt sonst falsch).
 */
function setHeadline(pageId, bookId, patch = {}, userEmail = null) {
  const pid = parseInt(pageId);
  const cur = getHeadline(pid) || { dachzeile: null, titel: null, lead: null, teaser: null };
  const next = {};
  for (const f of HEADLINE_FIELDS) {
    next[f] = Object.prototype.hasOwnProperty.call(patch, f) ? _clean(patch[f], f) : (cur[f] ?? null);
  }
  if (HEADLINE_FIELDS.every(f => next[f] === null)) {
    _stmtDelete.run(pid);
    return null;
  }
  _stmtUpsert.run({ page_id: pid, book_id: parseInt(bookId), updated_by: userEmail, ...next });
  return getHeadline(pid);
}

// ── Varianten ────────────────────────────────────────────────────────────────

const _stmtVariants = db.prepare(
  `SELECT id, page_id, feld, text, herkunft, created_by, created_at
     FROM page_headline_variants WHERE page_id = ?
    ORDER BY feld, created_at DESC, id DESC`,
);
const _stmtVariantById = db.prepare(
  'SELECT id, page_id, book_id, feld, text FROM page_headline_variants WHERE id = ?',
);
const _stmtAddVariant = db.prepare(`
  INSERT INTO page_headline_variants (page_id, book_id, feld, text, herkunft, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);
const _stmtDeleteVariant = db.prepare('DELETE FROM page_headline_variants WHERE id = ?');
const _stmtDupe = db.prepare(
  'SELECT id FROM page_headline_variants WHERE page_id = ? AND feld = ? AND text = ?',
);

/** Varianten einer Seite, nach Feld gruppiert: { [feld]: [ {…}, … ] }. */
function listVariants(pageId) {
  const out = Object.fromEntries(HEADLINE_FIELDS.map(f => [f, []]));
  for (const r of _stmtVariants.all(parseInt(pageId))) {
    if (out[r.feld]) out[r.feld].push(r);
  }
  return out;
}

/**
 * Legt eine Variante an und liefert sie zurueck. Wortgleiche Doppel werden
 * nicht angelegt, sondern die bestehende geliefert — ein zweiter KI-Lauf
 * schlaegt regelmaessig dieselbe naheliegende Formulierung vor, und eine Liste
 * mit demselben Titel dreimal ist keine Auswahl.
 */
function addVariant(pageId, bookId, { feld, text, herkunft = 'user', userEmail = null }) {
  if (!isValidHeadlineField(feld)) {
    const err = new Error(`Ungueltiges Titel-Feld: ${feld}`);
    err.code = 'INVALID_FIELD';
    throw err;
  }
  const clean = _clean(text, feld);
  if (!clean) return null;
  const h = HEADLINE_HERKUNFT.includes(herkunft) ? herkunft : 'user';
  const pid = parseInt(pageId);
  const dupe = _stmtDupe.get(pid, feld, clean);
  if (dupe) return _stmtVariantById.get(dupe.id);
  const info = _stmtAddVariant.run(pid, parseInt(bookId), feld, clean, h, userEmail);
  return _stmtVariantById.get(info.lastInsertRowid);
}

function deleteVariant(id) {
  return _stmtDeleteVariant.run(parseInt(id)).changes > 0;
}

/**
 * Variante uebernehmen: ihr Text wird der geltende Stand ihres Feldes. Die
 * Variante BLEIBT stehen — der bisherige Stand wird stattdessen als Variante
 * gesichert, sofern es ihn gab und er nicht ohnehin schon in der Liste steht.
 * So ist jede Uebernahme umkehrbar, ohne eine eigene Undo-Historie zu bauen.
 */
function promoteVariant(id, userEmail = null) {
  const v = _stmtVariantById.get(parseInt(id));
  if (!v) return null;
  return db.transaction(() => {
    const cur = getHeadline(v.page_id);
    const alt = cur?.[v.feld] || null;
    if (alt && alt !== v.text) {
      addVariant(v.page_id, v.book_id, { feld: v.feld, text: alt, herkunft: 'user', userEmail });
    }
    return setHeadline(v.page_id, v.book_id, { [v.feld]: v.text }, userEmail);
  })();
}

/** Zeile einer Variante (fuer ACL-Aufloesung ueber ihr Buch). */
function getVariant(id) {
  return _stmtVariantById.get(parseInt(id)) || null;
}

module.exports = {
  HEADLINE_FIELDS, HEADLINE_HERKUNFT, MAX_LEN, isValidHeadlineField,
  getHeadline, listBookHeadlines, setHeadline,
  listVariants, addVariant, deleteVariant, promoteVariant, getVariant,
};
