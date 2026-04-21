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

/**
 * Liefert das aktuelle BookStack-Token für den eingeloggten User eines Requests.
 * Quelle ist die DB (nicht `req.session.bookstackToken`), damit Token-Änderungen
 * auf einem anderen Gerät sofort in allen Sessions wirken.
 * Fallback auf Session-Token für LOCAL_DEV_MODE (dort steht das Token aus der
 * .env direkt in der Session, ohne DB-Eintrag).
 * @returns {{ id: string, pw: string } | null}
 */
function getTokenForRequest(req) {
  const email = req.session?.user?.email;
  if (email) {
    const stored = getUserToken(email);
    if (stored?.token_id && stored?.token_pw) return { id: stored.token_id, pw: stored.token_pw };
  }
  const t = req.session?.bookstackToken;
  return t?.id && t?.pw ? { id: t.id, pw: t.pw } : null;
}

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

module.exports = { getUserToken, setUserToken, getAnyUserToken, getAllUserTokens, getTokenForRequest };
