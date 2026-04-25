const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

let _key = null;

/**
 * Leitet den Encryption-Key einmalig aus SESSION_SECRET ab.
 * Wirft, wenn SESSION_SECRET fehlt — verhindert, dass Tokens versehentlich
 * im Klartext in die DB geschrieben werden.
 */
function getKey() {
  if (_key) return _key;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET nicht gesetzt – Token-Verschlüsselung nicht möglich. Bitte in .env setzen.');
  }
  _key = crypto.scryptSync(secret, 'bookstack-lektorat-token-enc', KEY_LEN);
  return _key;
}

/** Verschluesselt einen Klartext-String. Gibt `enc:v1:<hex>` zurueck. */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('hex');
}

/** Entschluesselt einen `enc:v1:<hex>`-String. Klartext wird unveraendert zurueckgegeben. */
function decrypt(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const key = getKey();
  const buf = Buffer.from(stored.slice(PREFIX.length), 'hex');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
}

/** Prueft, ob ein Wert bereits verschluesselt ist. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
