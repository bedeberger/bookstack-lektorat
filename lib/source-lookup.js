'use strict';
// DOI-/ISBN-Lookup fuer die Quellen-Erfassung: fragt Crossref (DOI) bzw.
// OpenLibrary (ISBN) und liefert einen Quellen-ENTWURF in `sources`-Form.
// Gespeichert wird nichts — der User bestaetigt den Entwurf in der Quellen-Karte.
//
// KEIN KI-Call → normale Route statt Job-Queue, dieselbe Begruendung wie beim
// Geocoding-Proxy (lib/geocode.js / routes/geocode.js): die Job-Queue existiert,
// um Modell-Aufrufe zu serialisieren, ihre Token-Kosten zu buchen und lange
// Laeufe pollbar zu machen. Ein Metadaten-Lookup ist ein einzelner Fremd-Request
// von unter einer Sekunde, ohne Modell, ohne Token, ohne Mutex-Bedarf — als Job
// verpackt waere er langsamer als synchron und wuerde die Queue-Statistik mit
// Nicht-KI-Zeilen verwaessern.
//
// SSRF-Hygiene: die beiden Hosts sind Konstanten in diesem Modul. Der User-Input
// (DOI bzw. ISBN) wird validiert, normalisiert und ausschliesslich URL-encodiert
// in Pfad/Query genau dieser Hosts eingesetzt. Es gibt keinen Parameter, der eine
// URL, einen Host oder ein Schema durchreicht — auch keinen fuer eine
// self-hosted Instanz, denn beide Dienste sind oeffentliche Register.

const { parsePersonName } = require('./bib-parse');
const logger = require('../logger');

const CROSSREF_BASE = 'https://api.crossref.org/works/';
const OPENLIBRARY_BASE = 'https://openlibrary.org/api/books';
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = process.env.SOURCE_LOOKUP_USER_AGENT
  || 'Schreibwerkstatt/1.0 (self-hosted book tool)';

/** Netz-/Timeout-/Protokollfehler. Traegt `code` fuer die Route (→ 502). */
class LookupUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LookupUnavailableError';
    this.code = 'LOOKUP_UNAVAILABLE';
  }
}

/**
 * DOI normalisieren: akzeptiert `10.1000/xyz`, `doi:10.1000/xyz` und
 * `https://doi.org/10.1000/xyz`. null, wenn es kein DOI ist.
 */
function normalizeDoi(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  if (s.length > 200) return null;
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
}

/**
 * ISBN normalisieren: Bindestriche/Leerzeichen weg, `x` → `X`. Akzeptiert
 * ISBN-10 und ISBN-13 nach Form (keine Pruefsummen-Rechnung — eine falsche
 * Pruefsumme endet ohnehin als „nicht gefunden"). null, wenn es keine ISBN ist.
 */
function normalizeIsbn(raw) {
  const s = String(raw ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!s) return null;
  if (/^\d{9}[\dX]$/.test(s)) return s;
  if (/^\d{13}$/.test(s)) return s;
  return null;
}

async function _fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    // 404 ist eine gueltige Antwort („kein Treffer"), kein Ausfall.
    if (r.status === 404) return null;
    if (!r.ok) throw new LookupUnavailableError(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e instanceof LookupUnavailableError) throw e;
    throw new LookupUnavailableError(e?.name === 'AbortError' ? 'Timeout' : (e?.message || 'Netzwerkfehler'));
  } finally {
    clearTimeout(timer);
  }
}

// Leerer Entwurf mit allen Spalten, damit jeder Mapper dieselbe Form liefert und
// die Karte kein Feld „fehlt" statt „leer" sieht.
function _draft(csl_type) {
  return {
    csl_type, citekey: null, authors: [], editors: [],
    title: null, container_title: null, publisher: null, place: null, year: null,
    edition: null, volume: null, issue: null, pages: null,
    doi: null, isbn: null, issn: null, url: null, accessed_at: null, note: null,
  };
}

function _str(v, max = 500) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function _first(v) {
  return Array.isArray(v) ? v.find(x => x != null && String(x).trim() !== '') ?? null : v;
}

// OpenLibrary liefert Verlage/Orte je nach Endpunkt als `[{name}]` oder als
// blosse Strings — beides auf den Namen bringen, ohne `[object Object]` zu riskieren.
function _named(v) {
  const first = _first(v);
  if (first && typeof first === 'object') return _str(first.name);
  return _str(first);
}

// Crossref-Personen: `{family, given}` oder `{name}` fuer Koerperschaften.
function _crossrefPersons(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr.slice(0, 50)) {
    const family = _str(p?.family, 200);
    const given = _str(p?.given, 200);
    if (family) { out.push(given ? { family, given } : { family }); continue; }
    const literal = _str(p?.name, 200);
    if (literal) out.push({ literal });
  }
  return out;
}

// Crossref-Werktyp → `csl_type` (nur Werte aus db/sources.js#CSL_TYPES).
const CROSSREF_TYPES = {
  'journal-article': 'article',
  'journal-issue': 'article',
  'journal-volume': 'article',
  'journal': 'article',
  'book': 'book',
  'monograph': 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'proceedings': 'book',
  'book-chapter': 'chapter',
  'book-part': 'chapter',
  'book-section': 'chapter',
  'proceedings-article': 'chapter',
  'dissertation': 'thesis',
  'report': 'report',
  'report-component': 'report',
  'standard': 'report',
  'dataset': 'dataset',
  'database': 'dataset',
};

/** Crossref-`message`-Objekt → Quellen-Entwurf. Pure → ohne Netz testbar. */
function mapCrossrefWork(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const d = _draft(CROSSREF_TYPES[String(msg.type || '').toLowerCase()] || 'other');
  d.title = _str(_first(msg.title));
  d.container_title = _str(_first(msg['container-title']));
  d.publisher = _str(msg.publisher);
  d.place = _str(msg['publisher-location']);
  d.authors = _crossrefPersons(msg.author);
  d.editors = _crossrefPersons(msg.editor);
  const dateParts = msg.issued?.['date-parts']?.[0]
    || msg['published-print']?.['date-parts']?.[0]
    || msg['published-online']?.['date-parts']?.[0]
    || msg.created?.['date-parts']?.[0];
  const year = Array.isArray(dateParts) ? dateParts[0] : null;
  d.year = Number.isInteger(year) ? String(year) : null;
  d.edition = _str(msg['edition-number']);
  d.volume = _str(msg.volume);
  d.issue = _str(msg.issue);
  d.pages = _str(msg.page);
  d.doi = _str(msg.DOI, 200);
  d.isbn = _str(_first(msg.ISBN), 40);
  d.issn = _str(_first(msg.ISSN), 40);
  d.url = _str(msg.URL, 500);
  if (!d.title && !d.authors.length && !d.editors.length) return null;
  return d;
}

/** OpenLibrary-`jscmd=data`-Objekt → Quellen-Entwurf. Pure → ohne Netz testbar. */
function mapOpenLibraryBook(data, isbn = null) {
  if (!data || typeof data !== 'object') return null;
  const d = _draft('book');
  const title = _str(data.title, 400);
  const subtitle = _str(data.subtitle, 400);
  d.title = title && subtitle ? `${title}: ${subtitle}`.slice(0, 500) : title;
  // OpenLibrary schreibt Personen als „Vorname Nachname" — dieselbe Aufteilung
  // wie beim BibTeX-Import, damit nicht zwei Heuristiken nebeneinander stehen.
  d.authors = (Array.isArray(data.authors) ? data.authors.slice(0, 50) : [])
    .map(a => parsePersonName(_str(a?.name, 200), { natural: true }))
    .filter(Boolean);
  d.publisher = _named(data.publishers);
  d.place = _named(data.publish_places);
  const year = /\b(1[0-9]{3}|2[0-9]{3})\b/.exec(String(data.publish_date || ''));
  d.year = year ? year[1] : null;
  d.isbn = isbn ? _str(isbn, 40) : _str(_first(data.identifiers?.isbn_13) || _first(data.identifiers?.isbn_10), 40);
  if (!d.title && !d.authors.length) return null;
  return d;
}

/**
 * DOI bei Crossref auflösen.
 * @returns {Promise<object|null>} Entwurf oder null (kein Treffer).
 * @throws {LookupUnavailableError} Netz-/Timeout-/Protokollfehler.
 */
async function lookupDoi(doi) {
  const clean = normalizeDoi(doi);
  if (!clean) return null;
  const json = await _fetchJson(`${CROSSREF_BASE}${encodeURIComponent(clean)}`);
  if (!json) return null;
  const draft = mapCrossrefWork(json.message);
  if (!draft) return null;
  // Der angefragte DOI ist verlaesslicher als ein fehlendes Feld in der Antwort.
  if (!draft.doi) draft.doi = clean;
  logger.info(`[quellen] doi-lookup ok doi=${clean} typ=${draft.csl_type}`);
  return draft;
}

/**
 * ISBN bei OpenLibrary auflösen.
 * @returns {Promise<object|null>} Entwurf oder null (kein Treffer).
 * @throws {LookupUnavailableError} Netz-/Timeout-/Protokollfehler.
 */
async function lookupIsbn(isbn) {
  const clean = normalizeIsbn(isbn);
  if (!clean) return null;
  const params = new URLSearchParams({ bibkeys: `ISBN:${clean}`, format: 'json', jscmd: 'data' });
  const json = await _fetchJson(`${OPENLIBRARY_BASE}?${params.toString()}`);
  // OpenLibrary antwortet auf einen unbekannten Schluessel mit `{}` statt 404.
  const data = json ? json[`ISBN:${clean}`] : null;
  if (!data) return null;
  const draft = mapOpenLibraryBook(data, clean);
  if (!draft) return null;
  logger.info(`[quellen] isbn-lookup ok isbn=${clean}`);
  return draft;
}

module.exports = {
  LookupUnavailableError,
  CROSSREF_TYPES,
  normalizeDoi, normalizeIsbn,
  mapCrossrefWork, mapOpenLibraryBook,
  lookupDoi, lookupIsbn,
};
