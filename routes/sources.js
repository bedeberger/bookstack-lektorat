'use strict';
// Quellen-Bibliothek: CRUD auf dem User-Pool `sources`, Ver-/Entknuepfen mit
// einem Buch (`book_source_links`) und der Lesepfad auf den abgeleiteten
// Fund-Index `source_citations` („wo wird diese Quelle belegt").
//
// Zugriffsmodell — zwei Achsen, bewusst getrennt:
//   BESITZ (owner_email)  Anlegen, Aendern, Loeschen im Pool. Nur der Besitzer.
//                         Warum: die Quelle liegt in seinen anderen Arbeiten mit
//                         drin; ein Co-Autor, der hier den Titel korrigiert,
//                         aendert fremde Buecher gleich mit.
//   BUCH-ACL              Lesen (ab 'viewer' — auch ein Lektor muss den
//                         Quellen-Marker im Text aufloesen koennen) und
//                         Ver-/Entknuepfen (ab 'editor'). Das ist eine Aussage
//                         ueber das Buch, nicht ueber die fremde Bibliothek.
//
// Ein Co-Autor, der eine Quelle sachlich falsch findet, nimmt sie also aus dem
// Buch oder legt seine eigene an — er editiert nie die Bibliothek des anderen.
//
// Rein kuratierend: nie generativ im Buchtext. Die Quellenangabe im Seiten-HTML ist die
// Wahrheit darueber, wo zitiert wird; diese Routen verwalten nur die Quelle.

const express = require('express');
const {
  db, CSL_TYPES,
  listSources, listPoolSources, getSource, createSource, updateSource, deleteSource,
  linkSource, unlinkSource, isSourceLinked, listSourceBooks,
} = require('../db/schema');
const { hasMinRole } = require('../db/book-access');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, resolveBookRole, sendACLError } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });

const Q_MAX = 200;

function _guard(req, res, bookId, minRole) {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

function _userEmail(req) {
  return req.session?.user?.email || null;
}

/** Darf der User die Quelle sehen? Besitzer immer; sonst reicht Leserecht auf
 *  irgendeinem Buch, dem die Quelle zugeordnet ist — dort steht ihr Marker im
 *  Text und muss aufloesbar sein. */
function _canRead(req, src) {
  const email = _userEmail(req);
  if (!email) return false;
  if (src.owner_email === email) return true;
  return listSourceBooks(src.id)
    .some(b => hasMinRole(resolveBookRole(req, b.book_id) || '', 'viewer'));
}

function _isOwner(req, src) {
  const email = _userEmail(req);
  return !!email && src.owner_email === email;
}

// Body-Felder pruefen, bevor die DB-Schicht sie normalisiert. Die DB-Schicht
// waehlt bei Fremdwerten stillschweigend den Default — fuer die API ist ein
// 400 die ehrlichere Antwort, sonst speichert der Client scheinbar erfolgreich
// einen Typ, den er nie zurueckbekommt.
function _validateBody(body) {
  if (body.csl_type !== undefined && !CSL_TYPES.includes(String(body.csl_type))) {
    return { error_code: 'INVALID_VALUE', params: { field: 'csl_type', allowed: CSL_TYPES.join(', ') } };
  }
  for (const key of ['authors', 'editors']) {
    if (body[key] !== undefined && body[key] !== null && !Array.isArray(body[key])) {
      return { error_code: 'INVALID_VALUE', params: { field: key, allowed: 'array' } };
    }
  }
  if (body.url) {
    const u = String(body.url).trim();
    if (u && !/^https?:\/\//i.test(u)) return { error_code: 'INVALID_URL' };
  }
  return null;
}

// Eine Quelle braucht mindestens einen Titel oder eine Person — sonst entsteht
// ein Verzeichniseintrag, der nichts benennt.
function _hasIdentity(src) {
  if (src.title && String(src.title).trim()) return true;
  const persons = [...(src.authors || []), ...(src.editors || [])];
  return persons.some(p => p && (p.family || p.literal || typeof p === 'string'));
}

// Freitextfilter clientnah in JS: die Liste ist klein (Literaturbibliotheken
// liegen im zwei- bis dreistelligen Bereich) und die Personen stecken als JSON
// in einer Spalte — ein SQL-LIKE darauf waere ungenauer.
function _applyFilters(rows, query) {
  let out = rows;
  const type = String(query.type || '').trim();
  if (CSL_TYPES.includes(type)) out = out.filter(r => r.csl_type === type);

  const q = String(query.q || '').trim().slice(0, Q_MAX).toLowerCase();
  if (q) {
    out = out.filter((r) => {
      const persons = [...r.authors, ...r.editors]
        .map(p => `${p.family || ''} ${p.given || ''} ${p.literal || ''}`).join(' ');
      const hay = [r.title, r.container_title, r.publisher, r.year, r.citekey, persons]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  return out;
}

// ── Bibliothek des Users ─────────────────────────────────────────────────────
// GET /sources/pool?archived=1&exclude_book_id=&type=&q=
// Speist den „aus Bibliothek hinzufuegen"-Picker. Nur der eigene Pool — eine
// fremde Bibliothek ist nirgends sichtbar, auch nicht fuer Co-Autoren.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'pool' ab.
router.get('/pool', (req, res) => {
  const email = _userEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  // Das Ausschlussbuch ist ein Anzeigefilter, kein Zugriffsargument — trotzdem
  // gegen die ACL gepruefen, damit die Route nicht verraet, welche Quellen in
  // einem fremden Buch liegen.
  const excludeBookId = toIntId(req.query.exclude_book_id);
  if (req.query.exclude_book_id && !excludeBookId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  if (excludeBookId && !_guard(req, res, excludeBookId, 'viewer')) return;

  const rows = listPoolSources(email, {
    includeArchived: String(req.query.archived || '') === '1',
    excludeBookId: excludeBookId || null,
  });
  res.json(_applyFilters(rows, req.query));
});

// ── Liste eines Buchs ────────────────────────────────────────────────────────
// GET /sources?book_id=&archived=1&type=book&q=
router.get('/', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'viewer')) return;

  const rows = listSources(bookId, { includeArchived: String(req.query.archived || '') === '1' });
  res.json(_applyFilters(rows, req.query));
});

// ── Einzelne Quelle ──────────────────────────────────────────────────────────
// Optionales `book_id` waehlt die Kennzahl-Sicht (buch-skopiert statt Pool).
router.get('/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = toIntId(req.query.book_id);
  const src = getSource(id, bookId || null);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_canRead(req, src)) return res.status(403).json({ error_code: 'NO_BOOK_ACCESS' });
  res.json(src);
});

// ── Fundstellen einer Quelle ─────────────────────────────────────────────────
// Namen kommen per JOIN zur Lesezeit (keine Snapshot-Spalten im Index).
// `book_id` grenzt auf ein Buch ein — die Quellen-Karte ist buchweit, und die
// Fundstellen aus einer anderen Arbeit gehoeren dort nicht in die Liste.
router.get('/:id/citations', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });

  const bookId = toIntId(req.query.book_id);
  if (bookId) {
    if (!_guard(req, res, bookId, 'viewer')) return;
  } else if (!_canRead(req, src)) {
    return res.status(403).json({ error_code: 'NO_BOOK_ACCESS' });
  }

  const rows = db.prepare(`
    SELECT sc.page_id, sc.count, sc.first_offset,
           p.page_name, p.position AS page_position, p.book_id,
           c.chapter_id, c.chapter_name
      FROM source_citations sc
      JOIN pages p         ON p.page_id = sc.page_id
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
     WHERE sc.source_id = ? AND (? IS NULL OR p.book_id = ?)
     ORDER BY c.position, p.position, sc.first_offset
  `).all(id, bookId || null, bookId || null);
  res.json(rows);
});

// ── Buecher, die eine Quelle nutzen ──────────────────────────────────────────
// Basis der Loesch-Warnung: „wird in 3 Arbeiten verwendet". Nur der Besitzer —
// sonst waere aus einem geteilten Buch ableitbar, an welchen anderen Arbeiten
// jemand sitzt.
router.get('/:id/books', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });
  res.json(listSourceBooks(id));
});

// ── Anlegen ──────────────────────────────────────────────────────────────────
// POST /sources  Body: { book_id?, csl_type?, title?, authors?, … }
// Legt im Pool des Users an. `book_id` ordnet gleich zu — der Normalfall aus der
// Quellen-Karte heraus. Ohne `book_id` entsteht ein reiner Bibliothekseintrag.
router.post('/', jsonBody, (req, res) => {
  const userEmail = _userEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const body = req.body || {};
  const bookId = body.book_id === undefined || body.book_id === null
    ? null
    : toIntId(body.book_id);
  if (body.book_id !== undefined && body.book_id !== null && !bookId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  if (bookId && !_guard(req, res, bookId, 'editor')) return;

  const bad = _validateBody(body);
  if (bad) return res.status(400).json(bad);
  if (!_hasIdentity(body)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  try {
    const created = createSource(userEmail, body);
    if (bookId) linkSource(bookId, created.id, userEmail);
    logger.info(`[quellen] create id=${created.id} book=${bookId || '-'} typ=${created.csl_type}`);
    res.json(bookId ? getSource(created.id, bookId) : created);
  } catch (e) {
    // UNIQUE(owner_email, citekey) — der Zitierschluessel muss in der Bibliothek
    // eindeutig sein, sonst zeigen zwei Eintraege denselben Kurzbeleg.
    if (/UNIQUE/i.test(e.message || '')) return res.status(409).json({ error_code: 'CITEKEY_TAKEN' });
    throw e;
  }
});

// ── Aktualisieren ────────────────────────────────────────────────────────────
// PATCH-artig: nur uebergebene Felder aendern sich. Nur der Besitzer — die
// Quelle liegt in seinen anderen Arbeiten mit drin.
router.put('/:id', jsonBody, (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const body = req.body || {};
  const bad = _validateBody(body);
  if (bad) return res.status(400).json(bad);
  if (!_hasIdentity({ ...src, ...body })) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  try {
    const bookId = toIntId(req.query.book_id);
    updateSource(id, body);
    res.json(getSource(id, bookId || null));
  } catch (e) {
    if (/UNIQUE/i.test(e.message || '')) return res.status(409).json({ error_code: 'CITEKEY_TAKEN' });
    throw e;
  }
});

// ── Einem Buch zuordnen ──────────────────────────────────────────────────────
// POST /sources/:id/link  Body: { book_id }
// Zwei Rechte gleichzeitig: Editor des Buchs (man aendert das Buch) UND
// Besitzer der Quelle (man verteilt nicht fremde Bibliothekseintraege).
router.post('/:id/link', jsonBody, (req, res) => {
  const id = toIntId(req.params.id);
  const bookId = toIntId(req.body?.book_id);
  if (!id || !bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_guard(req, res, bookId, 'editor')) return;
  if (!_isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const added = linkSource(bookId, id, _userEmail(req));
  if (added) logger.info(`[quellen] link id=${id} book=${bookId}`);
  res.json({ ok: true, added, source: getSource(id, bookId) });
});

// ── Aus dem Buch entfernen ───────────────────────────────────────────────────
// DELETE /sources/:id/link?book_id=
// Buch-Operation, kein Bibliotheks-Eingriff: reicht ab 'editor', der Pool-
// Eintrag bleibt unangetastet. Die Fundstellen DIESES Buchs raeumt die
// DB-Schicht mit weg; die Quellen-Marker im Seitentext bleiben stehen (die
// Seiten werden nicht hinter dem Ruecken des Users umgeschrieben).
router.delete('/:id/link', (req, res) => {
  const id = toIntId(req.params.id);
  const bookId = toIntId(req.query.book_id);
  if (!id || !bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;
  if (!isSourceLinked(bookId, id)) return res.status(404).json({ error_code: 'NOT_FOUND' });

  const src = getSource(id, bookId);
  const orphaned = src?.cite_pages || 0;
  unlinkSource(bookId, id);
  logger.info(`[quellen] unlink id=${id} book=${bookId} fundstellen=${orphaned}`);
  res.json({ ok: true, orphaned_citations: orphaned });
});

// ── Aus der Bibliothek loeschen ──────────────────────────────────────────────
// Wirkt in ALLEN Buechern — darum nur der Besitzer. Zuordnungen und Fundstellen
// verschwinden per FK-CASCADE. Quellen-Marker im Seiten-HTML bleiben stehen und
// werden zu Quellenangaben ohne Ziel — bewusst: die Seiten werden nicht hinter
// dem Ruecken des Users umgeschrieben. Die Antwort meldet Fundstellen und
// betroffene Buecher, damit die Karte davor warnen kann.
router.delete('/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const books = listSourceBooks(id).length;
  deleteSource(id);
  logger.info(`[quellen] delete id=${id} buecher=${books} fundstellen=${src.cite_pages}`);
  res.json({ ok: true, orphaned_citations: src.cite_pages, affected_books: books });
});

module.exports = router;
