# State-Modell (Frontend)

Verbindlicher Aufbau des Alpine-State. Vor jeder UI-Änderung die richtige Ebene wählen — Root vs. Sub-Komponente vs. Store entscheidet über Reaktivität, Lifecycle und Speicherlecks.

## Drei Ebenen

1. **Root `Alpine.data('lektorat')`** ([public/js/app.js](../public/js/app.js)) — `x-data="lektorat"` am `<body>`. SSoT für: Navigation, Session/Shell, i18n-Locale, **alle `showXxxCard`-Flags** (Hash-Router + Exklusivität), Job-Queue, Editor-Edit-Mode, Auto-Save, Selection. Cross-Cutting-Methoden: `t/tRaw`, `bsGet/bsGetAll`, `loadFiguren/loadOrte/loadSzenen`, `selectPage`, `gotoStelle`, `_closeOtherMainCards`.
2. **Sub-Komponenten `Alpine.data('xxxCard')`** in [public/js/cards/](../public/js/cards/) — eine pro UI-Card. Eigener fachlicher State + `init()`/`destroy()`. Karten haben **keine** eigenen `showXxxCard`-Flags (Root ist SSoT); sie hören via `$watch(() => window.__app.showXxxCard)` auf Öffnen/Schliessen.
3. **`Alpine.store(...)`** — geteilte, benannte State-Inseln. Zugriff ausschliesslich **direkt** via `$store.<name>` (Templates) / `this.$store.<name>` (Komponenten + in den Root gespreadete Module) / `Alpine.store('<name>')` (pure Helper) — sichtbare Abhängigkeit statt ambient `window.__app`. **Kein Root-Proxy mehr:** der frühere Getter/Setter-Shim in app.js, der Store-Felder unter den alten Namen (`this.x` / `$app.x`) spiegelte, ist für **alle** Stores abgebaut (`catalog`, `catalogUi`, `nav`, `session`, `shell`, `tts`, `stt`, `config`, `collab`, `jobs`, `badges`). Neue geteilte State-Insel → neuer Store, nie ein Root-Proxy. **Gegated:** [tests/unit/architecture-tripwire.test.mjs](../tests/unit/architecture-tripwire.test.mjs) zieht die Store-Liste dynamisch aus `cards/*-store.js` und macht CI rot, sobald app.js einen `Alpine.store('<name>')`-Forwarder (Root-Proxy) für irgendeinen Store enthält — Root liest geteilten State ausschliesslich via `this.$store.<name>`.
   - **`catalog`** ([catalog-store.js](../public/js/cards/catalog-store.js)) — Fach-Daten `figuren / orte / songs / szenen / globalZeitstrahl / zeitstrahlChronology`. **Kein Root-Proxy** (wie `tts`/`stt`/`config`): Root-Computeds/-Slices + in den Root gespreadete Fachmodule lesen `this.$store.catalog.*`, Karten/Helper `Alpine.store('catalog').*`, Templates `$store.catalog.*`. Die Lookup-Maps `figurenById`/`orteById`/`szenenById` (Root-Computeds) lesen ebenfalls hier; `loadFiguren` etc. **reassignen** die Arrays (nie pushen), damit der Map-Cache rebuildet.
   - **`catalogUi`** ([catalog-ui-store.js](../public/js/cards/catalog-ui-store.js)) — UI-Begleitstate der Katalog-Daten: Filter (`figuren/ereignisse/szenen/orte/songs/kontinuitaetFilters`), Selektion (`selectedFigurId/SzeneId/OrtId/SongId` — Hash-Router-SSoT, analog `nav.selectedBookId`), Lade-/Stempel-Flags (`figurenLoading/Progress/Status`, `szenen/orte/songsUpdatedAt`). **Kein Root-Proxy:** in den Root gespreadete Module (app-navigation, app-hash-router, app-jobs-core, app-view/bookscope, app-init, book/szenen·orte·songs·kontinuitaet·tree) via `this.$store.catalogUi.*`, Karten/Helper via `Alpine.store('catalogUi').*`, Templates via `$store.catalogUi.*`. Die `selectedXxxId` werden vom Hash-Router per Getter gewatcht (`() => this.$store.catalogUi.selectedFigurId`); die Filter persistiert `FILTER_SCOPES` (app-view/_shared.js) pro Buch im localStorage, ebenfalls über Getter-Watch (`app-init.js`). **Bewusst am Root:** `_figuresPollTimer` (reconnect-relevant, in `figurenState`). Gegated wie `nav`: [tests/unit/architecture-tripwire.test.mjs](../tests/unit/architecture-tripwire.test.mjs) prüft Store-Definition + Abwesenheit in app-state.js.
   - **`nav`** ([nav-store.js](../public/js/cards/nav-store.js)) — Navigations-State `books / selectedBookId / pages / tree` (von ~29 Modulen gelesen) + die Permalink-Spiegel der Werkstatt-/Plot-/Rückblick-Karten (`werkstattDraftId / werkstattDrafts / plotBeatId / rueckblickEntryId / pendingRueckblickZeitraum`). **Kein Root-Proxy:** Root-Computeds/-Slices + gespreadete Module via `this.$store.nav.*`, Karten/Helper via `Alpine.store('nav').*`, Templates via `$store.nav.*`. Der Buchorganizer mutiert `tree`/`pages` in-place (push/splice/sort) direkt auf dem reaktiven Store-Array; der Hash-Router watcht `selectedBookId / werkstattDraftId / plotBeatId / rueckblickEntryId` per Getter (`() => this.$store.nav.<feld>`), nicht per String-Pfad. **Warum die Permalink-Spiegel im Store statt in der Karte:** die jeweilige Karte hält ihren SSoT (`selectedDraftId/editingBeatId/selectedRueckblickId`) und spiegelt per `$watch` hierher; der Hash-Router (Root-Singleton) muss sie beim Cold-Open eines Permalinks lesen/schreiben, **bevor** die Karte gemountet ist — eine Karten-lokale Heimat wäre dann unsichtbar. `werkstattDrafts` spiegelt zusätzlich die Draft-Liste, damit die Command-Palette sie indizieren kann, ohne dass die Werkstatt je geöffnet wurde.
   - **`session`** ([session-store.js](../public/js/cards/session-store.js)) — Auth/Session `currentUser / sessionExpired / serverOffline / isOffline / devMode` (von ~33 Modulen + Root-Chrome gelesen). **Kein Root-Proxy:** Root-Slices/-Methoden + gespreadete Module via `this.$store.session.*`, Karten/Helper via `Alpine.store('session').*`, Templates via `$store.session.*`. Methoden (`logout`, Session-Banner, Online/Offline-Handler) bleiben am Root.
   - **`shell`** ([shell-store.js](../public/js/cards/shell-store.js)) — App-Meta/Shell `appReady / updateAvailable / bossScreenActive / themePref / uiLocale / defaultRegion / appTimezone / appName / appVersion / isMac / promptConfig` (sehr breit gelesen, allen voran `uiLocale` für `t()` + Date-Locale). **Kein Root-Proxy:** `this.$store.shell.*` / `$store.shell.*` / `Alpine.store('shell').*`. Methoden (`setTheme`, `changeLocale`, `t`/`tRaw`) bleiben am Root; `t()` trackt Reaktivität via `void this?.$store?.shell?.uiLocale`. **Bewusst NICHT migriert:** `focusGranularity`/`typewriterAnchor` bleiben am Root, weil der Editor-Kern sie über den editor-host-Vertrag ([shared/editor-host.js](../public/js/editor/shared/editor-host.js)) direkt von `window.__app` bzw. dem injizierten Standalone-Host (Mac-Client) liest — dort gäbe es keinen Store.
   - **`collab`** ([collab-store.js](../public/js/cards/collab-store.js)) — Collaboration/Presence/Soft-Lock. **Kein Root-Proxy:** direkt via `$store.collab` / `this.$store.collab` (Owner: app/app-collab.js).
   - **`jobs`** ([jobs-store.js](../public/js/cards/jobs-store.js)) — Job-Infrastruktur: Queue-Footer (`jobQueueItems`/`jobQueueExpanded`/`_jobQueueTimer`), Job-Done-Toast (`jobToast`/`_jobToastTimer`/`_toastedJobIds`), Komplettanalyse-Status (`alleAktualisieren*`). **Kein Root-Proxy:** gespreadete Methoden (app/app-jobs-core.js, app/app-komplett.js) via `this.$store.jobs.*`, Templates via `$store.jobs.*`, pure Helper via `Alpine.store('jobs')`. Methoden (`alleAktualisieren`, `cancelJob`, `_maybeShowJobToast`, …) bleiben am Root.
   - **`tts`** ([tts-store.js](../public/js/cards/tts-store.js)) — TTS/Proof-Listening `enabled / pause / playing / paused / loading / index / total`. **Kein Root-Proxy** (Referenzfall fürs „direkt, eine-Wahrheit"-Endbild): Konsumenten greifen direkt zu — tts-proof.js (in den Root gespreadet) via `this.$store.tts.*`, app-init.js setzt `this.$store.tts.enabled/pause`, das Template bindet `$store.tts.*`.
   - **`stt`** ([stt-store.js](../public/js/cards/stt-store.js)) — STT-Diktat `enabled / vad / recording / pending / transcribing / busy / caretUserSet`. **Kein Root-Proxy** (wie `tts`): direkt via `this.$store.stt.*` (stt-dictation.js/stt-time.js/figur-lookup.js), `app.$store.stt.*` (Edit-Lifecycle), `$store.stt.*` (Template). stt-time.js watcht `() => this.$store.stt.recording` (Getter-Watch statt String-Pfad).
   - **`config`** ([config-store.js](../public/js/cards/config-store.js)) — read-only /config-Settings `mapTiles / languagetoolEnabled / languagetoolDebounceMs / researchChatEnabled / apiProvider / claudeModel / claudeMaxTokens / ollamaModel / openaiCompatModel`, einmalig in app-init.js via `this.$store.config.*` gesetzt. **Kein Root-Proxy** (wie `tts`/`stt`): Templates binden `$store.config.*` (avatar-menu.html Provider-Label), Karten lesen `this.$store.config.*` (orte-map.js, user-settings) bzw. `ctx.$store.config.*` (research-chat.js), der Spellcheck-Dispatcher watcht `() => app.$store.config.languagetoolEnabled`.
   - **`badges`** ([badges-store.js](../public/js/cards/badges-store.js)) — buchweite Badge-Count-Maps `ideenCounts / chapterIdeenCounts / rechercheCounts / chapterRechercheCounts / plotBeatCounts / chapterPlotBeatCounts / shareCommentCounts / shareLinkCounts` (Sidebar-Indikatoren + Kapitel-/Editor-Badges). **Kein Root-Proxy:** Root-gespreadete Module (tree.js, app-view/badges.js, app-view/bookscope.js) schreiben via `this.$store.badges.*`, Helper-Module (ideen.js, recherche.js) via `Alpine.store('badges').*`, Templates lesen `$store.badges.*`. Schreibpfad immer Map-Reassignment (nie In-Place-Index-Assign), damit Alpine feuert. Die abgeleiteten `currentPage*Count`-Skalare bleiben am Root (currentPage-gebunden, nicht buchweit).
   - **`progress`** ([progress-store.js](../public/js/cards/progress-store.js)) — Tages-Schreibziel-State des Header-Donuts `dailyProgressBookId / dailyProgressStats / dailyProgressIsFinished / dailyProgressDailyGoalChars / _dailyProgressLoadingBookId`. Im Store statt in einer Karte, weil der Donut direkt im Root-Header-`<template>` rendert (es gibt keine Karte, die ihn hosten könnte). **Kein Root-Proxy:** Loader/Reset/`headerTodayRing()` (app-view/bookscope.js) via `this.$store.progress.*`, book-settings/settings.js spiegelt is_finished/daily_goal via `Alpine.store('progress').*`, das Header-Template liest `$store.progress.*`.

## Root-State-Slices ([public/js/app/app-state.js](../public/js/app/app-state.js))

`initialLektoratState()` spreadet **21 Slice-Funktionen** in ein flaches Root-Objekt. Neues Feld → in den passenden Slice:

| Slice | Inhalt |
|-------|--------|
| `shellState` | **Residual-Root-State** (Auth/Session → `$store.session`, App-Meta → `$store.shell`): nur noch `focusGranularity`, `typewriterAnchor` (editor-host-Vertrag, von `window.__app`/Standalone-Host gelesen) + `_abortCtrl`, `_usersByEmail`/Loading (interne Lazy-Caches) |
| `navigationState` | books, bookFilter\*, selectedBookId, bookRoles/currentBookRole/bookSharedFlags (ACL), pages, tree, Hash-Router-Internals (`_applyingHash`, `_hashInitialized`, `_inHashApply`, `_hashUpdatePending`, `_navDepth`), Order-Maps (`_chapterOrderMap`, `_pageOrderMap`, `_pageIdOrderMap`), pageSearch, newChapter-Felder |
| `pageState` | Mode-agnostischer Seiten-Inhalt: currentPage, currentPageEmpty/IdeenOpenCount/ChatSessionCount, renderedPageHtml, originalHtml, chapterFigures/showChapterFigures, newPage-Felder. Notebook, Focus und View lesen alle hier |
| `notebookState` | Notebook-Editor-Lifecycle: editMode, editDirty, editSaving, saveOffline, editConflict, pendingDraft, lastAutosaveAt/lastDraftSavedAt, Auto-Save-Timer (`_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler`), pageEditorFullscreen/Zoom/FitWidth |
| `focusState` | Focus-Editor: focusActive (SSoT „Fokusmodus an"), focusCountWords/Chars + Deltas (Live-Counter im Fokus-Header). Dirty-/Saving-Zustand kommt aus `notebookState` — der Focus-Editor läuft auf der Notebook-Save-Pipeline |
| `editorPopupState` | Spiegel-Flags `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen` (für Escape-Routing in `editor-focus-onKey`) + `_figurLookupIndex` (Lookup-Cache) |
| `cardsState` | **Alle `showXxxCard`-Flags** inkl. Admin-Karten (showAdminUsers/Settings/Usage/Categories/BooksCard), showSongsCard, showKontinuitaetCard, showSearchCard, showKomplettStatus, showAvatarMenu, adminUsageTab — exklusiv via `_closeOtherMainCards(keep)` |
| `statusState` | status, statusSpinner, `_statusTimer` |
| `confirmDialogState` | Native-`<dialog>`-Modal-Ersatz für `window.confirm`/prompt (verhindert macOS-Vollbild-Bug) inkl. Input-Mode + Resolver |
| `lektoratState` | analysisOut, correctedHtml, hasErrors, lektoratFindings, selectedFindings, appliedOriginals, appliedHistoricCorrections, checkDone/Loading/Progress/Status, saveApplying, batchLoading/Progress/Status, lastCheckId, pageHistory, activeHistoryEntryId, Token-Estimates (`tokEsts`, `_tokenEstGen`), pageLastChecked, ideenCounts/chapterIdeenCounts, ideenScope/ideenChapterId/currentChapterIdeenOpenCount, showTokLegend/tokTooltipData/showPageStatusTip, `_statsObserver*` |
| `bookReviewState` | bookReviewHistory (von tree.js geschrieben, von user-settings beim Reset gelesen → Root) |
| `kapitelReviewState` | kapitelReviewChapterId (Hash-Router-SSoT) |
| ~~`tagebuchRueckblickNavState` / `figurWerkstattState` / `plotNavState`~~ | **migriert → `$store.nav`** (Permalink-Spiegel `pendingRueckblickZeitraum/rueckblickEntryId/werkstattDraftId/werkstattDrafts/plotBeatId`, Hash-Router-SSoT); kein Root-Slice mehr |
| `figurenState` | nur noch `_figuresPollTimer` (Reconnect-relevant → Root). Filter/Selektion/Lade-Flags (`figurenLoading/Progress/Status`, `selectedFigurId`, `figurenFilters`) → `$store.catalogUi` |
| ~~`ereignisseState` / `szenenState` / `orteState` / `songsState` / `kontinuitaetState`~~ | **migriert → `$store.catalogUi`** (Filter + `selectedXxxId` + `UpdatedAt`); kein Root-Slice mehr |
| `chatsState` | `_checkDoneBeforeChat` |
| `featuresUsageState` | recentFeatureKeys (Top-3 Quick-Pills), recentPageIds (Palette) |
| ~~`bookCreateState`~~ | **migriert → Karte `bookCreateCard`** ([book-create-card.js](../public/js/cards/book-create-card.js) auf dem `<dialog>`); Root-Trigger `openCreateBook()` dispatcht `book-create:open` |
| `collabState` | `_collabSince`, `_collabPollTimer`, recentRemoteEdits (`Map<page_id, { isSelf, device }>` — `isSelf` trennt eigenes Zweit-Gerät von fremdem User, Tooltip via `remoteEditTip()`), collabToast/`_collabToastTimer`, livePresenceByPage, Heartbeat-Timer (`_presencePingTimer`/`_presencePingPageId`), Geraete-Ping (`_bookDevicePingTimer`/`_bookDevicePingBookId`/`_selfPageDeviceCount` — page-scoped Multi-Device-Erkennung), Lock-State (`_currentEditLock`, `_lockHeartbeatTimer`, foreignEditLock) |
| ~~`dailyProgressState`~~ | **migriert → `$store.progress`** ([progress-store.js](../public/js/cards/progress-store.js); Header-Donut neben Avatar). Loader/Reset/`headerTodayRing()` bleiben Root-Methoden (app-view/bookscope.js) |
| `entitiesState` | entitiesEnabledForCurrentBook, entityPanelOpen (localStorage-persistiert `sw:entityPanelOpen`), `_entitiesBusy` (Inline-Entitäten-Panel im Editor) |

**Regel:** Slices sind Funktionen (nicht Konstanten), damit jede Komponenten-Instanz frische Arrays/Objekte erhält. Sonst geteilte Referenzen.

## Computed-Maps am Root (Performance)

`figurenById / orteById / szenenById` (Getter am Root in [public/js/app.js](../public/js/app.js)) sind getter-basierte O(1)-Lookups, die nur bei Referenzwechsel der Quell-Arrays neu gebaut werden. **`loadFiguren` etc. müssen die Arrays reassignen, nie pushen** — sonst rebuildet der Cache nicht. Render-Loops in figuren.html/orte.html/szenen.html nutzen diese Maps statt `.find()`.

Weitere Root-Computeds: `szenenNachKapitel`, `szenenNachSeite`, `orteFiltered`, `szenenFiltered`, `filteredTree`, `selectedBookName`, `selectedBookUrl`, `statusHtml`, `ideenMovePickerOptions()`.

## Lifecycle

Root-`init()`/`destroy()` leben als Methoden-Modul in [public/js/app/app-init.js](../public/js/app/app-init.js) und werden in die Root gespreadet (nicht inline in app.js).
- **Root `init()`** ([app-init.js](../public/js/app/app-init.js)): setzt `window.__app = this` (für `$app`-Magic), erzeugt `_abortCtrl = new AbortController()`, registriert globale Listener mit `{ signal }`.
- **Root `destroy()`** ([app-init.js](../public/js/app/app-init.js)): `_abortCtrl.abort()` → alle Listener weg in einem Schlag. Plus `clearInterval(_jobQueueTimer)`, `clearTimeout(_statusTimer)`, `_teardownStatsObserver()`. **Pflicht für jede neue globale Subscription:** `{ signal: this._abortCtrl.signal }` an `addEventListener` — sonst Leak bei HMR/Re-Init.
- **Sub-`init()`/`destroy()`**: Karten managen ihre Window-Listener selbst — der Soll-Pattern dafür ist [`setupCardLifecycle`](../public/js/cards/card-lifecycle.js) (siehe nächste Section). vis-network/Chart-Instanzen explizit `.destroy()` callen + Refs nullen (sonst halten DataSets das alte Buch im Speicher).

## Soll-Pattern für Buch-scoped Karten: `setupCardLifecycle`

Karten, die auf `book:changed` / `view:reset` / `card:refresh` reagieren und beim Öffnen Daten laden, nutzen [`setupCardLifecycle`](../public/js/cards/card-lifecycle.js). Der Helper kapselt die drei Window-Listener + Timer-Cleanup hinter einem `init()`-Aufruf und einem `destroy()`-Aufruf.

**Default-Soll:**

```js
import { setupCardLifecycle } from './card-lifecycle.js';

window.Alpine.data('orteCard', () => ({
  orteLoading: false,
  orteProgress: 0,
  orteStatus: '',
  _ortePollTimer: null,
  _lifecycle: null,

  init() {
    this._lifecycle = setupCardLifecycle(this, {
      name: 'orte',                                // matcht event.detail.name auf card:refresh
      showFlag: 'showOrteCard',                    // Root-Flag, das per $watch beobachtet wird
      timerKeys: ['_ortePollTimer'],               // Poll-Timer auf ctx, automatisch geclearet
      resetState: { orteLoading: false, orteProgress: 0, orteStatus: '' },
      load: (root) => root.loadOrte(root.selectedBookId),
    });
  },
  destroy() { this._lifecycle?.destroy(); },
}));
```

Der Helper macht:
- `$watch(showFlag)` → bei `true` + `selectedBookId` → `cfg.onShow ?? cfg.load`.
- `book:changed` → Timer clear + `resetState` + (sichtbar + Buch vorhanden) → `cfg.load`.
- `view:reset` → Timer clear + `resetState` (KEIN Reload).
- `card:refresh` → wenn `event.detail.name === cfg.name` und Buch vorhanden → `cfg.load`.
- `destroy()` → `clearTimers` + `AbortController.abort()` (alle internen Listener weg).

**Optional cfg-Felder:**
| Feld | Zweck |
|------|-------|
| `onShow(root)` | Override für `$watch(showFlag)`-Body (z.B. zusätzliche Side-Effects wie Textarea-Fokus, oder Mehrfach-Load). |
| `onBookChanged(e, ctx, root)` | Vollständiger Override; skipt das Default-`reset+load`. Nutzen für Karten mit Coalesce-Logik (Microtask, debounce). |
| `onViewReset(e, ctx, root)` | Vollständiger Override fürs `view:reset`-Verhalten. Nutzen, wenn `view:reset` mehr räumt als `book:changed` (z.B. user-scoped Profile-Liste in PDF-Export). |
| `resetStateView` | Eigenes Reset-Objekt nur fürs `view:reset` (wenn book vs. view unterschiedlich resetten). |
| `refreshNeedsBookId: false` | Default: `card:refresh` ignoriert wenn kein Buch aktiv. False für Karten mit eigener Buch-Prüfung. |
| `showNeedsBookId: false` | Analog für `$watch(showFlag)`. |
| `extraListeners: [{ type, handler }]` | Zusätzliche Window-Events (z.B. `chat:reset`, `book-chat:reset`, `ideen:reset`, `kapitel-review:select`, `book-stats:select`, `job:reconnect`). Werden über denselben AbortController automatisch wieder abgemeldet. |

**Rückgabewert:** `{ signal, destroy }`. `signal` ist der `AbortController.signal` der internen Listener — Karten können eigene `addEventListener(..., { signal })` damit registrieren und sparen sich das `removeEventListener`.

**Wann nicht nutzen:** Karten ohne `book:changed`/`view:reset`/`card:refresh`-Trio (Editor-Slices wie [editor-find-card](../public/js/cards/editor-find-card.js), [editor-figur-lookup-card](../public/js/cards/editor-figur-lookup-card.js)) verwenden direkt `AbortController` ohne Helper. Karten mit komplett-anderer Reset-Semantik (Coalesce + microtask wie [book-overview-card](../public/js/cards/book-overview-card.js); zweistufiger Form-Unmount wie [pdf-export-card](../public/js/cards/pdf-export-card.js)) bleiben manuell — der Helper ist Convenience, nicht Pflicht.

## `$app` / `window.__app` (Root-Zugriff aus Subs)

Alpine's `$root` zeigt auf das nächste `x-data` (= Sub selbst), nicht auf die `lektorat`-Root.
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren` — via `Alpine.magic('app', …)` in [public/js/app/register-cards.js](../public/js/app/register-cards.js) (`registerAppMagics`).
- **In JS-Methoden/Gettern** (Subs): `window.__app.xxx`. Magics sind in JS-Getter-Ausführungen nicht zuverlässig; `window.__app` ist robust und ein reaktiver Alpine-Proxy.

## Event-Bus (Root → Subs)

Custom-Events am `window`. Vollständige Liste:

| Event | Dispatcher | Hörer | Zweck |
|-------|-----------|-------|-------|
| `book:changed` | `_resetBookScopedState()` | alle Subs mit Buchscope | State resetten + bei offener Karte neu laden |
| `view:reset` | `resetView()` | alle Subs | Lokalen State komplett nullen |
| `card:refresh` `{ name }` | erneuter Klick auf offene Karte | passende Sub | Daten neu laden |
| `job:reconnect` `{ type, jobId, job, extra? }` | `checkPendingJobs()` | review/kapitel-review/figuren/komplett | Loading-State übernehmen + Polling starten |
| `job:finished` `{ type, jobId, job, dedupId, bookId }` | `_detectFinishedJobs()` (Diff aus `/jobs/queue`) | Root + Subs | Sidebar/History idempotent updaten, auch wenn kein per-Card-Poller mehr läuft (Reload-Lücke). Konsumenten müssen idempotent sein — fired auch parallel zu per-Card-onDone. |
| `chat:reset` / `book-chat:reset` | Seitenwechsel / User-Settings-Reset | chat-card, book-chat-card | Session leeren |
| `kapitel-review:select` `{ chapterId }` | Sidebar / Hash-Router | kapitel-review-card | Chapter-ID setzen |
| `book-stats:select` | Hash-Router | book-stats-card | Statistik-Tab wählen |
| `palette:open` | global | palette-card | Command-Palette öffnen |
| `app:update-available` | Service-Worker-Listener | Root-Banner | Update-Hinweis |
| `session-expired` | `fetch`-Wrapper | Root | Banner zeigen |

## Karten-Inventar (Alpine.data-Names)

**SSoT: [public/js/app/register-cards.js](../public/js/app/register-cards.js)** — `registerAllCards()` ruft jede `registerXxxCard()` auf; die Import-Liste oben in der Datei ist die vollständige, drift-freie Quelle. `registerAppMagics()` registriert daneben `$app`/`$blog`/`$hubspot`/`$syncProviders` + die Stores. Beide werden im `alpine:init`-Handler in [app.js](../public/js/app.js) aufgerufen, bevor `Alpine.data('lektorat')` definiert wird. Grobe Gruppierung (Stand kann minimal nachhängen — bei Zweifel register-cards.js lesen):

- **Buchebene:** `bookOverviewCard`, `bookCreateCard`, `bookReviewCard`, `kapitelReviewCard`, `figurenCard`, `figurWerkstattCard`, `orteCard`, `songsCard`, `szenenCard`, `ereignisseCard`, `kontinuitaetCard`, `plotCard`, `worldFactsCard`, `tagebuchRueckblickCard`, `bookStatsCard`, `myStatsCard`, `stilCard`, `fehlerHeatmapCard`, `chatCard`, `bookChatCard`, `rechercheCard`, `ideenCard`, `finetuneExportCard`, `exportCard`, `pdfExportCard`, `epubExportCard`, `docxExportCard`, `bookSettingsCard`, `userSettingsCard`, `bookOrganizerCard`, `bookEditorCard`, `searchCard`, `folderImportCard`, `shareLinksCard`, `snapshotsCard`, `blogSyncCard`, `hubspotSyncCard`, `helpCard`, `paletteCard`.
- **Admin-Karten:** `adminUsersCard`, `adminSettingsCard`, `adminUsageCard`, `adminCategoriesCard`, `adminBooksCard`, `adminLogsCard`, `adminParseFailsCard`, `adminJsErrorsCard`, `adminDevicesCard`.
- **Editor-Slices:** `editorFindCard`, `editorSynonymeCard`, `editorFigurLookupCard`, `editorToolbarCard`, `editorFocusCard`, `editorNotebookCard`, `editorEntitiesCard`, `editorSpellcheckCard`, `lektoratFindingsCard`, `editorCommentsCard`, `pageHistoryCard`, `pageRevisionsCard`.

## Was bleibt im Root (nicht in Subs auslagern)

- Alle Show-Flags (Exklusivität!), Hash-Router, Auto-Save, Selection-Management, Editor-Edit-Mode, Job-Queue, Cross-Cutting-Loader (`loadFiguren` etc.), `_abortCtrl`-basiertes globales Listener-Setup.
- Editor-Module: `page-view`, `editor/edit`, `editor/utils`, `tree`, `history`, `api-ai`, `i18n`, `shortcuts` — gespreaded in den Root, nicht in eigene Subs.

## Drei Editoren

Die App hat **drei unabhängige Editoren**. Bei Änderungen muss der User benennen, welcher gemeint ist — siehe Harte Regel „Editor-Spezifikation" in [CLAUDE.md](../CLAUDE.md).

| Editor | Scope | Aktivierung | State | Doku |
|---|---|---|---|---|
| **Notebook-Editor** | eine Seite (Edit-Modus auf der `editor`-Karte) | `startEdit()` Button | `notebookState` + `editMode`-Flag | [notebook-editor.md](notebook-editor.md) |
| **Focus-Editor** | eine Seite (Vollbild-Schreibmodus, läuft auf Notebook) | `enterFocusMode()` / Cmd+Shift+E | `focusState` + `focusActive`-Flag | [focus-editor.md](focus-editor.md) |
| **Bucheditor** | ganzes Buch (eigene Karte `bookEditor`) | `toggleBookEditorCard()` aus Palette/Quick-Pills | Card-lokal in [`bookEditorCard`](../public/js/cards/book-editor-card.js); Root-Flag `showBookEditorCard` (`cardsState`) | [book-editor.md](book-editor.md) |

Bucheditor ist **kein Modus** auf einer Einzelseite — er ist eine eigenständige Karte mit eigener Save-Pipeline (`saveQueue`, pro Block) und keiner Verbindung zu `editMode`/`focusActive`. Exklusivität zum Notebook/Focus läuft über `_closeOtherMainCards` (`EXCLUSIVE_CARDS`-Eintrag in [feature-registry.js](../public/js/cards/feature-registry.js)), nicht über die Modus-Flags.

## Editor-Modi des Notebook-Editors (4 Stück, **Konsistenz kritisch**)

Vier orthogonale Modi am **Notebook-Editor** (nicht am Bucheditor) — kein Single-Enum, sondern Boolean-Flags am Root. Reihenfolge der Mutations und Invarianten sind **harte Regeln**: jede Änderung am Modus-Setup muss diese Tabelle aktuell halten.

| Modus | Flag | Slice / Datei | Enter | Exit |
|-------|------|---------------|-------|------|
| **Viewmodus** (Lesen) | _kein_ (= alle anderen `false`) | — | Default | — |
| **Prüfmodus** | `checkDone: true` | `lektoratState` ([app-state.js](../public/js/app/app-state.js)) | `runCheck()` ([editor/lektorat.js](../public/js/editor/lektorat.js)) → Polling → Setzen bei Done (ebd.) oder `loadHistoryEntry` ([history.js](../public/js/book/history.js)) | `closeFindings()` ([editor/lektorat.js](../public/js/editor/lektorat.js)) |
| **Editmodus** | `editMode: true` | `notebookState` ([app-state.js](../public/js/app/app-state.js)) | `startEdit()` ([editor/notebook/edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js)) | `cancelEdit()` / `saveEdit()` (ebd.) |
| **Fokusmodus** | `focusActive: true` | `focusState` ([app-state.js](../public/js/app/app-state.js)) | `enterFocusMode()` / `startFocusEdit()` / Cmd+Shift+E | `exitFocusMode()` / Esc / Cmd+Shift+E |

**Begleit-State pro Modus:**
- Prüfmodus: `lektoratFindings`, `selectedFindings`, `correctedHtml`, `hasErrors`, `analysisOut`, `appliedOriginals`, `appliedHistoricCorrections`, `lastCheckId`, `activeHistoryEntryId`, `checkProgress`, `checkStatus`, `_checkPollTimer`.
- Editmodus: `editDirty`, `editSaving`, `saveOffline`, `lastAutosaveAt`, `lastDraftSavedAt`, `_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler` (`notebookState`) + `originalHtml` (`pageState`, da Mode-agnostisch).
- Fokusmodus: `focusCountWords/Chars/*Delta` (`focusState`) + `focusGranularity` (`shellState`) + Sub-Maschine `_focusState` (`idle`/`entering`/`active`/`exiting`) + `_focusGen` (Re-Entry-Guard) in [editorFocusCard](../public/js/cards/editor-focus-card.js).

**Erlaubte Kombinationen** (8 Bool-Tripel, 4 erlaubt):

| Edit | Focus | Check | Erlaubt? | Bemerkung |
|------|-------|-------|----------|-----------|
| 0 | 0 | 0 | ✓ | Viewmodus |
| 0 | 0 | 1 | ✓ | View + Findings (Split-View) |
| 1 | 0 | 0 | ✓ | Edit |
| 1 | 1 | 0 | ✓ | Edit + Fokus |
| 1 | * | 1 | ✗ | **Invariante: Edit + Prüfmodus forbidden** — `startEdit` bricht bei `checkDone` ab; Edit/Fokus-Buttons sind im Prüfmodus ausgeblendet. |
| 0 | 1 | * | ✗ | **Invariante: `focusActive → editMode`** |

**Invarianten (Pflicht — bei Änderungen prüfen):**

1. `focusActive === true` ⇒ `editMode === true`. Enforced in [editor/focus/card.js](../public/js/editor/focus/card.js) (`enterFocusMode` bricht bei `!app.editMode` ab) und [editor/notebook/edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js) (`cancelEdit` ruft `exitFocusMode` zuerst).
2. `runCheck` darf nicht im Editmodus starten. Template-Guard: Prüfen-Button steht in `<template x-if="!editMode">` ([editor-notebook.html](../public/partials/editor-notebook.html)).
3. `editMode === true` ⇒ `checkDone === false`. Enforced in `startEdit` ([editor/notebook/edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js), Guard `if (this.checkDone) return`) und im Template über `x-show="canEdit() && !checkDone"` auf Edit/Fokus-Buttons ([editor-notebook.html](../public/partials/editor-notebook.html)). Findings im Editor sind damit ausgeschlossen — Korrekturen laufen via `saveCorrections` aus dem Prüfmodus, nicht via contenteditable.
4. **Chat-Modus** (showChatCard) snapshotet `checkDone` in `_checkDoneBeforeChat` und setzt `checkDone=false` ([chat-base.js](../public/js/chat/chat-base.js)); beim Schliessen Restore ([app-view/cards.js](../public/js/app/app-view/cards.js)). Ohne diesen Snapshot würde der Chat Findings doppelt rendern.
5. **Reset-Reihenfolge in `resetPage()`** ([app-view/page.js](../public/js/app/app-view/page.js)): `exitFocusMode` → `_stopAutosave` → Chat-Reset → Card-Flags → Editor-State (`editMode/editDirty/editSaving`) → Lektorat-State (`checkDone/findings/...`). Diese Reihenfolge ist Pflicht — Fokus zuerst, weil `exitFocusMode` `editMode/editDirty` liest.
6. `saveEdit` im Fokus bleibt im Fokus+Edit ([editor/notebook/edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js)) — User möchte weiter schreiben. Erst sauberer Exit räumt Edit-Mode auf, dann flusht `exitFocusMode` per `quickSave` ([editor/focus/card.js](../public/js/editor/focus/card.js)).
7. Hotkey Cmd+Shift+E ([editor/focus/trampoline.js](../public/js/editor/focus/trampoline.js) → `onKey`-Routing in [editor/focus/card.js](../public/js/editor/focus/card.js)) wirkt nur bei `showEditorCard` und routet zustandsabhängig: in Fokus → exit, in Edit → enter, sonst → startFocusEdit (Edit + Fokus in einem Schritt).

**Bei Modus-Erweiterung (z.B. „Diff-Modus", „Annotations-Modus")** dieser Section folgen:
1. Flag in passenden Slice von `app-state.js`.
2. Begleit-State + Timer-Refs daneben (gleicher Slice).
3. Invarianten-Tabelle hier ergänzen (Kombinations-Matrix).
4. `resetPage()` und `_resetBookScopedState()` um neuen Reset erweitern (gleiche Reihenfolge: neuer Modus zuerst aussen, sonst nach Lifecycle-Abhängigkeit).
5. Template-Guards setzen (analog `x-show="!editMode"` für Prüfen-Button).
6. Hotkey-Routing in handleFocusHotkey-Stil prüfen.
