// Alpine.data('pageHistoryCard') — Sub-Komponente für den Verlaufsbalken
// unter dem Editor.
//
// Daten (`pageHistory`, `activeHistoryEntryId`) bleiben am Root, weil
// loadHistoryEntry auch Lektorat-State schreibt (findings, correctedHtml,
// analysisOut). Sub ist reines Partial-Scope ohne eigenen State.

export function registerPageHistoryCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageHistoryCard', () => ({}));
}
