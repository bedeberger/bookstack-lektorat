// Feature-Flag für den Block-Level-Merge bei Stale-Write-Konflikten (Notebook +
// Focus-Editor). Off → klassischer Überschreiben/Übernehmen-Banner. Client-Konstante
// (keine Per-User-Differenzierung nötig); bei Bug einfach auf false → alter Pfad.
export const FEATURE_BLOCK_MERGE = true;

// Initialer State der `lektorat`-Alpine-Komponente.
// Als Funktion, damit jede Komponenten-Instanz eigene Arrays/Objekte erhält
// (sonst teilen sich alle Instanzen dieselben Referenzen).
//
// Der Export `initialLektoratState()` bleibt ein flaches Objekt — Alpine
// spreadet das direkt in die Komponente. Die internen Slice-Funktionen sind
// rein organisatorisch und machen sichtbar, welche Felder fachlich
// zusammengehören. Neue Felder kommen in den passenden Slice.


// Residual-Root-State, der NICHT in einen benannten Store gewandert ist:
//   - Auth/Session (currentUser, sessionExpired, serverOffline, isOffline,
//     devMode) leben in Alpine.store('session') (cards/session-store.js) und
//     werden direkt via $store.session / this.$store.session gelesen (kein
//     Root-Proxy).
//   - App-Meta/Shell (appReady, updateAvailable, bossScreenActive, themePref,
//     uiLocale, defaultRegion, appTimezone, appName, appVersion, isMac,
//     promptConfig) leben in Alpine.store('shell') (cards/shell-store.js),
//     ebenfalls direkt via $store.shell (kein Root-Proxy).
//   - Read-only /config-Settings (mapTiles, languagetoolEnabled, apiProvider +
//     Modell-IDs, …) → Alpine.store('config'); STT → $store.stt; TTS → $store.tts;
//     Collab → $store.collab; Jobs → $store.jobs.
//
// Hier bleiben nur die Felder, die der Editor-Kern über den editor-host-Vertrag
// (shared/editor-host.js) direkt von `window.__app` liest und die der
// Standalone-Host (Mac-Client) als eigene Felder spiegelt — ein Store-Zugriff
// stünde dort nicht zur Verfügung — plus die internen Root-Lazy-Caches.
const shellState = () => ({
  focusGranularity: 'paragraph',
  // Vertikale Anker-Position des Typewriter-Scrollings im Focus-Editor
  // (0 = oben, 0.5 = Mitte, 0.33 = oberes Drittel). Default 0.5 = unveraendertes
  // Verhalten. Primaer fuer fremde Schalen (macOS-Client via Bridge) gedacht.
  typewriterAnchor: 0.5,
  // Locale des bearbeiteten Textes — Teil des editor-host-Vertrags. Speist die
  // Satz-Segmentierung im Focus-Sentence-Modus (Intl.Segmenter kennt pro
  // Sprache eigene Abkuerzungsregeln). Spiegelt `$store.shell.uiLocale`, weil
  // der Editor-Kern nicht auf Alpine-Stores zugreifen darf (Invariante 0) und
  // der Standalone-Host (Mac-Client) das Feld selbst setzt.
  contentLocale: 'de',
  _abortCtrl: null,
  // Email → Display-Name-Map fuer Revision-Listen, Tree-Toasts, Konflikt-Hinweise.
  // Lazy gefuellt via `/me/users-light` beim ersten Zugriff in `userDisplayName`.
  // Map-Form (statt POJO) damit Lookups O(1) bleiben und Alpine den Reactor
  // nicht bei jeder Property-Zugriffsfolge feuert.
  _usersByEmail: null,
  _usersByEmailLoading: false,
});

const navigationState = () => ({
  // books / selectedBookId / pages / tree leben in Alpine.store('nav') (geteilt
  // mit ~29 Reader-Modulen) und werden direkt via $store.nav / this.$store.nav
  // gelesen (kein Root-Proxy — wie catalog/tts/jobs). Siehe cards/nav-store.js.
  // Erst nach dem ersten loadBooks() true. Gate fuer den Welcome-Empty-State
  // (books.length === 0), damit der nicht waehrend des initialen Ladens blitzt.
  booksLoaded: false,
  // Kategorie-Pool (global, beim Login einmal geladen). Liefert die Gruppen-Namen
  // fuer die Buchwahl-Combobox (Bücher gruppiert nach Kategorie, siehe
  // tree.js#bookComboOptions). Wird nur befuellt, wenn Bücher Kategorien haben.
  bookFilterCategoryPool: [],
  // Per-Buch ACL-Rolle aus /books/:id/access. `currentBookRole` ist die Rolle
  // fuer selectedBookId (Snapshot fuer $watch + Getter `canEdit`/`canReview`).
  // null = nicht ermittelbar (kein Zugriff oder Endpoint-Fehler) → Frontend
  // faellt auf Legacy-Verhalten zurueck (canEdit=true), bis serverseitige
  // Schreibpfade enforced sind. `bookRoles` cached pro Buch.
  bookRoles: {},
  currentBookRole: null,
  // Per-Buch: true wenn mind. 2 ACL-Eintraege (Owner + N) → Collab-Poller + Presence-Pings
  // erst dann starten. Single-User-Bücher pollen nicht. Befüllt in `_loadBookRole`.
  bookSharedFlags: {},
  // Tree wird während Buchwechsel-Fetch sichtbar gelassen + via CSS gedimmt +
  // Klicks blockiert, statt vorab geleert (sonst leerer Tree bei Fetch-Fail).
  treeLoading: false,
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
  _pageSearchActiveId: null,
  _filteredTreeMemo: null,
  newChapterTitle: '',
  newChapterCreating: false,
  newChapterError: '',
  // Diary-Calendar (Tagebuch-Bücher): Sidebar-Mode (Tree vs. Kalender) und
  // aktiver Monat. `sidebarMode` startet 'tree'; auf Buchwechsel setzt
  // tree.js#loadPages bei buchtyp='tagebuch' auf 'calendar'.
  sidebarMode: 'tree',
  diaryCalendarYearMonth: null,
  _diaryCalendarJumpModel: '',
  // Diary-Rückblick „An diesem Tag" + Zeitraum-Suche (rein lesend, kein KI-Call).
  diaryAnniversaryOpen: true,
  diaryRangeFrom: '',
  diaryRangeTo: '',
  // Pagetree-Rechtsklick-Menü. SSoT für Open/Pos/Target; Render in sidebar.html.
  // Target-Form: { kind: 'page'|'chapter', id, name }. Position viewport-fixed
  // (sidebar liegt ausserhalb einer transform-Card, daher kein Containing-Block-
  // Offset nötig).
  pageTreeMenuOpen: false,
  pageTreeMenuPos: { left: 0, top: 0 },
  pageTreeMenuTarget: null,
  _pageTreeMenuOutsideHandler: null,
  _pageTreeMenuEscHandler: null,
});

// Page-Slice: Inhalt der aktuell geöffneten Seite. Mode-agnostisch — Notebook,
// Focus und View lesen alle aus diesem Slice. `originalHtml` ist die zuletzt
// gespeicherte Server-Fassung (Quelle für Diff/Dirty-Check), `renderedPageHtml`
// die sanitierte Read-Mode-HTML-Fassung. Page-Lifecycle (selectPage, loadPages)
// schreibt hier.
const pageState = () => ({
  currentPage: null,
  // Push-getriebener „Zuletzt bearbeitet auf <Gerät>"-Hint der offenen Seite.
  // Vom Server (loadPage → last_editor) befüllt, in selectPage/_refetchCurrentPage
  // gegen das aktuelle Gerät gefiltert (nur fremde EIGENE Geräte, nicht live).
  // null = kein Hint (eigener Browser, fehlende Daten oder fremder User).
  pageLastEditor: null,
  currentPageEmpty: false,
  // true, wenn der Seiteninhalt nicht geladen werden konnte (Netz-/SW-Cache-
  // Fehler beim Öffnen). Zeigt im View-Modus einen Retry-Block statt einer
  // stillen leeren Seite. Wird bei jedem Ladeversuch (selectPage/Retry) genullt.
  pageLoadError: false,
  // true, solange der Seiteninhalt beim Öffnen lädt — zeigt im View-Modus ein
  // Lade-Skelett statt einer blanken Fläche (langsames Netz / kalter SW-Cache).
  pageContentLoading: false,
  // Re-Entry-Guard für den manuellen Retry-Button (deaktiviert ihn während des
  // Ladens). Im Template gebunden → muss explizit deklariert sein.
  _retryingPageLoad: false,
  currentPageIdeenOpenCount: 0,
  currentPageRechercheCount: 0,
  // Anzahl nicht-verworfener Plot-Beats im Kapitel der offenen Seite. Speist den
  // Plot-Verknüpfungs-Eintrag im Page-Action-Menü (Beats hängen am Kapitel).
  currentPagePlotBeatCount: 0,
  currentPageShareCommentCount: 0,
  // Anzahl aktiver Share-Links, die die offene Seite enthalten (Page-/Kapitel-/
  // Buch-Share). Speist den Badge am „Teilen"-Eintrag des Page-Action-Menüs.
  currentPageShareLinkCount: 0,
  currentPageChatSessionCount: 0,
  // Kommentar-Leiste (Leseansicht): die editorCommentsCard spiegelt hierhin,
  // ob sie für die offene Seite Threads zeigt → Grid-Klasse `comments-split`
  // an .editor-body-wrap (analog checkDone → lektorat-split). pageCommentCount
  // ist die Anzahl auf der Seite verankerter Threads (unabhängig von der
  // Sichtbarkeit) — speist Badge + Sichtbarkeit des Toggle-Buttons in den
  // Seiten-Actions.
  pageCommentRailOpen: false,
  pageCommentCount: 0,
  renderedPageHtml: '',
  chapterFigures: [],
  showChapterFigures: false,
  originalHtml: null,
  newPageTitle: '',
  newPageCreating: false,
  newPageError: '',
});

// Notebook-Slice: Lifecycle des Normal-Editors (Edit-Mode, Autosave, Draft,
// Zoom, Fullscreen, Konflikt). Der Focus-Editor läuft auf derselben
// Save-Pipeline und liest/schreibt dieselben Felder (`editMode`, `editDirty`,
// `editSaving`) — `focusState` hält nur, was ausschliesslich den Fokusmodus
// betrifft.
const notebookState = () => ({
  editMode: false,
  editDirty: false,
  editSaving: false,
  saveOffline: false,
  pageEditorFullscreen: false,
  pageEditorZoom: 1,
  pageEditorFitWidth: false,
  // Steuerzeichen anzeigen (Absatzmarken ¶ + Zeilenumbruch ↵). Reine
  // CSS-Pseudo-Element-Dekoration auf dem contenteditable (page-view.css),
  // kein Markup im gespeicherten HTML. User-Wahl, in editorPrefs persistiert.
  pageEditorShowMarks: false,
  // Titel-Kopf des Beitrags anzeigen (Dachzeile/Titel/Lead, nur publizistische
  // Bücher — siehe editor-page-head-card.js). ANZEIGE-Wahl im Notebook-Editor,
  // gilt für Lese- UND Bearbeitungsmodus: sie blendet den Kopf aus, wenn jemand
  // am Fliesstext arbeitet, und ändert nichts an den gespeicherten Feldern und
  // nichts an Share-Reader oder Export. Default AN, in editorPrefs persistiert.
  pageEditorShowHead: true,
  // Cross-User-Konflikt aus _checkPageConflict. quickSave (Auto-Save / Exit-
  // Fokus) zeigt keinen Modal — der Banner ist im Fokus-Header sichtbar und
  // bleibt bis zum nächsten erfolgreichen Save oder bis User explizit
  // entscheidet. Form: `{ remoteUserName, remoteUpdatedAt }`.
  editConflict: null,
  // Block-Level-Merge-Auflösung (Notebook + Focus). Gesetzt, wenn ein
  // Stale-Write-Konflikt blockweise gemerged wurde und einzelne Blöcke in
  // beiden Versionen kollidieren — die Auflösungs-UI braucht User-Entscheidung.
  // Form: `{ pageId, source, merged, conflicts:[{bid,tag,local_html,remote_html}],
  // remoteUpdatedAt, decisions:{[bid]:'local'|'remote'|'both'} }`. null = kein
  // offener Konflikt. Auto-gemergte (kollisionsfreie) Edits setzen das nie.
  conflictResolution: null,
  // Local-Draft-Hinweis für nicht-editMode: localStorage hat ungespeicherten
  // Entwurf für aktuell geöffnete Seite (z. B. nach Server-Crash mid-write,
  // Tab geschlossen + wieder geöffnet). Form `{ savedAt }`. Banner bietet
  // Resume (öffnet Edit-Mode + Draft-Restore via startEdit) oder Discard.
  pendingDraft: null,
  // Transient-Feedback nach Anführungszeichen-Normalisierung (Toolbar-Button):
  // `null` = kein Flash, sonst `{ count }`. Timer-gesteuert (~1.8 s) — Button
  // swappt Quote-Icon gegen Check + Success-Tönung als Abschluss-Indikator.
  quotesNormalizedFlash: null,
  _quotesFlashTimer: null,
  lastAutosaveAt: null,
  lastDraftSavedAt: null,
  // true, wenn der letzte lokale Draft-Write fehlschlug (localStorage voll) —
  // der Inhalt liegt dann NICHT lokal gesichert vor (Datenverlust-Risiko im
  // Offline-Fall). Speist den höchstprioren `unsaved`-Zustand des Save-
  // Indicators (app-ui.js#_saveStatus). Wird bei erfolgreichem Write/Save
  // wieder genullt.
  draftPersistFailed: false,
  _autosaveIdleTimer: null,
  _autosaveMaxTimer: null,
  _draftTimer: null,
  // Retry-Trigger für einen haengengebliebenen Offline-Save (edit/autosave.js).
  // Zwei Handles, weil zwei Anlaesse: `_onlineHandler` haengt an window
  // `online`+`focus`, `_onlineVisHandler` an document `visibilitychange`.
  // Beide leben am Root (nicht an der Card), weil `_uninstallOnlineRetry` auch
  // aus Root-Kontext gerufen wird (app-view/page.js#resetPage) und dieselben
  // Handles treffen muss.
  _onlineHandler: null,
  _onlineVisHandler: null,
  // Re-Entry-Guard der Reconnect-Outbox (app-outbox.js): verhindert, dass
  // sich überlappende online/focus/visibilitychange-Trigger den Draft-Flush
  // parallel starten. Kurzlebig, nur innerhalb von _flushOutbox gesetzt.
  _outboxFlushing: false,
});

// Fokus-State-Slice. Eigener Slice, damit alle vier Editor-Modi-Flags
// (editMode, checkDone, focusActive, plus „Viewmodus" als none-of-above) in
// app-state.js sichtbar sind. Sub-Komponenten-Maschine `_focusState`/`_focusGen`
// lebt in editorFocusCard.
//
// `focusActive` ist Single Source of Truth für „Fokusmodus an" (Templates, CSS,
// Body-Class). Dirty-/Saving-Zustand kommt aus `notebookState` (`editDirty`/
// `editSaving`) — der Focus-Editor läuft auf der Notebook-Save-Pipeline und
// braucht keine eigenen Spiegel-Flags.
const focusState = () => ({
  focusActive: false,
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
  showFigurWerkstattCard: false,
  showGlobalZeitstrahl: false,
  showEreignisseCard: false,
  showPlotCard: false,
  showMotivCard: false,
  showSzenenCard: false,
  showOrteCard: false,
  showSongsCard: false,
  showWorldFactsCard: false,
  showRechercheCard: false,
  showSourcesCard: false,
  showKontinuitaetCard: false,
  showErzaehlprofilCard: false,
  showTagebuchRueckblickCard: false,
  showBookStatsCard: false,
  showStilCard: false,
  showFehlerHeatmapCard: false,
  showRedundanzCard: false,
  showWortschatzCard: false,
  showStrukturCard: false,
  showTitelwerkstattCard: false,
  showChatCard: false,
  showIdeenCard: false,
  showReferenceCard: false,
  showBookChatCard: false,
  showBookSettingsCard: false,
  showUserSettingsCard: false,
  showMyStatsCard: false,
  showHelpCard: false,
  showOnboardingCard: false,
  // First-Login-Willkommens-Banner (zeigt einmalig auf „Erste Schritte").
  // Serverseitig gemerkt (welcomeDismissed); Loader _loadOnboardingWelcome.
  onboardingWelcome: false,
  showAdminUsersCard: false,
  showAdminSettingsCard: false,
  showAdminUsageCard: false,
  showAdminCategoriesCard: false,
  showAdminBooksCard: false,
  showAdminLogsCard: false,
  showAdminParseFailsCard: false,
  showAdminJsErrorsCard: false,
  showAdminDevicesCard: false,
  showAdminBackupCard: false,
  adminUsageTab: 'users',
  showFinetuneExportCard: false,
  showSnapshotsCard: false,
  showExportCard: false,
  showPdfExportCard: false,
  showEpubExportCard: false,
  showDocxExportCard: false,
  showFolderImportCard: false,
  showBookOrganizerCard: false,
  showBookEditorCard: false,
  showSearchCard: false,
  showShareLinksCard: false,
  showKomplettStatus: false,
  // Teil-Lauf der Komplettanalyse: die beiden read-only Endphasen (Kontinuitätsprüfung
  // P8, Erzählprofil) einzeln abwählbar. Sie sitzen am Ende der seriellen Kette und
  // kosten damit Wartezeit UND Geld — wer nach einer Kapitel-Änderung nur den Katalog
  // auffrischt, braucht sie nicht. Default false = alles läuft (unverändertes
  // Verhalten); nachziehen geht über die Standalone-Jobs der jeweiligen Karte.
  komplettSkipContinuity: false,
  komplettSkipNarrativeProfile: false,
  showAvatarMenu: false,
  // Overflow-Menü ("⋯") der Seiten-Action-Leiste (Notebook-Seitenansicht).
  pageActionsMenuOpen: false,
  // Tastenkürzel-Overlay (natives <dialog> via Alpine.data('modal'), an dieses
  // Flag gekoppelt). Toggle via toggleShortcutsOverlay() / `?`-Hotkey.
  shortcutsOpen: false,
});

const statusState = () => ({
  status: '',
  statusSpinner: false,
  _statusTimer: null,
});

// Confirm-Dialog (Ersatz für window.confirm). Native confirm() lässt Chrome
// auf macOS aus dem nativen Vollbild-Space rausspringen — bricht u.a. den
// Focus-Mode-Cancel-Flow. Wir nutzen stattdessen natives <dialog> +
// showModal() (DOM-Modal, kein OS-Modal); Markup in index.html, Helper
// `appConfirm`/`appPrompt` in app-chrome.js. Buttons rufen
// `_resolveConfirmDialog(bool)`.
const confirmDialogState = () => ({
  confirmDialogMessage: '',
  confirmDialogConfirmLabel: '',
  confirmDialogCancelLabel: '',
  confirmDialogDanger: false,
  // Input-Mode (Prompt-Variante via appPrompt): zeigt Textfeld; Resolver
  // liefert getrimmten Input-String (oder null bei Cancel).
  confirmDialogInput: false,
  confirmDialogInputValue: '',
  confirmDialogInputPlaceholder: '',
  _confirmDialogResolve: null,
});

// Seiten-Lektorat (Finding-Liste, Apply-Flow, Token-Estimates). `correctedHtml`
// ist die Lektorat-überlagerte HTML-Fassung (Overlay über `renderedPageHtml`,
// nur wenn `checkDone`); `hasErrors` flaggt, ob das Overlay harte Korrekturen
// enthält. Notebook/Focus berühren beides nicht (Invariante: editMode ⇒
// !checkDone).
const lektoratState = () => ({
  analysisOut: '',
  correctedHtml: null,
  hasErrors: false,
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
  // Buchweite Badge-Count-Maps (ideenCounts, chapterIdeenCounts, rechercheCounts,
  // chapterRechercheCounts, plotBeatCounts, chapterPlotBeatCounts,
  // shareCommentCounts, shareLinkCounts) leben in Alpine.store('badges')
  // (cards/badges-store.js) und werden direkt via $store.badges / this.$store.badges
  // bzw. Alpine.store('badges') gelesen (kein Root-Proxy). Die abgeleiteten
  // currentPage*Count-Skalare der offenen Seite bleiben hier (page-/currentPage-gebunden).
  // Scope der aktuell offenen Ideen-Karte: 'page' (neben Editor) oder
  // 'chapter' (neben Kapitelreview). ideenChapterId nur in 'chapter'-Modus
  // gesetzt. currentPageIdeenOpenCount/currentChapterIdeenOpenCount halten die
  // Badge-Counts fuer den jeweiligen Toggle-Button.
  ideenScope: 'page',
  ideenChapterId: null,
  currentChapterIdeenOpenCount: 0,
  showTokLegend: false,
  tokLegendPos: { x: 0, y: 0 },
  tokTooltipData: null,
  showPageStatusTip: false,
  pageStatusTipPos: { x: 0, y: 0 },
  pageStatusTipLines: [],
  // Lektorat-Check-Polls werden per-pageId gehalten (`_checkPollTimer_<id>`),
  // damit ein Seitenwechsel den Poll der Ursprungsseite nicht abreisst.
  // IntersectionObserver-basiertes Lazy-Loading der Token-Estimates für die
  // Sidebar (Server-Endpoint `/sync/page-stats/:bookId`). Refs hier, damit
  // _resetBookScopedState() / destroy() sauber aufräumen können.
  _statsObserver: null,
  _statsObserverMutation: null,
  _statsObserverState: null,
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

// Permalink-Spiegel der Werkstatt-/Plot-/Rückblick-Karten (werkstattDraftId,
// werkstattDrafts, plotBeatId, rueckblickEntryId, pendingRueckblickZeitraum) leben
// in Alpine.store('nav') (cards/nav-store.js). Die jeweilige Karte hält ihren SSoT
// (selectedDraftId/editingBeatId/selectedRueckblickId) und spiegelt per $watch in den
// Store; der Hash-Router liest/schreibt dort, weil er sie beim Cold-Open eines
// Permalinks braucht, BEVOR die Karte gemountet ist.

// Katalog-UI-State (Filter/Selektion/Lade-Stempel für figuren/ereignisse/szenen/
// orte/songs/kontinuitaet, deren Daten in Alpine.store('catalog') liegen) lebt in
// Alpine.store('catalogUi') (cards/catalog-ui-store.js) und wird direkt via
// $store.catalogUi / this.$store.catalogUi gelesen (kein Root-Proxy).
// Owner-Schreibpfade: app-navigation (Filter/Selektion bei Deep-Link-Sprüngen),
// app-hash-router (selectedXxxId als Hash-Router-SSoT), app-jobs-core + tree
// (figurenLoading/Progress/Status), app-view/bookscope + app-init
// (FILTER_SCOPES-Persist/Restore/Reset). Hier bleibt nur der reconnect-relevante
// Figuren-Poll-Timer am Root.
const figurenState = () => ({
  _figuresPollTimer: null,
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

// Collaboration-/Presence-/Soft-Lock-State lebt in Alpine.store('collab')
// (cards/collab-store.js) und wird direkt via $store.collab / this.$store.collab
// gelesen (kein Root-Proxy). Owner: app/app-collab.js.

// Buch-Erstellungs-Modal (Trigger: Combobox-Footer "+ Neues Buch") ist eine eigene
// Karte Alpine.data('bookCreateCard') auf dem <dialog> (cards/book-create-card.js) —
// State + Methoden leben dort, nicht mehr im Root.

// Tages-Schreibziel-Donut im Header lebt in Alpine.store('progress')
// (cards/progress-store.js) — Daten im Store statt am Root, weil der Donut im
// Root-Header rendert und es keine Karte gibt, die ihn hosten könnte.
// Loader/Reset/headerTodayRing bleiben Root-Methoden (app-view/bookscope.js).

// Entity-Linking pro Buch (Figuren-/Orte-Highlights + Szenen-/Ereignisse-Panel
// im Notebook-Editor). Source-of-Truth ist book_settings.entities_enabled —
// hier nur Spiegel, gesetzt von _loadBookFlagsForCurrentBook (beim Buchwechsel)
// und vom Toolbar-Toggle (toggleEntitiesEnabledForCurrentBook).
// entityPanelOpen kontrolliert die Klappschiene neben dem Editor-Body. Initial
// aus localStorage (`sw:entityPanelOpen`); Persistenz via $watch in app.js#init.
// Toolbar-Toggle "Entities aktivieren" oeffnet die Leiste einmalig beim
// Aktivieren (siehe editor-notebook.html).
const entitiesState = () => {
  let entityPanelOpen = false;
  try { entityPanelOpen = localStorage.getItem('sw:entityPanelOpen') === '1'; } catch (_) {}
  return {
    entitiesEnabledForCurrentBook: false,
    entityPanelOpen,
    _entitiesBusy: false,
    // Zitierstil + Buchsprache des aktuellen Buchs — Spiegel von
    // book_settings.citation_style bzw. .language, gesetzt vom selben Fetch wie
    // entitiesEnabledForCurrentBook (_loadBookFlagsForCurrentBook). Der
    // Beleg-Chip im Notebook-Editor formatiert seinen Kurzbeleg damit; ohne
    // Spiegel muesste jedes Einfuegen erst die Buch-Settings nachladen.
    citationStyleForCurrentBook: 'apa7',
    citationLangForCurrentBook: 'de',
  };
};

// Job-Infrastruktur-State (Queue-Footer, Job-Done-Toast, „Alle aktualisieren"/
// Komplettanalyse-Status) lebt in Alpine.store('jobs') (cards/jobs-store.js) und
// wird direkt via $store.jobs / this.$store.jobs gelesen (kein Root-Proxy).
// Owner: app/app-jobs-core.js + app/app-komplett.js.

export function initialLektoratState() {
  return {
    ...shellState(),
    ...navigationState(),
    ...pageState(),
    ...notebookState(),
    ...focusState(),
    ...editorPopupState(),
    ...cardsState(),
    ...statusState(),
    ...confirmDialogState(),
    ...lektoratState(),
    ...bookReviewState(),
    ...kapitelReviewState(),
    ...figurenState(),
    ...chatsState(),
    ...featuresUsageState(),
    ...entitiesState(),
  };
}
