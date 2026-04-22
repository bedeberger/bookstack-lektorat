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
  _offlineSyncInstalled: false,
  _draftPushRunning: false,
  themePref: 'auto',
  uiLocale: '',
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
  bookstackSearch: '',
  bookstackSearchResults: [],
  bookstackSearchLoading: false,
  bookstackSearchError: '',
  bookstackSearched: false,
  _bookstackSearchTimer: null,
  _bookstackSearchAbort: null,
  _bookstackSearchSeq: 0,
});

const editorState = () => ({
  currentPage: null,
  currentPageEmpty: false,
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
  _autosaveTimer: null,
  _draftTimer: null,
  _onlineHandler: null,
  newPageTitle: '',
  newPageCreating: false,
  newPageError: '',
});

const editorPopupState = () => ({
  showSynonymMenu: false,
  synonymMenuX: 0,
  synonymMenuY: 0,
  showSynonymPicker: false,
  synonymThesList: [],
  synonymThesLoading: false,
  synonymThesError: '',
  synonymThesDisabled: false,
  synonymKiList: [],
  synonymKiLoading: false,
  synonymKiError: '',
  _synonymRange: null,
  _synonymWord: '',
  _synonymPollTimer: null,
  _synonymScrollHandler: null,
  showFigurLookup: false,
  figurLookupX: 0,
  figurLookupY: 0,
  figurLookupData: null,
  _figurLookupScrollHandler: null,
  _figurLookupAnchor: null,
  _figurLookupIndex: null,
});

// Sichtbarkeit der Hauptkarten. Exklusiv: `_closeOtherMainCards(keep)`
// schliesst alle anderen und den Editor.
const cardsState = () => ({
  showBookCard: false,
  showTreeCard: true,
  showEditorCard: false,
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
  showBookChatCard: false,
  showBookSettingsCard: false,
  showUserSettingsCard: false,
  showKomplettStatus: false,
});

const statusState = () => ({
  status: '',
  statusSpinner: false,
  _statusTimer: null,
});

// Seiten-Lektorat (Finding-Liste, Apply-Flow, Token-Estimates)
const lektoratState = () => ({
  analysisOut: '',
  lektoratFindings: [],
  selectedFindings: [],
  appliedOriginals: [],
  checkDone: false,
  checkLoading: false,
  checkProgress: 0,
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
  showTokLegend: false,
  tokLegendPos: { x: 0, y: 0 },
  tokTooltipData: null,
  showPageStatusTip: false,
  pageStatusTipPos: { x: 0, y: 0 },
  pageStatusTipText: '',
  _checkPollTimer: null,
});

const bookReviewState = () => ({
  // Loading/Progress/Status/Out/selectedBookReviewId wandern in Alpine.data(
  // 'bookReviewCard'). bookReviewHistory bleibt am Root (tree.js/loadPages
  // schreibt, user-settings liest beim Danger-Reset).
  bookReviewHistory: [],
});

// Grösster Teil in Alpine.data('kapitelReviewCard') migriert. Nur
// `kapitelReviewChapterId` bleibt am Root — Hash-Router und Sidebar brauchen
// es als Single Source of Truth (analog zu selectedFigurId/selectedOrtId).
const kapitelReviewState = () => ({
  kapitelReviewChapterId: '',
});

const figurenState = () => ({
  // `figuren` lebt in Alpine.store('catalog').
  // figurenUpdatedAt + Graph-Internals wandern in Alpine.data('figurenCard').
  // Loading/Progress/Status + selectedFigurId + figurenFilters bleiben am Root
  // (Hash-Router, app-navigation, checkPendingJobs-Reconnect).
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

const ereignisseState = () => ({
  // `globalZeitstrahl` lebt in Alpine.store('catalog').
  // Meta-Felder (Loading/Progress/Status/PollTimer) wandern in
  // Alpine.data('ereignisseCard'). Filters bleiben am Root (app-navigation
  // schreibt sie).
  ereignisseFilters: {
    figurId: '',
    kapitel: '',
    seite: '',
    suche: '',
  },
});

const szenenState = () => ({
  // `szenen` lebt in Alpine.store('catalog'). Meta-Felder in szenenCard.
  szenenUpdatedAt: null,
  szenenFilters: {
    wertung: '',
    figurId: '',
    kapitel: '',
    seite: '',
    ortId: '',
    suche: '',
  },
});

const orteState = () => ({
  // `orte` lebt in Alpine.store('catalog'). Meta-Felder in orteCard.
  orteUpdatedAt: null,
  selectedOrtId: null,
  orteFilters: {
    figurId: '',
    kapitel: '',
    szeneId: '',
    suche: '',
  },
});

// kontinuitaetState wandert in Alpine.data('kontinuitaetCard')
// — siehe public/js/cards/kontinuitaet-card.js.

// bookStatsState wandert in Alpine.data('bookStatsCard')
// — siehe public/js/cards/book-stats-card.js.

// stilState wandert in Alpine.data('stilCard') — siehe public/js/cards/stil-card.js.

// fehlerHeatmapState wandert in Alpine.data('fehlerHeatmapCard')
// — siehe public/js/cards/fehler-heatmap-card.js.

// Chat-State komplett in Alpine.data('chatCard') + ('bookChatCard') migriert.
// _checkDoneBeforeChat bleibt am Root (von toggleChatCard + resetPage verwendet,
// Editor-nah) — siehe shellState.
const chatsState = () => ({
  _checkDoneBeforeChat: false,
});

const jobsState = () => ({
  jobQueueItems: [],
  _jobQueueTimer: null,
  showJobStats: false,
  jobStats: null,
  alleAktualisierenLoading: false,
  alleAktualisierenStatus: '',
  alleAktualisierenLastRun: null,
  alleAktualisierenProgress: 0,
  alleAktualisierenTokIn: 0,
  alleAktualisierenTokOut: 0,
  alleAktualisierenTps: null,
});

// settingsState wandert in Alpine.data('bookSettingsCard') + ('userSettingsCard')
// — siehe public/js/cards/book-settings-card.js + user-settings-card.js.

export function initialLektoratState() {
  return {
    ...shellState(),
    ...aiProviderState(),
    ...navigationState(),
    ...editorState(),
    ...editorPopupState(),
    ...cardsState(),
    ...statusState(),
    ...lektoratState(),
    ...bookReviewState(),
    ...kapitelReviewState(),
    ...figurenState(),
    ...ereignisseState(),
    ...szenenState(),
    ...orteState(),
    ...chatsState(),
    ...jobsState(),
  };
}
