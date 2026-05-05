// Benutzer-Einstellungen (Profil, Default-Sprache/Region/Buchtyp).
// Methoden werden in Alpine.data('userSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

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

  /** Buchtyp-Liste abhängig von der gewählten Default-Sprache (fallback: de). */
  userSettingsBuchtypen() {
    const lang = this.userSettingsDefaultLanguage || 'de';
    const typen = window.__app.promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },

  userSettingsBuchtypOptions() {
    return this.userSettingsBuchtypen().map(t => ({ value: t.key, label: t.label }));
  },

  userSettingsFocusOptions() {
    const app = window.__app;
    return [
      { value: 'paragraph',       label: app.t('profile.focus.paragraph') },
      { value: 'sentence',        label: app.t('profile.focus.sentence') },
      { value: 'window-3',        label: app.t('profile.focus.window3') },
      { value: 'typewriter-only', label: app.t('profile.focus.typewriterOnly') },
    ];
  },
};
