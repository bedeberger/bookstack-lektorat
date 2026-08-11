// Lektoratszeit-Tracking: summiert die Sekunden, während der Prüfmodus
// (`checkDone`) auf einer Seite aktiv ist und der Tab sichtbar ist.
// Timer-Lifecycle, Clamp, Tab-Lease und Senden kommen aus
// [heartbeat-tracker.js](heartbeat-tracker.js).
//
// Seitengebunden: Buch UND Seite werden beim Start eingefroren, damit ein
// Seitenwechsel den offenen Delta noch auf die ALTE Seite bucht (der `restart`-
// Watcher stoppt zuerst, dann startet er neu).
//
// `this` zeigt auf die Alpine-Komponente (via spread in app.js).

import { makeHeartbeatTracker } from './heartbeat-tracker.js';

export const lektoratTimeMethods = {
  _lektoratActivePageId: null,
  _lektoratActiveBookId: null,

  ...makeHeartbeatTracker({
    name: 'lektorat',
    url: '/history/lektorat-time',
    methods: {
      active: '_lektoratTimeActive',
      setup: '_setupLektoratTime',
      start: '_startLektoratHeartbeat',
      stop: '_stopLektoratHeartbeat',
      flush: '_flushLektoratTime',
    },
    spec: {
      isActive: (ctx) => ctx.checkDone
        && ctx.$store.nav.selectedBookId
        && ctx.currentPage?.id
        && document.visibilityState === 'visible',

      watch: [
        { get: 'checkDone' },
        { get: (ctx) => ctx.$store.nav.selectedBookId, restart: true },
        { get: (ctx) => ctx.currentPage?.id, restart: true },
      ],

      onStart: (ctx) => {
        ctx._lektoratActivePageId = ctx.currentPage?.id || null;
        ctx._lektoratActiveBookId = ctx.$store.nav.selectedBookId || null;
      },
      onStop: (ctx) => {
        ctx._lektoratActivePageId = null;
        ctx._lektoratActiveBookId = null;
      },

      payload: (ctx, seconds) => {
        if (seconds <= 0) return null;
        const bookId = ctx._lektoratActiveBookId;
        const pageId = ctx._lektoratActivePageId;
        if (!bookId || !pageId) return null;
        return { book_id: Number(bookId), page_id: Number(pageId), seconds };
      },
    },
  }),
};
