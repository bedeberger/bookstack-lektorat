// Schreibzeit-Tracking: summiert die Sekunden, während editMode oder focusActive
// aktiv sind, der Tab sichtbar ist UND der User innerhalb von IDLE_MS eine
// bewusste Eingabe (Taste, Klick, Scroll) gemacht hat. Heartbeat alle 15 s,
// damit bei Crash/Tab-Kill max. dieses Intervall verloren geht. Zusätzlicher
// Flush bei visibilitychange, pagehide und State-Wechseln.
//
// Idle-Cutoff (IDLE_MS): ein offen gelassener Editor ohne Eingabe akkumuliert
// nach Ablauf der Schwelle keine Zeit mehr — sonst zählt blosses Offenhalten als
// Schreibzeit. Editor öffnen / Tab wieder sichtbar machen gilt als Aktivität.
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { fetchJson } from '../utils.js';
import { acquireTickLease, clampTickSeconds, releaseTickLease } from './heartbeat.js';

const HEARTBEAT_MS = 15000;
const IDLE_MS = 180000; // 3 min ohne bewusste Eingabe → Editor gilt als untätig
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'input'];

export const writingTimeMethods = {
  _writingActiveSince: null,
  _writingHeartbeatTimer: null,
  _writingLastActivity: null,

  _writingTimeActive() {
    return !!((this.editMode || this.focusActive)
      && this.$store.nav.selectedBookId
      && document.visibilityState === 'visible');
  },

  _setupWritingTime() {
    const signal = this._abortCtrl?.signal;
    const sync = () => {
      if (this._writingTimeActive()) this._startWritingHeartbeat();
      else this._stopWritingHeartbeat(false);
    };
    this.$watch('editMode',       sync);
    this.$watch('focusActive',    sync);
    this.$watch(() => this.$store.nav.selectedBookId, () => {
      this._stopWritingHeartbeat(false);
      if (this._writingTimeActive()) this._startWritingHeartbeat();
    });
    document.addEventListener('visibilitychange', sync, { signal });
    window.addEventListener('pagehide', () => this._stopWritingHeartbeat(true), { signal });
    const onActivity = () => { this._writingLastActivity = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) {
      document.addEventListener(ev, onActivity, { signal, passive: true, capture: true });
    }
    sync();
  },

  _startWritingHeartbeat() {
    if (this._writingHeartbeatTimer) return;
    const now = Date.now();
    this._writingActiveSince = now;
    this._writingLastActivity = now; // Editor öffnen / Tab-Rückkehr = Aktivität
    this._writingHeartbeatTimer = setInterval(() => {
      this._flushWritingTime(false);
    }, HEARTBEAT_MS);
  },

  _stopWritingHeartbeat(useBeacon) {
    if (this._writingHeartbeatTimer) {
      clearInterval(this._writingHeartbeatTimer);
      this._writingHeartbeatTimer = null;
    }
    this._flushWritingTime(useBeacon);
    this._writingActiveSince = null;
    releaseTickLease('writing');
  },

  _flushWritingTime(useBeacon) {
    if (this._writingActiveSince == null) return;
    const now = Date.now();
    // Clamp: bei gestalltem Timer (Suspend, Freeze) wäre der Rohdelta die ganze
    // Lücke — siehe heartbeat.js. Der Rest verfällt bewusst.
    const seconds = clampTickSeconds((now - this._writingActiveSince) / 1000);
    this._writingActiveSince = now;
    if (seconds <= 0) return;
    // Idle-Cutoff: letzte bewusste Eingabe liegt länger als IDLE_MS zurück →
    // Editor offen, aber untätig. Intervall verfällt, statt Zeit zu buchen.
    if (this._writingLastActivity == null || now - this._writingLastActivity > IDLE_MS) return;
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    // Nach dem Idle-Cutoff, damit ein untätiger Tab das Lease nicht hält.
    if (!acquireTickLease('writing', now)) return;
    const payload = { book_id: Number(bookId), seconds };
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/history/writing-time', blob);
    } else {
      fetch('/history/writing-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  },

  async loadWritingTime(bookId) {
    try {
      this.writingTimeData = await fetchJson('/history/writing-time/' + bookId);
    } catch (e) {
      console.error('[loadWritingTime]', e);
    }
  },
};
