// Gate fuer die Sitzungswechsel-Erkennung beim Start.
//
// WARUM ALS UNIT-TEST: Der Service Worker ist auf localhost aus
// (public/js/app/boot/sw-register.js). Ein Stale-Hit nach dem Anmelden faellt
// darum weder lokal noch im Smoke auf — er zeigt sich auf HTTPS als Aussage,
// die niemand als Cache-Problem liest ("mein Tagebuch hat nicht alle Tage"),
// haelt ueber jeden normalen Reload und heilt nur zufaellig: per Hard-Refresh
// (umgeht den SW) oder Minuten spaeter durch den Wake-Refresh, sobald der Tab
// lange genug im Hintergrund war.
//
// DIE INVARIANTE: Eine neue Anmeldung ist ein EREIGNIS, kein Kaltstart. Der
// Cache im Browser kann einer beliebig alten oder fremden Sitzung gehoeren, und
// der Griff, der ihn leert, haengt an einem Klick auf den Logout-Link in der
// App — eine abgelaufene Session, ein geschlossener Browser oder ein Login von
// der Login-Seite kommen dort nie vorbei.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  SESSION_FP_COOKIE, readCookie, decideSessionChange, planSessionCacheAction,
} from '../../public/js/app/boot/session-change.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const server = require('../../lib/session-fingerprint.js');

test('Cookie-Name: Client-Kopie und Server-SSoT sind deckungsgleich', () => {
  // Bewusste Kopie (Server CJS, Bundle ESM). Driftet der Name, sucht der Client
  // stumm ein Cookie, das es nicht gibt: `changed` ist dann immer false und die
  // Erkennung ist wirkungslos, ohne dass irgendwo ein Fehler auftaucht.
  assert.equal(SESSION_FP_COOKIE, server.SESSION_FP_COOKIE);
});

test('Fingerprint trennt zwei Sitzungen DESSELBEN Users', () => {
  // Genau das ist der Fall, den eine E-Mail-Vergleich nicht sieht — und der
  // gemeldete: derselbe User meldet sich neu an, der Cache ist von vorher.
  const a = server.sessionFingerprint('a@b.c', 1700000000000);
  const b = server.sessionFingerprint('a@b.c', 1700000000001);
  assert.ok(a && b);
  assert.notEqual(a, b);
  // Und zwei User trennt er auch.
  assert.notEqual(a, server.sessionFingerprint('x@b.c', 1700000000000));
  // Stabil fuer dieselbe Sitzung, sonst waere jeder Request ein "Wechsel".
  assert.equal(a, server.sessionFingerprint('a@b.c', 1700000000000));
});

test('Fingerprint traegt keinen Klartext', () => {
  // Der Wert liegt fuer JS offen (das ist sein Zweck) und soll darum nichts
  // aussagen, was nicht schon im Browser steht.
  const fp = server.sessionFingerprint('geheim@example.com', 1700000000000);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.ok(!fp.includes('geheim'));
});

test('Ohne Session kein Fingerprint und kein Cookie', () => {
  assert.equal(server.sessionFingerprint(null, 1), null);
  assert.equal(server.sessionFingerprint('a@b.c', null), null);
  const res = { cookie: () => assert.fail('Set-Cookie ohne Session') };
  assert.equal(server.setSessionFingerprintCookie({ session: {}, headers: {} }, res), null);
});

test('Cookie wird gesetzt, wenn es fehlt — und nicht, wenn es passt', () => {
  const req = { session: { user: { email: 'a@b.c' }, loginAt: 1700000000000 }, headers: {} };
  const fp = server.sessionFingerprint('a@b.c', 1700000000000);

  const calls = [];
  server.setSessionFingerprintCookie(req, { cookie: (...a) => calls.push(a) });
  assert.equal(calls.length, 1);
  const [name, value, opts] = calls[0];
  assert.equal(name, server.SESSION_FP_COOKIE);
  assert.equal(value, fp);
  // httpOnly:false ist der ganze Punkt — die SPA MUSS den Wert lesen koennen.
  assert.equal(opts.httpOnly, false);
  assert.equal(opts.path, '/');

  // Gleicher Wert schon im Request → kein weiteres Set-Cookie an jeder Antwort.
  const same = { ...req, headers: { cookie: `${server.SESSION_FP_COOKIE}=${fp}; other=1` } };
  server.setSessionFingerprintCookie(same, { cookie: () => assert.fail('unnoetiges Set-Cookie') });

  // Fremder Wert → neu setzen.
  const stale = { ...req, headers: { cookie: `${server.SESSION_FP_COOKIE}=deadbeefdeadbeef` } };
  const again = [];
  server.setSessionFingerprintCookie(stale, { cookie: (...a) => again.push(a) });
  assert.equal(again.length, 1);
});

test('readCookie liest exakt den eigenen Namen', () => {
  assert.equal(readCookie('sw_sess', 'a=1; sw_sess=abc; b=2'), 'abc');
  assert.equal(readCookie('sw_sess', 'sw_sess=abc'), 'abc');
  // Kein Teiltreffer auf einem laengeren Namen — sonst liest die Erkennung
  // einen fremden Wert und meldet jeden Start als Wechsel.
  assert.equal(readCookie('sw_sess', 'xsw_sess=abc'), null);
  assert.equal(readCookie('sw_sess', ''), null);
  assert.equal(readCookie('sw_sess', undefined), null);
});

test('Entscheidung: nur ein ABWEICHENDES Cookie ist ein Wechsel', () => {
  // Kein Cookie → kein Signal (Cookies geblockt, Session aelter als das
  // Feature). Dann NICHT wegwerfen, sonst verliert die Offline-Kopie bei jedem
  // Start ihren Sinn.
  assert.equal(decideSessionChange(null, 'abc'), false);
  assert.equal(decideSessionChange('', 'abc'), false);
  // Gleiche Sitzung → Kaltstart, Cache bleibt (das Offline-Versprechen).
  assert.equal(decideSessionChange('abc', 'abc'), false);
  // Andere Sitzung → Wechsel.
  assert.equal(decideSessionChange('xyz', 'abc'), true);
  // Nichts gemerkt, aber Cookie da → als Wechsel behandeln: zu welcher Sitzung
  // der vorhandene Cache gehoert, ist unbekannt, und die Kosten sind nicht
  // vergleichbar (ein Refetch gegen fehlende Tage im Tagebuch). Auf einem
  // wirklich ersten Besuch ist der Cache leer und der Drop ein No-op.
  assert.equal(decideSessionChange('abc', null), true);
});

test('Offline wird kein Cache weggeworfen', () => {
  // Ein Cache, den wir nicht neu fuellen koennen, ist offline das Einzige, was
  // ueberhaupt funktioniert — und ein frischer Read scheitert dort ohnehin.
  assert.equal(planSessionCacheAction({ changed: true, online: false }), 'skip');
  assert.equal(planSessionCacheAction({ changed: true, online: true }), 'drop');
  assert.equal(planSessionCacheAction({ changed: false, online: true }), 'remember');
  // Auch offline: gleiche Sitzung → Fingerprint darf gemerkt bleiben.
  assert.equal(planSessionCacheAction({ changed: false, online: false }), 'remember');
});

test('Der Boot behandelt den Wechsel VOR dem ersten gecachten Read', () => {
  // Reihenfolge ist die halbe Korrektur: nach dem /config-Fetch geleert, hat
  // die Antwort den alten Cache-Stand schon geliefert.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app/app-init.js'), 'utf8');
  const detect = src.indexOf('reconcileSessionCaches()');
  const config = src.indexOf("fetchJson('/config')");
  const books = src.indexOf('this.loadBooks(');
  assert.ok(detect > 0, 'app-init.js prueft den Sitzungswechsel nicht.');
  assert.ok(config > 0 && books > 0);
  assert.ok(detect < config, 'Sitzungs-Check laeuft nach dem /config-Read → zu spaet.');
  assert.ok(detect < books, 'Sitzungs-Check laeuft nach dem Buch-Read → zu spaet.');
  // Rueckfall muss verdrahtet sein: ohne erreichbaren SW bleibt nur der
  // frische Read.
  assert.match(src, /loadBooks\(bootstrapOpts\)/,
    'Bootstrap-Read ignoriert den Rueckfall → ohne SW bleibt der Stale-Render.');
  // Der Rueckfall selbst liegt in boot/session-change.js — hier nur, dass der
  // Boot ihn ueberhaupt an den Read weitergibt.
  const sc = fs.readFileSync(path.join(ROOT, 'public/js/app/boot/session-change.js'), 'utf8');
  assert.match(sc, /source: 'login'/,
    "Rueckfall ohne source:'login' liest wieder aus dem Cache.");
});

test('Der Service Worker kennt den Sitzungswechsel als Anlass', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /SESSION_CACHE_DROP_TYPES/,
    'Kein gemeinsamer Griff fuer Logout + Sitzungswechsel.');
  assert.match(sw, /'auth-logout', 'session-changed'/,
    'session-changed fehlt → der Client postet ins Leere und faellt auf den frischen Read zurueck.');
  // Beide Sitzungs-Caches muessen fallen: der Baum liegt im CONTENT_CACHE, die
  // Identitaet des Users im CONFIG_CACHE.
  const handler = sw.slice(sw.indexOf('SESSION_CACHE_DROP_TYPES.has'));
  assert.match(handler, /caches\.delete\(CONTENT_CACHE\)/);
  assert.match(handler, /caches\.delete\(CONFIG_CACHE\)/);
});

test('Token-Sessions bekommen kein Fingerprint-Cookie', () => {
  // Device-/API-Token (`via` gesetzt) gehoeren keinem Browser-Cache, und ihr
  // `loginAt` entsteht pro Request neu — ohne diesen Vorbehalt haengte an jeder
  // Antwort der nativen Clients ein Set-Cookie mit neuem Wert.
  for (const via of ['device_token', 'api_token']) {
    const req = { session: { user: { email: 'a@b.c', via }, loginAt: 1700000000000 }, headers: {} };
    const res = { cookie: () => assert.fail(`Set-Cookie fuer via=${via}`) };
    assert.equal(server.setSessionFingerprintCookie(req, res), null);
  }
});
