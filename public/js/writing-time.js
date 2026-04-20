// Schreibzeit-Tracking: summiert die Sekunden, während editMode oder focusMode
// aktiv sind und der Tab sichtbar ist. Heartbeat alle 15 s, damit bei
// Crash/Tab-Kill max. dieses Intervall verloren geht. Zusätzlicher Flush bei
// visibilitychange, pagehide und State-Wechseln.
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { fetchJson } from './utils.js';

const HEARTBEAT_MS = 15000;

export const writingTimeMethods = {
  _writingActiveSince: null,
  _writingHeartbeatTimer: null,

  _writingTimeActive() {
    return !!((this.editMode || this.focusMode)
      && this.selectedBookId
      && document.visibilityState === 'visible');
  },

  _setupWritingTime() {
    const signal = this._abortCtrl?.signal;
    const sync = () => {
      if (this._writingTimeActive()) this._startWritingHeartbeat();
      else this._stopWritingHeartbeat(false);
    };
    this.$watch('editMode',       sync);
    this.$watch('focusMode',      sync);
    this.$watch('selectedBookId', () => {
      this._stopWritingHeartbeat(false);
      if (this._writingTimeActive()) this._startWritingHeartbeat();
    });
    document.addEventListener('visibilitychange', sync, { signal });
    window.addEventListener('pagehide', () => this._stopWritingHeartbeat(true), { signal });
    sync();
  },

  _startWritingHeartbeat() {
    if (this._writingHeartbeatTimer) return;
    this._writingActiveSince = Date.now();
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
  },

  _flushWritingTime(useBeacon) {
    if (this._writingActiveSince == null) return;
    const now = Date.now();
    const seconds = Math.round((now - this._writingActiveSince) / 1000);
    this._writingActiveSince = now;
    if (seconds <= 0) return;
    const bookId = this.selectedBookId;
    if (!bookId) return;
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
