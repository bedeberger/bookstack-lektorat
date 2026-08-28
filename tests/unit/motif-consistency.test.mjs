// Motiv-Konsistenz — die deterministische Messschicht der Motiv-Werkstatt.
//
// Zwei Dinge werden hier festgehalten:
//  1. Die Befunde selbst (welche Konstellation aus Kanten + Fundstellen erzeugt
//     welchen Code) — sie sind das ganze Feature, und sie sind pure Rechnung.
//  2. Die BEWUSSTE Kopie der Typ-Liste: die Familien-Tabelle lebt serverseitig
//     (CJS, lib/motif-consistency.js), die Picker-Reihenfolge im Browser-Bundle
//     (ESM, public/js/book/motiv/constants.js). Sie duerfen nicht driften —
//     ein Typ, den das Frontend anbietet und der Server nicht kennt, erzeugt
//     stumm eine unpruefbare Kante.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { MOTIF_REL_TYPES as FRONTEND_TYPES } from '../../public/js/book/motiv/constants.js';

const require = createRequire(import.meta.url);
const {
  MOTIF_REL_TYPES, MOTIF_REL_FAMILY, relFamily, computeMotifFindings,
} = require('../../lib/motif-consistency.js');
const de = require('../../public/js/i18n/de.json');
const en = require('../../public/js/i18n/en.json');

// Motiv-Fabrik: `chapters` = Soll-Bruecke, `occ` = Ist-Kapitel [id, …].
function motif(id, name, occ = [], { soll = [], count = null } = {}) {
  return {
    id, name,
    occurrenceCount: count == null ? occ.length : count,
    occChapters: occ.map(c => ({ chapterId: c, n: 1 })),
    chapters: soll.map(c => ({ id: c, name: `K${c}` })),
  };
}
const rel = (id, from, to, typ) => ({ id, from_motif_id: from, to_motif_id: to, typ });
const codes = (fs) => fs.map(f => f.code);

test('Typ-Familien: nur kuratierte Typen tragen eine Erwartung', () => {
  assert.equal(relFamily('verstaerkt'), 'gleichlauf');
  assert.equal(relFamily('kontrastiert'), 'spannung');
  assert.equal(relFamily('erinnert an'), null, 'Freitext wird nicht interpretiert');
  assert.equal(relFamily(''), null);
  assert.equal(relFamily(null), null);
});

test('Frontend-Picker und Server-Familien kennen dieselben Typen', () => {
  assert.deepEqual([...FRONTEND_TYPES].sort(), [...MOTIF_REL_TYPES].sort());
  assert.deepEqual([...MOTIF_REL_TYPES].sort(), Object.keys(MOTIF_REL_FAMILY).sort());
});

test('jeder Kanten-Typ hat ein Label in beiden Locales', () => {
  for (const t of MOTIF_REL_TYPES) {
    assert.ok(de[`motiv.relation.type.${t}`], `de fehlt: motiv.relation.type.${t}`);
    assert.ok(en[`motiv.relation.type.${t}`], `en fehlt: motiv.relation.type.${t}`);
  }
});

test('ungescannt liefert nichts — ungeprueft ist nicht abwesend', () => {
  const motifs = [motif(1, 'Wasser', [], { count: 0 }), motif(2, 'Feuer', [], { count: 0 })];
  const relations = [rel(9, 1, 2, 'verstaerkt')];
  assert.deepEqual(computeMotifFindings({ motifs, relations, chapterOrder: [1, 2, 3], scanned: false }), []);
  // Mit Scan wird aus derselben Lage ein Befund.
  assert.deepEqual(
    codes(computeMotifFindings({ motifs, relations, chapterOrder: [1, 2, 3], scanned: true })),
    ['geistNachbar'],
  );
});

test('Geist-Nachbar: Kante zeigt auf ein Motiv ohne jede Fundstelle', () => {
  const motifs = [motif(1, 'Wasser', [1, 2]), motif(2, 'Feuer', [], { count: 0 })];
  const found = computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'erinnert an')], chapterOrder: [1, 2, 3],
  });
  assert.deepEqual(codes(found), ['geistNachbar']);
  assert.equal(found[0].motiv_id, 1);
  assert.equal(found[0].partner, 'Feuer');
  assert.equal(found[0].relation_id, 9, 'die Kante ist referenzierbar (Graph-Markierung)');
  // Gilt auch fuer Freitext-Typen: dafuer braucht es keine Erwartung, nur die Zahl 0.
  assert.equal(found[0].typ, 'erinnert an');
});

test('Spannungs-Kante ohne gemeinsames Kapitel', () => {
  const motifs = [motif(1, 'Wasser', [1, 2]), motif(2, 'Feuer', [7, 8])];
  const found = computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'kontrastiert')], chapterOrder: [1, 2, 7, 8],
  });
  assert.deepEqual(codes(found), ['kontrastOhneBeruehrung']);
  assert.deepEqual(found[0].params, { kapitelFrom: 2, kapitelTo: 2 });
});

test('Spannungs-Kante mit Beruehrung ist in Ordnung', () => {
  const motifs = [motif(1, 'Wasser', [1, 2]), motif(2, 'Feuer', [2, 8])];
  assert.deepEqual(computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'kontrastiert')], chapterOrder: [1, 2, 8],
  }), []);
});

test('Gleichlauf-Kante mit zu duenner Ueberlappung', () => {
  // 1 gemeinsames von 4 Kapiteln des schmaleren Motivs = 0.25 < OVERLAP_MIN.
  const motifs = [motif(1, 'Wasser', [1, 2, 3, 4]), motif(2, 'Spiegel', [4, 7, 8, 9])];
  const found = computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'verstaerkt')], chapterOrder: [1, 2, 3, 4, 7, 8, 9],
  });
  assert.deepEqual(codes(found), ['gleichlaufOhneDeckung']);
  assert.deepEqual(found[0].params, { shared: 1, smaller: 4 });
});

test('Gleichlauf-Kante mit genug Deckung schweigt', () => {
  const motifs = [motif(1, 'Wasser', [1, 2, 3, 4]), motif(2, 'Spiegel', [2, 3, 4, 9])];
  assert.deepEqual(computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'verstaerkt')], chapterOrder: [1, 2, 3, 4, 9],
  }), []);
});

test('unbekannter Typ wird nicht als Familie interpretiert', () => {
  const motifs = [motif(1, 'Wasser', [1, 2]), motif(2, 'Feuer', [7, 8])];
  assert.deepEqual(computeMotifFindings({
    motifs, relations: [rel(9, 1, 2, 'erinnert an')], chapterOrder: [1, 2, 7, 8],
  }), [], 'kein Verteilungs-Befund ohne Erwartung');
});

test('Nabe ohne Substanz: viel verknuepft, im Text kaum da', () => {
  const chapterOrder = [1, 2, 3, 4, 5, 6, 7, 8];
  const motifs = [
    motif(1, 'Nabe', [1], { count: 1 }),
    ...[2, 3, 4, 5, 6].map(i => motif(i, `M${i}`, [1, 2, 3, 4, 5, 6, 7, 8], { count: 20 })),
  ];
  const relations = [rel(1, 1, 2, 'bedingt'), rel(2, 1, 3, 'bedingt'), rel(3, 1, 4, 'bedingt')];
  const found = computeMotifFindings({ motifs, relations, chapterOrder });
  const nabe = found.filter(f => f.code === 'nabeOhneSubstanz');
  assert.equal(nabe.length, 1);
  assert.equal(nabe[0].motiv, 'Nabe');
  assert.deepEqual(nabe[0].params, { kanten: 3, fundstellen: 1 });
});

test('Soll-Ist-Divergenz: zugeordnet hier, gefunden dort', () => {
  const motifs = [motif(1, 'Wasser', [7, 8], { soll: [1, 2] })];
  const found = computeMotifFindings({ motifs, relations: [], chapterOrder: [1, 2, 7, 8] });
  assert.deepEqual(codes(found), ['sollIstDivergenz']);
  assert.deepEqual(found[0].params, { soll: 2, ist: 2 });
});

test('Soll-Ist-Divergenz schweigt bei Ueberschneidung', () => {
  const motifs = [motif(1, 'Wasser', [2, 8], { soll: [1, 2] })];
  assert.deepEqual(computeMotifFindings({ motifs, relations: [], chapterOrder: [1, 2, 8] }), []);
});

test('Abbruch im Bogen: alles im vorderen Drittel', () => {
  const chapterOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const motifs = [motif(1, 'Wasser', [1, 2], { count: 5 }), motif(2, 'Feuer', [1, 2, 3, 4, 5, 6, 7, 8, 9])];
  const found = computeMotifFindings({ motifs, relations: [rel(1, 1, 2, 'bedingt')], chapterOrder });
  const arc = found.filter(f => f.code === 'abbruchImBogen');
  assert.equal(arc.length, 1);
  assert.equal(arc[0].motiv, 'Wasser');
  assert.deepEqual(arc[0].params, { letztesKapitel: 2, kapitelGesamt: 9, fundstellen: 5 });
});

test('Befunde sind nach Schwere sortiert', () => {
  const motifs = [
    motif(1, 'Wasser', [1, 2, 3, 4]),
    motif(2, 'Spiegel', [4, 7, 8, 9]),   // gleichlaufOhneDeckung (mittel)
    motif(3, 'Feuer', [], { count: 0 }), // geistNachbar (stark)
  ];
  const relations = [rel(1, 1, 2, 'verstaerkt'), rel(2, 1, 3, 'verstaerkt')];
  const found = computeMotifFindings({ motifs, relations, chapterOrder: [1, 2, 3, 4, 7, 8, 9] });
  assert.deepEqual(codes(found), ['geistNachbar', 'gleichlaufOhneDeckung']);
});

test('jeder Befund-Code hat Text + Hinweis in beiden Locales', () => {
  const CODES = [
    'geistNachbar', 'kontrastOhneBeruehrung', 'gleichlaufOhneDeckung',
    'nabeOhneSubstanz', 'sollIstDivergenz', 'abbruchImBogen',
  ];
  for (const c of CODES) {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      assert.ok(loc[`motiv.check.${c}`], `${name} fehlt: motiv.check.${c}`);
      assert.ok(loc[`motiv.check.${c}.hint`], `${name} fehlt: motiv.check.${c}.hint`);
    }
  }
});
