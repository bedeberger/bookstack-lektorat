// Figuren-Graph: Kantenbau aus den Beziehungen (Dedup, Richtung, Machtbreite).
// `_buildEdges` lebt als Methode am Karten-Pool; hier mit minimalem Fake-`this`
// aufgerufen — es greift nur auf `_graphFiguren()` und `_theme()` zu.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import { sharedMethods } from '../../public/js/graph/shared.js';

// Light-Theme-Attrappe: keine Farbnachführung, damit die Palette-Werte
// unverändert durchkommen und die Assertions über Farben lesbar bleiben.
const LIGHT = { dark: false, text: '#333', muted: '#777', ink: (c) => c };

function buildEdges(figuren, soziogramm = false) {
  const ctx = { _graphFiguren: () => figuren, _theme: () => LIGHT };
  return sharedMethods._buildEdges.call(ctx, soziogramm).edgeList;
}

const f = (id, beziehungen = []) => ({ id, name: id, beziehungen });
const bz = (figur_id, typ, extra = {}) => ({ figur_id, typ, ...extra });

describe('_buildEdges: Dedup', () => {
  test('ungerichteter Typ beidseitig gepflegt → eine Kante', () => {
    const edges = buildEdges([
      f('a', [bz('b', 'freund')]),
      f('b', [bz('a', 'freund')]),
    ]);
    assert.strictEqual(edges.length, 1);
  });

  test('gerichteter Typ: Hin- und Rückrichtung sind zwei Aussagen', () => {
    const edges = buildEdges([
      f('a', [bz('b', 'mentor')]),
      f('b', [bz('a', 'mentor')]),
    ]);
    assert.strictEqual(edges.length, 2);
  });

  test('verschiedene Typen zwischen demselben Paar bleiben nebeneinander', () => {
    const edges = buildEdges([
      f('a', [bz('b', 'freund'), bz('b', 'kollege')]),
      f('b', []),
    ]);
    assert.deepStrictEqual(edges.map(e => e.typ).sort(), ['freund', 'kollege']);
  });

  test('Beziehung auf eine nicht (mehr) existierende Figur wird verworfen', () => {
    const edges = buildEdges([f('a', [bz('weg', 'freund')])]);
    assert.deepStrictEqual(edges, []);
  });

  test('Zahl-ID auf der einen und String-ID auf der anderen Seite finden sich', () => {
    const edges = buildEdges([
      { id: 'a', name: 'a', beziehungen: [{ figur_id: 7, typ: 'freund' }] },
      { id: 7, name: 'b', beziehungen: [] },
    ]);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].to, 7, 'Ziel-ID bleibt die der Figur, nicht die des Verweises');
  });
});

describe('_buildEdges: Darstellung', () => {
  test('Standardgraph nimmt Pfeil/Strichelung aus der Typ-Palette', () => {
    const [kind] = buildEdges([f('a', [bz('b', 'kind')]), f('b')]);
    assert.strictEqual(kind.arrows, 'from');
    const [gesch] = buildEdges([f('a', [bz('b', 'geschwister')]), f('b')]);
    assert.deepStrictEqual(gesch.dashes, [5, 5]);
  });

  test('unbekannter Beziehungstyp fällt auf "andere" statt zu brechen', () => {
    const [e] = buildEdges([f('a', [bz('b', 'erfunden')]), f('b')]);
    assert.strictEqual(e.typ, 'erfunden');
    assert.ok(e.color.color, 'Farbe aus BZ.andere');
  });

  test('Soziogramm: Machtverhältnis bestimmt Richtung und Breite', () => {
    const [dom] = buildEdges([f('a', [bz('b', 'kollege', { machtverhaltnis: 2 })]), f('b')], true);
    assert.strictEqual(dom.arrows, 'to');
    const [sub] = buildEdges([f('a', [bz('b', 'kollege', { machtverhaltnis: -2 })]), f('b')], true);
    assert.strictEqual(sub.arrows, 'from');
    assert.ok(dom.width > 1 && dom.width === sub.width, 'Breite = Betrag der Macht');
  });

  test('Soziogramm ohne Machtangabe: gerichteter Typ behält seinen Pfeil', () => {
    const [e] = buildEdges([f('a', [bz('b', 'vorgesetzter')]), f('b')], true);
    assert.strictEqual(e.arrows, 'to');
    const [flat] = buildEdges([f('a', [bz('b', 'freund')]), f('b')], true);
    assert.strictEqual(flat.arrows, '');
  });
});

describe('_buildEdges: Theme-Nachführung', () => {
  test('Dark-Mode reicht jede Kantenfarbe durch die Lesbarkeits-Korrektur', () => {
    const seen = [];
    const ctx = {
      _graphFiguren: () => [f('a', [bz('b', 'freund')]), f('b')],
      _theme: () => ({ dark: true, ink: (c) => { seen.push(c); return 'INK'; } }),
    };
    const [e] = sharedMethods._buildEdges.call(ctx, false).edgeList;
    assert.strictEqual(e.color.color, 'INK');
    assert.strictEqual(e.color.highlight, 'INK');
    assert.strictEqual(seen.length, 2, 'Ruhe- und Highlight-Farbe');
  });
});
