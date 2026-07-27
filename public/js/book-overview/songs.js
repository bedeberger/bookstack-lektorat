// Musik-Tile: Count + Top-Songs nach Häufigkeit (Summe haeufigkeit über alle Kapitel).
export const songsMethods = {
  overviewSongsCount() { return (this.overviewSongs || []).length; },

  overviewTopSongs() {
    const songs = this.overviewSongs || [];
    return this._memo('topSongs', [songs], () => {
      return songs
        .map(s => {
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
        })
        .filter(s => s.total > 0 || songs.length <= 6)
        .sort((a, b) => b.total - a.total)
        .slice(0, 6);
    });
  },
};
