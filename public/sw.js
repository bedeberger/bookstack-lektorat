// Service Worker: hält die SPA-Shell offline verfügbar (Zug-Szenario).
// Strategie:
//  - Shell (HTML/CSS/JS/Partials/Icons): Stale-While-Revalidate, Cache-Fallback
//  - Alle anderen Pfade (APIs, Auth, KI, Job-Queue): Network-Only, NIE cachen
//  - Version-Bump via CACHE_VERSION invalidiert alte Caches

const CACHE_VERSION = 'lektorat-shell-v1';
const SHELL_PATH = '/index.html';

// Pfade, die niemals aus dem Cache kommen dürfen (dynamische/auth-pflichtige Daten)
const NEVER_CACHE_PREFIXES = [
  '/auth/',
  '/api/',
  '/claude',
  '/ollama',
  '/llama',
  '/config',
  '/jobs',
  '/history',
  '/figures',
  '/locations',
  '/chat',
  '/sync',
  '/booksettings',
];

const SHELL_ASSET_REGEX = /\.(?:css|js|mjs|svg|ico|png|woff2?)$/i;
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
    const cache = await caches.open(CACHE_VERSION);
    // Einstiegspunkt best-effort vorcachen – scheitert bei Offline-Install lautlos
    try { await cache.add(new Request('/', { cache: 'reload' })); } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;
  if (!isShellRequest(url) && req.mode !== 'navigate') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // Navigations-Request (HTML): immer index.html ausliefern (SPA-Shell)
    if (req.mode === 'navigate') {
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

    // Stale-While-Revalidate für Assets
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
  })());
});
