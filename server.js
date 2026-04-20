require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const logger = require('./logger');

// DB-Setup + Migrationen laufen beim Import
const { db, cleanupStuckJobRuns, upsertUserLogin } = require('./db/schema');

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const locationsRouter = require('./routes/locations');
const { router: jobsRouter, runKomplettAnalyseAll } = require('./routes/jobs');
const chatRouter = require('./routes/chat');
const bookSettingsRouter = require('./routes/booksettings');
const userSettingsRouter = require('./routes/usersettings');
const { router: proxiesRouter, bookstackProxy, BOOKSTACK_URL } = require('./routes/proxies');
const { router: syncRouter, syncAllBooks } = require('./routes/sync');

const PORT = process.env.PORT || 3737;
const app = express();

// Hinter einem Reverse-Proxy (NGINX, NPM, Traefik …) echte Client-IP
// und req.secure korrekt auswerten lassen.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CSP aus: Alpine/vis-network via CDN würde blockiert

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
const staticServe = express.static(path.join(__dirname, 'public'));
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

// ── Geschützte Routen ────────────────────────────────────────────────────────
app.use(proxiesRouter);
app.use('/history', historyRouter);
app.use('/figures', figuresRouter);
app.use('/locations', locationsRouter);
app.use('/jobs', jobsRouter);
app.use('/chat', chatRouter);
app.use('/booksettings', bookSettingsRouter);
app.use('/me', userSettingsRouter);
app.use('/sync', syncRouter);
app.use(staticServe);
app.use('/api', bookstackProxy);

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
