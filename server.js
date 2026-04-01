require('dotenv').config();
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3737;
const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// Expose .env config to the frontend (credentials only, no secrets beyond what's needed)
app.get('/config', (_req, res) => {
  res.json({
    tokenId: process.env.TOKEN_ID || '',
    tokenPw: process.env.TOKEN_KENNWORT || ''
  });
});

// Serve static files (the HTML app)
app.use(express.static(path.join(__dirname, 'public')));

// Proxy /claude → api.anthropic.com (avoids CORS, keeps API key server-side)
app.use('/claude', createProxyMiddleware({
  target: 'https://api.anthropic.com',
  changeOrigin: true,
  pathRewrite: { '^/': '/v1/messages' },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader('x-api-key', process.env.ANTHROPIC_API_KEY || '');
      proxyReq.setHeader('anthropic-version', '2023-06-01');
    },
    error: (err, _req, res) => {
      console.error('Claude proxy error:', err.message);
      res.status(502).json({ error: 'Claude nicht erreichbar: ' + err.message });
    }
  }
}));

// Proxy /api/* to BookStack (same server, no CORS issue)
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
      console.error('Proxy error:', err.message);
      res.status(502).json({ error: 'BookStack nicht erreichbar: ' + err.message });
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  console.log(`BookStack Ziel: ${BOOKSTACK_URL}`);
});
