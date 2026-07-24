// Alpine.store('nav') — geteilter Navigations-State: welches Buch, welche
// Seitenliste, welcher Tree gerade aktiv sind. Von ~29 Karten-/Fachmodulen
// gelesen (allen voran `selectedBookId`), darum eine schmale, benannte
// Store-Oberfläche statt buried in der Root-God-State.
//
// Kein Root-Proxy (wie catalog/tts/stt/config/collab/jobs): alle Konsumenten
// greifen direkt zu — Root-Computeds/-Slices + in den Root gespreadete
// Fachmodule via `this.$store.nav.*`, Karten/Helper via `Alpine.store('nav').*`,
// Templates via `$store.nav.*`. Der Buchorganizer mutiert `tree`/`pages`
// in-place (push/splice/sort) direkt auf dem reaktiven Store-Array. Der
// Hash-Router watcht `selectedBookId` per Getter (`() => this.$store.nav.
// selectedBookId`), nicht per String-Pfad.
//
// Bewusst NICHT hier: booksLoaded/bookRoles/treeLoading u.ä. — das ist
// Lade-Mechanik, eng an Root-Methoden gekoppelt und nicht cross-card gelesen.
//
// Permalink-Spiegel (werkstattDraftId/plotBeatId/rueckblickEntryId): die jeweilige
// Karte hält ihren eigenen SSoT (selectedDraftId/editingBeatId/selectedRueckblickId)
// und spiegelt ihn per $watch hierher. Sie liegen im Store statt in der Karte, weil
// der Hash-Router (Root-Singleton) sie beim Cold-Open eines Permalinks lesen/schreiben
// muss, BEVOR die Karte gemountet ist — eine Karten-lokale Heimat wäre dann unsichtbar.
// Der Hash-Router watcht sie per Getter (`() => this.$store.nav.X`), nicht per String-Pfad.
// werkstattDrafts: Spiegel der Werkstatt-Draft-Liste, damit die Command-Palette sie
// auch indizieren kann, ohne dass die Werkstatt je geöffnet wurde.
// pendingRueckblickZeitraum: Cold-Open-Handoff Overview-Heatmap → Rückblick-Karte.

export function registerNavStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('nav', {
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
    werkstattDraftId: null,
    werkstattDrafts: [],
    plotBeatId: null,
    rechercheItemId: null,
    rueckblickEntryId: null,
    pendingRueckblickZeitraum: null,
    // Permalink-Spiegel des effektiven Such-Scopes ('book' | 'all'). Die
    // searchCard spiegelt (mode==='semantic' || scopeMode==='book') hierher;
    // der Hash-Router liest ihn beim Cold-Open, um zwischen #book/:id/suche
    // (buch-skopiert) und #search (buchübergreifend) zu unterscheiden.
    searchScope: 'book',
  });
}
