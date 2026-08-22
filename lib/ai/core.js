'use strict';
// Provider-Dispatch: callAI / callAIChat / callAIWithTools. Wählt den Provider
// (Override > global), flattet System-Prompts für lokale Provider und serialisiert
// lokale Calls über den Mutex. Gibt { text, tokensIn, tokensOut, … } zurück.

const { resolveProvider, providerSupportsTools } = require('./config');
const { withOllamaLock, withOpenAICompatLock } = require('./shared');
const { _callClaude, _callClaudeWithTools } = require('./claude');
const { _callOllama } = require('./ollama');
const { _callOpenAICompat, _callOpenAICompatWithTools } = require('./openai-compat');

// jsonSchema: optionales JSON-Schema für Grammar-Constrained Decoding (nur lokale Provider).
// Wenn gesetzt, erzwingt llama.cpp/Ollama strukturkonformes JSON (inkl. korrekt escapete Strings).
// Claude ignoriert das Argument.
// onProgress({ chars, tokIn }): optionaler Callback während des Streamings.
// tier: optionales Per-Call-Tier für Claude (Tiered Routing). Entweder ein nackter
// Modellname (rückwärtskompatibel) oder `{ model, effort, label }` — siehe
// normalizeTier in lib/ai/shared.js. Nur Claude; lokale Provider ignorieren es.
async function callAI(userPrompt, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema, tier) {
  const messages = [{ role: 'user', content: userPrompt }];
  return callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema, undefined, undefined, tier);
}

// Multi-Turn-Variante von callAI: akzeptiert ein vollständiges Messages-Array
// (user/assistant-Wechsel) statt eines einzelnen User-Prompts.
// cacheLastMessage: Cache-Breakpoint auf die letzte Message (Multi-Turn-Caching,
// nur Claude — siehe _callClaude). Lokale Provider kennen kein Prompt-Caching und
// ignorieren das Flag.
async function callAIChat(messages, systemPrompt, onProgress, maxTokensOverride, signal, provider, jsonSchema, temperatureOverride, cacheLastMessage, tier) {
  provider = provider || resolveProvider();

  // Lokale Provider kennen kein Prompt-Caching → Array-Form (mehrere Cache-Blöcke)
  // auf einen String flatten. Claude behält die Array-Form und erzeugt daraus
  // separate cache_control-Blöcke (für Cross-Call-Caching, z.B. Buchtext über
  // mehrere Phasen hinweg).
  const flatSystem = (provider !== 'claude' && Array.isArray(systemPrompt))
    ? systemPrompt.map(b => b.text).join('\n\n')
    : systemPrompt;

  if (provider === 'ollama') {
    return withOllamaLock(() => _callOllama(messages, flatSystem, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride));
  }
  if (provider === 'openai-compat') {
    return withOpenAICompatLock(() => _callOpenAICompat(messages, flatSystem, onProgress, maxTokensOverride, signal, jsonSchema, temperatureOverride));
  }
  // jsonSchema fliesst bei Claude in output_config.format (Structured Outputs, siehe
  // _callClaude) — bisher nur von lokalen Providern (Grammar) genutzt, Claude ignorierte es.
  return _callClaude(messages, systemPrompt, onProgress, maxTokensOverride, signal, cacheLastMessage, tier, jsonSchema);
}

// Tool-Use-Round-Trip. Zwei Provider koennen es: Claude (native tool_use-Blocks,
// siehe lib/ai/claude.js) und openai-compat (Function-Calling, uebersetzt in
// lib/ai/tool-translate.js). Ollama hat keinen Pfad — dort wirft der Call, und der
// Caller muss auf den klassischen Buch-Chat umschalten. Wer vorher wissen will, ob
// dieser Provider Werkzeuge kann, fragt `providerSupportsTools` (SSoT in config.js).
//
// `messages` ist in BEIDEN Faellen die kanonische Anthropic-Form (Content-Blocks
// `tool_use`/`tool_result`); das Ergebnis traegt `toolUses` / `stopReason` /
// `rawContentBlocks` — damit bleibt routes/jobs/agentic-chat.js provider-neutral.
async function callAIWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal, provider) {
  provider = provider || resolveProvider();
  if (!providerSupportsTools(provider)) {
    const err = new Error(`Tool-Use nicht unterstützt für Provider '${provider}' – Caller muss auf Fallback-Pfad umschalten.`);
    err.code = 'AI_TOOLS_UNSUPPORTED';
    throw err;
  }
  if (provider === 'openai-compat') {
    // Lokale Provider kennen kein Prompt-Caching → System-Block-Array flatten
    // (gleiche Regel wie in callAIChat) und über den Semaphor serialisieren.
    const flatSystem = Array.isArray(systemPrompt) ? systemPrompt.map(b => b.text).join('\n\n') : systemPrompt;
    return withOpenAICompatLock(() => _callOpenAICompatWithTools(messages, flatSystem, tools, onProgress, maxTokensOverride, signal));
  }
  return _callClaudeWithTools(messages, systemPrompt, tools, onProgress, maxTokensOverride, signal);
}

module.exports = { callAI, callAIChat, callAIWithTools };
