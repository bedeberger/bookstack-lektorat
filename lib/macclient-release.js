'use strict';
// Der native macOS-Client (Focus-Writer, schreibwerkstatt-focuseditor) wird ueber
// den Mac App Store ausgeliefert. Dieses Modul haelt beides, was die Web-App
// darueber wissen muss: die Store-Adresse und die freigegebene Store-Version
// (Versions-Chip im Profil, „veraltet"-Vergleich im Admin-Geraete-Tab).
//
// MAC_APP_STORE_URL ist SSoT: die Landing liest sie direkt ([routes/public.js]),
// das Profil bekommt sie ueber die release.json-Antwort
// ([routes/content/assets.js]). Sie haengt bewusst NICHT am Versions-Lookup —
// faellt die Lookup-API aus, bleibt der Installationsweg sichtbar (gleiche Regel
// wie CHROME_STORE_URL in [lib/extension-release.js](./extension-release.js)).
//
// Die URL ist absichtlich storefront-neutral (kein /ch/-Pfad): Apple leitet auf
// die Storefront des Besuchers um, ein festgenagelter Laendercode zeigt allen
// anderen den falschen Shop. `mt=12` markiert Mac-Software. Der Lookup dagegen
// fragt eine konkrete Storefront ab (die API braucht eine); die Version ist
// storefront-gleich.
//
// Lookup + Cache: [lib/appstore-lookup.js](./appstore-lookup.js).

const { createAppStoreFetcher } = require('./appstore-lookup');

const APP_STORE_APP_ID = '6797073919';
const MAC_APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_APP_ID}?mt=12`;

module.exports = createAppStoreFetcher({
  appId: APP_STORE_APP_ID,
  country: 'CH',
  logName: 'macclient-release',
});

module.exports.APP_STORE_APP_ID = APP_STORE_APP_ID;
module.exports.MAC_APP_STORE_URL = MAC_APP_STORE_URL;
