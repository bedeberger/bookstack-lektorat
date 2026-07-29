// Sprachabhaengige Bausteine der Literaturangabe.
//
// Das sind DOKUMENT-Strings, keine UI-Strings: sie landen im gerenderten PDF /
// DOCX / Blog-Post und muessen der Sprache des BUCHS folgen, nicht der
// UI-Locale des Betrachters. Darum eine lang-Map im Modul statt Keys in
// public/js/i18n/*.json — dieselbe Entscheidung wie beim PDF-Renderer
// (`_TOC_DEFAULT_TITLE` in lib/pdf-render/pages.js).
//
// Zweiter Grund: das Modul laeuft auch serverseitig im Render-Pfad, wo kein
// t()-Kontext existiert, und muss ohne Alpine/DOM ladbar bleiben.

const DE = {
  lang: 'de',
  // Ueberschrift des Verzeichnisses, wenn book_settings.bibliography_title leer
  // ist (lib/bibliography.js). Steht hier und nicht in i18n/*.json, weil sie im
  // gerenderten Dokument landet — siehe Modulkopf.
  bibliographyTitle: 'Quellenverzeichnis',
  noYear: 'o. J.',
  noTitle: '[ohne Titel]',
  // Ein/mehrere Herausgeber — APA klammert das hinter die Namen.
  editorSuffix1: 'Hrsg.',
  editorSuffixN: 'Hrsg.',
  pageAbbrev1: 'S.',
  pageAbbrevN: 'S.',
  editionSuffix: 'Aufl.',
  inWord: 'In',
  editedBy: 'herausgegeben von',
  accessed: 'Abgerufen am',
  // Paraphrase-Praefix im Kurzbeleg (data-mode="paraphrase" am Chip).
  cfWord: 'vgl.',
  // Wiederholungs-Kurzformen im Anmerkungsapparat (format/notes.js).
  // `ibid` = unmittelbar davor dieselbe Quelle, `opCit` = im selben Kapitel schon
  // belegt, aber nicht direkt davor.
  ibidWord: 'Ebd.',
  opCitWord: 'a. a. O.',
  notesTitle: 'Anmerkungen',
  andApa: '&',
  andChicago: 'und',
  etAlApa: 'et al.',
  etAlChicago: 'u. a.',
  etAlNumeric: 'u. a.',
  quoteOpen: '„',   // „
  quoteClose: '“',  // "
};

const EN = {
  lang: 'en',
  bibliographyTitle: 'Sources',
  noYear: 'n.d.',
  noTitle: '[untitled]',
  editorSuffix1: 'Ed.',
  editorSuffixN: 'Eds.',
  pageAbbrev1: 'p.',
  pageAbbrevN: 'pp.',
  editionSuffix: 'ed.',
  inWord: 'In',
  editedBy: 'edited by',
  accessed: 'Accessed',
  cfWord: 'cf.',
  ibidWord: 'Ibid.',
  opCitWord: 'op. cit.',
  notesTitle: 'Notes',
  andApa: '&',
  andChicago: 'and',
  etAlApa: 'et al.',
  etAlChicago: 'et al.',
  etAlNumeric: 'et al.',
  quoteOpen: '“',   // "
  quoteClose: '”',  // "
};

export const LANGS = ['de', 'en'];

/** Labelsatz fuer eine Buchsprache. Unbekannte/fehlende Sprache → Deutsch
 *  (Default-Locale des Projekts, siehe prompt-config.json#defaultLocale). */
export function labelsFor(lang) {
  return lang === 'en' ? EN : DE;
}
