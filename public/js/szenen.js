// Szenenanalyse-Methoden am Root-Spread (von komplett-Job, app-view, orteCard gerufen).

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
