// BibTeX-/RIS-Parser (lib/bib-parse.js) gegen echte Export-Dateien.
//
// Gefahren, die die Fixtures abdecken — genau die, an denen ein handgeschriebener
// Parser gegen Fremd-Exporte scheitert:
//   - mehrere Eintraege in einer Datei, jeder mit anderen Feldern
//   - fehlende Felder (kein Titel, keine Person → der Aufrufer muss ablehnen)
//   - Zeilenumbrueche MITTEN im Wert (BibTeX-Klammerwert, RIS-Fortsetzungszeile)
//   - BOM + CRLF (endnote-export.ris ist genau so geschrieben)
//   - LaTeX-Akzente, Schutz-Klammern, Koerperschaft in doppelten Klammern
//   - `and others`, `@string`-Makro, Wert in Anfuehrungszeichen, Wert ohne Klammern
//
// Zusaetzlich gegated: jeder `csl_type`, den eine der Mapping-Tabellen ausgeben
// kann, existiert in db/sources.js#CSL_TYPES — sonst schreibt der Import
// stillschweigend 'book' (der Fallback in _values).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBib, parseBibtex, parseRis, parsePersonName, decodeLatex,
  BIBTEX_TYPES, RIS_TYPES, BIB_FORMATS,
} = require('../../lib/bib-parse.js');
const { CSL_TYPES } = require('../../db/sources.js');

const FIX = (name) => readFileSync(
  fileURLToPath(new URL(`../fixtures/bib/${name}`, import.meta.url)), 'utf8'
);

const BIBTEX = FIX('zotero-export.bib');
const RIS = FIX('endnote-export.ris');

const byKey = (entries) => Object.fromEntries(entries.map(e => [e.citekey, e]));

// ── Mapping-Tabellen ─────────────────────────────────────────────────────────

test('jeder gemappte csl_type existiert in CSL_TYPES', () => {
  for (const [src, table] of [['BIBTEX_TYPES', BIBTEX_TYPES], ['RIS_TYPES', RIS_TYPES]]) {
    for (const [key, csl] of Object.entries(table)) {
      assert.ok(CSL_TYPES.includes(csl), `${src}.${key} → '${csl}' ist kein CSL_TYPES-Wert`);
    }
  }
});

test('unbekannter Eintragstyp faellt auf other', () => {
  const [e] = parseBibtex('@quatschtyp{x, title = {Titel}}');
  assert.equal(e.csl_type, 'other');
});

// ── LaTeX ────────────────────────────────────────────────────────────────────

test('decodeLatex loest Akzente, Ligaturen und Schutzklammern auf', () => {
  assert.equal(decodeLatex('M{\\"u}ller'), 'Müller');
  assert.equal(decodeLatex('M\\"uller'), 'Müller');
  assert.equal(decodeLatex('Wei{\\ss}'), 'Weiß');
  assert.equal(decodeLatex('Andr\\\'e'), 'André');
  assert.equal(decodeLatex('{\\c{c}}edille'), 'çedille');
  assert.equal(decodeLatex('Dvo{\\v{r}}{\\\'a}k'), 'Dvořák');
  assert.equal(decodeLatex('{DNA}-Analyse'), 'DNA-Analyse');
  assert.equal(decodeLatex('Meyer \\& S{\\"o}hne'), 'Meyer & Söhne');
  assert.equal(decodeLatex('112--131'), '112–131');
  assert.equal(decodeLatex('\\emph{Kursiv}'), 'Kursiv');
  assert.equal(decodeLatex('Zeile\n   umbruch   im  Wert'), 'Zeile umbruch im Wert');
});

// ── Personen ─────────────────────────────────────────────────────────────────

test('Komma-Form wird zu family/given', () => {
  assert.deepEqual(parsePersonName('Müller, Hans'), { family: 'Müller', given: 'Hans' });
  assert.deepEqual(parsePersonName('Müller'), { literal: 'Müller' });
  assert.deepEqual(parsePersonName('Müller', { natural: true }), { family: 'Müller' });
});

test('Koerperschaft in Klammern wird literal', () => {
  assert.deepEqual(parsePersonName('{Bundesamt f{\\"u}r Statistik}'), { literal: 'Bundesamt für Statistik' });
  // Ohne Klammern und ohne Komma: BibTeX-Reihenfolge nur bei natural:true,
  // RIS (natural:false) behandelt es als Koerperschaft.
  assert.deepEqual(parsePersonName('Bundesamt für Kultur'), { literal: 'Bundesamt für Kultur' });
});

test('natural order respektiert klein geschriebene Namenspartikel', () => {
  assert.deepEqual(
    parsePersonName('Ludwig van Beethoven', { natural: true }),
    { family: 'van Beethoven', given: 'Ludwig' }
  );
  assert.deepEqual(
    parsePersonName('Hans Peter Müller', { natural: true }),
    { family: 'Müller', given: 'Hans Peter' }
  );
});

test('Suffix geht nicht verloren', () => {
  assert.deepEqual(
    parsePersonName('King, Jr., Martin Luther'),
    { family: 'King', given: 'Jr. Martin Luther' }
  );
});

// ── BibTeX ───────────────────────────────────────────────────────────────────

test('BibTeX: alle Eintraege der Datei werden gelesen, @string nicht', () => {
  const entries = parseBibtex(BIBTEX);
  assert.equal(entries.length, 7);
  assert.deepEqual(
    entries.map(e => e.citekey),
    ['kafka1915', 'mueller2020', 'beethoven2019', 'bfs2024', 'weiss2018', 'ohnetitel', 'oecd2021']
  );
});

test('BibTeX: Buch mit vollen Feldern', () => {
  const e = byKey(parseBibtex(BIBTEX)).kafka1915;
  assert.equal(e.csl_type, 'book');
  assert.equal(e.title, 'Die Verwandlung');
  assert.deepEqual(e.authors, [{ family: 'Kafka', given: 'Franz' }]);
  assert.equal(e.year, '1915');
  assert.equal(e.publisher, 'Kurt Wolff Verlag');
  assert.equal(e.place, 'Leipzig');
  assert.equal(e.edition, '1');
  assert.equal(e.isbn, '978-3-15-009900-2');
  assert.equal(e.container_title, null);
});

test('BibTeX: Aufsatz — Zeilenumbruch im Titel, Akzente, "and others", number→issue', () => {
  const e = byKey(parseBibtex(BIBTEX)).mueller2020;
  assert.equal(e.csl_type, 'article');
  assert.equal(e.title, 'Zur DNA-Sequenzierung in der forensischen Praxis');
  assert.deepEqual(e.authors, [
    { family: 'Müller', given: 'Hans-Peter' },
    { family: 'Weber', given: 'Anna' },
  ]);
  assert.equal(e.container_title, 'Zeitschrift für Rechtsmedizin');
  assert.equal(e.volume, '44');
  assert.equal(e.issue, '3');
  assert.equal(e.pages, '112–131');
  assert.equal(e.doi, '10.1007/s00194-020-00412-8');
  assert.equal(e.issn, '0044-3433');
});

test('BibTeX: Beitrag — booktitle wird container, Herausgeber getrennt, date→year', () => {
  const e = byKey(parseBibtex(BIBTEX)).beethoven2019;
  assert.equal(e.csl_type, 'chapter');
  assert.equal(e.title, 'Briefe an die ferne Geliebte');
  assert.equal(e.container_title, 'Quellen zur Musikgeschichte');
  assert.deepEqual(e.authors, [{ family: 'van Beethoven', given: 'Ludwig' }]);
  assert.deepEqual(e.editors, [
    { family: 'Schmid', given: 'Elke' },
    { family: 'von Arnim', given: 'Bettina' },
  ]);
  assert.equal(e.year, '2019');
  assert.equal(e.pages, '88-104');
  // Unaufgeloestes @string-Makro: der Name bleibt stehen statt den Wert zu leeren.
  assert.equal(e.publisher, 'springer');
});

test('BibTeX: @online → website, Koerperschaft, urldate', () => {
  const e = byKey(parseBibtex(BIBTEX)).bfs2024;
  assert.equal(e.csl_type, 'website');
  assert.deepEqual(e.authors, [{ literal: 'Bundesamt für Statistik' }]);
  assert.equal(e.title, 'Ständige Wohnbevölkerung nach Kanton');
  assert.equal(e.url, 'https://www.bfs.admin.ch/bfs/de/home.html');
  assert.equal(e.accessed_at, '2024-11-03');
});

test('BibTeX: Werte in Anfuehrungszeichen und ohne Klammern', () => {
  const e = byKey(parseBibtex(BIBTEX)).weiss2018;
  assert.equal(e.csl_type, 'thesis');
  assert.deepEqual(e.authors, [{ family: 'Weiß', given: 'Katharina' }]);
  assert.equal(e.title, 'Erzählstimmen im Spätwerk');
  assert.equal(e.publisher, 'Universität Zürich');   // school → publisher
  assert.equal(e.year, '2018');                      // year = 2018 ohne Klammern
});

test('BibTeX: fehlende Felder ergeben null, kein Absturz', () => {
  const e = byKey(parseBibtex(BIBTEX)).ohnetitel;
  assert.equal(e.title, null);
  assert.deepEqual(e.authors, []);
  assert.deepEqual(e.editors, []);
  assert.equal(e.year, null);
  assert.ok(e.note);
});

test('BibTeX: techreport → report, institution → publisher, DOI-URL bleibt URL', () => {
  const e = byKey(parseBibtex(BIBTEX)).oecd2021;
  assert.equal(e.csl_type, 'report');
  assert.equal(e.publisher, 'OECD Publishing');
  assert.deepEqual(e.authors, [{ literal: 'OECD' }]);
  assert.equal(e.issue, '2021/4');
  assert.equal(e.url, 'https://doi.org/10.1787/b35a14e5-en');
});

test('BibTeX: BOM und CRLF aendern das Ergebnis nicht', () => {
  const plain = parseBibtex(BIBTEX);
  const crlf = parseBibtex('﻿' + BIBTEX.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlf, plain);
});

test('BibTeX: Runde Klammern als Eintragsbegrenzer', () => {
  const [e] = parseBibtex('@book(paren1, title = {Mit runden Klammern}, year = {2001})');
  assert.equal(e.citekey, 'paren1');
  assert.equal(e.title, 'Mit runden Klammern');
  assert.equal(e.year, '2001');
});

test('BibTeX: nicht-http-URL wird verworfen', () => {
  const [e] = parseBibtex('@misc{x, title = {T}, url = {ftp://example.org/datei}}');
  assert.equal(e.url, null);
});

test('BibTeX: leerer und wirrer Text ergibt keine Eintraege', () => {
  assert.deepEqual(parseBibtex(''), []);
  assert.deepEqual(parseBibtex('nur Prosa, kein Eintrag'), []);
  assert.deepEqual(parseBibtex(null), []);
});

test('BibTeX: unbalancierte Klammer beendet die Datei statt zu haengen', () => {
  const entries = parseBibtex('@book{a, title = {Erster}}\n@book{b, title = {Offen');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'Erster');
  assert.equal(entries[1].title, 'Offen');
});

// ── RIS ──────────────────────────────────────────────────────────────────────

test('RIS: alle Datensaetze der BOM+CRLF-Datei werden gelesen', () => {
  const entries = parseRis(RIS);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(e => e.csl_type), ['article', 'book', 'chapter', 'website', 'other']);
});

test('RIS: Aufsatz — Fortsetzungszeile, SP/EP, SN als ISSN, Y2 als Abrufdatum', () => {
  const e = parseRis(RIS)[0];
  assert.equal(e.title, 'Narrative Ambiguität in der Gegenwartsprosa: eine korpusgestützte Annäherung');
  assert.deepEqual(e.authors, [
    { family: 'Berger', given: 'David' },
    { family: 'Kübler', given: 'Marie-Louise' },
  ]);
  assert.deepEqual(e.editors, [{ family: 'Hofmann', given: 'Ruth' }]);
  assert.equal(e.container_title, 'Deutsche Vierteljahrsschrift für Literaturwissenschaft');
  assert.equal(e.volume, '97');
  assert.equal(e.issue, '2');
  assert.equal(e.pages, '201-228');
  assert.equal(e.year, '2023');
  assert.equal(e.doi, '10.1007/s41245-023-00188-2');
  assert.equal(e.issn, '0012-0936');
  assert.equal(e.isbn, null);
  assert.equal(e.accessed_at, '2024-11-03');
  assert.equal(e.citekey, 'berger2023');
});

test('RIS: Monographie — BT ist der Titel, SN ist die ISBN', () => {
  const e = parseRis(RIS)[1];
  assert.equal(e.csl_type, 'book');
  assert.equal(e.title, 'Handbuch Erzählanalyse');
  assert.equal(e.container_title, null);
  assert.equal(e.publisher, 'Metzler');
  assert.equal(e.place, 'Stuttgart');
  assert.equal(e.edition, '3');
  assert.equal(e.isbn, '9783476026123');
  assert.equal(e.issn, null);
});

test('RIS: Beitrag — T2 ist der Sammelband, Koerperschaft ohne Komma bleibt literal', () => {
  const e = parseRis(RIS)[2];
  assert.equal(e.csl_type, 'chapter');
  assert.equal(e.title, 'Fokalisierung und Distanz');
  assert.equal(e.container_title, 'Handbuch Erzählanalyse');
  assert.deepEqual(e.authors, [{ literal: 'Bundesamt für Kultur' }]);
  assert.deepEqual(e.editors, [{ family: 'Schulze', given: 'Gerd' }]);
  assert.equal(e.pages, '45-63');
});

test('RIS: ELEC → website, rein numerische ID ist kein Zitierschluessel', () => {
  const e = parseRis(RIS)[3];
  assert.equal(e.csl_type, 'website');
  assert.equal(e.url, 'https://www.example.ch/leitfaden');
  assert.equal(e.accessed_at, '2025-01-17');
  assert.equal(e.citekey, null);
});

test('RIS: Datensatz ohne Titel und Person liefert leere Felder', () => {
  const e = parseRis(RIS)[4];
  assert.equal(e.title, null);
  assert.deepEqual(e.authors, []);
  assert.ok(e.note);
});

test('RIS: fehlendes ER am Dateiende verliert den letzten Datensatz nicht', () => {
  const entries = parseRis('TY  - BOOK\nTI  - Erster\nER  - \nTY  - BOOK\nTI  - Ohne Ende\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].title, 'Ohne Ende');
});

test('RIS: LF ohne BOM aendert das Ergebnis nicht', () => {
  const stripped = RIS.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  assert.deepEqual(parseRis(stripped), parseRis(RIS));
});

test('RIS: leerer Text ergibt keine Datensaetze', () => {
  assert.deepEqual(parseRis(''), []);
  assert.deepEqual(parseRis('irgendwas ohne Tags'), []);
});

// ── Dispatcher ───────────────────────────────────────────────────────────────

test('parseBib waehlt nach Format und verwirft Unbekanntes', () => {
  assert.deepEqual(BIB_FORMATS, ['bibtex', 'ris']);
  assert.equal(parseBib('bibtex', BIBTEX).length, 7);
  assert.equal(parseBib('ris', RIS).length, 5);
  assert.deepEqual(parseBib('endnote-xml', BIBTEX), []);
});

// Der Import legt die Entwuerfe ueber db/sources.js#createSource an — dessen
// Normalisierung erwartet genau diese Feldform.
test('Entwurf traegt alle Spalten von sources und nur CSL-Personenformen', () => {
  const expected = [
    'csl_type', 'citekey', 'authors', 'editors', 'title', 'container_title',
    'publisher', 'place', 'year', 'edition', 'volume', 'issue', 'pages',
    'doi', 'isbn', 'issn', 'url', 'accessed_at', 'note',
  ].sort();
  for (const entry of [...parseBibtex(BIBTEX), ...parseRis(RIS)]) {
    assert.deepEqual(Object.keys(entry).sort(), expected);
    for (const p of [...entry.authors, ...entry.editors]) {
      const keys = Object.keys(p).sort().join(',');
      assert.ok(['family', 'family,given', 'literal'].includes(keys), `Personenform '${keys}'`);
    }
  }
});
