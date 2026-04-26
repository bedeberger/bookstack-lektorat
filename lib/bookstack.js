'use strict';
// Gemeinsamer BookStack-API-Helper – wird von routes/jobs/shared.js, routes/sync.js
// und überall sonst benutzt, wo serverseitig die BookStack-REST-API aufgerufen wird.
// Akzeptiert beide historischen Token-Shapes: `{ id, pw }` (Session) und `{ token_id, token_pw }` (DB).

const BOOKSTACK_URL = (process.env.API_HOST || process.env.BOOKSTACK_URL || 'http://localhost:80').replace(/\/$/, '');

function authHeader(token) {
  if (!token) return `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
  const id = token.id ?? token.token_id ?? '';
  const pw = token.pw ?? token.token_pw ?? '';
  return `Token ${id}:${pw}`;
}

// BookStack/Laravel-Throttle liefert 429 mit `Retry-After` (Sekunden oder HTTP-Date).
// Hilfsfunktion liefert Wartezeit in ms, gedeckelt damit ein böser Header die
// Pipeline nicht ewig blockiert. Fallback null → Caller benutzt Exponential-Backoff.
function _parseRetryAfter(raw) {
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(30000, Math.round(secs * 1000));
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(30000, Math.max(0, date - Date.now()));
  return null;
}

const MAX_RETRY_429 = 3;

/**
 * GET /api/<path>. Wirft bei !ok einen Error mit `status` und `bodyText`.
 * Caller können das in i18nError / UI-spezifische Fehler umpacken.
 *
 * 429 (Rate-Limit) wird bis zu MAX_RETRY_429 Mal mit Retry-After-Backoff wiederholt.
 * Job-Pipelines (bsBatch parallel × 15) treffen das Laravel-Throttle sonst
 * schnell und brechen mitten in Phase 1 der Komplettanalyse ab.
 */
async function bsGet(path, token, { timeoutMs = 30000 } = {}) {
  let lastResp = null;
  for (let attempt = 0; attempt <= MAX_RETRY_429; attempt++) {
    const resp = await fetch(`${BOOKSTACK_URL}/api/${path}`, {
      headers: { Authorization: authHeader(token) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return resp.json();
    lastResp = resp;
    if (resp.status !== 429 || attempt === MAX_RETRY_429) break;
    const wait = _parseRetryAfter(resp.headers.get('Retry-After'))
      ?? Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(rs => setTimeout(rs, wait));
  }
  const bodyText = await lastResp.text().catch(() => '');
  const err = new Error(`BookStack /api/${path}: HTTP ${lastResp.status}`);
  err.status = lastResp.status;
  err.bodyText = bodyText;
  throw err;
}

/** Paginierte GET-Variante: iteriert via `count=500&offset=…` bis alle Einträge geladen. */
async function bsGetAll(path, token, opts) {
  const COUNT = 500;
  let offset = 0;
  const all = [];
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await bsGet(`${path}${sep}count=${COUNT}&offset=${offset}`, token, opts);
    const items = data.data || [];
    all.push(...items);
    if (all.length >= (data.total || 0) || !items.length) break;
    offset += items.length;
  }
  return all;
}

/**
 * Lädt Items (z.B. Pages) batchweise via `mapper(item, signal)` mit Concurrency-
 * Cap und Batch-Timeout. Verhindert, dass ein hängender BookStack-Request
 * die ganze Schleife blockiert: nach `batchTimeoutMs` wird der Batch abgebrochen
 * (laufende Mapper bekommen ein abortiertes Signal).
 *
 * opts:
 *   batchSize        — items pro Welle (Default 15)
 *   batchTimeoutMs   — max. Gesamt-Dauer eines Batches (Default 90s)
 *   onBatch(i,total) — Progress-Callback vor jedem Batch
 *   signal           — AbortSignal vom Job (höchste Priorität)
 *
 * Liefert Array der erfolgreichen `mapper`-Returns (`null` werden gefiltert).
 * Fehler innerhalb eines Mappers werden als `null` behandelt – die Caller
 * wollen typischerweise weiterlaufen, wenn einzelne Pages fehlschlagen.
 */
async function bsBatch(items, mapper, opts = {}) {
  const {
    batchSize = 15,
    batchTimeoutMs = 90000,
    onBatch = null,
    signal = null,
  } = opts;
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (onBatch) onBatch(i, items.length);
    const batch = items.slice(i, i + batchSize);
    const batchCtl = new AbortController();
    const timer = setTimeout(() => batchCtl.abort(), batchTimeoutMs);
    const onParentAbort = () => batchCtl.abort();
    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });
    try {
      const results = await Promise.allSettled(batch.map(it => mapper(it, batchCtl.signal)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value != null) out.push(r.value);
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }
  }
  return out;
}

module.exports = { bsGet, bsGetAll, bsBatch, authHeader, BOOKSTACK_URL };
