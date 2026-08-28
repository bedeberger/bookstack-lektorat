// Musik-Tile: Count + Top-Songs nach Häufigkeit (Summe haeufigkeit über alle Kapitel).
// Auswahl über dieselbe abgestufte Regel wie Figuren-, Orte- und Matrix-Spalten
// (./ranking.js) — hier fehlte die Wiederkehr-Stufe bisher, sodass Songs mit
// einer einzigen Nennung die wiederkehrenden aus der Liste drängen konnten.
import { rankPreferRecurring } from './ranking.js';

export const songsMethods = {
  overviewSongsCount() { return (this.overviewSongs || []).length; },

  overviewTopSongs() {
    const songs = this.overviewSongs || [];
    return this._memo('topSongs', [songs], () => {
      const rows = songs.map(s => {
        const kap = Array.isArray(s.kapitel) ? s.kapitel : [];
        const total = kap.reduce((sum, k) => sum + (Number(k.haeufigkeit) || 0), 0);
        return {
          id: s.id,
          titel: s.titel || '',
          interpret: s.interpret || '',
          genre: s.genre || '',
          kontext_typ: s.kontext_typ || '',
          total,
        };
      });
      return rankPreferRecurring(rows, { valueOf: s => s.total });
    });
  },
};
