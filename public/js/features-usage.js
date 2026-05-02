// Feature-Usage-Tracking + Palette/Quick-Pill-Helpers am Root.
// Erfasst Karten-Öffnungen via $watch auf den Show-Flags (rising edge), POSTet
// pro User an /usage/track. Lädt /usage/recent beim Login, fällt auf
// DEFAULT_RECENT_KEYS zurück. Stellt Methoden für Hero-Bar/Quick-Pills bereit:
//   - featureLabel/Desc/IsActive/Activate
//   - openPalette
//   - loadRecentFeatures (idempotent)

import { FEATURES, DEFAULT_RECENT_KEYS, featureByKey, isFeatureAvailable } from './cards/feature-registry.js';
import { fetchJson } from './utils.js';

export const featuresUsageMethods = {
  // Wird in init() aufgerufen, sobald Alpine $watch bereitsteht.
  setupFeatureUsageWatchers() {
    if (this._featureUsageWatchersInstalled) return;
    this._featureUsageWatchersInstalled = true;

    for (const f of FEATURES) {
      const flag = f.flag;
      const key = f.key;
      // $watch liefert (newVal, oldVal) — false→true ist Öffnen.
      this.$watch(flag, (val, old) => {
        if (val && !old) this._trackFeatureUsage(key);
      });
    }
  },

  async _trackFeatureUsage(key) {
    try {
      await fetch('/usage/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
        credentials: 'same-origin',
      });
    } catch (e) {
      // Tracking ist Best-Effort, niemals UI blockieren.
    }
    // Liste lokal sofort umsortieren (kein Roundtrip nötig).
    this._bumpRecentFeatureKey(key);
  },

  _bumpRecentFeatureKey(key) {
    const cur = Array.isArray(this.recentFeatureKeys) ? this.recentFeatureKeys.slice() : [];
    const idx = cur.indexOf(key);
    if (idx !== -1) cur.splice(idx, 1);
    cur.unshift(key);
    this.recentFeatureKeys = cur.slice(0, 3);
  },

  async loadRecentFeatures() {
    try {
      const rows = await fetchJson('/usage/recent?limit=3');
      const keys = (Array.isArray(rows) ? rows : [])
        .map(r => r.feature_key)
        .filter(k => featureByKey(k));
      this.recentFeatureKeys = keys.length ? keys.slice(0, 3) : DEFAULT_RECENT_KEYS.slice();
    } catch (e) {
      this.recentFeatureKeys = DEFAULT_RECENT_KEYS.slice();
    }
  },

  // Template-Helpers ---------------------------------------------------------

  featureLabel(key) {
    const f = featureByKey(key);
    return f ? this.t(f.labelKey) : '';
  },

  featureDesc(key) {
    const f = featureByKey(key);
    return f ? this.t(f.descKey) : '';
  },

  isFeatureActive(key) {
    const f = featureByKey(key);
    return !!(f && this[f.flag]);
  },

  isFeatureEnabled(key) {
    const f = featureByKey(key);
    if (!f) return false;
    return isFeatureAvailable(f, { selectedBookId: this.selectedBookId, pages: this.pages });
  },

  activateFeature(key) {
    const f = featureByKey(key);
    if (!f) return;
    if (!this.isFeatureEnabled(key)) return;
    const fn = this[f.toggle];
    if (typeof fn !== 'function') return;
    fn.call(this);
  },

  openPalette() {
    window.dispatchEvent(new CustomEvent('palette:open'));
  },
};
