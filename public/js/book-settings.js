// Buch-Einstellungen (Sprache, Region, Buchtyp, Perspektive, Zeit, Kontext).
// Methoden werden in Alpine.data('bookSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

import { fetchJson } from './utils.js';

export const bookSettingsMethods = {
  async loadBookSettings() {
    if (!window.__app.selectedBookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${window.__app.selectedBookId}`);
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
    if (!window.__app.selectedBookId) return;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    try {
      const r = await fetch(`/booksettings/${window.__app.selectedBookId}`, {
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
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
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
    const typen = window.__app.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },

  async loadBookJobStats() {
    if (!window.__app.selectedBookId) {
      this.bookJobStats = null;
      return;
    }
    this.bookJobStatsLoading = true;
    try {
      this.bookJobStats = await fetchJson(`/jobs/stats?book_id=${encodeURIComponent(window.__app.selectedBookId)}`);
    } catch (e) {
      console.error('[book-settings] Job-Statistiken laden fehlgeschlagen:', e);
      this.bookJobStats = [];
    } finally {
      this.bookJobStatsLoading = false;
    }
  },

  // Drill-Down: Typ-Zeile aufklappen → letzte N Runs nachladen.
  // Cache pro Typ in bookJobRuns; Re-Toggle schliesst nur, lädt nicht neu.
  async toggleJobRuns(type) {
    if (this.expandedJobType === type) {
      this.expandedJobType = null;
      return;
    }
    this.expandedJobType = type;
    if (this.bookJobRuns[type]) return;
    this.bookJobRunsLoading = true;
    try {
      const bookId = window.__app.selectedBookId;
      const runs = await fetchJson(`/jobs/runs?book_id=${encodeURIComponent(bookId)}&type=${encodeURIComponent(type)}&limit=20`);
      this.bookJobRuns[type] = runs;
    } catch (e) {
      console.error('[book-settings] Job-Runs laden fehlgeschlagen:', e);
      this.bookJobRuns[type] = [];
    } finally {
      this.bookJobRunsLoading = false;
    }
  },
};
