'use strict';
// Unit-Tests fuer lib/url-normalize.js — der Vergleichsmassstab der
// Dublettenpruefung (GET /sources/by-url, POST /capture).
// Lauf: `node --test tests/unit/`
//
// Zwei Fehlerrichtungen, beide hier festgenagelt:
//   zu aggressiv → zwei verschiedene Dokumente verschmelzen zu einer Quelle,
//                  die im Verzeichnis eine fremde Fundstelle behauptet
//   zu lasch     → dieselbe Seite liegt nach dem zweiten Klick doppelt drin

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrl, sameUrl } = require('../../lib/url-normalize');

test('gleiches Dokument: Schema, www, Port, Fragment, Trailing-Slash', () => {
  const canon = 'https://example.com/a/b?id=7';
  for (const variant of [
    'https://example.com/a/b?id=7',
    'http://example.com/a/b?id=7',
    'https://www.example.com/a/b?id=7',
    'https://example.com:443/a/b?id=7',
    'https://example.com/a/b?id=7#abschnitt-3',
    'https://example.com/a/b/?id=7',
    '  https://example.com/a/b?id=7  ',
  ]) {
    assert.equal(normalizeUrl(variant), canon, variant);
  }
});

test('Startseite behaelt ihren Root-Slash', () => {
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.ok(sameUrl('http://www.example.com', 'https://example.com/'));
});

test('Tracking-Parameter fallen weg, inhaltliche bleiben', () => {
  assert.equal(
    normalizeUrl('https://example.com/x?utm_source=news&utm_medium=mail&fbclid=abc&id=9'),
    'https://example.com/x?id=9',
  );
  assert.equal(normalizeUrl('https://example.com/x?utm_source=news'), 'https://example.com/x');
  // `ref` bleibt: manche Seiten liefern danach unterschiedliche Inhalte aus.
  assert.equal(normalizeUrl('https://example.com/x?ref=abc'), 'https://example.com/x?ref=abc');
});

test('Query-Reihenfolge ist bedeutungslos, Query-Inhalt nicht', () => {
  assert.ok(sameUrl('https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2'));
  assert.ok(!sameUrl('https://example.com/a?id=1', 'https://example.com/a?id=2'));
  assert.ok(!sameUrl('https://example.com/a', 'https://example.com/a?id=1'));
});

test('Pfad bleibt case-sensitiv, Host nicht', () => {
  assert.ok(!sameUrl('https://example.com/Path', 'https://example.com/path'));
  assert.ok(sameUrl('https://EXAMPLE.com/Path', 'https://example.com/Path'));
});

test('verschiedene Dokumente bleiben verschieden', () => {
  assert.ok(!sameUrl('https://example.com/a', 'https://example.com/b'));
  assert.ok(!sameUrl('https://example.com/a', 'https://example.org/a'));
  // Subdomain ist ein anderer Ort — nur `www.` gilt als Rauschen.
  assert.ok(!sameUrl('https://blog.example.com/a', 'https://example.com/a'));
  // Nicht-Standard-Port bleibt Teil der Adresse.
  assert.ok(!sameUrl('https://example.com:8443/a', 'https://example.com/a'));
});

test('Nicht-http(s) und Unparsbares sind null, nie gleich', () => {
  for (const bad of ['', '   ', null, undefined, 'kein text', 'ftp://example.com/x',
    'javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.ch', 'about:blank']) {
    assert.equal(normalizeUrl(bad), null, String(bad));
  }
  assert.equal(sameUrl(null, null), false);
  assert.equal(sameUrl('ftp://example.com/x', 'ftp://example.com/x'), false);
});
