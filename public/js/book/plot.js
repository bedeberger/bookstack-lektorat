// Facade: Methoden der Plot-Werkstatt (Beat-Board), kombiniert nach Domäne.
// Planendes Welt-/Plot-Werkzeug: Akte (Spalten) + Beats (Karten) pro Buch + User,
// optionale Handlungsstränge als Swimlanes. CRUD, 2D-Drag-&-Drop-Reordering und
// zwei KI-Jobs (Brainstorm + Consistency) — die KI plant/prüft nur die Struktur,
// schreibt nie Fliesstext ins Manuskript.
//
// Sub-Module (gemeinsamer this._memos-Speicher pro Card-Instanz, _memo aus
// lifecycle.js):
//   - constants.js — STATUSES, ACT_PALETTE, Spannungs-Mapping (geteilt)
//   - lifecycle.js — Board laden/reset + Memo-Helper
//   - derived.js   — abgeleitete Reads: Beats/Stats, Stränge, Grid, Spannungsbogen, Filter
//   - acts.js      — Akt-CRUD, Reihenfolge, Farbe, scoped Anlegen, Hybrid-Fork
//   - threads.js   — Strang-CRUD (Swimlanes)
//   - beats.js     — Beat-CRUD (flach + grid-zellen) + Drop-Mechanik (_dropBeat)
//   - dnd.js       — SortableJS-Anbindung (Init/Reattach/Revert → _dropBeat)
//   - history.js   — Undo/Redo (max 10 Schritte) über alle reversiblen Mutationen
//   - ai.js        — KI-Jobs (Brainstorm/Consistency), Lauf-Historie, Fullscreen

import { lifecycleMethods } from './plot/lifecycle.js';
import { derivedMethods } from './plot/derived.js';
import { actsMethods } from './plot/acts.js';
import { threadsMethods } from './plot/threads.js';
import { beatsMethods } from './plot/beats.js';
import { dndMethods } from './plot/dnd.js';
import { historyMethods } from './plot/history.js';
import { aiMethods } from './plot/ai.js';

export const plotMethods = {
  ...lifecycleMethods,
  ...derivedMethods,
  ...actsMethods,
  ...threadsMethods,
  ...beatsMethods,
  ...dndMethods,
  ...historyMethods,
  ...aiMethods,
};
