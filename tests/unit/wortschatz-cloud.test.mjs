// Wortwolke: die reine Auswahl- und Skalenlogik aus
// public/js/book/wortschatz-cloud.js. Das Layout selbst (d3-cloud) braucht ein
// Canvas und ist hier nicht Testgegenstand — getestet wird, WAS in die Wolke
// geht und mit welchem Gewicht.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCloudWords,
  cloudFontScale,
  cloudRotation,
} from '../../public/js/book/wortschatz-cloud.js';

const TERMS = [
  { term: 'nebel',   kind: 'freq', count: 40, keyness: 3.2 },
  { term: 'schwelle', kind: 'key', count: 4,  keyness: 22.5 },
  { term: 'gehen',   kind: 'freq', count: 12, keyness: null },
  { term: 'sagte',   kind: 'freq', count: 90, keyness: -18.0 },
];

test('freq-Modus gewichtet nach Häufigkeit und sortiert absteigend', () => {
  const rows = selectCloudWords(TERMS, 'freq');
  assert.deepEqual(rows.map(r => r.term), ['sagte', 'nebel', 'gehen', 'schwelle']);
  assert.equal(rows[0].weight, 90);
  assert.ok(rows.every(r => r.sign === 1), 'in der Häufigkeit gibt es kein Vorzeichen');
});

test('key-Modus nimmt den Betrag der Keyness, merkt sich aber das Vorzeichen', () => {
  const rows = selectCloudWords(TERMS, 'key');
  // gehen hat keine Keyness → fällt raus.
  assert.deepEqual(rows.map(r => r.term), ['schwelle', 'sagte', 'nebel']);
  assert.equal(rows[0].weight, 22.5);
  const sagte = rows.find(r => r.term === 'sagte');
  assert.equal(sagte.weight, 18, 'Betrag geht in die Grösse');
  assert.equal(sagte.sign, -1, 'gemieden bleibt als Vorzeichen erhalten');
});

test('key-Modus ohne Referenzkorpus liefert nichts (statt einer Wolke aus Nullen)', () => {
  const rows = selectCloudWords([{ term: 'a', count: 5, keyness: null }], 'key');
  assert.deepEqual(rows, []);
});

test('Auswahl ist gedeckelt und bei Gleichstand alphabetisch stabil', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ term: 'w' + String(i).padStart(3, '0'), count: 5 }));
  const rows = selectCloudWords(many, 'freq', 90);
  assert.equal(rows.length, 90);
  assert.equal(rows[0].term, 'w000');
  assert.equal(rows[89].term, 'w089');
});

test('Schriftskala ist monoton und bleibt in den Grenzen', () => {
  const rows = selectCloudWords(TERMS, 'freq');
  const scale = cloudFontScale(rows, 13, 76);
  const sizes = rows.map(r => scale(r.weight));
  assert.equal(Math.max(...sizes), 76);
  assert.equal(Math.min(...sizes), 13);
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] <= sizes[i - 1], 'grösseres Gewicht darf nie kleiner gesetzt werden');
  }
});

test('Wurzelskala dämpft den Zipf-Ausreisser gegenüber linear', () => {
  const rows = [{ weight: 1000 }, { weight: 100 }, { weight: 10 }];
  const scale = cloudFontScale(rows, 10, 100);
  const mid = scale(100);
  // Linear läge 100 bei ~18 und wäre gegen die 1000 optisch verschwunden.
  assert.ok(mid > 25, `Mittelwert zu stark gedrückt: ${mid}`);
  assert.ok(mid < 60);
});

test('gleiche Gewichte ergeben eine mittlere Grösse, nicht die maximale', () => {
  const scale = cloudFontScale([{ weight: 7 }, { weight: 7 }], 10, 80);
  assert.equal(scale(7), 45);
});

test('leere Liste kippt die Skala nicht', () => {
  assert.equal(cloudFontScale([], 13, 76)(99), 13);
});

test('Rotation ist deterministisch — gleiche Analyse, gleiches Bild', () => {
  const first = Array.from({ length: 10 }, (_, i) => cloudRotation(null, i));
  const again = Array.from({ length: 10 }, (_, i) => cloudRotation(null, i));
  assert.deepEqual(first, again);
  assert.deepEqual(first, [0, 0, 0, 0, -90, 0, 0, 0, 0, -90]);
});
