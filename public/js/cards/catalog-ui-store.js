// Alpine.store('catalogUi') — UI-Begleitstate der Katalog-Daten (figuren/orte/
// szenen/songs/ereignisse/kontinuitaet, die selbst in Alpine.store('catalog')
// liegen): Filter, Selektion, Lade-/Stempel-Flags. Vorher flach in der
// Root-God-State; jetzt eine schmale, benannte Store-Oberflaeche. Kein
// Root-Proxy: alle Konsumenten greifen direkt zu — in den Root gespreadete
// Module (app-navigation/app-hash-router/app-jobs-core/app-view + book/*) via
// `this.$store.catalogUi.*`, Karten/Helper via `Alpine.store('catalogUi').*` bzw.
// `window.__app.$store.catalogUi.*`, Templates via `$store.catalogUi.*`.
//
// selectedXxxId sind Hash-Router-SSoT (analog selectedBookId im nav-Store).
// Die Filter-Objekte werden via FILTER_SCOPES (app-view/_shared.js) pro Buch im
// localStorage persistiert. `_figuresPollTimer` (reconnect-relevant) bleibt
// bewusst am Root (app-state.js).

export function registerCatalogUiStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('catalogUi', {
    // Figuren: Lade-State wird vom Komplett-Job + Reconnect geschrieben.
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    selectedFigurId: null,
    figurenFilters: { kapitel: '', seite: '', suche: '' },

    // Ereignisse: Filter + Selektion (app-navigation schreibt beides).
    selectedEreignisId: null,
    ereignisseFilters: { figurId: '', kapitel: '', seite: '', subtyp: '', suche: '' },

    szenenUpdatedAt: null,
    selectedSzeneId: null,
    szenenFilters: { wertung: '', figurId: '', kapitel: '', ortId: '', suche: '' },

    orteUpdatedAt: null,
    selectedOrtId: null,
    orteFilters: { figurId: '', kapitel: '', szeneId: '', suche: '' },

    songsUpdatedAt: null,
    selectedSongId: null,
    songsFilters: { figurId: '', kapitel: '', szeneId: '', genre: '', kontextTyp: '', suche: '' },

    kontinuitaetFilters: { figurId: '', kapitel: '', schwere: '' },
  });
}
