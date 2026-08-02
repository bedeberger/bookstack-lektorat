// Veraltet-Vergleich im Admin-Geräte-Tab deckt auch die Chrome-Erweiterung ab
// (eigener Versionsstrang, eigene Referenz in `latestVersions.extension`).
// Reine Modulfunktionen — Alpine wird nicht gebraucht (nur `devicesFmtTs`
// greift auf `Alpine.store` zu; die geprüften Methoden bleiben
// plattformgetrieben rein).
import test from 'node:test';
import assert from 'node:assert/strict';

import { adminDevicesMethods } from '../../public/js/admin/admin-devices.js';

// Baut einen Methoden-Bind mit gesetztem `devicesLatestVersions`.
function harness(latestVersions) {
  const ctx = Object.assign({}, adminDevicesMethods, { devicesLatestVersions: latestVersions });
  return ctx;
}

test('_devicesIsChrome: erkennt chrome/<version> und platform: chrome', () => {
  const h = harness({});
  assert.equal(h._devicesIsChrome({ client_version: 'chrome/1.0.0' }), true);
  assert.equal(h._devicesIsChrome({ platform: 'Chrome' }), true);
  assert.equal(h._devicesIsChrome({ client_version: '1.0.0', platform: 'mac' }), false);
});

test('_devicesLatestForPlatform: Chrome greift auf extension-Strang', () => {
  const h = harness({ macos: '2.9', android: '2.0.0', extension: '1.0.0' });
  assert.equal(h._devicesLatestForPlatform({ client_version: 'chrome/1.0.0' }), '1.0.0');
  assert.equal(h._devicesLatestForPlatform({ client_version: 'android/2.0.0' }), '2.0.0');
  assert.equal(h._devicesLatestForPlatform({ client_version: '2.9' }), '2.9');
  assert.equal(h._devicesLatestForPlatform({ client_version: 'chrome/0.9.0', platform: 'Chrome' }), '1.0.0');
});

test('devicesIsOutdated: chrome < extension.latest → veraltet', () => {
  const h = harness({ macos: '2.9', android: '2.0.0', extension: '1.0.0' });
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/0.9.0' }), true);
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/1.0.0' }), false);
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/1.1.0' }), false);
});

test('devicesIsOutdated: ohne chrome-Erkennung wird nicht fälschlich mac-Vergleich gezogen', () => {
  // Vor dem Fix fiel chrome auf den macOS-Strang zurück (web-app mainline vs.
  // extension-1.0.0) und blinkte immer „veraltet". Jetzt gibt extension den
  // Takt vor.
  const h = harness({ macos: '99.0.0', android: '2.0.0', extension: '1.0.0' });
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/1.0.0' }), false);
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/0.5.0' }), true);
});

test('devicesIsOutdated: fehlende Referenz für chrome → kein veraltet (statt falschem Blinken)', () => {
  const h = harness({ macos: '2.9', android: '2.0.0', extension: null });
  assert.equal(h.devicesIsOutdated({ client_version: 'chrome/0.5.0' }), false);
});

test('devicesVersionLabel: chrome/-Prefix wird für Anzeige abgezogen', () => {
  const h = harness({});
  assert.equal(h.devicesVersionLabel({ client_version: 'chrome/1.0.0' }), '1.0.0');
});