// Tests fuer die geteilte Auswahlregel der Top-Listen (public/js/book-overview/ranking.js).
// Sie traegt vier Aufrufer (Figuren-, Orte-, Song-Kachel und die Spaltenauswahl
// der Praesenz-Matrizen); die Song-Kachel hatte die Wiederkehr-Stufe frueher
// nicht — genau dagegen steht der zweite Test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPreferRecurring, RECURRING_MIN } from '../../public/js/book-overview/ranking.js';

const val = (x) => x.n;
const rank = (items, opts = {}) => rankPreferRecurring(items, { valueOf: val, ...opts });
const names = (rows) => rows.map(r => r.name);

test('leere Eingabe → leere Liste', () => {
  assert.deepEqual(rankPreferRecurring([], { valueOf: val }), []);
  assert.deepEqual(rankPreferRecurring(null, { valueOf: val }), []);
});

test('Stufe 1: wiederkehrende Eintraege verdraengen Einmal-Treffer', () => {
  const out = rank([
    { name: 'einmal-a', n: 1 },
    { name: 'oft', n: 9 },
    { name: 'einmal-b', n: 1 },
    { name: 'zweimal', n: 2 },
  ]);
  assert.deepEqual(names(out), ['oft', 'zweimal']);
});

test('Stufe 2: ohne Wiederkehrende zaehlen die Eintraege mit Fundstellen', () => {
  const out = rank([
    { name: 'ohne', n: 0 },
    { name: 'einmal', n: 1 },
    { name: 'auch-ohne', n: 0 },
  ]);
  assert.deepEqual(names(out), ['einmal']);
});

test('Stufe 3: ohne jede Fundstelle bleibt die Liste sichtbar', () => {
  // „Noch nichts ausgezaehlt" darf nicht wie „nichts vorhanden" aussehen —
  // die Kachel zeigt dann die Eintraege ohne Zahlen statt gar nichts.
  const out = rank([{ name: 'a', n: 0 }, { name: 'b', n: 0 }]);
  assert.deepEqual(names(out), ['a', 'b']);
});

test('absteigend sortiert und auf limit gekappt', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `x${i}`, n: i + 2 }));
  const out = rank(items, { limit: 3 });
  assert.deepEqual(out.map(val), [11, 10, 9]);
});

test('Default-Limit ist 6', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `x${i}`, n: 5 }));
  assert.equal(rank(items).length, 6);
});

test('Eingabe wird nicht mutiert', () => {
  const items = [{ name: 'a', n: 1 }, { name: 'b', n: 9 }];
  rank(items);
  assert.deepEqual(names(items), ['a', 'b'], 'Reihenfolge des Originals bleibt');
});

test('minRecurring ist die Schwelle der ersten Stufe', () => {
  assert.equal(RECURRING_MIN, 2);
  const items = [{ name: 'a', n: 2 }, { name: 'b', n: 1 }];
  assert.deepEqual(names(rank(items)), ['a']);
  // Schwelle hoeher → niemand ist „wiederkehrend", Stufe 2 greift.
  assert.deepEqual(names(rank(items, { minRecurring: 5 })), ['a', 'b']);
});
