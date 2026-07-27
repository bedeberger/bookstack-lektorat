// Motiv-Tile: Ist-Präsenz-Matrix Kapitel × Motiv.
// Datenquelle: /motifs?book_id → { motifs: [{ id, name, occChapters:[{chapterId,n}] }] }.
// occChapters ist die Kapitel-Aufschlüsselung der KI-erkannten Fundstellen (Ist,
// score-floor-gefiltert serverseitig, page+scene → chapter_id), das Pendant zum
// kapitel-Breakdown der Orte. Zeigt, welche Motive das Buch tatsächlich
// durchziehen und wo sie fehlen — rein rückwärtsgewandt, kein KI-Job hier.
//
// Spaltenauswahl, Skalierung und Zeilen-Aufbau der Matrix teilt sich das Modul
// mit Figuren und Schauplätzen — siehe ./presence.js.
import { buildPresenceMatrix, bucketByRoot } from './presence.js';

export const motivMethods = {
  // Motiv-Präsenz-Matrix: Kapitel (Zeilen) × Top-Motive (Spalten).
  // Cell-Wert = Anzahl Ist-Fundstellen des Motivs im Wurzel-Kapitel; Sub-Kapitel
  // werden aufaggregiert. `occChapters` liefert nur IDs, der Namens-Fallback des
  // Resolvers läuft hier also immer ins Leere — das ist so gewollt.
  overviewMotifPresence() {
    const motifs = this.overviewMotifs?.motifs || [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('motifPresence', [motifs, tree],
      () => this._computeMotifPresence(motifs));
  },

  _computeMotifPresence(motifs) {
    const { chapters, resolveRoot } = this._presenceContext();
    const candidates = (motifs || []).map(m => {
      const occCh = Array.isArray(m.occChapters) ? m.occChapters : [];
      const { byRootId, total } = bucketByRoot(occCh, resolveRoot);
      return { id: m.id, name: m.name, byRootId, total };
    });
    return buildPresenceMatrix(candidates, chapters);
  },
};
