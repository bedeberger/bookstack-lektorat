'use strict';
// CRUD fuer book_sources (Quellenverzeichnis) + Lesepfad auf den abgeleiteten
// Fund-Index source_citations („wo wird diese Quelle belegt").
//
// Skopierung wie das Recherche-Board: buchweit GETEILT, `user_email` ist reine
// Ersteller-Attribution. Zugriff regelt die Buch-ACL — Lesen ab 'viewer'
// (die Leseansicht muss den Quellen-Marker aufloesen koennen, auch fuer einen
// Lektor), Schreiben ab 'editor'.
//
// Rein kuratierend: nie generativ im Buchtext. Die Quellenangabe im Seiten-HTML ist die
// Wahrheit darueber, wo zitiert wird; diese Routen verwalten nur die Quelle.

const express = require('express');
const {
  db, CSL_TYPES,
  listSources, getSource, createSource, updateSource, deleteSource,
} = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
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

// ── Liste ────────────────────────────────────────────────────────────────────
// GET /sources?book_id=&archived=1&type=book&q=
router.get('/', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'viewer')) return;

  const includeArchived = String(req.query.archived || '') === '1';
  let rows = listSources(bookId, { includeArchived });

  const type = String(req.query.type || '').trim();
  if (CSL_TYPES.includes(type)) rows = rows.filter(r => r.csl_type === type);

  // Freitextfilter clientnah in JS: die Liste ist pro Buch klein (Literatur-
  // verzeichnisse liegen im zwei- bis dreistelligen Bereich) und die Personen
  // stecken als JSON in einer Spalte — ein SQL-LIKE darauf waere ungenauer.
  const q = String(req.query.q || '').trim().slice(0, Q_MAX).toLowerCase();
  if (q) {
    rows = rows.filter((r) => {
      const persons = [...r.authors, ...r.editors]
        .map(p => `${p.family || ''} ${p.given || ''} ${p.literal || ''}`).join(' ');
      const hay = [r.title, r.container_title, r.publisher, r.year, r.citekey, persons]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  res.json(rows);
});

// ── Einzelne Quelle ──────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_guard(req, res, src.book_id, 'viewer')) return;
  res.json(src);
});

// ── Fundstellen einer Quelle ─────────────────────────────────────────────────
// Namen kommen per JOIN zur Lesezeit (keine Snapshot-Spalten im Index).
router.get('/:id/citations', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_guard(req, res, src.book_id, 'viewer')) return;

  const rows = db.prepare(`
    SELECT sc.page_id, sc.count, sc.first_offset,
           p.page_name, p.position AS page_position,
           c.chapter_id, c.chapter_name
      FROM source_citations sc
      JOIN pages p         ON p.page_id = sc.page_id
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
     WHERE sc.source_id = ?
     ORDER BY c.position, p.position, sc.first_offset
  `).all(id);
  res.json(rows);
});

// ── Anlegen ──────────────────────────────────────────────────────────────────
// POST /sources  Body: { book_id, csl_type?, title?, authors?, … }
router.post('/', jsonBody, (req, res) => {
  const userEmail = _userEmail(req);
  const bookId = toIntId(req.body?.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const body = req.body || {};
  const bad = _validateBody(body);
  if (bad) return res.status(400).json(bad);
  if (!_hasIdentity(body)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  try {
    const created = createSource(bookId, userEmail, body);
    logger.info(`[quellen] create id=${created.id} book=${bookId} typ=${created.csl_type}`);
    res.json(created);
  } catch (e) {
    // UNIQUE(book_id, citekey) — der Zitierschluessel muss im Buch eindeutig
    // sein, sonst zeigen zwei Verzeichniseintraege denselben Kurzbeleg.
    if (/UNIQUE/i.test(e.message || '')) return res.status(409).json({ error_code: 'CITEKEY_TAKEN' });
    throw e;
  }
});

// ── Aktualisieren ────────────────────────────────────────────────────────────
// PATCH-artig: nur uebergebene Felder aendern sich.
router.put('/:id', jsonBody, (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_guard(req, res, src.book_id, 'editor')) return;

  const body = req.body || {};
  const bad = _validateBody(body);
  if (bad) return res.status(400).json(bad);
  if (!_hasIdentity({ ...src, ...body })) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  try {
    res.json(updateSource(id, body));
  } catch (e) {
    if (/UNIQUE/i.test(e.message || '')) return res.status(409).json({ error_code: 'CITEKEY_TAKEN' });
    throw e;
  }
});

// ── Loeschen ─────────────────────────────────────────────────────────────────
// Fundstellen verschwinden per FK-CASCADE. Quellen-Marker im Seiten-HTML bleiben
// stehen und werden zu Quellenangaben ohne Ziel — bewusst: die Seiten werden nicht
// hinter dem Ruecken des Users umgeschrieben. Die Antwort meldet die Zahl der
// betroffenen Fundstellen, damit die Karte davor warnen kann.
router.delete('/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!_guard(req, res, src.book_id, 'editor')) return;

  deleteSource(id);
  logger.info(`[quellen] delete id=${id} book=${src.book_id} fundstellen=${src.cite_pages}`);
  res.json({ ok: true, orphaned_citations: src.cite_pages });
});

module.exports = router;
