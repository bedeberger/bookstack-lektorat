'use strict';
// Stubs lib/ai callAI via require.cache. Must be loaded BEFORE any module that
// requires lib/ai (routes/jobs/shared.js etc).
//
// Dispatcher matches each call against a list of registered handlers; first
// matching handler returns canned response. Handlers receive {prompt, system, schema}
// and return either a JS object (auto-serialized) or a string.

const path = require('path');
const realAi = require('../../../lib/ai');

const handlers = [];
const log = [];

function _systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(s => (typeof s === 'string' ? s : (s?.text || ''))).join('\n');
  return system?.text || '';
}

function _toResponse(result, prompt, system) {
  const obj = typeof result === 'function' ? result({ prompt, system }) : result;
  // Handler may return a raw callAI response shape (for testing truncated etc).
  if (obj && typeof obj === 'object' && obj.__raw) {
    const r = obj.__raw;
    return {
      text: r.text || '',
      truncated: !!r.truncated,
      tokensIn: r.tokensIn ?? Math.ceil((prompt?.length || 0) / 4),
      tokensOut: r.tokensOut ?? Math.ceil((r.text || '').length / 4),
      genDurationMs: r.genDurationMs ?? 1,
    };
  }
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return {
    text,
    truncated: false,
    tokensIn: Math.ceil((prompt?.length || 0) / 4),
    tokensOut: Math.ceil(text.length / 4),
    genDurationMs: 1,
  };
}

async function callAI(prompt, system, onProgress, _maxTok, _signal, _provider, jsonSchema) {
  const sys = _systemText(system);
  const entry = { prompt, system: sys, schema: jsonSchema, schemaKeys: jsonSchema ? Object.keys(jsonSchema?.properties || {}) : [] };
  log.push(entry);
  for (const h of handlers) {
    if (h.match(entry)) {
      const resp = _toResponse(h.respond, prompt, sys);
      if (typeof onProgress === 'function') onProgress({ chars: resp.text.length, tokIn: resp.tokensIn });
      return resp;
    }
  }
  throw new Error(`mock-ai: no handler matched. system="${sys.slice(0, 80)}" schemaKeys=${entry.schemaKeys.join(',')}`);
}

function on(matcher, respond) {
  const match = typeof matcher === 'function' ? matcher : (entry) => Object.keys(matcher).every(k => {
    if (k === 'systemIncludes') return entry.system.includes(matcher.systemIncludes);
    if (k === 'schemaHas') return entry.schemaKeys.includes(matcher.schemaHas);
    if (k === 'promptIncludes') return entry.prompt.includes(matcher.promptIncludes);
    return true;
  });
  handlers.push({ match, respond });
}

function reset() {
  handlers.length = 0;
  log.length = 0;
}

function install() {
  const aiPath = path.resolve(__dirname, '..', '..', '..', 'lib', 'ai.js');
  const stub = { ...realAi, callAI };
  require.cache[require.resolve(aiPath)] = {
    id: aiPath,
    filename: aiPath,
    loaded: true,
    exports: stub,
    children: [],
    paths: [],
  };
}

module.exports = { install, on, reset, log };
