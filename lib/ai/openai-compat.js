'use strict';
// OpenAI-kompatibler Provider (/v1/chat/completions, SSE): llama.cpp/vLLM/LiteLLM/
// OpenAI. Optionaler Bearer-Token, response_format json_schema (strict) für
// Grammar-Constrained Decoding, chat_template_kwargs zum Unterdrücken von Thinking.

const appSettings = require('../app-settings');
const logger = require('../../logger');
const {
  CHARS_PER_TOKEN, getContextConfigFor,
  openaiCompatTemp, openaiCompatThink, openaiCompatRepeatPenalty,
} = require('./config');
const {
  MAX_OUTPUT_RATIO, _connErrorCode, _unreachableError,
  estimatePromptTokens, assertPromptFitsContext,
} = require('./shared');

async function _callOpenAICompat(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
  const host = String(appSettings.get('ai.openai-compat.host') || 'http://localhost:8080').replace(/\/$/, '');
  const model = appSettings.get('ai.openai-compat.model') || 'llama3.2';
  const cfg = getContextConfigFor('openai-compat');
  const globalMax = cfg.maxTokensOut;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const temperature = openaiCompatTemp(temperatureOverride);
  // Optionaler Bearer-Token: gehostete OpenAI-kompatible Endpoints (vLLM, LiteLLM,
  // OpenAI selbst) verlangen ihn; lokale llama.cpp-Server brauchen ihn meist nicht.
  // Leer = kein Authorization-Header.
  const apiKey = String(appSettings.get('ai.openai-compat.api_key') || '').trim();
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

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const reqBody = {
    model,
    messages: allMessages,
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    max_tokens: maxTokens,
    repeat_penalty: openaiCompatRepeatPenalty(),
    response_format: responseFormat,
  };
  // Reasoning unterdrücken: vLLM/SGLang/llama.cpp reichen `chat_template_kwargs`
  // an die Jinja-Chat-Vorlage durch; bei Qwen3 & Co schaltet `enable_thinking:false`
  // die <think>-Spur ab. Server ohne dieses Kwarg ignorieren es folgenlos. Bei
  // think=true gar nicht senden (Modell-Default; echtes OpenAI bleibt nutzbar).
  if (!openaiCompatThink()) {
    reqBody.chat_template_kwargs = { enable_thinking: false };
  }

  // Preflight VOR dem fetch: nicht alle Pfade laufen ueber routes/jobs/shared/ai.js#aiCall
  // (callAIChat aus den Chat-Jobs geht direkt hier durch). Ohne den Guard antwortet
  // llama.cpp/vLLM mit „OpenAI-kompatibel 400: <Server-Text>" und niemand sieht, dass
  // der Prompt schlicht zu gross war. i18n-Aufloesung passiert weiter oben (failJob).
  const estimatedTokIn = estimatePromptTokens(allMessages, cfg.charsPerToken);
  assertPromptFitsContext({ provider: 'openai-compat', cfg, maxTokensOut: maxTokens, estTokIn: estimatedTokIn });

  let resp;
  try {
    resp = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal,
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') throw fetchErr;
    if (_connErrorCode(fetchErr)) throw _unreachableError('openai-compat', host, fetchErr);
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel fetch fehlgeschlagen (${host}): ${fetchErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!resp.ok) throw new Error(`OpenAI-kompatibel ${resp.status}: ${await resp.text()}`);

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
          // tokIn live als Schätzung durchreichen, sonst bleibt die Input-Anzeige
          // während des Streamings bei 0 (openai-compat meldet prompt_tokens erst
          // in der finalen usage-Chunk). Der echte Wert überschreibt sie unten.
          if (onProgress) onProgress({ chars: text.length, tokIn: estimatedTokIn, delta });
          // Sicherheitsabbruch: lokales Modell dreht durch (Wiederholungsschleife)
          const estOut = Math.ceil(text.length / CHARS_PER_TOKEN);
          if (estOut > MAX_OUTPUT_RATIO * estimatedTokIn) {
            logger.warn(`OpenAI-kompatibel Sicherheitsabbruch: Output (~${estOut} Tokens) > ${MAX_OUTPUT_RATIO}× Input (~${estimatedTokIn} Tokens) – Generierung abgebrochen`);
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
      } catch (e) {
        logger.debug?.(`OpenAI-kompatibel Chunk-Parse-Fehler: ${e.message} — Line: ${line.slice(0, 120)}`);
      }
    }
    if (truncated) break;
  }
  } catch (streamErr) {
    if (streamErr.name === 'AbortError') throw streamErr;
    if (_connErrorCode(streamErr)) throw _unreachableError('openai-compat', host, streamErr);
    const cause = streamErr.cause?.message || streamErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel Stream-Abbruch (${host}): ${streamErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!tokensIn)  tokensIn  = estimatedTokIn;
  if (!tokensOut) tokensOut = Math.ceil(text.length / CHARS_PER_TOKEN);
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text, truncated, tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0, genDurationMs, provider: 'openai-compat', model };
}

module.exports = { _callOpenAICompat };
