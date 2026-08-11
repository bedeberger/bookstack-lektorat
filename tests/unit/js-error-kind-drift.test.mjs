// Client-Fehler-Telemetrie: die `kind`-Werte, die der Browser meldet, muessen im
// Server-Enum stehen.
//
// Warum das ein Gate braucht: POST /telemetry/js-error verwirft ein unbekanntes
// `kind` nicht — es faellt still auf 'error' zurueck (routes/telemetry.js). Eine
// neue Art im Client kaeme also an, waere aber in /admin/js-errors nicht mehr von
// den gewoehnlichen Laufzeitfehlern zu unterscheiden. Genau diese Unterscheidung
// ist der Zweck von 'resource' und 'boot': ein Boot-Ausfall flutet die Liste mit
// Folgefehlern ("X is not defined"), und nur die Ursachen-Arten heben sich davon ab.
//
// Die beiden Melder sind klassische IIFE-Scripts (kein ESM, laufen bewusst
// unabhaengig vom app.js-Graphen) — darum wird ihre Quelle gelesen statt importiert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const CLIENT_FILES = ['public/js/client-error.js', 'public/js/failsafe-reveal.js'];

// Das Enum aus routes/telemetry.js. Bewusst als Quelltext-Parse: die Konstante ist
// modulintern und soll nicht allein fuer den Test exportiert werden.
function serverKinds() {
  const src = read('routes/telemetry.js');
  const m = src.match(/JS_ERROR_KINDS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'JS_ERROR_KINDS in routes/telemetry.js nicht gefunden');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

// Alle `kind: '…'`-Literale der Melder.
function clientKinds() {
  const found = new Map();
  for (const file of CLIENT_FILES) {
    for (const m of read(file).matchAll(/\bkind:\s*'([^']+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

test('jede vom Client gemeldete Fehler-Art steht im Server-Enum', () => {
  const server = serverKinds();
  for (const [kind, file] of clientKinds()) {
    assert.ok(
      server.has(kind),
      `kind '${kind}' (${file}) fehlt in JS_ERROR_KINDS — der Server wuerde es still zu 'error' abwerten`
    );
  }
});

test('die Ursachen-Arten sind beide vorhanden', () => {
  const client = clientKinds();
  assert.ok(client.has('resource'), "client-error.js meldet keine 'resource'-Ladefehler mehr");
  assert.ok(client.has('boot'), "failsafe-reveal.js meldet keinen 'boot'-Ausfall mehr");
});

test('der Boot-Melder haengt nicht am ESM-Graphen', () => {
  // Der ganze Sinn der Meldung ist, dass sie laeuft, wenn app.js NICHT laeuft.
  // Ein import/export hier wuerde sie im Ausfall mit abschalten.
  for (const file of CLIENT_FILES) {
    const src = read(file);
    assert.ok(!/^\s*(import|export)\s/m.test(src), `${file} darf kein ESM-Modul werden`);
  }
});

test('client-error.js hoert im Capture — sonst erreichen ihn Ladefehler nie', () => {
  // Resource-Ladefehler bubbeln nicht; ohne Capture-Flag am window-Listener
  // saehe der Reporter genau die Ereignisse nicht, um die es hier geht.
  const src = read('public/js/client-error.js');
  const m = src.match(/addEventListener\('error',[\s\S]*?\n\s*\}, (true|false)\);/);
  assert.ok(m, 'error-Listener in client-error.js nicht gefunden');
  assert.equal(m[1], 'true', 'error-Listener muss im Capture registriert sein');
});

test('failsafe-reveal.js meldet ueber den gemeinsamen Reporter', () => {
  // Kein zweiter fetch-/Dedup-/Throttle-Pfad daneben.
  const src = read('public/js/failsafe-reveal.js');
  assert.match(src, /window\.__reportClientError/);
  assert.ok(!/fetch\(/.test(src), 'failsafe-reveal.js darf keinen eigenen fetch-Pfad aufmachen');
  assert.match(read('public/js/client-error.js'), /window\.__reportClientError\s*=\s*report/);
});

test('shell-incoherent wird auch ausserhalb des ESM-Graphen protokolliert', () => {
  // Der heilende Empfaenger sitzt in app/boot/sw-register.js und faellt im
  // Boot-Ausfall mit aus — dann bliebe das Signal des SW voellig unsichtbar.
  assert.match(read('public/js/failsafe-reveal.js'), /'shell-incoherent'/);
  assert.match(read('public/js/app/boot/sw-register.js'), /'shell-incoherent'/);
});
