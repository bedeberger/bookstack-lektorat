'use strict';
// OpenAI-kompatibler Provider (/v1/chat/completions, SSE): llama.cpp/vLLM/LiteLLM/
// OpenAI. Optionaler Bearer-Token, response_format json_schema (strict) für
// Grammar-Constrained Decoding, chat_template_kwargs zum Unterdrücken von Thinking.

const appSettings = require('../app-settings');
const logger = require('../../logger');
const {
  CHARS_PER_TOKEN, getContextConfigFor, jobOverride,
  openaiCompatTemp, openaiCompatThink, openaiCompatRepeatPenalty,
} = require('./config');
const {
  MAX_OUTPUT_RATIO, _connErrorCode, _unreachableError,
  estimatePromptTokens, assertPromptFitsContext,
  combineSignals, timeoutError, sleep, parseRetryAfter, retryDelayMs, overloadError,
} = require('./shared');
const { aiSetting, aiApiKey } = require('./profile');

// Transiente HTTP-Antworten eines OpenAI-kompatiblen Endpunkts. 429 = Rate-Limit,
// 408 = Request-Timeout, 5xx = Server ueberlastet/neu gestartet (vLLM/LiteLLM/OpenAI
// liefern 502/503/504 waehrend eines Modell-Reloads). Deterministische Fehler (400
// Kontext zu gross, 401 Key falsch, 404 Modell unbekannt) sind bewusst NICHT dabei —
// sie mit Backoff zu wiederholen verzoegert nur die Fehlermeldung.
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
function _retryMaxAttempts() {
  return parseInt(appSettings.get('ai.openai-compat.retry_max'), 10) || 3;
}

// Hard-Timeout pro Call. Ohne ihn haelt ein stummer Endpunkt (haengender Stream,
// gehosteter Anbieter im Ausfall) den Job-Slot unbegrenzt — der Job-Worker sieht
// weder Fehler noch Fortschritt. Per-Job-Override (Komplettanalyse) > Instanz-Setting
// > 10 Minuten, gleiche Kette wie bei Claude.
function _timeoutMs() {
  return Number(jobOverride('openai-compat', 'timeoutMs'))
    || parseInt(appSettings.get('ai.openai-compat.timeout_ms'), 10) || 600000;
}

/** Retry-Schleife um `_callOpenAICompatAttempt`. Wiederholt wird NUR, was vor dem
 *  ersten Delta scheitert (HTTP-Status) — ein mitten im Stream abgerissener Call
 *  haette bereits Text emittiert und wuerde beim zweiten Versuch doppelt zaehlen;
 *  den Fall faengt der transiente Retry der Job-Schicht ab
 *  (routes/jobs/shared/ai.js#retryOnTransientAi). */
async function _callOpenAICompat(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
  const maxAttempts = _retryMaxAttempts();
  let attempt = 0;
  while (true) {
    try {
      return await _callOpenAICompatAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride);
    } catch (e) {
      if (e?.code === 'AI_OVERLOADED' && !signal?.aborted && attempt < maxAttempts - 1) {
        const delay = retryDelayMs(attempt, e.retryAfterSec);
        logger.warn(`OpenAI-kompatibel transient (${e.status || '?'}), Versuch ${attempt + 1}/${maxAttempts}, retry in ${Math.round(delay)}ms`);
        attempt++;
        await sleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
}

async function _callOpenAICompatAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride) {
  const host = String(aiSetting('openai-compat', 'host') || 'http://localhost:8080').replace(/\/$/, '');
  // Per-Job-Modell (Komplettanalyse) vor Profil-/Instanz-Modell — dieselbe Kette wie
  // _resolveClaudeModel; erlaubt ein staerkeres Analyse-Modell neben dem Alltags-Modell.
  const model = jobOverride('openai-compat', 'model') || aiSetting('openai-compat', 'model') || 'llama3.2';
  const cfg = getContextConfigFor('openai-compat');
  const globalMax = cfg.maxTokensOut;
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const temperature = openaiCompatTemp(temperatureOverride);
  // Optionaler Bearer-Token: gehostete OpenAI-kompatible Endpoints (vLLM, LiteLLM,
  // OpenAI selbst) verlangen ihn; lokale llama.cpp-Server brauchen ihn meist nicht.
  // Leer = kein Authorization-Header. Profil-Key vor globalem Key — zwei Endpunkte
  // desselben Providers haben in aller Regel verschiedene Zugaenge.
  const apiKey = String(aiApiKey('openai-compat') || '').trim();
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

  // Hard-Timeout ueber den ganzen Call (fetch UND Stream); User-Cancel bleibt aktiv.
  // `signalState.timedOut` trennt Timeout von Abbruch — beides kommt sonst als
  // AbortError an und der Job-Catch verbuchte einen haengenden Server als User-Abbruch.
  const timeoutMs = _timeoutMs();
  const { signal: combinedSignal, cleanup, state: signalState } = combineSignals(signal, timeoutMs, 'OpenAI-kompatibel');
  try {
  let resp;
  try {
    resp = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: combinedSignal,
    });
  } catch (fetchErr) {
    if (signalState.timedOut) throw timeoutError('OpenAI-kompatibel', timeoutMs);
    if (fetchErr.name === 'AbortError') throw fetchErr;
    if (_connErrorCode(fetchErr)) throw _unreachableError('openai-compat', host, fetchErr);
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel fetch fehlgeschlagen (${host}): ${fetchErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (RETRY_STATUS.has(resp.status)) {
      throw overloadError('OpenAI-kompatibel', resp.status, parseRetryAfter(resp),
        `OpenAI-kompatibel ${resp.status}: ${detail.slice(0, 300)}`);
    }
    throw new Error(`OpenAI-kompatibel ${resp.status}: ${detail || resp.statusText}`);
  }

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
    if (signalState.timedOut) throw timeoutError('OpenAI-kompatibel', timeoutMs);
    if (streamErr.name === 'AbortError') throw streamErr;
    if (_connErrorCode(streamErr)) throw _unreachableError('openai-compat', host, streamErr);
    const cause = streamErr.cause?.message || streamErr.cause?.code || '';
    throw new Error(`OpenAI-kompatibel Stream-Abbruch (${host}): ${streamErr.message}${cause ? ' – ' + cause : ''}`);
  }
  if (!tokensIn)  tokensIn  = estimatedTokIn;
  if (!tokensOut) tokensOut = Math.ceil(text.length / CHARS_PER_TOKEN);
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text, truncated, tokensIn, tokensOut, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0, genDurationMs, provider: 'openai-compat', model };
  } finally {
    cleanup();
  }
}

module.exports = { _callOpenAICompat };
