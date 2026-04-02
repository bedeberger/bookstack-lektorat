const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const logger = require('../logger');

const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

const router = express.Router();
const jsonBody = express.json();

// Credentials und Claude-Konfiguration ans Frontend liefern
router.get('/config', (_req, res) => {
  res.json({
    tokenId: process.env.TOKEN_ID || '',
    tokenPw: process.env.TOKEN_KENNWORT || '',
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    claudeMaxTokens: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6'
  });
});

// Proxy /claude → api.anthropic.com (SSE-Streaming mit Key-Injection)
router.post('/claude', jsonBody, async (req, res) => {
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

// Proxy /api/* → BookStack
const bookstackProxy = createProxyMiddleware({
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
});

module.exports = { router, bookstackProxy, BOOKSTACK_URL };
