// Graph-Kit: die reinen Teile des geteilten vis-network-Unterbaus
// (Tooltip-Geometrie + Farb-Arithmetik der Dark-Mode-Nachführung).
import { test, describe } from 'node:test';
import assert from 'node:assert';

import { clampTipPos } from '../../public/js/graph-kit/tooltip.js';
import {
  parseColor, mix, rgba, toCss, luminance, readable, adaptNodeColor,
} from '../../public/js/graph-kit/theme.js';

describe('clampTipPos', () => {
  test('genug Platz → rechts unter dem Cursor mit Offset', () => {
    const p = clampTipPos({ cx: 100, cy: 100, tipW: 200, tipH: 80, boxW: 800, boxH: 600 });
    assert.deepStrictEqual(p, { left: 114, top: 114 });
  });

  test('rechter Rand → klappt auf die linke Cursor-Seite', () => {
    const p = clampTipPos({ cx: 700, cy: 100, tipW: 200, tipH: 80, boxW: 800, boxH: 600 });
    assert.strictEqual(p.left, 700 - 200 - 14);
    assert.strictEqual(p.top, 114);
  });

  test('unterer Rand → klappt über den Cursor', () => {
    const p = clampTipPos({ cx: 100, cy: 560, tipW: 200, tipH: 80, boxW: 800, boxH: 600 });
    assert.strictEqual(p.top, 560 - 80 - 14);
  });

  test('Ecke unten rechts → beide Achsen klappen', () => {
    const p = clampTipPos({ cx: 780, cy: 580, tipW: 200, tipH: 80, boxW: 800, boxH: 600 });
    assert.strictEqual(p.left, 780 - 214);
    assert.strictEqual(p.top, 580 - 94);
  });

  test('Tooltip grösser als der Container → nie negative Position', () => {
    const p = clampTipPos({ cx: 10, cy: 10, tipW: 400, tipH: 400, boxW: 300, boxH: 200 });
    assert.strictEqual(p.left, 0);
    assert.strictEqual(p.top, 0);
  });
});

describe('Farb-Arithmetik', () => {
  test('parseColor: hex kurz/lang und rgb/rgba', () => {
    assert.deepStrictEqual(parseColor('#fff'), [255, 255, 255]);
    assert.deepStrictEqual(parseColor('#2d6a9f'), [45, 106, 159]);
    assert.deepStrictEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
    assert.deepStrictEqual(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
    assert.strictEqual(parseColor('nonsense'), null);
    assert.strictEqual(parseColor(undefined), null);
  });

  test('mix klemmt und rundet', () => {
    assert.deepStrictEqual(mix([0, 0, 0], [255, 255, 255], 0.5), [128, 128, 128]);
    assert.deepStrictEqual(mix([0, 0, 0], [255, 255, 255], 2), [255, 255, 255]);
    assert.deepStrictEqual(mix([0, 0, 0], [255, 255, 255], -1), [0, 0, 0]);
  });

  test('rgba/toCss liefern canvas-taugliche Strings', () => {
    assert.strictEqual(rgba([1, 2, 3], 0.5), 'rgba(1,2,3,0.5)');
    assert.strictEqual(toCss([1, 2, 3]), 'rgb(1,2,3)');
  });

  test('luminance ordnet dunkel < hell', () => {
    assert.ok(luminance([0, 0, 0]) < luminance([128, 128, 128]));
    assert.ok(luminance([128, 128, 128]) < luminance([255, 255, 255]));
  });
});

describe('readable (Akzentfarbe auf dunklem Grund)', () => {
  test('Light-Mode lässt die Palette unangetastet', () => {
    assert.strictEqual(readable('#2d6a9f', false), '#2d6a9f');
    assert.strictEqual(readable('#333', false), '#333');
  });

  test('Dark-Mode hellt dunkle Farben auf', () => {
    const out = readable('#2d6a9f', true);
    assert.notStrictEqual(out, '#2d6a9f');
    assert.ok(luminance(parseColor(out)) > luminance(parseColor('#2d6a9f')));
  });

  test('Dark-Mode lässt bereits helle Farben stehen', () => {
    assert.strictEqual(readable('#FFF3CC', true), '#FFF3CC');
  });

  test('unparsbare Eingabe bleibt unverändert (kein Absturz im Draw-Pfad)', () => {
    assert.strictEqual(readable('currentColor', true), 'currentColor');
  });
});

describe('adaptNodeColor', () => {
  const light = { dark: false, surfaceRgb: [255, 255, 255] };
  const dark = { dark: true, surfaceRgb: [31, 32, 35] };
  const spec = {
    background: '#D4E8FF', border: '#2d6a9f',
    highlight: { background: '#BDD8FF', border: '#1d4b73' },
    // Die Schicht-Palette führt daneben Band-/Label-/Font-Werte — die dürfen nicht
    // ins vis-color-Objekt durchrutschen.
    band: 'rgba(212,232,255,0.35)', label: '#1d4b73', font: { color: '#fff' },
  };

  test('Light-Mode normalisiert auf die drei vis-Schlüssel', () => {
    assert.deepStrictEqual(Object.keys(adaptNodeColor(spec, light)).sort(),
      ['background', 'border', 'highlight']);
    assert.strictEqual(adaptNodeColor(spec, light).background, '#D4E8FF');
  });

  test('Dark-Mode dunkelt die Fläche Richtung Oberfläche ab', () => {
    const out = adaptNodeColor(spec, dark);
    assert.ok(luminance(parseColor(out.background)) < luminance(parseColor(spec.background)));
    // ... bleibt aber getönt, nicht identisch mit der Oberfläche
    assert.notDeepStrictEqual(parseColor(out.background), dark.surfaceRgb);
    // Highlight bleibt heller als der Ruhezustand (Selektion muss sichtbar sein).
    assert.ok(luminance(parseColor(out.highlight.background)) > luminance(parseColor(out.background)));
  });

  test('Dark-Mode hält die Border als Erkennungsanker lesbar', () => {
    const out = adaptNodeColor(spec, dark);
    assert.ok(luminance(parseColor(out.border)) > luminance(parseColor(spec.border)));
  });
});
