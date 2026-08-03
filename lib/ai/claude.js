'use strict';
// Claude-Provider (Anthropic Messages API): Streaming-Calls (Text + Tool-Use),
// Prompt-Caching-Blocks, Retry/Backoff bei Overload/Rate-Limit, Timeout-Signal,
// Modell-spezifische Sampling/Thinking/Effort-Parameter (aus config.js).

const appSettings = require('../app-settings');
const logger = require('../../logger');
const { getContext } = require('../log-context');
const {
  _resolveClaudeModel, _resolveClaudeContextWindow, _resolveClaudeMaxOut, _claudeModelMaxOut,
  _claudeSamplingParams, _claudeThinkingParams, _claudeOutputConfigParams,
  _claudeSupportsStructuredOutputs,
} = require('./config');
const { normalizeTier } = require('./shared');

// Claude-API liefert 529 (Overloaded) und 429 (Rate-Limit) als transiente Fehler. Beide
// retryen mit Exponential-Backoff (1s/2s/4s + Jitter). Stream-`overloaded_error` retried
// nur, wenn noch kein Text/Block emittiert wurde (sonst würde Output dupliziert).
// 503 mit `error.type === 'overloaded_error'` (z. B. "API key validation is temporarily
// unavailable") ist ebenfalls transient – Detection nicht über Status, sondern über
// den Body-Typ (siehe `_isOverloadedBody`).
const RETRY_STATUS = new Set([429, 529]);
function _retryMaxAttempts() {
  return parseInt(appSettings.get('ai.claude.retry_max'), 10) || 3;
}

function _isOverloadedBody(rawText) {
  if (!rawText) return false;
  try {
    const parsed = JSON.parse(rawText);
    return parsed?.error?.type === 'overloaded_error';
  } catch {
    return false;
  }
}

function _parseRetryAfter(resp) {
  const v = resp?.headers?.get?.('retry-after');
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _retryDelayMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000 + Math.random() * 250, 30000);
  }
  const base = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
  return base + Math.random() * 500;
}

function _overloadError(status, retryAfterSec, message) {
  const err = new Error(message || `Claude overloaded (status=${status || 'stream'})`);
  err.code = 'AI_OVERLOADED';
  err.status = status || null;
  err.retryAfterSec = retryAfterSec || null;
  return err;
}

function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Hard-Timeout pro Claude-Call. Schützt gegen hängende Streams (z.B. wenn die
// Anthropic-API die Verbindung stumm hält). User-Cancel (signal) bleibt zusätzlich aktiv.
// Per-Job-Override via ALS-Context (claudeTimeoutMs) > globaler ai.claude.timeout_ms >
// Default. Die Komplettanalyse setzt den Override (job.js), weil Opus langsamer ist und
// der Single-Pass mehrere grosse Calls macht – analog zu Modell/Kontext/Output.
function _claudeTimeoutMs() {
  return Number(getContext().claudeTimeoutMs) || parseInt(appSettings.get('ai.claude.timeout_ms'), 10) || 600000;
}

// Beta-Feature-Header für Claude. Das 1M-Kontextfenster (Input > 200K Tokens)
// ist hinter dem `context-1m-2025-08-07`-Beta gated; ohne ihn lehnt die API
// Requests mit context_window > 200K ab. Greift automatisch, sobald
// ai.claude.context_window > 200000 gesetzt ist (Sonnet 4.x und Opus 4.6+ tragen 1M).
function _claudeBetaHeader() {
  const betas = ['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11'];
  if (_resolveClaudeContextWindow() > 200000) betas.push('context-1m-2025-08-07');
  return betas.join(',');
}

/**
 * Baut Claude-system-Blocks aus String oder Array.
 * String  → ein cache_control-Block (5-min-TTL, Default-Verhalten).
 * Array   → je Eintrag ein Block; {text, ttl?} – ttl:'1h' nutzt den Extended-TTL-Beta.
 *           Mehrere Blöcke = mehrere Cache-Breakpoints (z.B. [Buchtext(1h), Phase-System(5min)]).
 */
function _buildClaudeSystemBlocks(systemPrompt) {
  if (!systemPrompt) return null;
  if (typeof systemPrompt === 'string') {
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  if (Array.isArray(systemPrompt) && systemPrompt.length > 0) {
    return systemPrompt.map(b => {
      // cache:false → volatiler Block OHNE Breakpoint (z.B. die pro Query neu
      // keyword-selektierten Buchseiten im klassischen Buch-Chat). Ein Breakpoint
      // hier wäre ein cache_write, der nie gelesen wird, weil der Block jede Runde
      // andere Bytes trägt. Der Block muss am Ende des Arrays stehen (Präfix-Match).
      if (b.cache === false) return { type: 'text', text: b.text };
      return {
        type: 'text',
        text: b.text,
        cache_control: b.ttl === '1h'
          ? { type: 'ephemeral', ttl: '1h' }
          : { type: 'ephemeral' },
      };
    });
  }
  return null;
}

// Multi-Turn-Caching für den Tool-Use-Loop: setzt einen Cache-Breakpoint auf den
// letzten Content-Block der letzten Nachricht. Pro Iteration wächst die Message-Liste
// (assistant tool_use + user tool_result); ohne Breakpoint wird die ganze History
// jede Runde voll bezahlt. Mit Breakpoint liest Iteration N+1 den Präfix bis Iteration N
// aus dem Cache (Render-Order tools→system→messages; System hat bereits einen Breakpoint,
// macht zusammen 2 von max 4). Klont nur die betroffene Nachricht — die Original-`messages`
// (vom Loop wiederverwendet + persistiert) bleiben unangetastet. String-Content wird in
// einen text-Block mit cache_control gewandelt.
function _withCacheBreakpointOnLastMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const out = messages.slice();
  const i = out.length - 1;
  const last = out[i];
  const cc = { type: 'ephemeral' };
  if (typeof last.content === 'string') {
    out[i] = { ...last, content: [{ type: 'text', text: last.content, cache_control: cc }] };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice();
    const bi = blocks.length - 1;
    blocks[bi] = { ...blocks[bi], cache_control: cc };
    out[i] = { ...last, content: blocks };
  }
  return out;
}

function _combineSignals(userSignal, timeoutMs) {
  const ctrl = new AbortController();
  // `timedOut` markiert den Unterschied zwischen User-Cancel und Timeout.
  // Ohne Marker liefert node-fetch in beiden Fällen `error.name === 'AbortError'`,
  // sodass Job-Catches den Timeout fälschlich als User-Abbruch verbuchen.
  const state = { timedOut: false };
  const onAbort = () => ctrl.abort(userSignal?.reason);
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    ctrl.abort(new Error(`Claude-Timeout nach ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    userSignal?.removeEventListener?.('abort', onAbort);
  };
  return { signal: ctrl.signal, cleanup, state };
}

// cacheLastMessage: setzt einen Cache-Breakpoint auf die letzte Message
// (_withCacheBreakpointOnLastMessage). Nur sinnvoll für Multi-Turn-Chats mit
// über die Turns STABILEM System-Prompt (Seiten-Chat) — dann liest Turn N+1 die
// bisherige Konversation aus dem Cache. Bei volatilem System (klassischer
// Buch-Chat: Seiten pro Query neu selektiert) bringt es nichts, weil eine
// System-Änderung den Messages-Cache ohnehin invalidiert.
// jsonSchema: optionales JSON-Schema. Bei unterstützten Modellen (Opus 4.7+/Sonnet 5/
// Fable/Haiku 4.5/Legacy-Opus, siehe _claudeSupportsStructuredOutputs) wird es als
// output_config.format = json_schema gesendet (Structured Outputs) → garantiert schema-
// valides JSON, kein Prosa-Leak durch adaptive Thinking, kein jsonrepair-Partial-Risiko.
// Lehnt die API es mit HTTP 400 ab (Schema-Grenzverletzung, Modell doch nicht unterstützt),
// wird der Call EINMALIG ohne output_config.format wiederholt (Verhalten wie bisher) statt
// den Job non-retryable zu killen.
async function _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, jsonSchema) {
  const maxAttempts = _retryMaxAttempts();
  let schema = jsonSchema || null;
  let structFallbackUsed = false;
  let attempt = 0;
  while (true) {
    try {
      return await _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, schema);
    } catch (e) {
      if (e?.code === 'AI_STRUCTURED_OUTPUT_UNSUPPORTED' && schema && !structFallbackUsed) {
        structFallbackUsed = true;
        schema = null;
        logger.warn(`Claude Structured-Output abgelehnt (${(e.message || '').slice(0, 140)}) – Retry ohne output_config.format.`);
        continue; // zählt nicht gegen das Overload-Budget
      }
      if (e?.code === 'AI_OVERLOADED' && !signal?.aborted && attempt < maxAttempts - 1) {
        const delay = _retryDelayMs(attempt, e.retryAfterSec);
        logger.warn(`Claude overload (${e.status || 'stream'}), Versuch ${attempt + 1}/${maxAttempts}, retry in ${Math.round(delay)}ms`);
        attempt++;
        await _sleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
}

async function _callClaudeAttempt(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, jsonSchema) {
    // Per-Call-Tier (Modell + Effort), siehe normalizeTier in ./shared: die
    // Komplettanalyse routet Extraktion und Konsolidierung parallel auf verschiedene
    // Modelle/Denk-Tiefen, darum darf hier NICHTS aus dem geteilten ALS-Store gepatcht
    // werden. Ohne Tier bleibt es beim ALS-/Setting-Wert (unverändertes Verhalten).
    const { model: tierModel, effort: tierEffort } = normalizeTier(tier);
    const model = _resolveClaudeModel(tierModel);
    // Konfigurierten/Override-Output-Cap zusätzlich aufs harte Modell-Ceiling klemmen
    // (sonst HTTP 400 → non-retryable Job-Kill bei zu hoch gesetztem max_tokens_out).
    const globalMax = Math.min(_resolveClaudeMaxOut(), _claudeModelMaxOut(model));
    const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
    // output_config kombiniert Effort (ai.claude.effort.* via ALS) und – bei unterstützten
    // Modellen mit Schema – Structured Outputs (format). Beide sind Geschwister-Keys.
    const sentFormat = !!(jsonSchema && _claudeSupportsStructuredOutputs(model));
    const outputConfig = { ...(_claudeOutputConfigParams(model, tierEffort).output_config || {}) };
    if (sentFormat) outputConfig.format = { type: 'json_schema', schema: jsonSchema };
    const body = {
      model, max_tokens: maxTokens,
      ..._claudeSamplingParams(model),
      ..._claudeThinkingParams(model),
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
      messages: cacheLastMessage ? _withCacheBreakpointOnLastMessage(messages) : messages,
      stream: true,
    };
    const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
    if (sysBlocks) body.system = sysBlocks;

    const timeoutMs = _claudeTimeoutMs();
    const { signal: combinedSignal, cleanup, state: signalState } = _combineSignals(signal, timeoutMs);
    try {
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': appSettings.get('ai.claude.api_key') || '',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': _claudeBetaHeader(),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (e) {
      if (signalState.timedOut) {
        const err = new Error(`Claude-Timeout nach ${timeoutMs}ms`);
        err.code = 'AI_TIMEOUT';
        throw err;
      }
      throw e;
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      if (RETRY_STATUS.has(resp.status) || _isOverloadedBody(detail)) {
        const ra = _parseRetryAfter(resp);
        throw _overloadError(resp.status, ra, `Claude ${resp.status}: ${detail.slice(0, 300)}`);
      }
      // Structured-Output-Ablehnung (nur wenn wir format tatsächlich gesendet haben):
      // eigener Code, damit _callClaude einmalig ohne output_config.format retryt statt
      // den Job non-retryable zu killen. Nur bei 400 + einschlägigem Body-Hinweis.
      if (resp.status === 400 && sentFormat && /output_config|json_schema|\bschema\b|\bformat\b/i.test(detail)) {
        const err = new Error(`Claude 400 (structured output): ${detail.slice(0, 200)}`);
        err.code = 'AI_STRUCTURED_OUTPUT_UNSUPPORTED';
        throw err;
      }
      throw new Error(`Claude ${resp.status}: ${detail || resp.statusText}`);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let text = '', buf = '', tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, truncated = false;
    let stopReason = null;
    let t_first = 0, t_last = 0;
    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') { streamDone = true; break; }
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type === 'error') {
          if (ev.error?.type === 'overloaded_error' && text.length === 0) {
            throw _overloadError(null, null, `Claude Stream-Fehler: overloaded_error – ${ev.error?.message || ''}`);
          }
          throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
        }
        if (ev.type === 'message_start' && ev.message?.usage) {
          const u = ev.message.usage;
          cacheCreationIn = u.cache_creation_input_tokens || 0;
          // 1h-TTL-Writes kosten 2x statt 1.25x (5min) — Anteil separat fuer costUsd.
          // cacheCreationIn bleibt das TTL-uebergreifende Total (Anzeige-Kompatibilitaet).
          cacheCreation1hIn = u.cache_creation?.ephemeral_1h_input_tokens || 0;
          cacheReadIn     = u.cache_read_input_tokens || 0;
          tokensIn = (u.input_tokens || 0) + cacheCreationIn + cacheReadIn;
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn });
        }
        if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) tokensOut = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          if (ev.delta?.stop_reason === 'max_tokens') truncated = true;
        }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const now = Date.now();
          if (!t_first) t_first = now;
          t_last = now;
          const delta = ev.delta.text || '';
          text += delta;
          if (onProgress) onProgress({ chars: text.length, tokIn: tokensIn, delta });
        }
      }
    }
    const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
    return { text, truncated, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, genDurationMs, stopReason, provider: 'claude', model };
    } finally {
      cleanup();
    }
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
async function _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  const maxAttempts = _retryMaxAttempts();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal);
    } catch (e) {
      if (e?.code === 'AI_OVERLOADED' && !signal?.aborted && attempt < maxAttempts - 1) {
        const delay = _retryDelayMs(attempt, e.retryAfterSec);
        logger.warn(`Claude overload (${e.status || 'stream'}), Versuch ${attempt + 1}/${maxAttempts}, retry in ${Math.round(delay)}ms`);
        await _sleep(delay, signal);
        continue;
      }
      throw e;
    }
  }
}

async function _callClaudeWithToolsAttempt(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal) {
  const model = _resolveClaudeModel();
  // Output-Cap aufs harte Modell-Ceiling klemmen (siehe _callClaudeAttempt / _claudeModelMaxOut).
  const globalMax = Math.min(_resolveClaudeMaxOut(), _claudeModelMaxOut(model));
  const maxTokens = maxTokensOverride ? Math.min(maxTokensOverride, globalMax) : globalMax;
  const body = {
    model, max_tokens: maxTokens,
    ..._claudeSamplingParams(model),
    ..._claudeThinkingParams(model),
    ..._claudeOutputConfigParams(model),
    messages: _withCacheBreakpointOnLastMessage(messages), stream: true,
  };
  const sysBlocks = _buildClaudeSystemBlocks(systemPrompt);
  if (sysBlocks) body.system = sysBlocks;
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const timeoutMs = _claudeTimeoutMs();
  const { signal: combinedSignal, cleanup, state: signalState } = _combineSignals(signal, timeoutMs);
  try {
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': appSettings.get('ai.claude.api_key') || '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': _claudeBetaHeader(),
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (e) {
    if (signalState.timedOut) {
      const err = new Error(`Claude-Timeout nach ${timeoutMs}ms`);
      err.code = 'AI_TIMEOUT';
      throw err;
    }
    throw e;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    if (RETRY_STATUS.has(resp.status) || _isOverloadedBody(detail)) {
      const ra = _parseRetryAfter(resp);
      throw _overloadError(resp.status, ra, `Claude ${resp.status}: ${detail.slice(0, 300)}`);
    }
    throw new Error(`Claude ${resp.status}: ${detail || resp.statusText}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  // Content-Blocks werden per Index addressiert (content_block_start/delta/stop).
  // Jeder Block ist entweder text oder tool_use; bei tool_use wird input_json
  // in deltas geliefert und muss akkumuliert werden.
  const blocks = []; // [{ type:'text', text } | { type:'tool_use', id, name, _inputJson }]
  let textAcc = '';
  let buf = '';
  let tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreationIn = 0, cacheCreation1hIn = 0, truncated = false;
  let stopReason = null;
  let t_first = 0, t_last = 0;
  let streamDone = false;
  while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6);
      if (raw === '[DONE]') { streamDone = true; break; }
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === 'error') {
        if (ev.error?.type === 'overloaded_error' && textAcc.length === 0 && blocks.filter(Boolean).length === 0) {
          throw _overloadError(null, null, `Claude Stream-Fehler: overloaded_error – ${ev.error?.message || ''}`);
        }
        throw new Error(`Claude Stream-Fehler: ${ev.error?.type} – ${ev.error?.message}`);
      }
      if (ev.type === 'message_start' && ev.message?.usage) {
        const u = ev.message.usage;
        cacheCreationIn = u.cache_creation_input_tokens || 0;
        // 1h-TTL-Anteil separat (2x-Tarif), Total bleibt in cacheCreationIn.
        cacheCreation1hIn = u.cache_creation?.ephemeral_1h_input_tokens || 0;
        cacheReadIn     = u.cache_read_input_tokens || 0;
        tokensIn = (u.input_tokens || 0) + cacheCreationIn + cacheReadIn;
        if (onProgress) onProgress({ chars: textAcc.length, tokIn: tokensIn });
      }
      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: cb.id, name: cb.name, _inputJson: '' };
        } else if (cb.type === 'server_tool_use') {
          // Server-Tool (z.B. web_search): Input kommt wie bei tool_use via
          // input_json_delta. Wird NICHT vom Caller ausgeführt — Anthropic führt es
          // serverseitig in derselben Runde aus. Block muss aber in rawContentBlocks
          // erhalten bleiben, falls das Modell daneben ein Custom-Tool ruft (Re-Send).
          blocks[ev.index] = { type: 'server_tool_use', id: cb.id, name: cb.name, _inputJson: '' };
        } else if (cb.type === 'web_search_tool_result') {
          // Server-Tool-Ergebnis: kommt vollständig im content_block_start (keine
          // Deltas). Verbatim erhalten — gehört beim Re-Send zur assistant-Runde.
          blocks[ev.index] = { type: 'web_search_tool_result', tool_use_id: cb.tool_use_id, content: cb.content };
        } else if (cb.type === 'text') {
          blocks[ev.index] = { type: 'text', text: '' };
        } else if (cb.type === 'thinking') {
          // Adaptive Thinking (Opus 4.7+): Thinking-Block samt `signature` MUSS in der
          // nächsten Runde als erster Block des assistant-Turns zurückgespielt werden,
          // sonst 400 ("assistant message must start with a thinking block"). Bei
          // display:'omitted' (Default) bleibt `thinking` leer, die signature kommt
          // trotzdem via signature_delta — beides wird in rawContentBlocks erhalten.
          blocks[ev.index] = { type: 'thinking', thinking: cb.thinking || '', signature: cb.signature || '' };
        } else if (cb.type === 'redacted_thinking') {
          blocks[ev.index] = { type: 'redacted_thinking', data: cb.data || '' };
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
        } else if (d.type === 'thinking_delta') {
          b.thinking += d.thinking || '';
        } else if (d.type === 'signature_delta') {
          b.signature += d.signature || '';
        }
      }
      if (ev.type === 'content_block_stop') {
        // tool_use / server_tool_use: akkumuliertes input-JSON parsen (kann leer sein → {})
        const b = blocks[ev.index];
        if (b && (b.type === 'tool_use' || b.type === 'server_tool_use')) {
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
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data };
    if (b.type === 'text') return { type: 'text', text: b.text };
    // Server-Tool-Blöcke (web_search) verbatim erhalten — Anthropic verlangt sie
    // beim Re-Send als Teil der assistant-Runde, falls daneben ein Custom-Tool lief.
    if (b.type === 'server_tool_use') return { type: 'server_tool_use', id: b.id, name: b.name, input: b.input || {} };
    if (b.type === 'web_search_tool_result') return { type: 'web_search_tool_result', tool_use_id: b.tool_use_id, content: b.content };
    return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
  });
  const genDurationMs = (t_first && t_last > t_first) ? t_last - t_first : null;
  return { text: textAcc, toolUses, stopReason, rawContentBlocks, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, genDurationMs, truncated, provider: 'claude', model };
  } finally {
    cleanup();
  }
}

module.exports = { _callClaude, _callClaudeWithTools };
