// Unit: lib/welt-summary.js — die Weltaufbau-MESSUNG fuer die Buchbewertung.
//
// Pure Zaehlerei, ohne DB testbar (gleiche Begruendung wie struktur-summary).
// Die tragende Invariante steht im ersten Test: ein NICHT erhobener Index liefert
// null, damit die Bewertung „nie analysiert" nicht als „weltarm" benotet.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeWorldFacts } = require('../../lib/welt-summary.js');

const KAP = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'];
const FAKTEN = [
  { kategorie: 'regel', subjekt: 'Magie', fakt: 'Tote kehren nie zurueck.', kapitel: ['K1'] },
  { kategorie: 'regel', subjekt: 'Magie', fakt: 'Zauber kostet Lebenszeit.', kapitel: ['K2', 'K3'] },
  { kategorie: 'ort', subjekt: 'Nordwall', fakt: 'Der Nordwall trennt zwei Reiche.', kapitel: ['K1'] },
  { kategorie: 'historie', subjekt: null, fakt: 'Der Krieg endete 1712.', kapitel: [] },
];

test('nicht erhobener Index → null (nicht „0 Fakten")', () => {
  assert.equal(summarizeWorldFacts({ scanned: false, fakten: [] }, KAP), null);
  // Auch mit (fremden) Fakten im Objekt: `scanned:false` ist das Veto.
  assert.equal(summarizeWorldFacts({ scanned: false, fakten: FAKTEN }, KAP), null);
  assert.equal(summarizeWorldFacts(null, KAP), null);
});

test('erhoben, aber leer → ebenfalls null (kein Block ohne Messwerte)', () => {
  assert.equal(summarizeWorldFacts({ scanned: true, fakten: [] }, KAP), null);
});

test('Kategorien absteigend, Naben nur ab zwei Fakten', () => {
  const s = summarizeWorldFacts({ scanned: true, fakten: FAKTEN }, KAP);
  assert.deepEqual(s.proKategorie[0], { kategorie: 'regel', anzahl: 2 });
  assert.equal(s.gesamt, 4);
  assert.deepEqual(s.topSubjekte, [{ subjekt: 'Magie', anzahl: 2 }]);
});

test('Kapitel-Abdeckung nennt die Kapitel ohne etablierten Fakt', () => {
  const s = summarizeWorldFacts({ scanned: true, fakten: FAKTEN }, KAP);
  assert.equal(s.kapitelAbdeckung.gesamt, 6);
  assert.equal(s.kapitelAbdeckung.mitFakten, 3);
  assert.deepEqual(s.kapitelAbdeckung.ohneFakten, ['K4', 'K5', 'K6']);
});

test('Fakten ohne Kapitelbezug werden ausgewiesen, nicht in den Bogen gerechnet', () => {
  const s = summarizeWorldFacts({ scanned: true, fakten: FAKTEN }, KAP);
  assert.equal(s.ohneKapitelBezug, 1);
  assert.equal(s.bogen.anfang + s.bogen.mitte + s.bogen.schluss, 4);  // 3x anfang, 1x mitte
  assert.deepEqual(s.bogen, { anfang: 3, mitte: 1, schluss: 0 });
});

test('ein Fakt zaehlt je Drittel nur einmal, auch bei vielen Kapiteln darin', () => {
  const s = summarizeWorldFacts({
    scanned: true,
    fakten: [{ kategorie: 'regel', fakt: 'Gilt ueberall.', kapitel: ['K1', 'K2'] }],
  }, KAP);
  assert.equal(s.bogen.anfang, 1);   // K1 + K2 liegen beide im ersten Drittel
});

test('Kapitel-Deckel wird offengelegt statt die Liste als vollstaendig zu zeigen', () => {
  const viele = Array.from({ length: 30 }, (_, i) => `Kap ${i + 1}`);
  const s = summarizeWorldFacts({
    scanned: true,
    fakten: [{ kategorie: 'regel', fakt: 'Nur hier.', kapitel: ['Kap 1'] }],
  }, viele);
  assert.equal(s.kapitelAbdeckung.ohneFakten.length, 10);
  assert.equal(s.kapitelAbdeckung.ohneFaktenGekuerzt, 19);
});

test('Beispiele streuen ueber die Kategorien statt eine zu wiederholen', () => {
  const fakten = [
    ...Array.from({ length: 10 }, (_, i) => ({ kategorie: 'kultur', fakt: `Kultur ${i}`, kapitel: ['K1'] })),
    { kategorie: 'regel', fakt: 'Die eine Regel.', kapitel: ['K2'] },
  ];
  const s = summarizeWorldFacts({ scanned: true, fakten }, KAP);
  assert.ok(s.beispiele.some(b => b.kategorie === 'regel'),
    'die einzige Regel muss unter den Beispielen auftauchen');
  assert.equal(s.beispiele[1].kategorie, 'regel');   // Round-Robin: zweite Kategorie sofort dran
});

test('Kapitelnamen matchen unabhaengig von Gross-/Kleinschreibung und Whitespace', () => {
  const s = summarizeWorldFacts({
    scanned: true,
    fakten: [{ kategorie: 'regel', fakt: 'X.', kapitel: ['  k1 '] }],
  }, ['K1', 'K2']);
  assert.equal(s.kapitelAbdeckung.mitFakten, 1);
  assert.deepEqual(s.kapitelAbdeckung.ohneFakten, ['K2']);
});
