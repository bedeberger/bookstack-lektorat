// Unit-Tests für den On-demand-Loader der Vendor-Libs (public/js/lazy-libs.js).
//
// Gegenstand ist eine real aufgetretene Fehlerklasse: `undefined is not a
// constructor (evaluating 'new vis.Network(…)')`. Ursache war eine Asymmetrie in
// jedem Loader — der Cache-Hit prüfte ein konkretes Symbol (`window.vis?.Network`),
// der Lade-Pfad danach gar nichts und reichte stumpf `window.vis` weiter. Feuert
// `onload` ohne dass das Global steht (abgeschnittene/teilweise ausgelieferte
// Antwort), resolvte die Promise mit `undefined` — und weil der Loader sie cacht,
// bekam JEDER weitere Aufruf denselben unbrauchbaren Wert bis zum Reload.
//
// Die Selbstheilung ist darum genauso Testgegenstand wie der Wurf: ein
// fehlgeschlagener Ladeversuch MUSS den Modul-Cache nullen, sonst ist ein
// transienter Netz-Blip ein dauerhaft kaputtes Feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Minimaler DOM-Stub statt linkedom: der Test muss `onload` selbst auslösen und
// dabei kontrollieren, ob das Global gesetzt wurde — genau das kann eine echte
// DOM-Implementierung nicht.
function freshEnv() {
  const scripts = [];
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({ src: '', async: false, onload: null, onerror: null }),
    querySelector: () => null,
    head: { appendChild: (el) => { scripts.push(el); } },
  };
  return scripts;
}

// Frischer Modul-Import pro Test — lazy-libs hält seinen Lade-Cache im
// Modul-Scope, den sonst der Vortest vorbelegt.
let _n = 0;
const freshModule = () => import(`../../public/js/lazy-libs.js?t=${++_n}`);

// ── Regelfall ───────────────────────────────────────────────────────────────

test('Script geladen und Global steht → Promise liefert das Global', async () => {
  const scripts = freshEnv();
  const { loadVis } = await freshModule();

  const p = loadVis();
  assert.equal(scripts.length, 1, 'genau ein Script-Tag');
  assert.match(scripts[0].src, /vis-network/);

  globalThis.window.vis = { Network: function () {} };
  scripts[0].onload();

  const vis = await p;
  assert.ok(vis.Network, 'Aufrufer bekommt das nutzbare Global');
});

test('Cache-Hit: steht das Global schon, wird kein zweites Script angehaengt', async () => {
  const scripts = freshEnv();
  const { loadVis } = await freshModule();
  globalThis.window.vis = { Network: function () {} };

  const vis = await loadVis();
  assert.ok(vis.Network);
  assert.equal(scripts.length, 0, 'kein Netz-Zugriff bei vorhandenem Global');
});

// ── Die Regression ──────────────────────────────────────────────────────────

test('onload ohne Global → Wurf statt undefined, und der naechste Versuch laedt neu', async () => {
  const scripts = freshEnv();
  const { loadVis } = await freshModule();

  const p1 = loadVis();
  scripts[0].onload();                     // "geladen", aber window.vis fehlt
  await assert.rejects(p1, /Global fehlt/, 'kein stilles undefined');

  // Kernpunkt: der Fehlversuch darf sich nicht im Cache festsetzen.
  const p2 = loadVis();
  assert.equal(scripts.length, 2, 'zweiter Versuch laedt wirklich erneut');
  globalThis.window.vis = { Network: function () {} };
  scripts[1].onload();
  assert.ok((await p2).Network, 'Feature heilt ohne Reload');
});

test('Teil-Global (vis ohne .Network) zaehlt nicht als geladen', async () => {
  const scripts = freshEnv();
  const { loadVis } = await freshModule();

  const p = loadVis();
  globalThis.window.vis = {};              // da, aber unbrauchbar
  scripts[0].onload();
  await assert.rejects(p, /Global fehlt/, 'pick() spiegelt den Cache-Hit exakt');
});

test('Netzfehler (onerror) nullt den Cache ebenfalls', async () => {
  const scripts = freshEnv();
  const { loadChart } = await freshModule();

  const p1 = loadChart();
  scripts[0].onerror();
  await assert.rejects(p1, /nicht geladen/);

  const p2 = loadChart();
  assert.equal(scripts.length, 2);
  globalThis.window.Chart = function () {};
  scripts[1].onload();
  assert.ok(await p2);
});

// ── Drift-Gate ──────────────────────────────────────────────────────────────

test('jeder Loader geht ueber _loadGlobal — kein blankes _loadScript daneben', async () => {
  const src = await readFile(new URL('../../public/js/lazy-libs.js', import.meta.url), 'utf8');

  // `_loadScript` darf nur noch an genau einer Stelle AUFGERUFEN werden: im
  // Helper. Ein Loader, der es direkt nimmt, hat wieder keinen Global-Check.
  // (Die Definition `function _loadScript(` zaehlt nicht mit.)
  const direct = [...src.matchAll(/(?<!function\s)_loadScript\(/g)].length;
  assert.equal(direct, 1, `_loadScript wird ${direct}x aufgerufen — erwartet: nur in _loadGlobal`);

  // Jeder exportierte Loader muss den Helper benutzen.
  const loaders = [...src.matchAll(/export function (load\w+)\s*\(/g)].map(m => m[1]);
  assert.ok(loaders.length >= 8, `erwartet mindestens 8 Loader, gefunden: ${loaders.length}`);

  const calls = [...src.matchAll(/(?<!function\s)_loadGlobal\(/g)].length;
  assert.equal(calls, loaders.length, `${loaders.length} Loader, aber ${calls} _loadGlobal-Aufrufe`);
});
