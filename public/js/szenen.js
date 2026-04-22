// Szenenanalyse-Methoden. Bleiben im Root-Spread, weil sie von mehreren
// Orten (komplett-Job, app-view._reloadVisibleBookCards, orteCard via
// $root.loadSzenen) gerufen werden. `this.szenen` geht über den Root-Proxy
// an Alpine.store('catalog').

import { fetchJson } from './utils.js';

export const szenenMethods = {
  async loadSzenen(bookId) {
    try {
      const data = await fetchJson('/figures/scenes/' + bookId);
      this.szenen = data?.szenen || [];
      this.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },
};
