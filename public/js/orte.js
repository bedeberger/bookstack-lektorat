// Schauplatz-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

export const orteMethods = {
  async loadOrte(bookId) {
    try {
      const data = await fetch('/locations/' + bookId).then(r => r.json());
      this.orte = data?.orte || [];
      this.orteUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadOrte]', e);
    }
  },

  async saveOrte() {
    try {
      await fetch('/locations/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orte: this.orte }),
      });
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
