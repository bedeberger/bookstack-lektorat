'use strict';
// KI-Konfiguration & Auflösung: Provider-Resolution (global/per-User/ALS-Override),
// Token-Budget-Konstanten (boot-frozen + Validierung), Per-Provider-Temperatur/
// Think/Repeat-Penalty, Claude-Modell-Parameter (Sampling/Thinking/Effort/Caps).

const appSettings = require('../app-settings');
const logger = require('../../logger');
const { getContext } = require('../log-context');
const { aiSetting, profileProvider } = require('./profile');

const VALID_PROVIDERS = new Set(['claude', 'ollama', 'openai-compat']);

// Per-User-Provider-Resolution. Reihenfolge:
//   1. Provider des zugewiesenen KI-Profils (app_users.ai_profile_id)
//   2. app_settings.ai.provider
//   3. Hardcoded 'claude'
// userEmail wird ueblicherweise via ALS-Context aus dem Job/Request gezogen
// (siehe routes/jobs/shared/queue.js#runWithContext). Das Profil traegt neben dem
// Provider auch dessen Parameter (Modell, Host, Kontextfenster …) — die loest
// `aiSetting` aus ./profile auf, ueberall dort, wo frueher direkt
// `appSettings.get('ai.<provider>.<key>')` stand.
function _globalProvider() {
  const v = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
  return VALID_PROVIDERS.has(v) ? v : 'claude';
}

function resolveProvider({ userEmail } = {}) {
  const email = userEmail || getContext().user || null;
  const fromProfile = profileProvider({ userEmail: email });
  if (fromProfile && VALID_PROVIDERS.has(fromProfile)) return fromProfile;
  return _globalProvider();
}

// Provider-KLASSE: 'cloud' = Frontier-Modell (volle Prompts inkl. JSON_ONLY,
// fokussierte Lektorat-Teilpässe, parallele Calls), 'local' = schwaches/lokales
// Modell (Slim-Prompts, Kombi-Call, serielle Verarbeitung, reduzierte Kontextblöcke).
// SSoT für die Klassen-Entscheidung — Konsumenten: lib/prompts-loader.js
// (Prompt-Variante), routes/jobs/lektorat.js (Kontextblöcke + Split),
// routes/jobs/shared/ai.js#settledAll (Serialisierung).
// openai-compat ist per Default 'local' (llama.cpp/vLLM & Co); der Schalter
// `cloud` stuft gehostete Frontier-APIs (z.B. Kimi/Moonshot, OpenAI) auf 'cloud'
// hoch — pro Profil, sonst global (`ai.openai-compat.cloud`). Per-Call gelesen →
// eine Aenderung greift ohne Restart.
// Bewusst KEIN Ersatz fuer `=== 'claude'`-Gates: Claude-API-Faehigkeiten (Prompt-Caching
// inkl. Warmup, Tool-Use, Tiered Routing, phase1_concurrency, Web-Search-Faktencheck)
// haengen weiter am Provider-NAMEN. Alles, was nur ein faehiges Modell braucht —
// Kontinuitaet, Erzaehlprofil, Verify-Filter, Remap-Rescue —, haengt an der Klasse.
function providerClass(provider, opts) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  if (p === 'claude') return 'cloud';
  if (p === 'openai-compat' && aiSetting('openai-compat', 'cloud', opts) === true) return 'cloud';
  return 'local';
}

// Wie viele Calls verträgt dieser Provider gleichzeitig? SSoT für Phasen, die zwei
// unabhängige Calls parallel fahren wollen (z.B. Komplettanalyse P2 Figuren ∥ P3 Orte).
//   claude        — kein providerseitiges Gate hier; die Concurrency bestimmt der
//                   Aufrufer (z.B. `ai.claude.phase1_concurrency` gegen das TPM-Limit).
//   openai-compat — Semaphore mit `ai.openai-compat.max_parallel` (lib/ai/shared.js).
//                   1 = strikt seriell.
//   ollama        — 1: ein globaler Mutex serialisiert dort ALLE Calls (VRAM-Schutz),
//                   parallel angestossene Calls warten nur in der Queue.
// KEIN Ersatz für die Provider-KLASSE: «verträgt parallele Calls» ist eine Aussage über
// den Endpunkt, «ist ein fähiges Modell» eine über die Qualität. Wer parallelisiert, weil
// es schneller ist, fragt hier; wer eine Strategie wählt, fragt `providerClass`.
function maxParallelCalls(provider, opts) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  if (p === 'ollama') return 1;
  if (p === 'openai-compat') {
    return Math.max(1, parseInt(aiSetting('openai-compat', 'max_parallel', opts), 10) || 1);
  }
  return Infinity;
}

// Kann dieser Provider Werkzeuge (Tool-Use / Function-Calling)? SSoT für die
// Pfadwahl des agentischen Buch-Chats (routes/jobs/chat/book-chat.js) UND für den
// Dispatch in ./core.js — beide müssen dieselbe Frage stellen, sonst landet ein
// User im agentischen Pfad, in dem der Call dann wirft.
//   claude        — native tool_use-Blocks.
//   openai-compat — Function-Calling, übersetzt in ./tool-translate.js. Abschaltbar
//                   über `ai.openai-compat.tools` (Endpunkte/Modelle ohne
//                   Tool-Protokoll; der Buch-Chat fällt dann auf den klassischen Pfad).
//   ollama        — kein Pfad implementiert (/api/chat kann `tools`, aber in einem
//                   eigenen Wire-Format; bis dahin klassischer Buch-Chat).
// KEIN Ersatz für die Provider-KLASSE: «kann Werkzeuge» ist eine API-Fähigkeit,
// «ist ein fähiges Modell» eine Qualitätsaussage. Der Recherche-Chat bleibt am
// NAMEN gegated — er braucht Anthropics `web_search`-Server-Tool, nicht bloss
// irgendein Tool-Protokoll.
function providerSupportsTools(provider, opts) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  if (p === 'claude') return true;
  if (p === 'openai-compat') return appSettings.get('ai.openai-compat.tools') !== false;
  return false;
}

// Klasse des Providers, den DIESER User effektiv fährt. Der Normalfall an
// Aufrufstellen, die eine Strategie waehlen (Prompt-Variante, Lektorat-Split,
// Parallelitaet): sie interessiert der User, nicht die globale Einstellung.
function effectiveProviderClass(opts) {
  const email = opts && 'userEmail' in opts ? opts.userEmail : undefined;
  const provider = resolveProvider(email === undefined ? {} : { userEmail: email });
  return providerClass(provider, opts);
}

// Durchschnittliche Zeichen pro Token – bestimmt die Umrechnung zwischen Text-Länge
// und Token-Budget. Tokenizer-abhängig: Claude komprimiert deutschen Text effizient
// (~3 chars/token); moderne SentencePiece-Tokenizer von Mistral/Llama liegen bei
// ~4 chars/token auf deutschem Fliesstext (gemessen an Mistral-Small3.2). Falscher
// Wert → Input-Budget grob unter-/überschätzt → entweder 400-Fehler vom Provider
// oder massiv unterausgelasteter Kontext. Admin-Setting `ai.chars_per_token` für
// Modelle mit abweichendem Tokenizer.
// Boot-frozen: Budget-Ableitungen (SINGLE_PASS_LIMIT etc.) lesen den Wert beim
// Modul-Load anderer Files. Admin-PUT erfordert App-Restart.
const _PROVIDER = String(appSettings.get('ai.provider') || 'claude').toLowerCase();
const _CHARS_PER_TOKEN_DEFAULT = _PROVIDER === 'claude' ? 3 : 4;
const CHARS_PER_TOKEN = appSettings.has('ai.chars_per_token')
  ? Number(appSettings.get('ai.chars_per_token')) || _CHARS_PER_TOKEN_DEFAULT
  : _CHARS_PER_TOKEN_DEFAULT;

// Maximale Output-Tokens.
const MAX_TOKENS_OUT = Number(appSettings.get('ai.claude.max_tokens_out')) || 64000;

// Gesamtes Kontextfenster des Modells (Input + Output). Für Claude-API provider-
// seitig fix (200K), für lokale Modelle vom User zu setzen je nach Deployment
// (Mistral-Small3.2: 128K, Gemma3-12B: 128K, kleinere Modelle oft 32K oder 8K).
const MODEL_CONTEXT = Number(appSettings.get('ai.claude.context_window')) || 200000;

// Sicherheitspuffer für Tokenisierungs-Unsicherheit und System-Prompt-Overhead,
// den CHARS_PER_TOKEN nicht exakt trifft. PROPORTIONAL zum Fenster, weil der Fehler
// der Char→Token-Heuristik mit der Prompt-Länge mitwächst: bei 72 000 geschätzten
// Input-Tokens deckt ein absoluter Puffer von 2000 weniger als 3 % Schätzabweichung
// ab — auf deutschem Fliesstext liegt CHARS_PER_TOKEN je nach Tokenizer aber leicht
// um 5 % daneben, und das sind dort 3600 Tokens. 3 % des Fensters skalieren mit.
// Untergrenze 2000: bei einem 8K-Fenster wären 3 % (240 Tokens) wirkungslos.
// Fenster-Default je Provider, wenn in app_settings keiner steht. Steht hier oben, weil
// schon der Boot-Konsistenz-Check ihn braucht; `getContextConfigFor` weiter unten liest
// dieselbe Tabelle. Fuer Ollama/openai-compat 32 000 (typisch fuer 32K-Modelle) — der
// Admin setzt via `ai.<provider>.context_window` hoeher.
const PROVIDER_CONTEXT_DEFAULTS = { claude: 200000, ollama: 32000, 'openai-compat': 32000 };

const CONTEXT_SAFETY_MIN = 2000;
const CONTEXT_SAFETY_FRACTION = 0.03;
function contextSafetyMargin(contextWindow) {
  const ctx = Number(contextWindow) || 0;
  return Math.max(CONTEXT_SAFETY_MIN, Math.round(ctx * CONTEXT_SAFETY_FRACTION));
}

// Hard-Check: max_tokens_out muss genug Platz für Input lassen — pro Provider.
// Sonst kollabieren abgeleitete Budgets auf ihre Mindestwerte, und lokale Provider
// (llama.cpp/Ollama) schicken max_tokens > num_ctx → 400-Fehler.
for (const p of ['claude', 'ollama', 'openai-compat']) {
  const ctx = Number(appSettings.get(`ai.${p}.context_window`));
  const out = Number(appSettings.get(`ai.${p}.max_tokens_out`));
  if (!ctx || !out) continue;
  const margin = contextSafetyMargin(ctx);
  if (out + margin >= ctx) {
    throw new Error(
      `Fehlkonfiguration: ai.${p}.max_tokens_out (${out}) + Sicherheitspuffer (${margin}) ` +
      `>= ai.${p}.context_window (${ctx}). max_tokens_out ist der Output-Cap und muss deutlich kleiner ` +
      `sein als das gesamte Kontextfenster context_window (Input + Output). Beispiel für Mistral-Small3.2: ` +
      `context_window=128000, max_tokens_out=16000.`
    );
  }
}

// Komplett-Override-Konsistenz: der obige Loop deckt nur die globalen Keys ab. Ein
// gesetztes ai.<provider>.max_tokens_out.komplett muss genug Platz fürs Input lassen — gegen
// ai.<provider>.context_window.komplett (falls gesetzt) bzw. sonst gegen das globale
// Kontextfenster. Ohne diesen Check kollabiert eine inkonsistente Override (z.B. 128K Output
// auf einem versehentlich auf 100K gesetzten Komplett-Kontext) das Input-Budget still auf
// den 2000-Token-Floor und die Extraktion sieht nur einen Bruchteil des Buchs.
// Beide Provider mit Komplett-Override-Satz (SSoT der Liste:
// routes/jobs/komplett/job-shared.js#KOMPLETT_OVERRIDE_PROVIDERS).
for (const p of ['claude', 'openai-compat']) {
  const kOut = parseInt(appSettings.get(`ai.${p}.max_tokens_out.komplett`), 10) || 0;
  if (!kOut) continue;
  const kCtx = (parseInt(appSettings.get(`ai.${p}.context_window.komplett`), 10) || 0)
    || Number(appSettings.get(`ai.${p}.context_window`)) || PROVIDER_CONTEXT_DEFAULTS[p];
  const kMargin = contextSafetyMargin(kCtx);
  if (kOut + kMargin >= kCtx) {
    throw new Error(
      `Fehlkonfiguration: ai.${p}.max_tokens_out.komplett (${kOut}) + Sicherheitspuffer ` +
      `(${kMargin}) >= effektives Komplett-Kontextfenster (${kCtx}). Setze ` +
      `ai.${p}.context_window.komplett höher oder max_tokens_out.komplett tiefer ` +
      `(z.B. Opus 4.8: context_window.komplett=1000000, max_tokens_out.komplett=128000).`
    );
  }
}

const INPUT_BUDGET_TOKENS = MODEL_CONTEXT - MAX_TOKENS_OUT - contextSafetyMargin(MODEL_CONTEXT);
const INPUT_BUDGET_CHARS  = INPUT_BUDGET_TOKENS * CHARS_PER_TOKEN;

logger.info(`AI-Budget: context=${MODEL_CONTEXT} out=${MAX_TOKENS_OUT} margin=${contextSafetyMargin(MODEL_CONTEXT)} inputBudget=${INPUT_BUDGET_TOKENS} tok (~${INPUT_BUDGET_CHARS} chars, ${CHARS_PER_TOKEN} chars/tok)`);

// Default-Temperaturen für lokale Provider – shared mit routes/proxies.js, damit
// Job-Pfad und Editor-Proxy-Pfad bei fehlender Env denselben Wert sehen.
const DEFAULT_OLLAMA_TEMP = 0.2;
const DEFAULT_OPENAI_COMPAT_TEMP = 0.1;

function ollamaTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(aiSetting('ollama', 'temperature'));
  return Number.isFinite(v) ? v : DEFAULT_OLLAMA_TEMP;
}
function openaiCompatTemp(override) {
  if (override != null && Number.isFinite(override)) return override;
  const v = Number(aiSetting('openai-compat', 'temperature'));
  return Number.isFinite(v) ? v : DEFAULT_OPENAI_COMPAT_TEMP;
}

// Anti-Loop: repeat_penalty pro lokalem Provider aus app_settings (1.0 = aus).
// Bricht Wiederholungsschleifen bei grammar-constrained JSON-Decoding.
function ollamaRepeatPenalty() {
  const v = Number(aiSetting('ollama', 'repeat_penalty'));
  return Number.isFinite(v) && v >= 1 ? v : 1.15;
}
function openaiCompatRepeatPenalty() {
  const v = Number(aiSetting('openai-compat', 'repeat_penalty'));
  return Number.isFinite(v) && v >= 1 ? v : 1.15;
}

// Reasoning/„Thinking" pro lokalem Provider. false = unterdrücken (spart Output-
// Tokens für die <think>-Spur, die wir ohnehin verwerfen), true = Modell denken
// lassen. Per-Call gelesen → Admin-Änderung greift ohne Server-Restart.
function ollamaThink() {
  return aiSetting('ollama', 'think') === true;
}
function openaiCompatThink() {
  return aiSetting('openai-compat', 'think') === true;
}

// Chat-spezifische Temperatur-Override (nur Ollama/Llama). Wenn `ai.chat_temperature`
// in app_settings gesetzt ist, übersteuert sie die Provider-Defaults – aber nur für
// Seiten- und Buch-Chat. Andere Job-Typen (Review, Lektorat, Komplett-Analyse) bleiben
// auf ihren Provider-Defaults, weil sie deterministische Analyse-Antworten brauchen.
function chatTemperature() {
  if (!appSettings.has('ai.chat_temperature')) return null;
  const n = Number(appSettings.get('ai.chat_temperature'));
  return Number.isFinite(n) ? n : null;
}

// ── Per-Call-Auflösung (global ODER Per-Job-Override via ALS-Context) ────────
// Die Komplettanalyse-Familie kann Modell, Kontextfenster, Output-Cap und Timeout
// eigenständig setzen (z.B. Opus 4.8 mit 128K Output, während global Sonnet 4.6 / 64K
// läuft) — und zwar für JEDEN Provider, nicht nur für Claude: ein gehostetes
// Frontier-Modell über openai-compat hat dieselbe Trennung zwischen Alltags- und
// Analyse-Konfiguration.
// modelOverride bei `_resolveClaudeModel`: optionaler per-Call-Modellname (Tiered
// Routing der Komplettanalyse — mechanische Extraktions-Calls auf ein günstigeres Modell
// als die Konsolidierung/das Urteil). Präzedenz: per-Call > Per-Job-ALS-Override >
// Profil > globales Setting. Parallel-safe, weil als Argument durchgereicht (kein
// ALS-Mutieren zwischen nebenläufigen Calls). Das PROFIL steht zwischen ALS-Override und
// globalem Setting: der Per-Job-Override ist die speziellere Aussage und gewinnt, das
// Profil schlaegt aber die Instanz-Einstellung.
//
// Per-Job-Override-Bag im ALS-Context: `setContext({ aiJob: { provider, model,
// contextWindow, maxTokensOut, timeoutMs, effort } })`. Gesetzt wird er von den
// Job-Familien, die mit eigener Modell-/Fenster-Konfiguration laufen duerfen
// (Komplettanalyse: routes/jobs/komplett/job-shared.js#_komplettAiOverrides;
// Buch-Chat: routes/jobs/chat/book-chat.js).
//
// Der Bag traegt seinen `provider` MIT, und gelesen wird er nur, wenn der Anfrager
// derselbe ist. Sonst bekaeme ein Call gegen einen anderen Provider die Parameter
// eines fremden Modells — dieselbe Falle, gegen die auch das Profil-Overlay in
// ./profile abgesichert ist (ein Claude-Modellname als `model` an einen llama.cpp-Server).
// Leerstring/0/null zaehlen als „nicht gesetzt", damit ein leeres Admin-Feld auf den
// globalen Wert zurueckfaellt statt ihn zu loeschen.
function jobOverride(provider, field) {
  const bag = getContext().aiJob;
  if (!bag || bag.provider !== provider) return undefined;
  const v = bag[field];
  return (v === null || v === undefined || v === '') ? undefined : v;
}

function _resolveClaudeModel(modelOverride) {
  return modelOverride || jobOverride('claude', 'model') || aiSetting('claude', 'model') || 'claude-sonnet-4-6';
}
function _resolveClaudeContextWindow() {
  return Number(jobOverride('claude', 'contextWindow')) || Number(aiSetting('claude', 'context_window')) || 200000;
}
function _resolveClaudeMaxOut() {
  return Number(jobOverride('claude', 'maxTokensOut')) || Number(aiSetting('claude', 'max_tokens_out')) || MAX_TOKENS_OUT;
}

// Hartes Output-Token-Ceiling pro Claude-Modell: die API lehnt höhere `max_tokens` mit
// HTTP 400 (invalid_request_error) ab — und 400 ist NICHT in RETRY_STATUS, killt also den
// gesamten Job non-retryable. Eine Fehlkonfiguration (z.B. max_tokens_out.komplett=150000 für
// Opus, das nur 128000 erlaubt) wird hier still aufs Modell-Limit geklemmt statt zum Job-Kill
// zu führen. Konservativ am Modellstring (greift auch bei Suffix-Varianten wie "…[1m]"):
// Opus 4.x/5+, Sonnet 5+ und Fable/Mythos 5+ = 128000, alle übrigen = 64000.
// Ein zu TIEFER Wert hier kostet nur Output-Headroom (Truncation-Risiko bei sehr grossen
// Antworten), ein zu HOHER killt den Job mit non-retryable HTTP 400 — darum bleiben
// Sonnet 4.6/4.5 und Haiku bewusst bei 64000, auch wenn die Modelle mehr könnten.
function _claudeModelMaxOut(model) {
  const m = String(model || '');
  const wide = /claude-opus-(?:4-|[5-9]|\d\d)/.test(m)
    || /claude-sonnet-(?:[5-9]|\d\d)\b/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m);
  return wide ? 128000 : 64000;
}

// „Moderne" Claude-Generation: Sampling-Parameter (temperature/top_p/top_k) ENTFERNT
// (gesetzter Wert → HTTP 400), Thinking adaptiv (kein budget_tokens), neuer Tokenizer.
// Deckt Opus 4.7/4.8/4.9…, Sonnet 5+ und Fable/Mythos 5+ ab. Opus/Sonnet 4.6 und älter
// bleiben klassisch (temperature erlaubt, kein thinking-Feld). Am Modellstring, damit ein
// Modellwechsel (global oder per-Job via ALS) automatisch das richtige Verhalten wählt;
// trifft auch Suffix-Varianten (z.B. "claude-opus-4-8[1m]").
// WICHTIG: Sonnet 5 lehnt Sampling-Parameter ebenfalls ab — die frühere reine Opus-4.7+-
// Regex hätte einen künftigen `ai.claude.model = claude-sonnet-5` mit temperature:0.2
// bestückt und JEDEN Call mit non-retryable HTTP 400 gekillt.
// WICHTIG: Opus 5 lehnt Sampling-Parameter ebenfalls ab — die frühere Regex traf nur
// `claude-opus-4-…` und hätte ein `ai.claude.model = claude-opus-5` als „klassisch"
// eingestuft, mit temperature:0.2 bestückt und JEDEN Call non-retryable gekillt.
function _isModernClaudeGen(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[789]|\d\d)/.test(m)          // Opus 4.7, 4.8, 4.9, 4.1x…
    || /claude-opus-(?:[5-9]|\d\d)/.test(m)              // Opus 5+
    || /claude-sonnet-(?:[5-9]|\d\d)\b/.test(m)          // Sonnet 5+
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m); // Fable/Mythos 5+
}
function _claudeAcceptsTemperature(model) {
  return !_isModernClaudeGen(model);
}
function _claudeSamplingParams(model) {
  return _claudeAcceptsTemperature(model) ? { temperature: 0.2 } : {};
}

// Structured Outputs (output_config.format = json_schema) — GA auf Fable/Mythos 5,
// Opus 4.7/4.8, Sonnet 5, Haiku 4.5 sowie Legacy Opus 4.5/4.1. Für Sonnet 4.6/4.5 und
// älter NICHT bestätigt → dort NICHT senden (sonst 400). Konservative Allowlist; der
// Provider (claude.js) hat zusätzlich ein 400-Fallback-Netz, das output_config.format
// bei Ablehnung einmalig weglässt. Am Modellstring (Suffix-tolerant).
function _claudeSupportsStructuredOutputs(model) {
  const m = String(model || '');
  return _isModernClaudeGen(m)
    || /claude-opus-4-(?:1|5)\b/.test(m)   // Opus 4.1 / 4.5 (Legacy, unterstützt)
    || /claude-haiku-4-5/.test(m);         // Haiku 4.5
}

// Adaptive Thinking pro Claude-Modell. Opus 4.7+ schreiben bei DEAKTIVIERTEM Thinking
// (= kein `thinking`-Feld) zunehmend Reasoning-Prosa in den sichtbaren Output. Bei den
// JSON-Only-Pipelines (Komplettanalyse/Kontinuität/Lektorat) bläht das die Antwort auf,
// bis sie ans max_tokens-Ceiling stösst (`stop_reason: max_tokens` → truncated → Wurf
// gemäss JSON-Only-Invariante) oder das JSON mit Prosa verunreinigt — Symptom: „kein
// Output". Adaptive Thinking verlagert das Reasoning in Thinking-Blöcke (`display`
// defaultet auf 'omitted'), der sichtbare Text-Stream bleibt reines JSON. `budget_tokens`
// ist auf Opus 4.7+ entfernt (400), adaptive hat keinen Budget-Parameter. Greift am
// Modellstring (gleiche Generationen-Erkennung wie _claudeAcceptsTemperature) → ein
// Modellwechsel via ALS-Override schaltet es automatisch passend. Sonnet 4.6 / Opus 4.6
// haben diese Regression nicht und bleiben unverändert (kein thinking-Feld).
function _claudeUsesAdaptiveThinking(model) {
  return _isModernClaudeGen(model);
}
function _claudeThinkingParams(model) {
  return _claudeUsesAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {};
}

// Effort-Parameter (`output_config.effort`) steuert Denk-Tiefe + Token-Spend auf
// Opus 4.5+ und Sonnet 4.6. Wird ausschliesslich per ALS-Override (`aiJob.effort`)
// gesetzt – aktuell nur vom Buch-Chat (ai.claude.effort.bookchat → _applyBookChatAiOverrides).
// Kein globaler ai.claude.effort-Read: ohne Override bleiben alle anderen Job-Pfade
// (Komplett/Review/Lektorat) unverändert (= API-Default 'high', kein Feld gesendet).
const _CLAUDE_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// `override` (Per-Call-Tier, siehe normalizeTier in ./shared) schlägt den ALS-Wert.
// Parallel-safe: das Tier reist als Argument mit, statt den geteilten ALS-Store zu
// patchen — sonst würde ein Extraktions-Call mit eigenem Effort die parallel
// laufenden Konsolidierungs-Calls mitverstellen.
function _resolveClaudeEffort(override) {
  const raw = override != null && String(override).trim() !== '' ? override : jobOverride('claude', 'effort');
  const s = raw != null ? String(raw).trim().toLowerCase() : '';
  return _CLAUDE_EFFORT_VALUES.has(s) ? s : null;
}
// effort 400t auf Sonnet 4.5 / Haiku 4.5. Die 5er-Serie (Opus 5, Sonnet 5, Fable/Mythos 5)
// unterstützt die volle Leiter low…max; bei den 4.x-Modellen ist `max` Opus-tier-only und
// `xhigh` Opus-4.7+-only. Tier-Mismatch wird auf 'high' geklemmt statt zu werfen (analog
// _claudeAcceptsTemperature).
function _claudeAcceptsEffort(model) {
  const m = String(model || '');
  return /claude-opus-4-(?:[5-9]|\d\d)/.test(m)
    || /claude-sonnet-4-(?:[6-9]|\d\d)/.test(m)
    || _isModernClaudeGen(m);           // deckt Opus 5+, Sonnet 5+, Fable/Mythos 5+ ab
}
// Die Leiter ist feiner als „Opus vs. Sonnet": `max` kam mit Opus 4.6 UND Sonnet 4.6
// (Opus 4.5 kennt nur low/medium/high), `xhigh` erst mit Opus 4.7. Die 5er-Serie
// unterstützt beide. Ein nicht unterstützter Wert wird auf 'high' geklemmt statt gesendet.
function _claudeOutputConfigParams(model, effortOverride) {
  let effort = _resolveClaudeEffort(effortOverride);
  if (!effort || !_claudeAcceptsEffort(model)) return {};
  const m = String(model || '');
  const isGen5 = /claude-(?:opus|sonnet)-(?:[5-9]|\d\d)/.test(m)
    || /claude-(?:fable|mythos)-(?:[5-9]|\d\d)/.test(m);
  const allowsMax   = isGen5 || /claude-opus-4-(?:[6-9]|\d\d)/.test(m) || /claude-sonnet-4-(?:[6-9]|\d\d)/.test(m);
  const allowsXhigh = isGen5 || /claude-opus-4-(?:[789]|\d\d)/.test(m);
  if (effort === 'max' && !allowsMax) effort = 'high';
  if (effort === 'xhigh' && !allowsXhigh) effort = 'high';
  return { output_config: { effort } };
}

// Per-Provider Context-Config. Boot-Konstanten (`INPUT_BUDGET_TOKENS` etc.)
// bleiben fuer Backwards-Compat — sie repraesentieren den Globalwert beim Server-Start.
// Code-Pfade mit auflusbarem userEmail nutzen `getContextConfigFor(provider)`, um
// das per-Provider-Limit zu lesen. Fehlt fuer Ollama/Llama ein eigenes context_window
// in app_settings, faellt es auf 32 000 (typisch fuer 32K-Modelle) zurueck — der
// Admin kann via `ai.ollama.context_window` / `ai.openai-compat.context_window` hoeher setzen.
// Modell-abhängige Zeichen/Token-Rate für Claude. Der Opus-4.7+/Sonnet-5/Fable-Tokenizer
// produziert ~1×–1.35× mehr Tokens als der alte (deutscher Fliesstext ~2.4–2.6 chars/Token
// statt ~3). Der globale `ai.chars_per_token` (Default 3) passt für Sonnet 4.6 (alter
// Tokenizer, Prod-Modell), UNTERschätzt aber die Tokenzahl der modernen Generation und damit
// das Char-Budget → zu optimistische Single-Pass-/Chunk-Grenzen. Für moderne Modelle daher
// konservativer (2.5), sofern der Admin `ai.chars_per_token` nicht explizit tiefer gesetzt hat.
// Trifft NUR den Claude-Pfad; lokale Provider bleiben unberührt.
const _MODERN_CLAUDE_CHARS_PER_TOKEN = 2.5;
function _claudeCharsPerToken(model) {
  if (!_isModernClaudeGen(model)) return CHARS_PER_TOKEN;
  return Math.min(CHARS_PER_TOKEN, _MODERN_CLAUDE_CHARS_PER_TOKEN);
}

function getContextConfigFor(provider) {
  const p = VALID_PROVIDERS.has(provider) ? provider : 'claude';
  // Claude liest via Resolver (ALS-Per-Job-Override → global), damit die
  // Komplettanalyse mit eigenem Kontextfenster/Output-Cap rechnet, ohne die
  // globalen (z.B. Sonnet-) Calls zu beeinflussen.
  let ctx, maxOut, cpt;
  if (p === 'claude') {
    ctx = _resolveClaudeContextWindow();
    maxOut = _resolveClaudeMaxOut();
    // Tokenizer-Rate am effektiven (Per-Job-Override → globalen) Claude-Modell: so rechnet
    // die Opus-4.8-Komplettanalyse mit 2.5, während globale Sonnet-4.6-Calls bei 3 bleiben.
    cpt = _claudeCharsPerToken(_resolveClaudeModel());
  } else {
    // Gleiche Reihenfolge wie bei Claude: Per-Job-Override (Komplettanalyse) schlaegt
    // das Profil, das Profil die Instanz-Einstellung. Ohne den Override-Read faehrt ein
    // gehostetes Frontier-Modell ueber openai-compat die Analyse mit dem globalen
    // Alltags-Fenster — genau der Wert, der fuer Lektorat/Chat gesetzt ist.
    ctx = Number(jobOverride(p, 'contextWindow')) || Number(aiSetting(p, 'context_window')) || PROVIDER_CONTEXT_DEFAULTS[p];
    maxOut = Number(jobOverride(p, 'maxTokensOut')) || Number(aiSetting(p, 'max_tokens_out')) || MAX_TOKENS_OUT;
    cpt = CHARS_PER_TOKEN || 4;
  }
  const safety = contextSafetyMargin(ctx);
  // Ein Profil kann eine Kombination tragen, die der Boot-Check (er prueft nur die
  // globalen Keys) nie gesehen hat. Statt das Input-Budget still auf den Floor
  // kollabieren zu lassen, wird es hier gemeldet — die Route validiert beim
  // Speichern, das hier ist das Netz fuer Zeilen, die anders hineingekommen sind.
  if (maxOut + safety >= ctx) {
    logger.warn(`AI-Profil-Konflikt (${p}): max_tokens_out=${maxOut} + Puffer=${safety} >= context_window=${ctx}. `
      + 'Das Input-Budget faellt auf den Mindestwert — Profil korrigieren.');
  }
  const inputBudgetTokens = Math.max(2000, ctx - maxOut - safety);
  return {
    provider: p,
    contextWindow: ctx,
    maxTokensOut: maxOut,
    charsPerToken: cpt,
    // Der Preflight-Guard (assertPromptFitsContext in ./shared) rechnet den Puffer
    // NICHT selbst nach — sonst driftet er von der Budget-Ableitung hier weg.
    safetyMargin: safety,
    inputBudgetTokens,
    inputBudgetChars: inputBudgetTokens * cpt,
  };
}

module.exports = {
  VALID_PROVIDERS, resolveProvider, providerClass, effectiveProviderClass, providerSupportsTools,
  maxParallelCalls,
  CHARS_PER_TOKEN, MAX_TOKENS_OUT, MODEL_CONTEXT, contextSafetyMargin,
  INPUT_BUDGET_TOKENS, INPUT_BUDGET_CHARS,
  DEFAULT_OLLAMA_TEMP, DEFAULT_OPENAI_COMPAT_TEMP,
  ollamaTemp, openaiCompatTemp, ollamaRepeatPenalty, openaiCompatRepeatPenalty,
  ollamaThink, openaiCompatThink, chatTemperature,
  getContextConfigFor, jobOverride,
  _resolveClaudeModel, _resolveClaudeContextWindow, _resolveClaudeMaxOut, _claudeModelMaxOut,
  _claudeSamplingParams, _claudeThinkingParams, _claudeOutputConfigParams,
  _claudeAcceptsTemperature, _claudeUsesAdaptiveThinking, _claudeAcceptsEffort,
  _isModernClaudeGen, _claudeSupportsStructuredOutputs, _claudeCharsPerToken,
};
