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
      this.$watch(() => this.$root.showOrteCard, async (visible) => {
        if (!visible) return;
        if (!this.$root.selectedBookId) return;
        if (!this.$root.szenen.length) await this.$root.loadSzenen(this.$root.selectedBookId);
        await this.$root.loadOrte(this.$root.selectedBookId);
      });

      this._onBookChanged = async () => {
        if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
        this.orteLoading = false;
        this.orteProgress = 0;
        this.orteStatus = '';
        if (!this.$root.showOrteCard) return;
        if (!this.$root.selectedBookId) return;
        await this.$root.loadOrte(this.$root.selectedBookId);
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
        if (!this.$root.selectedBookId) return;
        this.$root.loadOrte(this.$root.selectedBookId);
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
