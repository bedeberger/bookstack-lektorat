// Initialer State der `lektorat`-Alpine-Komponente.
// Als Funktion, damit jede Komponenten-Instanz eigene Arrays/Objekte erhält
// (sonst teilen sich alle Instanzen dieselben Referenzen).
//
// Der Export `initialLektoratState()` bleibt ein flaches Objekt — Alpine
// spreadet das direkt in die Komponente. Die internen Slice-Funktionen sind
// rein organisatorisch und machen sichtbar, welche Felder fachlich
// zusammengehören. Neue Felder kommen in den passenden Slice.

const shellState = () => ({
  currentUser: null,
  devMode: false,
  sessionExpired: false,
  bookstackTokenInvalid: false,
  serverOffline: false,
  isOffline: false,
  updateAvailable: false,
  _offlineSyncInstalled: false,
  _draftPushRunning: false,
  themePref: 'auto',
  focusGranularity: 'paragraph',
  uiLocale: '',
  // Plattform-Detect für Tasten-Hint-Anzeige (⌘ vs. Ctrl). Wird in init()
  // gesetzt; default true wäre auf Windows falsch, default false ist sichere
  // Annahme bevor JS gelaufen ist (Hero erscheint mit Ctrl, dann snap auf ⌘ falls Mac).
  isMac: false,
  bookstackUrl: '',
  promptConfig: {},
  showTokenSetup: false,
  tokenSetupId: '',
  tokenSetupPw: '',
  tokenSetupError: '',
  tokenSetupLoading: false,
  tokenSetupCanCancel: false,
  _abortCtrl: null,
});

const aiProviderState = () => ({
  claudeModel: 'claude-sonnet-4-6',
  claudeMaxTokens: 64000,
  apiProvider: 'claude',
  ollamaModel: 'llama3.2',
  llamaModel:  'llama3.2',
});

const navigationState = () => ({
  books: [],
  selectedBookId: '',
  pages: [],
  tree: [],
  _applyingHash: false,
  _hashInitialized: false,
  _hashUpdatePending: false,
  _navDepth: 0,
  _inHashApply: false,
  _chapterOrderMap: null,
  _pageOrderMap: null,
  _pageIdOrderMap: null,
  pageSearch: '',
  pageSearchActiveIndex: 0,
  bookstackSearch: '',
  bookstackSearchResults: [],
  bookstackSearchLoading: false,
  bookstackSearchError: '',
  bookstackSearched: false,
  bookstackSearchActiveIndex: 0,
  _bookstackSearchTimer: null,
  _bookstackSearchAbort: null,
  _bookstackSearchSeq: 0,
});

const editorState = () => ({
  currentPage: null,
  currentPageEmpty: false,
  currentPageIdeenOpenCount: 0,
  currentPageChatSessionCount: 0,
  renderedPageHtml: '',
  chapterFigures: [],
  showChapterFigures: false,
  originalHtml: null,
  correctedHtml: null,
  hasErrors: false,
  editMode: false,
  editDirty: false,
  editSaving: false,
  saveOffline: false,
  lastAutosaveAt: null,
  lastDraftSavedAt: null,
  _autosaveIdleTimer: null,
  _autosaveMaxTimer: null,
  _draftTimer: null,
  _onlineHandler: null,
  newPageTitle: '',
  newPageCreating: false,
  newPageError: '',
});

// Fokusmodus-Flag + Live-Counter. Eigener Slice, damit alle vier Editor-Modi-
// Flags (editMode, checkDone, focusMode, plus „Viewmodus" als none-of-above)
// in app-state.js sichtbar sind. Sub-Komponenten-Maschine `_focusState`/
// `_focusGen` lebt in editorFocusCard.
const focusModeState = () => ({
  focusMode: false,
  focusCountWords: 0,
  focusCountChars: 0,
  focusCountWordsDelta: '±0',
  focusCountCharsDelta: '±0',
});

// Restliche Editor-Popup-Felder am Root:
//   - `_figurLookupIndex`: Lookup-Cache für den synchronen Hit-Test in
//     `_tryOpenFigurLookupAt` (wird aus Synonym-Kontextmenü aufgerufen).
//   - `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen`: Spiegel-
//     Flags, die die Subs setzen, damit editor-focus-onKey (Escape) weiss,
//     welches Popover offen ist, ohne in die Sub zu greifen.
// Der Rest des Synonym-/Figur-Lookup-States lebt in den jeweiligen
// Alpine.data-Subs (editorSynonymeCard, editorFigurLookupCard).
const editorPopupState = () => ({
  _figurLookupIndex: null,
  _figurLookupOpen: false,
  _synonymMenuOpen: false,
  _synonymPickerOpen: false,
});

// Sichtbarkeit der Hauptkarten. Exklusiv: `_closeOtherMainCards(keep)`
// schliesst alle anderen und den Editor.
const cardsState = () => ({
  showBookCard: false,
  showTreeCard: true,
  showEditorCard: false,
  showBookOverviewCard: false,
  showBookReviewCard: false,
  showKapitelReviewCard: false,
  showFiguresCard: false,
  showGlobalZeitstrahl: false,
  showEreignisseCard: false,
  showSzenenCard: false,
  showOrteCard: false,
  showKontinuitaetCard: false,
  showBookStatsCard: false,
  showStilCard: false,
  showFehlerHeatmapCard: false,
  showChatCard: false,
  showIdeenCard: false,
  showBookChatCard: false,
  showBookSettingsCard: false,
  showUserSettingsCard: false,
  showFinetuneExportCard: false,
  showKomplettStatus: false,
  showAvatarMenu: false,
});

const statusState = () => ({
  status: '',
  statusSpinner: false,
  _statusTimer: null,
});

// Confirm-Dialog (Ersatz für window.confirm). Native confirm() lässt Chrome
// auf macOS aus dem nativen Vollbild-Space rausspringen, damit die Browser-
// Modal überhaupt rendert — nach Klick bleibt das Fenster ausserhalb des
// Vollbilds. Eigener Alpine-Modal vermeidet das. `_resolve` wird vom
// `appConfirm`-Helper gesetzt; Buttons rufen `_resolveConfirmDialog(bool)`.
const confirmDialogState = () => ({
  confirmDialogOpen: false,
  confirmDialogMessage: '',
  confirmDialogConfirmLabel: '',
  confirmDialogCancelLabel: '',
  confirmDialogDanger: false,
  _confirmDialogResolve: null,
});

// Seiten-Lektorat (Finding-Liste, Apply-Flow, Token-Estimates)
const lektoratState = () => ({
  analysisOut: '',
  lektoratFindings: [],
  selectedFindings: [],
  appliedOriginals: [],
  appliedHistoricCorrections: [],
  checkDone: false,
  checkLoading: false,
  checkProgress: 0,
  checkStatus: '',
  saveApplying: null,
  batchLoading: false,
  batchProgress: 0,
  batchStatus: '',
  lastCheckId: null,
  pageHistory: [],
  activeHistoryEntryId: null,
  tokEsts: {},
  _tokenEstGen: 0,
  pageLastChecked: {},
  ideenCounts: {},
  showTokLegend: false,
  tokLegendPos: { x: 0, y: 0 },
  tokTooltipData: null,
  showPageStatusTip: false,
  pageStatusTipPos: { x: 0, y: 0 },
  pageStatusTipText: '',
  _checkPollTimer: null,
});

// bookReviewHistory wird von tree.js/loadPages geschrieben und von
// user-settings beim Danger-Reset gelesen; deshalb am Root.
const bookReviewState = () => ({
  bookReviewHistory: [],
});

// Hash-Router und Sidebar brauchen kapitelReviewChapterId als Single Source
// of Truth (analog zu selectedFigurId/selectedOrtId).
const kapitelReviewState = () => ({
  kapitelReviewChapterId: '',
});

// Root-seitig: figurenLoading/Progress/Status, selectedFigurId, Filters —
// gebraucht von Hash-Router, app-navigation, checkPendingJobs-Reconnect.
const figurenState = () => ({
  figurenLoading: false,
  figurenProgress: 0,
  figurenStatus: '',
  selectedFigurId: null,
  figurenFilters: {
    kapitel: '',
    seite: '',
    suche: '',
  },
  _figuresPollTimer: null,
});

// Filters bleiben am Root — app-navigation schreibt sie.
const ereignisseState = () => ({
  ereignisseFilters: {
    figurId: '',
    kapitel: '',
    seite: '',
    suche: '',
  },
});

const szenenState = () => ({
  szenenUpdatedAt: null,
  selectedSzeneId: null,
  szenenFilters: {
    wertung: '',
    figurId: '',
    kapitel: '',
    ortId: '',
    suche: '',
  },
});

const orteState = () => ({
  orteUpdatedAt: null,
  selectedOrtId: null,
  orteFilters: {
    figurId: '',
    kapitel: '',
    szeneId: '',
    suche: '',
  },
});

// _checkDoneBeforeChat wird von toggleChatCard + resetPage verwendet (Editor-nah).
const chatsState = () => ({
  _checkDoneBeforeChat: false,
});

// Feature-Usage: Top-3 nach Recency, gespeist aus /usage/recent. Default-Set
// aus feature-registry, wenn User noch keine Tracking-Daten hat.
// recentPageIds: pro Buch die letzten N geöffneten Seiten-IDs (Command-Palette).
const featuresUsageState = () => ({
  recentFeatureKeys: ['review', 'figuren', 'bookchat'],
  recentPageIds: [],
});

const jobsState = () => ({
  jobQueueItems: [],
  jobQueueExpanded: false,
  _jobQueueTimer: null,
  alleAktualisierenLoading: false,
  alleAktualisierenStatus: '',
  alleAktualisierenLastRun: null,
  alleAktualisierenProgress: 0,
  alleAktualisierenTokIn: 0,
  alleAktualisierenTokOut: 0,
  alleAktualisierenTps: null,
  alleAktualisierenPassMode: null,
});

export function initialLektoratState() {
  return {
    ...shellState(),
    ...aiProviderState(),
    ...navigationState(),
    ...editorState(),
    ...focusModeState(),
    ...editorPopupState(),
    ...cardsState(),
    ...statusState(),
    ...confirmDialogState(),
    ...lektoratState(),
    ...bookReviewState(),
    ...kapitelReviewState(),
    ...figurenState(),
    ...ereignisseState(),
    ...szenenState(),
    ...orteState(),
    ...chatsState(),
    ...featuresUsageState(),
    ...jobsState(),
  };
}
