// AdminDevicesCard-Methods. Wird im adminDevicesCard-Alpine-Scope gespreaded.
// Root-Zugriffe via window.__app. Liest aus /admin/devices (alle Device-Tokens
// der nativen Mac-Focus-Clients und der Chrome-Erweiterung: gemeldete
// Client-Version, Nutzungszaehler, letzte Aktivitaet). Read-only —
// Ausstellen/Widerrufen bleibt beim User unter /me. Veraltete Versionen werden
// gegen das neueste Release der jeweiligen Plattform verglichen (macOS, Android,
// Chrome-Erweiterung — drei eigene Repos, drei eigene Versionsstraenge).

import { tzOpts } from '../utils.js';

export const adminDevicesMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async devicesEnter() {
    if (this.devicesInitialized) return;
    this.devicesInitialized = true;
    await this._devicesLoad();
  },

  async _devicesLoad() {
    this.devicesLoading = true;
    this.devicesError = '';
    try {
      const r = await fetch('/admin/devices', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.devicesList = data.devices || [];
      this.devicesLatestVersions = data.latestVersions || {};
    } catch (e) {
      this.devicesError = e.message;
    } finally {
      this.devicesLoading = false;
    }
  },

  devicesRefresh() {
    this.devicesInitialized = false;
    return this.devicesEnter();
  },

  // ── Format ───────────────────────────────────────────────────────────────
  devicesFmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH',
      tzOpts({ dateStyle: 'medium', timeStyle: 'short' }));
  },

  // Status-Label: widerrufen / abgelaufen / aktiv.
  devicesStatus(d) {
    if (d.revoked_at) return window.__app.t('admin.devices.statusRevoked');
    if (d.expires_at && d.expires_at < new Date().toISOString()) return window.__app.t('admin.devices.statusExpired');
    return window.__app.t('admin.devices.statusActive');
  },

  // Rechteumfang des Tokens. Gelesen wird der Scope-String, nicht die Plattform:
  // welche Rechte ein Token hat, entscheidet lib/device-scopes.js, nicht wie sich
  // der Client nennt. Labels geteilt mit der Benutzer-Ansicht (gleicher Begriff).
  devicesScopeLabel(d) {
    const scopes = String(d?.scopes || '').split(',').map(s => s.trim());
    if (scopes.includes('content:write')) return window.__app.t('profile.devices.kind.device');
    if (scopes.includes('capture:write')) return window.__app.t('profile.devices.kind.capture');
    return window.__app.t('profile.devices.kind.none');
  },

  // Anzeige-Label: der Android-Client meldet seine Version als `android/2.0.0`
  // (Plattform-Prefix), der macOS-Client als reines `2.9`. Prefix fuer Anzeige
  // und Vergleich wegnormalisieren — wir wollen nur den dotted-Numeric-Teil.
  devicesVersionLabel(d) {
    return this._devicesCleanVersion(d.client_version) || d.client_version || '';
  },

  // Extrahiert den dotted-Numeric-Versionsteil aus einem evtl. praefixierten
  // String (`android/2.0.0` → `2.0.0`, `2.9` → `2.9`).
  _devicesCleanVersion(v) {
    if (!v) return '';
    const m = String(v).match(/\d+(?:\.\d+)*/);
    return m ? m[0] : '';
  },

  // Erkennt ein Android-Geraet. Das `platform`-Feld ist Freitext (vom User beim
  // Ausstellen des Tokens eingegeben → evtl. „Pixel", „Samsung", leer); darum
  // primaer am `client_version`-Prefix (`android/…`, vom Client gemeldet)
  // festmachen, das `platform`-Feld nur als Fallback.
  _devicesIsAndroid(d) {
    return /android/i.test(d.client_version || '') || /android/i.test(d.platform || '');
  },

  // Erkennt die Chrome-Erweiterung. Der Client meldet seine Version als
  // `chrome/<version>` (Praefix, analog `android/…`); fehlt der Praefix, faellt
  // die Erkennung auf das Freitext-`platform`-Feld zurueck (z.B. „Chrome").
  _devicesIsChrome(d) {
    return /chrome/i.test(d.client_version || '') || /chrome/i.test(d.platform || '');
  },

  // Neueste Version fuer die Plattform dieses Geraets (Chrome vs. Android vs.
  // macOS getrennt — jeder Repo hat seinen eigenen Versionsstrang).
  _devicesLatestForPlatform(d) {
    const v = this.devicesLatestVersions || {};
    if (this._devicesIsChrome(d)) return v.extension || null;
    if (this._devicesIsAndroid(d)) return v.android || null;
    return v.macos || null;
  },

  // Ist die installierte Version aelter als das neueste Release der jeweiligen
  // Plattform? (Reiner String-Vergleich der dotted-Version; nur bei sauberem
  // semver aussagekraeftig.)
  devicesIsOutdated(d) {
    const latest = this._devicesLatestForPlatform(d);
    const installed = this._devicesCleanVersion(d.client_version);
    if (!latest || !installed) return false;
    return this._devicesCmpVersion(installed, latest) < 0;
  },

  _devicesCmpVersion(a, b) {
    const pa = this._devicesCleanVersion(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = this._devicesCleanVersion(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  },
};
