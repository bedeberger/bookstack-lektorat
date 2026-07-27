// Geteilte Invarianten der drei Heartbeat-Zeit-Tracker:
//   [writing-time.js](writing-time.js)   — Schreibzeit  (writing_time)
//   [lektorat-time.js](lektorat-time.js) — Lektoratszeit (lektorat_time)
//   [stt-time.js](stt-time.js)           — Diktatzeit    (stt_time)
// Alle drei messen Wall-Clock zwischen zwei Flushes und POSTen den Delta.
// Wer hier etwas ändert, ändert es für alle drei.
//
// A) Tick-Clamp — der Delta ist `now - activeSince`, nicht das Intervall. Stallt
//    der Timer (System-Suspend bei sichtbarem Tab, Tab-Freeze, langer Main-
//    Thread-Task), bucht ein einziger Tick die gesamte Lücke. Der Server clamped
//    erst bei 1 h/Ping, das ist als letzte Verteidigungslinie gedacht, nicht als
//    Normalfall. MAX_TICK_SECONDS deckelt auf zwei Intervalle: genug Luft für
//    verzögerte Timer, zu wenig für eine Suspend-Lücke. Unterzählen ist hier die
//    sichere Richtung — verlorene Sekunden sind harmlos, erfundene nicht.
//
// B) Tab-Lease — pro Tab läuft ein eigener Heartbeat, der Server summiert
//    additiv (`seconds = seconds + excluded.seconds`). Zwei offene Tabs buchen
//    dieselbe Wall-Clock doppelt. Das Lease lässt pro Tracker nur einen Tab
//    zählen; die anderen laufen weiter, senden aber nicht.

// Muss zum HEARTBEAT_MS der Tracker passen (alle drei: 15 s).
const HEARTBEAT_MS = 15000;
const MAX_TICK_SECONDS = (HEARTBEAT_MS / 1000) * 2;

// Lease-Laufzeit: knapp über zwei Intervalle. Der Halter erneuert alle 15 s.
// Stirbt er (Crash, Tab-Kill ohne pagehide), übernimmt ein anderer Tab nach
// spätestens LEASE_MS — Verlust also maximal ein Intervall.
const LEASE_MS = 40000;
const LEASE_PREFIX = 'sw:hb-lease:';

// Pro Tab (nicht pro Gerät) — zwei Tabs desselben Browsers müssen sich
// unterscheiden. Bewusst nicht `getDeviceId()`: das ist persistent pro Gerät und
// in allen Tabs identisch, damit wäre das Lease wirkungslos.
const TAB_ID = (() => {
  try { return globalThis.crypto.randomUUID(); } catch { /* kein WebCrypto */ }
  return 'tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
})();

/**
 * Deckelt einen Tick-Delta auf `max` Sekunden. Nicht-endliche, negative und
 * Null-Werte werden zu 0 (der Aufrufer bricht dann ab).
 */
export function clampTickSeconds(rawSeconds, max = MAX_TICK_SECONDS) {
  const s = Math.round(Number(rawSeconds) || 0);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.min(s, max);
}

// localStorage kann werfen (Safari Private Mode, blockierte Third-Party-
// Cookies). Kein Storage → kein Lease → alle Tabs zählen wie bisher. Lieber
// der alte Doppelzähl-Fall als gar keine Zeiterfassung.
function _store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/**
 * Versucht, das Lease für `name` zu halten oder zu übernehmen. `true` = dieser
 * Tab darf diesen Tick buchen. Direkt vor dem Senden aufrufen, nicht früher:
 * ein Tab, der wegen Idle-Cutoff ohnehin nichts bucht, soll das Lease nicht
 * blockieren, sondern es auslaufen lassen.
 */
export function acquireTickLease(name, now = Date.now()) {
  const store = _store();
  if (!store) return true;
  const key = LEASE_PREFIX + name;
  try {
    let cur = null;
    try { cur = JSON.parse(store.getItem(key) || 'null'); } catch { cur = null; }
    const fresh = cur && Number.isFinite(cur.ts) && (now - cur.ts) < LEASE_MS;
    if (fresh && cur.id !== TAB_ID) return false;
    store.setItem(key, JSON.stringify({ id: TAB_ID, ts: now }));
    // Verify-Read als Billig-CAS: localStorage kennt kein Compare-and-Swap.
    // Haben zwei Tabs gleichzeitig gelesen und geschrieben, sehen beide danach
    // denselben (letzten) Wert — der Verlierer setzt diesen Tick aus.
    const after = JSON.parse(store.getItem(key) || 'null');
    return !!after && after.id === TAB_ID;
  } catch {
    return true; // QuotaExceeded o.ä. → nicht blockieren
  }
}

/**
 * Gibt das Lease frei, wenn dieser Tab es hält. Beim Stoppen des Heartbeats
 * aufrufen, damit ein zweiter Tab sofort übernimmt statt LEASE_MS zu warten.
 */
export function releaseTickLease(name) {
  const store = _store();
  if (!store) return;
  const key = LEASE_PREFIX + name;
  try {
    const cur = JSON.parse(store.getItem(key) || 'null');
    if (cur && cur.id === TAB_ID) store.removeItem(key);
  } catch { /* nichts freizugeben */ }
}

export const _internals = { HEARTBEAT_MS, MAX_TICK_SECONDS, LEASE_MS, LEASE_PREFIX, TAB_ID };
