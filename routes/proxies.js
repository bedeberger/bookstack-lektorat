const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// prompt-config.json einmalig laden; fehlt die Datei, werden Defaults aus prompts.js verwendet.
let _promptConfig = null;
function getPromptConfig() {
  if (_promptConfig !== null) return _promptConfig;
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8');
    _promptConfig = JSON.parse(raw);
    logger.info('prompt-config.json geladen.');
  } catch (e) {
    logger.warn('prompt-config.json nicht gefunden oder ungültig – Prompt-Defaults werden verwendet. (' + e.message + ')');
    _promptConfig = {};
  }
  return _promptConfig;
}

const router = express.Router();
const jsonBody = express.json();

// Modell-Konfiguration ans Frontend liefern (keine Credentials)
router.get('/config', (req, res) => {
  res.json({
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    bookstackTokenOk: !!req.session?.bookstackToken,
    claudeMaxTokens: parseInt(process.env.MODEL_TOKEN, 10) || 64000,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6',
    apiProvider: process.env.API_PROVIDER || 'claude',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    user: req.session?.user || null,
    devMode: process.env.LOCAL_DEV_MODE === 'true',
    promptConfig: getPromptConfig(),
  });
});

// Proxy /claude → api.anthropic.com (SSE-Streaming mit Key-Injection)
router.post('/claude', jsonBody, async (req, res) => {
  try {
    // Nur erlaubte Felder weitergeben – verhindert Model-Override durch das Frontend
    const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: req.body.system,
        messages: req.body.messages,
        stream: true,
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.json();
      logger.error(`Claude upstream ${upstream.status} (model=${model}): ${JSON.stringify(err)}`);
      return res.status(upstream.status).json(err);
    }
    logger.info(`Claude call model=${model} max_tokens=${maxTokens}`);
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

// Proxy /ollama → Ollama /api/chat (NDJSON → Anthropic-kompatibles SSE)
router.post('/ollama', jsonBody, async (req, res) => {
  const ollamaHost = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  try {
    // Anthropic-Request-Format → Ollama-Format umwandeln
    const messages = [];
    if (req.body.system) messages.push({ role: 'system', content: req.body.system });
    for (const m of (req.body.messages || [])) messages.push(m);

    const upstream = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: req.body.max_tokens || 65536 } }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      logger.error(`Ollama upstream ${upstream.status}: ${text}`);
      return res.status(upstream.status).json({ error: { message: text } });
    }

    logger.info(`Ollama call model=${model}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Ollama NDJSON → Anthropic-kompatibles SSE normalisieren
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const text = chunk.message?.content || '';
          if (text) {
            const sse = JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text },
            });
            res.write(`data: ${sse}\n\n`);
          }
        } catch (e) {
          logger.warn('Ollama NDJSON parse error: ' + e.message);
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    logger.error('Ollama proxy error: ' + err.message);
    if (!res.headersSent) res.status(502).json({ error: { message: 'Ollama nicht erreichbar: ' + err.message } });
    else res.end();
  }
});

// Proxy /api/* → BookStack (Token kommt aus req.session.bookstackToken)
const bookstackProxy = createProxyMiddleware({
  target: BOOKSTACK_URL,
  changeOrigin: true,
  pathRewrite: { '^/': '/api/' },
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.removeHeader('Authorization');
      const t = req.session?.bookstackToken;
      if (t?.id && t?.pw) {
        proxyReq.setHeader('Authorization', `Token ${t.id}:${t.pw}`);
      }
    },
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
