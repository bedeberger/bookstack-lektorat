'use strict';
// Liest das "latest"-GitHub-Release des oeffentlichen Repos der Chrome-
// Erweiterung (bedeberger/schreibwerkstatt-browser-extension), damit die Web-
// App in /me Version + ZIP-Link der Erweiterung anzeigen kann. Das .zip liegt
// NICHT im Repo, sondern als Release-Asset auf dem GitHub-CDN — die UI verlinkt
// direkt darauf (kein Download-Proxy).
//
// Der regulaere Installationsweg ist der Chrome Web Store (CHROME_STORE_URL);
// das ZIP ist der Zweitweg fuer Chromium-Browser ohne Store-Zugang und fuer
// Vorabversionen. Die Store-URL ist hier SSoT: Landing ([routes/public.js])
// liest sie direkt, das Profil bekommt sie ueber die release.json-Antwort
// ([routes/content/assets.js]) — sie haengt bewusst NICHT am GitHub-Fetch, sonst
// verschwaende ein GitHub-Ausfall den primaeren Installationsweg.
//
// Generischer Fetcher + Cache: [lib/github-release.js](./github-release.js).

const { createReleaseFetcher } = require('./github-release');

const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/kbekgjommnbkibdpdpdiaokcpnpiopdo';

module.exports = createReleaseFetcher({
  repo: 'bedeberger/schreibwerkstatt-browser-extension',
  assetExt: '.zip',
  assetKey: 'zip',
  logName: 'extension-release',
});

module.exports.CHROME_STORE_URL = CHROME_STORE_URL;