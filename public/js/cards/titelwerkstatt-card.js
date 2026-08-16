// Alpine.data('titelwerkstattCard') — Titel-Werkstatt journalistischer Beiträge.
//
// Nur bei journalistischen Buchtypen sichtbar (Gate via feature-registry
// `requiresBuchtyp`, autoritativ ist das Buchtyp-Gate der Route). Fachlicher
// State lebt hier, der `showTitelwerkstattCard`-Flag im Root (Hash-Router,
// Exklusivität).

import { titelwerkstattMethods } from '../book/titelwerkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { HEADLINE_FIELDS } from '../headline/channels.js';

// Filterleiste pro Buch im localStorage (siehe public/js/filter-persist.js).
// Die beiden Felder stehen weiterhin in `freshState()` (Regel „State explizit
// deklariert"), werden von `setupCardLifecycle` aber aus dem Reset-Payload
// gestrichen — sonst gewänne der Default gegen den restaurierten Stand.
const TW_FILTER_SCOPES = [
  { scope: 'titelwerkstatt', defaults: { twFilterSuche: '', twFilterKapitel: '' } },
];

// Buch-skopierter State — Factory, damit `book:changed` und `view:reset` nicht
// dieselben Objekt-Referenzen weiterreichen.
const freshState = () => ({
  twEnabled: false,
  twPages: {},           // { [page_id]: { dachzeile, titel, lead, teaser, … } }
  twOpenId: null,        // aufgeklappte Zeile
  twFilterSuche: '',     // Freitext über Beitragsname/Dachzeile/Titel
  twFilterKapitel: '',   // Kapitel-ID als String, '' = alle (inkl. Sub-Kapitel)
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
  // Revisionszähler für das Zeilen-Memo: er zählt Mutationen mit, die die
  // Schlüssel-Anzahl nicht ändern (ein geänderter Titel bei gleicher
  // Seitenzahl) — ohne ihn träfe der Memo-Vergleich und die Tabelle zeigte den
  // alten Wert.
  _twRev: 0,
  // Speicher des `_memo`-Helpers (book/titelwerkstatt.js). Über `resetState`
  // beim Buchwechsel geleert, sonst hinge die Tabelle am alten Buch.
  _memos: {},
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
        filterScopes: TW_FILTER_SCOPES,
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

      // Filteränderung schliesst eine aufgeklappte Zeile, die dadurch aus der
      // Liste fällt. Als $watch statt als `@input`/`@combobox-change` im
      // Template: beide Filter schreiben über `x-model`, und ein zweiter
      // Handler am selben Event hinge in der Auswertungsreihenfolge.
      this.$watch('twFilterSuche', () => this._twCloseHiddenRow());
      this.$watch('twFilterKapitel', () => this._twCloseHiddenRow());
    },

    destroy() {
      if (this._twPollTimer) { clearInterval(this._twPollTimer); this._twPollTimer = null; }
      this._lifecycle?.destroy();
    },

    ...titelwerkstattMethods,
  }));
}
