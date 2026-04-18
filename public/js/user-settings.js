export const userSettingsMethods = {

  async toggleUserSettingsCard() {
    if (this.showUserSettingsCard) { this.showUserSettingsCard = false; return; }
    this._closeOtherMainCards('userSettings');
    this.showUserSettingsCard = true;
    await this.loadUserSettings();
  },

  async loadUserSettings() {
    this.userSettingsLoading = true;
    try {
      const data = await fetch('/me/settings').then(r => r.json());
      this.userSettingsProfile         = { email: data.email, name: data.name, created_at: data.created_at, last_login_at: data.last_login_at };
      this.userSettingsDefaultLanguage = data.default_language || '';
      this.userSettingsDefaultRegion   = data.default_region   || '';
      this.userSettingsDefaultBuchtyp  = data.default_buchtyp  || '';
    } catch (e) {
      console.error('[user-settings] Laden fehlgeschlagen:', e);
    } finally {
      this.userSettingsLoading = false;
    }
  },

  async saveUserSettings() {
    this.userSettingsSaving = true;
    this.userSettingsSaved  = false;
    this.userSettingsError  = '';
    try {
      const r = await fetch('/me/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_language: this.userSettingsDefaultLanguage || null,
          default_region:   this.userSettingsDefaultRegion   || null,
          default_buchtyp:  this.userSettingsDefaultBuchtyp  || null,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || this.t('common.saveFailed'));
      this.userSettingsSaved = true;
      setTimeout(() => { this.userSettingsSaved = false; }, 3000);
    } catch (e) {
      this.userSettingsError = e.message;
    } finally {
      this.userSettingsSaving = false;
    }
  },

  async resetBookHistory() {
    const bookId = this.userSettingsDangerBookId;
    if (!bookId) return;
    const book = this.books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!confirm(this.t('userSettings.resetConfirm', { name }))) return;

    this.bookHistoryResetLoading = true;
    this.bookHistoryResetMessage = '';
    this.bookHistoryResetError   = '';
    try {
      const r = await fetch(`/history/book/${bookId}`, { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || this.t('common.deleteFailed'));
      const d = data.deleted || {};
      this.bookHistoryResetMessage = this.t('userSettings.resetSummary', {
        lektorate: d.page_checks || 0,
        reviews:   d.book_reviews || 0,
        chats:     d.chat_sessions || 0,
      });
      if (String(this.selectedBookId) === String(bookId)) {
        this.pageHistory       = [];
        this.bookReviewHistory = [];
        this.chatSessions      = [];
        this.chatMessages      = [];
        this.chatSessionId     = null;
      }
      setTimeout(() => { this.bookHistoryResetMessage = ''; }, 6000);
    } catch (e) {
      this.bookHistoryResetError = e.message;
    } finally {
      this.bookHistoryResetLoading = false;
    }
  },

  /** Buchtyp-Liste abhängig von der gewählten Default-Sprache (fallback: de). */
  userSettingsBuchtypen() {
    const lang = this.userSettingsDefaultLanguage || 'de';
    const typen = this.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },
};
