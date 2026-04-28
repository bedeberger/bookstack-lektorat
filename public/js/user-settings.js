// Benutzer-Einstellungen (Profil, Default-Sprache/Region/Buchtyp, Danger:
// Buch-Historie löschen). Methoden werden in Alpine.data('userSettingsCard')
// gespreadet; Root-Zugriffe via window.__app.

import { fetchJson } from './utils.js';

export const userSettingsMethods = {
  async loadUserSettings() {
    this.userSettingsLoading = true;
    try {
      const data = await fetchJson('/me/settings');
      this.userSettingsProfile          = { email: data.email, name: data.name, created_at: data.created_at, last_login_at: data.last_login_at };
      this.userSettingsDefaultLanguage  = data.default_language  || '';
      this.userSettingsDefaultRegion    = data.default_region    || '';
      this.userSettingsDefaultBuchtyp   = data.default_buchtyp   || '';
      this.userSettingsFocusGranularity = data.focus_granularity || 'paragraph';
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
          default_language:  this.userSettingsDefaultLanguage  || null,
          default_region:    this.userSettingsDefaultRegion    || null,
          default_buchtyp:   this.userSettingsDefaultBuchtyp   || null,
          focus_granularity: this.userSettingsFocusGranularity || 'paragraph',
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      window.__app.focusGranularity = this.userSettingsFocusGranularity || 'paragraph';
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
    const book = window.__app.books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!confirm(window.__app.t('userSettings.resetConfirm', { name }))) return;

    this.bookHistoryResetLoading = true;
    this.bookHistoryResetMessage = '';
    this.bookHistoryResetError   = '';
    try {
      const r = await fetch(`/history/book/${bookId}`, { method: 'DELETE' });
      if (!r.ok) {
        let errData = null;
        try { errData = await r.json(); } catch (_) {}
        throw new Error(errData ? window.__app.tError(errData) : `HTTP ${r.status}`);
      }
      const data = await r.json();
      const d = data.deleted || {};
      this.bookHistoryResetMessage = window.__app.t('userSettings.resetSummary', {
        lektorate: d.page_checks || 0,
        reviews:   d.book_reviews || 0,
        chats:     d.chat_sessions || 0,
      });
      if (String(window.__app.selectedBookId) === String(bookId)) {
        window.__app.pageHistory       = [];
        window.__app.bookReviewHistory = [];
        window.dispatchEvent(new CustomEvent('chat:reset'));
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
    const typen = window.__app.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },
};
