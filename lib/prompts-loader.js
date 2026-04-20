'use strict';
// Lazy-Loader für public/js/prompts.js (ESM) aus CJS-Kontext.
// Idempotent: configurePrompts() wird genau einmal aufgerufen, Ergebnis gecacht.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let _promptConfig = null;
function getPromptConfig() {
  if (_promptConfig) return _promptConfig;
  _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'prompt-config.json'), 'utf8'));
  return _promptConfig;
}

let _promptsPromise = null;
function getPrompts() {
  if (_promptsPromise) return _promptsPromise;
  _promptsPromise = (async () => {
    const mod = await import(pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'prompts.js')).href);
    mod.configurePrompts(getPromptConfig(), process.env.API_PROVIDER || 'claude');
    return mod;
  })();
  return _promptsPromise;
}

module.exports = { getPrompts, getPromptConfig };
