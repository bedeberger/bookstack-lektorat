// Zitierstil-Formatter (public/js/sources/format.js).
//
// Der Formatter ist SSoT fuer jeden Ausgabeweg des Quellenverzeichnisses und
// fuer den Kurzbeleg-Chip im Seiten-HTML — hier entscheidet sich die
// inhaltliche Korrektheit, nicht im Renderer. Geprueft werden darum:
// Stilregeln je Satzfamilie, die Personen-Schwellen der drei Stile, die
// Punktuations-Kollaps-Regeln (die naiv verkettet garantiert brechen),
// HTML-Escaping, Sortierung/Nummernvergabe und die Enum-Deckung gegen DB-Schicht
// und Migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CITATION_STYLES, DEFAULT_STYLE,
  formatFull, formatFullHtml, formatFullRuns, formatShort,
  sortEntries, assignNumbers, assignYearSuffixes, sortKeyOf, labelsFor,
} from '../../public/js/sources/format.js';
import {
  initialsOf, personInverted, personNormal, familyOf,
  apaAuthorList, chicagoAuthorList, numericAuthorList,
} from '../../public/js/sources/format/persons.js';
import { enDashRange, pageLabel, locatorUrl } from '../../public/js/sources/format/runs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Kurzform-Helfer: nur die Felder setzen, die der jeweilige Test braucht.
function src(over = {}) {
  return {
    id: 1, csl_type: 'book', authors: [], editors: [],
    title: null, container_title: null, publisher: null, place: null,
    year: null, edition: null, volume: null, issue: null, pages: null,
    doi: null, url: null, accessed_at: null,
    ...over,
  };
}

const KAFKA = src({
  authors: [{ family: 'Kafka', given: 'Franz' }],
  title: 'Die Verwandlung', year: '1915', place: 'Leipzig', publisher: 'Kurt Wolff',
});

// ── Enum-Deckung (Drift-Gate) ────────────────────────────────────────────────

test('CITATION_STYLES deckt VALID_CITATION_STYLES der DB-Schicht', () => {
  const schema = readFileSync(resolve(ROOT, 'db', 'schema.js'), 'utf8');
  const m = /VALID_CITATION_STYLES\s*=\s*\[([^\]]+)\]/.exec(schema);
  assert.ok(m, 'VALID_CITATION_STYLES in db/schema.js nicht gefunden');
  const dbStyles = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  // Laufen die auseinander, formatiert der Renderer stumm im Default-Stil,
  // waehrend die DB einen Stil speichert, den der Formatter nicht kennt.
  assert.deepEqual([...CITATION_STYLES].sort(), [...dbStyles].sort());
});

test('DEFAULT_STYLE entspricht dem Spalten-Default der Migration', () => {
  const mig = readFileSync(resolve(ROOT, 'db', 'migrations.js'), 'utf8');
  const m = /citation_style\s+TEXT\s+DEFAULT\s+'([^']+)'/.exec(mig);
  assert.ok(m, 'Spalten-Default fuer citation_style nicht gefunden');
  assert.equal(DEFAULT_STYLE, m[1]);
});

test('unbekannter Stil und unbekannte Sprache fallen auf die Defaults zurueck', () => {
  assert.equal(formatFull(KAFKA, { style: 'bibtex' }), formatFull(KAFKA, { style: DEFAULT_STYLE }));
  assert.equal(formatFull(KAFKA, { lang: 'fr' }), formatFull(KAFKA, { lang: 'de' }));
  assert.equal(labelsFor('fr').lang, 'de');
  assert.equal(formatFull(null), '');
  assert.deepEqual(formatFullRuns(null), []);
});

// ── Namen ────────────────────────────────────────────────────────────────────

test('initialsOf: mehrteilige und gekoppelte Vornamen', () => {
  assert.equal(initialsOf('Franz'), 'F.');
  assert.equal(initialsOf('Franz Xaver'), 'F. X.');
  assert.equal(initialsOf('Hans-Peter'), 'H.-P.');
  assert.equal(initialsOf('Theodor W.'), 'T. W.');
  assert.equal(initialsOf(''), '');
});

test('Koerperschaften (literal) werden in jeder Position unveraendert uebernommen', () => {
  const p = { literal: 'Bundesamt fuer Statistik' };
  assert.equal(personInverted(p), 'Bundesamt fuer Statistik');
  assert.equal(personNormal(p, { initials: true }), 'Bundesamt fuer Statistik');
  assert.equal(familyOf(p), 'Bundesamt fuer Statistik');
  // Auch der blosse String ist erlaubt (Import-Pfade liefern das).
  assert.equal(familyOf('OECD'), 'OECD');
});

test('personInverted/-Normal: mit und ohne Vorname, mit Initialen', () => {
  const p = { family: 'Kafka', given: 'Franz' };
  assert.equal(personInverted(p), 'Kafka, Franz');
  assert.equal(personInverted(p, { initials: true }), 'Kafka, F.');
  assert.equal(personNormal(p), 'Franz Kafka');
  assert.equal(personNormal(p, { initials: true }), 'F. Kafka');
  assert.equal(personInverted({ family: 'Kafka' }), 'Kafka');
});

test('APA-Namensliste: Schwellen 1 / 2 / 3–20 / ab 21', () => {
  const L = labelsFor('de');
  const p = n => Array.from({ length: n }, (_, i) => ({ family: `N${i + 1}`, given: 'V' }));
  assert.equal(apaAuthorList(p(1), L), 'N1, V.');
  assert.equal(apaAuthorList(p(2), L), 'N1, V., & N2, V.');
  assert.equal(apaAuthorList(p(3), L), 'N1, V., N2, V., & N3, V.');

  const twenty = apaAuthorList(p(20), L);
  assert.ok(twenty.includes('N19, V., & N20, V.'), 'bis 20 wird vollstaendig gelistet');
  assert.ok(!twenty.includes('…'));

  // Ab 21: erste 19, Auslassung, letzte — die 20. faellt weg.
  const twentyOne = apaAuthorList(p(21), L);
  assert.ok(twentyOne.includes('N19, V., … N21, V.'));
  assert.ok(!twentyOne.includes('N20'));
});

test('Chicago-Namensliste: erste invertiert, Rest natuerlich, ab 11 gekuerzt', () => {
  const L = labelsFor('de');
  const p = n => Array.from({ length: n }, (_, i) => ({ family: `N${i + 1}`, given: 'V' }));
  assert.equal(chicagoAuthorList(p(1), L), 'N1, V');
  assert.equal(chicagoAuthorList(p(2), L), 'N1, V, und V N2');
  assert.equal(chicagoAuthorList(p(3), L), 'N1, V, V N2, und V N3');
  assert.ok(chicagoAuthorList(p(10), L).includes('und V N10'), 'bis 10 vollstaendig');
  const eleven = chicagoAuthorList(p(11), L);
  assert.ok(eleven.endsWith('u. a.'));
  assert.ok(!eleven.includes('N8'), 'ab 11 nur die ersten 7');
  assert.equal(chicagoAuthorList(p(11), labelsFor('en')).endsWith('et al.'), true);
});

test('numerische Namensliste: Semikolon, ab 4 gekuerzt', () => {
  const L = labelsFor('de');
  const p = n => Array.from({ length: n }, (_, i) => ({ family: `N${i + 1}`, given: 'V' }));
  assert.equal(numericAuthorList(p(2), L), 'N1, V; N2, V');
  assert.equal(numericAuthorList(p(3), L), 'N1, V; N2, V; N3, V');
  assert.equal(numericAuthorList(p(4), L), 'N1, V u. a.');
});

// ── Voll-Eintrag je Stil und Satzfamilie ─────────────────────────────────────

test('APA 7: Monografie, Auflage, Verlagsort wird bewusst weggelassen', () => {
  assert.equal(
    formatFull(src({ ...KAFKA, edition: '2' }), { style: 'apa7' }),
    'Kafka, F. (1915). Die Verwandlung (2. Aufl.). Kurt Wolff.'
  );
  // APA 7 hat den Verlagsort abgeschafft — "Leipzig" darf nicht erscheinen.
  assert.ok(!formatFull(KAFKA, { style: 'apa7' }).includes('Leipzig'));
  assert.equal(
    formatFull(src({ ...KAFKA, edition: '2' }), { style: 'apa7', lang: 'en' }),
    'Kafka, F. (1915). Die Verwandlung (2nd ed.). Kurt Wolff.'
  );
});

test('APA 7: Aufsatz mit Band/Heft/Seiten und DOI', () => {
  const a = src({
    csl_type: 'article',
    authors: [{ family: 'Mueller', given: 'Anna' }, { family: 'Weber', given: 'Bernd' }],
    title: 'Zur Lage', container_title: 'Zeitschrift fuer Soziologie',
    volume: '12', issue: '3', pages: '45-67', year: '2020', doi: '10.1000/xyz',
  });
  assert.equal(
    formatFull(a, { style: 'apa7' }),
    'Mueller, A., & Weber, B. (2020). Zur Lage. Zeitschrift fuer Soziologie, 12(3), 45–67. https://doi.org/10.1000/xyz'
  );
});

test('APA 7: Sammelbandbeitrag mit Herausgebern in natuerlicher Reihenfolge', () => {
  const c = src({
    csl_type: 'chapter',
    authors: [{ family: 'Schmid', given: 'Carla' }],
    title: 'Rand und Mitte', container_title: 'Handbuch Peripherie',
    editors: [{ family: 'Wolff', given: 'Kurt' }, { family: 'Brod', given: 'Max' }],
    pages: '12-30', publisher: 'Haupt', year: '2019',
  });
  assert.equal(
    formatFull(c, { style: 'apa7' }),
    'Schmid, C. (2019). Rand und Mitte. In K. Wolff & M. Brod (Hrsg.), Handbuch Peripherie (S. 12–30). Haupt.'
  );
});

test('Herausgeber in der Urheberposition werden invertiert', () => {
  const e = src({ editors: [{ family: 'Wolff', given: 'Kurt' }], title: 'Sammelband', publisher: 'Verlag' });
  // Kopf traegt den Sortierschluessel → "Wolff, K.", nicht "K. Wolff".
  assert.equal(formatFull(e, { style: 'apa7' }), 'Wolff, K. (Hrsg.). (o. J.). Sammelband. Verlag.');
  assert.equal(formatFull(e, { style: 'chicago-ad' }), 'Wolff, Kurt, Hrsg. o. J. Sammelband. Verlag.');
  assert.equal(formatFull(e, { style: 'numeric' }), 'Wolff, Kurt (Hrsg.): Sammelband. Verlag, o. J.');
});

test('Chicago: Aufsatztitel in Anfuehrungszeichen der Buchsprache', () => {
  const a = src({
    csl_type: 'article', authors: [{ family: 'Mueller', given: 'Anna' }],
    title: 'Zur Lage', container_title: 'Zeitschrift', volume: '12', issue: '3',
    pages: '45-67', year: '2020',
  });
  assert.equal(formatFull(a, { style: 'chicago-ad' }), 'Mueller, Anna. 2020. „Zur Lage.“ Zeitschrift 12 (3): 45–67.');
  assert.equal(formatFull(a, { style: 'chicago-ad', lang: 'en' }), 'Mueller, Anna. 2020. “Zur Lage.” Zeitschrift 12 (3): 45–67.');
});

test('Chicago: Monografie mit Ort und Verlag', () => {
  assert.equal(formatFull(KAFKA, { style: 'chicago-ad' }), 'Kafka, Franz. 1915. Die Verwandlung. Leipzig: Kurt Wolff.');
  // Fehlt der Ort, bleibt der Verlag allein (kein fuehrender Doppelpunkt).
  assert.equal(
    formatFull(src({ ...KAFKA, place: null }), { style: 'chicago-ad' }),
    'Kafka, Franz. 1915. Die Verwandlung. Kurt Wolff.'
  );
});

test('numerisch: deutsche Verzeichniskonvention mit Jahr am Ende', () => {
  assert.equal(formatFull(KAFKA, { style: 'numeric' }), 'Kafka, Franz: Die Verwandlung. Leipzig: Kurt Wolff, 1915.');
});

test('Online-Ressource: Abrufdatum und Adresse', () => {
  const w = src({
    csl_type: 'website', authors: [{ literal: 'Bundesamt fuer Statistik' }],
    title: 'Bevoelkerungsstand', container_title: 'bfs.admin.ch',
    url: 'https://bfs.admin.ch/x', accessed_at: '2026-07-28', year: '2025',
  });
  assert.equal(
    formatFull(w, { style: 'apa7' }),
    'Bundesamt fuer Statistik. (2025). Bevoelkerungsstand. bfs.admin.ch. Abgerufen am 2026-07-28. https://bfs.admin.ch/x'
  );
  assert.ok(formatFull(w, { style: 'apa7', lang: 'en' }).includes('Accessed 2026-07-28'));
});

test('fehlende Angaben erzeugen keine leeren Trenner', () => {
  // Nur ein Titel — der Eintrag darf nicht ". . ." o.ae. enthalten.
  for (const style of CITATION_STYLES) {
    const out = formatFull(src({ title: 'Werk ohne alles' }), { style });
    assert.ok(!/\.\s*\./.test(out), `Doppelpunktierung in ${style}: ${out}`);
    assert.ok(!/,\s*,|,\s*\./.test(out), `Leerer Trenner in ${style}: ${out}`);
    assert.ok(out.startsWith('Werk ohne alles'), out);
  }
});

test('fehlender Titel wird als Platzhalter gesetzt, nicht verschwiegen', () => {
  const out = formatFull(src({ authors: [{ family: 'Kafka', given: 'Franz' }], year: '1915' }), { style: 'apa7' });
  assert.equal(out, 'Kafka, F. (1915). [ohne Titel].');
  assert.ok(formatFull(src({ authors: [{ family: 'X' }] }), { style: 'apa7', lang: 'en' }).includes('[untitled]'));
});

// ── Punktuation ──────────────────────────────────────────────────────────────

test('Punktuation: kein zweiter Punkt nach Initiale, Titel-Satzzeichen, Zitat', () => {
  // "Kafka, F." endet schon terminal → nur Leerzeichen vor "(1915)".
  assert.ok(formatFull(KAFKA, { style: 'apa7' }).startsWith('Kafka, F. (1915).'));

  // Titel mit '?' behaelt sein Satzzeichen und bekommt keinen Punkt dahinter.
  const q = src({ authors: [{ family: 'Kafka', given: 'Franz' }], title: 'Wer denn?', year: '1947', publisher: 'Querido' });
  assert.equal(formatFull(q, { style: 'apa7' }), 'Kafka, F. (1947). Wer denn? Querido.');

  const bang = src({ ...q, title: 'Endlich!' });
  assert.ok(formatFull(bang, { style: 'apa7' }).includes('Endlich! Querido.'));

  // Chicago: „Titel.“ darf keinen dritten Punkt hinter dem Anfuehrungszeichen holen.
  const a = src({ csl_type: 'article', authors: [{ family: 'M', given: 'A' }], title: 'Zur Lage', container_title: 'Z', year: '2020' });
  assert.ok(!formatFull(a, { style: 'chicago-ad' }).includes('.“.'));
});

test('Punktuation: kein Schlusspunkt hinter DOI/URL', () => {
  // Ein Punkt direkt hinter der Adresse wandert beim Kopieren mit hinein.
  for (const style of CITATION_STYLES) {
    const withDoi = formatFull(src({ ...KAFKA, doi: '10.1000/xyz' }), { style });
    assert.ok(withDoi.endsWith('https://doi.org/10.1000/xyz'), `${style}: ${withDoi}`);
    const withUrl = formatFull(src({ ...KAFKA, url: 'https://example.org/a.b' }), { style });
    assert.ok(withUrl.endsWith('https://example.org/a.b'), `${style}: ${withUrl}`);
  }
});

test('locatorUrl: DOI hat Vorrang und wird zur Adresse ergaenzt', () => {
  assert.equal(locatorUrl({ doi: '10.1000/xyz', url: 'https://x.test' }), 'https://doi.org/10.1000/xyz');
  assert.equal(locatorUrl({ doi: 'doi: 10.1000/xyz' }), 'https://doi.org/10.1000/xyz');
  assert.equal(locatorUrl({ doi: 'https://doi.org/10.1/a' }), 'https://doi.org/10.1/a');
  assert.equal(locatorUrl({ url: 'https://x.test' }), 'https://x.test');
  assert.equal(locatorUrl({}), '');
});

test('Seitenbereiche werden auf Halbgeviertstrich normalisiert', () => {
  assert.equal(enDashRange('45-67'), '45–67');
  assert.equal(enDashRange('45 - 67'), '45–67');
  assert.equal(enDashRange('45'), '45');
  assert.equal(enDashRange(''), '');
  const L = labelsFor('en');
  assert.equal(pageLabel('44', L), 'p. 44');
  assert.equal(pageLabel('44-46', L), 'pp. 44–46');
  assert.equal(pageLabel('44, 48', L), 'pp. 44, 48');
  assert.equal(pageLabel('', L), '');
});

// ── HTML ─────────────────────────────────────────────────────────────────────

test('formatFullHtml: Titel kursiv, alle Felder escapet', () => {
  const html = formatFullHtml(KAFKA, { style: 'apa7' });
  assert.ok(html.includes('<em>Die Verwandlung</em>'));

  // Quellenfelder sind User-Eingabe und fliessen in x-html-Senken + Blog-Push.
  const evil = formatFullHtml(src({
    authors: [{ family: 'X' }], year: '2000',
    title: '<script>alert(1)</script> & "b"',
  }), { style: 'apa7' });
  assert.ok(!evil.includes('<script'));
  assert.ok(evil.includes('&lt;script&gt;'));
  assert.ok(evil.includes('&amp;'));
  assert.ok(evil.includes('&quot;b&quot;'));
  // Ausser <em> entsteht kein Tag.
  assert.deepEqual([...evil.matchAll(/<(\/?)([a-z]+)/g)].map(m => m[2]), ['em', 'em']);
});

test('formatFullHtml und formatFull tragen denselben Text', () => {
  const runs = formatFullRuns(KAFKA, { style: 'chicago-ad' });
  assert.ok(runs.some(r => r.italic), 'Werktitel muss als kursiver Run erkennbar sein');
  const stripped = formatFullHtml(KAFKA, { style: 'chicago-ad' }).replace(/<\/?em>/g, '');
  assert.equal(stripped, formatFull(KAFKA, { style: 'chicago-ad' }));
});

// ── Kurzbeleg ────────────────────────────────────────────────────────────────

test('formatShort: Autor-Jahr-Stile und ihre Kuerzungsschwellen', () => {
  const p = n => Array.from({ length: n }, (_, i) => ({ family: `N${i + 1}`, given: 'V' }));
  const s = n => src({ authors: p(n), year: '2020', title: 'T' });

  assert.equal(formatShort(s(1), { style: 'apa7' }), '(N1, 2020)');
  assert.equal(formatShort(s(2), { style: 'apa7' }), '(N1 & N2, 2020)');
  assert.equal(formatShort(s(3), { style: 'apa7' }), '(N1 et al., 2020)');

  // Chicago: ohne Komma vor dem Jahr, kuerzt erst ab 4 Personen.
  assert.equal(formatShort(s(1), { style: 'chicago-ad' }), '(N1 2020)');
  assert.equal(formatShort(s(2), { style: 'chicago-ad' }), '(N1 und N2 2020)');
  assert.equal(formatShort(s(3), { style: 'chicago-ad' }), '(N1, N2 und N3 2020)');
  assert.equal(formatShort(s(4), { style: 'chicago-ad' }), '(N1 u. a. 2020)');
  assert.equal(formatShort(s(4), { style: 'chicago-ad', lang: 'en' }), '(N1 et al. 2020)');
});

test('formatShort: Stellenangabe wird nur bei Ziffern qualifiziert', () => {
  const s = src({ authors: [{ family: 'Kafka' }], year: '1915' });
  assert.equal(formatShort(s, { style: 'apa7', loc: '44' }), '(Kafka, 1915, S. 44)');
  assert.equal(formatShort(s, { style: 'apa7', loc: '44-46' }), '(Kafka, 1915, S. 44–46)');
  assert.equal(formatShort(s, { style: 'apa7', lang: 'en', loc: '44-46' }), '(Kafka, 1915, pp. 44–46)');
  // Schon qualifiziert → unveraendert, kein "S. S. 44".
  assert.equal(formatShort(s, { style: 'apa7', loc: 'S. 44' }), '(Kafka, 1915, S. 44)');
  assert.equal(formatShort(s, { style: 'apa7', loc: 'Kap. 3' }), '(Kafka, 1915, Kap. 3)');
  assert.equal(formatShort(s, { style: 'apa7', loc: '' }), '(Kafka, 1915)');
});

test('formatShort: numerisch nutzt die Nummer, ohne Nummer die Autor-Jahr-Form', () => {
  const s = src({ authors: [{ family: 'Kafka' }], year: '1915' });
  assert.equal(formatShort(s, { style: 'numeric', num: 12 }), '[12]');
  assert.equal(formatShort(s, { style: 'numeric', num: 12, loc: '44' }), '[12, S. 44]');
  // Chip gerade eingefuegt, Fund-Index noch nicht neu gebaut: lesbarer
  // Platzhalter statt "[?]" — der Regenerierungs-Pass stellt ihn richtig.
  assert.equal(formatShort(s, { style: 'numeric', num: null, loc: '44' }), '(Kafka, 1915, S. 44)');
});

test('formatShort: ohne Urheber traegt der Titel den Beleg, ohne Jahr die Sprachmarke', () => {
  assert.equal(formatShort(src({ title: 'Werk', year: '2000' }), { style: 'apa7' }), '(Werk, 2000)');
  assert.equal(formatShort(src({ authors: [{ family: 'Kafka' }] }), { style: 'apa7' }), '(Kafka, o. J.)');
  assert.equal(formatShort(src({ authors: [{ family: 'Kafka' }] }), { style: 'apa7', lang: 'en' }), '(Kafka, n.d.)');
  // Nur Herausgeber vorhanden → die tragen den Kurzbeleg.
  assert.equal(formatShort(src({ editors: [{ family: 'Wolff' }], year: '1915' }), { style: 'apa7' }), '(Wolff, 1915)');
  assert.equal(formatShort(null, {}), '');
});

test('formatShort: Paraphrase-Modus setzt das vgl./cf.-Praefix', () => {
  const s = src({ authors: [{ family: 'Kafka' }], year: '1915' });
  const p = { mode: 'paraphrase' };
  // Autor-Jahr-Stile: Praefix INNERHALB der Klammer.
  assert.equal(formatShort(s, { style: 'apa7', ...p }), '(vgl. Kafka, 1915)');
  assert.equal(formatShort(s, { style: 'apa7', loc: '44', ...p }), '(vgl. Kafka, 1915, S. 44)');
  assert.equal(formatShort(s, { style: 'chicago-ad', ...p }), '(vgl. Kafka 1915)');
  assert.equal(formatShort(s, { style: 'apa7', lang: 'en', ...p }), '(cf. Kafka, 1915)');
  // Numerisch: Praefix VOR der Klammer, die Klammerform selbst unveraendert.
  assert.equal(formatShort(s, { style: 'numeric', num: 12, ...p }), 'vgl. [12]');
  assert.equal(formatShort(s, { style: 'numeric', num: 12, loc: '44', ...p }), 'vgl. [12, S. 44]');
  assert.equal(formatShort(s, { style: 'numeric', num: 12, lang: 'en', ...p }), 'cf. [12]');
  // Default und unbekannter Modus bleiben praefixfrei — sonst wanderte ein „vgl."
  // in jeden Alt-Beleg, sobald der Regenerierungs-Pass laeuft.
  assert.equal(formatShort(s, { style: 'apa7' }), '(Kafka, 1915)');
  assert.equal(formatShort(s, { style: 'apa7', mode: 'quote' }), '(Kafka, 1915)');
  assert.equal(formatShort(s, { style: 'apa7', mode: 'quatsch' }), '(Kafka, 1915)');
});

// ── Sortierung + Nummern ─────────────────────────────────────────────────────

test('sortKeyOf: Autor, sonst Herausgeber, sonst Titel', () => {
  assert.equal(sortKeyOf(src({ authors: [{ family: 'Kafka' }], editors: [{ family: 'Wolff' }], title: 'T' })), 'Kafka');
  assert.equal(sortKeyOf(src({ editors: [{ family: 'Wolff' }], title: 'T' })), 'Wolff');
  assert.equal(sortKeyOf(src({ title: 'Titel' })), 'Titel');
});

test('sortEntries: alphabetisch mit deutscher Umlaut-Einordnung', () => {
  const list = [
    src({ id: 1, authors: [{ family: 'Zeller' }] }),
    src({ id: 2, authors: [{ family: 'Öhler' }] }),
    src({ id: 3, authors: [{ family: 'Ahrens' }] }),
    src({ id: 4, authors: [{ family: 'Ähnlich' }] }),
  ];
  // Im Verzeichnis sortiert 'Ö' unter 'O' und 'Ä' unter 'A' — Ähnlich direkt
  // neben Ahrens, nicht hinter Zeller.
  assert.deepEqual(sortEntries(list, { style: 'apa7', lang: 'de' }).map(s => s.id), [4, 3, 2, 1]);
});

test('sortEntries: gleicher Urheber nach Jahr, undatiert zuerst', () => {
  const list = [
    src({ id: 1, authors: [{ family: 'Kafka' }], year: '1922', title: 'B' }),
    src({ id: 2, authors: [{ family: 'Kafka' }], year: '', title: 'A' }),
    src({ id: 3, authors: [{ family: 'Kafka' }], year: '1915', title: 'C' }),
  ];
  assert.deepEqual(sortEntries(list, { style: 'apa7' }).map(s => s.id), [2, 3, 1]);
});

test('sortEntries: numerischer Stil nach Nummer, unnummerierte hinten', () => {
  const list = [
    src({ id: 1, authors: [{ family: 'Zeller' }] }),
    src({ id: 2, authors: [{ family: 'Ahrens' }] }),
    src({ id: 3, authors: [{ family: 'Mueller' }] }),
  ];
  const numbers = new Map([[3, 1], [1, 2]]);
  // 3 und 1 in Zitierreihenfolge, die unzitierte 2 danach.
  assert.deepEqual(sortEntries(list, { style: 'numeric', numbers }).map(s => s.id), [3, 1, 2]);
});

test('sortEntries mutiert die Eingabe nicht', () => {
  const list = [src({ id: 1, authors: [{ family: 'Z' }] }), src({ id: 2, authors: [{ family: 'A' }] })];
  const before = list.map(s => s.id);
  sortEntries(list, { style: 'apa7' });
  assert.deepEqual(list.map(s => s.id), before);
  assert.deepEqual(sortEntries([], {}), []);
});

test('assignNumbers: Nummer nach Erstzitat, Wiederholungen behalten ihre', () => {
  // Reihenfolge wie von db/sources.js#listBookCitations (Seitenposition, Offset).
  const citations = [
    { source_id: 7, page_id: 1 },
    { source_id: 3, page_id: 1 },
    { source_id: 7, page_id: 2 },   // Wiederholung → keine neue Nummer
    { source_id: 9, page_id: 2 },
    { source_id: null, page_id: 2 },
  ];
  const n = assignNumbers(citations);
  assert.equal(n.get(7), 1);
  assert.equal(n.get(3), 2);
  assert.equal(n.get(9), 3);
  assert.equal(n.size, 3);
  assert.equal(assignNumbers(null).size, 0);
});

// ── Jahres-Disambiguierung ───────────────────────────────────────────────────
// Ohne sie zeigt „(Müller, 2020)" bei zwei Werken desselben Jahres auf zwei
// Verzeichniseintraege gleichzeitig — der Beleg ist dann in beide Richtungen
// unaufloesbar.

test('assignYearSuffixes: nur mehrdeutige Autor-Jahr-Paare bekommen Buchstaben', () => {
  const list = [
    src({ id: 1, authors: [{ family: 'Müller' }], year: '2020', title: 'Zweiter Titel' }),
    src({ id: 2, authors: [{ family: 'Müller' }], year: '2020', title: 'Erster Titel' }),
    src({ id: 3, authors: [{ family: 'Müller' }], year: '2019', title: 'Anderes Jahr' }),
    src({ id: 4, authors: [{ family: 'Schmidt' }], year: '2020', title: 'Anderer Autor' }),
  ];
  const m = assignYearSuffixes(list, { lang: 'de' });
  // Buchstabe folgt der Verzeichnis-Reihenfolge der Gruppe (Titel alphabetisch),
  // NICHT der Eingabe-Reihenfolge — sonst wandert er beim Umstellen des Textes.
  assert.equal(m.get(2), 'a');
  assert.equal(m.get(1), 'b');
  // Eindeutige Eintraege bleiben ohne Buchstaben: ein „2019a" ohne „2019b"
  // daneben waere eine Falschmeldung an den Leser.
  assert.equal(m.has(3), false);
  assert.equal(m.has(4), false);
});

test('assignYearSuffixes: undatierte Werke bleiben aussen vor', () => {
  const list = [
    src({ id: 1, authors: [{ family: 'Müller' }], year: '', title: 'A' }),
    src({ id: 2, authors: [{ family: 'Müller' }], year: 'o. J.', title: 'B' }),
  ];
  assert.equal(assignYearSuffixes(list, {}).size, 0);
  assert.equal(assignYearSuffixes(null, {}).size, 0);
});

test('assignYearSuffixes: Herausgeber-/Titel-Sortierschluessel greifen wie im Verzeichnis', () => {
  // Ohne Urheber traegt der Titel den Sortierschluessel (title-first-Eintrag);
  // zwei solche Werke desselben Jahres sind NICHT mehrdeutig, weil ihr Kurzbeleg
  // bereits verschiedene Titel zeigt.
  const list = [
    src({ id: 1, authors: [], editors: [{ family: 'Weber' }], year: '2021', title: 'B' }),
    src({ id: 2, authors: [], editors: [{ family: 'Weber' }], year: '2021', title: 'A' }),
  ];
  const m = assignYearSuffixes(list, {});
  assert.equal(m.get(2), 'a');
  assert.equal(m.get(1), 'b');
});

test('assignYearSuffixes: mehr als 26 Werke kollidieren nicht', () => {
  const list = Array.from({ length: 28 }, (_, i) =>
    src({ id: i + 1, authors: [{ family: 'Vielschreiber' }], year: '2020', title: `T${String(i).padStart(2, '0')}` }));
  const m = assignYearSuffixes(list, {});
  assert.equal(new Set(m.values()).size, 28);
  assert.equal(m.get(1), 'a');
  assert.equal(m.get(26), 'z');
  assert.equal(m.get(27), 'aa');
});

test('suffix erscheint in Kurzbeleg UND Verzeichniseintrag — sonst zeigt er ins Leere', () => {
  const s = src({ id: 1, authors: [{ family: 'Müller', given: 'Anna' }], year: '2020', title: 'Ein Titel', publisher: 'Verlag' });
  assert.match(formatShort(s, { style: 'apa7', suffix: 'b' }), /Müller, 2020b/);
  assert.match(formatShort(s, { style: 'chicago-ad', suffix: 'b' }), /Müller 2020b/);
  assert.match(formatFull(s, { style: 'apa7', suffix: 'b' }), /\(2020b\)/);
});

test('numerischer Stil bleibt ohne Buchstaben — die Nummer ist bereits eindeutig', () => {
  const s = src({ id: 1, authors: [{ family: 'Müller' }], year: '2020', title: 'T', publisher: 'V' });
  assert.equal(formatShort(s, { style: 'numeric', num: 3, suffix: 'a' }), '[3]');
  assert.ok(!formatFull(s, { style: 'numeric', suffix: 'a' }).includes('2020a'));
});

test('ohne suffix bleibt alles wie bisher (Default-Pfad unveraendert)', () => {
  const s = src({ id: 1, authors: [{ family: 'Müller' }], year: '2020', title: 'T', publisher: 'V' });
  assert.equal(formatShort(s, { style: 'apa7' }), formatShort(s, { style: 'apa7', suffix: '' }));
  assert.equal(formatFull(s, { style: 'apa7' }), formatFull(s, { style: 'apa7', suffix: '' }));
});
