const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const logger = require('../logger');
const { MAX_TOKENS_OUT, MODEL_CONTEXT, CHARS_PER_TOKEN, ollamaTemp, llamaTemp } = require('../lib/ai');
const { getBookLocale, getUser, getTokenForRequest } = require('../db/schema');
const { getPrompts, getPromptConfig } = require('../lib/prompts-loader');
const { toIntId } = require('../lib/validate');

const BOOKSTACK_URL = process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80';

// Allowlist für den /claude-, /ollama- und /llama-Proxy: Client darf kein beliebiges
// `system` schicken. Stattdessen `promptKind` angeben – Server löst den System-Prompt
// aus prompts.js auf. Verhindert Missbrauch des Proxys als generischer LLM-Zugang.
const PROMPT_KIND_TO_KEY = {
  stilkorrektur: 'SYSTEM_STILKORREKTUR',
};

async function resolveProxySystemPrompt(promptKind) {
  const key = PROMPT_KIND_TO_KEY[promptKind];
  if (!key) return null;
  const mod = await getPrompts();
  return mod[key] || null;
}

const router = express.Router();
const jsonBody = express.json();

// Modell-Konfiguration ans Frontend liefern (keine Credentials)
router.get('/config', (req, res) => {
  const user = req.session?.user || null;
  res.json({
    bookstackUrl: BOOKSTACK_URL.replace(/\/$/, ''),
    bookstackTokenOk: !!getTokenForRequest(req),
    claudeMaxTokens: MAX_TOKENS_OUT,
    claudeModel: process.env.MODEL_NAME || 'claude-sonnet-4-6',
    apiProvider: process.env.API_PROVIDER || 'claude',
    charsPerToken: CHARS_PER_TOKEN,
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
    llamaModel:  process.env.LLAMA_MODEL  || 'llama3.2',
    user,
    userSettings: user ? getUser(user.email) : null,
    devMode: process.env.LOCAL_DEV_MODE === 'true',
    promptConfig: getPromptConfig(),
  });
});

// Proxy /claude → api.anthropic.com (SSE-Streaming mit Key-Injection)
router.post('/claude', jsonBody, async (req, res) => {
  try {
    const systemPrompt = await resolveProxySystemPrompt(req.body.promptKind);
    if (!systemPrompt) {
      return res.status(400).json({ error_code: 'INVALID_PROMPT_KIND', params: { kind: req.body.promptKind || '' } });
    }
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
        system: systemPrompt,
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
    if (!res.headersSent) res.status(502).json({ error_code: 'CLAUDE_UNREACHABLE', params: { detail: err.message } });
    else res.end();
  }
});

// Proxy /ollama → Ollama /api/chat (NDJSON → Anthropic-kompatibles SSE)
router.post('/ollama', jsonBody, async (req, res) => {
  const ollamaHost = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  try {
    const systemPrompt = await resolveProxySystemPrompt(req.body.promptKind);
    if (!systemPrompt) {
      return res.status(400).json({ error_code: 'INVALID_PROMPT_KIND', params: { kind: req.body.promptKind || '' } });
    }
    // Anthropic-Request-Format → Ollama-Format umwandeln
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of (req.body.messages || [])) messages.push(m);

    const upstream = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: MODEL_CONTEXT, think: false, temperature: ollamaTemp() } }),
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
    const systemPrompt = await resolveProxySystemPrompt(req.body.promptKind);
    if (!systemPrompt) {
      return res.status(400).json({ error_code: 'INVALID_PROMPT_KIND', params: { kind: req.body.promptKind || '' } });
    }
    // Anthropic-Request-Format → OpenAI-Format umwandeln
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of (req.body.messages || [])) messages.push(m);

    const upstream = await fetch(`${llamaHost}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: llamaTemp(),
        max_tokens: MAX_TOKENS_OUT,
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

// OpenThesaurus (openthesaurus.de) — deutscher Community-Thesaurus von Daniel Naber.
// JSON-API liefert Bedeutungsgruppen (synsets) mit stilistischem Level; nur für deutsche Bücher.
// Terme können Kontext in Klammern enthalten ("(sich) identifizieren (mit)") — wird fürs Ersetzen gestrippt.
function cleanThesTerm(term) {
  return String(term || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchOpenThesaurusRaw(word, budgetSignal) {
  const url = `https://www.openthesaurus.de/synonyme/search?q=${encodeURIComponent(word)}&format=application/json&baseform=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  const onBudget = () => ctrl.abort();
  budgetSignal?.addEventListener?.('abort', onBudget);
  try {
    const upstream = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!upstream.ok) return null;
    return await upstream.json();
  } catch (err) {
    if (err.name !== 'AbortError') logger.warn(`OpenThesaurus fetch «${word}»: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
    budgetSignal?.removeEventListener?.('abort', onBudget);
  }
}

function extractThesSynonyms(data, queryWord) {
  const synsets = Array.isArray(data?.synsets) ? data.synsets : [];
  const normQuery = queryWord.toLowerCase();
  const out = [];
  const seen = new Set([normQuery]);
  for (const synset of synsets) {
    const terms = Array.isArray(synset?.terms) ? synset.terms : [];
    for (const t of terms) {
      const clean = cleanThesTerm(t?.term);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ wort: clean, hinweis: (t?.level || '').trim() });
    }
  }
  return out;
}

// Liefert Synonyme; fällt bei flektierten Formen ("ging") automatisch auf die Grundform zurück.
async function fetchOpenThesaurus(word, budgetSignal) {
  const first = await fetchOpenThesaurusRaw(word, budgetSignal);
  if (!first) return { synonyme: [], lemma: null };
  const direct = extractThesSynonyms(first, word);
  if (direct.length > 0) return { synonyme: direct, lemma: null };
  const baseforms = Array.isArray(first?.baseforms) ? first.baseforms : [];
  for (const lemma of baseforms) {
    if (!lemma || lemma.toLowerCase() === word.toLowerCase()) continue;
    if (budgetSignal?.aborted) break;
    const second = await fetchOpenThesaurusRaw(lemma, budgetSignal);
    if (!second) continue;
    const hits = extractThesSynonyms(second, lemma);
    if (hits.length > 0) {
      const hinweis = `Grundform: ${lemma}`;
      return {
        synonyme: hits.map(h => ({ wort: h.wort, hinweis: h.hinweis || hinweis })),
        lemma,
      };
    }
  }
  return { synonyme: [], lemma: null };
}

router.get('/openthesaurus/synonyms', async (req, res) => {
  const word = (req.query.word || '').trim();
  const bookId = toIntId(req.query.book_id);
  const log = logger.child({ job: 'thesaurus', user: req.session?.user?.email || '-', book: bookId || '-' });
  if (!word) return res.json({ synonyme: [], disabled: false });
  const userEmail = req.session?.user?.email || null;
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  if (!locale || !locale.toLowerCase().startsWith('de')) {
    log.info(`word=«${word}» skipped (locale=${locale})`);
    return res.json({ synonyme: [], disabled: true });
  }
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(), 10000);
  const t0 = Date.now();
  try {
    const { synonyme, lemma } = await fetchOpenThesaurus(word, budget.signal);
    const ms = Date.now() - t0;
    log.info(`word=«${word}»${lemma ? ` lemma=«${lemma}»` : ''} hits=${synonyme.length} ${ms}ms`);
    res.json({ synonyme, disabled: false, lemma });
  } finally {
    clearTimeout(budgetTimer);
  }
});

// Proxy /api/* → BookStack. Token wird pro Request aus der DB gezogen, nicht
// aus der Session – sonst würde ein Token-Update auf Gerät A die Sessions auf
// anderen Geräten nicht erreichen (stale-token → fälschliches 401).
const bookstackProxy = createProxyMiddleware({
  target: BOOKSTACK_URL,
  changeOrigin: true,
  pathRewrite: { '^/': '/api/' },
  on: {
    proxyReq: (proxyReq, req) => {
      // Lektorat-Session-Cookie nicht an BookStack weiterreichen — BookStack sieht
      // sonst Cookie + Token gleichzeitig und auth-fallback hängt sich an die
      // (anonyme) Session statt am Token, Resultat: 403 "no API permission".
      proxyReq.removeHeader('cookie');
      proxyReq.removeHeader('Authorization');
      const t = getTokenForRequest(req);
      if (t) {
        proxyReq.setHeader('Authorization', `Token ${t.id}:${t.pw}`);
      }
    },
    proxyRes: (proxyRes, _req, res) => {
      // BookStack meldet fehlende Auth per Redirect zur Login-Seite (301/302);
      // widerrufene/ungültige Tokens per 401. Beides → einheitlicher Fehler-Code.
      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 401) {
        proxyRes.destroy();
        // headersSent-Guard: wenn http-proxy-middleware bereits Header relayed
        // hat, würde res.status() einen "Cannot set headers"-Crash werfen.
        if (!res.headersSent) res.status(401).json({ error_code: 'BOOKSTACK_UNAUTHED' });
      }
    },
    error: (err, _req, res) => {
      logger.error('BookStack proxy error: ' + err.message);
      if (!res.headersSent) res.status(502).json({ error_code: 'BOOKSTACK_UNREACHABLE', params: { detail: err.message } });
    }
  }
});

module.exports = { router, bookstackProxy, BOOKSTACK_URL };
