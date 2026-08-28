// Kanonform der Zeitstrahl-Events: beide Produzenten (konsolidierter
// Server-Endpunkt + Figuren-Fallback) laufen durch normalizeEvent, und ALLE
// Leseseiten verlassen sich darauf, dass die mehrwertigen Anker Arrays sind.
// Ohne diesen Vertrag normalisiert jede Stelle einzeln nach — das stand an
// dreizehn Stellen und las teils Felder, die kein Produzent mehr setzt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, normalizeEvents } from '../../public/js/cards/ereignisse/model.js';
import { applyEreignisseFilters } from '../../public/js/cards/ereignisse-card.js';

test('Skalar-Anker des Fallback-Pfads werden zu Listen', () => {
  const ev = normalizeEvent({ kapitel: 'Kap 1', seite: 'Seite A', ereignis: 'x' });
  assert.deepEqual(ev.kapitel, ['Kap 1']);
  assert.deepEqual(ev.seiten, ['Seite A']);
  assert.equal('seite' in ev, false, 'kein zweiter Traeger derselben Aussage');
});

test('Listen des Server-Pfads bleiben unveraendert', () => {
  const ev = normalizeEvent({
    kapitel: ['A', 'B'], chapter_ids: [1, 2], seiten: ['S1'], page_ids: [7],
    figuren: [{ id: 'fig_1', name: 'Anna' }],
  });
  assert.deepEqual(ev.kapitel, ['A', 'B']);
  assert.deepEqual(ev.chapter_ids, [1, 2]);
  assert.deepEqual(ev.seiten, ['S1']);
  assert.deepEqual(ev.page_ids, [7]);
  assert.equal(ev.figuren.length, 1);
});

test('fehlende Anker werden leere Listen, nie undefined', () => {
  const ev = normalizeEvent({ ereignis: 'x' });
  for (const k of ['kapitel', 'chapter_ids', 'seiten', 'page_ids', 'figuren']) {
    assert.ok(Array.isArray(ev[k]), `${k} muss ein Array sein`);
    assert.equal(ev[k].length, 0);
  }
});

test('leere Strings zaehlen nicht als Anker', () => {
  const ev = normalizeEvent({ kapitel: '', seite: '' });
  assert.deepEqual(ev.kapitel, []);
  assert.deepEqual(ev.seiten, []);
});

test('typ/subtyp bekommen ihre Defaults', () => {
  const ev = normalizeEvent({});
  assert.equal(ev.typ, 'persoenlich');
  assert.equal(ev.subtyp, 'sonstiges');
});

test('Filter greifen auf der Kanonform beider Produzenten gleich', () => {
  // links Server-Form, rechts Fallback-Form — nach der Normalisierung
  // unterscheidbar nur noch durch ihre Werte.
  const events = normalizeEvents([
    { id: 1, ereignis: 'Server', kapitel: ['Kap 1'], seiten: ['Seite A'] },
    { id: 2, ereignis: 'Fallback', kapitel: 'Kap 1', seite: 'Seite A' },
    { id: 3, ereignis: 'Anderes Kapitel', kapitel: 'Kap 2', seite: 'Seite B' },
  ]);
  assert.equal(applyEreignisseFilters(events, { kapitel: 'Kap 1' }).length, 2);
  assert.equal(applyEreignisseFilters(events, { kapitel: 'Kap 1', seite: 'Seite A' }).length, 2);
  assert.equal(applyEreignisseFilters(events, { kapitel: 'Kap 2' }).length, 1);
});
