'use strict';
// Facade der Wortschatz-Analyse (quantitative Stilistik pro Buch). Einziger
// Einstieg für Konsumenten (Job, Leseroute, Tests) — die Submodule unter
// lib/lexicon/ sind interne Aufteilung.
//
//   tokenize.js  Token-Sequenz + Segmente (SSoT „was ist ein Token")
//   measures.js  MATTR, MTLD, Yule's K, Heaps β, Hapax, lexikalische Dichte
//   ngrams.js    n-Gramm-Zählung (Apriori) + log-Dice
//   keyness.js   Log-Likelihood gegen ein Referenzkorpus
//   analyze.js   Orchestrator über die Seiten eines Buchs
//
// Alles darunter ist pure: keine DB, kein Netz, kein Zustand. Persistenz liegt in
// db/lexicon.js, das Einreihen in routes/jobs/lexicon-scan.js.

const tokenize = require('./lexicon/tokenize');
const measures = require('./lexicon/measures');
const ngrams = require('./lexicon/ngrams');
const keyness = require('./lexicon/keyness');
const analyze = require('./lexicon/analyze');

module.exports = {
  ...tokenize,
  ...measures,
  ...ngrams,
  ...keyness,
  ...analyze,
};
