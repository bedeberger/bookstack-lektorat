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
  findSourceByUrl, findImportDuplicate, findSimilarSource,
  linkSource, unlinkSource, isSourceLinked, listSourceBooks, getBookQuoteStats,
  listBookCitations, listSourceCitations,
} = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { BIB_FORMATS, parseBib } = require('../lib/bib-parse');
const { validateSourceBody, hasSourceIdentity } = require('../lib/source-validate');
const { normalizeUrl } = require('../lib/url-normalize');
const { lookupDoi, lookupIsbn, normalizeDoi, normalizeIsbn } = require('../lib/source-lookup');
const { localIsoDate } = require('../lib/local-date');
const { canRead, isOwner } = require('./sources-acl');
const sourcesDocRouter = require('./sources-doc');
const sourcesEvidenceRouter = require('./sources-evidence');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json({ limit: '256kb' });
// PDF-Anhang der Quelle: eigener Router unter demselben Mount (Upload/Download/
// Entfernen + Embed-Index-Trigger). Frueh eingehaengt, damit `/:id/doc` nicht
// erst hinter den CRUD-Routen liegt.
router.use('/', sourcesDocRouter);
// Belegvorschlag (`/evidence`): ebenfalls frueh, sonst faengt der `/:id`-Handler
// den Pfad als Id ab. Eigener Router aus demselben Grund wie der Dokument-Teil.
router.use('/', sourcesEvidenceRouter);
// Import-Text ist eine hochgeladene Datei im JSON-Feld — eine Zotero-Bibliothek
// sprengt das CRUD-Limit muehelos. Eigener Parser mit eigenem Limit statt das
// CRUD-Limit fuer alle Routen anzuheben.
const importBody = express.json({ limit: '4mb' });

const IMPORT_MAX_CHARS = 2_000_000;
const IMPORT_MAX_ENTRIES = 500;

// Die zwei Zugriffsachsen liegen in routes/sources-acl.js — der Dokument-Router
// (routes/sources-doc.js) braucht dieselbe Entscheidung, und eine kopierte
// ACL-Pruefung faellt nicht auf, wenn nur eine der Kopien nachgezogen wird.
// Feldpruefung + Identitaets-Minimum liegen aus demselben Grund in
// lib/source-validate.js: routes/capture.js muss durch dieselben Regeln gehen.
//
// Der Buch-Guard kommt aus lib/acl.js#guardBook.

// Typfilter der Listen-Endpunkte. Ein FREITEXTFILTER steht hier bewusst NICHT:
// die Suchfelder einer Quelle sind eine fachliche Entscheidung (zaehlt der
// Verlagsort? der Zitierschluessel?), und sie lag hier in einer dritten Kopie
// neben den beiden Frontend-Kopien — mit abweichender Feldliste. Die Liste ist
// klein genug, dass alle Konsumenten sie ohnehin vollstaendig laden und
// clientseitig ueber public/js/sources/search.js sieben.
function _applyTypeFilter(rows, query) {
  const type = String(query.type || '').trim();
  return CSL_TYPES.includes(type) ? rows.filter(r => r.csl_type === type) : rows;
}

// ── Bibliothek des Users ─────────────────────────────────────────────────────
// GET /sources/pool?archived=1&exclude_book_id=&type=
// Speist den „aus Bibliothek hinzufuegen"-Picker. Nur der eigene Pool — eine
// fremde Bibliothek ist nirgends sichtbar, auch nicht fuer Co-Autoren.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'pool' ab.
router.get('/pool', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  // Das Ausschlussbuch ist ein Anzeigefilter, kein Zugriffsargument — trotzdem
  // gegen die ACL gepruefen, damit die Route nicht verraet, welche Quellen in
  // einem fremden Buch liegen.
  const excludeBookId = toIntId(req.query.exclude_book_id);
  if (req.query.exclude_book_id && !excludeBookId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  if (excludeBookId && !guardBook(req, res, excludeBookId, 'viewer')) return;

  const rows = listPoolSources(email, {
    includeArchived: String(req.query.archived || '') === '1',
    excludeBookId: excludeBookId || null,
  });
  res.json(_applyTypeFilter(rows, req.query));
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
  if (!guardBook(req, res, bookId, 'viewer')) return;
  res.json(getBookQuoteStats(bookId));
});

// ── Fund-Index eines Buchs ───────────────────────────────────────────────────
// GET /sources/citations?book_id=
// Alle Fundstellen des Buchs flach, in Buch-Leserichtung (Seitenposition, dann
// Offset). Die Gegenrichtung zu /:id/citations („wo steht DIESE Quelle") und
// Grundlage des Quellen-Tabs im Referenz-Slot neben dem Notebook-Editor: welche
// Quellen sind auf dieser Seite bzw. in diesem Kapitel belegt.
//
// Bewusst OHNE Seiten-/Kapitelnamen: die kennt das Frontend aus dem Buchtree
// (`Alpine.store('nav').pages`), und ein JOIN waere hier ein zweiter Weg zum
// selben Namen. Ein Buch, ein Roundtrip — die Scope-Umschaltung des Slots
// (Seite/Kapitel/Buch) filtert danach clientseitig ohne Nachladen.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'citations' ab.
router.get('/citations', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  res.json(listBookCitations(bookId));
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
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const body = req.body || {};
  const bookId = toIntId(body.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'editor')) return;

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

  let imported = 0, skipped = 0, linked = 0;

  entries.forEach((entry, index) => {
    try {
      if (!hasSourceIdentity(entry)) { errors.push({ index, error_code: 'SOURCE_IDENTITY_REQ' }); return; }
      const existing = findImportDuplicate(email, entry);
      if (existing) {
        skipped++;
        if (linkSource(bookId, existing.id, email)) linked++;
        return;
      }
      const created = createSource(email, entry);
      linkSource(bookId, created.id, email);
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

// ── Dublettenpruefung nach URL ───────────────────────────────────────────────
// GET /sources/by-url?url=…&book_id=
// „Liegt dieses Dokument schon in meiner Bibliothek?" — die Frage, die die
// Browser-Erweiterung vor dem Erfassen stellt. Antwortet 404, wenn nicht.
//
// Nur der EIGENE Pool: eine fremde Bibliothek ist nirgends sichtbar, auch nicht
// als Ja/Nein-Auskunft. `book_id` ist optional und entscheidet nur, ob die
// Kennzahlen buch-skopiert kommen; `linked_to_book` sagt, ob die gefundene
// Quelle diesem Buch schon zugeordnet ist (dann ist nichts mehr zu tun).
//
// Steht VOR /:id, sonst faengt der Id-Handler 'by-url' ab.
router.get('/by-url', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const raw = String(req.query.url || '').trim();
  if (!raw) return res.status(400).json({ error_code: 'URL_REQ' });
  if (!normalizeUrl(raw)) return res.status(400).json({ error_code: 'INVALID_URL' });

  const bookId = req.query.book_id === undefined ? null : toIntId(req.query.book_id);
  if (req.query.book_id !== undefined && !bookId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  if (bookId && !guardBook(req, res, bookId, 'viewer')) return;

  const src = findSourceByUrl(email, raw, bookId);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  res.json({
    source: src,
    linked_to_book: bookId ? isSourceLinked(bookId, src.id) : null,
  });
});

// ── Recherche-Fundstueck → Quelle ────────────────────────────────────────────
// POST /sources/from-research  Body: { item_id, url_id? }
// Uebernimmt ein Fundstueck des Recherche-Boards als Quellen-Entwurf in die
// Bibliothek und ordnet es dem Buch des Fundstuecks zu. Die Felder sind
// VORBELEGT, nicht fertig — der User schaerft sie danach in der Karte nach.
// Das Fundstueck bleibt unangetastet (es ist die Notiz, die Quelle ist der Nachweis).
//
// `url_id` waehlt GEZIELT einen der Links des Fundstuecks: ein Fundstueck
// sammelt beliebig viele URLs (`research_item_urls`), und welche davon der
// Nachweis ist, weiss nur der User. Ohne Angabe bleibt es bei der ersten — das
// ist der Aufruf „ganzes Fundstueck uebernehmen".
//
// Bewusst nicht idempotent: derselbe Fund darf zweimal uebernommen werden (zwei
// Zitate aus derselben Seite mit unterschiedlichen Angaben). Damit ein
// versehentlicher Doppel-Klick nachvollziehbar bleibt, meldet das Log einen
// bereits vorhandenen Treffer mit gleicher URL/gleichem Titel.
//
// Steht VOR /:id, sonst faengt der Id-Handler 'from-research' ab.
router.post('/from-research', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const itemId = toIntId(req.body?.item_id);
  if (!itemId) return res.status(400).json({ error_code: 'INVALID_ID' });

  const item = db.prepare(
    'SELECT id, book_id, kind, title, body, source FROM research_items WHERE id = ?'
  ).get(itemId);
  if (!item) return res.status(404).json({ error_code: 'RESEARCH_ITEM_NOT_FOUND' });
  if (!guardBook(req, res, item.book_id, 'editor')) return;

  const rawUrlId = req.body?.url_id;
  const urlId = rawUrlId == null || rawUrlId === '' ? null : toIntId(rawUrlId);
  if (rawUrlId != null && rawUrlId !== '' && !urlId) return res.status(400).json({ error_code: 'INVALID_ID' });

  const urlRow = urlId
    ? db.prepare('SELECT url, label FROM research_item_urls WHERE id = ? AND item_id = ?').get(urlId, itemId)
    : db.prepare(
        'SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id LIMIT 1'
      ).get(itemId);
  // Ein `url_id`, das nicht zu diesem Fundstueck gehoert, ist ein Fehler und
  // KEIN stiller Rueckfall auf die erste URL — sonst landet der falsche Link
  // mit dem Anschein des gewaehlten in der Bibliothek.
  if (urlId && !urlRow) return res.status(404).json({ error_code: 'RESEARCH_URL_NOT_FOUND' });

  const firstUrl = urlRow?.url || null;

  const draft = {
    // Mit URL ist es ein Online-Nachweis, ohne URL bleibt die Gattung offen —
    // der User waehlt sie in der Karte. Nichts wird geraten.
    csl_type: firstUrl ? 'website' : 'other',
    // Der Titel des Fundstuecks benennt das Werk und hat Vorrang; das Link-Label
    // ist nur Fallback fuer ein unbenanntes Fundstueck (sonst scheitert die
    // Identitaets-Pruefung an einem Fund, der als Link durchaus benannt ist).
    // Nicht zusammengesetzt — geraten wird hier nichts.
    title: item.title || urlRow?.label || null,
    url: firstUrl,
    note: item.source || null,
    // Abrufdatum ist bei einem Online-Nachweis Pflichtangabe und heute die
    // Wahrheit: der Fund wurde eben uebernommen. lib/local-date.js statt
    // toISOString(), damit das Datum der App-Zeitzone folgt.
    accessed_at: firstUrl ? localIsoDate() : null,
  };
  if (!hasSourceIdentity(draft)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  const dupe = findSimilarSource(email, { url: draft.url, title: draft.title });
  if (dupe) {
    logger.info(`[quellen] from-research doppelt? item=${itemId} aehnlich zu quelle id=${dupe.id}`);
  }

  const created = createSource(email, draft);
  linkSource(item.book_id, created.id, email);
  logger.info(`[quellen] from-research item=${itemId} url=${urlId ?? 'erste'} book=${item.book_id} quelle=${created.id}`);
  res.json(getSource(created.id, item.book_id));
});

// ── Liste eines Buchs ────────────────────────────────────────────────────────
// GET /sources?book_id=&archived=1&type=book
router.get('/', (req, res) => {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  const rows = listSources(bookId, { includeArchived: String(req.query.archived || '') === '1' });
  res.json(_applyTypeFilter(rows, req.query));
});

// ── Einzelne Quelle ──────────────────────────────────────────────────────────
// Optionales `book_id` waehlt die Kennzahl-Sicht (buch-skopiert statt Pool).
router.get('/:id', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const bookId = toIntId(req.query.book_id);
  const src = getSource(id, bookId || null);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (!canRead(req, src)) return res.status(403).json({ error_code: 'NO_BOOK_ACCESS' });
  res.json(src);
});

// ── Fundstellen einer Quelle ─────────────────────────────────────────────────
// Namen kommen per JOIN zur Lesezeit (keine Snapshot-Spalten im Index).
// `book_id` grenzt auf ein Buch ein — die Quellen-Karte ist buchweit, und die
// Fundstellen aus einer anderen Arbeit gehoeren dort nicht in die Liste.
//
// OHNE `book_id` ist die Antwort buch-UEBERGREIFEND und darum nur fuer den
// Besitzer der Quelle. `canRead` reicht hier NICHT: es laesst jeden durch, der
// auf IRGENDEINEM verknuepften Buch Viewer ist — ein Mitarbeiter am geteilten
// Blog bekaeme damit Seiten- und Kapitelnamen aus der privaten Dissertation,
// sobald dort dieselbe Quelle haengt. Gleiche Begruendung und gleiche Schranke
// wie bei GET /:id/books darunter.
router.get('/:id/citations', (req, res) => {
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const src = getSource(id);
  if (!src) return res.status(404).json({ error_code: 'NOT_FOUND' });

  const bookId = toIntId(req.query.book_id);
  if (bookId) {
    if (!guardBook(req, res, bookId, 'viewer')) return;
  } else if (!isOwner(req, src)) {
    return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });
  }

  res.json(listSourceCitations(id, bookId || null));
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
  if (!isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });
  res.json(listSourceBooks(id));
});

// ── Anlegen ──────────────────────────────────────────────────────────────────
// POST /sources  Body: { book_id?, csl_type?, title?, authors?, … }
// Legt im Pool des Users an. `book_id` ordnet gleich zu — der Normalfall aus der
// Quellen-Karte heraus. Ohne `book_id` entsteht ein reiner Bibliothekseintrag.
router.post('/', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const body = req.body || {};
  const bookId = body.book_id === undefined || body.book_id === null
    ? null
    : toIntId(body.book_id);
  if (body.book_id !== undefined && body.book_id !== null && !bookId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  if (bookId && !guardBook(req, res, bookId, 'editor')) return;

  const bad = validateSourceBody(body);
  if (bad) return res.status(400).json(bad);
  if (!hasSourceIdentity(body)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

  try {
    const created = createSource(email, body);
    if (bookId) linkSource(bookId, created.id, email);
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
  if (!isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const body = req.body || {};
  const bad = validateSourceBody(body);
  if (bad) return res.status(400).json(bad);
  if (!hasSourceIdentity({ ...src, ...body })) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });

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
  if (!guardBook(req, res, bookId, 'editor')) return;
  if (!isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const added = linkSource(bookId, id, sessionEmail(req));
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
  if (!guardBook(req, res, bookId, 'editor')) return;
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
  if (!isOwner(req, src)) return res.status(403).json({ error_code: 'NOT_SOURCE_OWNER' });

  const books = listSourceBooks(id).length;
  deleteSource(id);
  logger.info(`[quellen] delete id=${id} buecher=${books} fundstellen=${src.cite_pages}`);
  res.json({ ok: true, orphaned_citations: src.cite_pages, affected_books: books });
});

module.exports = router;
