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
// public/js/sources/fields.js (pure, testbar ohne Alpine).

import { setupCardLifecycle } from './card-lifecycle.js';
import { sourcesMethods } from '../sources/manage.js';
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

    // Memo-Speicher der Aggregat-Methoden (sourceRows/srcVisibleFields).
    // Wird bei jedem loadSources/resetSources geleert.
    _memos: {},
    _sourcesSavedTimer: null,
    _sourcesNoticeTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'sources',
        showFlag: 'showSourcesCard',
        load: () => this.loadSources(),
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
        }),
      });
    },

    destroy() {
      if (this._sourcesSavedTimer) { clearTimeout(this._sourcesSavedTimer); this._sourcesSavedTimer = null; }
      if (this._sourcesNoticeTimer) { clearTimeout(this._sourcesNoticeTimer); this._sourcesNoticeTimer = null; }
      this._lifecycle?.destroy();
    },

    ...sourcesMethods,
  }));
}
