// Facade der Recherche-/Wissensboard-Karte (Sub-Komponente).
// Buchweit geteiltes Archiv: Notizen, Links, Zitate, Faktensplitter, Bilder —
// optional mit Buch-Entitaeten (Kapitel/Seite/Figur/Ort/Szene/Beat) verknuepfbar
// und ueber Tags filterbar. Rein kuratierend, nie generativ im Buchtext.
// Aufteilung nach Domaene in public/js/book/recherche/ — Konsumenten importieren
// ausschliesslich diese Facade.

import { rechercheBoardMethods } from './recherche/board.js';
import { rechercheItemMethods } from './recherche/items.js';
import { rechercheLinkMethods } from './recherche/links.js';
import { rechercheMediaMethods } from './recherche/media.js';

export const rechercheMethods = {
  ...rechercheBoardMethods,
  ...rechercheItemMethods,
  ...rechercheLinkMethods,
  ...rechercheMediaMethods,
};
