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
 * Legt Anschauungsmaterial fuer den Demo-Zugang an (Beispielbuch, gemeinfreie
 * Prosa, kein KI-Call). Idempotent ueber den Buchnamen — laeuft bei jedem
 * Demo-Login, damit ein Reviewer nie in eine leere App fällt, auch wenn der
 * vorige das Buch geloescht hat.
 *
 * Non-fatal: scheitert der Seed, wird der Login trotzdem durchgelassen. Ein
 * Reviewer, der ohne Beispielbuch reinkommt, ist besser als einer, der wegen
 * eines Seed-Fehlers vor einem 500 steht.
 */
async function seedDemoContent(email) {
  try {
    const { createDemoBook } = require('./demo-book');
    const result = await createDemoBook(email);
    if (!result.deduplicated) {
      logger.info(`Demo-Zugang: Beispielbuch angelegt (id=${result.bookId})`, { user: email });
    }
    return result;
  } catch (e) {
    logger.warn(`Demo-Zugang: Beispielbuch-Seed fehlgeschlagen: ${e.message}`, { user: email });
    return null;
  }
}

module.exports = { isEnabled, demoEmail, ensureDemoUser, seedDemoContent, DEMO_DISPLAY_NAME };
