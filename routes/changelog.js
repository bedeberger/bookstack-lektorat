'use strict';
// Changelog-Routen — Release-Notizen fuer den Reiter „Neuigkeiten" der
// Hilfe-Karte, plus die Quittung des Users.
//
// Die Liste wird LAZY geholt (erst beim Oeffnen des Reiters) und nicht ueber
// /config mitgeliefert: sie waechst mit jedem Release und haette in jeder
// Boot-Antwort nichts zu suchen. /config traegt nur die Kopf-Version
// (`changelogLatest`) plus den Stand des Users (`changelogSeen`) — genug fuer
// den Neu-Punkt am Hilfe-Knopf, ohne die Nutzlast.
//
// Keine Buch-Skopierung, keine ACL ausser dem globalen Session-Guard: der
// Changelog gehoert der Instanz, nicht einem Werk.

const express = require('express');
const { getChangelog, getLatestVersion } = require('../lib/changelog');
const appUsers = require('../db/app-users');
const { sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

/** Alle Releases, neueste zuerst. Beide Sprachen pro Eintrag — die Ansicht
 *  waehlt nach der UI-Sprache des Betrachters, nicht der Server. */
router.get('/', (req, res) => {
  res.json({ latest: getLatestVersion(), releases: getChangelog() });
});

/** Quittung: der User hat die Neuigkeiten bis einschliesslich `version`
 *  gesehen. Ohne `version` gilt die neueste bekannte. */
router.post('/seen', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const latest = getLatestVersion();
  const wanted = String(req.body?.version || '').trim() || latest;
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) {
    return res.status(400).json({ error_code: 'INVALID_VERSION' });
  }

  // Nur vorwaerts: ein Zweitgeraet mit alter Shell quittiert sonst auf seinen
  // eigenen, aelteren Stand zurueck und holt den Punkt damit wieder hervor.
  const seen = appUsers.getUser(email)?.changelog_seen_version || '';
  if (_cmp(wanted, seen) > 0) {
    try { appUsers.setChangelogSeen(email, wanted); }
    catch (e) { logger.warn(`changelog/seen: ${e.message}`); }
  }
  res.json({ ok: true, seen: appUsers.getUser(email)?.changelog_seen_version || null });
});

// Semver-Vergleich; ein leerer/ungueltiger Stand gilt als „aelter als alles".
function _cmp(a, b) {
  const pa = String(a || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  const pb = String(b || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = router;
