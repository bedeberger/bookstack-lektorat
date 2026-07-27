// Geteilte Konstanten des Buchorganizers.
//
// Eigenes Modul, weil die Slices untereinander nicht importieren (Facade-
// Konvention): MAX_CHAPTER_DEPTH brauchen dnd.js (Drop-Validierung + Demote),
// crud.js (Sub-Kapitel-Button) und die Karte (Template-Guard `ch.depth >=
// maxChapterDepth`).

// SSoT ist db/book-order.js — hier gespiegelt fuer die Frontend-Validierung.
export const MAX_CHAPTER_DEPTH = 3;

// Mehr Kapitel als das → erster Snapshot startet komplett zugeklappt.
export const COLLAPSE_THRESHOLD = 8;
