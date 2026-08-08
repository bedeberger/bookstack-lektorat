// Drift-Gate für das Vokabular des Struktur-Befunds.
//
// SSoT ist public/js/prompts/textsorten.js (STRUKTUR_STATUS / STRUKTUR_URTEILE /
// W_FRAGEN samt Rang-Maps). Daran hängen Schichten, die es NICHT importieren
// können oder nicht importieren sollen:
//
//   1. lib/struktur-summary.js — CJS-Spiegel. Das Modul ist bewusst pur (kein
//      DB-, kein Prompt-Import), damit die Zählerei ohne Stack testbar bleibt;
//      der Preis ist eine Kopie der Listen.
//   2. public/js/i18n/{de,en}.json — `struktur.status.<key>` /
//      `struktur.urteil.<key>`. Ein Wert ohne Label rendert als roher Key.
//   3. der CHECK-Constraint auf `page_structure_checks.gesamturteil`, falls es
//      einen gibt — ein neues Urteil, das die DB ablehnt, lässt den Job auf dem
//      letzten Beitrag scheitern.
//
// Ohne dieses Gate erscheint ein ergänzter Status im Schema, wird vom Modell
// geliefert, von der Verdichtung ignoriert und von der Karte ohne Label gezeigt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ts = await esm('public/js/prompts/textsorten.js');
const summary = require(path.join(ROOT, 'lib/struktur-summary.js'));

test('CJS-Spiegel in lib/struktur-summary.js deckt sich mit der SSoT', () => {
  assert.deepEqual(summary.URTEILE, ts.STRUKTUR_URTEILE);
  assert.deepEqual(summary.W_FRAGEN, ts.W_FRAGEN);
  assert.deepEqual(summary.STATUS_OFFEN, ts.STRUKTUR_STATUS_OFFEN);
  assert.deepEqual(summary.URTEIL_RANK, ts.STRUKTUR_URTEIL_RANG);
});

test('Rang-Maps decken jeden Wert ab und sind kollisionsfrei', () => {
  const raenge = Object.keys(ts.STRUKTUR_STATUS_RANG);
  assert.deepEqual(raenge.slice().sort(), ts.STRUKTUR_STATUS.slice().sort(),
    'STRUKTUR_STATUS_RANG kennt andere Status als STRUKTUR_STATUS');
  const werte = Object.values(ts.STRUKTUR_STATUS_RANG);
  assert.equal(new Set(werte).size, werte.length, 'zwei Status teilen sich einen Rang');

  const uRaenge = Object.keys(ts.STRUKTUR_URTEIL_RANG);
  assert.deepEqual(uRaenge.slice().sort(), ts.STRUKTUR_URTEILE.slice().sort(),
    'STRUKTUR_URTEIL_RANG kennt andere Urteile als STRUKTUR_URTEILE');
});

test('Fallback und Offen-Liste stehen im Status-Katalog', () => {
  assert.ok(ts.STRUKTUR_STATUS.includes(ts.STRUKTUR_STATUS_FALLBACK));
  // Der Fallback darf NICHT als Handlungsbedarf gelten: was das Modell nicht
  // geliefert hat, ist ungeprüft — dafür gibt es keine Massnahme.
  assert.ok(!ts.STRUKTUR_STATUS_OFFEN.includes(ts.STRUKTUR_STATUS_FALLBACK));
  for (const s of ts.STRUKTUR_STATUS_OFFEN) {
    assert.ok(ts.STRUKTUR_STATUS.includes(s), `${s} steht nicht im Status-Katalog`);
  }
});

test('jeder Wert hat ein Label in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const i18n = JSON.parse(
      fs.readFileSync(path.join(ROOT, `public/js/i18n/${loc}.json`), 'utf8'));
    for (const s of ts.STRUKTUR_STATUS) {
      assert.ok(i18n[`struktur.status.${s}`], `${loc}: struktur.status.${s} fehlt`);
    }
    for (const u of ts.STRUKTUR_URTEILE) {
      assert.ok(i18n[`struktur.urteil.${u}`], `${loc}: struktur.urteil.${u} fehlt`);
    }
  }
});

test('Signatur bewegt sich mit dem Vokabular', () => {
  // Sie geht in die Cache-Version des Struktur-Jobs ein (routes/jobs/struktur.js).
  // Enthielte sie die Listen nicht, bliebe nach einem neuen Status der alte
  // Befund neben jedem Beitrag stehen.
  for (const s of ts.STRUKTUR_STATUS) {
    assert.ok(ts.STRUKTUR_VOKABULAR_SIGNATUR.includes(s), `Signatur kennt ${s} nicht`);
  }
  for (const u of ts.STRUKTUR_URTEILE) {
    assert.ok(ts.STRUKTUR_VOKABULAR_SIGNATUR.includes(u), `Signatur kennt ${u} nicht`);
  }
});

test('der DB-CHECK auf gesamturteil kennt dieselben Urteile', () => {
  // Squashed-Schema statt Live-DB: der Test soll ohne Datenbank laufen.
  const sql = fs.readFileSync(path.join(ROOT, 'db/squashed-schema.js'), 'utf8');
  const tabelle = /CREATE TABLE[^;]*page_structure_checks[^;]*;/is.exec(sql)?.[0];
  assert.ok(tabelle, 'page_structure_checks fehlt im Squashed-Schema');
  const check = /gesamturteil[^,)]*CHECK\s*\(([^)]*)\)/is.exec(tabelle);
  if (!check) return; // kein CHECK auf der Spalte — dann gibt es nichts zu synchronisieren
  for (const u of ts.STRUKTUR_URTEILE) {
    assert.ok(check[1].includes(`'${u}'`), `CHECK-Constraint kennt «${u}» nicht`);
  }
});
