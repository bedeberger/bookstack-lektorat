// Alpine.data('orteCard') — Sub-Komponente der Schauplatz-Karte.
//
// Eigener State: Meta-Flags (Loading/Progress/Status/PollTimer).
// Root behält:
//   - `orte` (im Store, als $root-Getter verfügbar)
//   - `orteFilters` (app-navigation.js schreibt darauf)
//   - `selectedOrtId` (Hash-Router)
//   - `loadOrte`, `saveOrte`, `orteFiltered` (Root-Spread; von komplett-Job,
//     Szenen-Trigger und _reloadVisibleBookCards genutzt)

export function registerOrteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('orteCard', () => ({
    orteLoading: false,
    orteProgress: 0,
    orteStatus: '',
    _ortePollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showOrteCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        const tasks = [window.__app.loadOrte(window.__app.selectedBookId)];
        if (!window.__app.szenen.length) tasks.push(window.__app.loadSzenen(window.__app.selectedBookId));
        await Promise.all(tasks);
      });

      this._onBookChanged = async () => {
        if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
        this.orteLoading = false;
        this.orteProgress = 0;
        this.orteStatus = '';
        if (!window.__app.showOrteCard) return;
        if (!window.__app.selectedBookId) return;
        await window.__app.loadOrte(window.__app.selectedBookId);
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
        this.orteLoading = false;
        this.orteProgress = 0;
        this.orteStatus = '';
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = (e) => {
        if (e.detail?.name !== 'orte') return;
        if (!window.__app.selectedBookId) return;
        window.__app.loadOrte(window.__app.selectedBookId);
      };
      window.addEventListener('card:refresh', this._onCardRefresh);
    },

    destroy() {
      if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
      if (this._onCardRefresh) window.removeEventListener('card:refresh', this._onCardRefresh);
    },
  }));
}
