// Alpine.data('figurenCard') — Sub-Komponente der Figurenübersicht.
//
// Eigener State:
//   - Graph-Modus (figurenGraphModus, figurenGraphKapitel, figurenGraphFullscreen)
//   - vis-network-Internals (_figurenNetwork, _figurenHash, _figurenNodes, _figurenEdges)
//   - figurenUpdatedAt (Render-Timestamp im Card-Header)
//
// Root behält:
//   - `figuren` (im Store, via $root-Proxy)
//   - `figurenFilters` (app-navigation schreibt darauf)
//   - `selectedFigurId` (Hash-Router)
//   - `figurenLoading/Progress/Status` (checkPendingJobs schreibt darauf)
//   - `loadFiguren`, `saveFiguren` (von vielen Modulen gerufen)
//
// Lifecycle:
//   - $watch(showFiguresCard): bei Öffnen laden + Graph rendern
//   - $watch($root.uiLocale): Graph neu rendern (Labels übersetzt)
//   - book:changed: lokalen Graph-State nullen + vis-Network destroyen
//   - view:reset: wie book:changed
//   - card:refresh: Daten neu laden + Graph re-rendern

import { graphMethods } from '../graph.js';

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, andere: 4 };

export function registerFigurenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurenCard', () => ({
    figurenUpdatedAt: null,
    figurenGraphModus: 'figur',
    figurenGraphKapitel: null,
    figurenGraphFullscreen: false,
    _figurenNetwork: null,
    _figurenHash: null,
    _figurenNodes: null,
    _figurenEdges: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,
    _localeWatchCleanup: null,

    init() {
      this.$watch(() => window.__app.showFiguresCard, async (visible) => {
        if (!visible) return;
        const root = window.__app;
        if (!root.selectedBookId) return;
        await root.loadFiguren(root.selectedBookId);
        await this.$nextTick();
        this.renderFigurGraph();
      });

      // Sprachwechsel → Graph-Labels neu rendern (uiLocale Teil des Hash).
      this._localeWatchCleanup = this.$watch(() => window.__app.uiLocale, () => {
        if (window.__app.showFiguresCard && window.__app.figuren?.length) {
          this.renderFigurGraph();
        }
      });

      this._onBookChanged = async () => {
        if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
        // vis-network DataSets halten Referenzen aufs alte Buch; ohne null
        // bleiben sie bis zum nächsten view:reset im Speicher.
        this._figurenNodes = null;
        this._figurenEdges = null;
        this._figurenHash = null;
        this.figurenUpdatedAt = null;
        this.figurenGraphKapitel = null;
        if (!window.__app.showFiguresCard) return;
        if (!window.__app.selectedBookId) return;
        // loadFiguren läuft bereits aus _resetBookScopedState-Flow (loadPages);
        // wir warten bis figuren aktualisiert sind und rendern dann.
        await this.$nextTick();
        this.renderFigurGraph();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
        this._figurenHash = null;
        this._figurenNodes = null;
        this._figurenEdges = null;
        this.figurenUpdatedAt = null;
        this.figurenGraphModus = 'figur';
        this.figurenGraphKapitel = null;
        this.figurenGraphFullscreen = false;
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = async (e) => {
        if (e.detail?.name !== 'figuren') return;
        const root = window.__app;
        if (!root.selectedBookId) return;
        await root.loadFiguren(root.selectedBookId);
        await this.$nextTick();
        this.renderFigurGraph();
      };
      window.addEventListener('card:refresh', this._onCardRefresh);
    },

    destroy() {
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener('card:refresh', this._onCardRefresh);
    },

    // ── UI-Helper ────────────────────────────────────────────────────────────
    figurenKapitelListe() {
      return window.__app._deriveKapitel(window.__app.figuren, f => f.kapitel);
    },

    figurenSeitenListe() {
      // seiten ist ein Array von {kapitel, seite} — eigener Iterator nötig,
      // weil _deriveSeiten eine Eins-zu-Eins-Relation annimmt.
      const filters = window.__app.figurenFilters;
      if (!filters.kapitel) return [];
      const names = new Set();
      for (const f of (window.__app.figuren || [])) {
        for (const s of (f.seiten || [])) {
          if (s.kapitel === filters.kapitel && s.seite) names.add(s.seite);
        }
      }
      return window.__app._sortByPageOrder([...names]);
    },

    filteredFiguren() {
      const root = window.__app;
      const filters = root.figurenFilters;
      let result = root.figuren;
      const q = (filters.suche ?? '').toLowerCase();
      if (q) result = result.filter(f => (f.name ?? '').toLowerCase().includes(q));
      if (filters.kapitel) {
        result = result.filter(f =>
          (f.kapitel ?? []).some(k => k.name === filters.kapitel)
        );
      }
      if (filters.seite) {
        result = result.filter(f =>
          (f.seiten ?? []).some(s => s.kapitel === filters.kapitel && s.seite === filters.seite)
        );
      }
      return [...result].sort((a, b) => {
        const aK = Math.min(...(a.kapitel ?? []).map(k => root._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel ?? []).map(k => root._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        const aT = FIGUR_TYP_ORDER[a.typ] ?? 99;
        const bT = FIGUR_TYP_ORDER[b.typ] ?? 99;
        if (aT !== bT) return aT - bT;
        return (a.name ?? '').localeCompare(b.name ?? '', 'de');
      });
    },

    ...graphMethods,
  }));
}
