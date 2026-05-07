# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Deployment, Docker-Setup und Env-Variablen: siehe [README.md](README.md).

**Lokal starten:** `npm install && npm start` (Port 3737). Tests: `npm test` (Playwright, erstmalig `npx playwright install chromium`).

## Harte Regeln

- **UI-Patterns nur aus [DESIGN.md](DESIGN.md)** — vor jeder neuen UI-Komponente (Karte, Toggle, Badge, Liste, Status, …) den Pattern-Katalog prüfen. Wiederverwenden statt parallel neu erfinden. Existiert das Pattern nicht: erst dokumentieren in `DESIGN.md` (Markup-Snippet + CSS-Datei + Use-Case), dann verwenden. Klappbare Sections nutzen ausschliesslich das `.collapsible-toggle` + `.history-chevron`-Pattern (kein `<details>`/`<summary>`, kein neuer Marker). Akzentfarben pro Karte über `--card-accent-xxx` aus `tokens.css`.
- **Prompts nur unter `public/js/prompts/` (Facade `public/js/prompts.js`)** — einzige Quelle für alle Prompt-Schemas und Build-Logik. Externe Imports gehen ausschliesslich über die Facade `prompts.js`; Submodule (`prompts/lektorat.js`, `prompts/komplett.js`, `prompts/chat.js`, …) sind interne Aufteilung. Server importiert die Facade via dynamic `import()`. NIEMALS Prompts in Route-Handlern, Config-Dateien oder anderswo duplizieren.
- **KI-Calls nur via Job-Queue** — neue Features implementieren einen Job-Typ in `routes/jobs/` (Funktion `runXxxJob` + `router.post`). Direkte synchrone KI-Calls aus Route-Handlern sind verboten. Einzige Ausnahme: Seiten-Chat (`/chat/send`) nutzt bewusst SSE-Streaming.
- **`callAI` gibt nur JSON zurück** — jeder Systemprompt muss JSON-Only erzwingen (`JSON_ONLY`-Konstante in `prompts/state.js`). Nach jedem `callAI`-Aufruf Pflichtfeld prüfen (z.B. `fehler`, `gesamtnote`, `figuren`). Fehler werfen statt falsche Daten rendern. **`truncated`-Flag IMMER vor `parseJSON` prüfen und werfen** — `jsonrepair` ist tolerant und liefert sonst Partial-Daten zurück (verhindert „silent partial"-Bug).
- **Styles nur in `public/css/`** — keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML. CSS auf 41 thematische Files aufgeteilt (Cards, Editor-Slices, Layout-Slices, Component-Slices). Cascade-Reihenfolge via `@layer base, components, utilities;` in [public/css/tokens.css](public/css/tokens.css) (tokens unlayered, Custom-Props global). Neue Datei → in passendes File einsortieren oder neue Datei anlegen + in [public/index.html](public/index.html) **und** [tests/fixtures/focus-harness.html](tests/fixtures/focus-harness.html) (gleiche Reihenfolge!) als `<link>` ergänzen + `SHELL_CACHE` in [public/sw.js](public/sw.js) bumpen.
- **UI-Strings nur in `public/js/i18n/{de,en}.json`** — keine hartcodierten deutschen/englischen Texte in HTML-Partials, JS-Modulen oder Alpine-Templates. Immer `t('bereich.feld')` (bzw. `tRaw()` ausserhalb von Alpine) verwenden. Neuer String → Key in **beiden** Locale-Dateien ergänzen (de = Fallback, en = Übersetzung). Key-Konvention: `bereich.feld` (z.B. `profile.title`). Platzhalter via `{name}` + Parameter-Map.
  - **Gilt auch serverseitig:** `updateJob`/`failJob`-`statusText` immer als i18n-Key setzen (z.B. `'job.phase.aiReply'`), dynamische Werte als `statusParams`-Objekt. Job-Labels via `{ key, params }` an `createJob`. Fehler-Messages, die der User sieht, ebenfalls als Key.
  - **Automatisch übersetzen, ungefragt:** jeder neue User-sichtbare String wird beim Hinzufügen sofort in beide Locale-Dateien eingetragen — egal ob Frontend-Label, Server-Status, Fehlertext, Placeholder oder Tooltip. Nie nur DE (oder nur EN) committen und auf „mach ich später" verschieben.
  - **Persistierte User-Nachrichten (z.B. Chat-Fallbacks in DB):** als `__i18n:bereich.feld__`-Marker speichern; Frontend löst beim Rendern via `t()` auf. So bleibt die Locale-Wahl des späteren Betrachters massgeblich.
  - **Ausnahme:** Winston-Logs (`logger.info/warn/error`) bleiben vorläufig deutsch — sie gehen nur in `lektorat.log`/Console, nicht an den User.
- **`bsGetAll` statt `bsGet` für Listen** — BookStack paginiert (Standard 20 Einträge). `bsGetAll` iteriert alle Seiten automatisch.
- **Read-Modify-Write nur mit `bsGet(..., { fresh: true })`** — jeder Pfad, der eine BookStack-Seite liest, modifiziert und mit `bsPut` zurückschreibt (Lektorat-Save, Chat-Vorschlag-Apply, History-Apply, Pre-Send-Refresh des Seiten-Chats), MUSS den Read mit `fresh: true` machen. Sonst liefert der SW-API_CACHE (SWR) eine Pre-Edit-Fassung — der nachfolgende PUT überschreibt frische Server-Edits aus dem Fokus-Editor mit Stale-Daten („Lektorat hat alte Version genommen"-Bug). `_bsWrite` postet nach jedem erfolgreichen Schreibvorgang `invalidate-api` an den SW als zweite Schutzschicht; weitere RMW-Pfade müssen sich trotzdem nicht darauf verlassen — `fresh: true` ist Pflicht. Test: [tests/unit/stale-write.test.mjs](tests/unit/stale-write.test.mjs).
- **Job-Ergebnisse mit `updatedAt`-Staleness-Check** — Server-Jobs, deren Resultate auf einem Snapshot des BookStack-Seitenstands operieren (Lektorat-Findings mit Positionen, Chat-Antworten mit `vorschlaege.original`), liefern `updatedAt: pd.updated_at`. Der Client vergleicht im `onDone` mit `currentPage.updated_at`; weicht es ab (User hat während der Analyse gespeichert), wird das Ergebnis verworfen statt angewandt. Sonst landen positionsbasierte Findings auf verschobenem Text und überschreiben die User-Edits.
- **401-Handling zentral** — ein globaler `window.fetch`-Wrapper in `public/js/app.js` fängt alle 401-Antworten ab und dispatcht `session-expired`; Alpine zeigt daraufhin den Session-Banner. Feature-Module prüfen 401 nicht selbst und dürfen das Event nicht unterdrücken. Kein Auto-Redirect – User soll ungespeicherte Inhalte retten können.
- **`x-html` nur mit vorab-escaptem Content** — jede Stelle, die ins `x-html` fliesst, muss KI-/User-Felder vor der Interpolation durch `escHtml()` aus `utils.js` geschleust haben. Gilt für Status-Strings (`_runningJobStatus`), Review-Renderer (`_renderReviewHtml`, `_renderKapitelReviewHtml`), Lektorat-Output (`analysisOut`), Chat-Markdown (`renderChatMarkdown` escaped als erstes). Keine neuen `x-html`-Sinks ohne dieses Escape. Keine Runtime-Sanitizer wie DOMPurify – die Escape-Invariante reicht.
- **A11y: klickbare Nicht-Buttons** — Elemente mit Klasse `.internal-link` (spans/divs mit `@click`) werden global in `app.js` via MutationObserver + Event-Delegation tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Nicht pro Element wiederholen. Neue klickbare Nicht-Buttons → einfach `.internal-link` setzen.
- **Progress-Bars** — `.progress-bar` liest die Breite aus CSS-Custom-Prop `--progress`. Binding: `:style="{ '--progress': xProgress + '%' }"`, nicht `:style="'width:' + ... + '%'"`.
- **Card-Animationen nur via CSS** — `.card` fadet via `cardFadeIn` (in [public/css/card-form.css](public/css/card-form.css)) ein. Kein `x-transition` zusätzlich auf `.card`-Elementen, sonst doppelt (CSS translateY + Alpine scale konkurrieren, wirkt wabbelig — sichtbar v.a. bei grossen Karten wie Szenen). Neue Karte: nur `x-show="..." x-cloak`, keine Alpine-Transition.
- **`SHELL_CACHE` bumpen** — bei JS/CSS-Änderungen Konstante in [public/sw.js](public/sw.js) hochzählen. Sonst halten Mobile-Browser via Service-Worker alte Bundle-Versionen fest.
- **Combobox statt `<select>`** — alle Auswahlfelder nutzen `Alpine.data('combobox')` aus [public/js/app.js](public/js/app.js). Kein natives `<select>` für neue Features, ausser bei zwingendem Grund (z.B. native Mobile-Picker erwünscht — dann begründen). `init()` rendert Trigger + Dropdown + Search + Liste komplett selbst und überschreibt `innerHTML` des Wrapper-Divs. Wrapper-Div **leer lassen**, nur Attribute setzen. Pflicht-Pattern (3 Attribute):
  ```html
  <div x-data="combobox(placeholder, emptyLabel?)"
       x-modelable="value" x-model="selectedRef"
       x-effect="options = computeOptionsInline()"></div>
  ```
  - `init()` setzt automatisch: `combobox-wrap`-Klasse (+ `--compact` per Default), document-Mousedown (Outside-Close), Element-Keydown (Tastatur-Nav). Kein `@click.outside`, kein `@keydown`, keine `class`-Attribute mehr im Konsumenten-Markup.
  - Object-Form für Variante non-compact (selten, z.B. Buchwahl in Hero-Row): `combobox({ placeholder: t('…'), compact: false })`.
  - `options`: Array `[{ value, label }]`. Inline-Expression im `x-effect` aufbauen (siehe DESIGN.md "Reaktivität bei Datenquelle aus Karten-Scope" — Method-Indirection trackt nicht zuverlässig).
  - `x-modelable="value" x-model="ref"` koppelt internen `value`-State an äusseres Feld. Ohne `x-modelable` greift `@combobox-change` nicht in den Parent-State durch.
  - `emptyLabel` (2. Positional-Arg oder `{emptyLabel}`) erzeugt „Alle"-Option mit Wert `''`. Weglassen für Pflichtauswahl.
  - Optional `@combobox-change="…"` für Side-Effects bei Auswahl.
  - Referenz: [public/index.html](public/index.html) (Buchwahl, non-compact), [public/partials/szenen.html](public/partials/szenen.html) (Filter-Combobox).

## State-Modell (Frontend)

Verbindlicher Aufbau des Alpine-State. Vor jeder UI-Änderung die richtige Ebene wählen — Root vs. Sub-Komponente vs. Store entscheidet über Reaktivität, Lifecycle und Speicherlecks.

### Drei Ebenen

1. **Root `Alpine.data('lektorat')`** ([public/js/app.js:355](public/js/app.js#L355)) — `x-data="lektorat"` am `<body>`. SSoT für: Navigation, Session/Shell, i18n-Locale, **alle `showXxxCard`-Flags** (Hash-Router + Exklusivität), Job-Queue, Editor-Edit-Mode, Auto-Save, Selection. Cross-Cutting-Methoden: `t/tRaw`, `bsGet/bsGetAll`, `loadFiguren/loadOrte/loadSzenen`, `selectPage`, `gotoStelle`, `_closeOtherMainCards`.
2. **Sub-Komponenten `Alpine.data('xxxCard')`** in [public/js/cards/](public/js/cards/) — 24 Karten, eine pro UI-Card. Eigener fachlicher State + `init()`/`destroy()`. Karten haben **keine** eigenen `showXxxCard`-Flags (Root ist SSoT); sie hören via `$watch(() => window.__app.showXxxCard)` auf Öffnen/Schliessen.
3. **`Alpine.store('catalog')`** ([public/js/cards/catalog-store.js](public/js/cards/catalog-store.js)) — geteilte Fach-Daten `figuren / orte / szenen / globalZeitstrahl`. Root spiegelt sie via Getter/Setter-Proxy ([public/js/app.js:364-371](public/js/app.js#L364-L371)), damit `this.figuren = …` und `this.figuren.push(…)` weiter funktionieren. Karten lesen via `$store.catalog` oder `$app.figuren`.

### Root-State-Slices ([public/js/app-state.js](public/js/app-state.js))

`initialLektoratState()` spreadet **14 Slice-Funktionen** in ein flaches Root-Objekt. Neues Feld → in den passenden Slice:

| Slice | Inhalt |
|-------|--------|
| `shellState` | currentUser, devMode, sessionExpired, themePref, focusGranularity, uiLocale, isMac, bookstackUrl, promptConfig, Token-Setup-Modal, `_abortCtrl` |
| `aiProviderState` | claudeModel, claudeMaxTokens, apiProvider, ollamaModel, llamaModel |
| `navigationState` | books, selectedBookId, pages, tree, Hash-Router-Internals (`_applyingHash`, `_hashInitialized`, …), Order-Maps, pageSearch, BookStack-Search |
| `editorState` | currentPage, renderedPageHtml, editMode, editDirty, editSaving, Auto-Save-Timer (`_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`), originalHtml/correctedHtml, hasErrors, newPage-Felder |
| `focusModeState` | focusMode, focusCountWords, focusCountChars, focusCountWordsDelta, focusCountCharsDelta (Live-Counter im Fokus-Header) |
| `editorPopupState` | Spiegel-Flags `_figurLookupOpen`, `_synonymMenuOpen`, `_synonymPickerOpen` (für Escape-Routing in `editor-focus-onKey`) + `_figurLookupIndex` (Lookup-Cache) |
| `cardsState` | **Alle `showXxxCard`-Flags** (showBookCard, showFiguresCard, showEditorCard, showChatCard, showAvatarMenu, …) — exklusiv via `_closeOtherMainCards(keep)` |
| `statusState` | status, statusSpinner, `_statusTimer` |
| `confirmDialogState` | Eigener Modal-Ersatz für `window.confirm` (verhindert macOS-Vollbild-Bug) |
| `lektoratState` | analysisOut, lektoratFindings, selectedFindings, appliedOriginals, checkLoading/Progress/Status, Token-Estimates (`tokEsts`, `_tokenEstGen`), pageHistory, ideenCounts, pageLastChecked, `_checkPollTimer` |
| `bookReviewState` | bookReviewHistory (von tree.js geschrieben, von user-settings beim Reset gelesen → Root) |
| `kapitelReviewState` | kapitelReviewChapterId (Hash-Router-SSoT) |
| `figurenState` | figurenLoading/Progress/Status, selectedFigurId, figurenFilters, `_figuresPollTimer` (Reconnect-relevant → Root) |
| `ereignisseState` / `szenenState` / `orteState` | Filter + selectedXxxId (von app-navigation geschrieben) + UpdatedAt |
| `chatsState` | `_checkDoneBeforeChat` |
| `featuresUsageState` | recentFeatureKeys (Top-3 Quick-Pills), recentPageIds (Palette) |
| `jobsState` | jobQueueItems, jobQueueExpanded, alleAktualisierenLoading/Status/Progress/Tps, `_jobQueueTimer` |

**Regel:** Slices sind Funktionen (nicht Konstanten), damit jede Komponenten-Instanz frische Arrays/Objekte erhält. Sonst geteilte Referenzen.

### Computed-Maps am Root (Performance)

`figurenById / orteById / szenenById` ([public/js/app.js:378-398](public/js/app.js#L378-L398)) sind getter-basierte O(1)-Lookups, die nur bei Referenzwechsel der Quell-Arrays neu gebaut werden. **`loadFiguren` etc. müssen die Arrays reassignen, nie pushen** — sonst rebuildet der Cache nicht. Render-Loops in figuren.html/orte.html/szenen.html nutzen diese Maps statt `.find()`.

Weitere Root-Computeds: `szenenNachKapitel`, `szenenNachSeite`, `orteFiltered`, `szenenFiltered`, `filteredTree`, `selectedBookName`, `selectedBookUrl`, `statusHtml`, `ideenMovePickerOptions()`.

### Lifecycle

- **Root `init()`** ([public/js/app.js:511](public/js/app.js#L511)): setzt `window.__app = this` (für `$app`-Magic), erzeugt `_abortCtrl = new AbortController()`, registriert globale Listener mit `{ signal }`.
- **Root `destroy()`** ([public/js/app.js:504](public/js/app.js#L504)): `_abortCtrl.abort()` → alle Listener weg in einem Schlag. Plus `clearInterval(_jobQueueTimer)`, `clearTimeout(_statusTimer)`. **Pflicht für jede neue globale Subscription:** `{ signal: this._abortCtrl.signal }` an `addEventListener` — sonst Leak bei HMR/Re-Init.
- **Sub-`init()`/`destroy()`**: Karten managen ihre Window-Listener selbst (z.B. `_onBookChanged`); in `destroy()` mit `removeEventListener` aufräumen. vis-network/Chart-Instanzen explizit `.destroy()` callen + Refs nullen (sonst halten DataSets das alte Buch im Speicher).

### `$app` / `window.__app` (Root-Zugriff aus Subs)

Alpine's `$root` zeigt auf das nächste `x-data` (= Sub selbst), nicht auf die `lektorat`-Root.
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren` — via `Alpine.magic('app', …)` ([public/js/app.js:195](public/js/app.js#L195)).
- **In JS-Methoden/Gettern** (Subs): `window.__app.xxx`. Magics sind in JS-Getter-Ausführungen nicht zuverlässig; `window.__app` ist robust und ein reaktiver Alpine-Proxy.

### Event-Bus (Root → Subs)

Custom-Events am `window`. Vollständige Liste:

| Event | Dispatcher | Hörer | Zweck |
|-------|-----------|-------|-------|
| `book:changed` | `_resetBookScopedState()` | alle Subs mit Buchscope | State resetten + bei offener Karte neu laden |
| `view:reset` | `resetView()` | alle Subs | Lokalen State komplett nullen |
| `card:refresh` `{ name }` | erneuter Klick auf offene Karte | passende Sub | Daten neu laden (ersetzt altes `onOpenWhenOpen`) |
| `job:reconnect` `{ type, jobId, job, extra? }` | `checkPendingJobs()` | review/kapitel-review/figuren/komplett | Loading-State übernehmen + Polling starten |
| `chat:reset` / `book-chat:reset` | Seitenwechsel / User-Settings-Reset | chat-card, book-chat-card | Session leeren |
| `kapitel-review:select` `{ chapterId }` | Sidebar / Hash-Router | kapitel-review-card | Chapter-ID setzen |
| `book-stats:select` | Hash-Router | book-stats-card | Statistik-Tab wählen |
| `palette:open` | global | palette-card | Command-Palette öffnen |
| `app:update-available` | Service-Worker-Listener | Root-Banner | Update-Hinweis |
| `session-expired` / `bookstack-token-invalid` | `fetch`-Wrapper | Root | Banner zeigen |

### Karten-Inventar (Alpine.data-Names)

Buchebene: `bookOverviewCard`, `bookReviewCard`, `kapitelReviewCard`, `figurenCard`, `orteCard`, `szenenCard`, `ereignisseCard`, `kontinuitaetCard`, `bookStatsCard`, `stilCard`, `fehlerHeatmapCard`, `chatCard`, `bookChatCard`, `ideenCard`, `finetuneExportCard`, `bookSettingsCard`, `userSettingsCard`, `paletteCard`.
Editor-Slices: `editorFindCard`, `editorSynonymeCard`, `editorFigurLookupCard`, `editorToolbarCard`, `editorFocusCard`, `lektoratFindingsCard`, `pageHistoryCard`.

Alle in [public/js/app.js:197-220](public/js/app.js#L197-L220) via `registerXxxCard()` registriert.

### Was bleibt im Root (nicht in Subs auslagern)

- Alle Show-Flags (Exklusivität!), Hash-Router, Auto-Save, Selection-Management, Editor-Edit-Mode, Job-Queue, Cross-Cutting-Loader (`loadFiguren` etc.), `_abortCtrl`-basiertes globales Listener-Setup.
- Editor-Module: `page-view`, `editor-edit`, `editor-utils`, `tree`, `history`, `api-ai`, `api-bookstack`, `bookstack-search`, `offline-sync`, `i18n`, `shortcuts` — gespreaded in den Root, nicht in eigene Subs.

### Editor-Modi (4 Stück, **Konsistenz kritisch**)

Vier orthogonale Modi am Editor — kein Single-Enum, sondern Boolean-Flags am Root. Reihenfolge der Mutations und Invarianten sind **harte Regeln**: jede Änderung am Modus-Setup muss diese Tabelle aktuell halten.

| Modus | Flag | Slice / Datei | Enter | Exit |
|-------|------|---------------|-------|------|
| **Viewmodus** (Lesen) | _kein_ (= alle anderen `false`) | — | Default | — |
| **Prüfmodus** | `checkDone: true` | `lektoratState` ([app-state.js:167](public/js/app-state.js#L167)) | `runCheck()` ([lektorat.js:42](public/js/lektorat.js#L42)) → Polling → Setzen bei Done ([lektorat.js:149](public/js/lektorat.js#L149)) oder `loadHistoryEntry` ([history.js:141](public/js/history.js#L141)) | `closeFindings()` ([lektorat.js:28](public/js/lektorat.js#L28)) |
| **Editmodus** | `editMode: true` | `editorState` ([app-state.js:83](public/js/app-state.js#L83)) | `startEdit()` ([editor-edit.js:144](public/js/editor-edit.js#L144)) | `saveEdit()` / `cancelEdit()` ([editor-edit.js:208-232](public/js/editor-edit.js#L208-L232)) |
| **Fokusmodus** | `focusMode: true` | `focusModeState` ([app-state.js](public/js/app-state.js)) | `enterFocusMode()` / `startFocusEdit()` / Cmd+Shift+E | `exitFocusMode()` / Esc / Cmd+Shift+E |

**Begleit-State pro Modus:**
- Prüfmodus: `lektoratFindings`, `selectedFindings`, `correctedHtml`, `hasErrors`, `analysisOut`, `appliedOriginals`, `appliedHistoricCorrections`, `lastCheckId`, `activeHistoryEntryId`, `checkProgress`, `checkStatus`, `_checkPollTimer`.
- Editmodus: `editDirty`, `editSaving`, `saveOffline`, `lastAutosaveAt`, `lastDraftSavedAt`, `_autosaveIdleTimer`, `_autosaveMaxTimer`, `_draftTimer`, `_onlineHandler`, `originalHtml`.
- Fokusmodus: `focusCountWords/Chars/*Delta` (`focusModeState`) + `focusGranularity` (`shellState`) + Sub-Maschine `_focusState` (`idle`/`entering`/`active`/`exiting`) + `_focusGen` (Re-Entry-Guard) in [editorFocusCard](public/js/cards/editor-focus-card.js).

**Erlaubte Kombinationen** (8 Bool-Tripel, 6 erlaubt):

| Edit | Focus | Check | Erlaubt? | Bemerkung |
|------|-------|-------|----------|-----------|
| 0 | 0 | 0 | ✓ | Viewmodus |
| 0 | 0 | 1 | ✓ | View + Findings (Split-View) |
| 1 | 0 | 0 | ✓ | Edit |
| 1 | 0 | 1 | ✓ | Edit + Findings (Marks im Editor) |
| 1 | 1 | 0 | ✓ | Edit + Fokus |
| 1 | 1 | 1 | ✓ | Findings vorhanden, Fokus blendet UI aus |
| 0 | 1 | * | ✗ | **Invariante: `focusMode → editMode`** |

**Invarianten (Pflicht — bei Änderungen prüfen):**

1. `focusMode === true` ⇒ `editMode === true`. Enforced in [editor-focus.js:572](public/js/editor-focus.js#L572) (`enterFocusMode` bricht ab) und [editor-edit.js:231](public/js/editor-edit.js#L231) (`cancelEdit` ruft `exitFocusMode` zuerst).
2. `runCheck` darf nicht im Editmodus starten. Template-Guard: Prüfen-Button hat `x-show="!editMode"` ([editor.html:41-43](public/partials/editor.html#L41)).
3. `closeFindings`-Button im Editmodus nur sichtbar wenn `!focusMode` ([editor.html:66](public/partials/editor.html#L66)) — im Fokus sind Findings ohnehin ausgeblendet.
4. **Chat-Modus** (showChatCard) snapshotet `checkDone` in `_checkDoneBeforeChat` und setzt `checkDone=false` ([chat-base.js:121](public/js/chat-base.js#L121)); beim Schliessen Restore ([app-view.js:291-307](public/js/app-view.js#L291-L307)). Ohne diesen Snapshot würde der Chat Findings doppelt rendern.
5. **Reset-Reihenfolge in `resetPage()`** ([app-view.js:355-397](public/js/app-view.js#L355-L397)): `exitFocusMode` → `_stopAutosave` → Chat-Reset → Card-Flags → Editor-State (`editMode/editDirty/editSaving`) → Lektorat-State (`checkDone/findings/...`). Diese Reihenfolge ist Pflicht — Fokus zuerst, weil `exitFocusMode` `editMode/editDirty` liest.
6. `saveEdit` im Fokus bleibt im Fokus+Edit ([editor-edit.js:289](public/js/editor-edit.js#L289), [editor-focus.js:914](public/js/editor-focus.js#L914)) — User möchte weiter schreiben. Nur sauberer Exit (kein editDirty, kein editSaving) räumt Edit-Mode auf.
7. Hotkey Cmd+Shift+E ([editor-focus.js:531](public/js/editor-focus.js#L531)) wirkt nur bei `showEditorCard` und routet zustandsabhängig: in Fokus → exit, in Edit → enter, sonst → startFocusEdit (Edit + Fokus in einem Schritt).

**Bei Modus-Erweiterung (z.B. „Diff-Modus", „Annotations-Modus")** dieser Section folgen:
1. Flag in passenden Slice von `app-state.js`.
2. Begleit-State + Timer-Refs daneben (gleicher Slice).
3. Invarianten-Tabelle hier ergänzen (Kombinations-Matrix).
4. `resetPage()` und `_resetBookScopedState()` um neuen Reset erweitern (gleiche Reihenfolge: neuer Modus zuerst aussen, sonst nach Lifecycle-Abhängigkeit).
5. Template-Guards setzen (analog `x-show="!editMode"` für Prüfen-Button).
6. Hotkey-Routing in handleFocusHotkey-Stil prüfen.

## Neues Feature hinzufügen

### Backend (KI-Job)

1. Job-Datei in `routes/jobs/` anlegen (Pattern: siehe `routes/jobs/review.js`)
2. `runXxxJob`-Funktion + `router.post('/xxx', ...)` implementieren
3. Router in `routes/jobs.js` mounten
4. Prompt-Builder im passenden Submodul unter `public/js/prompts/` ergänzen (z.B. `prompts/komplett.js` für Pipeline-Prompts, `prompts/review.js` für Bewertungen) und in der Facade `public/js/prompts.js` re-exportieren — **bei schemarelevanter Änderung `PROMPTS_VERSION` (in `prompts/core.js`) bumpen** (invalidiert `chapter_extract_cache`-Einträge der Komplettanalyse)
5. Schema-Validierung nach `callAI` nicht vergessen
6. Dedup-Check im POST-Handler: `findActiveJobId(type, entityId, userEmail)` aus `routes/jobs/shared.js` (NICHT `runningJobs.get(...) && jobs.has(...)` — matcht sonst auch fertige Jobs)

### Frontend (neue Karte als `Alpine.data`-Sub-Komponente)

Der Frontend-Scope ist in **Alpine.data-Sub-Komponenten** aufgeteilt:
- **Root** (`x-data="lektorat"` am `<body>`): Navigation (`selectedBookId`, `pages`, `tree`), Session, i18n, `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität), Job-Queue-Footer, globale Cross-Cutting-Methoden (`t`, `bsGet`, `loadFiguren`, `selectPage`, `gotoStelle` …).
- **24 Sub-Komponenten** in [public/js/cards/](public/js/cards/) — eine pro UI-Karte. Buchebene: Figuren, Orte, Szenen, Ereignisse, Stil, Fehler-Heatmap, BookStats, BookSettings, UserSettings, Kontinuität, Ideen, Finetune-Export, Buch-Chat, Buch-Review, Kapitel-Review, Palette. Editor-Subs: editor-find, editor-synonyme, editor-figur-lookup, editor-toolbar, editor-focus, lektorat-findings, page-history. Plus Seiten-Chat. Jede besitzt fachlichen State + Lifecycle.
- **Im Root** verbleibt: `page-view`, `editor-edit`, `editor-utils`, Hash-Router, Auto-Save, Selection-Management, Navigation. Editor-UI-Slices wurden in eigene Cards extrahiert (Trampoline-Events aus dem Root, z.B. `editor:focus:toggle`).

**Neue Karte anlegen:**
1. Fachmodul in `public/js/` → Methods-Export (`export const xxxMethods = { ... }`), Root-Zugriffe via `window.__app.xxx` (siehe unten).
2. Sub-Komponente in `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ ...state, init(), destroy(), ...xxxMethods }))`, registriert als `registerXxxCard()` und in `app.js` aufgerufen.
3. Partial in `public/partials/xxx.html` mit `x-data="xxxCard"` am Wurzel-`<div class="card">`. Root-Zugriffe im Template via `$app.xxx`.
4. Root-Methode `toggleXxxCard()` in `app-view.js` — reiner Flag-Toggle + `_closeOtherMainCards`. Bei Karten, die bei erneutem Klick refreshen sollen (statt schliessen): `window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'xxx' } }))`.
5. `showXxxCard`-Flag in `app-state.js` → `cardsState`.
6. **Eintrag in [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js)** (Single Source of Truth für Quick-Pills + Command-Palette + Usage-Tracking) — bei `kind: 'toggle'` zusätzlich Key in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js) ergänzen, sonst verwirft `/usage/track` lautlos.

### Root-Zugriff aus Sub-Komponenten (`$app` / `window.__app`)

Alpine's `$root` zeigt auf das **nächste x-data-Element** (bei Sub-Komponenten also die Sub selbst), nicht auf die `lektorat`-Root. Darum gibt es `$app`:
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren`. Funktioniert über die Custom-Magic `Alpine.magic('app', …)` in [app.js](public/js/app.js).
- **In JS-Methoden/Gettern** (Sub-Komponenten): `window.__app.xxx` — der Root cached sich in `init()` in `window.__app` (garantiert reaktiver Alpine-Proxy). Alpine-Magics sind in JS-Getter-Ausführungen **nicht** zuverlässig verfügbar; `window.__app` ist robust.

### Geteilter Fach-State: `Alpine.store('catalog')`

`figuren`, `orte`, `szenen`, `globalZeitstrahl` leben in [public/js/cards/catalog-store.js](public/js/cards/catalog-store.js). Der Root exponiert sie als Getter/Setter-Proxy — alter Root-Code (`this.figuren = …`) funktioniert unverändert. Sub-Komponenten lesen via `$app.figuren` oder direkt `Alpine.store('catalog').figuren`.

### Events zwischen Root und Subs

Root dispatched, Subs hören:
- **`book:changed`** — aus `_resetBookScopedState()`; Subs resetten State + laden bei offener Karte neu.
- **`view:reset`** — aus `resetView()`; Subs nullen lokalen State komplett.
- **`card:refresh` `{ name }`** — erneuter Klick auf offene Karte; bildet das alte `onOpenWhenOpen`-Verhalten von `createJobFeature` nach.
- **`job:reconnect` `{ type, jobId, job, extra? }`** — aus `checkPendingJobs()`; Review/Kapitel-Review-Subs übernehmen Loading-State + starten Polling.
- **`chat:reset` / `book-chat:reset`** — Root dispatcht beim Seitenwechsel / User-Settings-Danger-Reset; Chat-Subs leeren Session.
- **`kapitel-review:select` `{ chapterId }`** — aus Sidebar/Hash-Router; Sub setzt ihre `kapitelReviewChapterId`.

### Job-Polling (shared utilities)

Pure Funktionen in [public/js/cards/job-helpers.js](public/js/cards/job-helpers.js):
- `startPoll(ctx, config)` — generischer Job-Poller mit explizitem ctx.
- `runningJobStatus(translate, …)` — Status-HTML mit Token-Info.

Für createJobFeature-ähnliche Karten: [public/js/cards/job-feature-card.js](public/js/cards/job-feature-card.js) exportiert `createCardJobFeature(cfg)` — Sub-Variante der Root-Factory mit Flag am `$app` statt lokal.

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Root-Toggle-Methode (`app-view.js`) ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor)
- `selectPage()` schliesst alle Buchkarten bevor der Editor öffnet
- Sub-Komponenten haben **keine** eigenen `showXxxCard`-Flags — der Root ist SSoT. Subs hören auf `$watch(() => window.__app.showXxxCard)`.
- Seiten-Chat ist eine Ausnahme: läuft neben dem Editor, kein `_closeOtherMainCards` beim Öffnen.

## Command-Palette + Feature-Registry

**SSoT für UI-Features:** [public/js/cards/feature-registry.js](public/js/cards/feature-registry.js) listet alle Karten (`kind: 'toggle'`), globalen Aktionen und Such-Provider. Quick-Pills, Command-Palette und Usage-Tracking lesen ausschliesslich daraus.

**Palette:** [public/js/cards/palette-card.js](public/js/cards/palette-card.js) — Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern. Trigger: Cmd/Ctrl+K bzw. `/`. Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen. Ohne Prefix: alles fuzzy gemixt (Score-Threshold in `FUZZY_THRESHOLD_PER_CHAR`).

**Karten-Keys synchron halten:** Wer eine neue Toggle-Karte hinzufügt, ergänzt sie in `FEATURES` (feature-registry) **und** in `ALLOWED_KEYS` von [routes/usage.js](routes/usage.js). Sonst wird `/usage/track` lautlos verworfen → keine Recency-Position in der Palette.

**Recency:** [public/js/features-usage.js](public/js/features-usage.js) wird in den Root gespreaded; `$watch` auf jeden Show-Flag (rising edge) ruft `/usage/track`. Beim Login lädt `/usage/recent` die letzten Keys; Fallback: `DEFAULT_RECENT_KEYS` aus feature-registry.

## Lazy-Loaded Libs

vis-network (Figuren-Graph) und Chart.js (BookStats) laden ausschliesslich on-demand via [public/js/lazy-libs.js](public/js/lazy-libs.js). Kein neuer `<script>`-Tag im `index.html` für grosse Libs — vorher blockten sie ~800 KB unbenutzte JS am initialen Page-Load.

## Prompt-System

**Trennung Config vs. Code:**
- `prompt-config.json` (Projektroot, Pflichtdatei) — Rollenformulierungen, Basisregeln, Buchtypen pro Sprache. Fehlt sie → Server-Crash beim Start.
- `public/js/prompts.js` — Facade (Re-Exports + `configurePrompts`-Orchestrator). Externer Einstieg für Server (dynamic `import()`) und Frontend (ESM).
- `public/js/prompts/` — interne Aufteilung nach Job-Typ:
  - `state.js` — `_isLocal`-Flag, `_jsonOnly()`, `JSON_ONLY`-Konstante (geteilter Provider-State)
  - `schema-utils.js` — Schema-Atome (`_obj`, `_str`, `_num`)
  - `blocks.js` — wiederverwendbare Regel-Blöcke (Stil, Wiederholung, Schwache Verben, Show-vs-Tell, Passiv, Perspektivbruch, Tempuswechsel, Erzählform)
  - `core.js` — `configureLocales`, `getLocalePromptsForBook`, alle `SYSTEM_*` Live-Exports, `PROMPTS_VERSION`, Locale-State
  - `lektorat.js` — Seiten-Lektorat (Einzel + Batch) + Stilkorrektur + `SCHEMA_LEKTORAT` (rebuild-pflichtig)
  - `review.js` — Buch-/Kapitel-Bewertung + statische Schemas
  - `komplett.js` — Komplettanalyse-Pipeline (Extraktion, Soziogramm, Orte, Kontinuität, Zeitstrahl) + alle dynamischen Schemas
  - `chat.js` — Seiten-Chat + Buch-Chat (klassisch + Agentic) + `BOOK_CHAT_TOOLS`
  - `synonym.js` — Synonym-Suche
  - `finetune.js` — Finetune-Export-Augmentation
- **Reihenfolge in `configurePrompts`:** `_setIsLocal(provider)` → `_rebuildLektoratSchema()` → `_rebuildKomplettSchemas()` → `configureLocales(cfg)`. Schemas vor `configureLocales`, weil `_buildLocalePrompts` → `buildSystemKomplett*` den `_isLocal`-Flag liest.

**Ladereihenfolge:**
- Server: `routes/jobs.js` und `routes/chat.js` lesen `prompt-config.json` synchron beim Modulstart → `configurePrompts()` einmalig (via `lib/prompts-loader.js`). `routes/proxies.js` liefert die Config lazy beim ersten `/config`-Call ans Frontend.
- Frontend: `app.js` → `init()` → `configurePrompts(cfg.promptConfig)` → setzt `SYSTEM_*`-Variablen via ESM-Live-Binding.

**Buchtypen:** In `prompt-config.json` unter `buchtypen`, aufgeteilt nach Sprachcode (`de`, `en`). Jeder Key hat `label` + `zusatz`. Neuer Typ: in beiden Sprachen ergänzen.

**Per-Buch-Kontext:** `getBookPrompts(bookId)` → `getLocalePromptsForBook()` augmentiert `baseRules` dynamisch mit Buchtyp-Zusatztext (`BUCHTYP-KONTEXT:`) und Freitext des Users (`VORRANGIGE ANGABEN DES AUTORS:` – übersteuert bei Konflikt die Basisregeln, insbesondere Stil/Ton/Format).

## Datenbank

DB-Code ist auf 6 Files in [db/](db/) verteilt: [connection.js](db/connection.js) (better-sqlite3-Setup, `PRAGMA foreign_keys = ON` global), [migrations.js](db/migrations.js) (Schema + `runMigrations`), [schema.js](db/schema.js), [figures.js](db/figures.js), [pages.js](db/pages.js), [tokens.js](db/tokens.js).

### Relationale Integrität (Pflicht)

- **Jede neue Tabelle integriert sich via FK** ins bestehende Schema. Lose `*_id`-Spalten (`book_id`, `page_id`, `chapter_id`, `figure_id`, `location_id`, …) ohne `REFERENCES` sind verboten.
- Refs auf lokale PKs/UNIQUE-Targets MÜSSEN als FK deklariert werden:
  - `books(book_id)` (PK; externe BookStack-ID, analog `pages.page_id`/`chapters.chapter_id`)
  - `pages(page_id)` (PK)
  - `chapters(chapter_id)` (UNIQUE)
  - `figures(id)` (PK; nicht `figures.fig_id` — TEXT, nicht UNIQUE alleine)
  - `locations(id)`, `figure_scenes(id)`, `chat_sessions(id)`, `continuity_*(id)`
- ON-DELETE-Strategie bewusst wählen:
  - `CASCADE` für reine Caches/Aggregationen (page_stats, chapter_reviews, figure_appearances, location_chapters, lektorat_time, page_figure_mentions, chat_sessions[kind=page], page_checks)
  - `SET NULL` für user-kuratierte Daten (figure_events.page_id/chapter_id, figure_scenes.page_id/chapter_id, locations.erste_erwaehnung_page_id, ideen.page_id, continuity_issue_chapters.chapter_id, page_checks.chapter_id, pages.chapter_id)
- **Snapshot-Spalten verboten** (`chapter_name`, `kapitel`, `seite`, `page_name`, `book_name`) — keine Ausnahmen. Display-Werte zur Lese-Zeit per JOIN auf `chapters`/`pages`/`books`/`figures`. Wahrheit lebt nur in `pages.page_name`, `chapters.chapter_name`, `books.name` (BookStack-Sync-Caches) und `figures.name` (User-Stamm). Snapshot-Fallback nur bei nullbarem FK, wenn KI-Output keine ID liefern konnte (z. B. `continuity_issue_figures.figur_name` mit nullable `figure_id`).
- Index auf jede neue FK-Spalte Pflicht (`CREATE INDEX idx_xx_yy ON …`).
- `book_id`-Spalten referenzieren `books(book_id)` (PK). Discovery via `upsertBook(b)` / `upsertBookByName(bookId, name)` in [routes/sync.js](routes/sync.js) bzw. [db/schema.js](db/schema.js) — jede BookStack-Buch-Berührung upserted in `books`, danach sind FK-CASCADE-Pfade aktiv. Composite-Defensive `(chapter_id, book_id) REFERENCES chapters(chapter_id, book_id)` prüfen, wenn Cross-Book-Bugs möglich.

### Sentinel-freie Modellierung

Vermeide Sentinel-Werte (`page_id=0`, `page_name='__book__'`) als Diskriminator. Stattdessen: explizite Spalte (`kind TEXT NOT NULL CHECK(kind IN ('page','book'))`) + `NULL` für nicht-anwendbare Refs + CHECK-Constraint, der die Kombination erzwingt. Beispiel: `chat_sessions`. Sentinels blockieren FK-Constraints und verstecken Geschäftslogik.

### Migration hinzufügen

Neuen `if (version < N)`-Block in `runMigrations()` ([db/migrations.js](db/migrations.js)) ergänzen (N = nächste fortlaufende Nummer, aktuelle Version siehe `schema_version`-Tabelle) + `UPDATE schema_version SET version = N`. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` mit FKs.

**Pflicht: jede Migration endet mit:**
```js
const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) throw new Error(`Migration N: foreign_key_check meldet ${fkErrors.length} Verstoesse.`);
db.prepare('UPDATE schema_version SET version = N').run();
```

**FK-Migration via Recreate-Pattern** (SQLite kann FKs nicht via `ALTER TABLE ADD CONSTRAINT`):
1. `db.pragma('foreign_keys = OFF')`
2. Pre-Cleanup: orphans nullen (UPDATE … SET ref = NULL WHERE ref NOT IN parent) bzw. löschen (CASCADE-Targets)
3. `DROP TABLE IF EXISTS xxx_new` (defensiv gegen Crash-Reste)
4. `CREATE TABLE xxx_new` mit finalen FKs + Indexen
5. `INSERT INTO xxx_new SELECT … FROM xxx`
6. `DROP TABLE xxx` → `ALTER TABLE xxx_new RENAME TO xxx`
7. Indexe neu anlegen (Recreate verliert sie)
8. `db.pragma('foreign_keys = ON')` + `foreign_key_check`
9. `UPDATE schema_version`

**Initial-Schema-Block** (oben in `migrations.js`) bleibt der "Stand vor allen Migrationen" — nur additive Changes (neue Spalten via ALTER ADD COLUMN, neue Tabellen). FK-Anreicherung NICHT ins Initial-Schema einbauen, sonst brechen Daten-Migrationen, die alte Spalten lesen, auf frischen DBs.

### Neuer Beziehungstyp

Keine Schemaänderung. `figure_relations.typ` ist Freitext. Neuen Typ in der `BZ`-Konstante (Frontend-Rendering) und im Claude-Prompt (`FIGUREN_BASIS_SCHEMA` in `public/js/prompts/komplett.js`) ergänzen.

`figure_relations.from_fig_id`/`to_fig_id` sind INTEGER-FK auf `figures.id` (nicht TEXT-fig_id). Schreib-/Lesepfade übersetzen via Lookup-Map (TEXT-fig_id ↔ INTEGER-id, siehe [db/figures.js](db/figures.js) `saveFigurenToDb`/`updateFigurenSoziogramm` und JOINs in [routes/figures.js](routes/figures.js), [routes/jobs/shared.js](routes/jobs/shared.js)).

## Architektur-Überblick

```
Browser → NGINX (HTTPS) → Express (Port 3737)
  /auth/*    → Google OIDC (Login/Callback/Logout/Me)
  /config    → Modell-Config + User (keine Credentials)
  /api/*     → BookStack-Proxy (Token aus Session, serverseitig)
  /claude    → api.anthropic.com (ANTHROPIC_API_KEY-Injection, SSE)
  /ollama    → Ollama /api/chat (NDJSON → SSE normalisiert)
  /jobs/*    → Hintergrund-Jobs (Status-Polling, alle KI-Analysen)
  /chat/*    → Seiten-Chat (SSE-Streaming) + Buch-Chat-Sessions
  /history/* → Job-Verlauf (SQLite)
  /figures/* → Figuren-CRUD (SQLite)
  /locations/*    → Orte-CRUD (SQLite)
  /ideen/*        → Ideen-CRUD (SQLite)
  /booksettings/* → Per-Buch-Settings (Buchtyp, Freitext)
  /me/*           → User-Settings (Sprache, Modell-Override)
  /sync/*         → Buchstatistik-Sync (manuell + Cron)
  /export/*       → Buch-Export (BookStack /export/{fmt} mit Timestamp-Filename)
  /pdf-export/*   → Custom-PDF-Export-Profile (CRUD + Cover-Upload + Font-Liste)
  /jobs/pdf-export → Render-Job (eigene pdfkit-Pipeline mit PDF/A-2B)
  /usage/*        → Feature-Usage-Tracking (Recency für Palette/Quick-Pills)
  /          → public/index.html (SPA)

Cron (täglich 02:00) → syncAllBooks() → page_stats + book_stats_history
```

**Auth:** Alle Routen ausser `/auth/*` sind durch Session-Guard geschützt. HTML-Requests → Redirect auf Login. API-Requests → `401 JSON`.

**Credentials:** KI-Aufrufe laufen über Server-Proxies — der Server hält alle API-Keys. Der BookStack-Proxy injiziert `req.session.bookstackToken` serverseitig.

## KI-Provider

Drei Provider, konfiguriert via `API_PROVIDER` in `.env`:

| Provider | Env-Vars | Besonderheit |
|----------|----------|--------------|
| `claude` | `ANTHROPIC_API_KEY`, `MODEL_NAME` | Prompt-Caching (`cache_control: ephemeral`), grosses Kontextfenster |
| `ollama` | `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TEMPERATURE` | Mutex-Serialisierung (VRAM-Schutz), dynamische `num_ctx`-Berechnung |
| `llama` | `LLAMA_HOST`, `LLAMA_MODEL`, `LLAMA_TEMPERATURE` | llama.cpp, ebenfalls Mutex-serialisiert |

**`MODEL_TOKEN`** setzt den globalen Output-Token-Cap (`MAX_TOKENS_OUT` in `lib/ai.js`, Default 64 000). Job-spezifische Overrides werden per `Math.min` gedeckelt.

**`MODEL_CONTEXT`** setzt das gesamte Kontextfenster (Input + Output, Default 200 000). Daraus leitet `lib/ai.js` das `INPUT_BUDGET_TOKENS` (= `MODEL_CONTEXT − MODEL_TOKEN − 2000`) ab. Alle kontextabhängigen Grenzen skalieren automatisch: `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (Komplettanalyse), `BOOK_CHAT_TOKEN_BUDGET`-Default, Buch-Chat-Tool-Result-Caps und das Classic-Buch-Chat-Text-Budget. Bei lokalen Modellen auf die native Kontextgrösse setzen (Mistral-Small3.2 / Gemma3 / Llama-3.1: 128 000, ältere: 32 000 / 8 000).

**JSON-Parsing:** `lib/ai.js` hat mehrstufigen Fallback: `JSON.parse()` → `extractBalancedJson()` → `jsonrepair()`.

## Two-Tier-Analyse

Jobs in `routes/jobs/` verwenden ein Single-Pass/Multi-Pass-Muster. Limits und Batch-Grössen sind als Konstanten in `routes/jobs/shared.js` definiert — `SINGLE_PASS_LIMIT` und `PER_CHUNK_LIMIT` skalieren dynamisch aus `INPUT_BUDGET_CHARS` (70% / 35%).

## Komplettanalyse-Job

**Pipeline-Phasen und Abhängigkeiten:**

```
Phase 1 – Vollextraktion (parallel pro Kapitel oder Single-Pass)
          → figuren, orte, fakten, szenen(Namen), assignments(Namen)
          → Checkpoint 'p1_full_done'
                    ↓
Phase 2 – Figuren konsolidieren + Soziogramm (aus P2-Output, kein Extra-Call)
Phase 3 – Schauplätze konsolidieren
Phase 3b – Kapitelübergreifende Beziehungen (nur Multi-Pass, non-critical)
                    ↓
Block 2 [parallel]:
  Phase 5 – Szenen remappen (kein API-Call, Namen → IDs)
  Phase 6 – Zeitstrahl konsolidieren
  Phase 8 – Kontinuitätscheck (Single-Pass: voller Text, Multi-Pass: Fakten)
```

**Standalone-Kontinuitätscheck:** `POST /jobs/kontinuitaet` — läuft Phase 8 einzeln, ohne die volle Pipeline. Exportiert `runKontinuitaetJob` aus `routes/jobs/komplett.js`.

**Wichtige Mechanismen:**
- **Delta-Cache:** Phase 1 (Multi-Pass) prüft `chapter_extract_cache` in der DB. Cache-Key enthält `pages_sig` (sortierte `page_id:updated_at`-Paare). Ändert sich eine Seite → Cache-Miss → Neu-Extraktion. Single-Pass wird nicht gecacht.
- **Prompt-Caching:** System-Prompt mit eingebettetem Schema wird bei parallelen Kapitel-Calls gecacht (~10% des Input-Preises für Folge-Calls).
- **Checkpoint-Wiederaufnahme:** `p1_full_done` speichert alle 5 Arrays. Alte `p1_done`-Checkpoints werden verworfen → Job-Neustart.

## Finetune-Export

Ziel: Buch im Modell **internalisieren** (Stil, Welt, Figuren, Fakten, Plot). Darum **maximal grosszügig extrahieren** — lieber zu viele Trainingssamples als zu wenige. Alles, was sich aus Text/Figuren/Szenen/Schauplätzen/Ereignissen/Lektorats-Findings als Q&A, Stil-Fortsetzung, Dialog, Szenen-Generierung, Fakten-Recall etc. ableiten lässt, mitnehmen. Keine künstlichen Sample-Caps, keine vorsichtigen Limits per Sampler — Modell soll Buch nach Finetune möglichst vollständig „kennen". Neue Sampler/Datenquellen tendenziell hinzufügen, nicht filtern. Code: [routes/jobs/finetune-export/](routes/jobs/finetune-export/).

## Custom PDF-Export

**Eigener Renderer**, nicht der BookStack-Upstream-PDF (der bleibt unter `/export/book/:id/pdf`). Ziel: druckfertige PDF/A-2B-Konformität mit User-konfigurierbarem Layout, Fonts, Cover, Kapitelgliederung.

**Pipeline:**
```
/jobs/pdf-export (POST, Job-Queue) → loadBookContents → render (pdfkit, subset='PDF/A-2b') → optional veraPDF-Validate
                                                          ↓
                                          /jobs/pdf-export/:id/file (Stream)
```

**Module:**
- `routes/jobs/pdf-export.js` — Job-Wrapper, hält PDF-Buffers in `pdfResults`-Map (TTL 2h).
- `lib/pdf-render.js` — pdfkit-Doc-Lifecycle, Cover, Title-Page, TOC, Kapitel-Loop, Header/Footer-Pass.
- `lib/pdf-html-walker.js` — linkedom-basiert. Whitelist: h1-h3, p, ul/ol/li, blockquote, pre, hr, img + inline strong/em/u/a. `<div class="poem">` → eigener `poem`-Block. Tabellen werden als Plain-Text-Fallback durchgereicht (kein Layout). Standard-Editor-Markup wird unterstützt.
- `lib/pdf-export-defaults.js` — `defaultConfig()` + `validateConfig(src)`. Strict: unbekannte Keys werden verworfen, Numerik geclampt, Enums whitelisted.
- PDF/A-2B-Subset macht pdfkit nativ via `subset: 'PDF/A-2b'` im PDFDocument-Constructor: hängt `pdfaid:part`/`conformance` ans XMP, schreibt OutputIntent mit eingebettetem sRGB-ICC-Profil aus pdfkit's eigenem Bundle (`node_modules/pdfkit/js/data/sRGB_IEC61966_2_1.icc`). **Nicht** manuell via `doc._root.data.Metadata = …` patchen — pdfkit's `endMetadata()` läuft danach und überschreibt die Referenz.
- `lib/pdfa-validate.js` — veraPDF-CLI-Wrapper. Schreibt Buffer in Tempdatei mit `.pdf`-Extension (CLI liest nicht von stdin), validiert, löscht. Wenn Binary fehlt → `{ available: false }`, Job liefert PDF mit Warnung. ENV `VERAPDF_BIN`, `VERAPDF_FLAVOUR`, `VERAPDF_DISABLED`.
- `lib/font-fetch.js` — Google-Fonts-Loader. Hardcoded Whitelist (~24 Familien). UA-Trick (`Wget/1.13.4`) zwingt Google-CSS-API zu TTF. 30-Tage-TTL via `font_cache`-Tabelle (Stale-while-revalidate: bei Network-Fail wird stale-Cache geliefert).
- `lib/cover-prepare.js` — sharp: Magic-Bytes-Check → JPEG, sRGB, kein Alpha, max. 2400 px Längsseite. PDF/A-tauglich.
- `db/pdf-export.js` + `db/fonts.js` — Profile-CRUD + Font-Cache. **Multiple Profile pro (book, user)** via `(book_id, user_email, name)`-UNIQUE; `book_id=0` für User-Default-Vorlagen. Cover-Bild als BLOB in `pdf_export_profile.cover_image`.

**Frontend:** `pdfExportCard` ([public/js/cards/pdf-export-card.js](public/js/cards/pdf-export-card.js)) mit Tabs Layout/Schrift/Kapitel/Cover/TOC/Extras/PDF/A. Live-Font-Preview lädt Google-Fonts-CSS lazy in den Browser. Profile-Operationen (CRUD, Default, Cover-Upload) gehen an `/pdf-export/...`. Render-Trigger an `/jobs/pdf-export`, Download-Stream `/jobs/pdf-export/:id/file`.

**Wichtige Invarianten:**
- `font.body` braucht `family` aus der Whitelist (lib/font-fetch.js#FONT_LIST). PUT validiert; bad font → 400 `FONT_NOT_ALLOWED`.
- Cover-Bilder werden bei Upload **und** beim Render durch sharp geschleust (defensiv-doppelt; PDF/A erlaubt kein Alpha/CMYK).
- `pageStructure: 'flatten'` (Default) verkettet alle BookStack-Pages eines Kapitels ohne Per-Page-Heading; `'nested'` rendert pro Page einen h2-Sub-Heading.
- Job-Result-JSON enthält Metadaten (Größe, MIME, PDF/A-Status), **nicht** den Buffer — der lebt in `routes/jobs/pdf-export.js#pdfResults` und wird über `/jobs/pdf-export/:id/file` gestreamt.
- veraPDF-Failure ist **non-fatal**: Datei wird trotzdem geliefert, Frontend zeigt Warnung.

**Ops:**
- veraPDF (Java-CLI, ~80 MB inkl. JRE) optional im Container. Fehlt es → Validation skipped, kein Crash.
- sharp ist Pflicht-Dep (Cover + Image-Embeds); libvips wird über das npm-Package mitgeliefert.
- Code: [routes/jobs/pdf-export.js](routes/jobs/pdf-export.js), [routes/pdf-export.js](routes/pdf-export.js), [lib/pdf-render.js](lib/pdf-render.js).

## Chat

- **Seiten-Chat** (`/chat/send`): SSE-Streaming, kein Job-Queue. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung.
- **Buch-Chat** (`/jobs/book-chat`): Job-Queue, kein Vorschläge-System. Sessions sind durch `chat_sessions.kind = 'book'` (mit `page_id IS NULL`) markiert; CHECK-Constraint erzwingt die Kombination.
- **SSE-Fehler:** `sseStarted`-Flag trennt Pre-Stream-Fehler (→ JSON 502) von Mid-Stream-Fehler (→ SSE `{ type: 'error' }` + `[DONE]`).

## Fehlerbehandlung

- **Jobs:** `try/catch` → `failJob(id, err)` setzt Status auf `'error'` oder `'cancelled'` (bei `AbortError`). Fehler werden in `job.error` gespeichert und geloggt.
- **API-Routen:** Fehlende Parameter → `400 JSON`, unauthentifiziert → `401 JSON`.
- **JSON-Parsing:** Mehrstufiger Fallback in `lib/ai.js` (siehe KI-Provider).
- **DB-Fehler:** Geloggt, blockieren nicht den Request.

## Logging

Winston (`logger.js`): Level `info`, Ausgabe in `lektorat.log` (5 MB, 3 Dateien rotiert) + Console. Jobs nutzen Child-Logger mit Kontext: `logger.child({ job, user, book })` → Format: `[INFO][lektorat|user@mail.com|42] Nachricht`.

## Projektstruktur

```
server.js              – Express-Setup, Auth-Guard, Cron, Route-Mounting
logger.js              – Winston-Config
lib/
  ai.js                – callAI(), Provider-Dispatch, JSON-Parsing
  bookstack.js         – authHeader, bsGet, bsGetAll-Paginierung
  crypto.js            – AES-256-GCM für persistierte Tokens (`enc:v1:`-Prefix)
  filenames.js         – Einheitlicher Filename-Builder mit Timestamp + Slug
  page-index.js        – Pro-Seite-Metriken (Pronomen, Dialog, Figuren-Mentions) für Agentic Buch-Chat
  prompts-loader.js    – Lazy-Import von public/js/prompts.js aus CJS-Kontext
  validate.js          – Eingabe-Validierung an Request-Grenzen (strikte Int-Parser)
db/                    – SQLite split: connection, migrations, schema,
                         figures, pages, tokens
routes/
  auth.js                  – Google OIDC
  proxies.js               – KI-Provider-Proxies + BookStack-Proxy
  jobs.js                  – Job-Router (mountet alle Feature-Router)
  jobs/shared.js           – Job-Queue, Limits, loadPageContents, Hilfsfunktionen
  jobs/lektorat.js         – Seiten-Lektorat + Batch-Check
  jobs/review.js           – Buchbewertung
  jobs/kapitel.js          – Kapitelbewertung
  jobs/komplett.js         – Komplettanalyse-Pipeline (inkl. Kontinuitätscheck)
  jobs/chat.js             – Buch-Chat (klassisch + Agentic-Dispatch)
  jobs/book-chat-tools.js  – Tool-Implementierungen für Agentic Buch-Chat
  jobs/synonyme.js         – Synonym-Vorschläge
  jobs/finetune-export/    – Finetune-Sample-Generator (eigener Router)
  jobs/narrative-labels.js – POV-/Tempus-Labels (Helper, kein Router)
  chat.js                  – Seiten-Chat (SSE)
  export.js                – BookStack-Buch-Export (Timestamp-Filename)
  usage.js                 – Feature-Usage-Tracking (ALLOWED_KEYS-Allowlist)
  figures.js, locations.js, history.js, sync.js, booksettings.js,
  usersettings.js, ideen.js
public/
  index.html           – SPA-Shell
  css/                 – 41 thematische Stylesheets, geladen via 41 <link>-Tags
                         in index.html. Reihenfolge = Cascade-Reihenfolge.
                         tokens.css (Custom-Props, Dark-Theme, Fonts) UNLAYERED;
                         alle anderen via @layer base/components/utilities
  partials/            – HTML-Partials, geladen per _loadPartials()
  js/app.js            – Alpine-Root (`x-data="lektorat"`), Methoden-Spreads,
                         `$app`-Magic, window.__app-Referenz
  js/app-state.js      – Root-State-Slices (shell, ai, navigation, editor,
                         cards-Flags, Editor-Findings, …)
  js/app-view.js       – Root-Toggle-Methoden (toggleXxxCard), selectPage,
                         resetView/_resetBookScopedState mit Event-Dispatches
  js/app-ui.js         – Filter-/Sort-Helper, Partial-Loader
  js/app-jobs-core.js  – Job-Queue, checkPendingJobs, _startPoll-Wrapper
  js/app-hash-router.js, app-navigation.js, app-chrome.js, app-komplett.js
  js/cards/            – Alpine.data-Sub-Komponenten (24 Karten + Shared)
    catalog-store.js          – Alpine.store('catalog') für figuren/orte/szenen/globalZeitstrahl
    feature-registry.js       – SSoT für Karten-Features + Aktionen + Provider-Hooks
                                (gelesen von Quick-Pills, Command-Palette, Usage-Tracking)
    job-helpers.js            – pure `startPoll(ctx, cfg)` + `runningJobStatus(translate, …)`
    job-feature-card.js       – `createCardJobFeature(cfg)` für Sub-Komponenten
    palette-card.js           – Command-Palette (Cmd/Ctrl+K, `/`)
    palette-fuzzy.js          – Fuzzy-Match + Highlight
    palette-providers.js      – Such-Provider (Seiten, Kapitel, Figuren, Orte, Szenen)
    stil-card.js, fehler-heatmap-card.js, book-stats-card.js
    book-settings-card.js, user-settings-card.js
    kontinuitaet-card.js, ereignisse-card.js, orte-card.js, szenen-card.js
    figuren-card.js           – inkl. vis-network-Graph-Lifecycle
    book-review-card.js, kapitel-review-card.js
    chat-card.js, book-chat-card.js
    ideen-card.js, finetune-export-card.js
    editor-find-card.js, editor-synonyme-card.js, editor-figur-lookup-card.js,
    editor-toolbar-card.js, editor-focus-card.js
    lektorat-findings-card.js, page-history-card.js
  js/prompts.js        – Facade: Re-Exports + configurePrompts-Orchestrator
  js/prompts/          – Submodule pro Job-Typ (state, schema-utils, blocks, core,
                         lektorat, review, komplett, chat, synonym, finetune)
  js/utils.js          – Gemeinsame Hilfsfunktionen
  js/lazy-libs.js      – On-demand-Loader für vis-network und Chart.js
                         (kein Eager-Load — sparte ~800 KB JS am initialen Page-Load)
  js/features-usage.js – Root-Spread: $watch auf Show-Flags, POST /usage/track,
                         GET /usage/recent für Palette-Section „Zuletzt"
  js/chat-base.js      – Geteilte Chat-Methoden (spreaded in chat-card + book-chat-card)
  js/*.js              – Fachmodule, die in Sub-Komponenten oder Root gespreadet werden
                         (figuren, orte, szenen, kontinuitaet, graph, review,
                          stil-heatmap, fehler-heatmap, bookstats, writing-time,
                          book-settings, user-settings, kapitel-review, ereignisse,
                          chat, book-chat)
                       – Editor-/Findings-Module (bleiben im Root-Spread):
                          page-view, editor-edit, editor-utils,
                          shortcuts, tree, history,
                          api-ai, api-bookstack, bookstack-search, offline-sync,
                          i18n
                       – Module hinter eigenen Cards (gespreaded in *-card.js):
                          editor-focus, editor-toolbar, editor-find,
                          editor-synonyme, editor-figur-lookup, lektorat,
                          ideen, finetune-export
```

## Tests

`npm test` führt Unit- und E2E-Tests nacheinander aus. Einzeln: `npm run test:unit` (Node built-in, Millisekunden, kein Browser) oder `npm run test:e2e` (Playwright, Chromium nötig). Setup: [tests/](tests/), [playwright.config.js](playwright.config.js).

**Unit** (`tests/unit/*.test.{js,mjs}`, `node --test`) — 15 Suiten, decken ab:
- JSON-Fallback-Kette ([ai.test.js](tests/unit/ai.test.js)), BookStack-Pagination ([bookstack.test.js](tests/unit/bookstack.test.js)), Stil-/Figuren-Metriken ([page-index.test.js](tests/unit/page-index.test.js)), Prompts-Build ([prompts.test.mjs](tests/unit/prompts.test.mjs)), XSS-Escape-Invariante ([escape-xss.test.mjs](tests/unit/escape-xss.test.mjs)), Request-Validierung ([validate.test.js](tests/unit/validate.test.js)), Job-Reconnect-Events ([job-reconnect.test.mjs](tests/unit/job-reconnect.test.mjs)), Hash-Router ([hash-router.test.mjs](tests/unit/hash-router.test.mjs)), Card-Exklusivität ([card-exclusivity.test.mjs](tests/unit/card-exclusivity.test.mjs)), Editor-Focus-Granularität ([editor-focus.test.mjs](tests/unit/editor-focus.test.mjs), [focus-granularity.test.mjs](tests/unit/focus-granularity.test.mjs)), Szenen-Filter ([szenen-filter.test.mjs](tests/unit/szenen-filter.test.mjs)), Ideen-Prompt + Schema ([ideen-prompt.test.mjs](tests/unit/ideen-prompt.test.mjs), [ideen-schema.test.js](tests/unit/ideen-schema.test.js)), Shared-Jobs-Helper ([shared-jobs.test.js](tests/unit/shared-jobs.test.js)).

**E2E** (`tests/e2e/*.spec.js`, Playwright):
- [tests/e2e/focus-editor.spec.js](tests/e2e/focus-editor.spec.js) – Fokus-Editor: Toggle, Recenter, Pointer-Schonfrist, Cleanup/Leak-Freiheit.
- [tests/e2e/clean-content.spec.js](tests/e2e/clean-content.spec.js) – `cleanContentArtefacts` aus [public/js/utils.js](public/js/utils.js): Paste-Artefakt-Stripping.
- [tests/e2e/lektorat.spec.js](tests/e2e/lektorat.spec.js) – Lektorat-Flow mit Mock-Server und Harness-Szenarien.

**Bei grösseren UI-Änderungen** (besonders am Editor, Fokus-Modus, Scroll-/Selection-Verhalten, Lektorat-Flow) vor dem Commit automatisch `npm test` ausführen. Schlägt etwas fehl, Ursache klären statt Tests anpassen. Übrige Bereiche weiterhin manuell validieren.
