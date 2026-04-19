// Schauplatz-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

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

  async toggleOrteCard() {
    if (this.showOrteCard) { await this.loadOrte(this.selectedBookId); return; }
    this._closeOtherMainCards('orte');
    this.showOrteCard = true;
    if (!this.szenen.length) await this.loadSzenen(this.selectedBookId);
    await this.loadOrte(this.selectedBookId);
  },
};
