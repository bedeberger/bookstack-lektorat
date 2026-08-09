'use strict';
// KI-Profil-Overlay: loest `ai.<provider>.<key>` pro User auf.
//
// Ein Profil (`ai_profiles`, zugewiesen via app_users.ai_profile_id) traegt einen
// Provider und beliebig viele Parameter-Ueberschreibungen. NULL in einer Spalte
// heisst „globaler Wert" — deshalb ist das hier ein Overlay und kein Ersatz:
//
//   aiSetting('openai-compat', 'model')   → Profil-Modell, sonst ai.openai-compat.model
//
// Das Overlay greift NUR, wenn der Provider des Profils dem angefragten Provider
// entspricht. Sonst bekaeme ein Call, der (aus welchem Grund auch immer) explizit
// gegen einen anderen Provider geht, die Parameter eines fremden Modells — etwa
// den Claude-Modellnamen als `model` an einen llama.cpp-Server.
//
// Der User kommt wie bei resolveProvider aus dem ALS-Context (der Job-Worker setzt
// ihn in routes/jobs/shared/queue.js#drainQueue), sofern der Aufrufer ihn nicht
// mitgibt. Ohne Kontext bleibt es beim globalen Wert.
//
// Lazy require auf die db-Module: lib/ai wird auch in Pfaden geladen, in denen die
// Tabellen noch nicht existieren (frische DB vor der Migration, Unit-Tests, die nur
// die Budget-Rechnung anfassen). Ein fehlendes Profil ist dort kein Fehler, sondern
// schlicht „kein Overlay".

const appSettings = require('../app-settings');
const { getContext } = require('../log-context');

function _emailFrom(opts) {
  if (opts && opts.userEmail) return opts.userEmail;
  if (opts && opts.userEmail === null) return null;
  return getContext().user || null;
}

/** Zugewiesenes Profil dieses Users (oder null). */
function activeProfile(opts) {
  const email = _emailFrom(opts);
  if (!email) return null;
  try {
    const appUsers = require('../../db/app-users');
    const u = appUsers.getUser(email);
    if (!u || !u.ai_profile_id) return null;
    const aiProfiles = require('../../db/ai-profiles');
    return aiProfiles.getProfile(u.ai_profile_id) || null;
  } catch { return null; }
}

/** Provider des zugewiesenen Profils (oder null = User folgt dem globalen ai.provider). */
function profileProvider(opts) {
  return activeProfile(opts)?.provider || null;
}

/**
 * Effektiver Wert von `ai.<provider>.<key>`: Profil-Spalte, sonst App-Setting.
 * `key` ist zugleich der Spaltenname im Profil (SSoT der Liste:
 * db/ai-profiles.js#PROFILE_FIELDS).
 */
function aiSetting(provider, key, opts) {
  const global = appSettings.get(`ai.${provider}.${key}`);
  const prof = activeProfile(opts);
  if (!prof || prof.provider !== provider) return global;
  const v = prof[key];
  return (v === null || v === undefined) ? global : v;
}

/**
 * Klartext-API-Key fuer diesen Provider. Getrennt von aiSetting, weil der Key im
 * Profil verschluesselt liegt und db/ai-profiles ihn bewusst nicht mit ausliefert.
 */
function aiApiKey(provider, opts) {
  const prof = activeProfile(opts);
  if (prof && prof.provider === provider) {
    try {
      const key = require('../../db/ai-profiles').apiKeyOf(prof.id);
      if (key) return key;
    } catch { /* faellt auf den globalen Key zurueck */ }
  }
  return String(appSettings.get(`ai.${provider}.api_key`) || '');
}

/**
 * Identitaet der aktiven Konfiguration fuer Cache-Schluessel und Semaphore-Buckets.
 * Zwei Profile auf DEMSELBEN Provider mit verschiedenen Modellen duerfen sich weder
 * Cache-Zeilen (der `provider`-Anteil im PK unterscheidet sie nicht) noch einen
 * Parallelitaets-Zaehler teilen (verschiedene Hosts vertragen verschiedene Lasten).
 */
function profileKey(provider, opts) {
  const prof = activeProfile(opts);
  if (!prof || prof.provider !== provider) return null;
  return `p${prof.id}`;
}

/**
 * Wie aiSetting, aber gegen einen MITGEGEBENEN profileKey statt gegen den
 * ALS-Context. Noetig fuer alles, was ausserhalb des aufrufenden Kontexts laeuft:
 * der Semaphore-Zaehler in ./shared wird beim Freiwerden eines Slots neu
 * ausgewertet — und das passiert im Kontext eines FREMDEN Calls. Ueber den
 * ALS-Context gelesen bekaeme der Bucket dort die Obergrenze eines anderen Profils.
 */
function aiSettingByProfileKey(provider, key, pkey) {
  const global = appSettings.get(`ai.${provider}.${key}`);
  const m = /^p(\d+)$/.exec(String(pkey || ''));
  if (!m) return global;
  try {
    const prof = require('../../db/ai-profiles').getProfile(parseInt(m[1], 10));
    if (!prof || prof.provider !== provider) return global;
    const v = prof[key];
    return (v === null || v === undefined) ? global : v;
  } catch { return global; }
}

module.exports = {
  activeProfile, profileProvider, aiSetting, aiApiKey, profileKey, aiSettingByProfileKey,
};
