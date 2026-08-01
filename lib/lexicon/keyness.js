'use strict';
// Keyness: welche Wörter sind für DIESES Buch auffällig, gemessen an einem
// Referenzkorpus. Pure — Eingabe sind Häufigkeitstabellen, Ausgabe Zahlen.
//
// Referenz in Phase 1 sind die übrigen Bücher desselben Autors. Das braucht keine
// externe Frequenzliste (und keine Lizenzklärung) und beantwortet die für den
// Schreibenden interessantere Frage: nicht „welche Wörter sind seltener als in der
// Zeitung", sondern „was benutze ich HIER auffällig und sonst nicht".
//
// Hat der Autor nur ein Buch, gibt es keine Referenz — dann bleibt die Spalte leer.
// Das ist der korrekte Zustand, kein Fehler; ein Buch gegen sich selbst zu testen
// liefert per Konstruktion überall null.

// Unter dieser Häufigkeit im Zielbuch wird keine Keyness gerechnet: bei a=1..2
// schlägt Log-Likelihood schon bei Zufallsschwankungen an.
const MIN_TARGET_COUNT = 3;

const { round } = require('./round');

// Log-Likelihood (G²) nach Dunning/Rayson-Garside für eine 2×2-Kontingenz:
//   a = Häufigkeit im Zielkorpus, b = im Referenzkorpus,
//   cA/cB = Gesamtgrösse Ziel/Referenz.
// Vorzeichen trägt die Richtung: positiv = im Zielbuch überrepräsentiert, negativ =
// unterrepräsentiert. Ohne Vorzeichen wäre „benutzt du auffällig oft" nicht von
// „vermeidest du auffällig" unterscheidbar — beides ist G² > 0.
//
// Konvention: 0·ln(0) = 0 (der Term fällt weg, wenn ein Korpus das Wort nie hat).
function logLikelihood(a, b, cA, cB) {
  if (!cA || !cB) return null;
  const total = cA + cB;
  const e1 = (cA * (a + b)) / total;
  const e2 = (cB * (a + b)) / total;
  let g2 = 0;
  if (a > 0 && e1 > 0) g2 += a * Math.log(a / e1);
  if (b > 0 && e2 > 0) g2 += b * Math.log(b / e2);
  g2 *= 2;
  const relTarget = a / cA;
  const relRef = b / cB;
  const sign = relTarget >= relRef ? 1 : -1;
  return round(sign * g2, 2);
}

// Keyness für eine Menge von Termen. `targetFreq`/`refFreq` sind Map<term,count>,
// `targetTotal`/`refTotal` die Token-Summen der beiden Korpora.
// Rückgabe: Map<term, number|null>.
//
// `opts.refFloor` rechnet die VORSICHTIGE Variante: die gespeicherte Referenz-
// Frequenztabelle ist gedeckelt (`freq_json`), ein dort fehlender Term hat also
// nicht zwingend die Häufigkeit 0, sondern irgendetwas unterhalb der Kappungs-
// grenze. Mit `refFloor` wird jede Referenzhäufigkeit auf diese Grenze angehoben —
// das Ergebnis ist eine untere Schranke der Auffälligkeit.
// Gebraucht wird das dort, wo die Keyness über die AUSWAHL entscheidet
// (analyze.js): sonst landen genau die Terme in der Liste, deren hoher Wert nur
// aus der Kappung stammt. Für die ANZEIGE bleibt die schlichte Variante — dort ist
// der Wert eine Beschreibung, kein Filter.
function keynessFor(terms, targetFreq, refFreq, targetTotal, refTotal, opts = {}) {
  const minCount = opts.minTargetCount || MIN_TARGET_COUNT;
  const floor = opts.refFloor || 0;
  const out = new Map();
  const hasRef = refTotal > 0;
  for (const term of terms) {
    const a = targetFreq.get(term) || 0;
    if (!hasRef || a < minCount) { out.set(term, null); continue; }
    const b = Math.max(refFreq.get(term) || 0, floor);
    out.set(term, logLikelihood(a, b, targetTotal, refTotal));
  }
  return out;
}

module.exports = { MIN_TARGET_COUNT, logLikelihood, keynessFor };
