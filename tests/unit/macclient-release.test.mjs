// Store-Versions-Parser der nativen macOS-App (/me + Admin-Geraete-Tab).
// Deckt das reine _parseLookup ab (kein Netz) — Feld-Mapping der iTunes-Lookup-
// Antwort, Version-Normalisierung, graceful nicht-gefunden-Fall. Dazu die Form
// der Store-URL: sie ist der Installationsweg und darf nicht storefront-fest
// werden (siehe lib/macclient-release.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const macclient = require('../../lib/macclient-release.js');
const { _parseLookup, MAC_APP_STORE_URL, APP_STORE_APP_ID } = macclient;

test('_parseLookup: mappt die Lookup-Antwort auf die Release-Form', () => {
  const rel = _parseLookup({
    resultCount: 1,
    results: [{
      version: '1.4.0',
      releaseNotes: 'Notizen',
      currentVersionReleaseDate: '2026-06-01T10:00:00Z',
      fileSizeBytes: '12582912',
      trackName: 'Schreibwerkstatt Focuseditor',
    }],
  });
  assert.deepEqual(rel, {
    available: true,
    version: '1.4.0',
    notes: 'Notizen',
    publishedAt: '2026-06-01T10:00:00Z',
    sizeBytes: 12_582_912,
  });
});

test('_parseLookup: strippt fuehrendes v und toleriert fehlende Zusatzfelder', () => {
  const rel = _parseLookup({ results: [{ version: 'v2.0.1' }] });
  assert.equal(rel.available, true);
  assert.equal(rel.version, '2.0.1');
  assert.equal(rel.notes, '');
  assert.equal(rel.publishedAt, null);
  assert.equal(rel.sizeBytes, 0);
});

test('_parseLookup: App nicht gefunden / leere Antwort → { available:false }', () => {
  assert.deepEqual(_parseLookup({ resultCount: 0, results: [] }), { available: false });
  assert.deepEqual(_parseLookup(null), { available: false });
  assert.deepEqual(_parseLookup({}), { available: false });
});

test('_parseLookup: Treffer ohne Version → { available:false }', () => {
  // Ohne Version taugt der Treffer nicht als Vergleichsgroesse fuer „veraltet".
  assert.deepEqual(_parseLookup({ results: [{ trackName: 'X' }] }), { available: false });
});

test('MAC_APP_STORE_URL: storefront-neutral, mit App-ID und Mac-Media-Type', () => {
  assert.match(MAC_APP_STORE_URL, /^https:\/\/apps\.apple\.com\/app\/id\d+\?mt=12$/);
  assert.ok(MAC_APP_STORE_URL.includes(APP_STORE_APP_ID));
  // Ein Laendercode im Pfad (/ch/, /de/, …) zeigt allen uebrigen Besuchern den
  // falschen Shop — Apple leitet ohne ihn selbst auf die richtige Storefront.
  assert.doesNotMatch(MAC_APP_STORE_URL, /apps\.apple\.com\/[a-z]{2}\//);
});
