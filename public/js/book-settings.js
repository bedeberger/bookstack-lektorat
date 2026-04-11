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
      const data = await fetch(`/booksettings/${this.selectedBookId}`).then(r => r.json());
      this.bookSettingsLanguage = data.language || 'de';
      this.bookSettingsRegion   = data.region   || 'CH';
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
          language: this.bookSettingsLanguage,
          region:   this.bookSettingsRegion,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
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
};
