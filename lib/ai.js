'use strict';
// Gemeinsamer KI-Aufruf-Helfer – wird von routes/jobs.js und routes/figures.js importiert.
// Gibt { text, tokensIn, tokensOut } zurück.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings

const { jsonrepair } = require('jsonrepair');

async function callAI(userPrompt, systemPrompt, onProgress, maxTokensOverride, signal, provider) {
  provider = provider || process.env.API_PROVIDER || 'claude';

  if (provider === 'ollama') {
    const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const model = process.env.OLLAMA_MODEL || 'llama3.2';
    const maxTokens = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const resp = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: maxTokens, temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || '0.2'), think: false } }),
      signal,
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    // Schätzung: ~3 Zeichen/Token für deutschen Text (Komposita, Umlaute).
    // Dient als Untergrenze – Ollama meldet bei KV-Cache-Treffer 0 oder nur User-Tokens.
    const estimatedTokIn = Math.ceil(messages.reduce((s, m) => s + (m.content?.length || 0), 0) / 3);

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
            // Math.max fängt drei Fälle ab:
            // - Vollständiger Cache-Hit: prompt_eval_count=0 → Schätzung gewinnt
            // - Partieller Cache-Hit: nur User-Tokens gemeldet → Schätzung ergänzt System-Tokens
            // - Kein Cache: echter Wert >= Schätzung → echter Wert gewinnt
            tokensIn = Math.max(chunk.prompt_eval_count || 0, estimatedTokIn);
            tokensOut = chunk.eval_count || 0;
            if (chunk.done_reason === 'length') truncated = true;
            if (chunk.eval_duration) genDurationMs = Math.round(chunk.eval_duration / 1e6);
            if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
          } else {
            text += chunk.message?.content || '';
            if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn });
          }
        } catch { }
      }
    }
    return { text, truncated, tokensIn, tokensOut, genDurationMs };
  } else {
    const model = process.env.MODEL_NAME || 'claude-sonnet-4-6';
    const globalMax = parseInt(process.env.MODEL_TOKEN, 10) || 64000;
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    const body = {
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [{ role: 'user', content: userPrompt }], stream: true,
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
            tokensIn = ev.message.usage.input_tokens || 0;
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
        const preview = clean.length > 300 ? clean.slice(0, 300) + '…' : clean;
        throw new Error(`JSON-Parse fehlgeschlagen (${e3.message}). KI-Antwort (Anfang): ${preview}`);
      }
    }
  }
}

module.exports = { callAI, parseJSON };
