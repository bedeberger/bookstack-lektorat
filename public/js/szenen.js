// Szenenanalyse-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const szenenMethods = {
  async toggleSzenenCard() {
    if (this.showSzenenCard) { this.showSzenenCard = false; return; }
    this._closeOtherMainCards('szenen');
    this.showSzenenCard = true;
    if (!this.figuren.length) await this.loadFiguren(this.selectedBookId);
    if (!this.orte.length) await this.loadOrte(this.selectedBookId);
    await this.loadSzenen(this.selectedBookId);
  },

  async loadSzenen(bookId) {
    try {
      const data = await fetch('/figures/scenes/' + bookId).then(r => r.json());
      this.szenen = data?.szenen || [];
      this.szenenUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadSzenen]', e);
    }
  },

};
