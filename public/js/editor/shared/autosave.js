// Auto-Save-Timing der Editoren — SSoT der beiden Konstanten und der
// idle+max-Scheduling-Regel.
//
// Idle-Timer wird bei jeder Schreibaktion zurückgesetzt (speichert erst nach
// einer Tipp-Pause); der Max-Timer läuft ab dem ersten Dirty-Mark durch und
// greift bei Dauer-Tippen. Ohne den Cap sammelt ein durchtippender User
// beliebig viel ungespeicherten Text an, ohne ihn Revision-Spam zu bezahlen.
//
// Notebook-Editor konsumiert nur die Konstanten: seine Timer-Handles müssen am
// Root-Host liegen (`app._autosaveIdleTimer`), weil `_stopAutosave` auch aus
// Root-Kontext über die Trampoline gerufen wird — siehe
// editor/notebook/edit/autosave.js. Der Bucheditor hat pro Block einen eigenen
// Timer und nutzt `createAutosaveTimers`.

import { createTimerBag } from './timers.js';

export const AUTOSAVE_IDLE_MS = 60000;
export const AUTOSAVE_MAX_MS = 120000;

// Pro Key (z.B. pageId) ein Idle- und ein Max-Timer. `fire(key)` wird von dem
// Timer gerufen, der zuerst abläuft; beide Timer des Keys werden dabei
// abgeräumt — der Aufrufer muss nach dem Save nicht selbst aufräumen.
export function createAutosaveTimers(fire, { idleMs = AUTOSAVE_IDLE_MS, maxMs = AUTOSAVE_MAX_MS } = {}) {
  const idle = createTimerBag();
  const max = createTimerBag();

  const clear = (key) => { idle.clear(key); max.clear(key); };
  const trigger = (key) => { clear(key); fire(key); };

  return {
    schedule(key) {
      idle.set(key, () => trigger(key), idleMs);
      max.setOnce(key, () => trigger(key), maxMs);
    },
    clear,
    clearAll() { idle.clearAll(); max.clearAll(); },
  };
}
