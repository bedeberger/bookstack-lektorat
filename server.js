const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3737;
const BOOKSTACK_URL = process.env.BOOKSTACK_URL || 'http://localhost:80';

// Serve static files (the HTML app)
app.use(express.static(path.join(__dirname, 'public')));

// Proxy /api/* to BookStack (same server, no CORS issue)
app.use('/api', createProxyMiddleware({
  target: BOOKSTACK_URL,
  changeOrigin: true,
  pathRewrite: { '^/api': '/api' },
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({ error: 'BookStack nicht erreichbar: ' + err.message });
    }
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lektorat läuft auf http://0.0.0.0:${PORT}`);
  console.log(`BookStack Ziel: ${BOOKSTACK_URL}`);
});
