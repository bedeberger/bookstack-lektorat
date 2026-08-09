// Figuren-Graph: die reine Positionslogik der Kapitel-Swimlane.
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  computeSwimlaneLayout, figureInfo, columnWidth, importanceBorderWidth,
  TIER_ORDER, ROW_H, MIN_DX,
} from '../../public/js/graph/layout.js';

const fig = (id, typ, kapitel = [], name = id) => ({ id, name, typ, kapitel });
const kap = (name, haeufigkeit = 1) => ({ name, haeufigkeit });

describe('columnWidth', () => {
  test('klemmt nach unten (viele Kapitel → keine Riesen-Canvas)', () => {
    assert.strictEqual(columnWidth(900, 37), 160);
  });
  test('klemmt nach oben (wenige Kapitel → keine Endlos-Spalte)', () => {
    assert.strictEqual(columnWidth(4000, 1), 440);
  });
  test('rechnet dazwischen linear, mit Mindest-Divisor 4', () => {
    assert.strictEqual(columnWidth(800, 4), 200);
    assert.strictEqual(columnWidth(800, 2), 200); // Divisor bleibt 4
  });
});

describe('figureInfo (X-Achse = gewichteter Kapitel-Schwerpunkt)', () => {
  const order = ['K1', 'K2', 'K3'];

  test('eine Figur in genau einem Kapitel sitzt auf dessen Index', () => {
    const info = figureInfo([fig('a', 'hauptfigur', [kap('K3')])], order);
    assert.strictEqual(info.a.xIdx, 2);
    assert.strictEqual(info.a.firstCh, 2);
  });

  test('gleichgewichtige Kapitel → arithmetische Mitte', () => {
    const info = figureInfo([fig('a', 'hauptfigur', [kap('K1'), kap('K3')])], order);
    assert.strictEqual(info.a.xIdx, 1);
  });

  test('Häufigkeit zieht überlinear (nicht bloss linear gemittelt)', () => {
    const info = figureInfo([fig('a', 'hauptfigur', [kap('K1', 1), kap('K3', 3)])], order);
    // linear gewichtet wäre (0·1 + 2·3)/4 = 1.5; die ^1.5-Gewichtung zieht weiter nach rechts
    assert.ok(info.a.xIdx > 1.5, `xIdx war ${info.a.xIdx}`);
    assert.ok(info.a.xIdx < 2, 'aber nie über das stärkste Kapitel hinaus');
  });

  test('Figur ohne verortbares Kapitel landet in der Achsenmitte', () => {
    const info = figureInfo([fig('a', 'nebenfigur', [kap('Unbekannt')])], order);
    assert.strictEqual(info.a.xIdx, 1);
    assert.strictEqual(info.a.firstCh, Number.POSITIVE_INFINITY);
  });

  test('unbekannter Typ fällt auf "andere"', () => {
    const info = figureInfo([fig('a', 'phantasietyp', [kap('K1')])], order);
    assert.strictEqual(info.a.tier, 'andere');
  });

  test('importance = Summe der Häufigkeiten, auch über nicht gelistete Kapitel', () => {
    const info = figureInfo([fig('a', 'hauptfigur', [kap('K1', 2), kap('Weg', 5)])], order);
    assert.strictEqual(info.a.importance, 7);
  });
});

describe('computeSwimlaneLayout', () => {
  const order = ['K1', 'K2', 'K3', 'K4'];

  test('nur belegte Tiers werden gerendert, in fester Reihenfolge', () => {
    const figuren = [
      fig('n', 'nebenfigur', [kap('K1')]),
      fig('h', 'hauptfigur', [kap('K1')]),
    ];
    const { tiersUsed, tierY } = computeSwimlaneLayout(figuren, order, 900);
    assert.deepStrictEqual(tiersUsed, ['hauptfigur', 'nebenfigur']);
    assert.strictEqual(tierY.hauptfigur, 0);
    assert.ok(tierY.nebenfigur > 0);
    assert.strictEqual(tierY.antagonist, undefined);
  });

  test('TIER_ORDER deckt jeden gerenderten Tier-Schlüssel ab', () => {
    const figuren = TIER_ORDER.map((t, i) => fig('f' + i, t, [kap('K1')]));
    const { tiersUsed } = computeSwimlaneLayout(figuren, order, 900);
    assert.deepStrictEqual(tiersUsed, TIER_ORDER);
  });

  test('zu nahe Figuren desselben Tiers stapeln in die nächste Zeile', () => {
    const figuren = [
      fig('a', 'hauptfigur', [kap('K1')]),
      fig('b', 'hauptfigur', [kap('K1')]),
      fig('c', 'hauptfigur', [kap('K1')]),
    ];
    const { layoutPerTier, nodePositions } = computeSwimlaneLayout(figuren, order, 900);
    assert.strictEqual(layoutPerTier.hauptfigur.maxRows, 3);
    assert.deepStrictEqual(nodePositions.map(n => n.y), [0, ROW_H, 2 * ROW_H]);
  });

  test('weit auseinanderliegende Figuren bleiben in einer Zeile', () => {
    const figuren = [
      fig('a', 'hauptfigur', [kap('K1')]),
      fig('b', 'hauptfigur', [kap('K4')]),
    ];
    const { COL_W, layoutPerTier } = computeSwimlaneLayout(figuren, order, 900);
    assert.ok(3 * COL_W >= MIN_DX, 'Testannahme: die zwei liegen weiter als MIN_DX auseinander');
    assert.strictEqual(layoutPerTier.hauptfigur.maxRows, 1);
  });

  test('ein Stapel schiebt das nächste Tier nach unten (kein Überlappen)', () => {
    const stacked = [
      fig('a', 'hauptfigur', [kap('K1')]),
      fig('b', 'hauptfigur', [kap('K1')]),
      fig('c', 'hauptfigur', [kap('K1')]),
      fig('n', 'nebenfigur', [kap('K1')]),
    ];
    const flat = [
      fig('a', 'hauptfigur', [kap('K1')]),
      fig('n', 'nebenfigur', [kap('K1')]),
    ];
    const withStack = computeSwimlaneLayout(stacked, order, 900);
    const withoutStack = computeSwimlaneLayout(flat, order, 900);
    assert.ok(withStack.tierY.nebenfigur > withoutStack.tierY.nebenfigur);
    const lowestHaupt = Math.max(...withStack.layoutPerTier.hauptfigur.items.map(i => i.row)) * ROW_H;
    assert.ok(withStack.tierY.nebenfigur > lowestHaupt);
  });

  test('deterministisch: gleiche Eingabe → identische Positionen', () => {
    const figuren = [
      fig('b', 'hauptfigur', [kap('K2')]),
      fig('a', 'hauptfigur', [kap('K2')]),
      fig('c', 'antagonist', [kap('K3', 4)]),
    ];
    const a = computeSwimlaneLayout(figuren, order, 900);
    const b = computeSwimlaneLayout(figuren, order, 900);
    assert.deepStrictEqual(
      a.nodePositions.map(n => [n.f.id, n.x, n.y]),
      b.nodePositions.map(n => [n.f.id, n.x, n.y]),
    );
  });

  test('leere Figurenliste → leeres, aber wohlgeformtes Layout', () => {
    const out = computeSwimlaneLayout([], order, 900);
    assert.deepStrictEqual(out.tiersUsed, []);
    assert.deepStrictEqual(out.nodePositions, []);
    assert.strictEqual(out.lastTierY, 0);
  });
});

describe('importanceBorderWidth', () => {
  test('startet bei 1 und ist bei 4 gedeckelt', () => {
    assert.strictEqual(importanceBorderWidth(0), 1);
    assert.strictEqual(importanceBorderWidth(1), 1);
    assert.strictEqual(importanceBorderWidth(10000), 4);
  });
  test('wächst monoton', () => {
    const vals = [1, 4, 16, 64, 256].map(importanceBorderWidth);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1]);
  });
});
