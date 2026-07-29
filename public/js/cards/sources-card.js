// Alpine.data('sourcesCard') — Sub-Komponente des Quellenverzeichnisses.
// Die Karte zeigt die Quellen DIESES Buchs; die Quelle selbst lebt in der
// persoenlichen Bibliothek ihres Besitzers (`owner_email`) und ist ueber die
// Bruecke `book_source_links` beliebig vielen Arbeiten zugeordnet. Daher zwei
// getrennte Aktionen: aus der Arbeit entfernen (jeder Editor) vs. aus der
// Bibliothek loeschen (nur der Besitzer, wirkt ueberall).
// Fachlicher State + Lifecycle hier, `showSourcesCard` + `toggleSourcesCard`
// im Root.
//
// Methoden in public/js/sources/manage.js, Feld-Inventar + Draft-Umrechnung in
// public/js/sources/fields.js (pure, testbar ohne Alpine). Die Quellen-Erkennung
// (Job `source-detect`, Vorschlagsliste) liegt in public/js/sources/detect.js.

import { EVT } from '../events.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { sourcesMethods } from '../sources/manage.js';
import { sourcesDetectMethods } from '../sources/detect.js';
import { draftFromSource } from '../sources/fields.js';

export function registerSourcesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('sourcesCard', () => ({
    sources: [],
    sourcesLoading: false,
    // Refetch bei bereits geladener Liste: die Tabelle bleibt stehen und wird nur
    // gedimmt, statt aufs Skeleton umzuschalten — kein Flackern beim Re-Klick.
    sourcesRefreshing: false,
    sourcesBusy: false,
    sourcesError: '',
    sourcesNotice: '',
    sourcesSaved: false,

    // Filter-Bar.
    srcFilterText: '',
    srcFilterType: '',
    srcShowArchived: false,

    // Detail-Formular. `srcEditingId`: null = zu, 'new' = Anlage, sonst die id.
    srcEditingId: null,
    srcDraft: draftFromSource(null),
    srcFormError: '',

    // Zitat-Kennzahlen des Buchs (GET /sources/stats). null = noch nicht/nicht
    // ermittelbar; die Leiste bleibt dann weg statt eine 0 zu behaupten.
    quoteStats: null,

    // Fundstellen-Panel („n× zitiert" aufgeklappt).
    srcCitationsId: null,
    srcCitations: [],
    srcCitationsLoading: false,
    srcCitationsError: '',

    // Bibliotheks-Picker: die eigene Bibliothek minus dem, was diesem Buch
    // schon zugeordnet ist. Lebt nur solange das Panel offen ist.
    srcPickerOpen: false,
    srcPool: [],
    srcPoolLoading: false,
    srcPoolError: '',
    srcPoolFilter: '',

    // Quellen-Erkennung (Job `source-detect`): Panel, Lauf, Funde. `srcDetected`
    // lebt nur im Client — ein Fund wird erst zur Quelle, wenn er uebernommen
    // wird, und ein verworfener Lauf soll spurlos verschwinden.
    srcDetectOpen: false,
    srcDetectRunning: false,
    srcDetectProgress: 0,
    srcDetectStatus: '',
    srcDetectError: '',
    srcDetectChapterId: '',     // '' = ganzes Buch
    srcDetected: [],
    srcDetectRan: false,        // trennt „noch nie gelaufen" von „nichts gefunden"
    srcDetectMeta: null,        // { verified, lookupSkipped, scopeName }

    // Deep-Link-Ziel (#book/X/quellen/<sourceId>) aus dem Quellen-Tab des
    // Referenz-Slots: gemerkt, bis die Liste geladen ist — loadSources
    // fokussiert es danach (_focusSourceById in sources/manage.js).
    _pendingFocusSourceId: null,

    // Memo-Speicher der Aggregat-Methoden (sourceRows/srcVisibleFields).
    // Wird bei jedem loadSources/resetSources geleert.
    _memos: {},
    _sourcesSavedTimer: null,
    _sourcesNoticeTimer: null,
    _srcDetectPollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'sources',
        showFlag: 'showSourcesCard',
        load: () => this.loadSources(),
        extraListeners: [
          // Permalink #book/X/quellen/<sourceId>: der Hash-Router dispatcht das
          // Event, _focusSourceById hebt die Zeile hervor (bzw. merkt sie bis
          // zum Load vor).
          { type: EVT.SOURCES_FOCUS_SOURCE, handler: (e) => this._focusSourceById(e.detail?.sourceId) },
        ],
        resetState: () => ({
          sources: [],
          sourcesBusy: false,
          sourcesError: '',
          sourcesNotice: '',
          srcFilterText: '',
          srcFilterType: '',
          srcShowArchived: false,
          srcEditingId: null,
          srcDraft: draftFromSource(null),
          srcFormError: '',
          srcCitationsId: null,
          srcCitations: [],
          srcCitationsLoading: false,
          srcCitationsError: '',
          srcPickerOpen: false,
          srcPool: [],
          srcPoolError: '',
          srcPoolFilter: '',
          // Buchwechsel verwirft die Funde: sie beziehen sich auf den Text des
          // alten Buchs und waeren im neuen sinnlos (und uebernehmbar!).
          srcDetectOpen: false,
          srcDetectRunning: false,
          srcDetectProgress: 0,
          srcDetectStatus: '',
          srcDetectError: '',
          srcDetectChapterId: '',
          srcDetected: [],
          srcDetectRan: false,
          srcDetectMeta: null,
          _pendingFocusSourceId: null,
          _memos: {},
        }),
        resetStateView: () => ({
          sourcesError: '',
          sourcesNotice: '',
          srcEditingId: null,
          srcDraft: draftFromSource(null),
          srcFormError: '',
          srcCitationsId: null,
          srcCitations: [],
          srcPickerOpen: false,
          srcPool: [],
          srcDetectError: '',
        }),
      });
    },

    destroy() {
      if (this._sourcesSavedTimer) { clearTimeout(this._sourcesSavedTimer); this._sourcesSavedTimer = null; }
      if (this._sourcesNoticeTimer) { clearTimeout(this._sourcesNoticeTimer); this._sourcesNoticeTimer = null; }
      // startPoll fährt setInterval — beim Kartenabbau stoppen, sonst pollt der
      // Lauf weiter gegen eine Komponente, die es nicht mehr gibt.
      if (this._srcDetectPollTimer) { clearInterval(this._srcDetectPollTimer); this._srcDetectPollTimer = null; }
      this._lifecycle?.destroy();
    },

    ...sourcesMethods,
    ...sourcesDetectMethods,
  }));
}
