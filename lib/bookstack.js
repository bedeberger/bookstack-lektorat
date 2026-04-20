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

/**
 * GET /api/<path>. Wirft bei !ok einen Error mit `status` und `bodyText`.
 * Caller können das in i18nError / UI-spezifische Fehler umpacken.
 */
async function bsGet(path, token, { timeoutMs = 30000 } = {}) {
  const resp = await fetch(`${BOOKSTACK_URL}/api/${path}`, {
    headers: { Authorization: authHeader(token) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    const err = new Error(`BookStack /api/${path}: HTTP ${resp.status}`);
    err.status = resp.status;
    err.bodyText = bodyText;
    throw err;
  }
  return resp.json();
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

module.exports = { bsGet, bsGetAll, authHeader, BOOKSTACK_URL };
