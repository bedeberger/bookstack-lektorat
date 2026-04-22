// Schauplatz-Methoden am Root-Spread (von app-view, Szenen-Trigger, toggleOrteCard gerufen).

import { fetchJson } from './utils.js';

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetchJson('/locations/' + bookId);
      this.orte = data?.orte || [];
      this.orteUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadOrte]', e);
    }
  },

  async saveOrte() {
    try {
      const r = await fetch('/locations/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orte: this.orte }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('[saveOrte]', e);
    }
  },
};
