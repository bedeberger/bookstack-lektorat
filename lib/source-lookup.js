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
const CROSSREF_SEARCH = 'https://api.crossref.org/works';
const OPENLIBRARY_BASE = 'https://openlibrary.org/api/books';
const OPENLIBRARY_SEARCH = 'https://openlibrary.org/search.json';
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

// ── Bibliografische Suche ────────────────────────────────────────────────────
// Gegenstueck zum ID-Lookup: hier gibt es keine Kennung, nur einen Titel und
// vielleicht einen Namen — so, wie ein Werk in einem Fliesstext erwaehnt wird
// (Job `source-detect`). Das macht die Suche unsicher, und die ganze Sorgfalt
// dieses Abschnitts liegt darum im ABLEHNEN: ein danebengegriffener Treffer
// waere schlimmer als gar keiner, weil er falsche Metadaten mit dem Anschein
// von Registerdaten in die Bibliothek traegt.
//
// Der Schwellenwert steht bewusst hoch und die Regel ist bewusst dumm
// (Token-Ueberlappung, kein Fuzzy-Matching): ein knapper Treffer wird verworfen
// und die Quelle bleibt als unbestaetigter Entwurf stehen — genau das, was der
// Autor dann von Hand prueft.

const SEARCH_ROWS = 5;
// Anteil der Tokens des kuerzeren Titels, der im laengeren vorkommen muss.
const TITLE_MIN_SIM = 0.6;
// Ohne Autoren-Treffer reicht das nicht — dann muss der Titel praktisch stehen.
const TITLE_SOLO_SIM = 0.85;
// Auflagen und Nachdrucke verschieben das Jahr; mehr als das ist ein anderes Werk.
const YEAR_TOLERANCE = 2;

// Fuellwoerter fliegen raus, sonst hebt „die/der/and/of" die Ueberlappung
// kurzer Titel kuenstlich an.
const TITLE_STOPWORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'von', 'vom', 'zu', 'zur', 'zum', 'im', 'in', 'am', 'an', 'auf', 'fuer', 'mit',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
]);

/** Titel → Token-Set: Diakritika weg, alles klein, Satzzeichen zu Leerraum,
 *  Fuellwoerter raus. Pure → ohne Netz testbar. */
function titleTokens(raw) {
  const s = String(raw ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Das scharfe S ueberlebt die NFD-Zerlegung (es ist kein Buchstabe mit
    // Akzent) und wuerde danach als Satzzeichen ein Wort zerreissen: aus
    // "Prozess" mit scharfem S wuerde sonst das Token "proze".
    .replace(/\u00df/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!s) return new Set();
  return new Set(s.split(' ').filter(t => t.length > 1 && !TITLE_STOPWORDS.has(t)));
}

/**
 * Aehnlichkeit zweier Titel als Anteil des KUERZEREN Titels, der im laengeren
 * steckt (Containment, nicht Jaccard): „Die Struktur wissenschaftlicher
 * Revolutionen" und „Die Struktur wissenschaftlicher Revolutionen. Mit einem
 * Postskriptum" sind dasselbe Werk, und ein Untertitel darf das nicht kippen.
 *
 * Weil Containment kurze Titel ueberbewertet („Faust" steckt in „Faust und die
 * Welt"), liefert die Funktion die Zahl der gemeinsamen Tokens mit — der
 * Aufrufer verlangt zusaetzlich mindestens zwei davon.
 *
 * @returns {{ sim: number, shared: number }}
 */
function titleMatch(a, b) {
  const ta = titleTokens(a), tb = titleTokens(b);
  if (!ta.size || !tb.size) return { sim: 0, shared: 0 };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return { sim: shared / Math.min(ta.size, tb.size), shared };
}

/** Nachnamen aus Personen in `sources`-Form ODER aus Klarnamen-Strings. */
function _familyNames(persons) {
  const out = new Set();
  for (const p of Array.isArray(persons) ? persons : []) {
    let family = null;
    if (typeof p === 'string') family = parsePersonName(p, { natural: true })?.family || null;
    else if (p && typeof p === 'object') family = p.family || p.literal || null;
    const norm = String(family ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z]+/g, '');
    if (norm.length > 1) out.add(norm);
  }
  return out;
}

/**
 * Passt ein Registertreffer zum gesuchten Werk? Pure → ohne Netz testbar.
 *
 * DIE REGEL IN EINEM SATZ: der kuerzere Titel muss zu mindestens
 * TITLE_MIN_SIM im laengeren stecken und das Jahr darf nicht davonlaufen;
 * traegt der Titel nur EIN inhaltliches Wort („Faust", „Der Prozess"), kann er
 * die Entscheidung nicht allein tragen und ein Nachname muss uebereinstimmen;
 * bei laengeren Titeln ersetzt eine Fast-Deckung (TITLE_SOLO_SIM) den fehlenden
 * Autoren-Treffer.
 *
 * @returns {{ ok: boolean, sim: number, authorHit: boolean }}
 */
function acceptMatch(candidate, hit) {
  const { sim, shared } = titleMatch(candidate?.title, hit?.title);
  const minTokens = Math.min(titleTokens(candidate?.title).size, titleTokens(hit?.title).size);
  const wantFam = _familyNames(candidate?.authors);
  const gotFam = _familyNames(hit?.authors);
  let authorHit = false;
  for (const f of wantFam) if (gotFam.has(f)) { authorHit = true; break; }

  const yA = parseInt(candidate?.year, 10), yB = parseInt(hit?.year, 10);
  const yearOk = !Number.isInteger(yA) || !Number.isInteger(yB)
    || Math.abs(yA - yB) <= YEAR_TOLERANCE;

  const titleOk = sim >= TITLE_MIN_SIM && yearOk;
  const ok = titleOk && (minTokens >= 2
    ? (shared >= 2 && (authorHit || sim >= TITLE_SOLO_SIM))
    : (shared >= 1 && authorHit));
  return { ok, sim, authorHit };
}

/** OpenLibrary-`search.json`-Doc → Quellen-Entwurf. Pure → ohne Netz testbar. */
function mapOpenLibrarySearchDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const d = _draft('book');
  const title = _str(doc.title, 400);
  const subtitle = _str(doc.subtitle, 400);
  d.title = title && subtitle ? `${title}: ${subtitle}`.slice(0, 500) : title;
  d.authors = (Array.isArray(doc.author_name) ? doc.author_name.slice(0, 50) : [])
    .map(n => parsePersonName(_str(n, 200), { natural: true }))
    .filter(Boolean);
  d.publisher = _named(doc.publisher);
  d.place = _named(doc.place);
  d.year = Number.isInteger(doc.first_publish_year) ? String(doc.first_publish_year) : null;
  d.isbn = _str(_first(doc.isbn), 40);
  if (!d.title && !d.authors.length) return null;
  return d;
}

const CROSSREF_SELECT = [
  'DOI', 'title', 'author', 'editor', 'issued', 'container-title', 'publisher',
  'publisher-location', 'type', 'ISBN', 'ISSN', 'page', 'volume', 'issue', 'URL', 'edition-number',
].join(',');

/** Freitext-Suche bei Crossref (Aufsaetze, Berichte, alles mit DOI). */
async function _searchCrossref(candidate) {
  const q = [candidate.title, ...(candidate.authors || []).map(a => (typeof a === 'string' ? a : a?.family))]
    .filter(Boolean).join(' ').slice(0, 300);
  if (!q) return [];
  const params = new URLSearchParams({
    'query.bibliographic': q,
    rows: String(SEARCH_ROWS),
    select: CROSSREF_SELECT,
  });
  const json = await _fetchJson(`${CROSSREF_SEARCH}?${params.toString()}`);
  const items = json?.message?.items;
  return (Array.isArray(items) ? items : []).map(mapCrossrefWork).filter(Boolean);
}

/** Freitext-Suche bei OpenLibrary (Buecher). */
async function _searchOpenLibrary(candidate) {
  const params = new URLSearchParams({
    limit: String(SEARCH_ROWS),
    fields: 'title,subtitle,author_name,first_publish_year,publisher,place,isbn',
  });
  if (candidate.title) params.set('title', String(candidate.title).slice(0, 300));
  const authorStr = (candidate.authors || [])
    .map(a => (typeof a === 'string' ? a : [a?.given, a?.family].filter(Boolean).join(' ')))
    .filter(Boolean).join(' ').slice(0, 200);
  if (authorStr) params.set('author', authorStr);
  if (!params.has('title') && !params.has('author')) return [];
  const json = await _fetchJson(`${OPENLIBRARY_SEARCH}?${params.toString()}`);
  const docs = json?.docs;
  return (Array.isArray(docs) ? docs : []).map(mapOpenLibrarySearchDoc).filter(Boolean);
}

// Welches Register zuerst? Nach Werktyp — und danach einmal das andere, weil
// Buecher auch bei Crossref und Aufsaetze gelegentlich bei OpenLibrary liegen.
// Mehr als zwei Fremd-Requests pro Kandidat gibt es nicht.
const BOOKISH = new Set(['book', 'chapter', 'thesis', 'other', 'film']);

/**
 * Ein im Text erwaehntes Werk in den Registern suchen und, wenn der Treffer die
 * Pruefung besteht, als angereicherten Entwurf zurueckgeben.
 *
 * @param {object} candidate `{ title, authors, year, csl_type }` — was der Text hergibt.
 * @returns {Promise<{draft: object, sim: number, authorHit: boolean, register: string}|null>}
 *          null = kein belastbarer Treffer (der Aufrufer behaelt seinen Entwurf).
 * @throws  {LookupUnavailableError} Netz-/Timeout-/Protokollfehler.
 */
async function searchWork(candidate) {
  if (!candidate?.title || !String(candidate.title).trim()) return null;
  const order = BOOKISH.has(candidate.csl_type)
    ? [['openlibrary', _searchOpenLibrary], ['crossref', _searchCrossref]]
    : [['crossref', _searchCrossref], ['openlibrary', _searchOpenLibrary]];

  for (const [register, search] of order) {
    let hits = [];
    try {
      hits = await search(candidate);
    } catch (e) {
      // Ein ausgefallenes Register darf das andere nicht mitreissen.
      logger.warn(`[quellen] werk-suche ${register} fehlgeschlagen: ${e.message}`);
      continue;
    }
    let best = null;
    for (const hit of hits) {
      const verdict = acceptMatch(candidate, hit);
      if (!verdict.ok) continue;
      if (!best || verdict.sim > best.sim) best = { draft: hit, sim: verdict.sim, authorHit: verdict.authorHit, register };
    }
    if (best) return best;
  }
  return null;
}

module.exports = {
  LookupUnavailableError,
  CROSSREF_TYPES,
  normalizeDoi, normalizeIsbn,
  mapCrossrefWork, mapOpenLibraryBook, mapOpenLibrarySearchDoc,
  lookupDoi, lookupIsbn,
  titleTokens, titleMatch, acceptMatch, searchWork,
};
