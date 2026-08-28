// Schauplatz-Tile: Count + Top-Liste + Präsenz-Matrix.
// Datenquelle: /locations/:book_id liefert pro Ort `kapitel: [{name, haeufigkeit}]`
// (sortiert haeufigkeit desc) und `figuren: [fig_id]`. Kein Geo, keine Koordinaten.
// Ranking: Summe der Kapitel-Häufigkeiten = Gesamt-Präsenz im Buch. Bevorzugt
// mehrfach erwähnte Schauplätze (total >= 2); Einmal-Nennungen nur als Fallback.
//
// Spaltenauswahl, Skalierung und Zeilen-Aufbau der Matrix teilt sich das Modul
// mit Figuren und Motiven — siehe ./presence.js.
import { buildPresenceMatrix, bucketByRoot } from './presence.js';
import { rankPreferRecurring } from './ranking.js';

export const orteMethods = {
  overviewOrteCount() { return (this.overviewOrte || []).length; },

  overviewTopOrte() {
    const orte = this.overviewOrte || [];
    return this._memo('topOrte', [orte], () => {
      const rows = orte.map(o => {
        const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
        const total = kap.reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0);
        return { id: o.id, name: o.name, typ: o.typ || 'andere', total };
      });
      return rankPreferRecurring(rows, { valueOf: o => o.total });
    });
  },

  // Schauplatz-Präsenz-Matrix: Kapitel (Zeilen) × Top-Schauplätze (Spalten).
  // Cell-Wert = location_chapters.haeufigkeit; Sub-Kapitel auf ihr Wurzel-Kapitel
  // aggregiert, Kapitel-Match primär per chapter_id mit Namens-Fallback
  // (Backfill-Lücken: alte Einträge ohne aufgelöste ID).
  overviewOrtPresence() {
    const orte = this.overviewOrte || [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('ortPresence', [orte, tree],
      () => this._computeOrtPresence(orte));
  },

  _computeOrtPresence(orte) {
    const { chapters, resolveRoot } = this._presenceContext();
    const candidates = (orte || []).map(o => {
      const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
      const { byRootId, total } = bucketByRoot(
        kap.map(k => ({ chapterId: k?.chapter_id, chapterName: k?.name, n: k?.haeufigkeit })),
        resolveRoot,
      );
      return { id: o.id, name: o.name, byRootId, total };
    });
    return buildPresenceMatrix(candidates, chapters);
  },
};
