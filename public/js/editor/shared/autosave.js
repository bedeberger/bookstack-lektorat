// Auto-Save-Timing der Editoren — SSoT der beiden Konstanten und der
// idle+max-Scheduling-Regel.
//
// Idle-Timer wird bei jeder Schreibaktion zurückgesetzt (speichert erst nach
// einer Tipp-Pause); der Max-Timer läuft ab dem ersten Dirty-Mark durch und
// greift bei Dauer-Tippen. Ohne den Cap sammelt ein durchtippender User
// beliebig viel ungespeicherten Text an, ohne ihn Revision-Spam zu bezahlen.
//
// Beide Editoren nutzen `createAutosaveTimers`: der Bucheditor mit einem Key pro
// Block (pageId), der Notebook-Editor mit genau einem Key — er bearbeitet immer
// nur eine Seite. Dessen Bag liegt am Root-Host, weil `_stopAutosave` auch aus
// Root-Kontext über die Trampoline gerufen wird (siehe
// editor/notebook/edit/autosave.js).

import { createTimerBag } from './timers.js';

export const AUTOSAVE_IDLE_MS = 60000;
export const AUTOSAVE_MAX_MS = 120000;

/**
 * Pro Key (z.B. pageId) ein Idle- und ein Max-Timer. Der Timer, der zuerst
 * abläuft, räumt BEIDE Timer des Keys ab und ruft dann `fire(key)` — der
 * Aufrufer muss nach dem Save nicht selbst aufräumen.
 *
 * @param {(key: any) => void} [fire] Default-Auslöser.
 * @param {{idleMs?: number, maxMs?: number}} [opts]
 */
export function createAutosaveTimers(fire, { idleMs = AUTOSAVE_IDLE_MS, maxMs = AUTOSAVE_MAX_MS } = {}) {
  const idle = createTimerBag();
  const max = createTimerBag();

  const clear = (key) => { idle.clear(key); max.clear(key); };

  return {
    /**
     * @param {any} key
     * @param {(key:any)=>void} [fireNow] Überschreibt `fire` für diesen Aufruf.
     *   Für Konsumenten, deren Auslöser an ein `this` gebunden ist, das über die
     *   Lebensdauer des Bags wechseln kann (Alpine-Karte wird neu gemountet):
     *   ein bei der Konstruktion eingefangenes `this` zeigte dann auf eine tote
     *   Instanz. Der Max-Timer behält bewusst den Auslöser seines ERSTEN
     *   Schedules — er misst ab dem ersten Dirty-Mark, nicht ab dem letzten.
     */
    schedule(key, fireNow = fire) {
      const trigger = () => { clear(key); fireNow(key); };
      idle.set(key, trigger, idleMs);
      max.setOnce(key, trigger, maxMs);
    },
    // Läuft für `key` noch ein Timer?
    pending(key) { return idle.has(key) || max.has(key); },
    clear,
    clearAll() { idle.clearAll(); max.clearAll(); },
  };
}
