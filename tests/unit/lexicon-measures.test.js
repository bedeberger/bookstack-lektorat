'use strict';
// Unit-Tests der reinen Wortschatz-Masse (lib/lexicon/*). Kein DB-, kein Netz-Zugriff.
// Lauf: `node --test tests/unit/lexicon-measures.test.js`
//
// Die Erwartungswerte sind von Hand nachgerechnet und im Test als Rechnung notiert.
// Ohne das messen solche Tests nur „macht weiter dasselbe wie beim Schreiben" — der
// Rechenweg im Kommentar ist der eigentliche Prüfmassstab.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tokenize, tokenizeSegments, frequencies, foldSharpS, normalizeToken,
} = require('../../lib/lexicon/tokenize');
const {
  hapaxStats, mattr, mtld, yuleK, heaps, lexicalDensity, MTLD_MIN_TOKENS,
} = require('../../lib/lexicon/measures');
const {
  countNgrams, logDice, selectTop, locate, phraseKey,
} = require('../../lib/lexicon/ngrams');
const { logLikelihood, keynessFor } = require('../../lib/lexicon/keyness');

// ---------------------------------------------------------------- tokenize -----

test('tokenize: lowercased, ß gefaltet, Einzelbuchstaben verworfen', () => {
  assert.deepEqual(
    tokenize('Die Straße heißt anders. A b Haus'),
    ['die', 'strasse', 'heisst', 'anders', 'haus']
  );
});

test('tokenize: Kontraktion mit Apostroph bleibt EIN Token', () => {
  // "geht's" darf nicht in "geht" + "s" zerfallen — sonst zählt der Apostroph-Rest
  // als eigener Type und die Type-Zahl steigt mit jeder Kontraktion.
  assert.deepEqual(tokenize("Er sagt, es geht's schon"), ['er', 'sagt', 'es', 'geht\'s', 'schon']);
});

test('tokenize: Zahlen sind kein Wortschatz', () => {
  assert.deepEqual(tokenize('Kapitel 12 von 30'), ['kapitel', 'von']);
});

test('tokenize: Akzentbuchstaben schneiden das Wort nicht ab', () => {
  assert.deepEqual(tokenize('im Café von Łódź'), ['im', 'café', 'von', 'łódź']);
});

test('foldSharpS/normalizeToken: NFC + lowercase + ss', () => {
  assert.equal(foldSharpS('Straße'), 'Strasse');
  // e + combining acute (U+0301) muss auf das vorkomponierte é fallen, sonst sind
  // "café" aus zwei Importquellen zwei verschiedene Types.
  assert.equal(normalizeToken('café'), 'café');
});

test('tokenizeSegments: Satzgrenzen trennen, kein Token geht verloren', () => {
  assert.deepEqual(
    tokenizeSegments('Er ging. Sie blieb! Und dann?'),
    [['er', 'ging'], ['sie', 'blieb'], ['und', 'dann']]
  );
});

test('tokenizeSegments: unpunktiertes Ende bleibt erhalten', () => {
  // Genau der Fall, an dem _sentenceRanges in lib/page-index.js absichtlich anders
  // arbeitet (dort wird der Rest verworfen — hier darf er nicht verschwinden).
  assert.deepEqual(tokenizeSegments('Erster Satz. Zweiter ohne Punkt'),
    [['erster', 'satz'], ['zweiter', 'ohne', 'punkt']]);
});

// ---------------------------------------------------------------- measures -----

test('hapaxStats: Types, Hapax, Dislegomena, Quote', () => {
  const f = frequencies(['a', 'a', 'a', 'b', 'b', 'c']);
  // types=3 (a,b,c), hapax=1 (c), dislegomena=1 (b), Quote 1/3
  assert.deepEqual(hapaxStats(f), {
    types: 3, hapax: 1, dislegomena: 1, hapax_ratio: 0.3333,
  });
});

test('mattr: gleitendes Fenster, Mittel der Fenster-TTR', () => {
  // ['a','a','b','b'], Fenster 2 → Fenster [a,a]=1/2, [a,b]=2/2, [b,b]=1/2
  // Mittel = (0.5 + 1 + 0.5) / 3 = 0.6667
  const r = mattr(['a', 'a', 'b', 'b'], 2);
  assert.equal(r.value, 0.6667);
  assert.equal(r.window, 2);
  assert.equal(r.windows, 3);
});

test('mattr: Text kürzer als das Fenster → einfache TTR, Fenster = Textlänge', () => {
  const r = mattr(['a', 'b', 'a'], 1000);
  assert.equal(r.window, 3);   // muss sichtbar sein, sonst wirkt der Wert robust
  assert.equal(r.windows, 1);
  assert.equal(r.value, 0.6667); // 2 Types / 3 Token
});

test('mattr: leere Sequenz → null, kein NaN', () => {
  assert.deepEqual(mattr([], 100), { value: null, window: 0, windows: 0 });
});

test('mtld: unter der Mindestlänge → null', () => {
  const short = Array.from({ length: MTLD_MIN_TOKENS - 1 }, (_, i) => 't' + i);
  assert.equal(mtld(short), null);
});

test('mtld: nur neue Wörter → null (Schwelle nie erreicht)', () => {
  const allUnique = Array.from({ length: 300 }, (_, i) => 't' + i);
  // TTR bleibt konstant 1, kein Faktor schliesst ab, Restfaktor = (1-1)/0.28 = 0.
  assert.equal(mtld(allUnique), null);
});

test('mtld: alternierende Sequenz → nachgerechneter Wert', () => {
  // a,b,a,b,… : nach 3 Token ist TTR = 2/3 = 0.667 ≤ 0.72 → Faktor voll, Reset.
  // 200 Token = 66 Faktoren à 3 Token, Rest 2 Token mit TTR 1 → Restfaktor 0.
  // MTLD = 200 / 66 = 3.0303 → gerundet 3.03; rückwärts identisch (Symmetrie).
  const toks = Array.from({ length: 200 }, (_, i) => (i % 2 ? 'b' : 'a'));
  assert.equal(mtld(toks), 3.03);
});

test('yuleK: nachgerechnet', () => {
  const f = frequencies(['a', 'a', 'a', 'b', 'b', 'c']);
  // V1=1, V2=1, V3=1 → Σ i²·V_i = 1 + 4 + 9 = 14; N=6
  // K = 10^4 · (14 − 6) / 36 = 80000/36 = 2222.22
  assert.equal(yuleK(f, 6), 2222.22);
});

test('heaps: V = N (nur neue Wörter) → β = 1, K = 1', () => {
  // Analytisch exakt: log V = log N für jeden Messpunkt, die Regression MUSS
  // Steigung 1 und Achsenabschnitt 0 (→ K = e^0 = 1) liefern.
  const allUnique = Array.from({ length: 1000 }, (_, i) => 't' + i);
  const r = heaps(allUnique);
  assert.equal(r.beta, 1);
  assert.equal(r.k, 1);
});

test('heaps: gesättigter Wortschatz → β nahe 0', () => {
  const twoTypes = Array.from({ length: 1000 }, (_, i) => (i % 2 ? 'b' : 'a'));
  const r = heaps(twoTypes);
  assert.ok(r.beta < 0.05, `β sollte gegen 0 gehen, war ${r.beta}`);
});

test('heaps: unter der Mindestlänge → null statt Rauschen', () => {
  assert.deepEqual(heaps(['a', 'b', 'c']), { beta: null, k: null, points: 0 });
});

test('lexicalDensity: Inhaltswörter / Gesamttoken', () => {
  const isContent = t => t !== 'der';
  assert.equal(lexicalDensity(['der', 'hund', 'bellt'], isContent), 0.6667);
});

// ------------------------------------------------------------------ ngrams -----

test('phraseKey: Leerzeichen-getrennter Schlüssel', () => {
  assert.equal(phraseKey(['mit', 'einem', 'ruck'], 0, 3), 'mit einem ruck');
  assert.equal(phraseKey(['mit', 'einem', 'ruck'], 1, 2), 'einem ruck');
});

test('countNgrams: Apriori sammelt die wiederkehrende Wendung über alle Level', () => {
  const seg = ['mit', 'einem', 'ruck'];
  const { levels, unigrams } = countNgrams([seg, seg, seg], { minCount: 3 });
  assert.equal(unigrams.get('mit'), 3);
  assert.equal(levels.get(2).get('mit einem'), 3);
  assert.equal(levels.get(2).get('einem ruck'), 3);
  assert.equal(levels.get(3).get('mit einem ruck'), 3);
  // Kein 4-Gramm möglich → Level 4 existiert nicht (Abbruch, nicht leere Map).
  assert.equal(levels.has(4), false);
});

test('countNgrams: Phrase unter der Mindesthäufigkeit fällt weg', () => {
  const { levels } = countNgrams([['a', 'b'], ['a', 'b']], { minCount: 3 });
  assert.equal(levels.size, 0);
});

test('countNgrams: Wendung überspannt NIE eine Segmentgrenze', () => {
  // Drei Segmente, deren Rand-Token die Phrase "b c" nur über die Grenze bilden würden.
  const segs = [['a', 'b'], ['c', 'd'], ['a', 'b'], ['c', 'd'], ['a', 'b'], ['c', 'd']];
  const { levels } = countNgrams(segs, { minCount: 3 });
  assert.equal(levels.get(2).get('a b'), 3);
  assert.equal(levels.get(2).get('c d'), 3);
  assert.equal(levels.get(2).has('b c'), false);
});

test('logDice: nachgerechnet', () => {
  // 14 + log2(2·10 / (20+30)) = 14 + log2(0.4) = 14 − 1.321928 = 12.678
  assert.equal(logDice(10, 20, 30), 12.678);
  // Maximum: die Teile kommen ausschliesslich gemeinsam vor → 14 + log2(1) = 14
  assert.equal(logDice(5, 5, 5), 14);
  assert.equal(logDice(0, 5, 5), null);
  assert.equal(logDice(5, 0, 0), null);
});

test('selectTop: Funktionswort-Kette rankt schlechter als die kohäsive Wendung', () => {
  // "in der" tritt 4× auf, aber beide Teile sind überall; "mit ruck" 3× und exklusiv.
  const segs = [];
  for (let i = 0; i < 4; i++) segs.push(['in', 'der']);
  for (let i = 0; i < 3; i++) segs.push(['mit', 'ruck']);
  segs.push(['in', 'haus'], ['der', 'weg'], ['in', 'stadt'], ['der', 'baum']);
  const counted = countNgrams(segs, { minCount: 3 });
  const rows = selectTop(counted, { limitPerN: 10 });
  const inDer = rows.find(r => r.phrase === 'in der');
  const mitRuck = rows.find(r => r.phrase === 'mit ruck');
  assert.ok(mitRuck.log_dice > inDer.log_dice,
    `kohäsive Wendung muss höheres log-Dice haben (${mitRuck.log_dice} vs ${inDer.log_dice})`);
});

test('locate: Segment-Indizes je Phrase, Mehrfachtreffer im Segment nur einmal', () => {
  const segs = [['a', 'b', 'x', 'a', 'b'], ['q'], ['a', 'b']];
  const hits = locate(segs, ['a b'], { maxN: 2 });
  assert.deepEqual(hits.get('a b'), [0, 2]);
});

// ----------------------------------------------------------------- keyness -----

test('logLikelihood: nachgerechnet, Vorzeichen trägt die Richtung', () => {
  // a=10, b=5, cA=cB=1000 → E1=E2=7.5
  // G² = 2·(10·ln(10/7.5) + 5·ln(5/7.5)) = 2·(2.876821 − 2.027326) = 1.699 → 1.7
  assert.equal(logLikelihood(10, 5, 1000, 1000), 1.7);
  // Gespiegelt: gleiche Stärke, im Zielkorpus unterrepräsentiert → negativ.
  assert.equal(logLikelihood(5, 10, 1000, 1000), -1.7);
});

test('logLikelihood: Wort fehlt in der Referenz → nur der Ziel-Term zählt', () => {
  // b=0 → zweiter Term entfällt (0·ln0 = 0), E1 = 1000·10/2000 = 5
  // G² = 2·10·ln(10/5) = 20·0.693147 = 13.86
  assert.equal(logLikelihood(10, 0, 1000, 1000), 13.86);
});

test('keynessFor: ohne Referenzkorpus bleibt die Spalte leer', () => {
  const target = frequencies(['haus', 'haus', 'haus']);
  const out = keynessFor(['haus'], target, new Map(), 3, 0);
  assert.equal(out.get('haus'), null);
});

test('keynessFor: unter der Mindesthäufigkeit im Zielbuch → null', () => {
  const target = frequencies(['haus', 'haus']);
  const out = keynessFor(['haus'], target, new Map([['haus', 1]]), 2, 1000);
  assert.equal(out.get('haus'), null);
});
