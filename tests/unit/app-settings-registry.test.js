'use strict';
// Gate der Settings-Registry (lib/app-settings/registry.js).
//
// Die Registry haelt Default, Wertebereich, Verschluesselung und ENV-Bootstrap
// eines Keys an EINER Stelle; DEFAULTS/VALIDATORS/ENCRYPTED_KEYS/ENV_MAP sind
// daraus abgeleitet. Dieser Test haelt die Eigenschaften fest, die vorher
// zwischen vier parallelen Listen driften konnten — allen voran das
// `secret`-Flag: sein Vergessen schreibt ein Token im Klartext in die DB.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../../lib/app-settings/registry');
const { SETTINGS, DEFAULTS, VALIDATORS, ENCRYPTED_KEYS, ENV_MAP } = registry;

// Erlaubte Eigenschaften eines Deskriptors. Ein Tippfehler (`secrets: true`)
// waere sonst genau der stille Ausfall, den die Registry verhindern soll.
const ALLOWED_PROPS = new Set(['default', 'validate', 'secret', 'env']);
const VALIDATE_PROPS = new Set(['type', 'min', 'max', 'oneOf']);
const VALIDATE_TYPES = new Set(['int', 'number', 'enum', 'bool']);

// Namensmuster, die auf ein Geheimnis hindeuten. Ein Treffer MUSS `secret: true`
// tragen — das ist die eine Regel, die sich nicht aus der Struktur ergibt und
// deren Verletzung teuer ist.
const SECRET_NAME_RE = /(api_key|_secret|_password|github_token)$/;

test('Deskriptoren kennen nur erlaubte Eigenschaften', () => {
  const bad = [];
  for (const [key, d] of Object.entries(SETTINGS)) {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      bad.push(`${key}: Deskriptor muss ein Objekt sein (got ${JSON.stringify(d)})`);
      continue;
    }
    for (const prop of Object.keys(d)) {
      if (!ALLOWED_PROPS.has(prop)) {
        bad.push(`${key}: unbekannte Eigenschaft '${prop}' (erlaubt: ${[...ALLOWED_PROPS].join(', ')})`);
      }
    }
    // Ein Eintrag ohne jede Eigenschaft ist ein Versehen.
    if (!Object.keys(d).length) bad.push(`${key}: leerer Deskriptor`);
  }
  assert.deepEqual(bad, [], 'Deskriptor-Verstoesse:\n  ' + bad.join('\n  '));
});

test('validate-Spec ist wohlgeformt und passt zum Default-Typ', () => {
  const bad = [];
  for (const [key, d] of Object.entries(SETTINGS)) {
    const v = d.validate;
    if (!v) continue;
    for (const prop of Object.keys(v)) {
      if (!VALIDATE_PROPS.has(prop)) bad.push(`${key}: validate.${prop} unbekannt`);
    }
    if (!VALIDATE_TYPES.has(v.type)) bad.push(`${key}: validate.type '${v.type}' unbekannt`);
    if (v.type === 'enum' && !Array.isArray(v.oneOf)) bad.push(`${key}: enum ohne oneOf`);
    if (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max) {
      bad.push(`${key}: min ${v.min} > max ${v.max}`);
    }
    // Der eigene Default muss durch den eigenen Validator kommen — sonst
    // scheitert der erste Admin-Save, der den Wert unveraendert zuruecksendet.
    if (Object.prototype.hasOwnProperty.call(d, 'default')) {
      assert.doesNotThrow(
        () => registry.validateValue(key, d.default),
        `${key}: eigener Default ${JSON.stringify(d.default)} verletzt die eigene validate-Spec`,
      );
    }
  }
  assert.deepEqual(bad, [], 'validate-Verstoesse:\n  ' + bad.join('\n  '));
});

test('Keys mit Geheimnis-Namen tragen secret: true', () => {
  const missing = Object.keys(SETTINGS).filter(k => SECRET_NAME_RE.test(k) && !SETTINGS[k].secret);
  assert.deepEqual(missing, [],
    'Diese Keys sehen nach Zugangsdaten aus, werden aber im Klartext persistiert: ' + missing.join(', '));
});

test('secret-Keys haben keinen nicht-leeren Default', () => {
  // Ein vorbelegtes Geheimnis waere ein ausgeliefertes Geheimnis.
  const bad = Object.entries(SETTINGS)
    .filter(([, d]) => d.secret && d.default !== undefined && d.default !== '')
    .map(([k, d]) => `${k} = ${JSON.stringify(d.default)}`);
  assert.deepEqual(bad, [], 'secret-Key mit vorbelegtem Wert: ' + bad.join(', '));
});

test('env-Spec ist wohlgeformt', () => {
  const bad = [];
  const seen = new Map();
  for (const [key, d] of Object.entries(SETTINGS)) {
    if (!d.env) continue;
    if (!Array.isArray(d.env)) { bad.push(`${key}: env muss eine Liste von [ENV_VAR, transform] sein`); continue; }
    for (const pair of d.env) {
      if (!Array.isArray(pair) || pair.length !== 2) { bad.push(`${key}: env-Eintrag muss [ENV_VAR, transform] sein`); continue; }
      const [envVar, transform] = pair;
      if (typeof envVar !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(envVar)) bad.push(`${key}: '${envVar}' ist kein ENV-Name`);
      if (typeof transform !== 'function') bad.push(`${key}: ${envVar} ohne transform-Funktion`);
      // Dieselbe ENV-Variable auf zwei Keys waere eine stille Doppelbelegung.
      if (seen.has(envVar)) bad.push(`${envVar}: zeigt auf ${seen.get(envVar)} UND ${key}`);
      else seen.set(envVar, key);
    }
  }
  assert.deepEqual(bad, [], 'env-Verstoesse:\n  ' + bad.join('\n  '));
});

test('abgeleitete Sichten deckungsgleich zur Registry', () => {
  // DEFAULTS enthaelt genau die Eintraege MIT default — `DEFAULTS[key] !== undefined`
  // und `Object.keys(DEFAULTS)` sind darauf angewiesen.
  assert.deepEqual(
    Object.keys(DEFAULTS).sort(),
    Object.keys(SETTINGS).filter(k => Object.prototype.hasOwnProperty.call(SETTINGS[k], 'default')).sort(),
  );
  assert.deepEqual(
    Object.keys(VALIDATORS).sort(),
    Object.keys(SETTINGS).filter(k => SETTINGS[k].validate).sort(),
  );
  assert.deepEqual(
    [...ENCRYPTED_KEYS].sort(),
    Object.keys(SETTINGS).filter(k => SETTINGS[k].secret).sort(),
  );
  assert.deepEqual(
    ENV_MAP.map(([e, k]) => [e, k]),
    Object.entries(SETTINGS).flatMap(([k, d]) => (d.env || []).map(([e]) => [e, k])),
  );
  // Jede ENV-Kante zeigt auf einen bekannten Key (sonst verwirft set() sie still).
  for (const [envVar, key] of ENV_MAP) {
    assert.ok(registry.isKnownKey(key), `ENV-Kante ${envVar} zeigt auf unbekannten Key ${key}`);
  }
});

test('isKnownKey deckt Defaults UND defaultlose Zugangsdaten', () => {
  for (const k of Object.keys(DEFAULTS)) assert.ok(registry.isKnownKey(k), k);
  for (const k of ENCRYPTED_KEYS) assert.ok(registry.isKnownKey(k), k);
  assert.equal(registry.isKnownKey('ai.claude.gibtsnicht'), false);
});

test('validateValue: Grenzen, Enums und Typen', () => {
  const { InvalidSettingValueError } = registry;
  assert.throws(() => registry.validateValue('ai.provider', 'gpt'), InvalidSettingValueError);
  assert.doesNotThrow(() => registry.validateValue('ai.provider', 'claude'));
  assert.throws(() => registry.validateValue('jobs.max_concurrent', 0), InvalidSettingValueError);
  assert.throws(() => registry.validateValue('jobs.max_concurrent', 9), InvalidSettingValueError);
  assert.throws(() => registry.validateValue('jobs.max_concurrent', 2.5), InvalidSettingValueError);
  assert.doesNotThrow(() => registry.validateValue('jobs.max_concurrent', 4));
  // Key ohne validate-Spec: alles erlaubt (freie Strings sind Absicht).
  assert.doesNotThrow(() => registry.validateValue('smtp.from_name', 'was auch immer'));
});
