// Benutzer-Einstellungen (Profil, Default-Sprache/Region/Buchtyp).
// Methoden werden in Alpine.data('userSettingsCard') gespreadet;
// Root-Zugriffe via window.__app.

import { fetchJson } from './utils.js';

export const userSettingsMethods = {
  async loadUserSettings() {
    this.userSettingsLoading = true;
    try {
      const data = await fetchJson('/me/settings');
      this.userSettingsProfile          = { email: data.email, name: data.display_name, created_at: data.created_at, last_login_at: data.last_login_at };
      this.userSettingsDefaultLanguage  = data.default_language  || '';
      this.userSettingsDefaultRegion    = data.default_region    || '';
      this.userSettingsDefaultBuchtyp   = data.default_buchtyp   || '';
      this.userSettingsFocusGranularity = data.focus_granularity || 'paragraph';
      this.userSettingsDailyGoal        = data.daily_goal_minutes || 0;
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
          daily_goal_minutes: Math.max(0, Math.min(1440, Math.round(Number(this.userSettingsDailyGoal) || 0))),
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      window.__app.focusGranularity = this.userSettingsFocusGranularity || 'paragraph';
      const region = this.userSettingsDefaultRegion || (Alpine.store('shell').uiLocale === 'en' ? 'US' : 'CH');
      Alpine.store('shell').defaultRegion = region;
      document.documentElement.setAttribute('lang', `${Alpine.store('shell').uiLocale || 'de'}-${region}`);
      this.userSettingsSaved = true;
      if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
      this._savedAtTimer = setTimeout(() => { this.userSettingsSaved = false; this._savedAtTimer = null; }, 2500);
    } catch (e) {
      this.userSettingsError = e.message;
    } finally {
      this.userSettingsSaving = false;
    }
  },

  /** Buchtyp-Liste abhängig von der gewählten Default-Sprache (fallback: de). */
  userSettingsBuchtypen() {
    const lang = this.userSettingsDefaultLanguage || 'de';
    const typen = Alpine.store('shell').promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },

  userSettingsBuchtypOptions() {
    return this.userSettingsBuchtypen().map(t => ({ value: t.key, label: t.label }));
  },

  userSettingsUiLangOptions() {
    const app = window.__app;
    return [
      { value: 'de', label: app.t('lang.de') },
      { value: 'en', label: app.t('lang.en') },
    ];
  },

  userSettingsDefaultLangOptions() {
    const app = window.__app;
    return [
      { value: '',   label: app.t('common.notSet') },
      { value: 'de', label: app.t('lang.de') },
      { value: 'en', label: app.t('lang.en') },
    ];
  },
  // Region-Optionen werden inline im x-effect gebaut (reaktiv auf
  // userSettingsDefaultLanguage) — Method-Indirection trackt das nicht
  // zuverlässig, siehe DESIGN.md „Reaktivität bei Datenquelle aus Karten-Scope".

  userSettingsFocusOptions() {
    const app = window.__app;
    return [
      { value: 'paragraph',       label: app.t('profile.focus.paragraph') },
      { value: 'sentence',        label: app.t('profile.focus.sentence') },
      { value: 'window-3',        label: app.t('profile.focus.window3') },
      { value: 'typewriter-only', label: app.t('profile.focus.typewriterOnly') },
    ];
  },

  // ── Device-Tokens (native Clients, z.B. Mac-Focus-Writer) ───────────────────
  // Plain-Token kommt vom Server NUR einmal nach POST und bleibt in
  // `deviceTokensJustCreated`, bis der User ihn wegklickt. DB haelt nur den Hash.

  async loadDeviceTokens() {
    this.deviceTokensLoading = true;
    this.deviceTokensError = '';
    try {
      const data = await fetchJson('/me/device-tokens');
      this.deviceTokensList = Array.isArray(data.tokens) ? data.tokens : [];
    } catch (e) {
      this.deviceTokensError = e.message;
    } finally {
      this.deviceTokensLoading = false;
    }
  },

  async deviceTokensCreate() {
    const name = (this.deviceTokensNewName || '').trim();
    if (!name) { this.deviceTokensError = window.__app.t('profile.devices.errorNameRequired'); return; }
    this.deviceTokensCreating = true;
    this.deviceTokensError = '';
    try {
      const r = await fetch('/me/device-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ device_name: name, kind: this.deviceTokensNewKind || 'device' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(window.__app.tError ? window.__app.tError(j) : (j.error_code || `HTTP ${r.status}`));
      this.deviceTokensJustCreated = j.token;
      this.deviceTokensNewName = '';
      await this.loadDeviceTokens();
    } catch (e) {
      this.deviceTokensError = e.message;
    } finally {
      this.deviceTokensCreating = false;
    }
  },

  async deviceTokensRevoke(id) {
    if (!confirm(window.__app.t('profile.devices.confirmRevoke'))) return;
    try {
      const r = await fetch(`/me/device-tokens/${id}/revoke`, { method: 'POST', credentials: 'same-origin' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error_code || `HTTP ${r.status}`); }
      await this.loadDeviceTokens();
    } catch (e) { this.deviceTokensError = e.message; }
  },

  async deviceTokensDelete(id) {
    if (!confirm(window.__app.t('profile.devices.confirmDelete'))) return;
    try {
      const r = await fetch(`/me/device-tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error_code || `HTTP ${r.status}`); }
      await this.loadDeviceTokens();
    } catch (e) { this.deviceTokensError = e.message; }
  },

  deviceTokensDismissPlain() {
    this.deviceTokensJustCreated = null;
  },

  // Rechteumfang eines bestehenden Tokens fuer die Liste. Gelesen wird der
  // Scope-String vom Server, nicht die beim Anlegen gewaehlte Art — ein Token,
  // dessen Scopes nicht mehr zu einer der beiden Arten passen, soll als solches
  // sichtbar sein und nicht stillschweigend als „Gerät" durchgehen.
  deviceTokenScopeLabel(t) {
    const app = window.__app;
    const scopes = String(t?.scopes || '').split(',').map(s => s.trim());
    if (scopes.includes('content:write')) return app.t('profile.devices.kind.device');
    if (scopes.includes('capture:write')) return app.t('profile.devices.kind.capture');
    return app.t('profile.devices.kind.none');
  },

  // ── macOS-App-Download (schreibwerkstatt-focuseditor) ───────────────────────
  // latest-Release-Metadaten vom Server (GitHub-Public-API-Proxy). Wirft nie;
  // bei { available:false } wird der Abschnitt schlicht nicht gerendert.
  async loadMacRelease() {
    try {
      const data = await fetchJson('/content/macclient/release.json');
      this.macRelease = data && data.available ? data : { available: false };
    } catch (e) {
      console.error('[user-settings] Mac-Release laden fehlgeschlagen:', e);
      this.macRelease = { available: false };
    }
  },

  /** Dateigröße des .dmg in MB, locale-formatiert. */
  macReleaseSizeMb() {
    const bytes = this.macRelease?.dmg?.sizeBytes || 0;
    if (!bytes) return '';
    return (bytes / 1048576).toLocaleString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH', { maximumFractionDigits: 1 });
  },

  /** Dezent erkennen, ob der Besucher auf macOS ist (nur für einen Hinweis). */
  macReleaseIsMacPlatform() {
    return /Mac/i.test(navigator.platform || navigator.userAgent || '');
  },

  // ── Android-App-Download (schreibwerkstatt-mobile) ──────────────────────────
  // latest-Release-Metadaten vom Server (GitHub-Public-API-Proxy). Wirft nie;
  // bei { available:false } wird der Abschnitt schlicht nicht gerendert.
  async loadAndroidRelease() {
    try {
      const data = await fetchJson('/content/android/release.json');
      this.androidRelease = data && data.available ? data : { available: false };
    } catch (e) {
      console.error('[user-settings] Android-Release laden fehlgeschlagen:', e);
      this.androidRelease = { available: false };
    }
  },

  /** Dateigröße des .apk in MB, locale-formatiert. */
  androidReleaseSizeMb() {
    const bytes = this.androidRelease?.apk?.sizeBytes || 0;
    if (!bytes) return '';
    return (bytes / 1048576).toLocaleString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH', { maximumFractionDigits: 1 });
  },

  /** Dezent erkennen, ob der Besucher auf Android ist (nur für einen Hinweis). */
  androidReleaseIsAndroidPlatform() {
    return /Android/i.test(navigator.userAgent || '');
  },
};
