'use strict';
// Admin-Tab „Geraete": listet alle Device-Tokens (native Mac-Focus-Clients +
// Chrome-Erweiterung) user-uebergreifend mit gemeldeter Client-Version,
// Nutzungszaehler und letzter Aktivitaet. Read-only — Ausstellen/Widerrufen
// bleibt beim User unter /me. Die installierten Versionen sind gegen die jeweils
// neueste veroeffentlichte Version der Plattform abgleichbar (macOS: freigegebene
// Mac-App-Store-Version, Android + Chrome-Erweiterung: neuestes GitHub-Release),
// damit veraltete Clients sichtbar werden — getrennt, weil alle Clients eigene
// Versionsstraenge haben.

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const deviceTokens = require('../db/device-tokens');
const macclientRelease = require('../lib/macclient-release');
const androidclientRelease = require('../lib/androidclient-release');
const extensionRelease = require('../lib/extension-release');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const devices = deviceTokens.listAllDeviceTokens();
    // Pro Plattform die neueste Version separat — ein Android-Client darf nicht
    // gegen die macOS-Version verglichen werden (sonst falsches „veraltet").
    // Gleiches gilt fuer die Chrome-Erweiterung (eigener Versionsstrang). Bei
    // macOS ist der Vergleichswert die *freigegebene* Store-Version: eine noch in
    // Review haengende Version kann niemand installiert haben.
    const latestVersions = { macos: null, android: null, extension: null };
    try {
      const [mac, android, ext] = await Promise.all([
        macclientRelease.getLatestRelease(),
        androidclientRelease.getLatestRelease(),
        extensionRelease.getLatestRelease(),
      ]);
      if (mac && mac.available) latestVersions.macos = mac.version;
      if (android && android.available) latestVersions.android = android.version;
      if (ext && ext.available) latestVersions.extension = ext.version;
    } catch { /* Release-Abruf nie den Tab blockieren lassen */ }
    res.json({ devices, latestVersions });
  } catch (e) {
    logger.error(`admin-devices list failed: ${e.message}`);
    res.status(500).json({ error_code: 'LIST_FAILED', message: e.message });
  }
});

module.exports = router;
