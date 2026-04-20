const { db } = require('./connection');
require('./migrations');
const { encrypt, decrypt, isEncrypted } = require('../lib/crypto');

const _getToken = db.prepare('SELECT token_id, token_pw FROM user_tokens WHERE email = ?');
const _upsertToken = db.prepare(`
  INSERT INTO user_tokens (email, token_id, token_pw, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(email) DO UPDATE SET
    token_id=excluded.token_id, token_pw=excluded.token_pw, updated_at=excluded.updated_at
`);
const _getAnyToken = db.prepare('SELECT token_id, token_pw FROM user_tokens LIMIT 1');
const _getAllTokens = db.prepare('SELECT email, token_id, token_pw FROM user_tokens');

/** Entschlüsselt ein Token-Row-Objekt. Migriert Klartext automatisch zu verschlüsselt. */
function _decryptRow(row, email) {
  if (!row) return row;
  const needsMigration = !isEncrypted(row.token_id) || !isEncrypted(row.token_pw);
  const plainId = decrypt(row.token_id);
  const plainPw = decrypt(row.token_pw);
  if (needsMigration && email) {
    _upsertToken.run(email, encrypt(plainId), encrypt(plainPw));
  }
  return { token_id: plainId, token_pw: plainPw };
}

/** Gibt { token_id, token_pw } für eine E-Mail zurück, oder undefined. */
function getUserToken(email) { return _decryptRow(_getToken.get(email), email); }

/** Speichert/aktualisiert den BookStack-Token für eine E-Mail (verschlüsselt). */
function setUserToken(email, tokenId, tokenPw) { _upsertToken.run(email, encrypt(tokenId), encrypt(tokenPw)); }

/** Gibt irgendeinen gespeicherten Token zurück (für Cron-Jobs ohne Session-Kontext). */
function getAnyUserToken() {
  const row = _getAnyToken.get();
  return row ? { token_id: decrypt(row.token_id), token_pw: decrypt(row.token_pw) } : undefined;
}

/** Gibt alle gespeicherten Tokens zurück (für User-iterierenden Sync). */
function getAllUserTokens() {
  return _getAllTokens.all().map(row => ({
    email: row.email,
    token_id: decrypt(row.token_id),
    token_pw: decrypt(row.token_pw),
  }));
}

module.exports = { getUserToken, setUserToken, getAnyUserToken, getAllUserTokens };
