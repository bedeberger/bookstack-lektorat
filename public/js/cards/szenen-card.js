// Alpine.data('szenenCard') — Sub-Komponente der Szenen-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `szenen` (im Store, als $root-Getter verfügbar)
//   - `szenenFilters` (Cross-Cutting via Alpine-Scope-Resolution)
//   - `loadSzenen`, `szenenFiltered`, `szenenNachKapitel`, `szenenNachSeite`
//     (Root-Spread; von komplett-Job und anderen genutzt)

export function registerSzenenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('szenenCard', () => ({
    szenenLoading: false,
    szenenProgress: 0,
    szenenStatus: '',
    szenenUebersichtOpen: false,
    _szenenPollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showSzenenCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await window.__app.loadSzenen(window.__app.selectedBookId);
      });

      this._onBookChanged = async () => {
        if (this._szenenPollTimer) { clearInterval(this._szenenPollTimer); this._szenenPollTimer = null; }
        this.szenenLoading = false;
        this.szenenProgress = 0;
        this.szenenStatus = '';
        if (!window.__app.showSzenenCard) return;
        if (!window.__app.selectedBookId) return;
        await window.__app.loadSzenen(window.__app.selectedBookId);
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._szenenPollTimer) { clearInterval(this._szenenPollTimer); this._szenenPollTimer = null; }
        this.szenenLoading = false;
        this.szenenProgress = 0;
        this.szenenStatus = '';
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = (e) => {
        if (e.detail?.name !== 'szenen') return;
        if (!window.__app.selectedBookId) return;
        window.__app.loadSzenen(window.__app.selectedBookId);
      };
      window.addEventListener('card:refresh', this._onCardRefresh);
    },

    destroy() {
      if (this._szenenPollTimer) { clearInterval(this._szenenPollTimer); this._szenenPollTimer = null; }
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener('card:refresh', this._onCardRefresh);
    },
  }));
}
