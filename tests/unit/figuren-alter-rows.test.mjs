// Verbindung von Katalog und Alters-Index (public/js/book/figuren-alter.js).
//
// KERNBEHAUPTUNG des Reiters, die hier festgenagelt wird: die zwei Alters-
// Quellen bleiben ZWEI. Der Textfund (was im Buch steht) und der gerechnete
// Wert (Bezugsjahr minus Geburtsjahr) stehen nebeneinander, weil ihre Abweichung
// der Befund IST — eine Zeile, die sich fuer einen der beiden entscheidet,
// verschweigt genau das. Und: die Tabelle arbeitet OHNE Lauf, dann traegt der
// Katalog sie allein.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { computeAlterRows } = await import('../../public/js/book/figuren-alter.js');

const figur = (over = {}) => ({
  id: 'fig_1', name: 'Dennis', kurzname: null, typ: 'hauptfigur',
  geburtstag: null, geburtsjahr: null, alter_im_roman: null, jahr_im_roman: null,
  stale: false, ...over,
});
const idx = (rows) => new Map(rows.map(r => [r.fig_id, r]));

test('ohne Lauf traegt der Katalog die Zeile', () => {
  const [row] = computeAlterRows([figur({ alter_im_roman: 34, geburtsjahr: 1985 })], null);
  assert.equal(row.alter_abgeleitet, 34);
  assert.equal(row.geburtsjahr, 1985);
  assert.equal(row.geburtsjahr_quelle, 'zeitstrahl');
  assert.equal(row.quelle, 'zeitstrahl');
  assert.equal(row.hatAlter, true);
  assert.deepEqual(row.belege, []);
});

test('Textfund und gerechneter Wert stehen NEBENEINANDER, nicht statt einander', () => {
  const ages = idx([{ fig_id: 'fig_1', alter_von: 12, alter_bis: 19, gerechnet: 34,
                      quelle: 'text', konfidenz: 0.9, geburtsjahr: 1985,
                      geburtsjahr_quelle: 'text', belege: [{ page_id: 7 }] }]);
  const [row] = computeAlterRows([figur({ alter_im_roman: 34 })], ages);
  assert.equal(row.alter_von, 12);
  assert.equal(row.alter_bis, 19);
  assert.equal(row.alter_abgeleitet, 34, 'der gerechnete Wert darf nicht wegfallen');
  assert.equal(row.quelle, 'text');
});

test('Index-Geburtsjahr schlaegt den Katalog (es kennt auch nur im Text Gefundenes)', () => {
  const ages = idx([{ fig_id: 'fig_1', geburtsjahr: 1971, geburtsjahr_quelle: 'text' }]);
  const [row] = computeAlterRows([figur({ geburtsjahr: 1985 })], ages);
  assert.equal(row.geburtsjahr, 1971);
  assert.equal(row.geburtsjahr_quelle, 'text');
});

test('ein einzelner Textfund ist eine Spanne der Laenge eins, kein offenes Ende', () => {
  const ages = idx([{ fig_id: 'fig_1', alter_von: 12 }]);
  const [row] = computeAlterRows([figur()], ages);
  assert.equal(row.alter_bis, 12);
});

test('stale-Figuren stehen nicht in der Tabelle', () => {
  assert.deepEqual(computeAlterRows([figur({ stale: true })], null), []);
});

test('Filter: Suche trifft Name UND Kurzname', () => {
  const figuren = [figur(), figur({ id: 'fig_2', name: 'Marion', kurzname: 'Mausi' })];
  assert.deepEqual(computeAlterRows(figuren, null, { suche: 'mausi' }).map(r => r.id), ['fig_2']);
  assert.deepEqual(computeAlterRows(figuren, null, { suche: 'denn' }).map(r => r.id), ['fig_1']);
});

test('Filter „nur": mitAlter / ohneAlter / widerspruch / beleg', () => {
  const figuren = [
    figur({ id: 'a', name: 'MitAlter', alter_im_roman: 34 }),
    figur({ id: 'b', name: 'OhneAlter' }),
    figur({ id: 'c', name: 'Streitfall' }),
  ];
  const ages = idx([{ fig_id: 'c', alter_von: 12, belege: [{ page_id: 3 }],
                      widerspruch: [{ typ: 'zitatWeichtAb', a: 12, b: 14 }] }]);
  const nur = (n) => computeAlterRows(figuren, ages, { nur: n }).map(r => r.id);
  assert.deepEqual(nur('mitAlter'), ['a', 'c']);
  assert.deepEqual(nur('ohneAlter'), ['b']);
  assert.deepEqual(nur('widerspruch'), ['c']);
  assert.deepEqual(nur('beleg'), ['c']);
  assert.deepEqual(nur(''), ['a', 'b', 'c']);
});

test('Filter „typ" schneidet auf einen Figurentyp', () => {
  const figuren = [figur(), figur({ id: 'fig_2', name: 'Bote', typ: 'randfigur' })];
  assert.deepEqual(computeAlterRows(figuren, null, { typ: 'randfigur' }).map(r => r.id), ['fig_2']);
});

test('sortiert nach Typ-Tier, dann Name (geteilte Taxonomie)', () => {
  const figuren = [
    figur({ id: '1', name: 'Zora',   typ: 'nebenfigur' }),
    figur({ id: '2', name: 'Anna',   typ: 'hauptfigur' }),
    figur({ id: '3', name: 'Bruno',  typ: 'hauptfigur' }),
    figur({ id: '4', name: 'Gegner', typ: 'antagonist' }),
  ];
  assert.deepEqual(computeAlterRows(figuren, null).map(r => r.name),
    ['Anna', 'Bruno', 'Gegner', 'Zora']);
});

test('vertraegt leere Eingaben', () => {
  assert.deepEqual(computeAlterRows(null, null), []);
  assert.deepEqual(computeAlterRows([], new Map()), []);
});
