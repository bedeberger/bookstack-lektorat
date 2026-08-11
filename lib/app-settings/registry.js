'use strict';
// Die Settings-Registry: EIN Deskriptor pro Key.
//
// Vier Eigenschaften haengen an einem Setting — Default, Wertebereich,
// Verschluesselung und ENV-Erstbefuellung. Die standen fruher in vier
// parallelen Listen (DEFAULTS / VALIDATORS / ENCRYPTED_KEYS / ENV_MAP), die
// alle auf denselben Key-String zeigten: ein neuer Key konnte in dreien fehlen,
// ohne dass etwas auffiel — am gefaehrlichsten beim `secret`-Flag, dessen
// Vergessen ein Token im Klartext in die DB schreibt. Hier tragen sie
// zusammen; die vier Listen sind daraus abgeleitete Sichten (unten).
//
// Ein Eintrag:
//   default   Hardcoded-Fallback, solange `app_settings` keine Row hat.
//             Fehlt die Eigenschaft, ist der Key ohne DB-Row undefined
//             (nur bei Zugangsdaten, s. Abschnitt am Ende).
//   validate  Wertebereich fuer set(): { type: 'int'|'number'|'enum'|'bool',
//             min, max, oneOf }. Fehlt = keine Pruefung; das ist bei freien
//             Strings (URLs, Hosts, Tokens) Absicht — dort ist „leer = aus"
//             ein gueltiger Zustand und ein Pattern-Check bringt wenig.
//             Ranges decken sich mit der numInput-min/max-Spec im Admin-UI
//             (public/partials/admin-settings.html); wer dort ein Limit
//             aendert, zieht es hier mit.
//   secret    true = wird encrypted persistiert und im Admin-UI maskiert.
//   env       [[ENV_VAR, transform], …] fuer die einmalige ENV→DB-Spiegelung.
//             Mehrere Variablen auf einem Key: die erste gewinnt (der Bootstrap
//             ueberspringt Keys, die schon eine DB-Row haben).
//
// Werte sind nicht-sensitiv (keine API-Keys, keine Tokens im Klartext).
// Boot-Layer-Werte (PORT, DB_PATH, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD,
// TZ, LOG_LEVEL, LOCAL_DEV_MODE, VERAPDF_BIN) bleiben in ENV und stehen nicht hier.

const SETTINGS = {
  ...require('./keys/auth'),
  ...require('./keys/ai'),
  ...require('./keys/app'),
  ...require('./keys/credentials'),
};

// --- Abgeleitete Sichten ----------------------------------------------------
// Bewusst aus SETTINGS berechnet und nicht daneben gepflegt: eine Sicht kann
// nicht mehr einen Key kennen, den die Registry nicht hat (und umgekehrt).

// Nur Eintraege MIT `default` — `DEFAULTS[key] !== undefined` und
// `Object.keys(DEFAULTS)` bleiben damit exakt so aussagekraeftig wie zuvor.
const DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS)
    .filter(([, d]) => Object.prototype.hasOwnProperty.call(d, 'default'))
    .map(([k, d]) => [k, d.default]),
));

const VALIDATORS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS).filter(([, d]) => d.validate).map(([k, d]) => [k, d.validate]),
));

const ENCRYPTED_KEYS = new Set(
  Object.entries(SETTINGS).filter(([, d]) => d.secret).map(([k]) => k),
);

// [envVar, key, transform] — Form und Reihenfolge wie zuvor (Reihenfolge ist
// Prioritaet, wenn zwei Variablen auf denselben Key zeigen).
const ENV_MAP = Object.freeze(Object.entries(SETTINGS).flatMap(
  ([key, d]) => (d.env || []).map(([envVar, transform]) => [envVar, key, transform]),
));

class InvalidSettingValueError extends Error {
  constructor(key, reason) {
    super(`${key}: ${reason}`);
    this.name = 'InvalidSettingValueError';
    this.code = 'INVALID_VALUE';
    this.key = key;
    this.reason = reason;
  }
}

function validateValue(key, value) {
  const v = VALIDATORS[key];
  if (!v) return;
  if (v.type === 'enum') {
    if (!v.oneOf.includes(value)) {
      throw new InvalidSettingValueError(key, `muss einer aus [${v.oneOf.join(', ')}] sein (got ${JSON.stringify(value)})`);
    }
    return;
  }
  if (v.type === 'int') {
    if (!Number.isInteger(value)) {
      throw new InvalidSettingValueError(key, `muss Integer sein (got ${JSON.stringify(value)})`);
    }
  } else if (v.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSettingValueError(key, `muss Number sein (got ${JSON.stringify(value)})`);
    }
  }
  if (typeof v.min === 'number' && value < v.min) {
    throw new InvalidSettingValueError(key, `muss >= ${v.min} sein (got ${value})`);
  }
  if (typeof v.max === 'number' && value > v.max) {
    throw new InvalidSettingValueError(key, `muss <= ${v.max} sein (got ${value})`);
  }
}

// Welche Keys werden encrypted persistiert? `set()` darf das nicht selbst
// raten — der Deskriptor markiert es explizit, weil ein vergessenes
// `secret: true` Token-Klartext in der DB landen liesse.
function isEncryptedKey(key) {
  return ENCRYPTED_KEYS.has(key);
}

// Bekannter Key = steht in der Registry. Die Admin-PUT-Route lehnt unbekannte
// Keys ab, damit Tippfehler nicht stillschweigend als toter Eintrag in
// app_settings landen.
function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

module.exports = {
  SETTINGS,
  DEFAULTS, VALIDATORS, ENCRYPTED_KEYS, ENV_MAP,
  validateValue, isEncryptedKey, isKnownKey,
  InvalidSettingValueError,
};
