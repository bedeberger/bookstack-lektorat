// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book-settings.js';

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsErzaehlperspektive: '',
    bookSettingsErzaehlzeit: '',
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',
    bookExportLoading: null,
    bookExportError: '',
    bookJobStats: null,
    bookJobStatsLoading: false,
    expandedJobType: null,
    bookJobRuns: {},
    bookJobRunsLoading: false,

    _onBookChanged: null,
    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showBookSettingsCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await Promise.all([this.loadBookSettings(), this.loadBookJobStats()]);
      });

      this._onBookChanged = () => {
        this.expandedJobType = null;
        this.bookJobRuns = {};
        if (!window.__app.showBookSettingsCard) return;
        if (!window.__app.selectedBookId) return;
        this.loadBookSettings();
        this.loadBookJobStats();
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => {
        this.bookSettingsSaved = false;
        this.bookSettingsError = '';
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset',  this._onViewReset);
    },

    ...bookSettingsMethods,
  }));
}
