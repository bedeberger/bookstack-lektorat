// Lektoratszeit-Tracking: summiert die Sekunden, während der Prüfmodus
// (`checkDone`) auf einer Seite aktiv ist und der Tab sichtbar ist.
// Heartbeat alle 15 s, Flush bei visibilitychange, pagehide, Seitenwechsel
// und State-Wechseln. Bei Seitenwechsel wird auf die alte Seite gebucht
// und mit der neuen Seite neu gestartet, da Prüfmodus seitengebunden ist.
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

const HEARTBEAT_MS = 15000;

export const lektoratTimeMethods = {
  _lektoratActiveSince: null,
  _lektoratActivePageId: null,
  _lektoratActiveBookId: null,
  _lektoratHeartbeatTimer: null,

  _lektoratTimeActive() {
    return !!(this.checkDone
      && this.selectedBookId
      && this.currentPage?.id
      && document.visibilityState === 'visible');
  },

  _setupLektoratTime() {
    const signal = this._abortCtrl?.signal;
    const sync = () => {
      if (this._lektoratTimeActive()) this._startLektoratHeartbeat();
      else this._stopLektoratHeartbeat(false);
    };
    const restart = () => {
      this._stopLektoratHeartbeat(false);
      if (this._lektoratTimeActive()) this._startLektoratHeartbeat();
    };
    this.$watch('checkDone',         sync);
    this.$watch('selectedBookId',    restart);
    this.$watch(() => this.currentPage?.id, restart);
    document.addEventListener('visibilitychange', sync, { signal });
    window.addEventListener('pagehide', () => this._stopLektoratHeartbeat(true), { signal });
    sync();
  },

  _startLektoratHeartbeat() {
    if (this._lektoratHeartbeatTimer) return;
    this._lektoratActiveSince = Date.now();
    this._lektoratActivePageId = this.currentPage?.id || null;
    this._lektoratActiveBookId = this.selectedBookId || null;
    this._lektoratHeartbeatTimer = setInterval(() => {
      this._flushLektoratTime(false);
    }, HEARTBEAT_MS);
  },

  _stopLektoratHeartbeat(useBeacon) {
    if (this._lektoratHeartbeatTimer) {
      clearInterval(this._lektoratHeartbeatTimer);
      this._lektoratHeartbeatTimer = null;
    }
    this._flushLektoratTime(useBeacon);
    this._lektoratActiveSince = null;
    this._lektoratActivePageId = null;
    this._lektoratActiveBookId = null;
  },

  _flushLektoratTime(useBeacon) {
    if (this._lektoratActiveSince == null) return;
    const now = Date.now();
    const seconds = Math.round((now - this._lektoratActiveSince) / 1000);
    this._lektoratActiveSince = now;
    if (seconds <= 0) return;
    const bookId = this._lektoratActiveBookId;
    const pageId = this._lektoratActivePageId;
    if (!bookId || !pageId) return;
    const payload = { book_id: Number(bookId), page_id: Number(pageId), seconds };
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/history/lektorat-time', blob);
    } else {
      fetch('/history/lektorat-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    }
  },
};
