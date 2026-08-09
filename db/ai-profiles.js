'use strict';
// Helper-API ueber `ai_profiles` — benannte KI-Modell-Konfigurationen, die einem
// User zugewiesen werden (app_users.ai_profile_id). Keine direkte SQL aus
// Konsumenten.
//
// JEDE Parameter-Spalte ist NULLBAR und bedeutet dann „nimm den globalen Wert
// `ai.<provider>.<key>`" — die Aufloesung dieses Overlays liegt in
// lib/ai/profile.js#aiSetting, NICHT hier. Dieses Modul ist reine Persistenz und
// kennt die Bedeutung der Werte nicht; es entschluesselt nur den API-Key, weil
// der verschluesselt in der Spalte liegt (wie ai.claude.api_key in app_settings).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');

// Spalten, die ein Profil ueberschreiben darf. SSoT dieser Liste — Route,
// Aufloesung und Admin-UI lesen sie, statt die Namen je einzeln zu wiederholen.
// `key` ist zugleich das Suffix des globalen Settings (`ai.<provider>.<key>`);
// genau daran haengt das Overlay in lib/ai/profile.js.
const PROFILE_FIELDS = [
  { key: 'model',          type: 'text' },
  { key: 'host',           type: 'text' },
  { key: 'api_key',        type: 'secret' },
  { key: 'cloud',          type: 'bool' },
  { key: 'temperature',    type: 'real' },
  { key: 'context_window', type: 'int' },
  { key: 'max_tokens_out', type: 'int' },
  { key: 'repeat_penalty', type: 'real' },
  { key: 'think',          type: 'bool' },
  { key: 'max_parallel',   type: 'int' },
];
const PROFILE_FIELD_KEYS = PROFILE_FIELDS.map(f => f.key);

const _SELECT = `
  SELECT id, name, provider, model, host, api_key, cloud, temperature,
         context_window, max_tokens_out, repeat_penalty, think, max_parallel,
         notes, created_by, created_at, updated_at
    FROM ai_profiles
`;

const _stmtGet     = db.prepare(`${_SELECT} WHERE id = ?`);
const _stmtGetName = db.prepare(`${_SELECT} WHERE name = ?`);
const _stmtList    = db.prepare(`${_SELECT} ORDER BY provider, name`);
const _stmtDelete  = db.prepare('DELETE FROM ai_profiles WHERE id = ?');
const _stmtUsage   = db.prepare('SELECT COUNT(*) AS n FROM app_users WHERE ai_profile_id = ?');

const _stmtInsert = db.prepare(`
  INSERT INTO ai_profiles (name, provider, model, host, api_key, cloud, temperature,
                           context_window, max_tokens_out, repeat_penalty, think,
                           max_parallel, notes, created_by, created_at, updated_at)
  VALUES (@name, @provider, @model, @host, @api_key, @cloud, @temperature,
          @context_window, @max_tokens_out, @repeat_penalty, @think,
          @max_parallel, @notes, @created_by, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);

const _stmtUpdate = db.prepare(`
  UPDATE ai_profiles
     SET name = @name, provider = @provider, model = @model, host = @host,
         api_key = @api_key, cloud = @cloud, temperature = @temperature,
         context_window = @context_window, max_tokens_out = @max_tokens_out,
         repeat_penalty = @repeat_penalty, think = @think,
         max_parallel = @max_parallel, notes = @notes,
         updated_at = ${NOW_ISO_SQL}
   WHERE id = @id
`);

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function _int(v) {
  const n = _num(v);
  return n === null ? null : Math.round(n);
}
function _bool(v) {
  if (v === null || v === undefined || v === '') return null;
  return (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
}
function _text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Rohzeile → Objekt fuer Konsumenten. Der API-Key wird NICHT entschluesselt:
// nur lib/ai/profile.js braucht den Klartext und holt ihn ueber apiKeyOf().
function _shape(row) {
  if (!row) return null;
  return {
    ...row,
    cloud: row.cloud === null ? null : !!row.cloud,
    think: row.think === null ? null : !!row.think,
    has_api_key: !!row.api_key,
    api_key: undefined,
  };
}

function getProfile(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  return _shape(_stmtGet.get(n));
}

function getProfileByName(name) {
  return _shape(_stmtGetName.get(String(name || '')));
}

function listProfiles() {
  return _stmtList.all().map(_shape);
}

/** Klartext-API-Key eines Profils (oder null). Getrennt von getProfile, damit ein
 *  Key nicht versehentlich in eine Admin-Antwort geraet. */
function apiKeyOf(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  const row = _stmtGet.get(n);
  if (!row || !row.api_key) return null;
  return isEncrypted(row.api_key) ? decrypt(row.api_key) : row.api_key;
}

// `api_key === '__unchanged__'` laesst den gespeicherten Key stehen (gleiche
// Konvention wie app_settings#set) — die Admin-UI bekommt ihn nie im Klartext
// zu sehen und kann ihn darum auch nicht zuruecksenden.
function _normalize(src, prev) {
  const out = {
    name: _text(src.name),
    provider: _text(src.provider),
    notes: _text(src.notes),
  };
  for (const f of PROFILE_FIELDS) {
    const raw = src[f.key];
    if (f.type === 'secret') {
      if (raw === '__unchanged__') out[f.key] = prev ? prev.api_key : null;
      else {
        const plain = _text(raw);
        out[f.key] = plain === null ? null : encrypt(plain);
      }
    } else if (f.type === 'bool') out[f.key] = _bool(raw);
    else if (f.type === 'int')   out[f.key] = _int(raw);
    else if (f.type === 'real')  out[f.key] = _num(raw);
    else                          out[f.key] = _text(raw);
  }
  return out;
}

function createProfile(src, createdBy) {
  const p = _normalize(src || {}, null);
  if (!p.name) throw new Error('createProfile: name required');
  if (!p.provider) throw new Error('createProfile: provider required');
  const info = _stmtInsert.run({ ...p, created_by: createdBy || null });
  return getProfile(info.lastInsertRowid);
}

function updateProfile(id, src) {
  const n = parseInt(id, 10);
  const prev = _stmtGet.get(n);
  if (!prev) return null;
  const p = _normalize({ ...prev, ...src, api_key: src.api_key }, prev);
  if (!p.name) throw new Error('updateProfile: name required');
  if (!p.provider) throw new Error('updateProfile: provider required');
  _stmtUpdate.run({ ...p, id: n });
  return getProfile(n);
}

/** Loeschen ist erlaubt, auch wenn User daran haengen: der FK setzt deren
 *  `ai_profile_id` auf NULL, sie folgen danach wieder dem globalen Provider.
 *  Die Zahl der betroffenen User kommt mit zurueck, damit die Route sie melden
 *  kann statt sie stillschweigend umzuhaengen. */
function deleteProfile(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return { deleted: false, detachedUsers: 0 };
  const affected = _stmtUsage.get(n)?.n || 0;
  const info = _stmtDelete.run(n);
  return { deleted: info.changes > 0, detachedUsers: affected };
}

function profileUsageCount(id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return 0;
  return _stmtUsage.get(n)?.n || 0;
}

module.exports = {
  PROFILE_FIELDS, PROFILE_FIELD_KEYS,
  getProfile, getProfileByName, listProfiles, apiKeyOf,
  createProfile, updateProfile, deleteProfile, profileUsageCount,
};
