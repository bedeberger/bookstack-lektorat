// Zitierstil-Formatter — SSoT fuer JEDEN Ausgabeweg des Quellenverzeichnisses
// (Custom-PDF, Custom-DOCX, WordPress, HubSpot, EPUB/HTML/MD/TXT) und fuer den
// Kurzbeleg-Chip im Seiten-HTML.
//
// Reines Modul: keine DOM-, Alpine- oder Netzwerk-Abhaengigkeit. Der Server laedt
// es per dynamic import() aus dem CJS-Kontext (Muster public/js/prompts.js,
// siehe lib/prompts-loader.js), das Frontend als normales ESM. Deshalb auch die
// Locale-Behandlung ueber einen explizit uebergebenen `lang`-Parameter statt
// ueber t(): die Angabe folgt der Sprache des BUCHS, nicht der UI-Locale des
// Betrachters, und im Render-Pfad gibt es ohnehin keinen t()-Kontext.
//
// Interne Aufteilung unter `sources/format/`:
//   labels.js   — sprachabhaengige Dokument-Bausteine (Hrsg., o. J., S., …)
//   runs.js     — Run-Modell + Klartext-/HTML-Renderer + Punktuationsregeln
//   persons.js  — Namen und Namenslisten je Stil
//   styles.js   — die drei Voll-Eintrag-Builder
//   sort.js     — Verzeichnis-Reihenfolge + Nummernvergabe
//
// Quellen-Objekt = die Form aus db/sources.js (CSL-JSON-nah):
//   { id, csl_type, authors:[{family,given}|{literal}], editors, title,
//     container_title, publisher, place, year, edition, volume, issue, pages,
//     doi, isbn, issn, url, accessed_at, … }

import { labelsFor } from './format/labels.js';
import { runsToText, runsToHtml, pageLabel } from './format/runs.js';
import { shortNames } from './format/persons.js';
import { STYLE_BUILDERS } from './format/styles.js';

export { LANGS, labelsFor } from './format/labels.js';
export { runsToText, runsToHtml } from './format/runs.js';
export { sortEntries, assignNumbers, assignYearSuffixes, sortKeyOf } from './format/sort.js';

/** Unterstuetzte Zitierstile. Deckungsgleich mit VALID_CITATION_STYLES in
 *  db/schema.js und dem CHECK-freien Enum in book_settings.citation_style —
 *  laufen die auseinander, formatiert der Renderer stumm im Default-Stil.
 *  Gegated durch tests/unit/sources-format.test.mjs. */
export const CITATION_STYLES = ['apa7', 'chicago-ad', 'numeric'];

export const DEFAULT_STYLE = 'apa7';

function _style(style) {
  return CITATION_STYLES.includes(style) ? style : DEFAULT_STYLE;
}

/** Jahres-Buchstabe an die Quelle heften (siehe format/sort.js#assignYearSuffixes).
 *
 *  Bewusst als flache Kopie mit veraendertem `year` statt als Extra-Parameter
 *  durch alle Stil-Builder: das Jahr wird in jedem Stil an mehreren Stellen
 *  gesetzt (Kopf, Klammer, Online-Zusatz), und ein zusaetzliches Argument muesste
 *  ueberall einzeln richtig eingebaut werden. So gibt es genau eine Stelle.
 *
 *  Im numerischen Stil bleibt die Quelle unveraendert: dort ist die Nummer der
 *  eindeutige Zeiger, ein Buchstabe waere ein zweites, ueberfluessiges
 *  Unterscheidungsmerkmal. */
function _withSuffix(src, suffix, style) {
  if (!suffix || style === 'numeric' || !src?.year) return src;
  return { ...src, year: `${String(src.year).trim()}${suffix}` };
}

/** Voll-Eintrag als Run-Liste (kursive Titel bleiben erkennbar).
 *  Basis fuer formatFull/formatFullHtml und fuer Renderer, die Runs direkt
 *  weiterverarbeiten (PDF/DOCX). */
export function formatFullRuns(src, { style = DEFAULT_STYLE, lang = 'de', suffix = '' } = {}) {
  if (!src) return [];
  const st = _style(style);
  return STYLE_BUILDERS[st](_withSuffix(src, suffix, st), labelsFor(lang));
}

/** Voll-Eintrag als Klartext (TXT/Markdown, Vorschau, Tests). */
export function formatFull(src, opts = {}) {
  return runsToText(formatFullRuns(src, opts));
}

/** Voll-Eintrag als HTML. Alle Quellenfelder sind escapet (User-Eingabe), der
 *  einzige erzeugte Tag ist <em> — den kennen alle Ziel-Pipelines. */
export function formatFullHtml(src, opts = {}) {
  return runsToHtml(formatFullRuns(src, opts));
}

// Stellenangabe im Kurzbeleg: beginnt sie mit einer Ziffer, kommt die
// Sprach-Abkuerzung davor ("44" → "S. 44"); beginnt sie mit einem Buchstaben,
// hat der User schon selbst qualifiziert ("Kap. 3", "Abs. 12", "S. 44") und der
// Wert bleibt unveraendert. Verhindert "S. S. 44".
function _loc(loc, labels) {
  const s = loc == null ? '' : String(loc).trim();
  if (!s) return '';
  return /^\d/.test(s) ? pageLabel(s, labels) : s;
}

/** Kurzbeleg fuer den Chip im Seiten-HTML.
 *
 *  `num` ist nur im numerischen Stil relevant und kommt aus assignNumbers().
 *  Fehlt er dort (Chip gerade eingefuegt, Fund-Index noch nicht neu gebaut),
 *  faellt der Kurzbeleg bewusst auf die Autor-Jahr-Form zurueck statt auf ein
 *  "[?]": der Chip-Text ist ohnehin ein Cache, den der Regenerierungs-Pass
 *  richtigstellt — bis dahin soll dort etwas Lesbares stehen.
 *
 *  `suffix` ist der Jahres-Buchstabe aus assignYearSuffixes ("a" → „Müller,
 *  2020a"). Er MUSS derselbe sein wie im Verzeichniseintrag — sonst zeigt der
 *  Kurzbeleg auf einen Eintrag, den es so nicht gibt.
 *
 *  `mode` kommt aus `data-mode` am Chip (public/js/sources/cite-html.js).
 *  `'paraphrase'` setzt das „vgl."/„cf."-Praefix — im numerischen Stil VOR die
 *  Klammer („vgl. [7, S. 44]"), in den Autor-Jahr-Stilen hinein
 *  („(vgl. Müller, 2020, S. 44)"). Die Klammerform selbst bleibt unveraendert. */
export function formatShort(src, { style = DEFAULT_STYLE, lang = 'de', loc = '', num = null, mode = 'quote', suffix = '' } = {}) {
  if (!src) return '';
  const st = _style(style);
  const labels = labelsFor(lang);
  src = _withSuffix(src, suffix, st);
  const locStr = _loc(loc, labels);
  const cf = mode === 'paraphrase' ? `${labels.cfWord} ` : '';

  if (st === 'numeric' && Number.isInteger(num)) {
    return locStr ? `${cf}[${num}, ${locStr}]` : `${cf}[${num}]`;
  }

  const persons = (Array.isArray(src.authors) && src.authors.length) ? src.authors : src.editors;
  const names = shortNames(persons, st === 'numeric' ? DEFAULT_STYLE : st, labels);
  const year = src.year ? String(src.year).trim() : labels.noYear;
  // Ohne Urheber traegt der Kurztitel den Beleg (APA/Chicago: title-first).
  const head = names || String(src.title || '').trim() || labels.noTitle;

  // APA trennt Name und Jahr mit Komma, Chicago nur mit Leerzeichen.
  const core = (st === 'chicago-ad') ? `${head} ${year}` : `${head}, ${year}`;
  return `(${cf}${locStr ? `${core}, ${locStr}` : core})`;
}
