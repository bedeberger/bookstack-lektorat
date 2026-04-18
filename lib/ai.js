'use strict';
// Gemeinsamer KI-Aufruf-Helfer – wird von routes/jobs.js und routes/figures.js importiert.
// Gibt { text, tokensIn, tokensOut } zurück.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings

const fs = require('fs');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
const logger = require('../logger');

// Zeichenanzahl pro Token für deutschen Text (Komposita, Umlaute → dichter als Englisch).
const CHARS_PER_TOKEN = 3;

// Maximale Output-Tokens – einzige Quelle für MODEL_TOKEN aus der .env.
const MAX_TOKENS_OUT = parseInt(process.env.MODEL_TOKEN, 10) || 64000;

// Sicherheitsgrenze für lokale Modelle: Abbruch wenn Output-Tokens das N-fache
// der Input-Tokens übersteigen. Verhindert endlose Wiederholungsschleifen.
const MAX_OUTPUT_RATIO = 3;

// Ollama und Llama verarbeiten parallele Anfragen schlecht (VRAM-Überlauf, Verbindungsabbruch).
// Dieser Mutex serialisiert alle lokalen KI-Calls global – Jobs laufen weiter parallel,
// nur die eigentlichen KI-Aufrufe kommen nacheinander am Server an.
let _ollamaQueue = Promise.resolve();
function withOllamaLock(fn) {
  const next = _ollamaQueue.then(fn);
  _ollamaQueue = next.catch(() => {}); // Fehler nicht in die Queue-Chain leiten
  return next;
}

let _llamaQueue = Promise.resolve();
function withLlamaLock(fn) {
  const next = _llamaQueue.then(fn);
  _llamaQueue = next.catch(() => {});
  return next;
}

// jsonSchema: optionales JSON-Schema für Grammar-Constrained Decoding (nur lokale Provider).
// Wenn gesetzt, erzwingt llama.cpp/Ollama strukturkonformes JSON (inkl. korrekt escapete Strings).
// Claude ignoriert das Argument.
async function callAI(userPrompt, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema) {
  const messages = [{ role: 'user', content: userPrompt }];
  return callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema);
}

// Multi-Turn-Variante von callAI: akzeptiert ein vollständiges Messages-Array
// (user/assistant-Wechsel) statt eines einzelnen User-Prompts.
async function callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema) {
  provider = provider || process.env.API_PROVIDER || 'claude';

  if (provider === 'ollama') {
    return withOllamaLock(() => _callOllama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema));
  }
  if (provider === 'llama') {
    return withLlamaLock(() => _callLlama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema));
  }
  return _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal);
}

async function _callOllama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema) {
    const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    const globalMax = MAX_TOKENS_OUT;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    // Dient als Untergrenze – Ollama meldet bei KV-Cache-Treffer 0 oder nur User-Tokens.
    const estimatedTokIn = Math.ceil(allMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);
    // num_ctx: Gesamtkontextfenster (Input + Output) – dynamisch aus Input-Schätzung + Output-Limit.
    // Fester Wert (MAX_TOKENS_OUT) wäre bei grossen Prompts zu klein und würde Input stillschweigend
    // kürzen (weniger Szenen/Figuren extrahiert). +1000 als Sicherheitspuffer.
    const num_ctx = estimatedTokIn + maxTokens + 1000;
    // format: JSON-Schema-Objekt (strikt) oder 'json' (permissiv). Schema erzwingt via GBNF-Grammatik
    //   nicht nur gültiges JSON sondern auch korrekt escapete Strings und schema-konforme Felder –
    //   verhindert die «unescaped `"` im String»-Klasse von Bugs, die mistral-small3.2 regelmässig
    //   produziert. Fallback 'json' (ohne Schema) ist nur hint-basiert.
    const fmt = jsonSchema || 'json';
    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: allMessages, stream: true, format: fmt, options: { num_ctx, num_predict: maxTokens, temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || '0.2'), think: false } }),
      signal,
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false, genDurationMs = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.done) {
            // Echten prompt_eval_count bevorzugen; nur bei vollständigem Cache-Hit
            // (prompt_eval_count=0) Fallback auf Schätzung, damit die Anzeige nicht 0 wird.
            // Vorher: Math.max(real, estimate) führte zu Überzählen, wenn die Schätzung
            // (CHARS_PER_TOKEN=3) zu pessimistisch war – die DB speicherte dann z.B. 128k,
            // obwohl das Modell 98k echte Tokens meldete.
            tokensIn = chunk.prompt_eval_count && chunk.prompt_eval_count > 0
              ? chunk.prompt_eval_count
              : estimatedTokIn;
            tokensOut = chunk.eval_count || 0;
            if (chunk.done_reason === 'length') truncated = true;
            if (chunk.eval_duration) genDurationMs = Math.round(chunk.eval_duration / 1e6);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          } else {
            text += chunk.message?.content || '';
            // Während des Streamings kein Schätzwert für tokIn durchreichen –
            // das führte sonst zu einer Anzeige, die nach Job-Ende vom echten
            // Wert aus usage abweicht (Inkonsistenz Job-Status vs. DB-Nachricht).
            if (onProgress) onProgress({ chars: text.length, tokIn: 0 });
            // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
            const estOut = Math.ceil(text.length / CHARS_PER_TOKEN);
            if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
              logger.warn(`Ollama Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
              truncated = true;
              reader.cancel();
              break;
            }
          }
        } catch { }
      }
      if (truncated) break;
    }
    return { text, truncated, tokensIn, tokensOut, genDurationMs };
}

async function _callLlama(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema) {
  const host = (process.env.LLAMA_HOST || 'http://localhost:8080').replace(/\/$/, '');
  const model = process.env.LLAMA_MODEL || 'llama3.2';
  const globalMax = MAX_TOKENS_OUT;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const allMessages = [];
  if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
  allMessages.push(...messages);

  // response_format:
  //   - Mit Schema: json_schema strict:true → GBNF-Grammar-Constrained Decoding. Erzwingt
  //     schema-konforme Struktur UND korrekt escapete Strings (fixt den «unescaped `"`»-Bug,
  //     den mistral-small3.2 im json_object-Modus produziert).
  //   - Ohne Schema: json_object als Fallback-Hint (nicht grammar-erzwungen).
  const responseFormat = jsonSchema
    ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: jsonSchema } }
    : { type: 'json_object' };

  let resp;
  try {
    resp = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: allMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: parseFloat(process.env.LLAMA_TEMPERATURE || '0.1'),
        max_tokens: maxTokens,
        response_format: responseFormat,
      }),
      signal,
    });
  } catch (fetchErr) {
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`Llama fetch fehlgeschlagen (${host}): ${fetchErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!resp.ok) throw new Error(`Llama ${resp.status}: ${await resp.text()}`);

  const estimatedTokIn = Math.ceil(allMessages.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', tokensIn = 0, tokensOut = 0, truncated = false;
  let t_first = 0, t_last = 0;
  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') continue;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) {
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          text += delta;
          // Während des Streamings kein Schätzwert für tokIn durchreichen –
          // sonst weicht die Job-Anzeige vom echten prompt_tokens (aus usage) ab.
          if (onProgress) onProgress({ chars: text.length, tokIn: 0 });
          // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
          const estOut = Math.ceil(text.length / CHARS_PER_TOKEN);
          if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
            logger.warn(`Llama Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
            truncated = true;
            reader.cancel();
            break;
          }
        }
        if (chunk.choices?.[0]?.finish_reason === 'length') truncated = true;
        if (chunk.usage) {
          tokensIn  = chunk.usage.prompt_tokens     || estimatedTokIn;
          tokensOut = chunk.usage.completion_tokens || Math.ceil(text.length / CHARS_PER_TOKEN);
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
        }
      } catch { }
    }
    if (truncated) break;
  }
  } catch (streamErr) {
    if (streamErr.name === 'AbortError') throw streamErr;
    const cause = streamErr.cause?.message || streamErr.cause?.code || '';
    throw new Error(`Llama Stream-Abbruch (${host}): ${streamErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!tokensIn)  tokensIn  = estimatedTokIn;
  if (!tokensOut) tokensOut = Math.ceil(text.length / CHARS_PER_TOKEN);
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text, truncated, tokensIn, tokensOut, genDurationMs };
}

async function _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal) {
    const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
    const globalMax = MAX_TOKENS_OUT;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    const body = {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages, stream: true,
    };
    if (systemPrompt) body.system = [{
      type: 'text', text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    }];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(await resp.json())}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = '', buf = '', tokensIn = 0, tokensOut = 0, truncated = false;
    let t_first = 0, t_last = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') break;
        try {
          let ev;
          try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.type === 'error') {
            throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
          }
          if (ev.type === 'message_start' && ev.message?.usage) {
            const u = ev.message.usage;
            tokensIn = (u.input_tokens || 0)
                     + (u.cache_creation_input_tokens || 0)
                     + (u.cache_read_input_tokens || 0);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
          if (ev.type === 'message_delta' && ev.usage) {
            tokensOut = ev.usage.output_tokens || 0;
            if (ev.delta?.stop_reason === 'max_tokens') truncated = true;
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const now = Date.now();
            if (!t_first) t_first = now;
            t_last = now;
            text += ev.delta.text;
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          }
        } catch (streamErr) { throw streamErr; }
      }
    }
    const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
    return { text, truncated, tokensIn, tokensOut, genDurationMs };
}

// ── Tool-Use (Anthropic Messages API) ──────────────────────────────────────
// Einzelner Round-Trip mit Tool-Use. Der Caller (Job-Runner) verwaltet den Loop:
// wenn stopReason === 'tool_use' muss er die Tools ausführen, Results als
// tool_result-Blocks an die messages anhängen und erneut aufrufen.
//
// Rückgabe:
//   { text, toolUses, stopReason, rawContentBlocks, tokensIn, tokensOut, genDurationMs, truncated }
//   - text: kumulierter Text aller text_delta-Blocks (kann leer sein bei reiner Tool-Antwort)
//   - toolUses: [{ id, name, input }] mit bereits geparstem input (Objekt)
//   - stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | ...
//   - rawContentBlocks: Original-Content-Blocks (text+tool_use) für die nächste Runde
//
// Nur Claude-Provider. Ollama/Llama werfen einen Fehler – Caller muss auf
// Fallback-Pfad (klassischer Buch-Chat) umschalten.
async function callAIWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, provider) {
  provider = provider || process.env.API_PROVIDER || 'claude';
  if (provider !== 'claude') {
    throw new Error(`Tool-Use nicht unterstützt für Provider '${provider}' – Caller muss auf Fallback-Pfad umschalten.`);
  }
  return _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal);
}

async function _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
  const globalMax = MAX_TOKENS_OUT;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const body = {
    model, max_tokens: maxTokens, temperature: 0.2,
    messages, stream: true,
  };
  if (systemPrompt) body.system = [{
    type: 'text', text: systemPrompt,
    cache_control: { type: 'ephemeral' },
  }];
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(await resp.json())}`);

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  // Content-Blocks werden per Index addressiert (content_block_start/delta/stop).
  // Jeder Block ist entweder text oder tool_use; bei tool_use wird input_json
  // in deltas geliefert und muss akkumuliert werden.
  const blocks = []; // [{ type:'text', text } | { type:'tool_use', id, name, _inputJson }]
  let textAcc = '';
  let buf = '';
  let tokensIn = 0, tokensOut = 0, truncated = false;
  let stopReason = null;
  let t_first = 0, t_last = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'error') {
        throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        const u = ev.message.usage;
        tokensIn = (u.input_tokens || 0)
                 + (u.cache_creation_input_tokens || 0)
                 + (u.cache_read_input_tokens || 0);
        if (onProgress) onProgress({ chars: textAcc.length, tokIn: tokensIn });
      }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, _inputJson: '' };
        } else if (cb.type === 'text') {
          blocks[ev.index] = { type: 'text', text: '' };
        }
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const b = blocks[ev.index];
        if (!b) continue;
        if (d.type === 'text_delta') {
          b.text += d.text || '';
          textAcc += d.text || '';
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          if (onProgress) onProgress({ chars: textAcc.length, tokIn: tokensIn });
        } else if (d.type === 'input_json_delta') {
          b._inputJson += d.partial_json || '';
        }
      }
      if (ev.type === 'content_block_stop') {
        // tool_use: akkumuliertes input-JSON parsen (kann leer sein → {})
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          try { b.input = b._inputJson ? JSON.parse(b._inputJson) : {}; }
          catch (e) { b.input = {}; b.parseError = e.message; }
          delete b._inputJson;
        }
      }
      if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) tokensOut = ev.usage.output_tokens;
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.delta?.stop_reason === 'max_tokens') truncated = true;
      }
    }
  }
  const toolUses = blocks.filter(b => b && b.type === 'tool_use').map(b => ({
    id: b.id, name: b.name, input: b.input || {}, ...(b.parseError ? { parseError: b.parseError } : {}),
  }));
  const rawContentBlocks = blocks.filter(Boolean).map(b => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
  });
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text: textAcc, toolUses, stopReason, rawContentBlocks, tokensIn, tokensOut, genDurationMs, truncated };
}

// Extrahiert das erste balancierte JSON-Objekt aus text, ohne Trailing-Content
// mit {}-Mustern (z.B. Modell-Hinweise nach dem JSON) einzuschliessen.
function extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString && ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJSON(text) {
  const clean = text.replace(/```json\s*|```/g, '').trim();
  try { return JSON.parse(clean); } catch {
    const candidate = extractBalancedJson(clean) ?? clean;
    try { return JSON.parse(candidate); } catch {
      try { return JSON.parse(jsonrepair(candidate)); } catch (e3) {
        // Diagnostik: Position aus jsonrepair-Fehlermeldung extrahieren, Kontextfenster ausgeben,
        // Rohtext in ai_parse_fails/ ablegen (nicht versioniert, rotiert nicht).
        // Bei lokalen Modellen bricht die JSON-Struktur oft mitten im Stream (kein Truncation,
        // sondern Drift) – ohne Rohtext-Dump ist die Stelle nicht rekonstruierbar.
        const posMatch = /position\s+(\d+)/i.exec(e3.message);
        const pos = posMatch ? parseInt(posMatch[1], 10) : null;
        let preview;
        if (pos != null) {
          const from = Math.max(0, pos - 300);
          const to   = Math.min(clean.length, pos + 300);
          preview = `…${clean.slice(from, pos)}⟦HIER⟧${clean.slice(pos, to)}… (pos ${pos} von ${clean.length})`;
        } else {
          preview = clean.length > 300 ? clean.slice(0, 300) + '…' : clean;
        }
        try {
          const dir = path.resolve(__dirname, '..', 'ai_parse_fails');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const fp = path.join(dir, `${ts}.txt`);
          fs.writeFileSync(fp, clean, 'utf8');
          logger.error(`JSON-Parse-Fehler: Rohtext (${clean.length} chars, pos=${pos}) nach ${fp} geschrieben.`);
        } catch (writeErr) {
          logger.warn(`Konnte Rohtext nicht in ai_parse_fails/ schreiben: ${writeErr.message}`);
        }
        throw new Error(`JSON-Parse fehlgeschlagen (${e3.message}). Kontext: ${preview}`);
      }
    }
  }
}

module.exports = { callAI, callAIChat, callAIWithTools, parseJSON, CHARS_PER_TOKEN, MAX_TOKENS_OUT };
