'use strict';
// Demo-Zugang: ENV-getriebener Passwort-Login fuer einen NICHT-Admin-Account.
//
// Zweck: Store-Reviews. Apple (Guideline 2.1) und Google Play ("App access")
// verlangen einen funktionierenden Demo-Account als Pflichtfeld, der Chrome Web
// Store Test-Credentials in den Reviewer-Notes. Der Google-OIDC-Pfad ist dafuer
// untauglich — ein Google-Konto laesst sich nicht an Reviewer weitergeben (2FA,
// Googles ToS, Login-Blocks aus Datacenter-IPs).
//
// Warum nicht einfach der ADMIN_PASSWORD-Pfad: der legt eine Session mit
// global_role='admin' an und gibt damit /admin/* und fremde Buecher frei. Ein
// Demo-Zugang ist ein normaler User — die beiden Pfade bleiben getrennt, damit
// ein Audit des Admin-Logins ein Audit des Admin-Logins bleibt.
//
// Wahrheit lebt in ENV (DEMO_EMAIL + DEMO_PASSWORD), analog ADMIN_EMAIL/
// ADMIN_PASSWORD und aus demselben Grund: Credentials gehoeren nicht in
// app_settings (siehe Kopfkommentar lib/app-settings.js). Fehlt eines der
// beiden, ist der Pfad vollstaendig aus — auf einer Prod-Instanz existiert er
// dadurch nicht, ohne dass ein Setting falsch stehen kann.

const appUsers = require('../db/app-users');
const deviceTokens = require('../db/device-tokens');
const { TOKEN_KINDS } = require('./device-scopes');
const logger = require('../logger');

// Session-Anzeigename. Kein i18n-Key: das ist ein Name (wie 'Admin' im
// ENV-Admin-Pfad), kein UI-String.
const DEMO_DISPLAY_NAME = 'Demo';

function _norm(v) {
  return String(v || '').toLowerCase().trim();
}

// Kollisionswarnung nur einmal pro Boot loggen (isEnabled() laeuft pro Request
// auf /login und pro Login-Versuch).
let _collisionLogged = false;

/** Demo-Zugangs-E-Mail aus ENV (normalisiert) oder ''. */
function demoEmail() {
  return _norm(process.env.DEMO_EMAIL);
}

/**
 * Ist der Demo-Login aktiv? Beide ENV-Werte muessen gesetzt sein.
 *
 * Zusaetzlicher Guard: DEMO_EMAIL === ADMIN_EMAIL deaktiviert den Pfad. Sonst
 * wuerden sich die zwei Login-Routen um dieselbe app_users-Row streiten —
 * ensureAdminFromEnv() hebt sie auf 'admin', ensureDemoUser() drueckt sie
 * zurueck auf 'user', und welche Rolle die Session bekaeme, haengt davon ab,
 * welcher Pfad zuletzt lief. Fail-closed auf der harmloseren Seite: der
 * Demo-Pfad faellt aus, der Admin-Pfad bleibt.
 */
function isEnabled() {
  if (!process.env.DEMO_EMAIL || !process.env.DEMO_PASSWORD) return false;
  if (demoEmail() && demoEmail() === _norm(process.env.ADMIN_EMAIL)) {
    if (!_collisionLogged) {
      _collisionLogged = true;
      logger.error('DEMO_EMAIL ist identisch mit ADMIN_EMAIL — Demo-Login bleibt deaktiviert. Eigene Adresse fuer den Demo-Zugang setzen.');
    }
    return false;
  }
  return true;
}

/**
 * Stellt die app_users-Row des Demo-Users sicher und liefert die Rolle fuer die
 * Session. Re-Run-tauglich (jeder Login).
 *
 * Rueckgabe:
 *   { role: 'user', name }        → Login darf weitergehen
 *   { denied: 'suspended'|'deleted' } → Status-Gate greift
 *   null                          → Pfad nicht aktiv
 *
 * Der Rollen-Downgrade ist Absicht: wird die Demo-Row von Hand oder ueber den
 * Admin-Tab auf 'admin' gehoben, drueckt der naechste Demo-Login sie zurueck.
 * Der Zugang ist oeffentlich bekannt und darf nie Admin-Rechte tragen.
 */
function ensureDemoUser() {
  if (!isEnabled()) return null;
  const email = demoEmail();
  const existing = appUsers.getUser(email);
  if (!existing) {
    appUsers.createUser({
      email,
      displayName: DEMO_DISPLAY_NAME,
      globalRole: 'user',
      status: 'active',
      // Kein Invite-Recht: der Zugang ist oeffentlich bekannt und wuerde sonst
      // zum Versandweg fuer Einladungsmails.
      canInviteUsers: 0,
    });
    logger.info(`Demo-User angelegt: ${email}`);
    return { role: 'user', name: DEMO_DISPLAY_NAME };
  }
  if (existing.status !== 'active') {
    return { denied: existing.status === 'deleted' ? 'deleted' : 'suspended' };
  }
  if (existing.global_role !== 'user') {
    appUsers.setGlobalRole(email, 'user');
    logger.warn(`Demo-User hatte global_role='${existing.global_role}' — auf 'user' zurueckgesetzt.`);
  }
  return { role: 'user', name: existing.display_name || DEMO_DISPLAY_NAME };
}

/**
 * Legt Anschauungsmaterial fuer den Demo-Zugang an (kein KI-Call): das eigene
 * Beispielbuch mit gemeinfreier Prosa UND ein zweites Buch eines fremden
 * Kontos, auf dem der Demo-User nur `viewer` ist. Idempotent, laeuft bei jedem
 * Demo-Login und bei jedem Serverstart, damit ein Reviewer nie in eine leere
 * App faellt, auch wenn der vorige alles geloescht hat.
 *
 * Rueckgabe: das Ergebnis von `createDemoBook` plus `foreign` (Ergebnis von
 * `createForeignDemoBook` bzw. null, wenn nur dieser Teil scheiterte).
 *
 * Non-fatal: scheitert der Seed, wird der Login trotzdem durchgelassen. Ein
 * Reviewer, der ohne Beispielbuch reinkommt, ist besser als einer, der wegen
 * eines Seed-Fehlers vor einem 500 steht.
 */
async function seedDemoContent(email) {
  let result = null;
  try {
    const { createDemoBook } = require('./demo-book');
    result = await createDemoBook(email);
    if (!result.deduplicated) {
      logger.info(`Demo-Zugang: Beispielbuch angelegt (id=${result.bookId})`, { user: email });
    }
  } catch (e) {
    logger.warn(`Demo-Zugang: Beispielbuch-Seed fehlgeschlagen: ${e.message}`, { user: email });
    return null;
  }

  // Zweites Buch: fremdes Eigentum, Demo-User nur `viewer` — der vorfuehrbare
  // 403-Pfad der Browser-Erweiterung (siehe lib/demo-book.js). Eigener
  // try/catch aus demselben Grund wie oben, aber eine Stufe strenger gedacht:
  // faellt der Fehlerfall-Seed aus, ist die App trotzdem benutzbar, und ein
  // Reviewer ohne Fremdbuch ist besser als einer vor einem 500.
  let foreign = null;
  try {
    const { createForeignDemoBook } = require('./demo-book');
    foreign = await createForeignDemoBook(email);
    if (!foreign.deduplicated) {
      logger.info(`Demo-Zugang: Fremdbuch angelegt (id=${foreign.bookId}, Rolle viewer)`, { user: email });
    }
  } catch (e) {
    logger.warn(`Demo-Zugang: Fremdbuch-Seed fehlgeschlagen: ${e.message}`, { user: email });
  }

  return { ...result, foreign };
}

// Fixe Device-Tokens des Demo-Zugangs. `device_name` ist der stabile Slot-Name:
// upsertFixedDeviceToken raeumt aeltere Tokens desselben Slots weg, sodass eine
// ENV-Rotation das alte Token wirklich entzieht.
const TOKEN_SLOTS = [
  {
    env: 'DEMO_DEVICE_TOKEN',
    deviceName: 'Demo-Client (macOS/Android)',
    platform: 'demo-native',
    scopes: TOKEN_KINDS.device,
  },
  {
    env: 'DEMO_CAPTURE_TOKEN',
    deviceName: 'Demo-Erweiterung (Chrome)',
    platform: 'demo-extension',
    scopes: TOKEN_KINDS.capture,
  },
];

/**
 * Registriert die in ENV vorgegebenen Device-Tokens des Demo-Users.
 *
 * Warum ueberhaupt fix statt ueber den normalen Mint-Pfad: die nativen Clients
 * und die Browser-Erweiterung authentisieren per Bearer-Token und sehen die
 * Login-Seite nie. Ein Store-Reviewer muesste sonst erst im Browser einloggen,
 * ins Profil, ein Token minten und es in die App kopieren — realistisch der
 * Punkt, an dem die Review als „App unbenutzbar" endet. Mit einem fixen Token
 * steht der Wert in den Reviewer-Notes und der Client laeuft ohne Umweg.
 *
 * Nur Format-geprueft, nicht generiert: der Klartext muss ausserhalb bekannt
 * bleiben (Reviewer-Notes), die DB kennt weiterhin nur den SHA-256-Hash. Ein
 * formal ungueltiger Wert wird NICHT registriert (fail closed) — sonst wandert
 * ein Kurz-Token wie `swd_test` als vollwertiger Schreibzugang auf eine
 * oeffentlich erreichbare Instanz.
 *
 * Rueckgabe: Array der registrierten Slots (leer, wenn nichts gesetzt ist).
 */
function ensureDemoTokens() {
  if (!isEnabled()) return [];
  const email = demoEmail();
  const seen = new Map(); // Klartext → Slot, gegen doppelt verwendete Werte
  const done = [];
  for (const slot of TOKEN_SLOTS) {
    const plain = String(process.env[slot.env] || '').trim();
    if (!plain) continue;
    if (!deviceTokens.isValidTokenFormat(plain)) {
      logger.error(`${slot.env} hat kein gueltiges Token-Format (erwartet: swd_ + 64 Hex-Zeichen, z.B. aus \`openssl rand -hex 32\`) — Token wird NICHT registriert.`);
      continue;
    }
    // Derselbe Wert in zwei Slots wuerde dieselbe Row treffen (token_hash ist
    // UNIQUE): der zweite Upsert ueberschriebe die Scopes des ersten, und der
    // Client mit dem weiteren Scope verlöre ihn lautlos.
    if (seen.has(plain)) {
      logger.error(`${slot.env} ist identisch mit ${seen.get(plain)} — jeder Slot braucht einen eigenen Wert. Token wird NICHT registriert.`);
      continue;
    }
    seen.set(plain, slot.env);
    try {
      const r = deviceTokens.upsertFixedDeviceToken({
        userEmail: email,
        plain,
        deviceName: slot.deviceName,
        platform: slot.platform,
        scopes: slot.scopes,
      });
      if (r.action === 'created' || r.rotatedAway) {
        logger.info(`Demo-Token «${slot.deviceName}» ${r.action}${r.rotatedAway ? ` (${r.rotatedAway} altes Token entzogen)` : ''}.`);
      }
      done.push({ ...slot, id: r.id, action: r.action });
    } catch (e) {
      logger.error(`Demo-Token «${slot.deviceName}» konnte nicht registriert werden: ${e.message}`);
    }
  }
  return done;
}

/**
 * Ist dieses Device-Token ein ENV-vorgegebener Demo-Slot?
 *
 * Zweck: die fixen Tokens erscheinen im Profil des Demo-Users wie jedes andere
 * Geraet — ein neugieriger Reviewer koennte sie dort widerrufen und damit den
 * nativen Zugang aller folgenden Reviewer bis zum naechsten Serverstart
 * abschalten. Die Pflege-Routen lehnen das darum ab: entzogen wird ein fixes
 * Token ueber die ENV, nicht ueber die UI.
 */
function isFixedDemoToken(tokenId) {
  if (!isEnabled()) return false;
  const row = deviceTokens.getDeviceTokenById(tokenId);
  if (!row || row.user_email !== demoEmail()) return false;
  return TOKEN_SLOTS.some(s => s.deviceName === row.device_name);
}

/**
 * Boot-Bootstrap des Demo-Zugangs: app_users-Row + fixe Device-Tokens.
 *
 * Muss beim SERVERSTART laufen, nicht erst beim ersten Login: die Tokens sind
 * genau fuer die Clients da, die den Browser-Login nie aufrufen. Der FK auf
 * app_users(email) verlangt dabei die Reihenfolge User-vor-Token.
 */
function ensureDemoAccess() {
  if (!isEnabled()) return null;
  const ensured = ensureDemoUser();
  if (ensured && ensured.denied) {
    logger.warn(`Demo-Zugang: User ist '${ensured.denied}' — Tokens werden nicht registriert.`);
    return { user: ensured, tokens: [] };
  }
  return { user: ensured, tokens: ensureDemoTokens() };
}

module.exports = {
  isEnabled, demoEmail, ensureDemoUser, seedDemoContent,
  ensureDemoTokens, ensureDemoAccess, isFixedDemoToken,
  DEMO_DISPLAY_NAME, TOKEN_SLOTS,
};
