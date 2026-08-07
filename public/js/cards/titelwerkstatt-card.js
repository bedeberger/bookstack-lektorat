// Alpine.data('titelwerkstattCard') — Titel-Werkstatt journalistischer Beiträge.
//
// Nur bei journalistischen Buchtypen sichtbar (Gate via feature-registry
// `requiresBuchtyp`, autoritativ ist das Buchtyp-Gate der Route). Fachlicher
// State lebt hier, der `showTitelwerkstattCard`-Flag im Root (Hash-Router,
// Exklusivität).

import { titelwerkstattMethods } from '../book/titelwerkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { HEADLINE_FIELDS } from '../headline/channels.js';

// Buch-skopierter State — Factory, damit `book:changed` und `view:reset` nicht
// dieselben Objekt-Referenzen weiterreichen.
const freshState = () => ({
  twEnabled: false,
  twPages: {},           // { [page_id]: { dachzeile, titel, lead, teaser, … } }
  twOpenId: null,        // aufgeklappte Zeile
  twDraft: {},           // { [feld]: string } der offenen Zeile
  twVariants: {},        // { [feld]: [ {id, text, herkunft}, … ] }
  twNewVariant: {},      // { [feld]: string } Eingabefeld „Variante hinzufügen"
  twSuggestFields: [...HEADLINE_FIELDS], // welche Felder der KI-Lauf abdeckt
  twSaving: {},          // { [feld]: true } während des PUT
  twRunning: false,
  twProgress: 0,
  twStatus: '',
  twError: '',
  twLoadError: false,
  twLastRun: null,
  // Zeilen-Memo: das Template liest die Liste im x-for UND in der Kopfzeile.
  // `_twRev` zählt Mutationen mit, die die Schlüssel-Anzahl nicht ändern (ein
  // geänderter Titel bei gleicher Seitenzahl) — ohne ihn träfe der Memo-
  // Vergleich und die Tabelle zeigte den alten Wert.
  _twRev: 0,
  _twRowsKey: null,
  _twRows: [],
});

export function registerTitelwerkstattCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('titelwerkstattCard', () => ({
    ...freshState(),
    _twPollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'titelwerkstatt',
        showFlag: 'showTitelwerkstattCard',
        timerKeys: ['_twPollTimer'],
        resetState: freshState,
        onShow: async () => { await this.loadTitelwerkstatt(); },
        onCardRefresh: async (e, ctx) => { await ctx.loadTitelwerkstatt(); },
        extraListeners: [
          // Reconnect eines laufenden Varianten-Jobs nach Reload/Tab-Wechsel.
          { type: 'job:reconnect', handler: (e) => {
            if (e.detail?.type !== 'headline-variants') return;
            const pageId = parseInt(String(e.detail.job?.entityId || '').replace(/^p/, ''));
            if (!pageId) return;
            this.twReconnect(e.detail.jobId, pageId);
          } },
        ],
      });
    },

    destroy() {
      if (this._twPollTimer) { clearInterval(this._twPollTimer); this._twPollTimer = null; }
      this._lifecycle?.destroy();
    },

    ...titelwerkstattMethods,
  }));
}
