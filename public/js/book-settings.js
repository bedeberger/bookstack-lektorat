import { fetchJson } from './utils.js';

export const bookSettingsMethods = {

  async toggleBookSettingsCard() {
    if (this.showBookSettingsCard) { await this.loadBookSettings(); return; }
    this._closeOtherMainCards('bookSettings');
    this.showBookSettingsCard = true;
    await this.loadBookSettings();
  },

  async loadBookSettings() {
    if (!this.selectedBookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${this.selectedBookId}`);
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
      this.bookSettingsErzaehlperspektive = data.erzaehlperspektive || '';
      this.bookSettingsErzaehlzeit        = data.erzaehlzeit        || '';
    } catch (e) {
      console.error('[book-settings] Laden fehlgeschlagen:', e);
    } finally {
      this.bookSettingsLoading = false;
    }
  },

  async saveBookSettings() {
    if (!this.selectedBookId) return;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    try {
      const r = await fetch(`/booksettings/${this.selectedBookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language:          this.bookSettingsLanguage,
          region:            this.bookSettingsRegion,
          buchtyp:           this.bookSettingsBuchtyp              || null,
          buch_kontext:      this.bookSettingsBuchKontext          || null,
          erzaehlperspektive: this.bookSettingsErzaehlperspektive  || null,
          erzaehlzeit:       this.bookSettingsErzaehlzeit          || null,
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? this.tError(data) : `HTTP ${r.status}`);
      }
      this.bookSettingsSaved = true;
      setTimeout(() => { this.bookSettingsSaved = false; }, 3000);
    } catch (e) {
      this.bookSettingsError = e.message;
    } finally {
      this.bookSettingsSaving = false;
    }
  },

  bookSettingsLocaleDisplay() {
    const map = {
      'de-CH': 'Deutsch (Schweiz)',
      'de-DE': 'Deutsch (Deutschland)',
      'en-US': 'English (USA)',
      'en-GB': 'English (UK)',
    };
    return map[`${this.bookSettingsLanguage}-${this.bookSettingsRegion}`] || `${this.bookSettingsLanguage}-${this.bookSettingsRegion}`;
  },

  /** Gibt die Buchtyp-Liste für die aktuelle Sprache zurück (aus promptConfig). */
  bookSettingsBuchtypen() {
    const lang = this.bookSettingsLanguage || 'de';
    const typen = this.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },
};
