// Redaktions-Stufen — ESM-SSoT fuer alles, was im Browser laeuft.
//
// Die Liste ist GEORDNET: sie ist der Weg eines Beitrags durch die Redaktion,
// nicht bloss eine Menge erlaubter Werte. Daraus leiten sich Anzeige-Reihenfolge,
// Fortschritt und der Vergleich „weiter als" ab.
//
// CJS-Spiegel: db/redaktion.js#REDAKTION_STATUS (die Schreibpfade validieren
// synchron und koennen kein ESM importieren) und der CHECK-Constraint von
// `page_editorial_status.status`. Drift ist durch
// tests/unit/redaktion-status.test.mjs gegated — neue Stufe heisst: hier, dort,
// im CHECK und in beiden Locale-Dateien (`redaktion.status.<key>`).

export const REDAKTION_STATUS = ['roh', 'gegengelesen', 'schlussredigiert', 'freigegeben'];

/** Stufe, ab der ein Beitrag fertig ist. */
export const REDAKTION_STATUS_DONE = 'freigegeben';

/** Position in der Kette (0-basiert), -1 fuer unbekannt/ungesetzt. */
export function statusRank(v) {
  return REDAKTION_STATUS.indexOf(v);
}

/**
 * i18n-Key des Stufen-Labels. Eigener Helper statt eines Template-Literals an
 * fuenf Stellen — der Praefix ist damit genau einmal geschrieben.
 */
export function statusLabelKey(v) {
  return `redaktion.status.${v}`;
}
