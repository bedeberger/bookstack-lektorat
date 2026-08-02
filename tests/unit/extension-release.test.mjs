// Parser des latest-GitHub-Release fuer den Chrome-Erweiterungs-Download (/me).
// Deckt das reine _parseRelease ab (kein Netz) — Asset-Auswahl (.zip),
// Version-Normalisierung, graceful kein-.zip-Fall.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _parseRelease } = require('../../lib/extension-release.js');

test('_parseRelease: waehlt das .zip-Asset, strippt fuehrendes v', () => {
  const rel = _parseRelease({
    tag_name: 'v1.0.0',
    body: 'Erstes Sideload-Release bis zur Web-Store-Aufnahme',
    published_at: '2026-08-02T10:00:00Z',
    assets: [
      { name: 'checksums.txt', size: 10, browser_download_url: 'https://x/checksums.txt' },
      { name: 'schreibwerkstatt-browser-extension-1.0.0.zip', size: 245_760, browser_download_url: 'https://x/ext.zip' },
    ],
  });
  assert.equal(rel.available, true);
  assert.equal(rel.version, '1.0.0');
  assert.equal(rel.notes, 'Erstes Sideload-Release bis zur Web-Store-Aufnahme');
  assert.equal(rel.publishedAt, '2026-08-02T10:00:00Z');
  assert.deepEqual(rel.zip, { name: 'schreibwerkstatt-browser-extension-1.0.0.zip', sizeBytes: 245_760, downloadUrl: 'https://x/ext.zip' });
});

test('_parseRelease: kein .zip → { available:false }', () => {
  const rel = _parseRelease({ tag_name: 'v2.0', assets: [{ name: 'app.dmg', size: 1, browser_download_url: 'https://x/app.dmg' }] });
  assert.deepEqual(rel, { available: false });
});

test('_parseRelease: leeres/ungueltiges Release → { available:false }', () => {
  assert.deepEqual(_parseRelease(null), { available: false });
  assert.deepEqual(_parseRelease({}), { available: false });
});

test('_parseRelease: case-insensitive .ZIP-Endung', () => {
  const rel = _parseRelease({ tag_name: '0.3.0', assets: [{ name: 'Ext.ZIP', size: 5, browser_download_url: 'https://x/Ext.ZIP' }] });
  assert.equal(rel.available, true);
  assert.equal(rel.zip.name, 'Ext.ZIP');
});