// Figuren-Tile: Count + Top-Liste + Präsenz-Matrix.
// Datenquelle: overviewSzenen.fig_ids (gleiche Quelle wie Sidebar-Auflistung).
// figuren[].kapitel.haeufigkeit zählt nur namentliche Treffer und unterzählt
// Hauptfiguren bei pronomenlastigen Texten systematisch — daher hier nicht
// als Ranking-Quelle verwendet.
//
// Spaltenauswahl, Skalierung und Zeilen-Aufbau der Matrix teilt sich das Modul
// mit Schauplätzen und Motiven — siehe ./presence.js.
import { buildPresenceMatrix } from './presence.js';

export const figurenMethods = {
  overviewFigurenCount() { return (this.overviewFiguren || []).length; },

  // Top-6 Figuren nach Szenen-Präsenz.
  overviewTopFiguren() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    return this._memo('topFiguren', [figs, sz], () => {
      const totals = new Map();
      for (const s of sz) {
        if (!Array.isArray(s.fig_ids)) continue;
        for (const fid of s.fig_ids) totals.set(fid, (totals.get(fid) || 0) + 1);
      }
      const ranked = figs
        .map(f => ({
          id: f.id,
          name: f.name,
          kurzname: f.kurzname,
          rolle: f.rolle || null,
          mentions: totals.get(f.id) || 0,
        }))
        .sort((a, b) => b.mentions - a.mentions);
      // Bevorzugt Figuren mit mehreren Szenen; Einmal-Auftritte nur als Fallback,
      // falls keine Figur mehrfach vorkommt (analog Orte-Tile).
      const recurring = ranked.filter(f => f.mentions >= 2);
      const base = recurring.length ? recurring : ranked;
      return base.slice(0, 6);
    });
  },

  // Figuren-Präsenz-Matrix: Kapitel (Zeilen) × Top-Figuren (Spalten).
  // Cell-Wert = Anzahl Szenen, in denen die Figur im Kapitel auftritt
  // (gezählt aus overviewSzenen.fig_ids); Sub-Kapitel auf ihr Wurzel-Kapitel
  // aggregiert, Kapitel-Match primär per chapter_id mit Namens-Fallback.
  overviewFigurePresence() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('figPresence', [figs, sz, tree],
      () => this._computeFigurePresence(figs, sz));
  },

  _computeFigurePresence(figs, sz) {
    const { chapters, resolveRoot } = this._presenceContext();

    // Szenen-major zählen: eine Szene liefert Kapitel + n Figuren auf einmal.
    // Darum hier eigene Akkumulation statt `bucketByRoot` (das ist entity-major).
    const counts = new Map(); // fig_id -> { byRootId, total }
    for (const s of sz) {
      if (!Array.isArray(s.fig_ids) || s.fig_ids.length === 0) continue;
      const root = resolveRoot(s.chapter_id, s.kapitel);
      if (!root) continue;
      const rid = Number(root.id);
      for (const figId of s.fig_ids) {
        let m = counts.get(figId);
        if (!m) { m = { byRootId: new Map(), total: 0 }; counts.set(figId, m); }
        m.byRootId.set(rid, (m.byRootId.get(rid) || 0) + 1);
        m.total++;
      }
    }

    const figById = new Map(figs.map(f => [f.id, f]));
    const candidates = [];
    for (const [figId, m] of counts) {
      const f = figById.get(figId);
      if (!f) continue;
      candidates.push({ id: figId, name: f.kurzname || f.name, byRootId: m.byRootId, total: m.total });
    }
    return buildPresenceMatrix(candidates, chapters);
  },
};
