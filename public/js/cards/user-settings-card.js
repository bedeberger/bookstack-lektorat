// Alpine.data('userSettingsCard') — Sub-Komponente der Benutzer-Einstellungen
// (Profil, Default-Präferenzen). Fachlicher State lebt hier,
// `showUserSettingsCard` + `toggleUserSettingsCard` im Root. Daten werden nur
// beim erstmaligen Öffnen nachgeladen (user-bound, nicht buch-bound) — kein
// book:changed-Hook nötig.

import { userSettingsMethods } from '../user-settings.js';

export function registerUserSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('userSettingsCard', () => ({
    userSettingsProfile: null,
    userSettingsDefaultLanguage: '',
    userSettingsDefaultRegion: '',
    userSettingsDefaultBuchtyp: '',
    userSettingsFocusGranularity: 'paragraph',
    userSettingsLoading: false,
    userSettingsSaving: false,
    userSettingsSaved: false,
    userSettingsError: '',

    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showUserSettingsCard, async (visible) => {
        if (!visible) return;
        await this.loadUserSettings();
      });

      this._onViewReset = () => {
        this.userSettingsSaved = false;
        this.userSettingsError = '';
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...userSettingsMethods,
  }));
}
