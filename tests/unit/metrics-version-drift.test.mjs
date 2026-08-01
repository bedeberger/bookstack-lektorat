// Gate gegen den Drift, den docs/wortschatz.md ausdrücklich als Beispiel nennt:
// lib/page-index.js#METRICS_VERSION (Server) und die Kopie
// public/js/book/stil-heatmap.js#EXPECTED_METRICS_VERSION (Frontend) müssen
// gleichauf sein.
//
// Warum die Kopie überhaupt existiert: die Stil-Karte entscheidet damit, ob sie
// beim Öffnen einen Re-Sync auslöst. Läuft sie hinterher, sieht der Autor nach
// einem Backend-Bump dauerhaft alte Werte, ohne dass irgendwo ein Fehler
// erscheint — der Wert steht ja da, er ist nur veraltet.
//
// Wer eine Metrik ändert, bumpt beide Zahlen im selben Commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readConst(file, name) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `${name} nicht in ${file} gefunden`);
  return Number(m[1]);
}

test('EXPECTED_METRICS_VERSION im Frontend == METRICS_VERSION im Server', () => {
  const server = readConst('lib/page-index.js', 'METRICS_VERSION');
  const frontend = readConst('public/js/book/stil-heatmap.js', 'EXPECTED_METRICS_VERSION');
  assert.equal(frontend, server,
    `Drift: lib/page-index.js hat ${server}, public/js/book/stil-heatmap.js erwartet ${frontend}. `
    + 'Beide im selben Commit bumpen.');
});
