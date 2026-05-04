require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const logger = require('./logger');

// DB-Setup + Migrationen laufen beim Import
const { db, cleanupStuckJobRuns, upsertUserLogin, touchUserLastSeen, addUserActivity } = require('./db/schema');

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const locationsRouter = require('./routes/locations');
const { router: jobsRouter, runKomplettAnalyseAll } = require('./routes/jobs');
const chatRouter = require('./routes/chat');
const ideenRouter = require('./routes/ideen');
const bookSettingsRouter = require('./routes/booksettings');
const userSettingsRouter = require('./routes/usersettings');
const { router: proxiesRouter, bookstackProxy, bookstackPageCleaner, BOOKSTACK_URL } = require('./routes/proxies');
const { router: syncRouter, syncAllBooks } = require('./routes/sync');
const exportRouter = require('./routes/export');
const usageRouter = require('./routes/usage');

const PORT = process.env.PORT || 3737;
const app = express();

// Hinter einem Reverse-Proxy (NGINX, NPM, Traefik …) echte Client-IP
// und req.secure korrekt auswerten lassen.
app.set('trust proxy', 1);
// CSP: alle Skripte/Styles/Fonts self-hosted (vendor/ + js/ + css/ + fonts/).
// 'unsafe-eval' ist Pflicht für Alpine.js v3 (kompiliert Direktiven dynamisch).
// 'unsafe-inline' bei style-src ist nötig, weil Alpine `:style` zur Laufzeit
// inline-style-Attribute setzt (z.B. progress-bar via --progress).
// img-src enthält die BookStack-Origin (Editor-Preview rendert Server-HTML mit
// absoluten BookStack-Bild-URLs) plus data:/blob: für Generated Charts/Graphs
// plus *.googleusercontent.com für Google-Profilbilder im Avatar-Menü.
// connect-src 'self' deckt alle XHR/SSE-Endpunkte (Server proxy'd Anthropic,
// Ollama, BookStack); Plausible darf an seine eigene Origin posten.
const PLAUSIBLE_ORIGIN = 'https://analytics.david-berger.ch';
const cspBookstackOrigin = (() => {
  try { return new URL(BOOKSTACK_URL).origin; }
  catch { return null; }
})();
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'", PLAUSIBLE_ORIGIN],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com', ...(cspBookstackOrigin ? [cspBookstackOrigin] : [])],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", PLAUSIBLE_ORIGIN],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

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

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

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

const isHttps = (process.env.APP_URL || '').startsWith('https');
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }, // alle 15 min abgelaufene Sessions löschen
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
    secure: isHttps,
    httpOnly: true,
    sameSite: 'lax',
  },
}));

if (LOCAL_DEV_MODE) {
  logger.warn('LOCAL_DEV_MODE aktiv – OAuth wird übersprungen, automatische Dev-Session!');
} else if (!process.env.ALLOWED_EMAILS) {
  logger.warn('ALLOWED_EMAILS nicht gesetzt – ALLE Google-Konten haben Zugriff! Bitte in .env einschränken.');
}

// ── Auth-Routen (öffentlich) ──────────────────────────────────────────────────
app.use(authRouter);

// ── Öffentliche PWA-Assets (vor Auth-Guard) ──────────────────────────────────
// Browser holen manifest.webmanifest und sw.js ohne Credentials; hinter dem
// Auth-Guard würde das in einen Google-OIDC-Redirect laufen und CORS-Fehler werfen.
const PUBLIC_ASSETS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/bookstack_lektorat_icon.svg',
  '/bookstack_lektorat_icon.ico',
  '/favicon.ico',
]);
// Statische Assets: `no-cache` für alles ausser Bildern. ETag bleibt aktiv —
// Browser revalidiert bei jedem Reload mit If-None-Match (304 wenn unverändert,
// nur Header-Roundtrip, keine Bytes). Bilder/Icons halten 7 Tage, weil sie sich
// praktisch nie ändern.
const staticServe = express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // sw.js darf nie HTTP-gecached werden, sonst frieren Clients auf alter
    // Service-Worker-Version fest und sehen Asset-Updates nicht.
    if (/(?:^|[\\/])sw\.js$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});
app.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_ASSETS.has(req.path)) {
    return staticServe(req, res, next);
  }
  next();
});

// ── Auth-Guard ────────────────────────────────────────────────────────────────
// API-Pfade → 401 JSON; HTML-Pfade → Redirect zu /auth/login
const API_PREFIXES = ['/api/', '/history/', '/figures/', '/locations/', '/jobs/', '/sync/', '/chat/', '/booksettings/', '/me/', '/config', '/claude', '/ollama', '/llama'];

app.use((req, res, next) => {
  if (req.session?.user) return next();
  if (LOCAL_DEV_MODE) {
    req.session.user = { email: 'dev@local', name: 'Dev (lokal)' };
    upsertUserLogin('dev@local', 'Dev (lokal)');
    if (process.env.TOKEN_ID && process.env.TOKEN_KENNWORT) {
      req.session.bookstackToken = { id: process.env.TOKEN_ID, pw: process.env.TOKEN_KENNWORT };
    }
    return next();
  }
  if (API_PREFIXES.some(p => req.path.startsWith(p))) {
    return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  }
  return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
});

// ── Aktivitäts-Tracking ──────────────────────────────────────────────────────
// Pro authentifiziertem Request wird die Differenz zum letzten Request als aktive
// Zeit gezählt – aber nur, wenn die Lücke < 5 min ist (danach gilt der User als
// weg gewesen). `users.last_seen_at` wird nur alle 60 s in die DB geschrieben,
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
app.use('/figures', figuresRouter);
app.use('/locations', locationsRouter);
app.use('/jobs', jobsRouter);
app.use('/chat', chatRouter);
app.use('/ideen', ideenRouter);
app.use('/booksettings', bookSettingsRouter);
app.use('/me', userSettingsRouter);
app.use('/sync', syncRouter);
app.use('/export', exportRouter);
app.use('/usage', usageRouter);

// Logout: usage-Tabelle behält Einträge (User-Wiederkehr → Top-3 sofort wieder da).
// Wenn Datenschutz erforderlich, Cleanup über Job/Cron auf Last-Seen-Basis.
app.use(staticServe);
app.use('/api', bookstackPageCleaner, bookstackProxy);

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  logger.info(`BookStack Ziel: ${BOOKSTACK_URL}`);

  // Hängende Job-Runs aus dem letzten Server-Leben bereinigen
  const stuck = cleanupStuckJobRuns();
  if (stuck > 0) logger.warn(`Startup: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// Docker/Systemd schicken SIGTERM, Ctrl+C schickt SIGINT. Ohne Handler werden
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
    try { db.close(); } catch {}
    logger.info('Graceful Shutdown abgeschlossen.');
    process.exit(err ? 1 : 0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Tägliche Cron-Jobs (node-cron)
try {
  const cron = require('node-cron');
  // Zeitzone explizit setzen – ohne expliziten Wert läuft node-cron in Server-TZ,
  // in Docker-Containern typischerweise UTC → "02:00" wäre dann 03:00/04:00 CH-Zeit.
  const cronTz = process.env.CRON_TIMEZONE || 'Europe/Zurich';

  // 02:00 – Buchstatistik-Sync + hängende Jobs bereinigen
  cron.schedule('0 2 * * *', () => {
    logger.info('Cron: Starte täglichen Buchstatistik-Sync…');
    syncAllBooks().catch(e => logger.error('Cron-Sync Fehler: ' + e.message));

    const stuck = cleanupStuckJobRuns();
    if (stuck > 0) logger.warn(`Cron: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
    else logger.info('Cron: Keine hängenden Job-Runs gefunden.');
  }, { timezone: cronTz });
  logger.info(`Cron-Job registriert: Buchstatistik-Sync + Job-Cleanup täglich 02:00 (${cronTz})`);

  // 03:00 – Nacht-Komplettanalyse für alle Bücher × alle User (deaktiviert)
  // cron.schedule('0 3 * * *', () => {
  //   logger.info('Cron: Starte nächtliche Komplettanalyse…');
  //   runKomplettAnalyseAll().catch(e => logger.error('Cron-Komplettanalyse Fehler: ' + e.message));
  // }, { timezone: cronTz });
  // logger.info(`Cron-Job registriert: Komplettanalyse täglich 03:00 (${cronTz})`);
} catch {
  logger.warn('node-cron nicht verfügbar – keine automatischen Cron-Jobs (npm install ausführen)');
}
