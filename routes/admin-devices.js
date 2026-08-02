'use strict';
// Admin-Tab „Geraete": listet alle Device-Tokens (native Mac-Focus-Clients +
// Chrome-Erweiterung) user-uebergreifend mit gemeldeter Client-Version,
// Nutzungszaehler und letzter Aktivitaet. Read-only — Ausstellen/Widerrufen
// bleibt beim User unter /me. Die installierten Versionen sind gegen das
// neueste GitHub-Release der jeweiligen Plattform (macOS, Android, Chrome-
// Erweiterung) abgleichbar, damit veraltete Clients sichtbar werden — getrennt,
// weil alle Repos eigene Versionsstraenge haben.

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
    // Gleiches gilt fuer die Chrome-Erweiterung (eigener Versionsstrang).
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
