// Figurenübersicht-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Die eigentliche Extraktion läuft als Teil von POST /jobs/komplett-analyse.

import { escHtml } from './utils.js';

export const figurenMethods = {
  async loadFiguren(bookId) {
    try {
      const data = await fetch('/figures/' + bookId).then(r => r.json());
      this.figuren = data?.figuren || [];
      this.figurenUpdatedAt = data?.updated_at || null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      console.error('[loadFiguren]', e);
    }
  },

  async saveFiguren() {
    try {
      await fetch('/figures/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: this.figuren }),
      });
    } catch (e) {
      console.error('[saveFiguren]', e);
    }
  },

  async toggleFiguresCard() {
    if (this.showFiguresCard) {
      await this.loadFiguren(this.selectedBookId);
      await this.$nextTick();
      this.renderFigurGraph();
      return;
    }
    this._closeOtherMainCards('figures');
    this.showFiguresCard = true;
    await this.loadFiguren(this.selectedBookId);
    await this.$nextTick();
    this.renderFigurGraph();
  },
};
