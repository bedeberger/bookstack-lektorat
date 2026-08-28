// Unit-Tests fuer den Lebenslauf-Reiter der Figuren-Karte.
//
// Getestet wird die reine Schicht (public/js/book/figuren-lebenslauf.js): die
// Zuordnung Ereignis → Lebensphase, die Kandidatenwahl und der Matrix-Aufbau.
// Die Alpine-Methoden daneben sind duenne Leser darauf.
//
// KERNBEHAUPTUNG des Features, die hier festgenagelt wird: die Zeilen-Achse ist
// das ALTER, nicht das Jahr. Zwei ungleich alte Figuren muessen im selben
// Lebensabschnitt in derselben Zeile stehen, obwohl ihre Kalenderjahre
// auseinanderliegen. Faellt dieser Test, ist der Vergleich, um den es geht,
// kaputt — auch wenn die Tabelle noch rendert.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  jahrAusDatum, phaseFuerAlter, figurGeburtsjahr,
  computeLebenslaufKandidaten, computeLebenslauf,
  LEBENSPHASEN, PHASE_UNDATIERT,
} = await import('../../public/js/book/figuren-lebenslauf.js');

const evt = (datum, ereignis, extra = {}) => ({ datum, ereignis, subtyp: 'sonstiges', ...extra });

// Nachbau der beiden Hauptfiguren aus „Der Amoklauf": ein Jahr Altersunterschied,
// beide im selben Schulhaus, aber in verschiedenen Kalenderjahren.
const DENNIS = {
  id: 'fig_42', name: 'Dennis', typ: 'hauptfigur', geburtstag: '1985', geburtsjahr: 1985,
  lebensereignisse: [
    evt('1985', 'Geburt von Dennis im Kantonsspital Olten', { subtyp: 'geburt' }),
    evt('1991', 'Dennis beginnt die Schule im Bifang-Schulhaus', { subtyp: 'wendepunkt', page_id: 11 }),
    evt('1997', 'Dennis wechselt ins Frohheim in die Bezirksschule', { subtyp: 'wendepunkt' }),
  ],
};
const SAMUEL = {
  id: 'fig_30', name: 'Samuel', typ: 'hauptfigur', geburtstag: '1986', geburtsjahr: 1986,
  lebensereignisse: [
    evt('1986', 'Geburt von Samuel', { subtyp: 'geburt' }),
    evt('1990', 'Samuel erkrankt an Kinderleukämie', { subtyp: 'krankheit' }),
    evt('1999', 'Samuel wechselt in die Sekundarstufe im Frohheim', { subtyp: 'wendepunkt' }),
    evt('2002', 'Samuel beginnt seine KV-Lehre', { subtyp: 'wendepunkt' }),
  ],
};

test('jahrAusDatum liest die erste vierstellige Jahreszahl', () => {
  assert.equal(jahrAusDatum('1985'), 1985);
  assert.equal(jahrAusDatum('Frühling 1850'), 1850);
  assert.equal(jahrAusDatum('5.8.2002'), 2002);
  assert.equal(jahrAusDatum('irgendwann später'), null);
  assert.equal(jahrAusDatum(''), null);
  assert.equal(jahrAusDatum(null), null);
});

test('phaseFuerAlter trifft die Bandgrenzen exakt', () => {
  assert.equal(phaseFuerAlter(-1), 'vorgeschichte');
  assert.equal(phaseFuerAlter(-40), 'vorgeschichte');
  assert.equal(phaseFuerAlter(0), 'geburt');
  assert.equal(phaseFuerAlter(1), 'kleinkind');
  assert.equal(phaseFuerAlter(5), 'kleinkind');
  assert.equal(phaseFuerAlter(6), 'schulkind');
  assert.equal(phaseFuerAlter(11), 'schulkind');
  assert.equal(phaseFuerAlter(12), 'jugend');
  assert.equal(phaseFuerAlter(17), 'jugend');
  assert.equal(phaseFuerAlter(18), 'jungerwachsen');
  assert.equal(phaseFuerAlter(29), 'jungerwachsen');
  assert.equal(phaseFuerAlter(30), 'erwachsen');
  assert.equal(phaseFuerAlter(49), 'erwachsen');
  assert.equal(phaseFuerAlter(50), 'reife');
  assert.equal(phaseFuerAlter(64), 'reife');
  assert.equal(phaseFuerAlter(65), 'hochalter');
  assert.equal(phaseFuerAlter(120), 'hochalter');
  assert.equal(phaseFuerAlter(null), PHASE_UNDATIERT);
  assert.equal(phaseFuerAlter(NaN), PHASE_UNDATIERT);
});

test('die Baender sind lueckenlos und ueberschneidungsfrei', () => {
  for (let a = 0; a <= 120; a++) {
    const treffer = LEBENSPHASEN.filter(p =>
      (p.von == null || a >= p.von) && (p.bis == null || a <= p.bis));
    assert.equal(treffer.length, 1, `Alter ${a} trifft ${treffer.length} Phasen`);
  }
});

test('figurGeburtsjahr: Index vor Katalog vor Stammfeld', () => {
  assert.equal(figurGeburtsjahr({ geburtsjahr: 1985, geburtstag: '1912' }, { geburtsjahr: 1888 }), 1888);
  assert.equal(figurGeburtsjahr({ geburtsjahr: 1985, geburtstag: '1912' }, null), 1985);
  assert.equal(figurGeburtsjahr({ geburtstag: '3. Mai 1912' }, null), 1912);
  assert.equal(figurGeburtsjahr({}, null), null);
});

test('Kandidaten: ohne Geburtsjahr keine Spalte, aber gezaehlt', () => {
  const ohne = { id: 'fig_9', name: 'Namenlos', typ: 'nebenfigur', lebensereignisse: [evt('1990', 'x')] };
  const stale = { ...DENNIS, id: 'fig_x', stale: true };
  const leer = { id: 'fig_8', name: 'Statist', typ: 'nebenfigur', geburtsjahr: 1950, lebensereignisse: [] };
  const { liste, ohneJahr } = computeLebenslaufKandidaten([DENNIS, SAMUEL, ohne, stale, leer], null);
  assert.deepEqual(liste.map(k => k.id), ['fig_30', 'fig_42']); // mehr Ereignisse zuerst
  assert.equal(ohneJahr, 1);
});

test('Kandidaten: Suche und Typfilter', () => {
  const neben = { ...SAMUEL, id: 'fig_7', name: 'Pamela', typ: 'nebenfigur' };
  assert.deepEqual(
    computeLebenslaufKandidaten([DENNIS, SAMUEL, neben], null, { typ: 'hauptfigur' }).liste.map(k => k.name),
    ['Samuel', 'Dennis']);
  assert.deepEqual(
    computeLebenslaufKandidaten([DENNIS, SAMUEL, neben], null, { suche: 'den' }).liste.map(k => k.name),
    ['Dennis']);
});

test('Zeilen-Achse ist das Alter: Uebertritt beider Figuren in EINER Zeile', () => {
  const { spalten, zeilen } = computeLebenslauf([DENNIS, SAMUEL], null, ['fig_42', 'fig_30']);
  assert.deepEqual(spalten.map(s => s.name), ['Samuel', 'Dennis']);

  const jugend = zeilen.find(z => z.key === 'jugend');
  assert.ok(jugend, 'Jugend-Zeile fehlt');
  // Samuel steht in Spalte 0 (mehr Ereignisse), Dennis in Spalte 1.
  const samuelJugend = jugend.zellen[0].map(e => e.jahr);
  const dennisJugend = jugend.zellen[1].map(e => e.jahr);
  // 1997 (Dennis, 12) und 1999 (Samuel, 13): verschiedene Jahre, dieselbe Zeile.
  assert.deepEqual(dennisJugend, [1997]);
  assert.deepEqual(samuelJugend, [1999, 2002]);
});

test('Matrix: Alter pro Zelle, Geburt und Kindheit getrennt, Sprungziel erhalten', () => {
  const { zeilen } = computeLebenslauf([DENNIS, SAMUEL], null, ['fig_42', 'fig_30']);
  const keys = zeilen.map(z => z.key);
  assert.deepEqual(keys, ['geburt', 'kleinkind', 'schulkind', 'jugend']);

  const schulkind = zeilen.find(z => z.key === 'schulkind');
  const dennisSchule = schulkind.zellen[1][0];
  assert.equal(dennisSchule.jahr, 1991);
  assert.equal(dennisSchule.alter, 6);
  assert.equal(dennisSchule.page_id, 11);           // Sprungziel bleibt erhalten
  assert.equal(schulkind.zellen[0].length, 0);      // Samuel: nichts in dieser Phase

  const kleinkind = zeilen.find(z => z.key === 'kleinkind');
  assert.equal(kleinkind.zellen[0][0].alter, 4);    // Samuel, Leukämie mit vier
});

test('Leere Phasen erscheinen nicht als Zeile', () => {
  const { zeilen } = computeLebenslauf([DENNIS], null, ['fig_42']);
  assert.ok(!zeilen.some(z => z.key === 'jungerwachsen'));
  assert.ok(!zeilen.some(z => z.key === PHASE_UNDATIERT));
});

test('Undatierte und vorgeburtliche Ereignisse bekommen eigene Zeilen', () => {
  const f = {
    id: 'fig_1', name: 'Anna', typ: 'hauptfigur', geburtsjahr: 1900,
    lebensereignisse: [
      evt('1880', 'Die Eltern lernen sich kennen'),
      evt('später einmal', 'Anna verschwindet'),
      evt('1900', 'Geburt', { subtyp: 'geburt' }),
    ],
  };
  const { zeilen } = computeLebenslauf([f], null, ['fig_1']);
  assert.deepEqual(zeilen.map(z => z.key), ['vorgeschichte', 'geburt', PHASE_UNDATIERT]);
  assert.equal(zeilen[0].zellen[0][0].alter, -20);
  assert.equal(zeilen[2].zellen[0][0].jahr, null);
  assert.equal(zeilen[2].zellen[0][0].datum, 'später einmal');
});

test('Ereignisse einer Zelle stehen chronologisch', () => {
  const f = {
    id: 'fig_1', name: 'Anna', typ: 'hauptfigur', geburtsjahr: 1900,
    lebensereignisse: [evt('1925', 'c'), evt('1919', 'a'), evt('1922', 'b')],
  };
  const { zeilen } = computeLebenslauf([f], null, ['fig_1']);
  assert.deepEqual(zeilen[0].zellen[0].map(e => e.ereignis), ['a', 'b', 'c']);
});

test('Ohne Auswahl keine Matrix (und kein Absturz)', () => {
  assert.deepEqual(computeLebenslauf([DENNIS], null, []), { spalten: [], zeilen: [] });
  assert.deepEqual(computeLebenslauf([], null, ['fig_42']), { spalten: [], zeilen: [] });
  assert.deepEqual(computeLebenslauf(null, null, null), { spalten: [], zeilen: [] });
});

test('Der Alters-Index liefert ein Geburtsjahr nach, das der Katalog nicht kennt', () => {
  const nurText = { id: 'fig_5', name: 'Rolf', typ: 'nebenfigur', lebensereignisse: [evt('1970', 'Rolf zieht fort')] };
  const ages = new Map([['fig_5', { geburtsjahr: 1955 }]]);
  assert.equal(computeLebenslaufKandidaten([nurText], null).liste.length, 0);
  const { spalten, zeilen } = computeLebenslauf([nurText], ages, ['fig_5']);
  assert.equal(spalten.length, 1);
  assert.equal(zeilen[0].key, 'jugend');
  assert.equal(zeilen[0].zellen[0][0].alter, 15);
});
