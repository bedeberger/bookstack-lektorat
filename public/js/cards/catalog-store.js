// Alpine.store('catalog') — geteilte Fach-Daten, die von mehreren Karten
// gelesen/geschrieben werden: `figuren`, `orte`, `szenen`, `globalZeitstrahl`.
//
// Motivation: Vor der Store-Einführung lebten diese Arrays im Root und wurden
// von Komplett-Job, figuren.js, orte.js, szenen.js, ereignisse.js, chat.js,
// Editor-Modulen UND mehreren Filter-Karten querbeet gelesen/geschrieben.
// Das blockierte die Migration von Filter-Karten zu Alpine.data.
//
// Kompatibilitätsschicht: Der Root definiert weiterhin `figuren`, `orte`,
// `szenen`, `globalZeitstrahl` als Getter/Setter-Proxy auf den Store
// (siehe app.js). Bestehender Root-Code (this.figuren = …, this.orte.push)
// funktioniert unverändert, neue Sub-Komponenten greifen direkt via
// this.$store.catalog zu.

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
