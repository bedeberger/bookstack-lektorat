// Figurenentwicklungsbögen-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const charakterentwicklungMethods = {
  async toggleCharacterArcsCard() {
    if (this.showCharacterArcsCard) { this.showCharacterArcsCard = false; return; }
    this._closeOtherMainCards('characterArcs');
    this.showCharacterArcsCard = true;
    if (!this.figuren?.length) await this.loadFiguren(this.selectedBookId);
    await this.loadCharacterArcs();
  },

  async loadCharacterArcs() {
    if (!this.selectedBookId) return;
    try {
      const data = await fetch('/figures/character-arcs/' + this.selectedBookId).then(r => r.json());
      this.characterArcs = data?.entwicklungsboegen || null;
      this.characterArcsUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadCharacterArcs]', e);
    }
  },

  // Gibt den arc_typ als lesbares Label zurück
  arcTypLabel(typ) {
    const map = {
      'Reifebogen': 'Reife',
      'Verfallsbogen': 'Verfall',
      'Erlösungsbogen': 'Erlösung',
      'Tragischer Bogen': 'Tragik',
      'Wandlungsbogen': 'Wandlung',
      'Stasis': 'Stasis',
    };
    return map[typ] || (typ || '');
  },

  // Gibt eine CSS-Klasse für den arc_typ zurück (für Farb-Badges)
  arcTypClass(typ) {
    const map = {
      'Reifebogen': 'arc-reife',
      'Verfallsbogen': 'arc-verfall',
      'Erlösungsbogen': 'arc-erloesung',
      'Tragischer Bogen': 'arc-tragik',
      'Wandlungsbogen': 'arc-wandlung',
      'Stasis': 'arc-stasis',
    };
    return map[typ] || 'arc-andere';
  },

  // Gibt die Figur-Daten zur fig_id aus dem figuren-Array zurück
  arcFigurData(figId) {
    return (this.figuren || []).find(f => f.id === figId) || null;
  },

  // Entwicklungsbögen gefiltert + sortiert
  characterArcsSorted() {
    if (!this.characterArcs) return [];
    const typOrder = ['Reifebogen', 'Verfallsbogen', 'Erlösungsbogen', 'Tragischer Bogen', 'Wandlungsbogen', 'Stasis'];
    return [...this.characterArcsFiltered].sort((a, b) => {
      const ta = typOrder.indexOf(a.arc_typ);
      const tb = typOrder.indexOf(b.arc_typ);
      return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
    });
  },
};
