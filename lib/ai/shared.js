'use strict';
// Provider-übergreifende Helfer: Concurrency-Locks für lokale Provider, Connection-
// Fehler-Erkennung, i18n-keyed Unreachable-Error, Output-Runaway-Grenze.

const appSettings = require('../app-settings');

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

const withOllamaLock = makeLock();
const withOpenAICompatLock = makeSemaphore(() => Number(appSettings.get('ai.openai-compat.max_parallel')));

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
  _connErrorCode, _unreachableError,
  normalizeTier,
};
