'use strict';
// Tokenisierung für die Wortschatz-Analyse. Pure, ohne DB/Netz — SSoT für die
// Frage „was ist ein Token" in allen lexikalischen Massen (measures.js, ngrams.js,
// keyness.js).
//
// Bewusst NICHT deckungsgleich mit `page_stats.words`: dort zählt jede whitespace-
// getrennte Einheit (Zahlen, Kapitelnummern, Einzelbuchstaben-Reste), hier zählen
// nur Wörter. `tokens` liegt darum systematisch unter `words` — das ist Absicht und
// kein Drift. Zahlen sind kein Wortschatz, und ein Einzelbuchstabe (aus „geht's")
// bläht die Type-Zahl auf, ohne ein Wort zu sein.

// Ein Token: Buchstabenfolge, optional mit inneren Apostroph-Gruppen, damit
// Kontraktionen ein Token bleiben („geht's" → ein Type, nicht „geht" + „s").
// \p{L} statt [A-Za-zÄÖÜäöüß], damit Akzentbuchstaben aus Zitaten/Namen (café,
// Œuvre, Łódź) nicht mitten im Wort abschneiden.
const TOKEN_RE = /\p{L}+(?:['’ʼ]\p{L}+)*/gu;

// Einzelbuchstaben werden verworfen: im Deutschen gibt es praktisch kein
// einbuchstabiges Wort, in der Praxis sind es Reste aus Abkürzungen und
// Auszeichnungs-Artefakten.
const MIN_TOKEN_LEN = 2;

// Segmentgrenzen für n-Gramme: satzfinale Zeichen und Zeilenumbrüche (die der
// Aufrufer aus den Blockgrenzen des HTML setzt). Eigene Implementierung statt
// `_sentenceRanges` aus lib/page-index.js — die liefert Zeichen-Ranges für die
// Beispielsatz-Suche und verwirft unpunktierte Enden; hier darf kein Token
// verloren gehen, und gebraucht werden die Token-Gruppen, nicht die Offsets.
const SEGMENT_SPLIT_RE = /[.!?…]+|\n+/;

// ß → ss. Nötig, weil die App auf Schweizer Schreibnorm läuft (siehe baseRules in
// prompt-config.json), importiertes Material aber beide Formen mitbringt: ohne
// Faltung sind „Strasse" und „Straße" zwei Types und jedes Diversitätsmass ist
// nach oben verzerrt. In der Schweizer Norm sind die gefalteten Paare ohnehin
// Homographen (Masse/Maße → Masse).
function foldSharpS(s) {
  return s.replace(/ß/g, 'ss');
}

// Ein Roh-Treffer → Vergleichsform: NFC-normalisiert (Kombinations-Akzente aus
// Importen zusammenziehen), lowercased, ß gefaltet.
function normalizeToken(raw) {
  return foldSharpS(String(raw).normalize('NFC').toLowerCase());
}

// Flache Token-Sequenz in Leserichtung. Die Reihenfolge ist für MATTR/MTLD/Heaps
// bedeutungstragend — nie sortieren, nie deduplizieren.
function tokenize(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    const t = normalizeToken(m[0]);
    if (t.length >= MIN_TOKEN_LEN) out.push(t);
  }
  return out;
}

// Token-Sequenz, gruppiert nach Segment (Satz bzw. Block). Nur für n-Gramme:
// Phrasen dürfen keine Satzgrenze überspannen, sonst entstehen Geister-Wendungen
// („…die Tür. Er stand…" → „tür er stand"). Leere Segmente fallen weg.
function tokenizeSegments(text) {
  const out = [];
  for (const part of String(text == null ? '' : text).split(SEGMENT_SPLIT_RE)) {
    const toks = tokenize(part);
    if (toks.length) out.push(toks);
  }
  return out;
}

// Häufigkeitstabelle einer Token-Sequenz.
function frequencies(tokens) {
  const f = new Map();
  for (const t of tokens || []) f.set(t, (f.get(t) || 0) + 1);
  return f;
}

module.exports = {
  TOKEN_RE, MIN_TOKEN_LEN, SEGMENT_SPLIT_RE,
  foldSharpS, normalizeToken, tokenize, tokenizeSegments, frequencies,
};
