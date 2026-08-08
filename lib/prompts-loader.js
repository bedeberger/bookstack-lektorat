'use strict';
// Lazy-Loader für public/js/prompts.js (ESM) aus CJS-Kontext.
//
// ZWEI INSTANZEN, eine pro Provider-KLASSE: die Prompt-Schicht baut für lokale
// Modelle abgemagerte Varianten (kein JSON_ONLY, kompakte Basisregeln, reduzierte
// Schemas — siehe public/js/prompts/state.js). Die Entscheidung hängt an einem
// Modul-Flag (`_isLocal`), die tatsächliche Provider-Auflösung aber am User
// (app_users.ai_provider_override, siehe lib/ai/config.js#resolveProvider). Eine
// einzige, global konfigurierte Instanz gibt im Mischbetrieb darum systematisch
// die Prompts des jeweils anderen Providers aus:
//   - Cloud-Prompts an ein lokales Modell → Felder, die das _isLocal-Gating
//     bewusst weglässt, weil kleine Modelle sie halluzinieren (machtverhaltnis,
//     aeusseres/stimme/hintergrund/arc).
//   - Slim-Prompts an Claude → die JSON_ONLY-Pflichtanweisung fehlt, und bei
//     Claude-Modellen ohne Structured-Output-Support erzwingt dann keine Schicht
//     mehr reines JSON.
//
// Darum wird pro Klasse ein eigener Modulgraph geladen und EINMAL konfiguriert.
// Nicht pro Call umkonfigurieren: die Job-Queue läuft parallel, und Konsumenten
// halten die Namespace-Referenz über `await`-Grenzen hinweg (`const prompts =
// await getPrompts()` … später `prompts.SCHEMA_X`) — ein Flip zwischendurch
// würde ihnen den Boden unter den Füssen wegziehen.
//
// PROMPTS_VERSION unterscheidet sich zwischen den Instanzen (Content-Hash über die
// gebauten Prompts). Das ist korrekt und braucht keinen Bump des Basis-Prefix:
// alle provider-partitionierten Cache-Tabellen führen `provider` im PRIMARY KEY
// (lektorat_cache, synonym_cache, chapter_review_cache, book_review_cache,
// chapter_macro_review_cache, chapter_extract_cache, book_extract_cache,
// motif_brainstorm_cache, tagebuch_rueckblick_cache), und jeder cacheVersion-String
// enthält zusätzlich `_modelName(effectiveProvider)`. Die Varianten können sich
// also nicht gegenseitig ihre Rows überschreiben.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const appSettings = require('./app-settings');
const { resolveProvider, providerClass } = require('./ai/config');
const logger = require('../logger');

function _globalProvider() {
  return String(appSettings.get('ai.provider') || 'claude').toLowerCase();
}

let _promptConfig = null;
function getPromptConfig() {
  if (_promptConfig) return _promptConfig;
  _promptConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'prompt-config.json'), 'utf8'));
  return _promptConfig;
}

// Repräsentativer Provider je Klasse — nur der `_isLocal`-Flag hängt davon ab,
// nicht das konkrete Modell (das kommt pro Call aus lib/ai).
const VARIANT_PROVIDER = { cloud: 'claude', local: 'ollama' };

// Klassen-Entscheidung ist SSoT in lib/ai/config.js#providerClass — dort flippt
// `ai.openai-compat.cloud` openai-compat auf 'cloud' (gehostete Frontier-APIs).
function promptVariantFor(provider) {
  return providerClass(provider);
}

// Query-Parameter, der die Variante durch den Modulgraphen trägt. SSoT hier; der
// Hook bekommt ihn via register(data).
const VARIANT_PARAM = 'promptVariant';

// Loader-Hook registrieren (idempotent). Ohne ihn dupliziert die Marker-Query nur
// die Einstiegsdatei, während `prompts/state.js` mit dem `_isLocal`-Flag geteilt
// bliebe — siehe lib/prompts-variant-hooks.mjs. `module.register` gibt es ab
// Node 20.6; package.json erlaubt >=20, darum der Fallback auf EINE Instanz nach
// globalem Provider (= Verhalten ohne diesen Umbau) statt eines Crashs.
let _hooksState = null;   // 'on' | 'off'
function _ensureHooks() {
  if (_hooksState) return _hooksState;
  try {
    const { register } = require('node:module');
    if (typeof register !== 'function') throw new Error('module.register fehlt');
    register('./prompts-variant-hooks.mjs', {
      parentURL: pathToFileURL(__filename).href,
      data: { param: VARIANT_PARAM },
    });
    _hooksState = 'on';
  } catch (e) {
    logger.warn(`Prompt-Varianten: ESM-Loader-Hook nicht verfügbar (${e.message}). `
      + 'Fallback auf eine gemeinsame Prompt-Instanz nach globalem ai.provider — '
      + 'Per-User-Provider-Override wirkt dann nicht auf die Prompt-Variante. Node >= 20.6 nötig.');
    _hooksState = 'off';
  }
  return _hooksState;
}

const PROMPTS_ENTRY = pathToFileURL(path.resolve(__dirname, '..', 'public', 'js', 'prompts.js')).href;
const _instances = new Map();   // variant → Promise<module namespace>

function _loadVariant(variant) {
  // Ohne Loader-Hook teilen beide Varianten einen Modulgraphen. Dann darf es nur
  // EINEN Cache-Eintrag geben — eine zweite Konfiguration wuerde die erste
  // ueberschreiben statt eine eigene Instanz zu ergeben.
  const hooks = _ensureHooks();
  const key = hooks === 'on' ? variant : 'shared';
  const cached = _instances.get(key);
  if (cached) return cached;
  const p = (async () => {
    if (hooks !== 'on') {
      const mod = await import(PROMPTS_ENTRY);
      mod.configurePrompts(getPromptConfig(), _globalProvider());
      return mod;
    }
    const mod = await import(`${PROMPTS_ENTRY}?${VARIANT_PARAM}=${variant}`);
    mod.configurePrompts(getPromptConfig(), VARIANT_PROVIDER[variant]);
    return mod;
  })();
  _instances.set(key, p);
  return p;
}

// Prompt-Instanz für den EFFEKTIVEN Provider dieses Users. Ohne `userEmail` zieht
// resolveProvider den User aus dem ALS-Context (Job-Worker setzt ihn in
// routes/jobs/shared/queue.js#drainQueue) — ausserhalb eines Job-/Request-Kontexts
// bleibt es beim globalen Provider.
function getPrompts(userEmail = null) {
  return _loadVariant(promptVariantFor(resolveProvider({ userEmail })));
}

// Für Aufrufer, die den effektiven Provider schon aufgelöst haben (z.B. der
// Chat-Titel-Job bekommt ihn als Argument) — spart die zweite Auflösung und
// bindet die Variante an genau den Provider, mit dem auch der Call rausgeht.
// Ohne Argument dieselbe Auflösung wie callAI (ALS-Context) statt eines stillen
// Cloud-Defaults — sonst könnte die Prompt-Variante vom Call auseinanderlaufen.
function getPromptsForProvider(provider) {
  const p = String(provider || '').toLowerCase() || resolveProvider({});
  return _loadVariant(promptVariantFor(p));
}

module.exports = { getPrompts, getPromptsForProvider, getPromptConfig, promptVariantFor };
