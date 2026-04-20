// Gemeinsame Utilities für die Editor-Module (editor-find, editor-synonyme,
// editor-figur-lookup). Vermeidet die dreifache Definition von Wort-Regex
// und Namens-Normalisierung.

// Ein "Einzelwort" ist eine zusammenhängende Sequenz aus Buchstaben/Ziffern.
// Bindestriche und Apostrophe zählen mit, damit «auf-/abwärts» oder «wir's» erfasst werden.
export const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-']*$/u;

// Test, ob ein Zeichen Teil eines Wortes ist (inkl. Bindestrich/Apostroph).
export const isWordChar = (c) => /[\p{L}\p{N}\-']/u.test(c);

// NFD-normalisierter, diakritikafreier Lowercase-String für lookup-Vergleiche.
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Editor-Root aus dem DOM holen – jede Editor-Methode brauchte das.
export function getEditEl() {
  return document.querySelector('#editor-card .page-content-view--editing');
}
