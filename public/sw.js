// Service Worker: hält die SPA-Shell und Buch-Inhalte offline verfügbar (Zug-Szenario).
// Strategie:
//  - Navigate (/, /index.html): Cache-Only innerhalb der Generation, Netz nur
//    bei kaltem Cache. Der Shell-HTML gehört zum kohärenz-kritischen Satz (s.u.)
//    und wird beim Install mitgecacht. Bewusst KEIN Stale-While-Revalidate —
//    eine Revalidierung schriebe nach einem Deploy das HTML der neuen Generation
//    in den Cache des noch aktiven alten SW und erzeugte damit „neues Markup
//    gegen alte JS-Module".
//    Deploy-Update fliesst über `skip-waiting` + controllerchange-Reload.
//  - Kohärenz-kritische Shell-Assets (App-JS + Partials + App-CSS + i18n +
//    Icon-Sprite): Liste + Content-Hash kommen aus dem generierten
//    /sw-manifest.js (importScripts). Der Install-Handler precacht diesen Satz
//    ATOMAR (cache.addAll). Damit hat jede SW-Generation ihren vollständigen,
//    kohärenten Asset-Satz ab Installationszeitpunkt — ein lazy-gefetchtes
//    Partial oder dynamisch importiertes Modul zieht NIE eine neuere Fassung
//    vom Netz in eine laufende alte Generation (Skew → ReferenceError auf
//    neuen Card-Feldern). Auslieferung: Cache-Only. Ein Miss (iOS evictiert
//    Einzeleinträge) holt bewusst KEINE evtl. neuere Einzeldatei nach, sondern
//    meldet den Clients 'shell-incoherent' → sauberer Reload in eine
//    kohärente Generation; die Netzkopie wird nur als Notnagel ungecacht
//    durchgereicht.
//  - Nicht-kritische Shell-Assets (vendor/*, fonts/*): self-contained,
//    versionsstabil → eigener VENDOR_CACHE (NICHT an SHELL_BUILD gekoppelt),
//    Cache-First mit Netz-Fallback. Da der Cache-Name generationsunabhängig ist,
//    überleben diese ~2.8 MB jeden Deploy, statt bei jedem Generationswechsel
//    neu vom Netz gezogen zu werden (kein Skew auf App-Feldern möglich).
//  - SHELL_CACHE-Name leitet sich aus dem Content-Hash (__SHELL_BUILD) ab:
//    jede Asset-Änderung erzeugt automatisch eine neue Generation — kein
//    manueller Versions-Bump mehr. Regeneriert via `npm run sw:manifest`
//    (läuft auf prestart), Drift gegated durch sw-manifest-drift.test.mjs.
//  - Content-GETs (/content/*): Stale-While-Revalidate im CONTENT_CACHE → Navigation + Seiteninhalt offline
//  - Schreibende Requests (PUT/POST/DELETE): nie behandelt (method-Check am Anfang)
//  - Auth/KI/Job-Queue/SSE: Network-Only, nie cachen

// Generierte Manifest-/Build-Konstanten (self.__SHELL_BUILD, self.__SHELL_MANIFEST).
// Wird mit der SW-Registrierung persistiert → auch beim Offline-Start verfügbar.
// updateViaCache:'none' (Registrierung in app.js) erzwingt frische Revalidierung
// dieser Importe beim Update-Check, sodass ein neuer Build zuverlässig erkannt wird.
importScripts('/sw-manifest.js');

const SHELL_BUILD = self.__SHELL_BUILD || 'dev';
const SHELL_MANIFEST = Array.isArray(self.__SHELL_MANIFEST) ? self.__SHELL_MANIFEST : [];
const MANIFEST_SET = new Set(SHELL_MANIFEST);
const SHELL_CACHE = 'schreibwerkstatt-shell-' + SHELL_BUILD;
const CONTENT_CACHE = 'schreibwerkstatt-content-v1';
const CONFIG_CACHE = 'schreibwerkstatt-config-v2';
// Versionsstabile Assets (vendor/*, fonts/*) leben generationsunabhängig hier,
// damit sie nicht bei jedem Deploy mit dem SHELL_CACHE weggeworfen werden.
const VENDOR_CACHE = 'schreibwerkstatt-vendor-v1';
const ACTIVE_CACHES = new Set([SHELL_CACHE, CONTENT_CACHE, CONFIG_CACHE, VENDOR_CACHE]);
const SHELL_PATH = '/index.html';
const CONFIG_PATH = '/config';

// Pfade, die niemals aus dem Cache kommen dürfen (dynamische/auth-pflichtige Daten, Streams).
// /content/* und /config sind bewusst NICHT hier – sie haben eigene SWR-Handler.
const NEVER_CACHE_PREFIXES = [
  '/auth/',
  '/jobs',
  '/history',
  '/figures',
  '/locations',
  '/chat',
  '/sync',
  '/booksettings',
  '/publication',
  '/ideen',
  '/research',
  '/book-editor',
  '/search',
  '/share',
];

const SHELL_ASSET_REGEX = /\.(?:css|js|mjs|json|svg|ico|png|woff2?)$/i;
const PARTIAL_REGEX = /^\/partials\//;
const VERSION_STABLE_REGEX = /^\/(?:vendor|fonts)\//;

// /js/plausible-init.js wird vom Server dynamisch aus app_settings gerendert
// (Plausible an/aus + URL). Niemals cachen, sonst greift Admin-Toggle nicht
// ohne Hard-Reload + SW-Invalidate.
const PLAUSIBLE_INIT_PATH = '/js/plausible-init.js';

function isShellRequest(url) {
  if (url.pathname === '/' || url.pathname === '/index.html') return true;
  if (url.pathname === PLAUSIBLE_INIT_PATH) return false;
  if (PARTIAL_REGEX.test(url.pathname)) return true;
  if (SHELL_ASSET_REGEX.test(url.pathname)) return true;
  return false;
}

function isNeverCache(url) {
  // Exakter Pfad oder echter Unterpfad (mit Slash). Kein nackter Prefix-Match —
  // sonst würde z.B. `/searchbar` fälschlich als `/search` gewertet.
  return NEVER_CACHE_PREFIXES.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
}

// Atomarer Precache mit Backoff-Retry. `cache.addAll` ist all-or-nothing: ein
// einziger fehlgeschlagener von ~480 Requests rejectet den ganzen Satz und
// committet nichts (kein halb gefüllter Cache). Genau im schlechten Netz (= das
// Zielszenario) reicht ein transienter Fehler, um ein Update nie zu installieren.
// Darum mehrere Versuche mit wachsender Pause; bleibt es nach `attempts` beim
// Fehler, propagiert der letzte Error und der Install scheitert sauber — der alte
// SW bedient seinen eigenen, kohärenten Satz unverändert weiter.
async function precacheWithRetry(cache, paths, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await cache.addAll(paths.map(p => new Request(p, { cache: 'reload' })));
      return;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Den VOLLSTÄNDIGEN kohärenz-kritischen Asset-Satz dieser Generation ATOMAR
    // vorcachen: App-JS + Partials + App-CSS + i18n + Icon-Sprite. So zieht zur
    // Laufzeit nie ein lazy-gefetchtes Partial / dynamisch importiertes Modul eine
    // fremde Generation vom Netz. `cache: 'reload'` umgeht den HTTP-Cache, damit
    // der Precache wirklich diese Generation holt.
    await precacheWithRetry(cache, SHELL_MANIFEST);
    // Einstiegspunkt (SPA-Shell) best-effort dazu — nicht im Manifest, weil er
    // unter zwei Schlüsseln adressiert wird ('/' bei Navigation, SHELL_PATH beim
    // Lookup); offline-Install scheitert hier lautlos. Unter BEIDEN Schlüsseln
    // ablegen, damit der Lookup in handleNavigate deterministisch die Kopie
    // DIESER Generation trifft. `ok`/`opaqueredirect`-Check statt `cache.add`:
    // fällt die Session beim Install gerade aus, antwortet `/` mit einem
    // Login-Redirect — der darf nie als SPA-Shell im Cache landen.
    try {
      const shellRes = await fetch(new Request('/', { cache: 'reload' }));
      if (shellRes && shellRes.ok && shellRes.type !== 'opaqueredirect') {
        await cache.put(SHELL_PATH, shellRes.clone());
        await cache.put('/', shellRes.clone());
      }
    } catch {}
    // Bewusst KEIN skipWaiting hier: der neue SW bleibt `waiting`, bis der
    // User das Update-Banner klickt (applyUpdate → 'skip-waiting'-Message).
    // Sonst übernähme der neue SW eine laufende (Editor-)Seite sofort und
    // bediente Partials/Assets der neuen Generation gegen die noch im Speicher
    // laufenden ALTEN JS-Module → Skew (z.B. ReferenceError auf neu
    // hinzugefügten Card-State-Feldern, die das alte Modul nicht kennt).
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !ACTIVE_CACHES.has(k)).map(k => caches.delete(k)));
    // Kein clients.claim(): laufende Tabs behalten den alten SW (= alte
    // Partials + alte Module, kohärent), bis sie via Banner/Reload wechseln.
    // Activate läuft ohnehin erst nach 'skip-waiting', also nach User-Klick.
  })());
});

// Navigate (HTML-Shell): Cache-Only innerhalb der Generation, mit Netz-Fallback
// nur bei kaltem Cache. Der Shell-HTML gehört zum kohärenz-kritischen Satz wie
// jedes Modul und Partial — er wird beim Install dieser Generation gecacht und
// danach unverändert ausgeliefert.
//
// KEIN Stale-While-Revalidate: eine Revalidierung würde das HTML vom Netz in den
// SHELL_CACHE schreiben. Nach einem Deploy ist das aber das HTML der NEUEN
// Generation, während der noch aktive ALTE SW (kein skipWaiting) jedes Modul,
// Partial und CSS weiter cache-only aus SEINER Generation bedient. Die nächste
// Navigation liefert dann neues Markup gegen alte JS-Module — genau der Skew,
// den der atomare Cache-Only-Satz verhindern soll (Alpine-Expressions greifen
// auf Stores/Karten zu, die das geladene app.js nicht registriert). Ein Login ist
// dafür der typische Auslöser, weil er mehrere echte Navigationen hintereinander
// macht: die erste schreibt das fremde HTML in den Cache, die zweite serviert es.
// Deploy-Updates laufen ausschliesslich über `skip-waiting` + controllerchange-
// Reload in die neu precachte, kohärente Generation.
//
// Innerhalb einer Generation ist das HTML ohnehin unveränderlich: seine Bytes
// gehen in __SHELL_BUILD ein (scripts/sw-manifest.js), jede Änderung erzeugt also
// eine neue Generation samt neuem Precache.
async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_PATH) || await cache.match('/');
  if (cached) return cached;

  // Kalter Cache: der Install-Precache der Shell ist best-effort und kann
  // scheitern (offline installiert, Session-Redirect). Hier einmalig aus dem Netz
  // füllen — kein Skew-Risiko, denn es gibt keine gecachte Generation, die
  // überschrieben würde, und genau dieses HTML wird gerendert.
  try {
    const net = await fetch(req);
    if (net && net.ok && net.type !== 'opaqueredirect') cache.put(SHELL_PATH, net.clone());
    return net;
  } catch {
    return new Response('Offline – Shell nicht im Cache.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// Meldet allen kontrollierten Tabs, dass der kohärente Asset-Satz dieser
// Generation Lücken hat (Einzel-Eviction). Der Client triggert daraufhin den
// regulären Update-/Reload-Pfad (Banner falls Editor dirty, sonst Reload) und
// bootet in eine frisch precachte, kohärente Generation.
async function notifyIncoherent(pathname) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: false });
    for (const c of clients) c.postMessage({ type: 'shell-incoherent', path: pathname });
  } catch {}
}

// Kohärenz-kritische Shell-Assets (App-JS/Partials/CSS/i18n/Icons): Cache-Only.
// Der Satz wurde beim Install atomar precacht → ein Hit ist garantiert kohärent.
// Ein Miss bedeutet Einzel-Eviction (v.a. iOS). Dann NICHT die evtl. neuere
// Einzeldatei vom Netz nachladen (das wäre exakt der Skew, den wir verhindern),
// sondern die Clients zum sauberen Reload anstossen. Die Netzkopie wird nur als
// Notnagel ungecacht durchgereicht, damit der laufende Fetch nicht hängt; der
// Reload stellt sofort wieder Kohärenz her. Offline → 503.
//
// Nicht-kritische Shell-Assets (vendor/*, fonts/*): self-contained und
// versionsstabil, kein Skew auf App-Feldern möglich → klassisch Cache-First mit
// Netz-Fallback (lazy nachladbar, auch nach Eviction).
async function handleShellAsset(req, url) {
  // Versionsstabile Assets (vendor/*, fonts/*) liegen im generationsunabhängigen
  // VENDOR_CACHE → ein Hit überlebt jeden Deploy, kein erneuter Netz-Fetch beim
  // Generationswechsel. Kein Skew möglich (self-contained, kein App-Feld-Bezug).
  if (VERSION_STABLE_REGEX.test(url.pathname)) {
    const vcache = await caches.open(VENDOR_CACHE);
    const vhit = await vcache.match(req);
    if (vhit) return vhit;
    try {
      const net = await fetch(req);
      if (net && net.ok) vcache.put(req, net.clone());
      return net;
    } catch {
      return new Response('Offline', { status: 503 });
    }
  }

  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;

  if (MANIFEST_SET.has(url.pathname)) {
    // Query-versionierte Shell-Assets (z.B. /icons.svg?v=NNN) sind unter ihrem
    // query-losen Pfad precacht. ignoreSearch matcht die precachte Generation,
    // statt bei jedem ?v= einen ungecachten Netz-Fetch zu erzwingen (offline →
    // Icon-Sprite nicht ladbar → alle Icons weg). Die Generation ist trotzdem
    // kohärent: Ändert sich der Sprite-Inhalt, verschiebt sich __SHELL_BUILD und
    // die ganze Generation wird neu precacht.
    const ignoreSearchHit = await cache.match(req, { ignoreSearch: true });
    if (ignoreSearchHit) return ignoreSearchHit;
    notifyIncoherent(url.pathname);
    try {
      return await fetch(req); // Notnagel, bewusst NICHT in diese Generation cachen
    } catch {
      return new Response('Offline', { status: 503 });
    }
  }

  try {
    const net = await fetch(req);
    if (net && net.ok) cache.put(req, net.clone());
    return net;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Content-GETs: Stale-While-Revalidate, damit Buch-/Kapitel-/Seitenlisten
// und einzelne Seiteninhalte (/content/pages/:id) offline lesbar bleiben.
// 401/Fehlerantworten werden nicht gecacht, damit Login-Redirects nicht festfrieren.
//
// LRU-Bound: ohne Limit wächst der Cache mit jeder besuchten Seite und
// verbraucht auf Long-Running-Sessions zig MB. MAX_CONTENT_CACHE_ENTRIES kappt
// nach FIFO (cache.keys() liefert Insertion-Order in allen Browsern, die SW
// unterstützen).
const MAX_CONTENT_CACHE_ENTRIES = 200;
async function _evictContentCache(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_CONTENT_CACHE_ENTRIES;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) await cache.delete(keys[i]);
  }
}
async function _handleSwr(req, cacheName) {
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
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const netPromise = fetch(req).then(async (res) => {
    if (res && res.ok && res.type !== 'opaqueredirect') {
      await cache.put(req, res.clone());
      await _evictContentCache(cache);
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

function handleContent(req) { return _handleSwr(req, CONTENT_CACHE); }

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

// Logout aus dem Client: API+Config-Caches dropen, sonst rendert die SPA nach
// `/auth/logout` kurz noch gecachte Seiten/Configs des alten Users.
// Update-Anstoss: 'skip-waiting' aktiviert den wartenden SW sofort. Erst danach
// feuert `controllerchange` im Client, der dann ein einmaliges location.reload()
// macht.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === 'auth-logout') {
    event.waitUntil((async () => {
      await Promise.all([
        caches.delete(CONTENT_CACHE),
        caches.delete(CONFIG_CACHE),
      ]);
      event.source?.postMessage?.({ type: 'auth-logout-done' });
    })());
  }
  // Invalidiert CONTENT_CACHE-Einträge nach Writes. Ohne diesen Bust liefert SWR
  // nach einem PUT weiterhin die alte Fassung beim nächsten GET — und ein
  // Read-Modify-Write-Pfad (Lektorat-Save, Chat-Vorschlag) überschreibt damit
  // frische User-Edits mit Stale-Daten. paths sind /content/*-Subpfade
  // ohne `/content/`-Prefix.
  if (event.data?.type === 'invalidate-content') {
    const paths = Array.isArray(event.data.paths) ? event.data.paths : [];
    event.waitUntil(_invalidateCacheEntries(CONTENT_CACHE, paths, '/content/'));
  }
});

async function _invalidateCacheEntries(cacheName, paths, prefix) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const targets = new Set(paths.map(p => prefix + p));
  for (const k of keys) {
    try {
      const u = new URL(k.url);
      if (targets.has(u.pathname)) await cache.delete(k);
    } catch {}
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return;

  if (req.mode === 'navigate') {
    // Nur die SPA-Shell selbst (/ bzw. /index.html) ist eine Shell-Navigation.
    // Server-gerenderte Public-Seiten (/datenschutz, /register, /landing, /privacy)
    // sind ebenfalls navigate-Requests, dürfen aber NIE durch handleNavigate
    // laufen: das würde ihre Antwort unter SHELL_PATH cachen und den nächsten
    // SPA-Load mit der falschen Seite (z.B. der Datenschutzerklärung) bedienen.
    // Diese Pfade gehen unbehandelt ans Netz.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      event.respondWith(handleNavigate(req));
    }
    return;
  }
  if (url.pathname === CONFIG_PATH) {
    event.respondWith(handleConfig(req));
    return;
  }
  if (url.pathname.startsWith('/content/')) {
    event.respondWith(handleContent(req));
    return;
  }
  if (isShellRequest(url)) {
    event.respondWith(handleShellAsset(req, url));
  }
});
