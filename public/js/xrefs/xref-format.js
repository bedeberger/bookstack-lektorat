// Wortlaut eines aufgeloesten Querverweises — pur, geteilt zwischen Browser und
// allen Exportern.
//
// Das sind DOKUMENT-Strings, keine UI-Strings: „Kapitel" / „Abb." landen im
// gerenderten PDF/DOCX/Blog-Post und folgen der Sprache des BUCHS, nicht der
// UI-Locale des Betrachters. Darum eine lang-Map im Modul statt Keys in
// public/js/i18n/*.json — dieselbe Entscheidung wie in
// public/js/sources/format/labels.js und im PDF-Renderer.

const DE = {
  chapterWord: 'Kapitel',
  figureWord: 'Abb.',
  pageWord: 'S.',
  quoteOpen: '„',
  quoteClose: '“',
  // Trenner zwischen Nummer und Titel: „Abb. 3.2: Der Kaefer"
  titleSep: ': ',
};

const EN = {
  chapterWord: 'Chapter',
  figureWord: 'Fig.',
  pageWord: 'p.',
  quoteOpen: '“',
  quoteClose: '”',
  titleSep: ': ',
};

/** Labelsatz fuer eine Buchsprache. Unbekannt/fehlend → Deutsch (Default-Locale
 *  des Projekts, siehe prompt-config.json#defaultLocale). */
export function xrefLabelsFor(lang) {
  return lang === 'en' ? EN : DE;
}

function _word(kind, L) {
  if (kind === 'chapter') return L.chapterWord;
  if (kind === 'figure') return L.figureWord;
  return L.pageWord;
}

/** Anzeigetext eines Querverweises.
 *
 *  `entry`: { number, title } aus der Nummern-Map (xref-number.js), oder null,
 *  wenn das Ziel nicht (mehr) existiert.
 *
 *  RUECKGABE null BEDEUTET „nicht aufloesbar". Der Aufrufer laesst dann den
 *  vorhandenen Text stehen (er ist der Cache vom Einfuege-Zeitpunkt, also
 *  wenigstens lesbar) und markiert den Verweis als offen — er schreibt NIE ein
 *  „???" in den Text des Autors.
 *
 *  OHNE NUMMER, ABER MIT TITEL faellt der Verweis auf den Titel zurueck:
 *  bei `numbering: 'none'` im Exportprofil gibt es schlicht keine Kapitelnummer,
 *  auf die man zeigen koennte. „siehe „Die Verwandlung"" ist dann richtig und
 *  „siehe Kapitel " waere kaputt.
 */
export function formatXref({ kind, fmt = 'label', entry, lang = 'de' }) {
  if (!entry) return null;
  const L = xrefLabelsFor(lang);
  const num = entry.number ? String(entry.number) : '';
  const title = String(entry.title || '').trim();

  if (!num) return title ? `${L.quoteOpen}${title}${L.quoteClose}` : null;

  if (fmt === 'number') return num;
  if (fmt === 'title' && title) return `${_word(kind, L)} ${num}${L.titleSep}${title}`;
  return `${_word(kind, L)} ${num}`;
}

/** Praefix einer nummerierten Abbildungslegende: „Abb. 3.2: ".
 *  Ohne Nummer leer — dann bleibt die Legende so, wie der Autor sie geschrieben
 *  hat. */
export function figureCaptionPrefix(number, lang = 'de') {
  if (!number) return '';
  const L = xrefLabelsFor(lang);
  return `${L.figureWord} ${String(number)}${L.titleSep}`;
}
