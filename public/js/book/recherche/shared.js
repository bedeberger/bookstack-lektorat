// Geteilte Konstanten + Draft-Fabrik der Recherche-Karte. Eigenes Modul, damit
// die vier Fach-Submodule (board/items/links/media) sie ohne Ringimport teilen.

// Fundstueck-Arten (Reihenfolge = Anzeige in Combobox/Filter).
export const KINDS = ['note', 'link', 'quote', 'fact', 'image', 'document', 'transcript'];
// Verknuepfungs-Kategorien (Reihenfolge = Anzeige in Picker/Filter/Sortierung).
export const LINK_KINDS = ['figure', 'location', 'scene', 'beat', 'thread', 'chapter', 'page'];

// Einarbeitungs-Stufen (`research_items.status`), Reihenfolge = Spaltenfolge im
// Status-Board. Spiegel der Server-SSoT `RESEARCH_STATUSES` in
// lib/research-validate.js — der Vertrag (gleiche Keys, gleiche Reihenfolge) ist
// durch tests/unit/research-status.test.mjs gegated. Ein Status-Key ist eine
// Persistenz-Konstante (Spaltenwert + CHECK + i18n-Key `recherche.status.<key>`):
// ergaenzen ja, umbenennen nein.
export const STATUSES = ['offen', 'in_arbeit', 'eingearbeitet', 'verworfen'];

// Die Verknuepfungs-Kategorien, die eine STELLE IM BUCH bezeichnen. Nur sie
// beantworten die Frage des Status-Boards („wo habe ich das eingearbeitet?") und
// stehen darum auf der Karte; Figur/Ort/Szene/Beat/Strang sind Themen-Bezuege und
// bleiben in der Detailansicht.
export const PLACE_LINK_KINDS = ['chapter', 'page'];

export function emptyDraft() {
  return { kind: 'note', title: '', body: '', urls: [], source: '', tags: '', fileName: '' };
}
