'use strict';
// BibTeX-/RIS-Parser fuer den Quellen-Import. REINE Funktionen: kein KI-Call,
// kein Netz, kein DB-Zugriff. Eingabe ist Text, Ausgabe sind Quellen-Entwuerfe
// in `sources`-Form — dieselben Feldnamen wie db/sources.js#TEXT_FIELDS plus
// `csl_type`/`authors`/`editors`. Was daraus angelegt wird, entscheidet der
// Aufrufer (routes/sources.js); dieses Modul speichert nichts.
//
// Warum ein eigener Parser statt einer Lib: die beiden Formate interessieren
// hier nur so weit, wie Zotero/Citavi/EndNote/JabRef sie tatsaechlich schreiben,
// und das Ergebnis muss exakt auf unsere elf `csl_type`-Werte und die
// Spalten von `sources` fallen. Eine generische BibTeX-Lib liefert AST-Knoten,
// die vollstaendig umgeschrieben werden muessten — die Mapping-Tabellen sind der
// eigentliche Inhalt, das Tokenizing ist der kleine Teil.
//
// Robustheit vor Strenge: ein Eintrag, den der Parser nicht versteht, wird
// uebersprungen, nicht als Fehler des ganzen Imports behandelt. Fremd-Exporte
// sind chronisch unsauber (fehlende Felder, Zeilenumbrueche mitten im Wert, BOM,
// CRLF, `@string`-Makros, `and others`) — der Import soll trotzdem das liefern,
// was lesbar war.

// ── LaTeX-Dekodierung ────────────────────────────────────────────────────────
// BibTeX-Werte tragen Umlaute und Sonderzeichen als Makros (`\"a`, `{\ss}`) und
// schuetzen Gross-Schreibung mit Klammern (`{DNA}`). Beides muss weg, bevor der
// Text in einer Spalte landet — sonst steht `M{\"u}ller` im Quellenverzeichnis.

const ACCENTS = {
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', n: 'ǹ', y: 'ỳ', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', C: 'Ć', N: 'Ń', S: 'Ś', Z: 'Ź' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', Y: 'Ÿ' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū', A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' },
  '.': { c: 'ċ', e: 'ė', z: 'ż', C: 'Ċ', E: 'Ė', Z: 'Ż' },
  c: { c: 'ç', s: 'ş', t: 'ţ', C: 'Ç', S: 'Ş', T: 'Ţ' },                                     // Cedille
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', n: 'ň', d: 'ď', t: 'ť', C: 'Č', S: 'Š', Z: 'Ž', R: 'Ř', E: 'Ě', N: 'Ň' }, // Hacek
  u: { a: 'ă', g: 'ğ', A: 'Ă', G: 'Ğ' },                                                     // Breve
  r: { a: 'å', u: 'ů', A: 'Å', U: 'Ů' },                                                     // Ring
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },                                                     // Doppelakut
  k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },                                                     // Ogonek
};

// Eigenstaendige Zeichen-Makros. Reihenfolge zaehlt (`\oe` vor `\o`), der
// Negative-Lookahead verhindert zusaetzlich, dass `\o` in `\oe` trifft.
const LATEX_SYMBOLS = [
  ['ss', 'ß'], ['AE', 'Æ'], ['ae', 'æ'], ['OE', 'Œ'], ['oe', 'œ'],
  ['AA', 'Å'], ['aa', 'å'], ['O', 'Ø'], ['o', 'ø'], ['L', 'Ł'], ['l', 'ł'],
  ['DH', 'Ð'], ['dh', 'ð'], ['TH', 'Þ'], ['th', 'þ'], ['i', 'ı'], ['j', 'ȷ'],
  ['textendash', '–'], ['textemdash', '—'], ['dots', '…'], ['ldots', '…'],
];

const _ACCENT_SYMBOLS = '`\'"^~=.';
const _ACCENT_LETTERS = 'cvurHk';
const _RE_ACCENT_BRACED = new RegExp(`\\\\([${_ACCENT_SYMBOLS}]|[${_ACCENT_LETTERS}])\\s*\\{\\s*([a-zA-Z])\\s*\\}`, 'g');
const _RE_ACCENT_BARE = new RegExp(`\\\\([${_ACCENT_SYMBOLS}])\\s*([a-zA-Z])`, 'g');
const _RE_ACCENT_SPACED = new RegExp(`\\\\([${_ACCENT_LETTERS}])\\s+([a-zA-Z])`, 'g');

function _applyAccent(cmd, letter) {
  return ACCENTS[cmd]?.[letter] ?? letter;
}

/**
 * LaTeX-Notation → Klartext. Loest Akzent-Makros und Zeichen-Makros auf, macht
 * escapte Interpunktion sichtbar (`\&` → `&`), wirft unbekannte Makros weg
 * (`\emph{Titel}` → `Titel`), entfernt Schutz-Klammern und normalisiert
 * Whitespace. Fuer URL/DOI/ISBN NICHT verwenden — dort wuerde `~`/`--`/`_`
 * den Wert veraendern; dafuer ist `plainValue` zustaendig.
 */
function decodeLatex(raw) {
  let s = String(raw ?? '');
  if (!s) return '';
  for (const [name, ch] of LATEX_SYMBOLS) {
    s = s.replace(new RegExp(`\\\\${name}(?![a-zA-Z])`, 'g'), ch);
  }
  s = s.replace(_RE_ACCENT_BRACED, (_, c, l) => _applyAccent(c, l));
  s = s.replace(_RE_ACCENT_BARE, (_, c, l) => _applyAccent(c, l));
  s = s.replace(_RE_ACCENT_SPACED, (_, c, l) => _applyAccent(c, l));
  s = s.replace(/\\([&%$#_{}])/g, '$1');
  s = s.replace(/---/g, '—').replace(/--/g, '–');
  s = s.replace(/\\\\/g, ' ').replace(/~/g, ' ');
  s = s.replace(/\\[a-zA-Z]+\s*/g, '');   // uebrige Makros: Name weg, Argument bleibt
  s = s.replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Wert ohne LaTeX-Interpretation: nur Klammern weg + Whitespace normalisiert.
 *  Fuer Felder, in denen `~`, `--` und `_` bedeutungstragend sind (URL, DOI). */
function plainValue(raw) {
  const s = String(raw ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

function _text(raw) {
  const s = decodeLatex(raw);
  return s || null;
}

// Erste plausible Jahreszahl. `date = {2020-03-12}`, `PY = 2020/// `, `[2019]`
// und `2018a` liefern alle das Jahr; `n.d.` liefert null.
function _year(raw) {
  const m = /\b(1[0-9]{3}|2[0-9]{3})\b/.exec(String(raw ?? ''));
  return m ? m[1] : null;
}

// http(s)-URL aus einem Feldwert ziehen. Deckt `\url{…}` und `howpublished`-
// Werte mit Fliesstext ab; alles ohne http(s) ergibt null (kein `mailto:`,
// kein `file:` — der Wert landet spaeter in einem :href-Binding).
function _url(raw) {
  const s = String(raw ?? '').replace(/\\url\s*\{([^}]*)\}/g, '$1');
  const m = /https?:\/\/[^\s{}"\\,]+/i.exec(s.replace(/[{}]/g, ''));
  return m ? m[0].replace(/[.,;)]+$/, '') : null;
}

// RIS-Datumsangaben (`2020/03/12/`, `2020///`) → ISO-nahe Kurzform. Freitext
// bleibt Freitext: `accessed_at` ist eine Anzeige-Spalte, kein Datumstyp.
function _risDate(raw) {
  const s = plainValue(raw);
  if (!s) return null;
  const m = /^(\d{4})(?:\/(\d{1,2}))?(?:\/(\d{1,2}))?/.exec(s);
  if (!m) return s;
  const parts = [m[1]];
  if (m[2]) parts.push(String(m[2]).padStart(2, '0'));
  if (m[3]) parts.push(String(m[3]).padStart(2, '0'));
  return parts.join('-');
}

// ── Personen ─────────────────────────────────────────────────────────────────

/** Wahr, wenn der String EINE umschliessende Klammergruppe ist (`{Amt fuer X}`).
 *  BibTeX behandelt so etwas als atomaren Namen — genau unser `literal`-Fall. */
function _isSingleGroup(s) {
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return depth === 0;
}

const _LOWER_FIRST = /^[a-zà-öø-ÿ]/;

/**
 * Ein Personen-Token → `{family, given}` | `{literal}` | `null`.
 *
 * Drei Formen, in dieser Reihenfolge:
 *   1. Eine umschliessende Klammergruppe → Koerperschaft (`{literal}`).
 *   2. Komma-Form „Nachname, Vorname" → `{family, given}`. Das ist die Form,
 *      die BibTeX und RIS beide als kanonisch schreiben.
 *   3. Nur bei `natural: true` (BibTeX): „Vorname Nachname". BibTeX definiert
 *      diese Reihenfolge als Teil seiner Namens-Grammatik (First-von-Last),
 *      inklusive der Regel, dass klein geschriebene Partikel zum Nachnamen
 *      gehoeren („Ludwig van Beethoven" → family „van Beethoven").
 *      RIS kennt die Form nicht — dort ist ein Wert ohne Komma fast immer eine
 *      Koerperschaft, also `literal`. Diesselbe Zurueckhaltung wie in
 *      db/sources.js#normalizePersons, wo ein blosser String immer `literal` wird.
 */
function parsePersonName(raw, { natural = false } = {}) {
  const token = String(raw ?? '').trim();
  if (!token) return null;
  if (_isSingleGroup(token)) {
    const literal = decodeLatex(token.slice(1, -1));
    return literal ? { literal } : null;
  }

  const plain = decodeLatex(token);
  if (!plain) return null;

  const parts = plain.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    // Suffixe („King, Jr., Martin Luther") haben in `sources` keine eigene
    // Spalte — sie wandern in den Vornamen, statt verloren zu gehen.
    const family = parts[0];
    const given = parts.slice(1).join(' ');
    return given ? { family, given } : { family };
  }

  if (!natural) return { literal: plain };

  const words = plain.split(/\s+/);
  if (words.length === 1) return { family: words[0] };
  let split = words.length - 1;
  for (let k = 1; k < words.length - 1; k++) {
    if (_LOWER_FIRST.test(words[k])) { split = k; break; }
  }
  return { family: words.slice(split).join(' '), given: words.slice(0, split).join(' ') };
}

// `Autor A and Autor B` am Top-Level trennen (ein `and` in einer Klammergruppe
// gehoert zum Namen: `{Meier and Sons}`).
function _splitAnd(raw) {
  const s = String(raw ?? '');
  const parts = [];
  let depth = 0, start = 0, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && /\s/.test(ch)) {
      const m = /^\s+and\s+/i.exec(s.slice(i));
      if (m) { parts.push(s.slice(start, i)); i += m[0].length; start = i; continue; }
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

const MAX_PERSONS = 50;   // Spiegel zu db/sources.js — dort wird ohnehin gekappt

/** BibTeX-Personenfeld (`author`/`editor`) → CSL-Array. */
function parseBibPersons(raw) {
  if (!raw) return [];
  const out = [];
  for (const token of _splitAnd(raw)) {
    if (/^(others|et\.? al\.?)$/i.test(token)) continue;   // BibTeX-Kuerzel fuer „u.a."
    const p = parsePersonName(token, { natural: true });
    if (p) out.push(p);
    if (out.length >= MAX_PERSONS) break;
  }
  return out;
}

/** RIS-Personenzeilen (je Zeile eine Person) → CSL-Array. */
function parseRisPersons(lines) {
  const out = [];
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const token = String(line ?? '').trim().replace(/,\s*$/, '');
    if (!token || /^(others|et\.? al\.?)$/i.test(token)) continue;
    const p = parsePersonName(token, { natural: false });
    if (p) out.push(p);
    if (out.length >= MAX_PERSONS) break;
  }
  return out;
}

// ── BibTeX ───────────────────────────────────────────────────────────────────

// Eintragstyp → `csl_type`. Nur Werte aus db/sources.js#CSL_TYPES sind erlaubt;
// alles Unbekannte faellt auf 'other' (gegated durch tests/unit/bib-parse.test.mjs).
const BIBTEX_TYPES = {
  book: 'book', mvbook: 'book', booklet: 'book', collection: 'book',
  mvcollection: 'book', proceedings: 'book', mvproceedings: 'book', periodical: 'book',
  article: 'article', suppperiodical: 'article',
  incollection: 'chapter', inbook: 'chapter', bookinbook: 'chapter', suppbook: 'chapter',
  inproceedings: 'chapter', conference: 'chapter', inreference: 'chapter',
  phdthesis: 'thesis', mastersthesis: 'thesis', thesis: 'thesis',
  techreport: 'report', report: 'report', manual: 'report', standard: 'report',
  online: 'website', electronic: 'website', www: 'website',
  dataset: 'dataset',
  movie: 'film', video: 'film', audio: 'film', music: 'film',
  jurisdiction: 'legal', legislation: 'legal', legal: 'legal',
  misc: 'other', unpublished: 'other', software: 'other',
};

// Eintragstypen, die selbst kein Werk sind (`@string`, `@preamble`, `@comment`).
const BIBTEX_META_TYPES = new Set(['string', 'preamble', 'comment']);

/** BOM weg, Zeilenenden auf `\n` (CRLF und CR-only). */
function _prepare(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// Index der schliessenden Klammer des Eintrags. Klammer-Tiefe zaehlt; ein
// Wert in Anfuehrungszeichen wird uebersprungen, damit ein `{` darin nicht
// zaehlt.
function _findEntryEnd(src, from, close) {
  let depth = 0, inQuote = false;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (inQuote) { if (ch === '"') inQuote = false; continue; }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      if (depth === 0) { if (close === '}') return i; continue; }
      depth--;
      continue;
    }
    if (ch === close && depth === 0) return i;
  }
  return src.length;
}

// Auf `sep` trennen, aber nur am Top-Level (Klammer-Tiefe 0, nicht in "…").
function _splitTop(str, sep) {
  const parts = [];
  let depth = 0, inQuote = false, start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (inQuote) { if (ch === '"') inQuote = false; continue; }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { parts.push(str.slice(start, i)); start = i + 1; }
  }
  parts.push(str.slice(start));
  return parts;
}

// Rohen Feldwert entpacken: `{…}`, `"…"`, blosses Token (Zahl oder unaufgeloestes
// `@string`-Makro) und `#`-Konkatenation.
function _unwrapValue(raw) {
  return _splitTop(String(raw ?? '').trim(), '#').map((chunk) => {
    const s = chunk.trim();
    if (s.length >= 2 && s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1);
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  }).join('');
}

function _pick(fields, ...names) {
  for (const n of names) {
    const v = fields[n];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function _bibEntry(type, body) {
  const chunks = _splitTop(body, ',');
  const citekey = plainValue(chunks.shift() || '');
  const fields = {};
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const name = chunk.slice(0, eq).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_:+-]*$/.test(name)) continue;
    const value = _unwrapValue(chunk.slice(eq + 1));
    if (value.trim() === '') continue;
    fields[name] = value;
  }

  const csl = BIBTEX_TYPES[type] || 'other';
  // Uebergeordnetes Werk je Gattung: bei Aufsaetzen die Zeitschrift, bei
  // Beitraegen der Sammelband. `series` bleibt bewusst aussen vor — als
  // container_title wuerde eine Buchreihe im Verzeichnis wie ein Sammelband
  // erscheinen, in dem das Buch enthalten waere.
  const container = csl === 'article'
    ? _pick(fields, 'journal', 'journaltitle', 'shortjournal', 'booktitle')
    : _pick(fields, 'booktitle', 'maintitle', 'journal', 'journaltitle');

  return {
    csl_type: csl,
    citekey: citekey || null,
    authors: parseBibPersons(_pick(fields, 'author')),
    editors: parseBibPersons(_pick(fields, 'editor')),
    title: _text(_pick(fields, 'title')),
    container_title: _text(container),
    publisher: _text(_pick(fields, 'publisher', 'school', 'institution', 'organization')),
    place: _text(_pick(fields, 'address', 'location')),
    year: _year(_pick(fields, 'year', 'date', 'issued')),
    edition: _text(_pick(fields, 'edition')),
    volume: _text(_pick(fields, 'volume')),
    issue: _text(_pick(fields, 'number', 'issue')),
    pages: _text(_pick(fields, 'pages')),
    doi: plainValue(_pick(fields, 'doi')),
    isbn: plainValue(_pick(fields, 'isbn')),
    issn: plainValue(_pick(fields, 'issn')),
    url: _url(_pick(fields, 'url', 'howpublished')),
    accessed_at: _text(_pick(fields, 'urldate', 'accessed', 'lastaccessed')),
    note: _text(_pick(fields, 'note', 'annote')),
  };
}

/**
 * BibTeX-Text → Array von Quellen-Entwuerfen. Nicht interpretierbare Eintraege
 * werden uebersprungen; `@string`/`@preamble`/`@comment` ebenso.
 */
function parseBibtex(text) {
  const src = _prepare(text);
  const out = [];
  const re = /@([a-zA-Z]+)[ \t\n]*([{(])/g;
  let m;
  while ((m = re.exec(src))) {
    const type = m[1].toLowerCase();
    const close = m[2] === '{' ? '}' : ')';
    const bodyStart = m.index + m[0].length;
    const bodyEnd = _findEntryEnd(src, bodyStart, close);
    re.lastIndex = Math.min(src.length, bodyEnd + 1);
    if (BIBTEX_META_TYPES.has(type)) continue;
    const entry = _bibEntry(type, src.slice(bodyStart, bodyEnd));
    if (entry) out.push(entry);
  }
  return out;
}

// ── RIS ──────────────────────────────────────────────────────────────────────

// TY-Code → `csl_type`. Deckt die Codes ab, die Zotero/EndNote/Citavi ausgeben.
const RIS_TYPES = {
  BOOK: 'book', EBOOK: 'book', EDBOOK: 'book', SER: 'book',
  CHAP: 'chapter', ECHAP: 'chapter', CONF: 'chapter', CPAPER: 'chapter',
  JOUR: 'article', EJOUR: 'article', JFULL: 'article', ABST: 'article',
  NEWS: 'article', MGZN: 'article',
  ELEC: 'website', WEB: 'website', ICOMM: 'website', BLOG: 'website',
  THES: 'thesis',
  RPRT: 'report', GOVDOC: 'report', STAND: 'report',
  STAT: 'legal', CASE: 'legal', BILL: 'legal', LEGAL: 'legal', HEAR: 'legal',
  MPCT: 'film', VIDEO: 'film', SOUND: 'film', MUSIC: 'film', ADVS: 'film',
  DATA: 'dataset', DBASE: 'dataset',
  GEN: 'other', UNPB: 'other', COMP: 'other', PAT: 'other',
};

// Tags, die mehrfach vorkommen duerfen (je Zeile eine Person/ein Schlagwort).
const RIS_MULTI = new Set(['AU', 'A1', 'A2', 'A3', 'A4', 'ED', 'KW', 'UR', 'N1']);
const _RE_RIS_TAG = /^([A-Z][A-Z0-9]) {1,2}-\s?(.*)$/;

function _risRecord(f) {
  const ty = String(f.TY?.[0] || '').trim().toUpperCase();
  const csl = RIS_TYPES[ty] || 'other';
  const one = (...tags) => {
    for (const t of tags) {
      const v = f[t]?.[0];
      if (v != null && String(v).trim() !== '') return v;
    }
    return null;
  };
  const many = (...tags) => tags.flatMap(t => f[t] || []);

  // Bei einem Beitrag ist `BT`/`T2` der Sammelband, bei einer Monographie ist
  // `BT` der Titel selbst — dieselbe Zeile bedeutet je Gattung etwas anderes.
  const isContribution = csl === 'chapter';
  const title = one('TI', 'T1', ...(isContribution ? [] : ['BT', 'CT']));
  const container = isContribution
    ? one('T2', 'BT', 'JF', 'JO')
    : (csl === 'article' ? one('JO', 'JF', 'J2', 'T2') : one('JF', 'JO'));

  const sp = plainValue(one('SP'));
  const ep = plainValue(one('EP'));
  const pages = sp && ep && !sp.includes('-') ? `${sp}-${ep}` : (sp || ep);

  // RIS kennt nur `SN` fuer beide Nummern — die ISSN-Form entscheidet.
  const sn = plainValue(one('SN'));
  const isIssn = !!sn && /^\d{4}-?\d{3}[\dxX]$/.test(sn.replace(/\s/g, ''));

  // `ID` ist bei Zotero oft eine laufende Nummer — als Zitierschluessel
  // unbrauchbar und ein Kollisions-Magnet. Nur woertliche Schluessel uebernehmen.
  const rawId = plainValue(one('ID'));
  const citekey = rawId && /[a-zA-Z]/.test(rawId) && !/\s/.test(rawId) ? rawId : null;

  return {
    csl_type: csl,
    citekey,
    authors: parseRisPersons(many('AU', 'A1')),
    editors: parseRisPersons(many('ED', 'A2')),
    title: _text(title),
    container_title: _text(container),
    publisher: _text(one('PB')),
    place: _text(one('CY', 'PP')),
    year: _year(one('PY', 'Y1', 'DA')),
    edition: _text(one('ET')),
    volume: _text(one('VL')),
    issue: _text(one('IS')),
    pages: pages || null,
    doi: plainValue(one('DO')),
    isbn: isIssn ? null : sn,
    issn: isIssn ? sn : null,
    url: _url(one('UR', 'L1')),
    accessed_at: _risDate(one('Y2')),
    note: _text(one('N1', 'AB')),
  };
}

/**
 * RIS-Text → Array von Quellen-Entwuerfen. `TY` beginnt einen Datensatz, `ER`
 * schliesst ihn; eine Zeile ohne Tag ist Fortsetzung des vorigen Werts
 * (Zeilenumbrueche mitten im Titel sind in RIS-Exporten die Regel).
 */
function parseRis(text) {
  const out = [];
  let cur = null;
  let lastTag = null;

  const flush = () => {
    if (cur && Object.keys(cur).length) out.push(_risRecord(cur));
    cur = null;
    lastTag = null;
  };

  for (const line of _prepare(text).split('\n')) {
    const m = _RE_RIS_TAG.exec(line.replace(/\s+$/, ''));
    if (!m) {
      const cont = line.trim();
      if (cur && lastTag && cont) {
        const arr = cur[lastTag];
        arr[arr.length - 1] = `${arr[arr.length - 1]} ${cont}`.trim();
      }
      continue;
    }
    const [, tag, value] = m;
    if (tag === 'TY') { flush(); cur = { TY: [value.trim()] }; lastTag = 'TY'; continue; }
    if (tag === 'ER') { flush(); continue; }
    if (!cur) cur = {};                       // Datensatz ohne TY: trotzdem lesen
    if (!cur[tag]) cur[tag] = [value];
    else if (RIS_MULTI.has(tag)) cur[tag].push(value);
    // Einwertiger Tag doppelt: der erste Wert gewinnt (sonst gewinnt bei
    // EndNote-Exporten eine Wiederholung am Dateiende).
    lastTag = tag;
  }
  flush();
  return out;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

const BIB_FORMATS = ['bibtex', 'ris'];

/** `format` ('bibtex'|'ris') + Text → Quellen-Entwuerfe. Unbekanntes Format → []. */
function parseBib(format, text) {
  if (format === 'bibtex') return parseBibtex(text);
  if (format === 'ris') return parseRis(text);
  return [];
}

module.exports = {
  BIB_FORMATS, BIBTEX_TYPES, RIS_TYPES,
  parseBib, parseBibtex, parseRis,
  parsePersonName, parseBibPersons, parseRisPersons,
  decodeLatex, plainValue,
};
