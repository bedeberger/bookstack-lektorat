'use strict';
// Tests für public/sw.js – Cache-Konstanten + Snapshot-Guard.
//
// CLAUDE.md / memory: Bei JS/CSS-Änderungen muss SHELL_CACHE in sw.js
// hochgezählt werden, sonst hängt der Mobile-Cache auf alten Assets fest.
//
// Strategie: Snapshot-Datei `tests/fixtures/sw-cache-snapshot.json` hält
// die zuletzt absichtlich freigegebene SHELL_CACHE-Version. Wenn jemand
// die Konstante ändert ohne die Snapshot zu aktualisieren, schlägt der
// Test fehl – der Bumper muss explizit bestätigen, dass er die Bedeutung
// kennt (alter Cache wird in `activate` geräumt). Das ist ein Manuell-
// Acknowledge-Guard, kein Auto-Bump – die Frage „muss ich bumpen?" bleibt
// beim Entwickler. Der Test verhindert nur, dass die Konstante still
// (oder still rückwärts) verschoben wird.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const swPath = path.resolve(__dirname, '..', '..', 'public', 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');

const snapshotPath = path.resolve(__dirname, '..', 'fixtures', 'sw-cache-snapshot.json');

function extractConst(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`);
  const m = sw.match(re);
  return m ? m[1] : null;
}

test('sw.js: SHELL_CACHE-Konstante existiert und folgt lektorat-shell-vN-Pattern', () => {
  const v = extractConst('SHELL_CACHE');
  assert.ok(v, 'SHELL_CACHE-Konstante fehlt');
  assert.match(v, /^lektorat-shell-v\d+$/,
    `SHELL_CACHE muss "lektorat-shell-vN" sein, ist "${v}"`);
});

test('sw.js: API_CACHE und CONFIG_CACHE existieren', () => {
  assert.ok(extractConst('API_CACHE'), 'API_CACHE fehlt');
  assert.ok(extractConst('CONFIG_CACHE'), 'CONFIG_CACHE fehlt');
});

test('sw.js: ACTIVE_CACHES enthält alle drei Cache-Konstanten', () => {
  // ACTIVE_CACHES wird im activate-Handler benutzt um veraltete Caches zu
  // löschen. Fehlt eine Konstante hier, wird der zugehörige Cache nie
  // bereinigt → unbegrenztes Wachstum.
  assert.match(sw, /ACTIVE_CACHES\s*=\s*new Set\(\s*\[\s*SHELL_CACHE\s*,\s*API_CACHE\s*,\s*CONFIG_CACHE/,
    'ACTIVE_CACHES muss alle drei Cache-Konstanten enthalten');
});

test('sw.js: activate-Handler räumt Caches die nicht in ACTIVE_CACHES sind', () => {
  // Regression-Schutz: ohne diese Zeile akkumulieren alte vN-Caches im Browser
  // bis der Storage-Quota platzt.
  assert.match(sw, /caches\.keys\(\)/);
  assert.match(sw, /!ACTIVE_CACHES\.has/);
  assert.match(sw, /caches\.delete/);
});

test('sw.js: SHELL_CACHE-Snapshot stimmt überein (manueller Bump-Acknowledge)', () => {
  const current = extractConst('SHELL_CACHE');
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (e) {
    assert.fail(
      `Snapshot ${snapshotPath} fehlt. Erstelle initial mit:\n` +
      `  echo '{"shellCache":"${current}"}' > ${snapshotPath}\n` +
      `Original-Fehler: ${e.message}`,
    );
  }
  assert.equal(
    current,
    snapshot.shellCache,
    `SHELL_CACHE wurde von "${snapshot.shellCache}" auf "${current}" geändert.\n` +
    `Wenn das Absicht ist (alter Mobile-Cache soll geräumt werden), update den Snapshot:\n` +
    `  ${snapshotPath}\n` +
    `Wenn nicht, stelle die alte Konstante wieder her in public/sw.js.`,
  );
});

test('sw.js: NEVER_CACHE_PREFIXES enthält Auth- und KI-Pfade (Sicherheit)', () => {
  // Diese Pfade dürfen NIE im Cache landen, sonst:
  //  - /auth/*: Login-Redirects frieren ein
  //  - /claude, /ollama, /llama: KI-Antworten würden gecacht
  //  - /jobs: Status-Polls würden stale-Daten liefern
  for (const prefix of ['/auth/', '/claude', '/ollama', '/llama', '/jobs', '/chat']) {
    assert.ok(
      sw.includes(`'${prefix}'`),
      `NEVER_CACHE_PREFIXES muss '${prefix}' enthalten, sonst Sicherheits-/Konsistenz-Bug`,
    );
  }
});
