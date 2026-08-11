// Factory der drei Heartbeat-Zeit-Tracker (Schreibzeit, Lektoratszeit, Diktat).
//
// Die drei messen dasselbe: Wall-Clock zwischen zwei Flushes, gebucht per POST
// als Delta. Identisch sind Timer-Lifecycle, Flush-Pfad (Clamp + Tab-Lease aus
// [heartbeat.js](heartbeat.js)), das Senden (fetch bzw. sendBeacon beim
// Entladen) und die Verdrahtung auf visibilitychange/pagehide/Buchwechsel.
// Genau das erzeugt `makeHeartbeatTracker` — die Tracker-Module halten nur noch
// ihre Unterschiede:
//
//   isActive(ctx)     — wann laeuft der Zaehler ueberhaupt
//   watch             — welche State-Aenderungen ihn starten/stoppen (sync) bzw.
//                       neu starten (restart: Delta wird auf den ALTEN Scope
//                       gebucht, bevor der neue beginnt)
//   onStart(ctx)      — Scope zum Startzeitpunkt einfrieren (Lektorat haengt an
//                       der Seite, nicht am Buch)
//   payload(ctx, s)   — Body des POST; `null` = dieser Tick wird nicht gebucht
//   skipTick(ctx)     — Tick verwerfen, ohne den Zaehler zu stoppen (Idle-Cutoff)
//
// `this`/ctx zeigt auf die Alpine-Root-Komponente (die Methoden werden dort
// hineingespreadet). Die Methodennamen bleiben pro Tracker erhalten — sie sind
// von aussen aufgerufene Oberflaeche (app-init.js, stt/insert.js).

import { acquireTickLease, clampTickSeconds, releaseTickLease, HEARTBEAT_MS } from './heartbeat.js';

// Body an den Server schicken. Beim Entladen per sendBeacon (fetch wird dort
// abgebrochen), sonst keepalive-fetch.
function _send(url, payload, useBeacon) {
  if (useBeacon && navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
    return;
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

// Baut das Methoden-Objekt eines Trackers.
//   name    — Lease-/State-Praefix (writing | lektorat | stt)
//   url     — POST-Ziel
//   methods — die zu erzeugenden Methodennamen (active/setup/start/stop/flush);
//             sie bleiben stabil, weil sie von aussen gerufen werden (s. Modulkopf)
//   spec    — die Unterschiede des Trackers: isActive, watch, onStart, onStop,
//             payload, skipTick, extraSetup
export function makeHeartbeatTracker({ name, url, methods, spec }) {
  const SINCE = `_${name}ActiveSince`;
  const TIMER = `_${name}HeartbeatTimer`;

  const start = function () {
    if (this[TIMER]) return;
    this[SINCE] = Date.now();
    spec.onStart?.call(this, this);
    this[TIMER] = setInterval(() => this[methods.flush](false), HEARTBEAT_MS);
  };

  const stop = function (useBeacon) {
    if (this[TIMER]) {
      clearInterval(this[TIMER]);
      this[TIMER] = null;
    }
    this[methods.flush](useBeacon);
    this[SINCE] = null;
    spec.onStop?.call(this, this);
    releaseTickLease(name);
  };

  const flush = function (useBeacon) {
    let seconds = 0;
    if (this[SINCE] != null) {
      const now = Date.now();
      // Der Delta ist `now - since`, nicht das Intervall — bei gestalltem Timer
      // waere das die ganze Luecke. Clamp + Lease: siehe heartbeat.js.
      seconds = clampTickSeconds((now - this[SINCE]) / 1000);
      this[SINCE] = now;
      if (seconds > 0 && spec.skipTick?.call(this, this, now)) seconds = 0;
      // Lease erst nach einem etwaigen Cutoff: ein Tab, der nichts bucht, soll
      // das Lease nicht halten.
      if (seconds > 0 && !acquireTickLease(name, now)) seconds = 0;
    }
    const payload = spec.payload.call(this, this, seconds);
    if (payload) _send(url, payload, useBeacon);
  };

  const setup = function () {
    const signal = this._abortCtrl?.signal;
    const sync = () => {
      if (this[methods.active]()) this[methods.start]();
      else this[methods.stop](false);
    };
    // Scope-Wechsel: erst auf den alten Scope buchen, dann neu starten.
    const restart = () => {
      this[methods.stop](false);
      if (this[methods.active]()) this[methods.start]();
    };
    for (const w of spec.watch || []) {
      // Alpine ruft den Getter ohne Argumente auf — eine Spec-Funktion erwartet
      // aber den Kontext, also hier binden. Strings gehen direkt durch
      // ($watch loest sie selbst gegen die Komponente auf).
      const get = typeof w.get === 'string' ? w.get : () => w.get(this);
      this.$watch(get, w.restart ? restart : sync);
    }
    document.addEventListener('visibilitychange', sync, { signal });
    window.addEventListener('pagehide', () => this[methods.stop](true), { signal });
    spec.extraSetup?.call(this, this, signal);
    sync();
  };

  return {
    [SINCE]: null,
    [TIMER]: null,
    [methods.active]() { return !!spec.isActive.call(this, this); },
    [methods.setup]: setup,
    [methods.start]: start,
    [methods.stop]: stop,
    [methods.flush]: flush,
  };
}
