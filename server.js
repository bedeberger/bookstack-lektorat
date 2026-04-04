require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');
const logger = require('./logger');

// DB-Setup + Migrationen laufen beim Import
require('./db/schema');

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const jobsRouter = require('./routes/jobs');
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

if (!process.env.SESSION_SECRET) {
  logger.warn('SESSION_SECRET nicht gesetzt – unsicher für Produktion!');
}
if (!process.env.ALLOWED_EMAILS) {
  logger.warn('ALLOWED_EMAILS nicht gesetzt – ALLE Google-Konten haben Zugriff! Bitte in .env einschränken.');
}

// ── Auth-Routen (öffentlich) ──────────────────────────────────────────────────
app.use(authRouter);

// ── Auth-Guard ────────────────────────────────────────────────────────────────
// API-Pfade → 401 JSON; HTML-Pfade → Redirect zu /auth/login
const API_PREFIXES = ['/api/', '/history/', '/figures/', '/jobs/', '/sync/', '/config', '/claude', '/ollama'];

app.use((req, res, next) => {
  if (req.session?.user) return next();
  if (API_PREFIXES.some(p => req.path.startsWith(p))) {
    return res.status(401).json({ error: 'Nicht angemeldet' });
  }
  return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
});

// ── Geschützte Routen ────────────────────────────────────────────────────────
app.use(proxiesRouter);
app.use('/history', historyRouter);
app.use('/figures', figuresRouter);
app.use('/jobs', jobsRouter);
app.use('/sync', syncRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', bookstackProxy);

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  logger.info(`BookStack Ziel: ${BOOKSTACK_URL}`);
});

// Täglicher Sync um 02:00 Uhr (node-cron)
try {
  const cron = require('node-cron');
  cron.schedule('0 2 * * *', () => {
    logger.info('Cron: Starte täglichen Buchstatistik-Sync…');
    syncAllBooks().catch(e => logger.error('Cron-Sync Fehler: ' + e.message));
  });
  logger.info('Cron-Job registriert: Buchstatistik-Sync täglich 02:00 Uhr');
} catch {
  logger.warn('node-cron nicht verfügbar – kein automatischer Sync (npm install ausführen)');
}
