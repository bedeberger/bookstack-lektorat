'use strict';
// DB-Helper fuer device_tokens — per-User-Bearer-Token fuer native Clients
// (Mac-Focus-Writer). Plain-Token wird nur einmal beim Create zurueckgegeben;
// danach existiert in der DB ausschliesslich der SHA-256-Hash.
// Format: `swd_<32 Hex-Bytes>` — eigener Prefix, damit der Device-Bearer-Pfad
// fremde Tokens (`sw_…` = api_tokens/Metrics) frueh abweisen kann.

const crypto = require('crypto');
const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const TOKEN_PREFIX = 'swd_';
// Bewusste KOPIE von TOKEN_KINDS.device aus lib/device-scopes.js: die DB-Schicht
// soll nicht in lib/ greifen muessen, um einen Default zu kennen. Gegen Drift
// gegated durch tests/unit/device-scopes.test.js.
const DEFAULT_SCOPES = 'content:read,content:write';

function generatePlainToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plain) {
  return crypto.createHash('sha256').update(String(plain || ''), 'utf8').digest('hex');
}

function createDeviceToken({ userEmail, deviceName, platform = null, scopes = DEFAULT_SCOPES, expiresAt = null }) {
  if (!userEmail) throw new Error('user_email required');
  if (!deviceName || !String(deviceName).trim()) throw new Error('device_name required');
  const plain = generatePlainToken();
  const hash = hashToken(plain);
  const r = db.prepare(`
    INSERT INTO device_tokens (user_email, token_hash, device_name, platform, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  `).run(userEmail, hash, String(deviceName).trim().slice(0, 100), platform ? String(platform).slice(0, 40) : null, scopes || DEFAULT_SCOPES, expiresAt);
  const row = db.prepare('SELECT id, user_email, device_name, platform, scopes, expires_at, created_at FROM device_tokens WHERE id = ?').get(r.lastInsertRowid);
  return { ...row, plain_token: plain };
}

// Format eines Klartext-Tokens: `swd_` + 64 Hex-Zeichen (32 Byte). Wird nur dort
// geprueft, wo ein Token von AUSSEN vorgegeben wird (fixe Demo-Tokens aus ENV) —
// generatePlainToken() erzeugt diese Form per Konstruktion.
const TOKEN_RE = /^swd_[0-9a-fA-F]{64}$/;

function isValidTokenFormat(plain) {
  return typeof plain === 'string' && TOKEN_RE.test(plain);
}

/**
 * Registriert ein VORGEGEBENES Klartext-Token (Hash in die DB, Klartext bleibt
 * beim Aufrufer). Existenzgrund: fixe Demo-Tokens aus ENV, damit ein
 * Store-Reviewer den nativen Client ohne Web-Login in Betrieb nehmen kann — der
 * normale Pfad (`createDeviceToken`) generiert das Token selbst und gibt es
 * genau einmal zurueck, was fuer einen ENV-vorgegebenen Wert nicht taugt.
 *
 * Idempotent und rotations-sicher: aeltere Tokens desselben Users mit demselben
 * `device_name` (= derselbe ENV-Slot) werden geloescht. Ohne das bliebe nach
 * einer ENV-Rotation das alte Token gueltig — Rotieren wuerde nichts entziehen.
 *
 * `revoked_at` wird bewusst geleert: bei einem ENV-vorgegebenen Token ist die ENV
 * die Wahrheit. Entziehen heisst Variable entfernen, nicht Row widerrufen.
 */
function upsertFixedDeviceToken({ userEmail, plain, deviceName, platform = null, scopes = DEFAULT_SCOPES }) {
  if (!userEmail) throw new Error('user_email required');
  if (!deviceName || !String(deviceName).trim()) throw new Error('device_name required');
  if (!isValidTokenFormat(plain)) throw new Error('token format invalid (expected swd_ + 64 hex chars)');
  const hash = hashToken(plain);
  const name = String(deviceName).trim().slice(0, 100);
  const plat = platform ? String(platform).slice(0, 40) : null;
  const sc = scopes || DEFAULT_SCOPES;
  const run = db.transaction(() => {
    const stale = db.prepare(`
      DELETE FROM device_tokens
      WHERE user_email = ? AND device_name = ? AND token_hash != ?
    `).run(userEmail, name, hash);
    const before = db.prepare('SELECT id FROM device_tokens WHERE token_hash = ?').get(hash);
    db.prepare(`
      INSERT INTO device_tokens (user_email, token_hash, device_name, platform, scopes, created_at)
      VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
      ON CONFLICT(token_hash) DO UPDATE SET
        user_email  = excluded.user_email,
        device_name = excluded.device_name,
        platform    = excluded.platform,
        scopes      = excluded.scopes,
        revoked_at  = NULL,
        expires_at  = NULL
    `).run(userEmail, hash, name, plat, sc);
    const row = db.prepare('SELECT id FROM device_tokens WHERE token_hash = ?').get(hash);
    return { id: row.id, action: before ? 'updated' : 'created', rotatedAway: stale.changes };
  });
  return run();
}

function findActiveTokenByPlain(plain) {
  if (!plain || typeof plain !== 'string') return null;
  if (!plain.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plain);
  const row = db.prepare(`
    SELECT id, user_email, scopes, expires_at, revoked_at
    FROM device_tokens
    WHERE token_hash = ?
  `).get(hash);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
  return row;
}

// Bei jedem authentifizierten Device-Token-Request: last_used_at/-ip aktualisieren,
// use_count +1 und — falls der Client eine Version meldet (X-Client-Version) —
// client_version persistieren. COALESCE haelt den letzten bekannten Wert, wenn
// ein Request mal ohne Versions-Header kommt.
function touchTokenUsage(tokenId, ip, clientVersion = null) {
  const ver = clientVersion ? String(clientVersion).trim().slice(0, 40) : null;
  db.prepare(`
    UPDATE device_tokens
       SET last_used_at = ${NOW_ISO_SQL},
           last_used_ip = ?,
           use_count    = use_count + 1,
           client_version = COALESCE(?, client_version)
     WHERE id = ?
  `).run(String(ip || '').slice(0, 64), ver, tokenId);
}

function getDeviceTokenById(id) {
  return db.prepare('SELECT id, user_email, device_name, platform FROM device_tokens WHERE id = ?').get(id) || null;
}

function listDeviceTokens(userEmail) {
  return db.prepare(`
    SELECT id, user_email, device_name, platform, scopes, client_version, use_count,
           last_used_at, last_used_ip, expires_at, revoked_at, created_at
    FROM device_tokens
    WHERE user_email = ?
    ORDER BY (revoked_at IS NULL) DESC, created_at DESC
  `).all(userEmail);
}

// Admin: alle Device-Tokens user-uebergreifend (fuer den Admin-Tab „Geraete").
// JOIN auf app_users fuer den Anzeigenamen — Snapshot-frei (Wahrheit in app_users).
function listAllDeviceTokens() {
  return db.prepare(`
    SELECT dt.id, dt.user_email, u.display_name AS user_display_name,
           dt.device_name, dt.platform, dt.scopes, dt.client_version, dt.use_count,
           dt.last_used_at, dt.last_used_ip, dt.expires_at, dt.revoked_at, dt.created_at
    FROM device_tokens dt
    LEFT JOIN app_users u ON u.email = dt.user_email
    ORDER BY (dt.revoked_at IS NULL) DESC, dt.last_used_at DESC NULLS LAST, dt.created_at DESC
  `).all();
}

function revokeDeviceToken(id, userEmail) {
  const r = db.prepare(`
    UPDATE device_tokens SET revoked_at = ${NOW_ISO_SQL}
    WHERE id = ? AND user_email = ? AND revoked_at IS NULL
  `).run(id, userEmail);
  return r.changes > 0;
}

function deleteDeviceToken(id, userEmail) {
  const r = db.prepare('DELETE FROM device_tokens WHERE id = ? AND user_email = ?').run(id, userEmail);
  return r.changes > 0;
}

/**
 * Loescht ALLE Tokens eines Users und liefert die Anzahl.
 *
 * Existenzgrund: die Konto-Selbstloeschung (lib/account-delete.js) muss den
 * Zugang der nativen Clients als ERSTEN Schritt kappen, bevor sie Inhalte
 * abraeumt — der FK-CASCADE von app_users wuerde das erst am Ende tun, und bis
 * dahin koennte ein noch laufender Client weiterschreiben. Loeschen statt
 * Widerrufen: ein Konto, das es nicht mehr gibt, braucht keine Token-Historie.
 */
function deleteAllDeviceTokens(userEmail) {
  return db.prepare('DELETE FROM device_tokens WHERE user_email = ? COLLATE NOCASE').run(userEmail).changes;
}

module.exports = {
  TOKEN_PREFIX,
  DEFAULT_SCOPES,
  generatePlainToken,
  hashToken,
  isValidTokenFormat,
  createDeviceToken,
  upsertFixedDeviceToken,
  findActiveTokenByPlain,
  touchTokenUsage,
  getDeviceTokenById,
  listDeviceTokens,
  listAllDeviceTokens,
  revokeDeviceToken,
  deleteDeviceToken,
  deleteAllDeviceTokens,
};
