// Alpine.store('catalog') — geteilte Fach-Daten, die von mehreren Karten
// gelesen/geschrieben werden: `figuren`, `orte`, `szenen`, `globalZeitstrahl`.
// Der Root spiegelt sie via Getter/Setter-Proxy (app.js), Karten greifen direkt
// via this.$store.catalog zu.

export function registerCatalogStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('catalog', {
    figuren: [],
    orte: [],
    szenen: [],
    globalZeitstrahl: [],

    clear() {
      this.figuren = [];
      this.orte = [];
      this.szenen = [];
      this.globalZeitstrahl = [];
    },
  });
}
