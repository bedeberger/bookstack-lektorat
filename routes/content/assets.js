'use strict';
// Content-Routes: OTA-/Release-Assets der nativen Clients — Focus-Editor-Bundle
// (macOS), macclient-i18n-Overrides, Release-Discovery (macOS, Android, Chrome).
// Alle ETag-konditional (If-None-Match → 304). Auth via globalem Guard.

const { createHash } = require('node:crypto');
const editorBundle = require('../../lib/editor-bundle');
const macclientI18n = require('../../lib/macclient-i18n');
const macclientRelease = require('../../lib/macclient-release');
const androidclientRelease = require('../../lib/androidclient-release');
const extensionRelease = require('../../lib/extension-release');
const logger = require('../../logger');
const { _clientLabel, _fail } = require('./shared');

function register(router) {
  // GET /content/editor-bundle.zip — OTA-Bundle des Focus-Editors fuer den nativen
  // macOS-Client (schreibwerkstatt-focuseditor), der die Editor-Assets zur Laufzeit
  // zieht und lokal cacht (statt sie zur Build-Zeit aus dem Repo zu kopieren).
  //
  // Inhalt (strukturerhaltend, Pfade relativ wie unter public/): die transitive
  // ES-Modul-Import-Closure ab focus.js / focus/standalone.js /
  // shared/editor-host.js / shared/block-merge.js, die Focus-Editor-CSS-Dateien
  // und ein bundle-manifest.json ({ sourceCommit, jsFiles[], cssFiles[] }). KEIN
  // index.html — das Boot-/Bridge-HTML besitzt der Client. Closure-Logik (SSoT)
  // in [lib/editor-bundle.js](../lib/editor-bundle.js).
  //
  // Auth: greift ueber den globalen Guard (server.js) — Session ODER Device-Token
  // (Bearer swd_…) wie alle /content/-Routen; keine zusaetzliche unauthentifizierte
  // Flaeche (Editor-JS waere unter public/js zwar ohnehin oeffentlich).
  //
  // ETag = sha256(sourceCommit + sortierte Datei-Hashes). Bei If-None-Match mit
  // passendem ETag → 304 ohne Body, sodass der Client bei jedem Online-Start
  // konditional anfragen kann, ohne ein unveraendertes Bundle neu zu laden.
  router.get('/editor-bundle.zip', async (req, res) => {
    try {
      const { etag, buffer } = await editorBundle.getBundle();
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
      const client = _clientLabel(req);
      if (req.headers['if-none-match'] === etag) {
        logger.info(`editor-bundle.zip: 304 unveraendert (${client}, etag=${etag.slice(0, 12)})`);
        return res.status(304).end();
      }
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="editor-bundle.zip"');
      logger.info(`editor-bundle.zip: ausgeliefert (${client}, ${(buffer.length / 1024).toFixed(0)} KB, etag=${etag.slice(0, 12)})`);
      res.send(buffer);
    } catch (e) { _fail(res, e, 'GET /content/editor-bundle.zip'); }
  });

  // GET /content/macclient-i18n.json — OTA-Override der UI-Strings des nativen
  // macOS-Clients (schreibwerkstatt-focuseditor). Body: { de: {…}, en: {…} },
  // flaches Key→Value je Locale. Der Client liefert dieselben Kataloge gebuendelt
  // mit; dieser Endpunkt erlaubt es, einzelne Keys zentral zu ueberschreiben —
  // fehlende Keys fallen im Client auf den gebuendelten Stand zurueck. SSoT der
  // Server-Overrides: assets/macclient-i18n/{de,en}.json (Details in
  // [lib/macclient-i18n.js](../lib/macclient-i18n.js)).
  //
  // Auth: globaler Guard (server.js) — Session ODER Device-Token, wie alle
  // /content/-Routen. ETag = sha256(Body); bei If-None-Match mit passendem ETag →
  // 304 ohne Body, sodass der Client konditional anfragen kann.
  router.get('/macclient-i18n.json', (req, res) => {
    try {
      const { etag, body } = macclientI18n.getCatalogs();
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
      const client = _clientLabel(req);
      if (req.headers['if-none-match'] === etag) {
        logger.info(`macclient-i18n.json: 304 unveraendert (${client}, etag=${etag.slice(1, 13)})`);
        return res.status(304).end();
      }
      res.set('Content-Type', 'application/json; charset=utf-8');
      logger.info(`macclient-i18n.json: ausgeliefert (${client}, ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB, etag=${etag.slice(1, 13)})`);
      res.send(body);
    } catch (e) { _fail(res, e, 'GET /content/macclient-i18n.json'); }
  });

  // GET /content/macclient/release.json — Installationsweg + freigegebene Version
  // der nativen macOS-App (schreibwerkstatt-focuseditor) fuer das Profil und den
  // Veraltet-Vergleich im Admin-Tab. Body: { storeUrl, available, version, notes,
  // publishedAt, sizeBytes } bzw. { storeUrl, available:false }. Versionsquelle:
  // iTunes-Lookup-API ueber [lib/macclient-release.js](../lib/macclient-release.js)
  // (In-Memory-Cache).
  //
  // `storeUrl` steht IMMER im Body, auch bei available:false — der Mac App Store
  // ist der einzige Installationsweg und darf nicht an einem Ausfall der
  // Lookup-API haengen. Es gibt keinen Direkt-Download und damit keinen
  // Download-Proxy; die Zeile wird nur Eingeloggten *angezeigt* (Anzeige-Gating).
  //
  // Auth: globaler Guard (server.js). ETag = sha256(version + storeUrl) — die
  // Store-URL gehoert hinein, sonst liefert ein 304 einem Client mit altem
  // Cache-Body weiterhin die alte Antwort. Bei If-None-Match mit passendem ETag
  // → 304 ohne Body.
  router.get('/macclient/release.json', async (req, res) => {
    try {
      const rel = { storeUrl: macclientRelease.MAC_APP_STORE_URL, ...(await macclientRelease.getLatestRelease()) };
      const body = JSON.stringify(rel);
      const etag = `"${createHash('sha256').update(`macclient-release:${rel.available ? rel.version : 'none'}:${rel.storeUrl}`).digest('hex')}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.send(body);
    } catch (e) { _fail(res, e, 'GET /content/macclient/release.json'); }
  });

  // GET /content/android/release.json — latest-Release-Metadaten der nativen
  // Android-App (schreibwerkstatt-mobile) fuer den Download-Hinweis im Profil.
  // Body: { available, version, notes, publishedAt, apk:{ name, sizeBytes,
  // downloadUrl } } bzw. { available:false }. Quelle: GitHub-Public-API ueber
  // [lib/androidclient-release.js](../lib/androidclient-release.js) (In-Memory-Cache).
  //
  // Die UI verlinkt direkt auf apk.downloadUrl (GitHub-CDN) — kein Download-Proxy.
  // Da das Client-Repo oeffentlich ist, ist die Asset-URL selbst oeffentlich; der
  // Download wird nur Eingeloggten *angezeigt* (Anzeige-Gating, kein Hard-Gating).
  //
  // Auth: globaler Guard (server.js). ETag = sha256(version); bei If-None-Match
  // mit passendem ETag → 304 ohne Body.
  router.get('/android/release.json', async (req, res) => {
    try {
      const rel = await androidclientRelease.getLatestRelease();
      const body = JSON.stringify(rel);
      const etag = `"${createHash('sha256').update(`androidclient-release:${rel.available ? rel.version : 'none'}`).digest('hex')}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.send(body);
    } catch (e) { _fail(res, e, 'GET /content/android/release.json'); }
  });

  // GET /content/extension/release.json — Installationswege der Chrome-
  // Erweiterung (schreibwerkstatt-browser-extension) fuer das Profil und den
  // Veraltet-Vergleich im Admin-Tab. Body: { storeUrl, available, version,
  // notes, publishedAt, zip:{ name, sizeBytes, downloadUrl } } bzw.
  // { storeUrl, available:false }. Release-Quelle: GitHub-Public-API ueber
  // [lib/extension-release.js](../lib/extension-release.js) (In-Memory-Cache).
  //
  // `storeUrl` steht IMMER im Body, auch bei available:false — der Chrome Web
  // Store ist der regulaere Installationsweg und darf nicht an einem GitHub-
  // Ausfall haengen. Das .zip ist der Zweitweg (Chromium ohne Store-Zugang,
  // Vorabversionen); die UI verlinkt direkt auf zip.downloadUrl — kein Download-
  // Proxy. Da das Repo oeffentlich ist, ist die Asset-URL selbst oeffentlich;
  // der Download wird nur Eingeloggten *angezeigt* (Anzeige-Gating, kein
  // Hard-Gating).
  //
  // Auth: globaler Guard (server.js). ETag = sha256(version + storeUrl) — die
  // Store-URL gehoert hinein, sonst liefert ein 304 einem Client mit altem
  // Cache-Body weiterhin die alte Antwort. Bei If-None-Match mit passendem ETag
  // → 304 ohne Body.
  router.get('/extension/release.json', async (req, res) => {
    try {
      const rel = { storeUrl: extensionRelease.CHROME_STORE_URL, ...(await extensionRelease.getLatestRelease()) };
      const body = JSON.stringify(rel);
      const etag = `"${createHash('sha256').update(`extension-release:${rel.available ? rel.version : 'none'}:${rel.storeUrl}`).digest('hex')}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache'); // immer revalidieren (via If-None-Match)
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.send(body);
    } catch (e) { _fail(res, e, 'GET /content/extension/release.json'); }
  });
}

module.exports = { register };
