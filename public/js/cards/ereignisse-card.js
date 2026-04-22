// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Root behält:
//   - `globalZeitstrahl` (im Store, via $root-Getter auch am Root sichtbar)
//   - `ereignisseFilters` (app-navigation.js schreibt darauf)
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)

export function registerEreignisseCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ereignisseCard', () => ({
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    _consolidatePollTimer: null,
    _ereignisseExtractPollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showEreignisseCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await window.__app._reloadZeitstrahl();
      });

      this._onBookChanged = async () => {
        if (this._consolidatePollTimer) { clearInterval(this._consolidatePollTimer); this._consolidatePollTimer = null; }
        if (this._ereignisseExtractPollTimer) { clearInterval(this._ereignisseExtractPollTimer); this._ereignisseExtractPollTimer = null; }
        this.ereignisseLoading = false;
        this.ereignisseProgress = 0;
        this.ereignisseStatus = '';
        this.zeitstrahlConsolidating = false;
        this.zeitstrahlProgress = 0;
        this.zeitstrahlStatus = '';
        if (!window.__app.showEreignisseCard) return;
        if (!window.__app.selectedBookId) return;
        await window.__app._reloadZeitstrahl();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._consolidatePollTimer) { clearInterval(this._consolidatePollTimer); this._consolidatePollTimer = null; }
        if (this._ereignisseExtractPollTimer) { clearInterval(this._ereignisseExtractPollTimer); this._ereignisseExtractPollTimer = null; }
        this.ereignisseLoading = false;
        this.ereignisseProgress = 0;
        this.ereignisseStatus = '';
        this.zeitstrahlConsolidating = false;
        this.zeitstrahlProgress = 0;
        this.zeitstrahlStatus = '';
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = (e) => {
        if (e.detail?.name !== 'ereignisse') return;
        window.__app._reloadZeitstrahl();
      };
      window.addEventListener('card:refresh', this._onCardRefresh);
    },

    destroy() {
      if (this._consolidatePollTimer) { clearInterval(this._consolidatePollTimer); this._consolidatePollTimer = null; }
      if (this._ereignisseExtractPollTimer) { clearInterval(this._ereignisseExtractPollTimer); this._ereignisseExtractPollTimer = null; }
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener('card:refresh', this._onCardRefresh);
    },

    // UI-Helper. Lesen $root-Filter + -Daten.
    ereignisseKapitelListe() {
      return window.__app._deriveKapitel(window.__app.globalZeitstrahl, ev => ev.kapitel);
    },

    ereignisseSeitenListe() {
      return window.__app._deriveSeiten(
        window.__app.globalZeitstrahl,
        window.__app.ereignisseFilters.kapitel,
        ev => ev.kapitel,
        ev => Array.isArray(ev.seiten) ? ev.seiten : ev.seite,
      );
    },

    filteredEreignisse() {
      const root = window.__app;
      const filters = root.ereignisseFilters;
      let result = root.globalZeitstrahl;
      if (filters.suche) {
        const q = filters.suche.toLowerCase();
        result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
      }
      if (filters.figurId) {
        result = result.filter(ev => ev.figuren.some(f => f.id === filters.figurId));
      }
      if (filters.kapitel) {
        result = result.filter(ev => {
          const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
          return kap.includes(filters.kapitel);
        });
      }
      if (filters.seite && filters.kapitel) {
        result = result.filter(ev => {
          const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
          return seiten.includes(filters.seite);
        });
      }
      return result;
    },
  }));
}
