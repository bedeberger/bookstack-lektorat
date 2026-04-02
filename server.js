require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const LOG_FILE = path.join(__dirname, 'lektorat.log');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE, maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
    new winston.transports.Console(),
  ],
});

const app = express();
const PORT = process.env.PORT || 3737;
const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// --- History-Store (JSON-Datei) ---
const HISTORY_FILE = path.join(__dirname, 'lektorat-history.json');

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { page_checks: [], book_reviews: [] };
  }
}

function writeHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data));
}

let nextId = (() => {
  const h = readHistory();
  const maxCheck = h.page_checks.reduce((m, r) => Math.max(m, r.id), 0);
  const maxReview = h.book_reviews.reduce((m, r) => Math.max(m, r.id), 0);
  return Math.max(maxCheck, maxReview) + 1;
})();

function newId() { return nextId++; }

// ---

const jsonBody = express.json();

// --- Request-Logging ---
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// --- Config ---
app.get('/config', (_req, res) => {
  res.json({
    tokenId: process.env.TOKEN_ID || '',
    tokenPw: process.env.TOKEN_KENNWORT || '',
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    claudeMaxTokens: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6'
  });
});

// --- History: Seitenlektorat ---
app.post('/history/check', jsonBody, (req, res) => {
  const { page_id, page_name, book_id, error_count, errors_json, stilanalyse, fazit, model } = req.body;
  const h = readHistory();
  const entry = {
    id: newId(),
    page_id, page_name, book_id,
    checked_at: new Date().toISOString(),
    error_count: error_count || 0,
    errors_json: errors_json || [],
    stilanalyse: stilanalyse || null,
    fazit: fazit || null,
    model: model || null,
    saved: false,
    saved_at: null,
  };
  h.page_checks.push(entry);
  writeHistory(h);
  res.json({ id: entry.id });
});

app.patch('/history/check/:id/saved', jsonBody, (req, res) => {
  const h = readHistory();
  const entry = h.page_checks.find(r => r.id === parseInt(req.params.id));
  if (entry) {
    entry.saved = true;
    entry.saved_at = new Date().toISOString();
    writeHistory(h);
  }
  res.json({ ok: true });
});

app.get('/history/page/:page_id', (req, res) => {
  const h = readHistory();
  const pageId = parseInt(req.params.page_id);
  const rows = h.page_checks
    .filter(r => r.page_id === pageId)
    .sort((a, b) => b.checked_at.localeCompare(a.checked_at))
    .slice(0, 20);
  res.json(rows);
});

// --- History: Buchbewertung ---
app.post('/history/review', jsonBody, (req, res) => {
  const { book_id, book_name, review_json, model } = req.body;
  const h = readHistory();
  const entry = {
    id: newId(),
    book_id, book_name,
    reviewed_at: new Date().toISOString(),
    review_json: review_json || null,
    model: model || null,
  };
  h.book_reviews.push(entry);
  writeHistory(h);
  res.json({ id: entry.id });
});

app.get('/history/review/:book_id', (req, res) => {
  const h = readHistory();
  const bookId = parseInt(req.params.book_id);
  const rows = h.book_reviews
    .filter(r => r.book_id === bookId)
    .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))
    .slice(0, 10);
  res.json(rows);
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Proxy /claude → api.anthropic.com (SSE-Streaming) ---
app.post('/claude', jsonBody, async (req, res) => {
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...req.body, stream: true }),
    });
    const model = req.body.model || '?';
    if (!upstream.ok) {
      const err = await upstream.json();
      logger.error(`Claude upstream ${upstream.status} (model=${model}): ${JSON.stringify(err)}`);
      return res.status(upstream.status).json(err);
    }
    logger.info(`Claude call model=${model} max_tokens=${req.body.max_tokens || '?'}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    logger.error('Claude proxy error: ' + err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Claude nicht erreichbar: ' + err.message });
    else res.end();
  }
});

// --- Proxy /api/* → BookStack ---
app.use('/api', createProxyMiddleware({
  target: BOOKSTACK_URL,
  changeOrigin: true,
  pathRewrite: { '^/': '/api/' },
  on: {
    proxyRes: (proxyRes, _req, res) => {
      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
        proxyRes.destroy();
        res.status(401).json({ error: 'BookStack: Nicht authentifiziert – Token ungültig oder abgelaufen.' });
      }
    },
    error: (err, _req, res) => {
      logger.error('BookStack proxy error: ' + err.message);
      res.status(502).json({ error: 'BookStack nicht erreichbar: ' + err.message });
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  logger.info(`BookStack Ziel: ${BOOKSTACK_URL}`);
});
