'use strict';
// Liest das "latest"-GitHub-Release des oeffentlichen Repos der Chrome-
// Erweiterung (bedeberger/schreibwerkstatt-browser-extension), damit die Web-
// App in /me Version + Download-Link der Erweiterung anzeigen kann. Das .zip
// liegt NICHT im Repo, sondern als Release-Asset auf dem GitHub-CDN — die UI
// verlinkt direkt darauf (kein Download-Proxy, Sideload bis zur Aufnahme in
// den Chrome Web Store).
//
// Generischer Fetcher + Cache: [lib/github-release.js](./github-release.js).

const { createReleaseFetcher } = require('./github-release');

module.exports = createReleaseFetcher({
  repo: 'bedeberger/schreibwerkstatt-browser-extension',
  assetExt: '.zip',
  assetKey: 'zip',
  logName: 'extension-release',
});