// Service Worker: hält die SPA-Shell und BookStack-Inhalte offline verfügbar (Zug-Szenario).
// Strategie:
//  - Shell (HTML/CSS/JS/Partials/Icons): Stale-While-Revalidate im SHELL_CACHE
//  - BookStack-GETs (/api/*): Stale-While-Revalidate im API_CACHE → Navigation + Seiteninhalt offline
//  - Schreibende Requests (PUT/POST/DELETE): nie behandelt (method-Check am Anfang)
//  - Auth/KI/Job-Queue/SSE: Network-Only, nie cachen
//  - Version-Bump der Konstanten invalidiert den jeweiligen Cache

const SHELL_CACHE = 'lektorat-shell-v39';
const API_CACHE = 'lektorat-api-v2';
const CONFIG_CACHE = 'lektorat-config-v1';
const ACTIVE_CACHES = new Set([SHELL_CACHE, API_CACHE, CONFIG_CACHE]);
const SHELL_PATH = '/index.html';
const CONFIG_PATH = '/config';

// Pfade, die niemals aus dem Cache kommen dürfen (dynamische/auth-pflichtige Daten, Streams).
// /api/* und /config sind bewusst NICHT hier – sie haben eigene SWR-Handler.
const NEVER_CACHE_PREFIXES = [
  '/auth/',
  '/claude',
  '/ollama',
  '/llama',
  '/jobs',
  '/history',
  '/figures',
  '/locations',
  '/chat',
  '/sync',
  '/booksettings',
];

const SHELL_ASSET_REGEX = /\.(?:css|js|mjs|json|svg|ico|png|woff2?)$/i;
const PARTIAL_REGEX = /^\/partials\//;

function isShellRequest(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (PARTIAL_REGEX.test(url.pathname)) return true;
  if (SHELL_ASSET_REGEX.test(url.pathname)) return true;
  return false;
}

function isNeverCache(url) {
  return NEVER_CACHE_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/') || url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Einstiegspunkt best-effort vorcachen – scheitert bei Offline-Install lautlos
    try { await cache.add(new Request('/', { cache: 'reload' })); } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !ACTIVE_CACHES.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const net = await fetch(req);
    if (net && net.ok && net.type !== 'opaqueredirect') {
      cache.put(SHELL_PATH, net.clone());
    }
    return net;
  } catch {
    const cached = await cache.match(SHELL_PATH) || await cache.match('/');
    if (cached) return cached;
    return new Response('Offline – Shell nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function handleShellAsset(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response('Offline', { status: 503 });
}

// BookStack-GETs: Stale-While-Revalidate, damit Buch-/Kapitel-/Seitenlisten
// und einzelne Seiteninhalte (/api/pages/:id) offline lesbar bleiben.
// 401/Fehlerantworten werden nicht gecacht, damit Login-Redirects nicht festfrieren.
//
// LRU-Bound: ohne Limit wächst der API-Cache mit jeder besuchten Seite und
// verbraucht auf Long-Running-Sessions zig MB. MAX_API_CACHE_ENTRIES kappt
// nach FIFO (cache.keys() liefert Insertion-Order in allen Browsern, die SW
// unterstützen).
const MAX_API_CACHE_ENTRIES = 200;
async function _evictApiCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_API_CACHE_ENTRIES;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
  }
}
async function handleApi(req) {
  // Bypass-Marker: konsistenzkritische Reads (z.B. Konflikt-Check vor
  // Draft-Push) müssen frische Server-Daten sehen, nicht den SWR-Cache.
  // Sonst matcht ein stale `page.html` mit dem `draft.originalHtml` und
  // ein veralteter Draft überschreibt Server-Stand.
  const url = new URL(req.url);
  if (url.searchParams.has('__fresh')) {
    try { return await fetch(req); }
    catch {
      return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  }
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then(async (res) => {
    if (res && res.ok && res.type !== 'opaqueredirect') {
      await cache.put(req, res.clone());
      await _evictApiCache(cache);
    }
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// /config liefert Session-User + Provider-Config. SWR, damit wiederkehrende
// Offline-User den App-Shell-Bootstrap komplett durchlaufen können. 401/Fehler
// werden nicht gecacht (via res.ok-Check), damit Login-Redirects nicht festfrieren.
async function handleConfig(req) {
  const cache = await caches.open(CONFIG_CACHE);
  const cached = await cache.match(CONFIG_PATH);
  const netPromise = fetch(req).then((res) => {
    if (res && res.ok && res.type !== 'opaqueredirect') cache.put(CONFIG_PATH, res.clone());
    return res;
  }).catch(() => null);

  if (cached) {
    netPromise.catch(() => {});
    return cached;
  }
  const net = await netPromise;
  if (net) return net;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req));
    return;
  }
  if (url.pathname === CONFIG_PATH) {
    event.respondWith(handleConfig(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApi(req));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(handleShellAsset(req));
  }
});
