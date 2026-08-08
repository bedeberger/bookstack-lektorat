'use strict';
// SEO-Sichtbarkeit der oeffentlichen Seiten.
//
// Testgegenstand ist eine Zusage, die man einer Seite nicht ansieht: geteilte
// Inhalte sind privat und duerfen NIE in einem Suchindex landen. Das ist keine
// Eigenschaft von share.html (dessen Meta-Tag deckt nur den HTML-Weg ab),
// sondern eine Eigenschaft JEDER Antwort unter /share — auch der Bild-Streams
// und JSON-Antworten, die kein <head> haben. Darum wird hier der Header am
// Router geprueft und nicht das Markup.
//
// Die Gegenprobe gehoert dazu: Landing und Datenschutz sollen indexierbar
// sein. Genau das war jahrelang nicht der Fall (geerbtes noindex aus der
// Share-Vorlage), und ein Test, der nur „share ist gesperrt" prueft, haette
// den stillen Totalausfall der Sichtbarkeit nicht bemerkt.
//
// Mini-Express + http wie in tests/unit/account-delete.test.js, kein Supertest.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `seo-robots-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;
delete process.env.DEMO_EMAIL;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appSettings = require('../../lib/app-settings');

const express = require('express');
const app = express();
app.use(require('../../routes/public'));
app.use('/share', require('../../routes/share'));

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
});

function _get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

function _setIndexable(value, publicUrl = 'https://app.example.test') {
  appSettings.set('seo.indexable', value, { updatedBy: 'test' });
  appSettings.set('app.public_url', publicUrl, { updatedBy: 'test' });
}

test('geteilte Inhalte tragen X-Robots-Tag: noindex — auf JEDER Antwort unter /share', async () => {
  _setIndexable(true);
  // Unbekannter Token → 404. Gerade dieser Weg ist wichtig: er liefert kein
  // share.html aus, das Meta-Tag greift hier also gar nicht.
  const res = await _get('/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
  assert.match(res.headers['x-robots-tag'] || '', /nofollow/);
});

test('/share bleibt auch bei indexierbarer Instanz gesperrt', async () => {
  _setIndexable(true);
  const res = await _get('/share/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.match(res.headers['x-robots-tag'] || '', /noindex/);
});

test('robots.txt sperrt /share NICHT — ein Disallow verdeckte den noindex-Header', async () => {
  // Kein Test der Formulierung, sondern der Wirkungskette: waere /share per
  // robots.txt verboten, koennte der Crawler den noindex-Header nie lesen und
  // ein von aussen verlinkter Token landete als reiner URL-Eintrag im Index.
  _setIndexable(true);
  const res = await _get('/robots.txt');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /Disallow:\s*\/share/i);
});

test('robots.txt nennt die Sitemap unter der konfigurierten Basis-URL', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/robots.txt');
  assert.match(res.body, /^Sitemap: https:\/\/app\.example\.test\/sitemap\.xml$/m);
});

test('Landing und Datenschutz sind indexierbar und nennen ihre kanonische URL', async () => {
  _setIndexable(true, 'https://app.example.test');
  for (const [urlPath, canonical] of [['/landing', '/'], ['/datenschutz', '/datenschutz']]) {
    const res = await _get(urlPath);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /noindex/, `${urlPath} darf kein noindex tragen`);
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://app\\.example\\.test${canonical === '/' ? '/' : canonical}">`));
  }
});

test('/privacy zeigt kanonisch auf /datenschutz — sonst konkurrieren zwei URLs mit gleichem Inhalt', async () => {
  _setIndexable(true, 'https://app.example.test');
  const res = await _get('/privacy');
  assert.match(res.body, /<link rel="canonical" href="https:\/\/app\.example\.test\/datenschutz">/);
});

test('seo.indexable=false nimmt die ganze Instanz aus dem Index', async () => {
  _setIndexable(false);
  const robots = await _get('/robots.txt');
  assert.match(robots.body, /^Disallow: \/$/m);

  const sitemap = await _get('/sitemap.xml');
  assert.equal(sitemap.status, 404);

  for (const urlPath of ['/landing', '/datenschutz']) {
    const res = await _get(urlPath);
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/, `${urlPath} braucht noindex`);
  }
});

test('ohne app.public_url bleibt die Instanz unindexiert — es gibt keine kanonische Adresse', async () => {
  _setIndexable(true, '');
  const robots = await _get('/robots.txt');
  assert.match(robots.body, /^Disallow: \/$/m);

  const landing = await _get('/landing');
  assert.match(landing.body, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(landing.body, /rel="canonical"/);
});
