// Die drei Zitierstile als Voll-Eintrag (Verzeichniszeile).
//
// Jeder Stil baut eine Liste von Teilen (jeweils Run-Arrays) und laesst
// joinParts/terminate die Punktuation setzen. So bleibt pro Stil genau eine
// Formatier-Stelle, und Klartext- wie HTML-Ausgabe entstehen aus demselben
// Ergebnis (siehe runs.js).
//
// csl_type wird auf vier Satzfamilien reduziert, weil sich die Stilregeln genau
// daran unterscheiden — nicht an den elf Typen einzeln:
//   article  → Zeitschriftenaufsatz (container + volume/issue/pages)
//   chapter  → Beitrag in Sammelband (Herausgeber + container + pages)
//   website  → Online-Ressource (container + url + Abrufdatum)
//   bookish  → alles uebrige (place/publisher); thesis/report/legal/interview/
//              film/dataset laufen bewusst hier mit. Typspezifische Zusaetze
//              (APA-Klammern wie "[Doctoral dissertation]") sind v1 nicht drin.

import {
  txt, it, urlRun, joinParts, terminate, quoted, pageLabel, enDashRange, locatorUrl,
} from './runs.js';
import {
  apaAuthorList, chicagoAuthorList, numericAuthorList,
  apaEditorList, editedByList,
  apaEditorHead, chicagoEditorHead, numericEditorHead,
} from './persons.js';

function family(cslType) {
  if (cslType === 'article') return 'article';
  if (cslType === 'chapter') return 'chapter';
  if (cslType === 'website') return 'website';
  return 'bookish';
}

function _title(src, labels) {
  const t = src.title ? String(src.title).trim() : '';
  return t || labels.noTitle;
}

function _year(src, labels) {
  const y = src.year ? String(src.year).trim() : '';
  return y || labels.noYear;
}

// Englische Ordnungszahl fuer Auflagen ("2nd ed." statt "2 ed."). Nur fuer
// reine Zahlen; alles andere (z.B. "Zweite, ueberarbeitete") bleibt wie getippt.
function _ordinalEn(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

function _edition(src, labels) {
  const raw = src.edition ? String(src.edition).trim() : '';
  if (!raw) return '';
  const num = /^(\d+)\.?$/.exec(raw);
  if (!num) return raw;                       // Freitext-Auflage unveraendert
  const n = parseInt(num[1], 10);
  return labels.lang === 'en'
    ? `${_ordinalEn(n)} ${labels.editionSuffix}`
    : `${n}. ${labels.editionSuffix}`;
}

// "Leipzig: Kurt Wolff" — fehlt eines von beiden, bleibt das andere allein.
function _placePublisher(src) {
  const place = src.place ? String(src.place).trim() : '';
  const publisher = src.publisher ? String(src.publisher).trim() : '';
  if (place && publisher) return `${place}: ${publisher}`;
  return publisher || place;
}

function _accessed(src, labels) {
  const a = src.accessed_at ? String(src.accessed_at).trim() : '';
  return a ? `${labels.accessed} ${a}` : '';
}

// ── APA 7 ────────────────────────────────────────────────────────────────────
// Kopf ist immer "<Urheber>. (<Jahr>)." — ohne Urheber ruecken Titel und Jahr
// vor (APA: title-first-Eintrag). `place` wird bewusst ignoriert: APA 7 hat den
// Verlagsort abgeschafft.
function apa7(src, labels) {
  const fam = family(src.csl_type);
  const authors = apaAuthorList(src.authors, labels);
  const head = authors || apaEditorHead(src.editors, labels);
  const year = `(${_year(src, labels)})`;
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  const parts = [];

  if (head) { parts.push(txt(head)); parts.push(txt(year)); }

  if (fam === 'article') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(txt(title));
    // Zeitschriftenname UND Bandzahl kursiv, Heftnummer und Seiten aufrecht.
    const journal = joinParts([
      it(src.container_title),
      joinParts([it(src.volume), txt(src.issue ? `(${src.issue})` : '')], ''),
    ], ', ');
    parts.push(joinParts([journal, txt(enDashRange(src.pages))], ', '));
  } else if (fam === 'chapter') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(txt(title));
    const eds = apaEditorList(src.editors, labels);
    const container = joinParts([
      it(src.container_title),
      txt(src.pages ? `(${pageLabel(src.pages, labels)})` : ''),
    ], ' ');
    parts.push(joinParts([txt(`${labels.inWord}${eds ? ` ${eds},` : ''}`), container], ' '));
    parts.push(txt(src.publisher));
  } else {
    // bookish + website: Titel kursiv, Auflage in Klammern dahinter.
    const titled = joinParts([it(title), txt(edition ? `(${edition})` : '')], ' ');
    if (!head) { parts.push(titled); parts.push(txt(year)); }
    else parts.push(titled);
    parts.push(fam === 'website' ? txt(src.container_title) : txt(src.publisher));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

// ── Chicago Author-Date ──────────────────────────────────────────────────────
// Jahr steht ohne Klammer direkt hinter dem Urheber; Aufsatz-/Kapiteltitel in
// Anfuehrungszeichen der Buchsprache, Werk-/Zeitschriftentitel kursiv.
function chicagoAd(src, labels) {
  const fam = family(src.csl_type);
  const authors = chicagoAuthorList(src.authors, labels);
  const head = authors || chicagoEditorHead(src.editors, labels);
  const year = _year(src, labels);
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  const parts = [];

  if (head) { parts.push(txt(head)); parts.push(txt(year)); }

  if (fam === 'article') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    // "Zeitschrift 12 (3): 45–67"
    const vol = joinParts([it(src.container_title), txt(src.volume)], ' ');
    const issue = joinParts([vol, txt(src.issue ? `(${src.issue})` : '')], ' ');
    parts.push(joinParts([issue, txt(enDashRange(src.pages))], ': '));
  } else if (fam === 'chapter') {
    if (!head) { parts.push(txt(title)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    parts.push(joinParts([
      joinParts([txt(labels.inWord), it(src.container_title)], ' '),
      txt(editedByList(src.editors, labels)),
      txt(enDashRange(src.pages)),
    ], ', '));
    parts.push(txt(_placePublisher(src)));
  } else if (fam === 'website') {
    if (!head) { parts.push(quoted(title, labels)); parts.push(txt(year)); }
    else parts.push(quoted(title, labels));
    parts.push(it(src.container_title));
  } else {
    const titled = joinParts([it(title), txt(edition)], '. ');
    if (!head) { parts.push(titled); parts.push(txt(year)); }
    else parts.push(titled);
    parts.push(txt(_placePublisher(src)));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

// ── Numerisch ────────────────────────────────────────────────────────────────
// Deutsche Verzeichniskonvention: "Nachname, Vorname: Titel. Ort: Verlag, Jahr."
// Die Nummer selbst gehoert nicht in den Eintrag — sie kommt aus der
// Erstzitat-Reihenfolge und wird vom Renderer als eigene Spalte gesetzt.
function numeric(src, labels) {
  const fam = family(src.csl_type);
  const authors = numericAuthorList(src.authors, labels);
  const head = authors || numericEditorHead(src.editors, labels);
  const year = _year(src, labels);
  const title = _title(src, labels);
  const edition = _edition(src, labels);
  const url = locatorUrl(src);
  const parts = [];

  if (fam === 'article') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), txt(title)], ' '));
    const vol = joinParts([it(src.container_title), txt(src.volume)], ' ');
    const issue = joinParts([vol, txt(src.issue ? `(${src.issue})` : '')], ' ');
    parts.push(joinParts([
      joinParts([txt(`${labels.inWord}:`), issue], ' '),
      txt(pageLabel(src.pages, labels)),
      txt(year),
    ], ', '));
  } else if (fam === 'chapter') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), txt(title)], ' '));
    parts.push(joinParts([
      joinParts([txt(`${labels.inWord}:`), it(src.container_title)], ' '),
      txt(editedByList(src.editors, labels)),
      txt(pageLabel(src.pages, labels)),
    ], ', '));
    parts.push(joinParts([txt(_placePublisher(src)), txt(year)], ', '));
  } else if (fam === 'website') {
    parts.push(joinParts([txt(head ? `${head}:` : ''), it(title)], ' '));
    parts.push(joinParts([txt(src.container_title), txt(year)], ', '));
  } else {
    parts.push(joinParts([txt(head ? `${head}:` : ''), it(title)], ' '));
    parts.push(txt(edition));
    parts.push(joinParts([txt(_placePublisher(src)), txt(year)], ', '));
  }

  parts.push(txt(_accessed(src, labels)));
  parts.push(urlRun(url));
  return terminate(joinParts(parts, '. '));
}

export const STYLE_BUILDERS = {
  'apa7': apa7,
  'chicago-ad': chicagoAd,
  'numeric': numeric,
};
