// Diktat-Tracking (STT): summiert die Sekunden, während das Mikrofon aufnimmt
// (sttRecording) und der Tab sichtbar ist. Zusätzlich werden die diktierten
// Zeichen gezählt (_trackSttChars, aufgerufen aus stt-dictation.js beim Einfügen
// jedes Transkript-Segments). Beide Werte gehen gemeinsam an /history/stt-time.
// Buchweit wie writing-time (keine page_id). Gelesen wird die Tagesreihe in der
// BookStats-Karte (loadBookStats → sttTimeData). Timer-Lifecycle, Clamp,
// Tab-Lease und Senden kommen aus [heartbeat-tracker.js](heartbeat-tracker.js).
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { makeHeartbeatTracker } from './heartbeat-tracker.js';

export const sttTimeMethods = {
  _sttCharsPending: 0,

  ...makeHeartbeatTracker({
    name: 'stt',
    url: '/history/stt-time',
    methods: {
      active: '_sttTimeActive',
      setup: '_setupSttTime',
      start: '_startSttHeartbeat',
      stop: '_stopSttHeartbeat',
      flush: '_flushSttTime',
    },
    spec: {
      isActive: (ctx) => ctx.$store.stt.recording
        && ctx.$store.nav.selectedBookId
        && document.visibilityState === 'visible',

      watch: [
        { get: (ctx) => ctx.$store.stt.recording },
        { get: (ctx) => ctx.$store.nav.selectedBookId, restart: true },
      ],

      // Der einzige Tracker, der auch ohne Sekunden bucht: die Zeichen zählt der
      // Tab, der sie eingefügt hat, und sie dürfen nie verfallen. Das Tab-Lease
      // greift darum (in heartbeat-tracker.js) nur auf die Sekunden.
      payload: (ctx, seconds) => {
        const chars = ctx._sttCharsPending || 0;
        ctx._sttCharsPending = 0;
        if (seconds <= 0 && chars <= 0) return null;
        const bookId = ctx.$store.nav.selectedBookId;
        return bookId ? { book_id: Number(bookId), seconds, chars } : null;
      },
    },
  }),

  // Zählt die Zeichen eines eingefügten Transkript-Segments. Wird auch
  // aufgerufen, wenn der Heartbeat schon gestoppt ist (Transkript-Response kommt
  // ggf. nach dem Mic-Stop zurück) — der Flush schickt dann nur die Zeichen.
  _trackSttChars(n) {
    const v = Number(n) || 0;
    if (v <= 0) return;
    this._sttCharsPending = (this._sttCharsPending || 0) + v;
    this._flushSttTime(false);
  },
};
