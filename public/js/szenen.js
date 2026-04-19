// Szenenanalyse-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { fetchJson } from './utils.js';

export const szenenMethods = {
  async toggleSzenenCard() {
    if (this.showSzenenCard) { await this.loadSzenen(this.selectedBookId); return; }
    this._closeOtherMainCards('szenen');
    this.showSzenenCard = true;
    if (!this.figuren.length) await this.loadFiguren(this.selectedBookId);
    if (!this.orte.length) await this.loadOrte(this.selectedBookId);
    await this.loadSzenen(this.selectedBookId);
  },

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
