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
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
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
          language:     this.bookSettingsLanguage,
          region:       this.bookSettingsRegion,
          buchtyp:      this.bookSettingsBuchtyp     || null,
          buch_kontext: this.bookSettingsBuchKontext || null,
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

  async resetBookHistory() {
    if (!this.selectedBookId) return;
    const name = this.selectedBookName || 'dieses Buch';
    if (!confirm(
      `Alle deine Lektorate, Buchbewertungen und Chats zu «${name}» löschen?\n\n` +
      `Andere Nutzer sind nicht betroffen. Diese Aktion ist nicht rückgängig zu machen.`
    )) return;

    this.bookHistoryResetLoading = true;
    this.bookHistoryResetMessage = '';
    this.bookHistoryResetError   = '';
    try {
      const r = await fetch(`/history/book/${this.selectedBookId}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Löschen fehlgeschlagen');
      const d = data.deleted || {};
      this.bookHistoryResetMessage =
        `Gelöscht: ${d.page_checks || 0} Lektorate, ${d.book_reviews || 0} Bewertungen, ${d.chat_sessions || 0} Chats.`;
      this.pageHistory      = [];
      this.bookReviewHistory = [];
      this.chatSessions     = [];
      this.chatMessages     = [];
      this.chatSessionId    = null;
      setTimeout(() => { this.bookHistoryResetMessage = ''; }, 6000);
    } catch (e) {
      this.bookHistoryResetError = e.message;
    } finally {
      this.bookHistoryResetLoading = false;
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
