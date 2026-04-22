// Alpine.data('kontinuitaetCard') — Sub-Komponente der Kontinuitätsprüfung.
//
// Eigener State: kontinuitaetResult, kontinuitaetStatus, kontinuitaetProgress,
// kontinuitaetLoading, kontinuitaetFilters, _kontinuitaetPollTimer.
// Root-Zugriffe (figuren, tree, pages, t, selectedBookId, selectedBookName,
// loadFiguren, selectPage, _runningJobStatus, _sortByChapterOrder) via $root.
//
// Einzige Sub-Komponente mit Job-Polling (läuft ohne createJobFeature,
// weil die Factory aktuell Root-Spread voraussetzt; Duplikation akzeptabel,
// bis die Reviews-Karten migriert werden und eine Sub-Variante nötig wird).
//
// Lifecycle:
//   - $watch(showKontinuitaetCard): bei Öffnen Figuren sicherstellen + History laden
//   - book:changed: State zurück, History fürs neue Buch laden (wenn sichtbar)
//   - view:reset: eigenen State nullen, Poll-Timer stoppen
//   - card:refresh (name==='kontinuitaet'): History-Refresh bei erneutem Klick
//     auf die bereits offene Karte (bildet das onOpenWhenOpen von vorher nach)

import { kontinuitaetMethods } from '../kontinuitaet.js';

export function registerKontinuitaetCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kontinuitaetCard', () => ({
    kontinuitaetResult: null,
    kontinuitaetLoading: false,
    kontinuitaetProgress: 0,
    kontinuitaetStatus: '',
    kontinuitaetFilters: { figurId: '', kapitel: '' },
    _kontinuitaetPollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onCardRefresh: null,

    init() {
      this.$watch(() => window.__app.showKontinuitaetCard, async (visible) => {
        if (!visible) return;
        const root = window.__app;
        if (!root.selectedBookId) return;
        if (!root.figuren?.length) await root.loadFiguren(root.selectedBookId);
        await this._loadKontinuitaetHistory();
      });

      this._onBookChanged = async () => {
        // Läuft ein Poll-Timer fürs alte Buch? Stoppen, sonst trifft er das falsche.
        if (this._kontinuitaetPollTimer) {
          clearInterval(this._kontinuitaetPollTimer);
          this._kontinuitaetPollTimer = null;
        }
        this.kontinuitaetResult = null;
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        this.kontinuitaetStatus = '';
        this.kontinuitaetFilters.figurId = '';
        this.kontinuitaetFilters.kapitel = '';
        if (!window.__app.showKontinuitaetCard) return;
        if (!window.__app.selectedBookId) return;
        await this._loadKontinuitaetHistory();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        if (this._kontinuitaetPollTimer) {
          clearInterval(this._kontinuitaetPollTimer);
          this._kontinuitaetPollTimer = null;
        }
        this.kontinuitaetResult = null;
        this.kontinuitaetStatus = '';
        this.kontinuitaetProgress = 0;
        this.kontinuitaetLoading = false;
        this.kontinuitaetFilters.figurId = '';
        this.kontinuitaetFilters.kapitel = '';
      };
      window.addEventListener('view:reset', this._onViewReset);

      this._onCardRefresh = (e) => {
        if (e.detail?.name !== 'kontinuitaet') return;
        this._loadKontinuitaetHistory();
      };
      window.addEventListener('card:refresh', this._onCardRefresh);
    },

    destroy() {
      if (this._kontinuitaetPollTimer) { clearInterval(this._kontinuitaetPollTimer); this._kontinuitaetPollTimer = null; }
      if (this._onBookChanged)  window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener('view:reset',  this._onViewReset);
      if (this._onCardRefresh)  window.removeEventListener('card:refresh', this._onCardRefresh);
    },

    ...kontinuitaetMethods,
  }));
}
