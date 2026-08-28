// Geteilte Auswahlregel der Top-Listen der Buch-Uebersicht (Figuren, Orte,
// Songs) und der Spaltenauswahl der Praesenz-Matrizen.
//
// Alle vier zeigen dieselbe Frage: „welche N Eintraege durchziehen das Buch?"
// Sie lag viermal im Code, und einmal (Songs) fehlte die entscheidende Stufe —
// eine stille Abweichung, die niemandem auffiel, weil jede Kopie fuer sich
// plausibel aussah.
//
// Pure Funktion (Alpine-/DOM-frei) → direkt unit-testbar, siehe
// tests/unit/book-overview-ranking.test.mjs.

// Ab wie vielen Fundstellen ein Eintrag als „wiederkehrend" gilt.
export const RECURRING_MIN = 2;

/**
 * Nach Kennzahl absteigend sortieren und die aussagekraeftigste Stufe waehlen.
 *
 * Drei Stufen, in dieser Reihenfolge:
 *   1. wiederkehrende Eintraege (Kennzahl >= RECURRING_MIN),
 *   2. sonst alle mit ueberhaupt einer Fundstelle (> 0),
 *   3. sonst alles.
 *
 * Warum abgestuft: Einmal-Treffer stammen meist alle aus einem einzigen
 * Kapitel und wuerden die wiederkehrenden Eintraege aus der Liste draengen —
 * gerade die sind aber die Aussage. Stufe 3 ist der Fall „noch nichts
 * ausgezaehlt" (keine Szenen indiziert, Kapitel-Haeufigkeiten leer): dort ist
 * eine Liste ohne Zahlen immer noch besser als gar keine.
 *
 * @param {Array<object>} items
 * @param {object} opts
 * @param {(item) => number} opts.valueOf  Kennzahl des Eintrags.
 * @param {number} [opts.limit=6]          Maximale Listenlaenge.
 * @param {number} [opts.minRecurring]     Schwelle der ersten Stufe.
 * @returns {Array<object>} Teilmenge von `items`, absteigend sortiert.
 */
export function rankPreferRecurring(items, { valueOf, limit = 6, minRecurring = RECURRING_MIN } = {}) {
  const ranked = [...(items || [])].sort((a, b) => valueOf(b) - valueOf(a));
  if (!ranked.length) return [];
  const recurring = ranked.filter(i => valueOf(i) >= minRecurring);
  if (recurring.length) return recurring.slice(0, limit);
  const withHits = ranked.filter(i => valueOf(i) > 0);
  return (withHits.length ? withHits : ranked).slice(0, limit);
}
