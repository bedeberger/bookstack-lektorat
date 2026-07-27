// Diktat-Tracking (STT): summiert die Sekunden, während das Mikrofon aufnimmt
// (sttRecording) und der Tab sichtbar ist — Heartbeat alle 15 s, damit bei
// Crash/Tab-Kill max. dieses Intervall verloren geht. Zusätzlich werden die
// diktierten Zeichen gezählt (_trackSttChars, aufgerufen aus stt-dictation.js
// beim Einfügen jedes Transkript-Segments). Beide Werte gehen gemeinsam an
// /history/stt-time. Buchweit wie writing-time (keine page_id). Gelesen wird die
// Tagesreihe in der BookStats-Karte (loadBookStats → sttTimeData).
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { acquireTickLease, clampTickSeconds, releaseTickLease } from './heartbeat.js';

const HEARTBEAT_MS = 15000;

export const sttTimeMethods = {
  _sttActiveSince: null,
  _sttHeartbeatTimer: null,
  _sttCharsPending: 0,

  _sttTimeActive() {
    return !!(this.$store.stt.recording
      && this.$store.nav.selectedBookId
      && document.visibilityState === 'visible');
  },

  _setupSttTime() {
    const signal = this._abortCtrl?.signal;
    const sync = () => {
      if (this._sttTimeActive()) this._startSttHeartbeat();
      else this._stopSttHeartbeat(false);
    };
    this.$watch(() => this.$store.stt.recording, sync);
    this.$watch(() => this.$store.nav.selectedBookId, () => {
      this._stopSttHeartbeat(false);
      if (this._sttTimeActive()) this._startSttHeartbeat();
    });
    document.addEventListener('visibilitychange', sync, { signal });
    window.addEventListener('pagehide', () => this._stopSttHeartbeat(true), { signal });
    sync();
  },

  _startSttHeartbeat() {
    if (this._sttHeartbeatTimer) return;
    this._sttActiveSince = Date.now();
    this._sttHeartbeatTimer = setInterval(() => {
      this._flushSttTime(false);
    }, HEARTBEAT_MS);
  },

  _stopSttHeartbeat(useBeacon) {
    if (this._sttHeartbeatTimer) {
      clearInterval(this._sttHeartbeatTimer);
      this._sttHeartbeatTimer = null;
    }
    this._flushSttTime(useBeacon);
    this._sttActiveSince = null;
    releaseTickLease('stt');
  },

  // Zählt die Zeichen eines eingefügten Transkript-Segments. Wird auch
  // aufgerufen, wenn der Heartbeat schon gestoppt ist (Transkript-Response kommt
  // ggf. nach dem Mic-Stop zurück) — der Flush schickt dann nur die Zeichen.
  _trackSttChars(n) {
    const v = Number(n) || 0;
    if (v <= 0) return;
    this._sttCharsPending = (this._sttCharsPending || 0) + v;
    this._flushSttTime(false);
  },

  _flushSttTime(useBeacon) {
    let seconds = 0;
    if (this._sttActiveSince != null) {
      const now = Date.now();
      // Clamp gegen gestallte Timer — siehe heartbeat.js.
      seconds = clampTickSeconds((now - this._sttActiveSince) / 1000);
      this._sttActiveSince = now;
      // Lease nur auf die Sekunden: die Zeichen zählt der Tab, der sie
      // tatsächlich eingefügt hat, und sie dürfen nie verfallen.
      if (seconds > 0 && !acquireTickLease('stt', now)) seconds = 0;
    }
    const chars = this._sttCharsPending || 0;
    this._sttCharsPending = 0;
    if (seconds <= 0 && chars <= 0) return;
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    const payload = { book_id: Number(bookId), seconds, chars };
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/history/stt-time', blob);
    } else {
      fetch('/history/stt-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  },
};
