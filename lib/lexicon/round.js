'use strict';
// Einheitliche Rundung für alle Kennzahlen der Wortschatz-Analyse. Eine Stelle,
// damit measures/ngrams/keyness dieselbe Konvention halten: nicht-endliche Werte
// (NaN, ±Infinity) und null werden zu null, nicht zu einer Zahl. Sonst landen
// NaN-Werte in REAL-Spalten und tauchen im Frontend als leere Zelle ohne Ursache auf.
function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { round };
