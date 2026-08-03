'use strict';
// Gemeinsamer KI-Aufruf-Helfer – Facade über lib/ai/. Wird von routes/jobs.js,
// routes/figures.js u.v.m. importiert. Gibt { text, tokensIn, tokensOut } zurück.
//
// Interne Aufteilung (Submodule, NICHT direkt importieren – immer diese Facade):
//   ai/config.js        — Provider-Resolution, Token-Budget-Konstanten + Boot-Validierung,
//                         Per-Provider-Temp/Think, Claude-Modell-Parameter (Sampling/Effort).
//   ai/parse.js         — JSON-Parse-Fallback-Kette + Rohtext-Feld-Extraktion.
//   ai/shared.js        — Provider-übergreifend: Mutex-Locks, Connection-Fehler, Unreachable.
//   ai/claude.js        — Claude-Streaming (Text + Tool-Use), Retry/Backoff, Caching-Blocks.
//   ai/ollama.js        — Ollama-Streaming.
//   ai/openai-compat.js — OpenAI-kompatibles Streaming.
//   ai/core.js          — Provider-Dispatch (callAI / callAIChat / callAIWithTools).

const core = require('./ai/core');
const config = require('./ai/config');
const parse = require('./ai/parse');
const shared = require('./ai/shared');

module.exports = {
  callAI: core.callAI,
  callAIChat: core.callAIChat,
  callAIWithTools: core.callAIWithTools,
  parseJSON: parse.parseJSON,
  parseJSONLenient: parse.parseJSONLenient,
  extractStringField: parse.extractStringField,
  chatTemperature: config.chatTemperature,
  ollamaTemp: config.ollamaTemp,
  openaiCompatTemp: config.openaiCompatTemp,
  ollamaThink: config.ollamaThink,
  openaiCompatThink: config.openaiCompatThink,
  CHARS_PER_TOKEN: config.CHARS_PER_TOKEN,
  MAX_TOKENS_OUT: config.MAX_TOKENS_OUT,
  MODEL_CONTEXT: config.MODEL_CONTEXT,
  INPUT_BUDGET_TOKENS: config.INPUT_BUDGET_TOKENS,
  INPUT_BUDGET_CHARS: config.INPUT_BUDGET_CHARS,
  DEFAULT_OLLAMA_TEMP: config.DEFAULT_OLLAMA_TEMP,
  DEFAULT_OPENAI_COMPAT_TEMP: config.DEFAULT_OPENAI_COMPAT_TEMP,
  resolveProvider: config.resolveProvider,
  VALID_PROVIDERS: config.VALID_PROVIDERS,
  getContextConfigFor: config.getContextConfigFor,
  _claudeAcceptsTemperature: config._claudeAcceptsTemperature,
  _claudeUsesAdaptiveThinking: config._claudeUsesAdaptiveThinking,
  _claudeAcceptsEffort: config._claudeAcceptsEffort,
  _isModernClaudeGen: config._isModernClaudeGen,
  _claudeSupportsStructuredOutputs: config._claudeSupportsStructuredOutputs,
  _claudeCharsPerToken: config._claudeCharsPerToken,
  // Per-Call-Tier (Modell + Effort + Kosten-Label): normalizeTier fuer Aufrufer, die
  // ein Tier bauen oder auswerten; _resolveClaudeModel, um den effektiven Modellnamen
  // eines Calls zu bestimmen (Bepreisung in routes/jobs/shared/ai.js).
  normalizeTier: shared.normalizeTier,
  _resolveClaudeModel: config._resolveClaudeModel,
};
