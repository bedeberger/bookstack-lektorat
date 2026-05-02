// Feature-Usage-Tracking am Root.
// Erfasst Karten-Öffnungen via $watch auf den Show-Flags (rising edge), POSTet
// pro User an /usage/track. Lädt /usage/recent beim Login, fällt auf
// DEFAULT_RECENT_KEYS zurück. Die Liste wird ausschliesslich von der
// Command-Palette gelesen (Section „Zuletzt"). Hero-Trigger ruft openPalette().

import { FEATURES, DEFAULT_RECENT_KEYS, featureByKey } from './cards/feature-registry.js';
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

  // Letzte N Seiten des aktuellen Buchs (Command-Palette „Zuletzt"-Sektion).
  // Wird bei Buch-Wechsel + nach Tracking-Bumps neu geladen.
  async loadRecentPages(bookId) {
    if (!bookId) { this.recentPageIds = []; return; }
    try {
      const rows = await fetchJson(`/usage/page/recent?book_id=${encodeURIComponent(bookId)}&limit=5`);
      this.recentPageIds = (Array.isArray(rows) ? rows : [])
        .map(r => r.page_id)
        .filter(Number.isFinite);
    } catch (e) {
      this.recentPageIds = [];
    }
  },

  // Best-Effort-Tracking. Aufgerufen aus selectPage(). Lokale Liste wird
  // sofort umsortiert, damit Palette ohne Roundtrip aktuell ist.
  _trackPageUsage(pageId, bookId) {
    if (!pageId || !bookId) return;
    try {
      fetch('/usage/page/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: pageId, book_id: bookId }),
        credentials: 'same-origin',
      }).catch(() => {});
    } catch {}
    const cur = Array.isArray(this.recentPageIds) ? this.recentPageIds.slice() : [];
    const idx = cur.indexOf(pageId);
    if (idx !== -1) cur.splice(idx, 1);
    cur.unshift(pageId);
    this.recentPageIds = cur.slice(0, 5);
  },

  openPalette() {
    window.dispatchEvent(new CustomEvent('palette:open'));
  },
};
