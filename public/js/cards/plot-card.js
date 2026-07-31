// Alpine.data('plotCard') — Sub-Komponente für die Plot-Werkstatt (Beat-Board).
// Buchebenen-Karte (exklusiv): Akte (Spalten) + Beats (Karten) + zwei KI-Jobs
// (Brainstorm, Consistency). Fachdaten leben lokal in der Karte (nicht im
// catalog-store), weil sie rein planend und nicht mit Figuren/Orten geteilt sind.

import { plotMethods } from '../book/plot.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { loadSortable } from '../lazy-libs.js';
import { EVT } from '../events.js';

export function registerPlotCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('plotCard', () => ({
    acts: [],
    // Handlungsstränge (Swimlanes): optionale zweite Ordnungsachse. Leeres Array
    // = flaches Board (heutiges Verhalten). Pro Buch + User, lokal in der Karte.
    threads: [],
    beats: [],
    // Gerichtete Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff). Flache Liste
    // aus dem /plot-Payload ({ id, from_beat_id, to_beat_id, typ, from_titel,
    // to_titel }); die Beat-Karte gruppiert sie pro Beat (ausgehende Kanten).
    relations: [],
    // Temp-State fürs Anlegen einer Beziehung im Beat-Edit (Typ + Ziel-Beat).
    relDraftTyp: '',
    relDraftTarget: '',
    // Werkstatt-Figuren (draft_figures) des Buchs, fürs Beat-Picker + Badges.
    // Lokal in der Karte geladen (nicht im catalog-store — wie die Plot-Daten).
    draftFiguren: [],
    // Motiv-Katalog (Motiv-Werkstatt) fürs Beat-Motiv-Picker: id + name + theme_id
    // (für Gruppierung nach Thema). Die Badge-Farbe liefert der Server pro Beat
    // (beat.motifs[].farbe). Best-effort in loadBoard geladen — Board bleibt
    // Primärdaten, Motive nur Beilage. themesCatalog (id + name, Position-Reihenfolge)
    // liefert die Gruppen-Header + -Ordnung fürs Picker.
    motifsCatalog: [],
    themesCatalog: [],
    loading: false,
    busy: false,
    errorMessage: '',
    _memos: {},

    // O(1)-Lookup-Map id→Draft (gleiches Muster wie $app.figurenById): Getter
    // baut nur bei Referenz-Wechsel neu (loadBoard reassignt draftFiguren).
    get draftFigurenById() {
      if (this._draftFigMapRef !== this.draftFiguren) {
        this._draftFigMapRef = this.draftFiguren;
        this._draftFigMap = new Map((this.draftFiguren || []).map(d => [d.id, d]));
      }
      return this._draftFigMap;
    },

    // Strang-Lookup läuft über die Methode _threadById (board.js, SSoT) — kein
    // Card-Getter, weil ihn nur die reinen Methods-Module konsumieren.

    // Filter (Kapitel / Figur / Werkstatt-Figur) — wie szenen/ereignisse; filtert
    // die Beats pro Akt-Spalte rein fürs Rendering (beatsForAct bleibt ungefiltert
    // für Drag&Drop + Order-Persistenz).
    plotFilters: { kapitel: '', figurId: '', draftFigurId: '', status: '', text: '' },

    // Beat-Edit / -Add
    editingBeatId: null,
    beatDraft: { titel: '', beschreibung: '', status: 'geplant', chapter_id: '', intensitaet: null, figure_ids: [], draft_figure_ids: [], motif_ids: [] },
    addingActId: null,
    // Grid-Add-Beat: Zell-Schlüssel `${actId}:${threadId|null}` (statt addingActId).
    addingCell: null,
    newBeatTitel: '',

    // Akt-Edit / -Add / -Farbe
    editingActId: null,
    actDraft: '',
    addingAct: false,
    newActName: '',
    actColorPickerId: null,
    // Grid-Add-Akt-Scope: false = nicht im Add-Modus, null = geteilter Akt,
    // <threadId> = strang-eigener Akt (Hybrid). Eigene Variable neben `addingAct`
    // (flaches Board), weil das Grid scoped hinzufügt.
    addingActScope: false,

    // Strang-Edit / -Add / -Farbe (Swimlanes)
    editingThreadId: null,
    threadDraft: { name: '', farbe: null, figure_id: '', draft_figure_id: '' },
    addingThread: false,
    newThreadName: '',
    threadColorPickerId: null,
    // ID der Lane, deren Aktions-Dropdown (Kebab) offen ist (Single-Select wie die
    // Color-Picker-IDs). Das Menü ist ein einzelnes, nach <body> teleportiertes
    // .context-menu (JS-positioniert) — die Lane lebt in einem overflow/transform-
    // Scrollcontainer, in dem ein verankertes Popover geclippt würde.
    threadActionsOpenId: null,
    threadMenuPos: { top: 0, left: 0 },

    // ID des Beats, dessen Anchor-Fundstellen-Popover offen ist (Single-Select).
    // Das Popover ist ein einzelnes, nach <body> teleportiertes .context-menu
    // (JS-positioniert) — die Beat-Karte lebt in einem overflow/transform-
    // Scrollcontainer, in dem ein verankertes Popover geclippt würde.
    beatOccPopoverBeatId: null,
    beatOccPopoverPos: { top: 0, left: 0 },

    // Eingeklappte „verworfen"-Beats pro Akt ({ [actId]: true }).
    verworfenOpen: {},

    // Spannungsbogen-Figur-Fokus (Feature: Figurenbogen über die Kurve). Encodierter
    // Wert `c:<figId>` (Katalog) bzw. `w:<draftId>` (Werkstatt), '' = kein Fokus.
    // Hebt die Beats dieser Figur auf der Kurve hervor (Rest gedämpft).
    tensionFocusFigur: '',

    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // horizontaler Platz fürs Akt-Board. Toggle in plotMethods.togglePlotFullscreen.
    plotFullscreen: false,

    // Drag & Drop (SortableJS, eine Instanz pro Beat-Zelle — siehe book/plot/dnd.js).
    _sortables: [],
    _reattachQueued: false,
    // ID des gerade gezogenen Beats (von dnd.js#onBeatSortEnd gesetzt, von
    // beats.js#_dropBeat gelesen).
    _dragBeatId: null,

    // Undo/Redo (max 10 Schritte, siehe book/plot/history.js). Gefüllt von den
    // Mutations-Methoden, geleert von resetPlot/loadBoard und jedem Löschen.
    _undoStack: [],
    _redoStack: [],
    _inHistoryFlight: false,

    // KI: Brainstorm
    brainstormActId: null,
    brainstormThreadId: null,
    brainstormLoading: false,
    brainstormStatus: '',
    brainstormProgress: 0,
    brainstormResult: null,
    _brainstormJobId: null,
    _brainstormPollTimer: null,

    // KI: Beat-Verankerung (Ist-Index gegen den Buchtext, kein callAI). Treibt das
    // Drift-Badge pro Beat. `beatAnchorStale` kommt aus dem /plot-Payload (Beats
    // seit letztem Anchor-Lauf geändert → „Verankerung aktualisieren" anbieten).
    anchorLoading: false,
    anchorStatus: '',
    anchorProgress: 0,
    beatAnchorStale: false,
    _anchorJobId: null,
    _anchorPollTimer: null,

    // KI: Consistency
    consistencyLoading: false,
    consistencyStatus: '',
    consistencyProgress: 0,
    consistencyResult: null,
    selectedKonfliktIdx: null,
    _consistencyJobId: null,
    _consistencyPollTimer: null,

    // Konsistenz-Prüfungs-Historie (persistierte Läufe pro Buch). Klick auf einen
    // Eintrag lädt sein Result in das bestehende Consistency-Panel (selectedRunId).
    consistencyRuns: [],
    selectedRunId: null,

    // Brainstorm-Lauf-Historie (persistierte Läufe pro Buch, zusätzlich pro
    // Akt/Strang). Klick auf einen Eintrag lädt seine Vorschläge zurück in das
    // Inline-Panel des zugehörigen Akts/der Zelle (selectedBrainstormRunId).
    brainstormRuns: [],
    selectedBrainstormRunId: null,

    // Deep-Link-Ziel (#book/X/plot/<beatId>): gemerkt, bis das Board geladen ist.
    _pendingFocusBeatId: null,

    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'plot',
        showFlag: 'showPlotCard',
        // Timer-Cleanup läuft ausschliesslich über _clearJobs (SSoT): book:changed/
        // view:reset via resetPlot, destroy() ruft es unten selbst. Kein timerKeys
        // hier (sonst zwei Quellen für dieselben drei Poll-Timer).
        // Sortable vor dem ersten Board-Render laden — _reattachSortables (via
        // loadBoard / $watch) bindet die Beat-Zellen, sobald window.Sortable da ist.
        onShow: async () => { await loadSortable(); await this.loadBoard(); },
        onBookChanged: () => {
          this._destroySortables();
          this.resetPlot();
          const bookId = Alpine.store('nav').selectedBookId;
          if (window.__app.showPlotCard && bookId) {
            this.loadBoard();
            // book:changed hat den Katalog-Store geleert; der Figuren-Picker
            // braucht ihn neu (analog loadDeps beim Toggle-Open).
            if (!Alpine.store('catalog').figuren?.length) window.__app.loadFiguren(bookId);
          }
        },
        onViewReset: () => { this._destroySortables(); this.resetPlot(); },
        onCardRefresh: () => this.loadBoard(),
      });

      // Strukturelle Änderungen (Akt-/Strang-CRUD, Fork/Unfork, loadBoard-Reassign)
      // tauschen die Beat-Zell-Container im DOM → SortableJS muss neu binden.
      // Beat-only-Änderungen (Add/Delete/Drop) lassen die Container stehen und
      // brauchen kein Reattach. _scheduleReattach coalesct Mehrfach-Feuer pro Frame.
      this.$watch('acts', () => this._scheduleReattach());
      this.$watch('threads', () => this._scheduleReattach());

      // Karte schliessen (anderes Feature / Home) darf keinen offenen Beat-Edit
      // hinterlassen — sonst öffnet die Karte beim nächsten Mal direkt im Beat.
      // setupCardLifecycle kennt nur die true-Flanke; den Reset hängen wir hier an.
      this.$watch(() => window.__app.showPlotCard, (visible) => {
        if (!visible && this.editingBeatId != null) this.cancelEditBeat();
      });

      // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z + Cmd/Ctrl+Y (Muster wie im Buchorganizer).
      // Nur bei sichtbarer Karte und Fokus ausserhalb von Eingabefeldern —
      // sonst überschriebe man die native Edit-Undo-Funktion in Titel-/
      // Beschreibungsfeldern (Beat-Edit, Akt-/Strang-Umbenennen).
      window.addEventListener('keydown', (e) => {
        if (!window.__app?.showPlotCard) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        if (!(e.metaKey || e.ctrlKey)) return;
        const key = (e.key || '').toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          this.plotHistoryUndo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          this.plotHistoryRedo();
        }
      }, { signal: this._lifecycle.signal });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--plot), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.plotFullscreen = active; },
      });

      // Deep-Link-Permalink #book/X/plot/<beatId>: Hash-Router dispatcht das Event;
      // _focusBeatById fokussiert den Beat (bzw. merkt ihn bis zum Board-Load vor).
      window.addEventListener(EVT.PLOT_FOCUS_BEAT, (e) => {
        this._focusBeatById(e.detail?.beatId);
      }, { signal: this._lifecycle.signal });

      // Cross-Feature: Navigation Werkstatt → Plot. Setzt den Werkstatt-Figur-Filter
      // (plotFilters überlebt den Board-Load, daher kein Parking nötig).
      window.addEventListener(EVT.PLOT_FILTER_DRAFT_FIGURE, (e) => {
        this.applyDraftFigureFilter(e.detail?.draftId);
      }, { signal: this._lifecycle.signal });
    },

    destroy() {
      this._clearJobs();
      this._destroySortables();
      this._detachOccPopoverListeners?.();
      this._lifecycle?.destroy();
    },

    ...plotMethods,
  }));
}
