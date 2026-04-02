require('dotenv').config();
const express = require('express');
const path = require('path');
const logger = require('./logger');

// DB-Setup + Migrationen laufen beim Import
require('./db/schema');

const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const { router: proxiesRouter, bookstackProxy, BOOKSTACK_URL } = require('./routes/proxies');
const { router: syncRouter, syncAllBooks } = require('./routes/sync');

const PORT = process.env.PORT || 3737;
const app = express();

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

app.use(proxiesRouter);
app.use('/history', historyRouter);
app.use('/figures', figuresRouter);
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
