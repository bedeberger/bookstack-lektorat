// Alpine.data('bookOrganizerCard') — Sub-Komponente Buchorganizer.
//
// Reorder/Move (DnD via SortableJS, lazy), Create/Rename/Delete für Kapitel +
// Seiten + Undo/Redo (max 10 Aktionen). Keine KI, keine Job-Queue — direkter
// Storage-Zugriff via contentRepo (Domain-Repository, /content/*).
//
// Speicher-Strategie: nach jeder erfolgreichen Mutation patchen wir den
// Sidebar-Store IN-PLACE. Kein `loadPages()` (würde nav.pages + nav.tree
// reassignen → ganze App-UI re-rendert, sichtbarer Flicker). Sidebar liest
// dieselben Items, die wir mutieren, und re-rendert nur die betroffenen Stellen
// via Alpine-Deep-Reactivity.
//
// Re-Snapshot der Card-Visualisierung passiert über die Events `pages:loaded`
// (echte Server-Reloads, z.B. Buchwechsel) und `page:removed` (Remote-Delete
// aus dem Collab-Feed — `_removePageFromTree` entfernt die Seite dort bereits
// aus nav.tree/nav.pages) — nicht über einen $watch der Tree-Identität, sonst
// würden eigene Reassignments im Tree zur Selbst-Reentry führen.
//
// Methoden-Pool kommt aus ../book-organizer.js (Slices: dnd, persist, mirror,
// crud, history, view).

import { setupCardLifecycle } from './card-lifecycle.js';
import { loadSortable } from '../lazy-libs.js';
import { bookOrganizerMethods } from '../book-organizer.js';
import { MAX_CHAPTER_DEPTH } from '../book-organizer/constants.js';
import { EVT } from '../events.js';

// Buch-skopierter State — SSoT fuer Initial-Wert, `book:changed` und
// `view:reset`. Factory (keine Konstante): Object.assign wuerde sonst dieselben
// Array-/Object-Referenzen ueber mehrere Resets hinweg teilen.
const freshState = () => ({
  workTree: [],      // [{ id, name, depth, parent_id, pages: [...], subchapters: [...] }]
  soloPages: [],     // [{ id, name, chapter_id: 0 }]
  chapterOpen: {},   // { [chapter_id]: bool } — per-Buch UI-Sicht
  organizerSearch: '',
  jumpToChapterId: '',
  organizerStatus: '',
  organizerSaving: false,
  // Redaktions-Status (Slice book-organizer/redaktion.js). `redaktionEnabled`
  // haengt am Buchtyp und kommt vom Server — solange es false ist, rendert die
  // Zeile keine Stufen-Spalte.
  redaktionEnabled: false,
  redaktionByPage: {},   // { [page_id]: { status, stale, updated_by, … } }
  redaktionCounts: null, // { roh, gegengelesen, …, ohne } oder null
  redaktionSaving: {},   // { [page_id]: true } waehrend des PUT
  _undoStack: [],
  _redoStack: [],
  _inHistoryFlight: false,
  _memos: {},        // Cache für chapterLengthDist (siehe view.js#_memo)
});

export function registerBookOrganizerCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookOrganizerCard', () => ({
    ...freshState(),
    maxChapterDepth: MAX_CHAPTER_DEPTH, // Template-Guard fuer Sub-Kapitel-Button
    _sortables: [],
    _lifecycle: null,
    _onHistoryKeydown: null,

    init() {
      // Kein `resetState` im Lifecycle-Cfg (auch nicht als Factory, die der
      // Helper inzwischen unterstuetzt): beide Reset-Pfade sind hier
      // ueberschrieben, weil sie zusaetzlich Sortable destroyen muessen — ein
      // Override skippt `applyReset`, das Feld waere also toter Code. Wer die
      // Overrides je aufloest, gibt stattdessen `resetState: freshState` mit.
      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookOrganizer',
        showFlag: 'showBookOrganizerCard',
        onShow: async () => {
          await loadSortable();
          await this._rerender();
          // Parallel zum Render, nicht davor: die Seitenliste soll nicht auf
          // eine Metadaten-Abfrage warten, die sie auch nachtragen kann.
          this.loadRedaktion();
        },
        // book:changed feuert VOR loadPages — Sortable cleanen + State leeren,
        // der pages:loaded-Listener unten greift, sobald loadPages fertig ist.
        onBookChanged: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, freshState());
        },
        // Re-Klick auf offene Karte: lokaler Snapshot reicht — Drag/Rename/CRUD
        // mutieren nav.tree in-place, Server-Stand und Card-State sind in sync.
        // `loadPages` würde Sidebar-Tree clearen + neu fetchen → Flicker.
        onCardRefresh: async (e, ctx) => {
          await ctx._rerender();
          ctx.loadRedaktion();
        },
        onViewReset: (e, ctx) => {
          ctx._destroySortables();
          Object.assign(ctx, freshState());
        },
        extraListeners: [
          { type: 'pages:loaded', handler: async () => {
            if (!window.__app.showBookOrganizerCard) return;
            await loadSortable();
            await this._rerender();
            // Buchwechsel bei offener Karte: `book:changed` hat den Slice-State
            // geleert, hier kommt der des neuen Buchs.
            this.loadRedaktion();
          } },
          // Remote-Delete (Collab-Feed): `_removePageFromTree` hat die Seite
          // bereits aus nav.tree/nav.pages entfernt (In-Place, kein Reload →
          // kein pages:loaded). Der Workstate muss trotzdem nachgezogen werden,
          // sonst bleibt die geloeschte Seite als Zeile stehen.
          { type: EVT.PAGE_REMOVED, handler: async () => {
            if (!window.__app.showBookOrganizerCard) return;
            await this._rerender();
          } },
        ],
      });

      // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z + Cmd/Ctrl+Y. Nur wenn Karte sichtbar
      // und Fokus nicht in einem Input/Textarea (sonst greift die native
      // Edit-Undo-Funktion der Rename-Felder).
      this._onHistoryKeydown = (e) => {
        if (!window.__app?.showBookOrganizerCard) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const cmd = e.metaKey || e.ctrlKey;
        if (!cmd) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.historyUndo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          this.historyRedo();
        }
      };
      window.addEventListener('keydown', this._onHistoryKeydown, { signal: this._lifecycle.signal });

      // Bei aktiver Suche bricht Reorder über gefiltertem DOM die Reihenfolge —
      // Sortable-Instances werden in dem Fall disabled, statt das Suchfeld
      // selbst zu sperren. Such-Toggle erzeugt/entfernt zusätzlich x-if-gated
      // Page-ULs im DOM → Sortable danach neu binden.
      this.$watch('organizerSearch', () => {
        this._reattachSortables();
      });
    },

    destroy() {
      this._destroySortables();
      this._lifecycle?.destroy();
    },

    ...bookOrganizerMethods,
  }));
}
