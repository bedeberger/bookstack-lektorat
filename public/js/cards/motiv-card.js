// Motiv-Werkstatt — Alpine.data-Sub-Komponente (Themen & Motive als Konstellation).
// State explizit deklariert; Fachmethoden aus public/js/book/motiv.js gespreadet.
// Root-Zugriffe via window.__app (JS) bzw. $app (Template).

import { motivMethods } from '../book/motiv.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit.js';

export function registerMotivCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('motivCard', () => ({
    // Daten (Graph-Payload)
    themes: [],
    motifs: [],
    relations: [],
    allBeats: [],
    allActs: [],
    // Werkstatt-Figuren (draft_figures) fürs Figuren-Verknüpfungs-Combobox (Gruppe „Plotwerkstatt")
    allDraftFiguren: [],
    // UI-Status
    loading: false,
    busy: false,
    errorMessage: '',
    // Auswahl + Fundstellen
    selectedMotifId: null,
    // Themen-Auswahl (parallel zur Motiv-Auswahl, gegenseitig exklusiv): Klick auf
    // ein Thema (Liste oder Graph-Knoten) öffnet den Themen-Editor im Panel.
    selectedThemeId: null,
    occurrences: [],
    occLoading: false,
    // Panel-Sektionen auf-/zugeklappt (pro Motiv in localStorage persistiert,
    // gesetzt bei jeder Auswahl in selectMotif; Default offen): Fundstellen (Ist),
    // Soll-Verknüpfungen und Motiv↔Motiv-Beziehungen.
    occExpanded: true,
    linksExpanded: true,
    relationsExpanded: true,
    // Edit-Puffer der Kern-Felder (Name/Thema/Beschreibung/Trigger) — explizit
    // gespeichert via Save/Cancel-Leiste, kein Feld-Autosave.
    editThemeId: '',
    editName: '',
    editBeschreibung: '',
    editTriggers: '',
    // Edit-Puffer des Themen-Editors (Name/Beschreibung) — explizit gespeichert
    // via Save/Cancel, kein Feld-Autosave (App-Standard, wie der Motiv-Editor).
    editThemeName: '',
    editThemeBeschreibung: '',
    // Edit-Puffer der Soll-Verknüpfungen (Figuren/Beats/Kapitel/Seiten) — wie die
    // Kern-Felder explizit via Save/Cancel-Icon persistiert, kein Auto-Save mehr.
    // Bei Auswahl aus dem Motiv gefüllt (_loadLinkBuffer), Chips lesen die Puffer.
    editFigures: [],
    editDraftFigures: [],
    editBeats: [],
    editChapters: [],
    editPages: [],
    // Ansicht: Konstellation (Graph), Kapitel-Verlaufsband (Heatmap Motiv × Kapitel)
    // oder Konsistenz-Befunde (deterministische Messung der Motiv-Kanten)
    motivView: 'graph',
    // Kapitel-Verlaufsband — aufgeklapptes Zell-Detail (`motifId:chapterId`) und
    // die dafür geholten Fundstellen. Der Cache liegt pro Motiv (eine Bandzeile
    // hat so viele Zellen wie das Buch Kapitel) und wird bei jedem loadBoard()
    // geleert, weil ein Scan-Lauf die Zahlen darunter verschiebt.
    activeBandDetailKey: null,
    bandOccCache: {},
    bandDetailLoading: false,
    // Konsistenz-Befunde (GET /motifs/consistency — Messung, kein KI-Lauf).
    // checksScanned=false heisst: der Ist-Index ist leer, es wurde also nicht
    // gemessen — nicht „alles in Ordnung".
    checks: [],
    checksScanned: true,
    checksLoading: false,
    selectedCheckIdx: null,
    // KI-Urteil (Job `motif-consistency`) — zweite Schicht neben der Messung.
    // consistencyResult ist transient (frischer Lauf ODER wieder geöffneter
    // Lauf aus der Historie), consistencyRuns die persistierte Liste.
    consistencyRunning: false,
    consistencyProgress: 0,
    consistencyResult: null,
    consistencyRuns: [],
    selectedConsistencyRunId: null,
    selectedKonfliktIdx: null,
    motivConsistencyJobId: null,
    // Graph-Layer
    layerFigures: false,
    layerBeats: false,
    layerChapters: false,
    // Graph-Kontextmenü (Rechtsklick)
    graphMenuOpen: false,
    graphMenuNodeId: null,
    graphMenuPos: { top: 0, left: 0 },
    // Offener Thema-Farbwähler (Themen-Liste im Panel), null = keiner
    themeColorPickerId: null,
    // Eingabe-Drafts
    newThemeName: '',
    newMotifName: '',
    newMotifThemeId: '',
    newRelationTargetId: '',
    newRelationTyp: '',
    // Scan-Job
    scanning: false,
    scanProgress: 0,
    motivScanJobId: null,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für die Konstellation. Toggle in graphMethods.toggleMotivFullscreen.
    motivFullscreen: false,
    // Embedding-Index-Refresh (für semantische Erkennung)
    indexing: false,
    // Ist der Embedding-Index des Buches veraltet? Server-gestützt aus loadBoard
    // (embedIndex.stale) — steuert den „Index aktualisieren"-Hinweis. Kein Session-
    // Flag: verschwindet, sobald der Index tatsächlich frisch ist (auch via Nacht-Cron).
    embedIndexStale: false,
    // Brainstorm-Job (KI-Vorschläge)
    brainstorming: false,
    motivBrainstormJobId: null,
    suggestions: [],
    // Brainstorm-Lauf-Historie (persistiert pro Buch); ein Eintrag lädt seine
    // Vorschläge zurück ins Panel (selectedBrainstormRunId markiert den offenen Lauf).
    brainstormRuns: [],
    selectedBrainstormRunId: null,
    // interne (nicht-reaktive) Felder
    // Cross-Feature-Sprung (Plot-Beat-Motiv-Badge → motiv:select): geparkte Motiv-ID,
    // falls das Board beim Event noch nicht geladen war; loadBoard wendet sie an.
    _pendingMotifId: null,
    _beatsLoaded: false,
    _draftFigurenLoaded: false,
    _memos: {},
    _motivNetwork: null,
    _motivNodes: null,
    _motivEdges: null,
    _motivHash: '',
    // Aufgelöste Canvas-Farben (Hell/Dunkel), pro Render in renderMotivGraph gesetzt.
    _graphTheme: null,
    _themeObserver: null,
    _scanPollTimer: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _embedPollTimer: null,
    _layoutSaveTimer: null,
    // Persistiertes Knoten-Layout (node_id → {x,y}); aus loadBoard, beim Ziehen gespeichert.
    _savedPositions: null,
    _graphMenuCloseHandler: null,
    // SortableJS-Instanz der Themen-Liste (Reihenfolge per Drag)
    _themeSortable: null,
    _lifecycle: null,

    init() {
      // Cross-Card-Sprung: `motiv:select` (z.B. aus einem Plot-Beat-Motiv-Badge)
      // wählt das Motiv aus. Motive evtl. noch nicht geladen → ID parken,
      // loadBoard() wendet sie nach dem Fetch an.
      const onSelectMotif = (e) => {
        const id = parseInt(e.detail?.motifId);
        if (!id) return;
        if (!this.motifs.length) { this._pendingMotifId = id; return; }
        if (this.motifById(id) && this.selectedMotifId !== id) this.selectMotif(id);
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'motiv',
        showFlag: 'showMotivCard',
        timerKeys: ['_scanPollTimer', '_brainstormPollTimer', '_consistencyPollTimer', '_embedPollTimer', '_layoutSaveTimer'],
        onShow: () => this.loadBoard(),
        onBookChanged: () => {
          this.resetMotiv();
          if (window.__app.showMotivCard && this.$store.nav.selectedBookId) this.loadBoard();
        },
        onViewReset: () => this.resetMotiv(),
        onCardRefresh: () => this.loadBoard(),
        extraListeners: [{ type: 'motiv:select', handler: onSelectMotif }],
      });

      // Auf-/Zuklappen der Panel-Sektionen pro Motiv persistieren.
      this.$watch('occExpanded', (v) => {
        if (this.selectedMotifId) this._persistSectionExpanded('occ', this.selectedMotifId, v);
      });
      this.$watch('linksExpanded', (v) => {
        if (this.selectedMotifId) this._persistSectionExpanded('links', this.selectedMotifId, v);
      });
      this.$watch('relationsExpanded', (v) => {
        if (this.selectedMotifId) this._persistSectionExpanded('relations', this.selectedMotifId, v);
      });

      // Theme-Wechsel (Hell/Dunkel) → Konstellation neu zeichnen. Die Farben
      // stecken im gezeichneten Canvas-Bild, ein CSS-Wechsel erreicht sie nicht.
      this._themeObserver = observeThemeChange(() => {
        if (window.__app.showMotivCard && this.motivView === 'graph') this.renderMotivGraph();
      });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit) und den
      // vis-network-Graph auf die neue Containergrösse neu zeichnen.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.motivFullscreen = active;
          // Container-Grösse ändert sich → Canvas erst nach dem Fullscreen-Reflow
          // neu vermessen (redraw) und die Ansicht einpassen (fit). Ohne fit bleibt
          // der Graph beim alten Viewport hängen und liegt ausserhalb der neuen
          // Fläche; rAF stellt sicher, dass das :fullscreen-Layout schon steht.
          requestAnimationFrame(() => {
            if (!this._motivNetwork) return;
            this._motivNetwork.redraw();
            this._motivNetwork.fit({ animation: { duration: 300 } });
          });
        },
      });
    },

    destroy() {
      // Ausstehende Layout-Speicherung noch flushen, solange das Netzwerk lebt.
      if (this._layoutSaveTimer) { clearTimeout(this._layoutSaveTimer); this._layoutSaveTimer = null; this._saveLayout(); }
      this._detachGraphMenuListeners();
      this._destroyThemeSortable();
      this._themeObserver?.disconnect();
      this._themeObserver = null;
      this._destroyGraph();
      this._lifecycle?.destroy();
    },

    ...motivMethods,
  }));
}
