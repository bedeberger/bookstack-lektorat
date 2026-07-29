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
  linkSource, unlinkSource, isSourceLinked, listSourceBooks, getBookQuoteStats,
} = require('../db/schema');
const { hasMinRole } = require('../db/book-access');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, resolveBookRole, sendACLError } = require('../lib/acl');
const { BIB_FORMATS, parseBib } = require('../lib/bib-parse');
const { lookupDoi, lookupIsbn, normalizeDoi, normalizeIsbn } = require('../lib/source-lookup');
const { localIsoDate } = require('../lib/local-date');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });
// Import-Text ist eine hochgeladene Datei im JSON-Feld — eine Zotero-Bibliothek
// sprengt das CRUD-Limit muehelos. Eigener Parser mit eigenem Limit statt das
// CRUD-Limit fuer alle Routen anzuheben.
const importBody = express.json({ limit: '4mb' });

const Q_MAX = 200;
const IMPORT_MAX_CHARS = 2_000_000;
const IMPORT_MAX_ENTRIES = 500;

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

// ── Zitat-Kennzahlen eines Buchs ─────────────────────────────────────────────
// GET /sources/stats?book_id=
// Zitat-Anteil (woertlich uebernommene Zeichen gegen Manuskript-Zeichen) plus die
// Aufteilung der Nachweise in woertlich vs. Paraphrase. Reine Ableitung aus dem
// Fund-Index + page_stats, kein Scan ueber die Seiten-HTMLs.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'stats' ab.
router.get('/stats', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'viewer')) return;
  res.json(getBookQuoteStats(bookId));
});

// ── Import aus BibTeX/RIS ────────────────────────────────────────────────────
// POST /sources/import  Body: { book_id, format: 'bibtex'|'ris', text }
// Legt je Eintrag eine Quelle im Pool des Users an und ordnet sie dem Buch zu.
// Parser: lib/bib-parse.js (pure, kein Netz, kein KI-Call).
//
// Antwort: { total, imported, skipped, linked, errors: [{ index, error_code }] }
//   total     geparste Eintraege (Grundlage der `index`-Werte in `errors`)
//   imported  neu angelegte Quellen
//   skipped   Eintraege, die es in der Bibliothek schon gibt (Zitierschluessel
//             belegt) — davon `linked` neu diesem Buch zugeordnet
//   errors    Eintraege, die nicht importierbar waren
//
// EIN kaputter Eintrag bricht den Import NICHT ab: ein Fremd-Export ist entweder
// ganz oder gar nicht brauchbar, und ein Abbruch bei Eintrag 37 von 200 hinterlaesst
// einen halb gefuellten Pool, dessen Rest der User nicht nachladen kann, ohne die
// ersten 36 als Duplikate zu riskieren.
//
// Der Zitierschluessel ist in der BIBLIOTHEK eindeutig (UNIQUE(owner_email,
// citekey)), nicht pro Buch. Ein Treffer wird darum nicht dupliziert, sondern —
// falls noch nicht vorhanden — dem Zielbuch zugeordnet: dieselbe .bib zweimal in
// zwei Arbeiten importiert soll in der zweiten Arbeit die Quellen sichtbar machen,
// nicht 200 Zeilen „uebersprungen" melden.
//
// Eintraege OHNE Zitierschluessel (RIS-Exporte haben oft keinen) werden ueber
// Gattung + Titel + Jahr erkannt. Sonst wuerde derselbe Import zweimal
// ausgefuehrt die Bibliothek verdoppeln, und der einzige Weg zurueck waere
// Loeschen von Hand. Zwei Werke gleicher Gattung mit identischem Titel UND
// identischem Jahr in einer Bibliothek sind praktisch immer dasselbe Werk.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'import' ab.
router.post('/import', importBody, (req, res) => {
  const userEmail = _userEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const body = req.body || {};
  const bookId = toIntId(body.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!_guard(req, res, bookId, 'editor')) return;

  const format = String(body.format || '').toLowerCase();
  if (!BIB_FORMATS.includes(format)) {
    return res.status(400).json({ error_code: 'IMPORT_FORMAT_INVALID', params: { allowed: BIB_FORMATS.join(', ') } });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return res.status(400).json({ error_code: 'IMPORT_TEXT_REQUIRED' });
  if (text.length > IMPORT_MAX_CHARS) return res.status(400).json({ error_code: 'IMPORT_TOO_LARGE' });

  const parsed = parseBib(format, text);
  if (!parsed.length) return res.status(400).json({ error_code: 'IMPORT_EMPTY' });

  const errors = [];
  const entries = parsed.slice(0, IMPORT_MAX_ENTRIES);
  if (parsed.length > entries.length) {
    // Kein stiller Cap: der Rest wird als Fehler-Zeile gemeldet, damit die Karte
    // „Eintrag 500 und folgende nicht importiert" anzeigen kann.
    errors.push({ index: entries.length, error_code: 'IMPORT_TOO_MANY', params: { max: IMPORT_MAX_ENTRIES } });
  }

  const findByCitekey = db.prepare(
    'SELECT id FROM sources WHERE owner_email = ? AND citekey = ? LIMIT 1'
  );
  const findByTitle = db.prepare(`
    SELECT id FROM sources
     WHERE owner_email = ? AND csl_type = ?
       AND title IS NOT NULL AND LOWER(title) = LOWER(?)
       AND COALESCE(year, '') = COALESCE(?, '')
     LIMIT 1
  `);
  let imported = 0, skipped = 0, linked = 0;

  entries.forEach((entry, index) => {
    try {
      if (!_hasIdentity(entry)) { errors.push({ index, error_code: 'SOURCE_IDENTITY_REQ' }); return; }
      const existing = entry.citekey
        ? findByCitekey.get(userEmail, entry.citekey)
        : (entry.title ? findByTitle.get(userEmail, entry.csl_type, entry.title, entry.year) : null);
      if (existing) {
        skipped++;
        if (linkSource(bookId, existing.id, userEmail)) linked++;
        return;
      }
      const created = createSource(userEmail, entry);
      linkSource(bookId, created.id, userEmail);
      imported++;
    } catch (e) {
      // Wettlauf gegen einen parallelen Import derselben Datei: der UNIQUE-Index
      // ist die Wahrheit, die Vorab-Abfrage nur die Abkuerzung.
      if (/UNIQUE/i.test(e.message || '')) { skipped++; return; }
      logger.warn(`[quellen] import eintrag ${index} fehlgeschlagen: ${e.message}`);
      errors.push({ index, error_code: 'IMPORT_ENTRY_FAILED' });
    }
  });

  logger.info(
    `[quellen] import format=${format} book=${bookId} eintraege=${parsed.length} `
    + `neu=${imported} vorhanden=${skipped} (davon zugeordnet=${linked}) fehler=${errors.length}`
  );
  res.json({ total: parsed.length, imported, skipped, linked, errors });
});

// ── DOI-/ISBN-Lookup ─────────────────────────────────────────────────────────
// GET /sources/lookup?doi=…  bzw.  ?isbn=…
// Liefert einen Quellen-ENTWURF (nichts wird gespeichert) — der User bestaetigt
// ihn in der Quellen-Karte. Proxy gegen Crossref bzw. OpenLibrary; kein KI-Call,
// darum keine Job-Queue (Begruendung im Modulkopf von lib/source-lookup.js).
//
// Steht VOR /:id, sonst faengt der Id-Handler 'lookup' ab.
router.get('/lookup', async (req, res) => {
  const rawDoi = String(req.query.doi || '').trim();
  const rawIsbn = String(req.query.isbn || '').trim();
  if (!rawDoi && !rawIsbn) return res.status(400).json({ error_code: 'LOOKUP_PARAM_REQUIRED' });
  if (rawDoi && rawIsbn) return res.status(400).json({ error_code: 'LOOKUP_PARAM_AMBIGUOUS' });

  if (rawDoi && !normalizeDoi(rawDoi)) return res.status(400).json({ error_code: 'INVALID_DOI' });
  if (rawIsbn && !normalizeIsbn(rawIsbn)) return res.status(400).json({ error_code: 'INVALID_ISBN' });

  try {
    const draft = rawDoi ? await lookupDoi(rawDoi) : await lookupIsbn(rawIsbn);
    if (!draft) return res.status(404).json({ error_code: 'LOOKUP_NOT_FOUND' });
    res.json(draft);
  } catch (e) {
    // Der Fremd-Dienst ist nicht unser Ausfall — 502 statt 500, und der User kann
    // die Quelle jederzeit per Hand erfassen (non-fatal, wie beim Geocoding).
    logger.warn(`[quellen] lookup fehlgeschlagen (${rawDoi ? 'doi' : 'isbn'}): ${e.message}`);
    res.status(502).json({ error_code: e.code === 'LOOKUP_UNAVAILABLE' ? 'LOOKUP_UNAVAILABLE' : 'LOOKUP_FAILED' });
  }
});

// ── Recherche-Fundstueck → Quelle ────────────────────────────────────────────
// POST /sources/from-research  Body: { item_id }
// Uebernimmt ein Fundstueck des Recherche-Boards als Quellen-Entwurf in die
// Bibliothek und ordnet es dem Buch des Fundstuecks zu. Die Felder sind
// VORBELEGT, nicht fertig — der User schaerft sie danach in der Karte nach.
// Das Fundstueck bleibt unangetastet (es ist die Notiz, die Quelle ist der Nachweis).
//
// Bewusst nicht idempotent: derselbe Fund darf zweimal uebernommen werden (zwei
// Zitate aus derselben Seite mit unterschiedlichen Angaben). Damit ein
// versehentlicher Doppel-Klick nachvollziehbar bleibt, meldet das Log einen
// bereits vorhandenen Treffer mit gleicher URL/gleichem Titel.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'from-research' ab.
router.post('/from-research', jsonBody, (req, res) => {
  const userEmail = _userEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const itemId = toIntId(req.body?.item_id);
  if (!itemId) return res.status(400).json({ error_code: 'INVALID_ID' });

  const item = db.prepare(
    'SELECT id, book_id, kind, title, body, source FROM research_items WHERE id = ?'
  ).get(itemId);
  if (!item) return res.status(404).json({ error_code: 'RESEARCH_ITEM_NOT_FOUND' });
  if (!_guard(req, res, item.book_id, 'editor')) return;

  const firstUrl = db.prepare(
    'SELECT url FROM research_item_urls WHERE item_id = ? ORDER BY position, id LIMIT 1'
  ).get(itemId)?.url || null;

  const draft = {
    // Mit URL ist es ein Online-Nachweis, ohne URL bleibt die Gattung offen —
    // der User waehlt sie in der Karte. Nichts wird geraten.
    csl_type: firstUrl ? 'website' : 'other',
    title: item.title || null,
    url: firstUrl,
    note: item.source || null,
    // Abrufdatum ist bei einem Online-Nachweis Pflichtangabe und heute die
    // Wahrheit: der Fund wurde eben uebernommen. lib/local-date.js statt
    // toISOString(), damit das Datum der App-Zeitzone folgt.
    accessed_at: firstUrl ? localIsoDate() : null,
  };
  if (!_hasIdentity(draft)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  const dupe = db.prepare(`
    SELECT id FROM sources
     WHERE owner_email = ?
       AND ((? IS NOT NULL AND url = ?) OR (? IS NOT NULL AND title = ?))
     LIMIT 1
  `).get(userEmail, draft.url, draft.url, draft.title, draft.title);
  if (dupe) {
    logger.info(`[quellen] from-research doppelt? item=${itemId} aehnlich zu quelle id=${dupe.id}`);
  }

  const created = createSource(userEmail, draft);
  linkSource(item.book_id, created.id, userEmail);
  logger.info(`[quellen] from-research item=${itemId} book=${item.book_id} quelle=${created.id}`);
  res.json(getSource(created.id, item.book_id));
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
