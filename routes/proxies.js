const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { MAX_TOKENS_OUT } = require('../lib/ai');
const { getBookLocale } = require('../db/schema');

const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// prompt-config.json einmalig laden; fehlt die Datei, wird ein Fehler geworfen.
let _promptConfig = null;
function getPromptConfig() {
  if (_promptConfig !== null) return _promptConfig;
  const raw = fs.readFileSync(path.resolve(__dirname, '../prompt-config.json'), 'utf8');
  _promptConfig = JSON.parse(raw);
  logger.info('prompt-config.json geladen.');
  return _promptConfig;
}

const router = express.Router();
const jsonBody = express.json();

// Modell-Konfiguration ans Frontend liefern (keine Credentials)
router.get('/config', (req, res) => {
  res.json({
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    bookstackTokenOk: !!req.session?.bookstackToken,
    claudeMaxTokens: MAX_TOKENS_OUT,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6',
    apiProvider: process.env.API_PROVIDER || 'claude',
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    llamaModel:  process.env.LLAMA_MODEL  || 'llama3.2',
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
    const maxTokens = MAX_TOKENS_OUT;
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
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: req.body.max_tokens || 65536, think: false, temperature: parseFloat(process.env.OLLAMA_TEMPERATURE ?? '0.1') } }),
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

// Proxy /llama → OpenAI-kompatibler Endpunkt (Anthropic-Format → OpenAI-Format → Anthropic-SSE)
router.post('/llama', jsonBody, async (req, res) => {
  const llamaHost = (process.env.LLAMA_HOST || 'http://localhost:8080').replace(/\/$/, '');
  const model = process.env.LLAMA_MODEL || 'llama3.2';
  try {
    // Anthropic-Request-Format → OpenAI-Format umwandeln
    const messages = [];
    if (req.body.system) messages.push({ role: 'system', content: req.body.system });
    for (const m of (req.body.messages || [])) messages.push(m);

    const upstream = await fetch(`${llamaHost}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: parseFloat(process.env.LLAMA_TEMPERATURE ?? '0.1'),
        max_tokens: req.body.max_tokens || 65536,
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      logger.error(`Llama upstream ${upstream.status}: ${text}`);
      return res.status(upstream.status).json({ error: { message: text } });
    }

    logger.info(`Llama call model=${model}`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // OpenAI-SSE → Anthropic-kompatibles SSE normalisieren
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
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          const text = chunk.choices?.[0]?.delta?.content || '';
          if (text) {
            const sse = JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text },
            });
            res.write(`data: ${sse}\n\n`);
          }
        } catch (e) {
          logger.warn('Llama SSE parse error: ' + e.message);
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    logger.error('Llama proxy error: ' + err.message);
    if (!res.headersSent) res.status(502).json({ error: { message: 'Llama nicht erreichbar: ' + err.message } });
    else res.end();
  }
});

// Scrape dict.wortschatz-leipzig.de (HTML), da der dokumentierte REST-Endpunkt
// /wordrelations in den verfügbaren Corpora leer/404 ist. Nur für deutsche Bücher.
// Leipzig kennt nur Lemmata – flektierte Formen ("ging", "schöne") liefern 0 Treffer.
// Fallback: bei Leerergebnis Suffix-Stripping und Umlaut-Auflösung probieren.
const LEIPZIG_SUFFIXES = ['sten', 'ster', 'stes', 'sten', 'ten', 'test', 'ere', 'eren', 'erer', 'eres', 'erem', 'en', 'em', 'es', 'er', 'te', 'st', 'e', 't', 'n', 's'];
function leipzigLemmaGuesses(word) {
  const out = [];
  const seen = new Set([word.toLowerCase()]);
  const push = (w) => { const k = w.toLowerCase(); if (w.length >= 3 && !seen.has(k)) { seen.add(k); out.push(w); } };
  // 1) Suffix-Stripping (Adjektiv- und Verbendungen)
  for (const s of LEIPZIG_SUFFIXES) {
    if (word.length - s.length >= 3 && word.toLowerCase().endsWith(s)) {
      push(word.slice(0, -s.length));
    }
  }
  // 2) Umlaut-Auflösung (Plural: Häuser → Hauser, Bücher → Bucher – plus anschliessendes Suffix-Stripping)
  const noUmlaut = word.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U');
  if (noUmlaut !== word) {
    push(noUmlaut);
    for (const s of LEIPZIG_SUFFIXES) {
      if (noUmlaut.length - s.length >= 3 && noUmlaut.toLowerCase().endsWith(s)) {
        push(noUmlaut.slice(0, -s.length));
      }
    }
  }
  return out.slice(0, 6);
}

// Einzelner Scrape-Call; bei Timeout/Fehler still leer zurück, damit der Fallback weitermachen kann.
async function fetchLeipzig(word, corpus, budgetSignal) {
  const url = `https://dict.wortschatz-leipzig.de/de/res?corpusId=${encodeURIComponent(corpus)}&word=${encodeURIComponent(word)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const onBudget = () => ctrl.abort();
  budgetSignal?.addEventListener?.('abort', onBudget);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'text/html', 'User-Agent': 'bookstack-lektorat/1.0' } });
    if (!upstream.ok) return [];
    const html = await upstream.text();
    const blockMatch = html.match(/<b>\s*Synonym:\s*<\/b>([\s\S]*?)(?:<br\s*\/?>|<\/p>)/i);
    if (!blockMatch) return [];
    const out = [];
    const seen = new Set([word.toLowerCase()]);
    const re = /<a[^>]*>\s*([^<]+?)\s*<\/a>/g;
    let m;
    while ((m = re.exec(blockMatch[1])) !== null) {
      const w = m[1].trim();
      if (!w) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
    return out;
  } catch (err) {
    if (err.name !== 'AbortError') logger.warn(`Leipzig fetch «${word}»: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
    budgetSignal?.removeEventListener?.('abort', onBudget);
  }
}

router.get('/leipzig/synonyms', async (req, res) => {
  const word = (req.query.word || '').trim();
  const bookId = parseInt(req.query.book_id, 10) || null;
  if (!word) return res.json({ synonyme: [], disabled: false });
  const locale = bookId ? getBookLocale(bookId) : 'de-CH';
  if (!locale || !locale.toLowerCase().startsWith('de')) {
    logger.info(`Leipzig call word=«${word}» skipped (locale=${locale})`);
    return res.json({ synonyme: [], disabled: true });
  }
  const corpus = process.env.LEIPZIG_CORPUS || 'deu_news_2025';
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), 12000);
  const t0 = Date.now();
  let tries = 1;
  try {
    let words = await fetchLeipzig(word, corpus, budget.signal);
    let lemma = null;
    if (words.length === 0) {
      for (const guess of leipzigLemmaGuesses(word)) {
        if (budget.signal.aborted) break;
        tries++;
        const hits = await fetchLeipzig(guess, corpus, budget.signal);
        if (hits.length > 0) { words = hits; lemma = guess; break; }
      }
    }
    const ms = Date.now() - t0;
    logger.info(`Leipzig call word=«${word}»${lemma ? ` lemma=«${lemma}»` : ''} corpus=${corpus} tries=${tries} hits=${words.length} ${ms}ms`);
    const hinweis = lemma ? `Lemma: ${lemma}` : '';
    res.json({ synonyme: words.map(w => ({ wort: w, hinweis })), disabled: false, lemma });
  } finally {
    clearTimeout(budgetTimer);
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
