// Changelog — Datei-Vertrag (changelog/README.md) + der Release-Gate.
//
// Der wichtigste Test hier ist `Zur aktuellen VERSION existiert ein Eintrag`:
// er haelt Versions-Bump und Release-Notizen im selben Commit zusammen. Ohne ihn
// waere „die Users koennen die Aenderungen nachlesen" eine Absicht statt einer
// Zusage — die erste Version ohne Eintrag faellt niemandem auf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'changelog');
const KINDS = new Set(['neu', 'verbessert', 'behoben']);

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const releases = files.map(f => ({
  file: f,
  data: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')),
}));

test('Changelog: mindestens ein Release liegt vor', () => {
  assert.ok(releases.length > 0, 'changelog/ enthaelt keine JSON-Datei');
});

test('Changelog: Dateiname == version, gueltiges Datum', () => {
  for (const { file, data } of releases) {
    const expected = path.basename(file, '.json');
    assert.match(data.version, /^\d+\.\d+\.\d+$/, `${file}: version ist kein Semver`);
    assert.equal(data.version, expected, `${file}: Dateiname und version weichen ab`);
    assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/, `${file}: date ist nicht YYYY-MM-DD`);
    assert.ok(!Number.isNaN(Date.parse(data.date)), `${file}: date ist kein gueltiges Datum`);
  }
});

test('Changelog: jeder Eintrag hat gueltiges kind und BEIDE Sprachen', () => {
  for (const { file, data } of releases) {
    assert.ok(Array.isArray(data.entries) && data.entries.length > 0,
      `${file}: entries fehlt oder ist leer`);
    for (const [i, e] of data.entries.entries()) {
      assert.ok(KINDS.has(e.kind),
        `${file} #${i}: kind '${e.kind}' — erlaubt: ${[...KINDS].join('/')}`);
      // i18n-Regel: Changelog ist User-Text, also nie nur eine Sprache.
      assert.ok(typeof e.de === 'string' && e.de.trim(), `${file} #${i}: de fehlt`);
      assert.ok(typeof e.en === 'string' && e.en.trim(), `${file} #${i}: en fehlt`);
    }
  }
});

test('Changelog: keine doppelte Version', () => {
  const seen = new Set();
  for (const { file, data } of releases) {
    assert.ok(!seen.has(data.version), `${file}: Version ${data.version} doppelt`);
    seen.add(data.version);
  }
});

test('Changelog: zur aktuellen VERSION existiert ein Eintrag', () => {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const hit = releases.find(r => r.data.version === version);
  assert.ok(hit, `changelog/${version}.json fehlt — jeder Versions-Bump bringt seine `
    + 'Release-Notizen im selben Commit mit (siehe .claude/commands/release.md).');
});

test('Changelog: i18n-Keys der Eintrags-Arten existieren in beiden Locales', async () => {
  for (const loc of ['de', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'js', 'i18n', `${loc}.json`), 'utf8'));
    for (const kind of KINDS) {
      assert.ok(dict[`changelog.kind.${kind}`], `${loc}.json: changelog.kind.${kind} fehlt`);
    }
  }
});

test('lib/changelog: sortiert absteigend nach Version und liefert die Kopf-Version', async () => {
  const { getChangelog, getLatestVersion } = await import('../../lib/changelog.js');
  const list = getChangelog();
  assert.equal(list.length, releases.length);
  const nums = list.map(r => r.version.split('.').map(Number));
  for (let i = 1; i < nums.length; i++) {
    const cmp = nums[i - 1][0] - nums[i][0] || nums[i - 1][1] - nums[i][1] || nums[i - 1][2] - nums[i][2];
    assert.ok(cmp > 0, `Reihenfolge falsch bei ${list[i - 1].version} vor ${list[i].version}`);
  }
  assert.equal(getLatestVersion(), list[0].version);
});
