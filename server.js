require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');
const logger = require('./logger');

// DB-Setup + Migrationen laufen beim Import
const { cleanupStuckJobRuns } = require('./db/schema');

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const locationsRouter = require('./routes/locations');
const { router: jobsRouter, runKomplettAnalyseAll } = require('./routes/jobs');
const chatRouter = require('./routes/chat');
const bookSettingsRouter = require('./routes/booksettings');
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
const isHttps = (process.env.APP_URL || '').startsWith('https');
app.use(session({
  secret: process.env.SESSION_SECRET || 'bitte-session-secret-in-env-setzen',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
    secure: isHttps,
    httpOnly: true,
    sameSite: 'lax',
  },
}));

const LOCAL_DEV_MODE = process.env.LOCAL_DEV_MODE === 'true';

if (LOCAL_DEV_MODE) {
  logger.warn('LOCAL_DEV_MODE aktiv – OAuth wird übersprungen, automatische Dev-Session!');
} else {
  if (!process.env.SESSION_SECRET) {
    logger.error('SESSION_SECRET nicht gesetzt – Server wird gestoppt. Bitte in .env setzen.');
    process.exit(1);
  }
  if (!process.env.ALLOWED_EMAILS) {
    logger.warn('ALLOWED_EMAILS nicht gesetzt – ALLE Google-Konten haben Zugriff! Bitte in .env einschränken.');
  }
}

// ── Auth-Routen (öffentlich) ──────────────────────────────────────────────────
app.use(authRouter);

// ── Auth-Guard ────────────────────────────────────────────────────────────────
// API-Pfade → 401 JSON; HTML-Pfade → Redirect zu /auth/login
const API_PREFIXES = ['/api/', '/history/', '/figures/', '/locations/', '/jobs/', '/sync/', '/chat/', '/booksettings/', '/config', '/claude', '/ollama', '/llama'];

app.use((req, res, next) => {
  if (req.session?.user) return next();
  if (LOCAL_DEV_MODE) {
    req.session.user = { email: 'dev@local', name: 'Dev (lokal)' };
    if (process.env.TOKEN_ID && process.env.TOKEN_KENNWORT) {
      req.session.bookstackToken = { id: process.env.TOKEN_ID, pw: process.env.TOKEN_KENNWORT };
    }
    return next();
  }
  if (API_PREFIXES.some(p => req.path.startsWith(p))) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
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
app.use('/sync', syncRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', bookstackProxy);

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  logger.info(`BookStack Ziel: ${BOOKSTACK_URL}`);

  // Hängende Job-Runs aus dem letzten Server-Leben bereinigen
  const stuck = cleanupStuckJobRuns();
  if (stuck > 0) logger.warn(`Startup: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
});

// Tägliche Cron-Jobs (node-cron)
try {
  const cron = require('node-cron');

  // 02:00 – Buchstatistik-Sync + hängende Jobs bereinigen
  cron.schedule('0 2 * * *', () => {
    logger.info('Cron: Starte täglichen Buchstatistik-Sync…');
    syncAllBooks().catch(e => logger.error('Cron-Sync Fehler: ' + e.message));

    const stuck = cleanupStuckJobRuns();
    if (stuck > 0) logger.warn(`Cron: ${stuck} hängender Job-Run(s) auf 'error' gesetzt.`);
    else logger.info('Cron: Keine hängenden Job-Runs gefunden.');
  });
  logger.info('Cron-Job registriert: Buchstatistik-Sync + Job-Cleanup täglich 02:00 Uhr');

  // 03:00 – Nacht-Komplettanalyse für alle Bücher × alle User (deaktiviert)
  // cron.schedule('0 3 * * *', () => {
  //   logger.info('Cron: Starte nächtliche Komplettanalyse…');
  //   runKomplettAnalyseAll().catch(e => logger.error('Cron-Komplettanalyse Fehler: ' + e.message));
  // });
  // logger.info('Cron-Job registriert: Komplettanalyse täglich 03:00 Uhr');
} catch {
  logger.warn('node-cron nicht verfügbar – keine automatischen Cron-Jobs (npm install ausführen)');
}
