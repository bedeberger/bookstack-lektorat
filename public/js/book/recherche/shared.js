// Geteilte Konstanten + Draft-Fabrik der Recherche-Karte. Eigenes Modul, damit
// die vier Fach-Submodule (board/items/links/media) sie ohne Ringimport teilen.

// Fundstueck-Arten (Reihenfolge = Anzeige in Combobox/Filter).
export const KINDS = ['note', 'link', 'quote', 'fact', 'image', 'document'];
// Verknuepfungs-Kategorien (Reihenfolge = Anzeige in Picker/Filter/Sortierung).
export const LINK_KINDS = ['figure', 'location', 'scene', 'beat', 'thread', 'chapter', 'page'];

export function emptyDraft() {
  return { kind: 'note', title: '', body: '', urls: [], source: '', tags: '', fileName: '' };
}
