'use strict';
// Versions-Leser fuer die im Apple App Store veroeffentlichten Clients dieses
// Projekts. Quelle ist die oeffentliche iTunes-Lookup-API (kein Key, kein Token):
//   https://itunes.apple.com/lookup?id=<appId>&country=<cc>
//
// Sie liefert die *freigegebene* Store-Version — genau die, die ein User
// installieren kann. Darum haengt die Versionsanzeige im Profil und der
// „veraltet"-Vergleich im Admin-Geraete-Tab hier und nicht an einem GitHub-
// Release-Tag: bei Store-Auslieferung gibt es kein Download-Asset mehr, aus
// dessen Vorhandensein sich eine Version ableiten liesse, und eine noch nicht
// freigegebene Version waere ohnehin die falsche Vergleichsgroesse.
//
// Contract ist derselbe wie bei [lib/github-release.js](./github-release.js):
// In-Memory-Cache mit TTL (~10 min), wirft nie, bei Netzfehler bleibt der letzte
// erfolgreiche Cache stehen (sonst { available:false }). Der feste Host braucht
// keinen SSRF-Guard — die URL ist keine User-Eingabe.

const logger = require('../logger');

const TTL_MS = 10 * 60 * 1000; // 10 Minuten
const FETCH_TIMEOUT_MS = 8000;

// Erzeugt einen Store-Versions-Leser fuer eine konkrete App.
//   appId:   numerische Apple-App-ID (ohne "id"-Praefix)
//   country: Storefront-Code der Abfrage. Die Lookup-API braucht eine konkrete
//            Storefront; die Version ist ueber alle Storefronts gleich.
//   logName: Praefix fuer Log-Zeilen
function createAppStoreFetcher({ appId, country, logName }) {
  const API_URL = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`;

  // Letztes erfolgreiches Parse-Ergebnis pro Prozess. Auch ueber die TTL hinaus
  // als Fallback bei Netzfehler aufgehoben.
  let _cache = null;        // { available: true, version, … } | { available: false }
  let _cachedAt = 0;

  function _parseLookup(json) {
    const results = Array.isArray(json?.results) ? json.results : [];
    const app = results.find(r => r && typeof r === 'object');
    if (!app) return { available: false };
    const version = String(app.version || '').replace(/^v/i, '').trim();
    if (!version) return { available: false };
    return {
      available: true,
      version,
      notes: app.releaseNotes || '',
      publishedAt: app.currentVersionReleaseDate || null,
      sizeBytes: Number(app.fileSizeBytes) || 0,
    };
  }

  async function _fetchLatest() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        headers: { 'User-Agent': 'schreibwerkstatt-server', 'Accept': 'application/json' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        logger.warn(`${logName}: App-Store-Lookup antwortete HTTP ${res.status}`);
        return null; // transient — Cache-Fallback
      }
      // Leeres results[] = App (in dieser Storefront) nicht gefunden. Das ist
      // eine gueltige Antwort, kein Fehler: { available:false } wird gecacht.
      return _parseLookup(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  // Liefert die geparste Store-Version oder { available:false }. Wirft nie. Bei
  // transienten Fehlern wird der letzte gueltige Cache zurueckgegeben (sonst
  // { available:false }).
  async function getLatestRelease() {
    const now = Date.now();
    if (_cache && (now - _cachedAt) < TTL_MS) return _cache;

    try {
      const fresh = await _fetchLatest();
      if (fresh) {
        _cache = fresh;
        _cachedAt = now;
        if (fresh.available) {
          logger.info(`${logName}: App-Store-Version = ${fresh.version}${fresh.sizeBytes ? ` (${(fresh.sizeBytes / 1048576).toFixed(1)} MB)` : ''}`);
        } else {
          logger.info(`${logName}: App-Store-Lookup fand die App nicht (id=${appId}, storefront=${country})`);
        }
        return _cache;
      }
      // Transienter Fehler: alten Cache behalten, sonst "nicht verfuegbar".
      return _cache || { available: false };
    } catch (e) {
      logger.warn(`${logName}: App-Store-Lookup fehlgeschlagen (${e.message}); nutze Cache-Fallback`);
      return _cache || { available: false };
    }
  }

  return {
    getLatestRelease,
    _parseLookup, // export fuer Tests
    _resetCache() { _cache = null; _cachedAt = 0; },
  };
}

module.exports = { createAppStoreFetcher };
