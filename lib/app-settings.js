'use strict';
// Single Source of Truth fuer Runtime-Configs. Konsumenten lesen Werte ueber get(key) und reagieren
// optional auf das 'changed'-Event, wenn der Admin per PUT etwas aendert.
//
// Auflösung:
//   1. DB-Setting (app_settings)
//   2. Hardcoded Default (DEFAULTS)
// Kein ENV-Fallback fuer migrierte Keys — `.env` ist fuer diese Keys tot.
// Boot-Layer-Werte (PORT, DB_PATH, SESSION_SECRET, ADMIN_EMAIL,
// ADMIN_PASSWORD, TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN) bleiben in ENV.

const { EventEmitter } = require('events');
const { db } = require('../db/connection');
require('../db/migrations');
const { NOW_ISO_SQL } = require('../db/now');
const { encrypt, decrypt, isEncrypted } = require('./crypto');
const logger = require('../logger');

const events = new EventEmitter();

// Pro Server-Boot Memory-Cache; Invalidierung via set() + clearCache().
const _cache = new Map();

// Registry: ein Deskriptor pro Key (Default, Wertebereich, Verschluesselung,
// ENV-Bootstrap) plus die daraus abgeleiteten Sichten. Diese Datei ist nur noch
// der Speicher darum: Cache, DB-Zugriff, Audit, Events.
const registry = require('./app-settings/registry');
const {
  DEFAULTS, VALIDATORS, ENCRYPTED_KEYS, ENV_MAP,
  isEncryptedKey, isKnownKey, InvalidSettingValueError,
} = registry;
const _validate = registry.validateValue;

const _stmtGet = db.prepare('SELECT value_json, encrypted FROM app_settings WHERE key = ?');
const _stmtList = db.prepare('SELECT key, value_json, encrypted, updated_at, updated_by FROM app_settings ORDER BY key');
const _stmtUpsert = db.prepare(`
  INSERT INTO app_settings (key, value_json, encrypted, updated_at, updated_by)
  VALUES (@key, @value_json, @encrypted, ${NOW_ISO_SQL}, @updated_by)
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    encrypted  = excluded.encrypted,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
`);
const _stmtDelete = db.prepare('DELETE FROM app_settings WHERE key = ?');
const _stmtAuditInsert = db.prepare(`
  INSERT INTO app_settings_audit (key, old_hash, new_hash, updated_by, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
`);

function _readFromDb(key) {
  const row = _stmtGet.get(key);
  if (!row) return undefined;
  let raw = row.value_json;
  if (row.encrypted) {
    try { raw = decrypt(raw); }
    catch (e) {
      logger.error(`app-settings: Decrypt-Fehler fuer ${key}: ${e.message}`);
      return undefined;
    }
  }
  try { return JSON.parse(raw); }
  catch (e) {
    logger.error(`app-settings: JSON-Parse-Fehler fuer ${key}: ${e.message}`);
    return undefined;
  }
}

function get(key) {
  if (_cache.has(key)) return _cache.get(key);
  const fromDb = _readFromDb(key);
  const value = fromDb !== undefined ? fromDb : (DEFAULTS[key] !== undefined ? DEFAULTS[key] : undefined);
  _cache.set(key, value);
  return value;
}

function has(key) {
  return _readFromDb(key) !== undefined;
}

function set(key, value, { updatedBy = 'system' } = {}) {
  const encrypted = isEncryptedKey(key);
  // Sentinel `__unchanged__` fuer Encrypted-Felder: nicht ueberschreiben.
  if (encrypted && value === '__unchanged__') return get(key);
  _validate(key, value);
  const json = JSON.stringify(value);
  const stored = encrypted && typeof value === 'string' ? encrypt(json) : json;
  // Audit: SHA-256-Hash beider Werte. Klartext-Secrets nie in der Audit-Tabelle.
  const crypto = require('crypto');
  const oldRaw = _readFromDb(key);
  const oldHash = oldRaw === undefined ? null : crypto.createHash('sha256').update(JSON.stringify(oldRaw)).digest('hex').slice(0, 16);
  const newHash = crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
  _stmtUpsert.run({
    key,
    value_json: stored,
    encrypted: encrypted ? 1 : 0,
    updated_by: updatedBy,
  });
  _stmtAuditInsert.run(key, oldHash, newHash, updatedBy);
  _cache.delete(key);
  events.emit('changed', { key, updatedBy });
  return value;
}

function remove(key, { updatedBy = 'system' } = {}) {
  _stmtDelete.run(key);
  _cache.delete(key);
  events.emit('changed', { key, removed: true, updatedBy });
}

// Liste fuer Admin-UI: encrypted-Werte werden maskiert (letzte 4 Zeichen
// sichtbar, falls vorhanden — sonst Sentinel "***").
function listForAdmin() {
  const rows = _stmtList.all();
  const map = new Map(rows.map(r => [r.key, r]));
  // Encrypted-Keys immer aufnehmen — auch die ohne Hardcoded-Default und ohne
  // DB-Row. Sonst rendert das Admin-UI zwar das Passwort-Feld (aus dem Partial),
  // aber der Key fehlt in adminSettingsMap → adminSettingsSave überspringt ihn
  // (`if (!s) continue`) und der eingegebene Wert wird stillschweigend verworfen.
  const allKeys = new Set([...rows.map(r => r.key), ...Object.keys(DEFAULTS), ...ENCRYPTED_KEYS]);
  const out = [];
  for (const key of [...allKeys].sort()) {
    const row = map.get(key);
    const encrypted = row?.encrypted ? 1 : (isEncryptedKey(key) ? 1 : 0);
    let value;
    let masked = null;
    if (row) {
      let raw = row.value_json;
      if (row.encrypted) {
        try {
          const dec = decrypt(raw);
          const parsed = JSON.parse(dec);
          masked = typeof parsed === 'string' && parsed.length > 4
            ? '***' + parsed.slice(-4)
            : '***';
          value = '__masked__';
        } catch { value = '__masked__'; masked = '***'; }
      } else {
        try { value = JSON.parse(raw); } catch { value = raw; }
      }
    } else {
      value = DEFAULTS[key];
    }
    out.push({
      key,
      value,
      masked,
      encrypted,
      isDefault: !row,
      updated_at: row?.updated_at || null,
      updated_by: row?.updated_by || null,
    });
  }
  return out;
}

function clearCache() {
  _cache.clear();
}

function on(event, fn) {
  events.on(event, fn);
}

function off(event, fn) {
  events.off(event, fn);
}

// ENV → DB Bootstrap. Beim Server-Start einmalig: fuer jeden ENV-Key, der
// noch nicht in der DB liegt, Wert aus process.env in app_settings spiegeln.
// Damit Admins beim ersten 4c-Lauf nicht alles in der UI nachpflegen muessen.
// Keine Ueberschreibung bestehender DB-Werte — ENV ist nur „Erstbefuellung".
// Spaeter koennen die ENV-Reads in den Konsumenten ersatzlos entfernt werden.
function bootstrapFromEnv() {
  let mirrored = 0;
  for (const [envVar, key, transform] of ENV_MAP) {
    if (has(key)) continue;
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') continue;
    let value;
    try { value = transform(raw); }
    catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} transform failed: ${e.message}`);
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    try {
      set(key, value, { updatedBy: 'env-bootstrap' });
      mirrored++;
    } catch (e) {
      logger.warn(`app-settings: bootstrap ${envVar}→${key} write failed: ${e.message}`);
    }
  }
  if (mirrored > 0) logger.info(`app-settings: ${mirrored} ENV-Wert(e) initial in DB gespiegelt.`);
  return mirrored;
}

module.exports = {
  get, has, set, remove,
  listForAdmin, clearCache,
  on, off,
  isEncryptedKey, isKnownKey, ENCRYPTED_KEYS, DEFAULTS,
  bootstrapFromEnv, ENV_MAP,
  VALIDATORS, InvalidSettingValueError,
};
