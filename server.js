require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { runWithContext, setContext } = require('./lib/log-context');

// DB-Setup + Migrationen laufen beim Import
const { db, cleanupStuckJobRuns, pruneStaleByAge } = require('./db/schema');
const appUsers = require('./db/app-users');
const { tryDeviceAuth, extractBearer } = require('./lib/device-auth');
const { deviceScopeGate } = require('./lib/device-scopes');
const deviceTokens = require('./db/device-tokens');
const bookAccess = require('./db/book-access');
const { ensureAdminFromEnv, touchUserLastSeen, addUserActivity } = appUsers;
const appSettings = require('./lib/app-settings');
const { getVersion } = require('./lib/version');

// Admin-Bootstrap: ADMIN_EMAIL aus ENV → app_users-Row mit
// global_role='admin'. Idempotent + ENV-Wechsel-tauglich (kein Restart-Zwang).
try {
  const r = ensureAdminFromEnv();
  if (r && r.action !== 'exists') logger.info(`ADMIN_EMAIL ${r.email}: ${r.action}`);
} catch (e) {
  logger.warn(`ensureAdminFromEnv: ${e.message}`);
}

// Settings-Bootstrap: ENV-Werte einmalig in app_settings spiegeln,
// solange noch keine DB-Row existiert. Idempotent — bestehende DB-Werte
// werden nicht ueberschrieben.
try { appSettings.bootstrapFromEnv(); }
catch (e) { logger.warn(`app-settings.bootstrapFromEnv: ${e.message}`); }

// Devmode-Seed: nur bei LOCAL_DEV_MODE + app.backend='localdb' und
// leerer books-Tabelle. Idempotent durch COUNT-Check.
try {
  const { runDevSeedIfNeeded } = require('./lib/dev-seed');
  runDevSeedIfNeeded();
} catch (e) { logger.warn(`runDevSeedIfNeeded: ${e.message}`); }

// Demo-Zugang-Bootstrap (nur wenn DEMO_EMAIL + DEMO_PASSWORD gesetzt sind):
// app_users-Row + fixe Device-Tokens aus ENV. Muss beim BOOT laufen und nicht
// erst beim ersten Login — die nativen Clients und die Browser-Erweiterung
// authentisieren per Bearer-Token und rufen die Login-Seite nie auf. Idempotent.
// Details + Betriebsregeln: lib/demo-user.js.
try {
  const demoUser = require('./lib/demo-user');
  if (demoUser.isEnabled()) {
    demoUser.ensureDemoAccess();
    // Beispielbuch asynchron nachziehen (Content-Store ist async), damit auch ein
    // Reviewer, der ausschliesslich im nativen Client arbeitet, Inhalt sieht.
    setImmediate(() => {
      demoUser.seedDemoContent(demoUser.demoEmail()).catch(() => {});
    });
  }
} catch (e) { logger.warn(`demo-user.ensureDemoAccess: ${e.message}`); }

// Initial-Reindex der FTS5-Tabellen, wenn die Marker-Row gesetzt ist.
// In setImmediate, damit Boot nicht blockiert.
setImmediate(() => {
  try {
    const searchIndex = require('./lib/search');
    searchIndex.reindexIfNeeded();
  } catch (e) { logger.warn(`searchIndex.reindexIfNeeded: ${e.message}`); }
});

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const figuresAlterRouter = require('./routes/figures-alter');
const locationsRouter = require('./routes/locations');
const songsRouter = require('./routes/songs');
const { router: jobsRouter, runKomplettAnalyseAll } = require('./routes/jobs');
const { reindexAllBooks } = require('./routes/jobs/embed-index');
const { reindexAllUserSources } = require('./routes/jobs/source-embed-index');
const { reindexAllXrefs } = require('./lib/xref-index');
const { scanAllBooks: scanAllMotifs } = require('./routes/jobs/motif-scan');
const { anchorAllBooks: anchorAllBeats } = require('./routes/jobs/beat-anchor');
const { scanAllBooks: scanAllLexicons } = require('./routes/jobs/lexicon-scan');
const chatRouter = require('./routes/chat');
const ideenRouter = require('./routes/ideen');
const researchRouter = require('./routes/research');
const sourcesRouter = require('./routes/sources');
const xrefsRouter = require('./routes/xrefs');
const plotRouter = require('./routes/plot');
const motifsRouter = require('./routes/motifs');
const bookSettingsRouter = require('./routes/booksettings');
const userSettingsRouter = require('./routes/usersettings');
const { router: proxiesRouter } = require('./routes/proxies');
const { router: syncRouter, syncAllBooks } = require('./routes/sync');
const { runCacheCleanup } = require('./lib/cache-cleanup');
const exportRouter = require('./routes/export');
const bookMigrationRouter = require('./routes/book-migration');
const pdfExportRouter = require('./routes/pdf-export');
const usageRouter = require('./routes/usage');
const { router: draftFiguresRouter } = require('./routes/draft-figures');
const contentRouter = require('./routes/content');
const snapshotsRouter = require('./routes/snapshots');
const shareRouter = require('./routes/share');

const PORT = process.env.PORT || 3737;
const app = express();

// Hinter einem Reverse-Proxy (NGINX, NPM, Traefik …) echte Client-IP
// und req.secure korrekt auswerten lassen.
app.set('trust proxy', 1);
// CSP: alle Skripte/Styles/Fonts self-hosted (vendor/ + js/ + css/ + fonts/).
// 'unsafe-eval' ist Pflicht für Alpine.js v3 (kompiliert Direktiven dynamisch).
// 'unsafe-inline' bei style-src ist nötig, weil Alpine `:style` zur Laufzeit
// inline-style-Attribute setzt (z.B. progress-bar via --progress).
// img-src deckt data:/blob: für Generated Charts/Graphs plus
// *.googleusercontent.com für Google-Profilbilder im Avatar-Menü plus
// *.tile.openstreetmap.org für die Leaflet-Karte der Schauplätze plus den
// Host eines self-hosted Tile-Servers (geocode.tiles.url), zur Laufzeit ergänzt.
// connect-src 'self' deckt alle XHR/SSE-Endpunkte (Server proxy'd Anthropic +
// Ollama; Storage geht ueber /content/*); Plausible-Origin wird zur Laufzeit
// aus app_settings ergänzt, falls Analytics aktiv ist.
function plausibleOriginFromSettings() {
  if (!appSettings.get('analytics.plausible.enabled')) return '';
  const url = String(appSettings.get('analytics.plausible.script_url') || '').trim();
  if (!url) return '';
  try { return new URL(url).origin; }
  catch { return ''; }
}

// CSP-img-src-Quelle aus der konfigurierten Tile-Server-URL (geocode.tiles.url).
// Leaflet laedt die Kacheln direkt im Browser, also muss der Host im img-src
// stehen. Das {s}-Subdomain-Token wird zum Wildcard-Host (https://*.host); ohne
// {s} liefert die Origin den exakten Host:Port. Leer/ungueltig → kein Eintrag.
function tileImgSrcFromSettings() {
  const tpl = String(appSettings.get('geocode.tiles.url') || '').trim();
  if (!tpl) return '';
  const hasSub = tpl.includes('{s}');
  try {
    const probe = tpl.replace('{s}', 'a').replace(/\{[zxy]\}/g, '0');
    const u = new URL(probe);
    return hasSub ? `${u.protocol}//*.${u.host.replace(/^a\./, '')}` : u.origin;
  } catch { return ''; }
}

function buildCspHeader() {
  const plausible = plausibleOriginFromSettings();
  const tileSrc    = tileImgSrcFromSettings();
  const scriptSrc  = ["'self'", "'unsafe-eval'", ...(plausible ? [plausible] : [])];
  const styleSrc   = ["'self'", "'unsafe-inline'"];
  const imgSrc     = ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com', 'https://*.tile.openstreetmap.org', ...(tileSrc ? [tileSrc] : [])];
  const fontSrc    = ["'self'"];
  const connectSrc = ["'self'", ...(plausible ? [plausible] : [])];
  const frameSrc   = ["'self'"];
  const dir = {
    'default-src':  ["'self'"],
    'script-src':   scriptSrc,
    'style-src':    styleSrc,
    'img-src':      imgSrc,
    'font-src':     fontSrc,
    // TTS / Proof-Listening: das synthetisierte Audio kommt vom /tts/speak-Proxy
    // (same-origin) und wird als blob:-Object-URL abgespielt.
    'media-src':    ["'self'", 'blob:'],
    'connect-src':  connectSrc,
    'frame-src':    frameSrc,
    // ALTCHA loest das PoW in einem Blob-Web-Worker.
    'worker-src':   ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src':   ["'none'"],
    'base-uri':     ["'self'"],
    'frame-ancestors': ["'self'"],
    'form-action':  ["'self'"],
  };
  return Object.entries(dir).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

// CSP-Cache: rebuild bei app_settings 'changed'-Event.
let _cspHeader = buildCspHeader();
appSettings.on('changed', (evt) => {
  if (!evt || !evt.key) return;
  if (evt.key === 'analytics.plausible.enabled' || evt.key === 'analytics.plausible.script_url'
      || evt.key === 'geocode.tiles.url') {
    _cspHeader = buildCspHeader();
  }
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', _cspHeader);
  next();
});

// gzip aktiv, aber SSE-Streams (text/event-stream) und Responses mit
// `x-no-compression` ausgenommen — Kompression würde Stream-Chunks bis zum
// Buffer-Flush zurückhalten und Live-Updates blockieren.
app.use(compression({
  filter(req, res) {
    if (req.headers['x-no-compression']) return false;
    const ct = res.getHeader('Content-Type');
    if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// ── Session ──────────────────────────────────────────────────────────────────
const LOCAL_DEV_MODE = process.env.LOCAL_DEV_MODE === 'true';

// Secret-Policy:
//   Production → SESSION_SECRET ist Pflicht (sonst Exit).
//   Dev-Mode   → falls nicht gesetzt, ein prozesslokaler Zufallsstring (Sessions
//                 gehen beim Restart verloren; keine deterministische Default-Konstante).
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (LOCAL_DEV_MODE) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    process.env.SESSION_SECRET = sessionSecret;
    logger.warn('SESSION_SECRET nicht gesetzt – zufälliges Dev-Secret generiert (Sessions überleben Restart nicht).');
  } else {
    logger.error('SESSION_SECRET nicht gesetzt – Server wird gestoppt. Bitte in .env setzen.');
    process.exit(1);
  }
}

const sessionStore = new SqliteStore({
  client: db,
  expired: { clear: true, intervalMs: 15 * 60 * 1000 }, // alle 15 min abgelaufene Sessions löschen
});
// Index auf expire — Store-GC scannt `WHERE datetime('now') > datetime(expire)`.
db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)').run();

app.use(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
    // `'auto'` leitet `secure` aus `req.secure` ab — funktioniert dank
    // `app.set('trust proxy', 1)` hinter NGINX/Traefik via `X-Forwarded-Proto`.
    // Eliminiert die Abhängigkeit zu APP_URL beim Boot (jetzt in app_settings).
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
  },
}));

if (LOCAL_DEV_MODE) {
  logger.warn('LOCAL_DEV_MODE aktiv – OAuth wird übersprungen, automatische Dev-Session!');
}

// ALS-Logging-Context: jeder logger.*-Call innerhalb des Request-Scopes erbt
// scope/user automatisch. Selbst silent — eigentliches Page-Load-Logging
// passiert weiter unten kurz vor staticServe.
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', reqId);
  runWithContext({
    job: 'http',
    user: req.session?.user?.email || null,
  }, () => next());
});

// ── Auth-Routen (öffentlich) ──────────────────────────────────────────────────
app.use(authRouter);

// ── Public-Routen (vor Auth-Guard) ───────────────────────────────────────────
// /landing, /register (GET+POST) und Unauth-Override fuer GET /. Eingeloggte
// und LOCAL_DEV_MODE laufen ueber `next()` weiter — Guard + staticServe
// liefern dann die SPA-Shell.
app.use(require('./routes/public'));

// /share/:token Reader-View + POST /share/:token/comment sind oeffentlich.
// Owner-API-Routen /share/api/* sind hingegen auth-pflichtig — die Auth-
// Routinen pruefen die Session selbst (requireSession-Mw).
app.use('/share', shareRouter);

// Plausible-Bootstrap dynamisch rendern: enabled+URL aus app_settings.
// Disabled oder leere URL → no-op JS (kein Tracking, keine Console-Error).
// Admin-Toggle ist die einzige Aktivierungs-Bedingung — keine Host-/Env-Filter.
// Vor dem Auth-Guard, damit Landing/Login/Register das Script ebenfalls laden.
// Cache-Control: no-store, damit Toggle ohne Browser-Reload-Hack greift.
app.get('/js/plausible-init.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const enabled = !!appSettings.get('analytics.plausible.enabled');
  const scriptUrl = String(appSettings.get('analytics.plausible.script_url') || '').trim();
  if (!enabled || !scriptUrl) {
    return res.send('/* plausible disabled */\n');
  }
  const safeUrl = JSON.stringify(scriptUrl);
  res.send(
    `// Plausible-Bootstrap. URL aus Admin-Settings (analytics.plausible.script_url).\n` +
    `(function () {\n` +
    `  var s = document.createElement('script');\n` +
    `  s.async = true;\n` +
    `  s.src = ${safeUrl};\n` +
    `  document.head.appendChild(s);\n` +
    `  window.plausible = window.plausible || function () { (plausible.q = plausible.q || []).push(arguments); };\n` +
    `  plausible.init = plausible.init || function (i) { plausible.o = i || {}; };\n` +
    `  plausible.init({ hashBasedRouting: true });\n` +
    `})();\n`
  );
});

// ── Öffentliche PWA-Assets (vor Auth-Guard) ──────────────────────────────────
// Browser holen manifest.webmanifest und sw.js ohne Credentials; hinter dem
// Auth-Guard würde das in einen Google-OIDC-Redirect laufen und CORS-Fehler werfen.
const PUBLIC_ASSETS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/schreibwerkstatt_icon.svg',
  // Lucide-Icon-Sprite: der Share-Reader-Vorlese-Dock (share-reader/tts.js)
  // referenziert Icons via <use href="/icons.svg#…">. Ohne Freigabe landet der
  // Request des ANONYMEN Lesers im Auth-Guard, kommt als HTML zurueck und der
  // <use>-Verweis loest nie auf → die Dock-Icons bleiben unsichtbar.
  '/icons.svg',
  '/schreibwerkstatt_icon.ico',
  '/favicon.ico',
  // Asset-Liste + Content-Hash des Service Workers. sw.js zieht die Datei als
  // ERSTES per importScripts — sie ist damit genauso pre-auth-pflichtig wie der
  // SW selbst. Faellt die Session aus, kaeme sonst Login-HTML zurueck und die
  // SW-Auswertung scheiterte an nosniff.
  '/sw-manifest.js',
  // ALTCHA-PoW-Widget (Custom-Element): von register.html + /login per
  // dynamic `<script type="module">` nachgeladen, sobald ALTCHA aktiv ist.
  '/vendor/altcha-3.0.11.min.js',
  // mermaid: share-reader/diagrams.js laedt die Lib nach, wenn der geteilte Text
  // einen `pre.mermaid` enthaelt. Ohne Freigabe bekaeme der ANONYME Leser die
  // Login-HTML statt des Skripts und saehe statt des Diagramms dessen Quelltext.
  // Einzelfreigabe statt eines `/vendor/`-Prefix: der Reader braucht genau diese
  // eine Datei, alle uebrigen Vendor-Libs gehoeren hinter den Auth-Guard.
  '/vendor/mermaid-11.16.0.min.js',
]);
// Pre-auth-erlaubte Prefixes: landing.html + register.html ziehen /css/tokens.css
// + /css/landing.css (+ deren @import-Sub-Tokens) und Variable-Fonts aus /fonts/.
// Ohne diese Freigabe landen die Requests im Auth-Guard und werden als HTML
// (`/login?returnTo=...`) zurückgegeben → Browser verweigert das Stylesheet wegen
// falschem MIME-Type.
//
// /js/ steht aus demselben Grund vollstaendig offen, und zwar fuer BEIDE Seiten:
//  - Der anonyme Leser braucht den kompletten Share-Reader-Modulgraph
//    (/js/share-reader/* plus die geteilten Module share-anchor, avatar,
//    scroll-fade, comment-card-layout, tts-segment, editor/comment-threads) sowie
//    die Skripte der Pre-Auth-Seiten (credential-login, register, share-theme-init).
//  - Der EINGELOGGTE User braucht ihn, weil der Service Worker die Shell
//    cache-only bedient: ein einzelner evictierter Eintrag (v.a. iOS) geht als
//    Notnagel ans Netz, und faellt in genau diesem Moment die Session aus, kam
//    frueher ein 302 auf /login zurueck. Fuer `<script type="module">` und
//    `<link rel="modulepreload">` heisst das: HTML statt JS, nosniff verweigert
//    das Modul, die App bootet nicht — sichtbar nur als "SCRIPT/LINK nicht
//    ladbar" im Fehler-Log. Client-Code ist kein Geheimnis (Stylesheets stehen
//    seit je offen), deshalb faellt die Gate-Ebene hier weg statt die Fehlerlage
//    ehrlicher zu machen.
// Ausnahme bleibt /js/plausible-init.js: die Route davor rendert es aus
// app_settings und greift zuerst.
//
// Das entbindet den Reader NICHT von seiner Import-Disziplin — er darf weiterhin
// nur aus /js/share-reader/ importieren (Kopplung + Bundle-Groesse), gegated
// durch block-sel-consolidation/cite-guard-drift/mermaid-drift.
const PUBLIC_ASSET_PREFIXES = ['/css/', '/fonts/', '/js/'];
// Statische Assets: `no-cache` für alles ausser Bildern. ETag bleibt aktiv —
// Browser revalidiert bei jedem Reload mit If-None-Match (304 wenn unverändert,
// nur Header-Roundtrip, keine Bytes). Bilder/Icons halten 7 Tage, weil sie sich
// praktisch nie ändern.
const staticServe = express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // Positiv-Marker der SPA-Shell fuer den Service Worker. Er ist noetig, weil
    // `GET /` unter EINER URL zwei verschiedene Dokumente liefert: eingeloggt
    // die Shell (dieses index.html), anonym die Landing-Seite (routes/public.js)
    // — beide mit 200. Ein URL-Cache kann die zwei nicht auseinanderhalten;
    // ohne Marker legt der SW bei abgelaufener Session die Landing-Seite als
    // Shell ab und bedient sie danach cache-only weiter (nur Hard-Refresh
    // kommt daran vorbei). Der SW cacht und serviert `/` nur mit diesem Header,
    // siehe public/sw.js#isShellResponse.
    if (/(?:^|[\\/])index\.html$/i.test(filePath)) {
      res.setHeader('X-App-Shell', '1');
    }
    // sw.js darf nie HTTP-gecached werden, sonst frieren Clients auf alter
    // Service-Worker-Version fest und sehen Asset-Updates nicht.
    if (/(?:^|[\\/])sw\.js$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      // SVG-Sprites zählen als Code (Icon-Set wird editiert) — wie JS/CSS via
      // ETag revalidieren, sonst halten Browser bis zu 7 Tage alte Versionen.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});
app.use((req, res, next) => {
  if (req.method === 'GET' && (
    PUBLIC_ASSETS.has(req.path) ||
    PUBLIC_ASSET_PREFIXES.some(p => req.path.startsWith(p))
  )) {
    return staticServe(req, res, next);
  }
  next();
});

// ── Prometheus-Endpoint (vor Auth-Guard) ─────────────────────────────────────
// /metrics nutzt Bearer-Token-Auth (lib/bearer-auth, Scope `metrics:read`).
// Mount muss VOR dem Session-Guard liegen, sonst redirected der Guard externe
// Scraper (HA/Prometheus/Grafana) auf /login. Die Route validiert den Token
// selbst und setzt req.session.user falls gueltig; ungueltige Tokens enden in
// 401 JSON ohne Redirect.
app.use('/metrics', require('./routes/metrics'));

// ── Auth-Guard ────────────────────────────────────────────────────────────────
// API-Pfade → 401 JSON; HTML-Pfade → Redirect zu /auth/login
// `/dictionary` steht ohne Trailing-Slash in der Liste: der Router bedient die
// Wurzel (GET/POST/DELETE `/dictionary`), ein `/dictionary/`-Prefix wuerde sie
// verfehlen und den Client auf /auth/login redirecten.
const API_PREFIXES = ['/history/', '/figures/', '/locations/', '/world-facts/', '/songs/', '/jobs/', '/sync/', '/chat/', '/booksettings/', '/publication/', '/content/', '/stt/', '/tts/', '/languagetool/', '/dictionary', '/books/', '/me/', '/admin/', '/local/', '/config', '/share/api/', '/name-guard/', '/research', '/research/', '/sources', '/sources/', '/xrefs', '/xrefs/', '/capture', '/textsorte/', '/redaktion/', '/headline/'];

app.use((req, res, next) => {
  // Device-Token (native Clients, z.B. Mac-Focus-Writer): Bearer swd_… loest auf
  // den echten User + dessen echte Rolle auf und respektiert das Status-Gate.
  // req.session.user wird gesetzt, sodass downstream (ACL, Logging, Activity)
  // den Request wie eine normale Session behandelt. Bei ungueltigem/fehlendem
  // Token faellt der Guard auf seinen normalen 401/Redirect-Pfad zurueck.
  //
  // Traegt der Request ein swd_-Bearer-Token, hat die Device-Auth IMMER Vorrang —
  // auch wenn schon ein Session-Cookie existiert. express-session setzt beim
  // ersten Touch ein Cookie, das der native Client mitsendet; ohne diesen Vorrang
  // wuerde der Session-Pfad die Device-Auth danach 7 Tage kurzschliessen
  // (touchTokenUsage-Telemetrie eingefroren, widerrufene Tokens blieben gueltig).
  // Bei ungueltigem/widerrufenem Token wird ein altes Cookie bewusst ignoriert,
  // damit der Recheck nicht ausgehebelt wird.
  const bearer = extractBearer(req);
  const isDeviceBearer = !!bearer && bearer.startsWith(deviceTokens.TOKEN_PREFIX);
  if (req.session?.user && !isDeviceBearer) return next();
  const deviceUser = tryDeviceAuth(req);
  if (deviceUser) {
    req.session.user = deviceUser;
    // Der ALS-Log-Context wurde oben mit user=null eingefroren (Device-Auth laeuft
    // erst hier, nach Session-Pruefung) — User nachtragen, damit Mac-Client-Requests
    // im Log-Tag dem User zugeordnet sind, nicht anonym laufen.
    setContext({ user: deviceUser.email });
    return next();
  }
  if (isDeviceBearer) {
    // swd_-Token vorhanden, aber ungueltig/widerrufen/abgelaufen → 401/Redirect
    // (unten), ohne auf eine evtl. bestehende Session zurueckzufallen.
    if (API_PREFIXES.some(p => req.path.startsWith(p))) {
      return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    }
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  // Dev-Logout-Marker (gesetzt durch /auth/logout): Auto-Dev-Session unterbinden,
  // damit der User Logout/Login-Flow wie in Prod testen kann. /auth/login raeumt
  // den Marker.
  if (LOCAL_DEV_MODE && !/(?:^|;\s*)sw_devout=1(?:;|$)/.test(req.headers.cookie || '')) {
    req.session.user = { email: 'dev@local', name: 'Dev (lokal)', role: 'admin' };
    try {
      const existing = appUsers.getUser('dev@local');
      if (!existing) {
        appUsers.createUser({ email: 'dev@local', displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active' });
      } else if (existing.global_role !== 'admin' || existing.status !== 'active') {
        if (existing.global_role !== 'admin') appUsers.setGlobalRole('dev@local', 'admin');
        if (existing.status !== 'active') appUsers.setStatus('dev@local', 'active');
      }
      appUsers.touchLogin('dev@local', 'Dev (lokal)');
    } catch (e) { logger.warn(`dev-mode admin upsert: ${e.message}`); }
    return next();
  }
  if (API_PREFIXES.some(p => req.path.startsWith(p))) {
    return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  }
  return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
});

// ── Device-Scope-Gate ────────────────────────────────────────────────────────
// Muss direkt hinter dem Auth-Guard liegen (der setzt req.session.user samt
// scopes) und VOR jedem Route-Mount. Betrifft nur Requests via Device-Token:
// ein `capture:write`-Token (Browser-Erweiterung) kommt nur an die Erfassungs-
// Endpunkte, `content:write` (native Clients) bleibt ungegated.
app.use(deviceScopeGate);

// ── Aktivitäts-Tracking ──────────────────────────────────────────────────────
// Pro authentifiziertem Request wird die Differenz zum letzten Request als aktive
// Zeit gezählt – aber nur, wenn die Lücke < 5 min ist (danach gilt der User als
// weg gewesen). `app_users.last_seen_at` wird nur alle 60 s in die DB geschrieben,
// um Write-Last niedrig zu halten.
const ACTIVITY_GAP_MS      = 5 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
app.use((req, res, next) => {
  const email = req.session?.user?.email;
  if (!email) return next();
  const now  = Date.now();
  const last = req.session.lastSeen || 0;
  const delta = now - last;
  if (delta > 0 && delta < ACTIVITY_GAP_MS) {
    try { addUserActivity(email, delta / 1000, new Date(now).toISOString()); }
    catch (e) { logger.warn('addUserActivity: ' + e.message); }
  }
  if (!req.session.loginAt) req.session.loginAt = now; // Fallback für Sessions aus Zeit vor diesem Feature
  req.session.lastSeen = now;
  if (now - (req.session.lastSeenPersisted || 0) > LAST_SEEN_THROTTLE_MS) {
    try { touchUserLastSeen(email, new Date(now).toISOString()); }
    catch (e) { logger.warn('touchUserLastSeen: ' + e.message); }
    req.session.lastSeenPersisted = now;
  }
  next();
});

// ── Geschützte Routen ────────────────────────────────────────────────────────
app.use(proxiesRouter);
app.use('/history', historyRouter);
app.use('/figures', figuresAlterRouter);
app.use('/figures', figuresRouter);
app.use('/locations', locationsRouter);
app.use('/world-facts', require('./routes/world-facts'));
app.use('/geocode', require('./routes/geocode'));
app.use('/tiles', require('./routes/tiles'));
app.use('/songs', songsRouter);
app.use('/jobs', jobsRouter);
app.use('/chat', chatRouter);
app.use('/ideen', ideenRouter);
app.use('/research', researchRouter);
app.use('/sources', sourcesRouter);
// Sammel-Endpunkt der Browser-Erweiterung: Fundstueck + Quelle in einem
// transaktionalen Aufruf (siehe routes/capture.js).
app.use('/capture', require('./routes/capture'));
app.use('/xrefs', xrefsRouter);
app.use('/plot', plotRouter);
app.use('/motifs', motifsRouter);
app.use('/lexicon', require('./routes/lexicon'));
app.use('/textsorte', require('./routes/textsorte'));
app.use('/redaktion', require('./routes/redaktion'));
app.use('/headline', require('./routes/headline'));
app.use('/booksettings', bookSettingsRouter);
app.use('/me', userSettingsRouter);
app.use('/sync', syncRouter);
app.use('/export', exportRouter);
app.use('/book-migration', bookMigrationRouter);
app.use('/pdf-export', pdfExportRouter);
app.use('/docx-export', require('./routes/docx-export'));
app.use('/publication', require('./routes/publication'));
app.use('/usage', usageRouter);
app.use('/telemetry', require('./routes/telemetry'));
app.use('/draft-figures', draftFiguresRouter);
app.use('/content', contentRouter);
app.use('/snapshots', snapshotsRouter);
app.use('/search', require('./routes/search'));
app.use('/languagetool', require('./routes/languagetool'));
app.use('/name-guard', require('./routes/name-guard'));
app.use('/stt', require('./routes/stt'));
app.use('/tts', require('./routes/tts'));
app.use('/dictionary', require('./routes/dictionary'));
app.use('/diagram', require('./routes/diagram'));
app.use('/books', require('./routes/book-access'));
app.use('/book-editor', require('./routes/book-editor'));
app.use('/admin/users', require('./routes/admin-users'));
app.use('/admin/books', require('./routes/admin-books'));
app.use('/admin/settings', require('./routes/admin-settings'));
app.use('/admin/ai-profiles',            require('./routes/admin-ai-profiles'));
app.use('/admin/usage', require('./routes/admin-usage'));
app.use('/admin/logs', require('./routes/admin-logs'));
app.use('/admin/parse-fails', require('./routes/admin-parse-fails'));
app.use('/admin/js-errors', require('./routes/admin-js-errors'));
app.use('/admin/registration-requests', require('./routes/admin-registration-requests'));
app.use('/admin/api-tokens',            require('./routes/admin-api-tokens'));
app.use('/admin/devices',               require('./routes/admin-devices'));
app.use('/admin/backup',                require('./routes/admin-backup'));
app.use('/local/categories', require('./routes/categories'));
app.use('/blog', require('./routes/blog'));
app.use('/hubspot', require('./routes/hubspot'));

// Logout: usage-Tabelle behält Einträge (User-Wiederkehr → Top-3 sofort wieder da).
// Wenn Datenschutz erforderlich, Cleanup über Job/Cron auf Last-Seen-Basis.

// Page-Load-Logging: nur echte SPA-Shell-Requests (Browser-Document, kein
// SW-Refetch, kein Asset-Call). Heuristik prüft sec-fetch-dest oder Accept.
app.use((req, _res, next) => {
  if (req.method === 'GET' && req.path === '/') {
    const dest = req.headers['sec-fetch-dest'];
    const accept = req.headers.accept || '';
    const isDoc = dest === 'document' || accept.startsWith('text/html');
    if (isDoc) {
      const ua = req.headers['user-agent'] || '-';
      logger.info(`page load (ua="${ua}")`);
    }
  }
  next();
});

app.use(staticServe);

function bootstrapDevAccess(stage) {
  if (!LOCAL_DEV_MODE) return;
  const email = 'dev@local';
  try {
    if (!appUsers.getUser(email)) {
      appUsers.createUser({ email, displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active' });
    }
    appUsers.touchLogin(email, 'Dev (lokal)');
    const books = db.prepare('SELECT book_id FROM books').all();
    let granted = 0;
    for (const { book_id } of books) {
      if (!bookAccess.getBookRole(book_id, email)) {
        bookAccess.grantAccess(book_id, email, 'owner', 'system');
        granted++;
      }
    }
    if (granted > 0) {
      logger.info(`LOCAL_DEV_MODE (${stage}): ${granted} Buch/Bücher für ${email} als owner freigeschaltet.`);
    }
  } catch (e) {
    logger.warn(`bootstrapDevAccess (${stage}): ${e.message}`);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`${appSettings.get('app.name')} v${getVersion()} läuft auf http://0.0.0.0:${PORT}`);

  bootstrapDevAccess('boot');

  // Hängende Job-Runs aus dem letzten Server-Leben bereinigen
  const stuck = cleanupStuckJobRuns();
  if (stuck > 0) logger.warn(`Startup: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);

  // Catch-up: täglicher 23:00-Sync nachholen, falls Server zur Cron-Zeit aus war.
  // Stale-Cleanup laeuft NACH dem Sync — Sync setzt last_seen_at frisch, sodass
  // wieder-erreichbare Buecher nicht versehentlich geprunt werden, wenn der
  // 23:00-Cron nie lief.
  // Cutoff = letzter erwarteter Lauf: heute wenn now >= 23:00, sonst gestern.
  // Sonst feuert Catch-up jeden Startup vor 23:00 unnötig (today existiert noch nicht).
  let syncPromise = Promise.resolve();
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const cutoff = now.getHours() >= 23 ? todayStr : yesterdayStr;
    const row = db.prepare('SELECT MAX(recorded_at) AS last FROM book_stats_history').get();
    if (!row?.last || row.last < cutoff) {
      logger.info(`Startup: book_stats_history letzter Eintrag ${row?.last || 'nie'} – hole Sync nach.`);
      syncPromise = runWithContext({ job: 'cron', user: 'system' }, () =>
        syncAllBooks().catch(e => logger.error('Startup-Sync Fehler: ' + e.message))
      );
    } else {
      logger.info('Startup: Sync aktuell – kein Catch-up nötig.');
    }
  } catch (e) {
    logger.error('Startup-Catch-up Fehler: ' + e.message);
  }

  syncPromise.finally(() => {
    const staleDays = Math.max(1, parseInt(appSettings.get('cron.stale_days'), 10) || 7);
    try {
      const counts = pruneStaleByAge(staleDays);
      if (!counts.stale_books && !counts.stale_chapters && !counts.stale_pages) {
        logger.info('Startup: Keine Stale-Eintraege gefunden.');
      }
    } catch (e) {
      logger.error('Startup Stale-Cleanup Fehler: ' + e.message);
    }
    bootstrapDevAccess('post-sync');
  });
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// systemd schickt SIGTERM, Ctrl+C schickt SIGINT. Ohne Handler werden
// offene SSE-Streams und Jobs abrupt gekappt. 30 s Drain-Zeit für laufende Requests,
// danach `server.close()` + SQLite-Close. Kein Force-Kill von Jobs – die kommen
// beim nächsten Start via cleanupStuckJobRuns() wieder hoch.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} empfangen – Graceful Shutdown (max 30 s Drain)…`);
  const force = setTimeout(() => {
    logger.warn('Drain-Timeout erreicht – erzwinge Exit.');
    try { db.close(); } catch {}
    process.exit(1);
  }, 30000);
  force.unref();
  server.close(err => {
    clearTimeout(force);
    if (err) logger.error('server.close Fehler: ' + err.message);
    try { db.pragma('optimize'); } catch {}
    try { db.close(); } catch {}
    logger.info('Graceful Shutdown abgeschlossen.');
    process.exit(err ? 1 : 0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  shutdown('uncaughtException', err);
});

// Tägliche Cron-Jobs (node-cron)
try {
  const cron = require('node-cron');
  // Zeitzone explizit setzen – ohne expliziten Wert läuft node-cron in Server-TZ.
  // In manchen LXC-Templates ist die TZ UTC → "23:00" wäre dann 00:00/01:00 CH-Zeit.
  const cronTz = appSettings.get('app.timezone') || 'Europe/Zurich';

  // 23:00 – Buchstatistik-Sync + hängende Jobs bereinigen + TTL-Cache-Cleanup.
  // Tagesscharfe Statistik: recorded_at am Tag X reflektiert Inhalte vom Tag X.
  cron.schedule('0 23 * * *', () => {
    runWithContext({ job: 'cron', user: 'system' }, () => {
      logger.info('Cron: Starte täglichen Buchstatistik-Sync…');
      // Wortschatz-Analyse hängt sich HINTER den Sync (nicht in die Embedding-
      // Kette weiter unten): sie liest reinen Seitentext, keine Vektoren, und
      // braucht dafür den frischen Stand aus dem Sync. Der Delta-Skip
      // (content_sig über die Seiten in Leserichtung) macht den Lauf für
      // unveränderte Bücher praktisch kostenlos.
      syncAllBooks()
        .then(() => scanAllLexicons())
        .catch(e => logger.error('Cron-Sync/Wortschatz Fehler: ' + e.message));

      const stuck = cleanupStuckJobRuns();
      if (stuck > 0) logger.warn(`Cron: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
      else logger.info('Cron: Keine hängenden Job-Runs gefunden.');

      try {
        const summary = runCacheCleanup();
        logger.info(`Cron: Cache-Cleanup entfernt ${summary.totalRemoved} Row(s) aus ${summary.tables.length} Tabellen.`);
      } catch (e) {
        logger.error('Cron Cache-Cleanup Fehler: ' + e.message);
      }

      // FTS5-Optimize. Faltet die Segmente zu einem grossen B-Tree
      // zusammen — billig nach naechtlichen Schreibern, beschleunigt Querys.
      try {
        const searchIndex = require('./lib/search');
        searchIndex.optimize();
      } catch (e) {
        logger.error('Cron Search-Optimize Fehler: ' + e.message);
      }

      // Abgelaufene page_locks wegraeumen. Funktional ist es nicht
      // noetig (Guards filtern `WHERE expires_at > now`), nur DB-Hygiene.
      try {
        const { purgeExpiredLocks } = require('./db/book-access');
        const removed = purgeExpiredLocks();
        if (removed > 0) logger.info(`Cron: ${removed} abgelaufene page_locks entfernt.`);
      } catch (e) {
        logger.error('Cron page_locks-Cleanup Fehler: ' + e.message);
      }

      // Semantische Suche: Embedding-Indizes aller Bücher frisch halten. Reiht
      // pro Buch einen Job ein (Delta-Cache → nur geänderte Chunks neu
      // embeddet); nie-indizierte Bücher bekommen ihren Erst-Index. Danach den
      // Motiv-Ist-Index + Plot-Beat-Verankerung nachziehen (motif-scan / beat-anchor
      // pro Buch/User) — beide reihen sich hinter die Embed-Jobs ein und lesen den
      // frischen Index. Keiner ruft callAI; sie nutzen nur den Embedding-/FTS-Index.
      // Querverweis-Index nachziehen: holt Bestandsinhalte nach, die seit
      // Einfuehrung des Features nie gespeichert wurden, und heilt Drift, die
      // kein Seiten-Write mehr anfassen wuerde (Verweis auf ein Ziel, das erst
      // spaeter angelegt wurde — siehe Buch-Guard in db/xrefs.js). Kein Job:
      // reine Klempnerei ohne callAI, wie der FTS-Index.
      reindexAllXrefs().catch(e => logger.error('Cron Querverweis-Index Fehler: ' + e.message));

      reindexAllBooks()
        .then(() => scanAllMotifs())
        .then(() => anchorAllBeats())
        .catch(e => logger.error('Cron Embedding-Reindex/Motiv-Scan/Beat-Anchor Fehler: ' + e.message));

      // Quellen-PDF-Index zieht nach dem Buch-Index nach (eigene Tabelle, eigener
      // Job — user-skopiert, nicht buchskopiert). Delta-Cache hält billig, was
      // schon indiziert war; frisch hochgeladene PDFs bekommen Erst-Index.
      reindexAllUserSources()
        .catch(e => logger.error('Cron Quellen-Embedding-Reindex Fehler: ' + e.message));
    });
  }, { timezone: cronTz });
  logger.info(`Cron-Job registriert: Buchstatistik-Sync + Job-Cleanup + Cache-TTL-Cleanup + page_locks-Purge täglich 23:00 (${cronTz})`);

  // 04:00 – Stale-Cleanup. Eintraege (books/chapters/pages), deren letzter
  // Discovery-Touch (last_seen_at) aelter ist als STALE_DAYS, werden geloescht.
  // Faengt Loeschungen ab, die presence-basiertes Pruning verfehlt: Buecher
  // ohne berechtigten User-Token, oder solche die im Sync-Lauf fehlgeschlagen
  // sind. Schwelle gross genug, dass ein einzelner Sync-Fehler nicht sofort
  // zuschlaegt. Laeuft 5h nach dem 23:00-Sync, damit aktuelle last_seen_at-
  // Touches schon eingebrannt sind.
  const staleDays = Math.max(1, parseInt(appSettings.get('cron.stale_days'), 10) || 7);
  cron.schedule('0 4 * * *', () => {
    runWithContext({ job: 'cron', user: 'system' }, () => {
      logger.info(`Cron: Starte Stale-Cleanup (Schwelle ${staleDays} Tage)…`);
      try {
        const counts = pruneStaleByAge(staleDays);
        if (!counts.stale_books && !counts.stale_chapters && !counts.stale_pages) {
          logger.info('Cron: Keine Stale-Eintraege gefunden.');
        }
      } catch (e) {
        logger.error('Cron Stale-Cleanup Fehler: ' + e.message);
      }
    });
  }, { timezone: cronTz });
  logger.info(`Cron-Job registriert: Stale-Cleanup täglich 04:00 (${cronTz}, Schwelle ${staleDays} Tage)`);

  // 02:30 – pending registration_requests aelter als N Tage auf
  // 'expired' setzen. Default 30 Tage; konfigurierbar via app_settings
  // auth.registration.expire_days. Status-Wechsel ohne Mail (siehe Spec).
  cron.schedule('30 2 * * *', () => {
    runWithContext({ job: 'cron', user: 'system' }, () => {
      try {
        const regRequests = require('./db/registration-requests');
        const days = Math.max(1, parseInt(appSettings.get('auth.registration.expire_days'), 10) || 30);
        const changed = regRequests.expireStale(days);
        if (changed > 0) logger.info(`Cron: ${changed} pending registration_requests auf 'expired' gesetzt (Schwelle ${days} Tage).`);
      } catch (e) {
        logger.error('Cron registration-expire Fehler: ' + e.message);
      }
    });
  }, { timezone: cronTz });
  logger.info(`Cron-Job registriert: registration_requests-Expire täglich 02:30 (${cronTz})`);

  // 03:00 – Nacht-Komplettanalyse für alle Bücher × alle User (DEAKTIVIERT).
  // Bei Reaktivierung den Body in runWithContext({ job: 'cron', user: 'system' }, …) wrappen
  // (wie die aktiven Crons oben), damit die enqueue-Logs den ALS-Context tragen; die
  // einzelnen Jobs erhalten ihren Context ohnehin über drainQueue.
  // cron.schedule('0 3 * * *', () => {
  //   logger.info('Cron: Starte nächtliche Komplettanalyse…');
  //   runKomplettAnalyseAll().catch(e => logger.error('Cron-Komplettanalyse Fehler: ' + e.message));
  // }, { timezone: cronTz });
  // logger.info(`Cron-Job registriert: Komplettanalyse täglich 03:00 (${cronTz})`);
} catch {
  logger.warn('node-cron nicht verfügbar – keine automatischen Cron-Jobs (npm install ausführen)');
}
