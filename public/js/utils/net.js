// Netzwerk- und Status-Helper: Fetch-Wrapper mit OK-Check + verzögerter
// Status-Reset.

/**
 * Fetch mit Pflicht-OK-Check und JSON-Parsing. Wirft bei HTTP-Fehlern,
 * damit der `.then(r => r.json())`-Pattern nicht stillschweigend HTML-
 * Fehlerseiten als JSON parst. 401 läuft durch den globalen fetch-Wrapper
 * in app.js (dispatcht `session-expired`) und wirft hier dann einen Fehler.
 *
 * Der geworfene Error trägt `status` (HTTP-Code) bzw. `status = 0` bei
 * Netzwerk-/Offline-Fehlern. Aufrufer können damit zwischen „Server sagt
 * nein" (4xx, Retry sinnlos) und „Blip" (5xx/Netzwerk, Retry sinnvoll)
 * unterscheiden, statt jeden Fehler gleich zu behandeln.
 */
export async function fetchJson(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    e.status = 0;
    throw e;
  }
  if (!r.ok) {
    let detail = '';
    try { const e = await r.clone().json(); detail = e.error || e.message || ''; } catch (_) {}
    const err = new Error(detail ? `HTTP ${r.status}: ${detail}` : `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/**
 * True, wenn ein `fetchJson`-Fehler ein transienter Blip ist (Netzwerk-Ausfall
 * oder 5xx) und ein Retry Sinn ergibt. 4xx sind bewusst ausgenommen: ein 403
 * (fehlendes Recht) oder 404 antwortet beim zweiten Versuch identisch, und ein
 * wiederholter 401 löst über den globalen fetch-Wrapper ein zweites
 * `session-expired` aus.
 */
export function isRetriableFetchError(err) {
  const s = err?.status;
  if (s == null) return true;      // unbekannte Fehlerquelle → einmal nachfassen
  return s === 0 || s >= 500;
}

/**
 * `fetchJson` mit JSON-Body-Boilerplate: setzt Methode + Content-Type-Header
 * und serialisiert `body` (weggelassen, wenn falsy — z.B. DELETE ohne Payload).
 * Ersetzt das an vielen Stellen ausgeschriebene
 * `{ method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(...) }`.
 */
export function sendJson(url, method, body) {
  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Löscht eine Alpine-Status-Property nach `delay`, wenn sie dann noch den
 * gesetzten Wert trägt. Verhindert, dass spätere Status-Updates durch einen
 * verzögerten Reset überschrieben werden – eigenes setTimeout-Idiom, das sich
 * an mehreren Stellen wiederholte.
 */
export function clearStatusAfter(obj, prop, expected, delay) {
  setTimeout(() => {
    if (obj[prop] === expected) obj[prop] = '';
  }, delay);
}

export async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
