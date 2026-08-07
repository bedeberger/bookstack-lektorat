// Facade für die Buchorganizer-Sub-Komponente.
// Bündelt DnD/Struktur-Moves, Persist-/Mirror-Pfad, CRUD, Undo/Redo-History und
// View-State zu einem Methoden-Pool, der in `cards/book-organizer-card.js` per
// `Alpine.data` in die Karte gespreaded wird. Sub-Module nutzen ausschliesslich
// `this.xxx` — kein Cross-Import zwischen Slices; geteilte Konstanten liegen in
// `book-organizer/constants.js`.
import { dndMethods } from './book-organizer/dnd.js';
import { persistMethods } from './book-organizer/persist.js';
import { mirrorMethods } from './book-organizer/mirror.js';
import { crudMethods } from './book-organizer/crud.js';
import { historyMethods } from './book-organizer/history.js';
import { viewMethods } from './book-organizer/view.js';
import { redaktionMethods } from './book-organizer/redaktion.js';

export const bookOrganizerMethods = {
  ...dndMethods,
  ...persistMethods,
  ...mirrorMethods,
  ...crudMethods,
  ...historyMethods,
  ...viewMethods,
  ...redaktionMethods,
};
