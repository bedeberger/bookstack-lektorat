// Motiv-Konstellation: Knoten-ID-Namespace und die Grössenskala der Motiv-Naben.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  nodeId, parseNode, makeMotifSize, defaultThemeColorKey, THEME_COLOR_KEYS,
  MOTIF_SIZE_MIN, MOTIF_SIZE_MAX, MOTIF_SIZE_GHOST,
} from '../../public/js/book/motiv/graph.js';

describe('Knoten-ID-Namespace', () => {
  test('Round-Trip über alle Knoten-Arten', () => {
    for (const kind of ['theme', 'motif', 'figure', 'draftFigure', 'beat', 'chapter']) {
      assert.deepStrictEqual(parseNode(nodeId(kind, 42)), { kind, id: 42 });
    }
  });

  test('df wird vor den Einzelbuchstaben gematcht (sonst wäre df7 eine Werkstatt-Figur d…)', () => {
    assert.deepStrictEqual(parseNode('df7'), { kind: 'draftFigure', id: 7 });
    assert.deepStrictEqual(parseNode('f7'), { kind: 'figure', id: 7 });
  });

  test('Fremdes/leeres → null statt Halb-Treffer', () => {
    for (const bad of ['', null, undefined, 'x1', 'm', 'm1x', '7']) {
      assert.strictEqual(parseNode(bad), null, `parseNode(${JSON.stringify(bad)})`);
    }
  });
});

describe('Themen-Auto-Farbe', () => {
  test('läuft zyklisch durch die Palette', () => {
    assert.strictEqual(defaultThemeColorKey(0), THEME_COLOR_KEYS[0]);
    assert.strictEqual(defaultThemeColorKey(THEME_COLOR_KEYS.length), THEME_COLOR_KEYS[0]);
  });
  test('verträgt negative Indizes (kein undefined im Canvas)', () => {
    assert.ok(THEME_COLOR_KEYS.includes(defaultThemeColorKey(-1)));
  });
});

describe('makeMotifSize', () => {
  test('Geist-Knoten bleiben fix klein, unabhängig vom Datensatz', () => {
    const size = makeMotifSize([1, 50]);
    assert.strictEqual(size({ ghost: true, count: 0, score: 0 }), MOTIF_SIZE_GHOST);
    assert.ok(MOTIF_SIZE_GHOST < MOTIF_SIZE_MIN);
  });

  test('bleibt innerhalb der Spanne', () => {
    const size = makeMotifSize([0, 3, 40]);
    for (const m of [{ count: 0, score: 0 }, { count: 40, score: 1 }, { count: 7, score: 0.5 }]) {
      const s = size(m);
      assert.ok(s >= MOTIF_SIZE_MIN && s <= MOTIF_SIZE_MAX, `${s} ausserhalb`);
    }
  });

  test('mehr Fundstellen → grösser (bei gleicher Konfidenz)', () => {
    const size = makeMotifSize([1, 5, 20]);
    assert.ok(size({ count: 20, score: 0.5 }) > size({ count: 1, score: 0.5 }));
  });

  test('höhere Konfidenz → grösser (bei gleicher Fundstellen-Zahl)', () => {
    const size = makeMotifSize([1, 20]);
    assert.ok(size({ count: 5, score: 0.95 }) > size({ count: 5, score: 0.2 }));
  });

  test('oft-aber-schwach bleibt unter seltener-aber-treffsicher', () => {
    // Der Grund für den Qualitäts-Anteil: der Ausschlag der Dichte allein soll
    // eine unsichere Massenerkennung nicht zum grössten Knoten machen.
    const size = makeMotifSize([2, 4, 30]);
    assert.ok(size({ count: 4, score: 1 }) > size({ count: 30, score: 0 }) - 5);
  });

  test('alle gleich häufig → mittlere Dichte statt Division durch null', () => {
    const size = makeMotifSize([5, 5, 5]);
    const s = size({ count: 5, score: 0 });
    assert.ok(Number.isFinite(s) && s > MOTIF_SIZE_MIN && s < MOTIF_SIZE_MAX);
  });

  test('leerer Datensatz (nur Geister) liefert endliche Grössen', () => {
    const size = makeMotifSize([]);
    assert.ok(Number.isFinite(size({ count: 0, score: 0 })));
  });

  test('Konfidenz ausserhalb 0..1 wird geklemmt', () => {
    const size = makeMotifSize([1, 10]);
    assert.strictEqual(size({ count: 10, score: 5 }), size({ count: 10, score: 1 }));
    assert.strictEqual(size({ count: 10, score: -3 }), size({ count: 10, score: 0 }));
  });
});
