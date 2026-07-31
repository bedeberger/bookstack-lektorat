'use strict';
// Mehrwort-Wendungen (n-Gramme) und ihre Kohäsion. Pure — Eingabe sind die
// Token-Segmente aus tokenize.js#tokenizeSegments, Ausgabe sind Zahlen.
//
// Zweck: Phrasen-Tics finden („mit einem Ruck", „konnte nicht anders als"). Die
// bestehende Wiederholungs-Metrik in lib/page-index.js sieht die nicht — sie zählt
// Einzelwörter pro Seite, und die Wörter einer Wendung sind einzeln unauffällig.
//
// Stoppwörter werden hier ABSICHTLICH nicht gefiltert: „mit einem Ruck" besteht zu
// zwei Dritteln aus Funktionswörtern. Gegen die dadurch drohende Flut aus blossen
// Funktionswort-Ketten („in der", „und dann") wirkt nicht ein Filter, sondern das
// Kohäsionsmass log-Dice: häufige Bestandteile drücken den Wert.

const DEFAULT_MIN_N = 2;
const DEFAULT_MAX_N = 5;
// Ein zweimal vorkommender Satzteil ist Zufall, kein Tic. Zugleich der Hebel gegen
// die Kandidaten-Explosion (siehe Apriori unten).
const DEFAULT_MIN_COUNT = 3;

const { round } = require('./round');

// Phrasen-Schlüssel. Token bestehen nur aus Buchstaben/Apostrophen (tokenize.js),
// darum ist das Leerzeichen ein kollisionsfreier Trenner.
function phraseKey(tokens, from, n) {
  let s = tokens[from];
  for (let k = 1; k < n; k++) s += ' ' + tokens[from + k];
  return s;
}

// Zählt n-Gramme über alle Segmente, Level für Level, mit Apriori-Beschneidung:
// ein (n)-Gramm kann die Mindesthäufigkeit nur erreichen, wenn sowohl sein
// (n−1)-Präfix als auch sein (n−1)-Suffix sie erreichen. Ohne diese Beschneidung
// müsste man für maxN=5 rund 4·N Kandidaten gleichzeitig im Speicher halten (bei
// einem 1-Mio-Zeichen-Buch ≈ 600 000 Einträge); mit ihr bleiben pro Level nur die
// tatsächlich wiederkehrenden übrig.
//
// Nebeneffekt, der gebraucht wird: weil auch das Suffix überlebt hat, ist für jedes
// überlebende n-Gramm die Häufigkeit seines (n−1)-Suffixes bekannt — genau der
// Nenner-Teil von log-Dice.
//
// Rückgabe: { unigrams: Map<token,count>, levels: Map<n, Map<phrase,count>> }.
// `unigrams` ist UNBESCHNITTEN (Nenner für die Bigramm-Kohäsion).
function countNgrams(segments, opts = {}) {
  const minN = Math.max(2, opts.minN || DEFAULT_MIN_N);
  const maxN = Math.max(minN, opts.maxN || DEFAULT_MAX_N);
  const minCount = Math.max(2, opts.minCount || DEFAULT_MIN_COUNT);

  const unigrams = new Map();
  for (const seg of segments) {
    for (const t of seg) unigrams.set(t, (unigrams.get(t) || 0) + 1);
  }

  const levels = new Map();
  let prevSurvivors = null; // Map<phrase,count> des Levels n-1 (nach Beschneidung)
  for (let n = 2; n <= maxN; n++) {
    const counts = new Map();
    for (const seg of segments) {
      const last = seg.length - n;
      for (let i = 0; i <= last; i++) {
        if (n > 2) {
          // Apriori: Präfix und Suffix müssen im Vorlevel überlebt haben.
          if (!prevSurvivors.has(phraseKey(seg, i, n - 1))) continue;
          if (!prevSurvivors.has(phraseKey(seg, i + 1, n - 1))) continue;
        }
        const key = phraseKey(seg, i, n);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    for (const [k, c] of counts) if (c < minCount) counts.delete(k);
    if (counts.size === 0) break; // kein längeres Level kann mehr etwas finden
    if (n >= minN) levels.set(n, counts);
    prevSurvivors = counts;
  }
  return { unigrams, levels };
}

// log-Dice über die Zerlegung erstes Token | Rest:
//   14 + log2( 2·f(Phrase) / (f(erstes Token) + f(Rest)) )
// Für n=2 ist das exakt das klassische log-Dice zweier Wörter. Die 14 ist die
// üblich gesetzte Konstante, die den Wert in einen positiven Bereich hebt
// (theoretisches Maximum 14); höher = die Teile kommen fast nur gemeinsam vor.
function logDice(phraseCount, headCount, tailCount) {
  const denom = (headCount || 0) + (tailCount || 0);
  if (!phraseCount || denom <= 0) return null;
  return round(14 + Math.log2((2 * phraseCount) / denom), 3);
}

// Die auffälligsten Wendungen je Länge. Der Deckel wirkt PRO LÄNGE, damit lange
// Wendungen nicht von den zwangsläufig häufigeren kurzen verdrängt werden.
// Sortiert wird innerhalb einer Länge nach Häufigkeit — die Kappung soll die
// wiederkehrenden behalten, nicht die exklusivsten Einmal-Fügungen.
function selectTop({ unigrams, levels }, opts = {}) {
  const limitPerN = opts.limitPerN || 60;
  const out = [];
  for (const [n, counts] of levels) {
    const prev = n === 2 ? unigrams : levels.get(n - 1);
    const rows = [];
    for (const [phrase, count] of counts) {
      const sp = phrase.indexOf(' ');
      const head = phrase.slice(0, sp);
      const tail = phrase.slice(sp + 1);
      const headCount = unigrams.get(head) || 0;
      // `prev` fehlt nur, wenn minN > 2 gesetzt wurde und das Vorlevel deshalb
      // nicht in `levels` liegt — dann bleibt log_dice leer statt falsch.
      const tailCount = prev ? (prev.get(tail) || 0) : 0;
      rows.push({ phrase, n, count, log_dice: logDice(count, headCount, tailCount) });
    }
    rows.sort((a, b) => b.count - a.count || (b.log_dice || 0) - (a.log_dice || 0));
    out.push(...rows.slice(0, limitPerN));
  }
  return out;
}

// Fundstellen der übergebenen Phrasen: Map<phrase, number[]> mit den Indizes der
// Segmente, in denen die Phrase vorkommt (aufsteigend, Mehrfachvorkommen im selben
// Segment einmal). Der Aufrufer hält die Zuordnung Segment → Seite/Kapitel und
// leitet daraus Streuung und Sprungziel ab; dieses Modul kennt beides nicht.
function locate(segments, phrases, opts = {}) {
  const maxN = Math.max(2, opts.maxN || DEFAULT_MAX_N);
  const wanted = phrases instanceof Set ? phrases : new Set(phrases);
  const byLen = new Map();
  for (const p of wanted) {
    const n = p.split(' ').length;
    if (!byLen.has(n)) byLen.set(n, new Set());
    byLen.get(n).add(p);
  }
  const hits = new Map();
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    for (const [n, set] of byLen) {
      if (n > maxN) continue;
      const last = seg.length - n;
      for (let i = 0; i <= last; i++) {
        const key = phraseKey(seg, i, n);
        if (!set.has(key)) continue;
        let arr = hits.get(key);
        if (!arr) { arr = []; hits.set(key, arr); }
        if (arr[arr.length - 1] !== si) arr.push(si);
      }
    }
  }
  return hits;
}

module.exports = {
  DEFAULT_MIN_N, DEFAULT_MAX_N, DEFAULT_MIN_COUNT,
  phraseKey, countNgrams, logDice, selectTop, locate,
};
