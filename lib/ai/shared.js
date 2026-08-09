'use strict';
// Provider-übergreifende Helfer: Concurrency-Locks für lokale Provider, Connection-
// Fehler-Erkennung, i18n-keyed Unreachable-Error, Output-Runaway-Grenze.

const { profileKey, aiSettingByProfileKey } = require('./profile');

// Sicherheitsgrenze für lokale Modelle: Abbruch wenn Output-Tokens das N-fache
// der Input-Tokens übersteigen. Verhindert endlose Wiederholungsschleifen.
const MAX_OUTPUT_RATIO = 4;

// Ollama verarbeitet parallele Anfragen schlecht (VRAM-Überlauf, Verbindungsabbruch).
// Dieser Mutex serialisiert alle Ollama-Calls global – Jobs laufen weiter parallel,
// nur die eigentlichen KI-Aufrufe kommen nacheinander am Server an.
function makeLock() {
  let queue = Promise.resolve();
  return function withLock(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {}); // Fehler nicht in die Queue-Chain leiten
    return next;
  };
}

// Semaphore mit dynamisch gelesener Obergrenze: erlaubt bis zu `getLimit()`
// gleichzeitige Calls, überzählige warten. `getLimit` wird pro Slot-Freigabe
// neu ausgewertet, sodass eine Admin-Setting-Änderung sofort greift. limit=1
// verhält sich wie ein Mutex. Für openai-compat-Server (z.B. LocalAI), die eine
// begrenzte Zahl paralleler Requests vertragen.
function makeSemaphore(getLimit) {
  let active = 0;
  const waiters = [];
  function pump() {
    const limit = Math.max(1, Math.floor(getLimit()) || 1);
    while (waiters.length && active < limit) {
      active++;
      const { fn, resolve, reject } = waiters.shift();
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  }
  return function withSlot(fn) {
    return new Promise((resolve, reject) => {
      waiters.push({ fn, resolve, reject });
      pump();
    });
  };
}

// Ein Bucket je Ziel-Endpunkt statt eines globalen Zaehlers: Profile desselben
// Providers zeigen auf verschiedene Server (ein lokales llama.cpp und ein
// gehostetes Frontier-Modell), und die vertragen verschieden viel Last. Ein
// gemeinsamer Zaehler wuerde entweder den lokalen Server ueberfahren oder den
// gehosteten kuenstlich ausbremsen. `null` (kein Profil) ist der Bucket der
// globalen Einstellung.
function makeKeyedGate(makeGate) {
  const gates = new Map();
  return function withGate(key, fn) {
    const k = key || '__global__';
    let gate = gates.get(k);
    if (!gate) { gate = makeGate(k); gates.set(k, gate); }
    return gate(fn);
  };
}

const _ollamaGates = makeKeyedGate(() => makeLock());
const _openAICompatGates = makeKeyedGate(
  (bucketKey) => makeSemaphore(() => Number(aiSettingByProfileKey('openai-compat', 'max_parallel', bucketKey)))
);

function withOllamaLock(fn) {
  return _ollamaGates(profileKey('ollama'), fn);
}
function withOpenAICompatLock(fn) {
  return _openAICompatGates(profileKey('openai-compat'), fn);
}

// ── Hard-Timeout + Backoff: geteilt von Claude und openai-compat ─────────────
// Beide sprechen einen entfernten HTTP-Endpunkt an, beide koennen mitten im Stream
// verstummen, beide muessen 429/Overload aussitzen. Die Mechanik ist identisch und
// gehoert genau einmal hierher — der Unterschied zwischen den Providern liegt in der
// Frage, WELCHE Antwort transient ist (Anthropic: 429/529 + overloaded_error im Body;
// OpenAI-kompatibel: 408/429/5xx), nicht darin, wie danach gewartet wird.

/** Kombiniert User-Signal und Hard-Timeout zu EINEM Signal.
 *  `state.timedOut` unterscheidet Timeout von User-Cancel — ohne den Marker liefert
 *  fetch in beiden Faellen `AbortError`, und der Job-Catch verbucht einen haengenden
 *  Endpunkt faelschlich als Abbruch durch den User.
 *  `label` geht in die Fehlermeldung (Provider-Name). */
function combineSignals(userSignal, timeoutMs, label = 'AI') {
  const ctrl = new AbortController();
  const state = { timedOut: false };
  const onAbort = () => ctrl.abort(userSignal?.reason);
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    state.timedOut = true;
    ctrl.abort(new Error(`${label}-Timeout nach ${timeoutMs}ms`));
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    userSignal?.removeEventListener?.('abort', onAbort);
  };
  return { signal: ctrl.signal, cleanup, state };
}

/** Timeout-Fehler mit `code: 'AI_TIMEOUT'` — die Job-Schicht stuft genau diesen Code
 *  als transient ein (routes/jobs/shared/ai.js#_isTransientAiError). */
function timeoutError(label, timeoutMs) {
  const err = new Error(`${label}-Timeout nach ${timeoutMs}ms`);
  err.code = 'AI_TIMEOUT';
  return err;
}

/** await-bares sleep, das auf ein Abort-Signal reagiert (User-Cancel waehrend des
 *  Backoffs soll nicht erst nach Ablauf der Wartezeit greifen). */
function sleep(ms, signal) {
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

/** `Retry-After`-Header in Sekunden (nur positive Ganzzahlen; die HTTP-Datums-Form
 *  liefern die hier bedienten APIs nicht). */
function parseRetryAfter(resp) {
  const v = resp?.headers?.get?.('retry-after');
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Exponential-Backoff mit Jitter (1s/2s/4s …), `Retry-After` schlaegt ihn. */
function retryDelayMs(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000 + Math.random() * 250, 30000);
  }
  return 1000 * Math.pow(2, attempt) + Math.random() * 500;
}

/** Transienter Provider-Fehler (Overload/Rate-Limit). Traegt `code: 'AI_OVERLOADED'`,
 *  woran die Retry-Schleife des jeweiligen Providers ihn erkennt. */
function overloadError(label, status, retryAfterSec, message) {
  const err = new Error(message || `${label} overloaded (status=${status || 'stream'})`);
  err.code = 'AI_OVERLOADED';
  err.status = status || null;
  err.retryAfterSec = retryAfterSec || null;
  return err;
}

// Erkennt Verbindungs-Fehler (Provider offline/DNS/Timeout) anhand cause.code.
// Liefert null, wenn der Fehler keine Connection-Klasse ist.
const _CONN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH']);
function _connErrorCode(err) {
  const code = err?.cause?.code || err?.code;
  if (code && _CONN_CODES.has(code)) return code;
  // node fetch wrappt DNS/Connect-Fehler oft als generisches "fetch failed".
  if (err?.message === 'fetch failed' && !err?.cause?.code) return 'FETCH_FAILED';
  return null;
}

// Wirft einen i18n-keyed Error für Provider-Unreachable. failJob übergibt
// `i18nParams` als `errorParams` an das Frontend; `t('error.OPENAI_COMPAT_UNREACHABLE', …)`
// rendert die Meldung in der User-Locale.
function _unreachableError(provider, host, fetchErr) {
  const code = _connErrorCode(fetchErr);
  const detail = code || fetchErr?.cause?.message || fetchErr?.message || 'unknown';
  const key = provider === 'ollama' ? 'error.OLLAMA_UNREACHABLE' : 'error.OPENAI_COMPAT_UNREACHABLE';
  const err = new Error(key);
  err.i18nParams = { host, detail };
  err.code = 'AI_UNREACHABLE';
  return err;
}

// ── Preflight: passt der Prompt überhaupt ins Kontextfenster? ────────────────
// Das Kontextfenster trägt Input UND Output. Passt der geschätzte Input nicht in
// den Rest, den `max_tokens` übriglässt, antwortet der Provider mit einem
// undurchsichtigen HTTP 400 (llama.cpp/vLLM: „OpenAI-kompatibel 400: <Server-Text>")
// oder kürzt den Prompt still (Ollama deckelt `num_ctx` selbst) — beides mitten im
// Job, nachdem der User schon gewartet hat, und ohne Hinweis darauf, dass Buch oder
// Kapitel schlicht zu gross war. Darum vor dem Absenden prüfen.
//
// GEKÜRZT WIRD HIER NICHTS: ein automatisch beschnittener Prompt analysierte ein
// halbes Buch und lieferte das Ergebnis als vollständig aus. Der Job soll mit
// klarer Ansage scheitern.
//
// Ersetzt NICHT den truncated-Guard nach dem Call (CLAUDE.md, JSON-Only-Invariante):
// dieser hier deckt „Input zu gross", jener „Output abgeschnitten".
const CONTEXT_OVERFLOW_KEY = 'job.error.aiContextOverflow';

// Zeichenzahl eines Prompt-Teils. Akzeptiert alle Formen der Call-Sites: String,
// Message-Array (`[{ role, content }]`), System-Block-Array (`[{ text, ttl }]`)
// und verschachtelte Content-Block-Arrays.
function _partChars(part) {
  if (!part) return 0;
  if (typeof part === 'string') return part.length;
  if (Array.isArray(part)) return part.reduce((s, p) => s + _partChars(p), 0);
  if (typeof part === 'object') {
    return (typeof part.text === 'string' ? part.text.length : 0) + _partChars(part.content);
  }
  return 0;
}

/** Geschätzte Input-Tokens eines Prompts (Heuristik über charsPerToken — den echten
 *  Wert meldet erst der Provider; genau dafür der Sicherheitspuffer unten). */
function estimatePromptTokens(parts, charsPerToken) {
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : 4;
  return Math.ceil(_partChars(parts) / cpt);
}

/** Wirft einen i18n-keyed Error (Muster wie `_unreachableError`), wenn geschätzter
 *  Input + Output-Cap + Sicherheitspuffer das Kontextfenster sprengen. Gibt sonst
 *  `estTokIn` zurück.
 *  `cfg`: Ergebnis von getContextConfigFor(provider).
 *  `maxTokensOut`: Output-Cap DIESES Calls (Job-Override liegt oft unter cfg.maxTokensOut).
 *  Ohne belastbares Fenster (unvollständige cfg) wird nicht geraten → kein Guard. */
function assertPromptFitsContext({ provider, cfg, maxTokensOut, estTokIn }) {
  const ctxWindow = Number(cfg?.contextWindow) || 0;
  const maxOut = Number(maxTokensOut) || Number(cfg?.maxTokensOut) || 0;
  const margin = Number(cfg?.safetyMargin) || 0;
  const budget = ctxWindow - maxOut - margin;
  if (!(ctxWindow > 0) || !(budget > 0)) return estTokIn;
  if (estTokIn <= budget) return estTokIn;
  const err = new Error(CONTEXT_OVERFLOW_KEY);
  err.i18nParams = {
    provider: provider || cfg?.provider || 'claude',
    tokIn: estTokIn, window: ctxWindow, maxOut, budget,
  };
  err.code = 'AI_CONTEXT_OVERFLOW';
  throw err;
}

// Per-Call-Tier: Modell UND Effort für EINEN Call, ohne den ALS-Context zu mutieren.
// Nötig, weil die Komplettanalyse ihre Extraktions-Calls auf ein anderes Modell mit
// anderer Denk-Tiefe routet als die Konsolidierung — und beide Gruppen laufen über
// `settledAll` PARALLEL. Ein ALS-Patch (setContext) würde dabei den Nachbar-Call
// mittreffen; darum reist das Tier als Argument mit dem Call.
//
// Akzeptiert beide Formen, damit die vielen bestehenden Call-Sites mit nacktem
// Modell-String unverändert bleiben:
//   'claude-sonnet-5'                       → { model: 'claude-sonnet-5' }
//   { model, effort, label }                → unverändert
// `label` klassifiziert den Call für die Kosten-Aufschlüsselung (job.result.costByPhase);
// es beeinflusst den Request NICHT.
function normalizeTier(tier) {
  if (!tier) return {};
  if (typeof tier === 'string') return { model: tier };
  return {
    model: tier.model || undefined,
    effort: tier.effort || undefined,
    label: tier.label || undefined,
  };
}

module.exports = {
  MAX_OUTPUT_RATIO,
  makeLock, makeSemaphore, withOllamaLock, withOpenAICompatLock,
  combineSignals, timeoutError, sleep, parseRetryAfter, retryDelayMs, overloadError,
  _connErrorCode, _unreachableError,
  CONTEXT_OVERFLOW_KEY, estimatePromptTokens, assertPromptFitsContext,
  normalizeTier,
};
