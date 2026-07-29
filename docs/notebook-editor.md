# Notebook-Editor

Klassischer Bearbeitungsmodus **für eine einzelne Seite**: `contenteditable` mit Toolbar (Bubble + Slash), Inline-Findings, Draft-/Autosave-Pipeline, Stale-Write-Schutz und Snapshot-Wiederaufnahme. Einer von drei unabhängigen Editoren der App — die anderen beiden sind der [Focus-Editor](focus-editor.md) (eigenständiger Vollbild-Schreibmodus, läuft auf demselben Seiten-Container) und der [Bucheditor](book-editor.md) (eigenständige Karte mit Manuskript-Stream über das ganze Buch). Bei Änderungswünschen muss der User immer nennen, welcher Editor gemeint ist (Harte Regel in [CLAUDE.md](../CLAUDE.md)).

Implementations-Detail: Notebook- und Focus-Editor teilen die Save-/HTML-Pipeline aus [public/js/editor/shared/](../public/js/editor/shared/) (`save-pipeline.js`, `html-clean.js`, `active-editor.js`); das macht sie nicht zu einem Editor — es ist eine geteilte Lib. Bucheditor nutzt `shared/` bewusst nicht (eigener Save-Pfad mit Per-Block-Queue). Alle drei Editoren schreiben über die [Content-Store-Facade](../lib/content-store/).

Code: [public/js/editor/notebook/edit.js](../public/js/editor/notebook/edit.js) (Facade, spreadet die Submodule aus `edit/` zu `notebookEditMethods`), [public/js/editor/notebook/toolbar.js](../public/js/editor/notebook/toolbar.js) (Facade für `editorToolbarCard`, spreadet aus `toolbar/`), [public/js/editor/notebook/storage.js](../public/js/editor/notebook/storage.js) (Snapshot), [public/js/editor/notebook/history.js](../public/js/editor/notebook/history.js) (Undo/Redo-Stack pro Edit-Session). Der Editor-Kern greift auf den Root nicht direkt via `window.__app` zu, sondern über `editorHost()` ([shared/editor-host.js](../public/js/editor/shared/editor-host.js)) — in der SPA ist das `window.__app`, in einer fremden Schale ein injizierter Host. Ausnahme: `card.js` (Reload-Restore-Glue) und `toolbar/` (notebook-only Chrome) bleiben auf `window.__app`. Card-Wrapper: [public/js/cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js). Partials: [public/partials/editor-notebook.html](../public/partials/editor-notebook.html), [public/partials/editor-body-edit.html](../public/partials/editor-body-edit.html), [public/partials/editor-toolbar.html](../public/partials/editor-toolbar.html). CSS: [public/css/editor/notebook/](../public/css/editor/notebook/).

Trigger: Edit-Button im Karten-Header (`startEdit`). Snapshot-Restore mountet den Editor automatisch beim Reload, wenn `normal.snapshot` für die aktuell geladene Seite passt.

## Verortung im Frontend

Sub-Karte `editorNotebookCard` ([public/js/cards/editor-notebook-card.js](../public/js/cards/editor-notebook-card.js)) hostet die volle Edit-Pipeline (`startEdit`/`saveEdit`/`cancelEdit`/`quickSave` + Autosave/Draft/Lock/Presence) und die Reload-Snapshot-Restore. Root spreaded nur dünne Trampoline-Forwarder ([editor/notebook/trampoline.js](../public/js/editor/notebook/trampoline.js)) und greift via `window.__notebookCard` durch — Templates und Cross-Card-Aufrufer (chat.js, focus/card.js, synonyme.js, find.js, toolbar.js, app-view.js) treffen damit weiter die Root-API (`app.startEdit()`, `app._markEditDirty()` …). Toolbar (Bubble + Slash) ist Sub-Card `editorToolbarCard`.

| Verantwortlichkeit | Wohnt in |
|---|---|
| `editMode`, `editDirty`, `editSaving`, `saveOffline`, `pendingDraft`, `editConflict`, Auto-Save-Timer | Root (`notebookState` in [app-state.js](../public/js/app/app-state.js)) |
| `currentPage`, `originalHtml`, `renderedPageHtml` (mode-agnostisch — von Notebook/Focus/View geteilt) | Root (`pageState` in [app-state.js](../public/js/app/app-state.js)) |
| `correctedHtml`, `hasErrors` (Lektorat-Overlay, nur im Prüfmodus aktiv — von page-view über `correctedHtml \|\| renderedPageHtml` konsumiert) | Root (`lektoratState` in [app-state.js](../public/js/app/app-state.js)) |
| `startEdit`/`saveEdit`/`cancelEdit`/`quickSave` + Autosave/Draft/Online-Retry + private Helper (`_checkPageConflict`, `_filterFindingsAfterSave`, `_flushDraftSaveNow`, `_markEditDirty`, …) | Sub `editorNotebookCard` ([editor/notebook/edit.js](../public/js/editor/notebook/edit.js)) |
| Root-API (Templates + Cross-Card-Aufrufer) | Trampoline ([editor/notebook/trampoline.js](../public/js/editor/notebook/trampoline.js)) — forwarded auf `window.__notebookCard` |
| Reload-Snapshot-Restore (Pendant zu `_tryRestoreFocus`) | Sub `editorNotebookCard` ([editor/notebook/card.js](../public/js/editor/notebook/card.js)) |
| Bubble + Slash-Menü State (`bubbleShow`, `slashShow`, …) | Sub `editorToolbarCard` |
| Container-Lookup (`page-content-view--editing`) | `shared/active-editor.js` (smart-switch mit Focus) |

**Trampoline-Pattern:** beide Editoren konsequent gleich strukturiert — Root hält nur Forwarder, Sub die Logik. Notebook nutzt direkte Sub-Ref-Calls (`window.__notebookCard?.X(args)`), weil Methoden Args/Returns durchreichen müssen (z. B. `_checkPageConflict(pageId, expectedUpdatedAt)`, `await quickSave()`). Focus-Trampoline ([editor/focus/trampoline.js](../public/js/editor/focus/trampoline.js)) ist CustomEvent-basiert (4 arg-lose Dispatcher) — pragmatischer Stilunterschied bei gleicher Architektur (siehe [focus-editor.md](focus-editor.md#root-vs-sub-trampoline-pattern)).

## Sheet-Optik (Tagebuch/Notebook)

`.page-content-view` ist der **gemeinsame Style-Scope für Read- und Edit-Modus** — kein Layout-Sprung beim Toggle, gleiche Buchsatz-Typografie in beiden Modi. CSS: [public/css/page/page-view.css](../public/css/page/page-view.css).

**Aktive Tagebuch-Hebel:**
- **Paper-Sheet-Shadow** — `box-shadow: var(--shadow-sm)` auf `.page-content-view` (Blatt-auf-Tisch-Lift in beiden Modi).
- **Buchsatz-Erstzeilen-Einzug** — `p + p { text-indent: 1.4em; margin-top: 0; }`. Folge-`<p>`-Selector greift automatisch nicht nach Headings, blockquote, poem, hr (Roman-/Tagebuch-Buchsatz). Mobile (<600 px): Margin auf 0.8em angehoben (Zeilen-Boost), Erstzeilen-Indent bleibt.
- **Vertikaler Atem** — `padding: 36px clamp(18px, 4vw, 40px)`, `line-height: 1.5`, `<p>`-Margin 0.6em (Desktop).

**`--editing`-Modifier** ergänzt nur Edit-Spezifika: linkes Rail (5 px primary), Background-Tint, `hyphens: none`, `text-wrap: wrap` (kein pretty/balance gegen Caret-Wackeln), `cursor: text`. Sheet-Shadow, Padding, Line-height, Erstzeilen-Einzug erbt aus dem Base-Selector — **Read und Edit zeigen identische Typografie**.

**Edit-only-Properties** müssen über `.page-content-view--editing` (oder Kind-Selektoren davon) gehängt werden. Setzt man Edit-Properties direkt auf `.page-content-view`, leaken sie in Read.

**Caption-Slot in Partials:** [editor-body-view.html](../public/partials/editor-body-view.html) (Read), [editor-body-edit.html](../public/partials/editor-body-edit.html) (Edit). Caption lebt **ausserhalb** des contenteditable, sonst landet sie im DB-HTML.

## Container-Lookup (smart-switch)

Beide Modi suchen ihren contenteditable via `getActiveEditorContainer()` aus [editor/shared/active-editor.js](../public/js/editor/shared/active-editor.js). Selektoren:

- Normal: `#editor-card .page-content-view--editing`
- Focus: `.focus-editor.is-active .page-content-view--editing` (nur wenn `app.focusActive` und Container sichtbar)

Damit sind mode-agnostische Subs (Synonyme, Figur-Lookup) ohne `if (app.focusActive)` lauffähig.

## Lifecycle

```
view  ──startEdit──▶ edit  ──saveEdit──▶ view
                       │  ──cancelEdit──▶ view (mit appConfirm bei Dirty)
                       │  ──quickSave──▶ edit (silent, Auto-/Ctrl+S)
                       │  ──Enter focus──▶ focus (focusMode=true, editMode bleibt)
                       └──Reload──▶ Snapshot-Restore (sessionStorage)
```

### startEdit
1. Guards: `currentPage && originalHtml !== null`, **nicht bereits im Edit-Modus** (Re-Entry würde `innerHTML` überschreiben und die Undo-Baseline neu setzen), kein laufender Check / Save, **nicht im Prüfmodus** (`checkDone === false`), `canEdit()`.
2. `editMode=true`, Reset `editDirty/editSaving/saveOffline/pendingDraft`.
3. `execCommand('defaultParagraphSeparator', false, 'p')` einmalig — sonst erzeugt Chrome/Safari `<div>` statt `<p>` bei Enter und Block-Erkennung greift nicht.
4. Draft aus localStorage lesen ([editor/draft-storage.js](../public/js/editor/draft-storage.js)); wenn vorhanden und ungleich Original → übernehmen + `editDirty=true`.
5. `mountEditorHtml(el, initialHtml)` ([shared/mount-html.js](../public/js/editor/shared/mount-html.js)) — setzt das HTML (bzw. Platzhalter-`<p><br></p>` bei leerer Seite), wrappt orphan Text-/Inline-Runs via `normalizeEditorBlocks` und stellt den Caret-Slot her (kindloser letzter `<p>` → `<br>`; trailing `<hr>` → Folge-Absatz). Meldet `{ repaired }`; bei `true` → `editDirty=true` + Draft schreiben (Legacy-Reparatur persistieren, sonst kehrt der Defekt nach jedem Reload zurück). Derselbe Helper bedient Undo/Redo-Restore und das Spiegeln eines gemergten Stands.
6. `_startAutosave` + `_installOnlineRetry`.
7. `_startPresenceHeartbeat` + `_acquireEditLock` (Soft-Lock).
8. `installEditCounter` (zählt in beiden Modi, sichtbar nur im Focus).
9. `writeNormalSnapshot(pageId)` — sessionStorage für Reload-Restore.
10. Layout-Prefs aus localStorage restoren: Fullscreen, Fit-Width, Steuerzeichen, **Zoom** ([notebook/storage.js](../public/js/editor/notebook/storage.js)). Persistenz läuft über `_persistEditorPrefs()` als SSoT — jeder Toggle schreibt den vollen Satz, weil localStorage den JSON-Eintrag komplett ersetzt. Steuerzeichen-Overlay erst nach dem Alpine-`x-show`-Flush installieren (`setTimeout 0`), sonst vermisst es einen `display:none`-Container (alle Rects 0).

### saveEdit ([edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js))
1. Guards: `currentPage`, **`editMode`** (ohne offene Session gibt es nichts zu speichern — das contenteditable hängt nach dem Teardown weiter im DOM und trüge sonst verworfenen Text zurück), `canEdit()`, Container vorhanden.
2. `stripLektoratMarks(el.innerHTML)` → kanonisches HTML (entfernt `.lektorat-ins`/`.chat-mark-ins`, unwrappt `.lektorat-mark`/`.chat-mark`, läuft durch Cleaner-Kette).
3. `isNoChange` → kein PUT; Save aus Focus bleibt im Focus, sonst `await cancelEdit()` ohne Dialog.
4. `editSaving = true` — **vor** dem ersten `await` (Pflicht-Invariante #6).
5. Kürzungs-Safety: neuer Text < 20 % vom alten und Original > 50 Z → `appConfirm` „kürzer speichern?".
6. `_resolveConflictBeforeSave({ silent: false })` — Pre-Check + Merge + ggf. Überschreib-Modal (s.u.).
7. `contentRepo.savePage(id, buildSavePayload({ source: focusActive ? 'focus' : 'main', expectedUpdatedAt }))` (siehe [shared/save-pipeline.js](../public/js/editor/shared/save-pipeline.js)).
8. `_applySaveSuccess(saved, savedHtml)` — **SSoT für die Save-Erfolgs-Nachbereitung** (Lifecycle): übernimmt `currentPage.updated_at`, setzt `originalHtml`/`currentPageEmpty`, ruft `_filterFindingsAfterSave` + `_syncPageStatsAfterSave` + `refreshPageAges`, räumt Draft + Autosave-Timer + `editDirty`/`saveOffline`/`editConflict`, `updatePageView`. Alle sechs Save-Pfade (saveEdit/quickSave/submitConflictResolution × Haupt- + 409-Re-Merge) rufen denselben Helper — keine Copy-Paste-Drift. `applyToEditor:true` spiegelt zusätzlich den gemergten Stand in den Editor (Konflikt-Auflösung). **Timer-Reset ist Pflicht:** der Autosave-Max-Timer wird von `_scheduleAutosave` nur gesetzt, wenn er `null` ist — bliebe er armiert, messe der 120-s-Cap der nächsten Tipp-Serie noch von der Baseline vor diesem Save.
9. `_filterFindingsAfterSave(newHtml)` — Findings, deren `original` nicht mehr matcht (Überlebens-Check via `findInHtml`, tolerant gegen Tag-/Whitespace-Differenzen, identisch zu `sortByPosition`), fliegen raus + selectedFindings + appliedOriginals + correctedHtml resetten.
10. Teardown **nur wenn nicht im Focus** via `_teardownEditSession()` (s.u.). Im Focus bleibt `editMode=true`.
11. Fehlerpfade: 409 `PAGE_CONFLICT` (Race nach Pre-Check) → `_retryAfterConflict` (s.u.); kollisionsfrei = stille Re-Save, sonst Auflösungs-Banner; bei Flag-off/Fehlschlag `_keepAsDraft` + klassischer Banner. Netzwerkfehler → `_keepAsDraft` (`saveOffline=true`), Online-Retry feuert `quickSave`.

### Konflikt-Pipeline (geteilt von allen drei Save-Pfaden)

`saveEdit`, `quickSave` und `submitConflictResolution` unterscheiden sich nur in Modal-vs-Banner und den Statustexten — die Konfliktlogik selbst liegt einmal in [edit/conflict.js](../public/js/editor/notebook/edit/conflict.js):

| Helper | Aufgabe |
|---|---|
| `_resolveConflictBeforeSave({ localHtml, source, silent })` | Pre-Check → Block-Merge → bei nicht-mergebarem Konflikt Modal (`silent:false`) bzw. Banner (`silent:true`). Liefert `{ proceed, saveHtml, expectedAt, merged }`. |
| `_retryAfterConflict({ localHtml, source, pageId, pageName, tag })` | 409-Race nach dem PUT: Merge gegen den frischen Remote-Stand + Re-Save. Liefert `{ saved, html }`, `{ conflict:true }` oder `null`. Setzt `editSaving=false`, **bevor** ein Auflösungs-Modal aufgehen kann (`submitConflictResolution` bricht bei gesetztem Flag früh ab → sonst Sackgasse). |
| `_keepAsDraft({ pageId, html, banner, statusKey })` | Fallback: Draft zuerst, dann `saveOffline` + Banner + Status. |
| `_conflictBannerFrom(conflict)` / `_conflictHintText(banner)` | Banner-Feldsatz bzw. Statuszeile (Gerät vs. User). |

**Überschreib-Stempel:** bestätigt der User „trotzdem speichern", geht `expectedUpdatedAt = conflict.remoteUpdatedAt` mit — **nicht** der stale Editor-Stempel. Der OCC-Guard im Backend prüft `WHERE updated_at = expected_updated_at` ([content-store/backends/localdb.js](../lib/content-store/backends/localdb.js)); mit dem alten Wert liefe der PUT erneut in 409 und die Entscheidung wäre wirkungslos.

### Block-Level-Merge bei Stale-Write ([shared/block-merge.js](../public/js/editor/shared/block-merge.js))
Flag `FEATURE_BLOCK_MERGE` ([app-state.js](../public/js/app/app-state.js)). Greift in `saveEdit`/`quickSave` an beiden Konflikt-Punkten (Pre-Check + 409-Race) — Notebook **und** Focus teilen den Pfad.
- **Block-IDs:** `lib/html-clean.js#ensureBlockIds` vergibt beim Page-Write (`localdb`-Backend, `_cleanHtmlSafe`) stabile `data-bid` auf allen Block-Tags. Nur auf gespeichertem Page-Body, nicht in `cleanPageHtml` (sonst auch Export/WP-Sync). Idempotent, Duplikate werden neu vergeben.
- **3-Way:** `_attemptBlockMerge` lädt frischen Remote-Stand, `base = originalHtml` (common ancestor), `local = Editor-HTML`. `mergeBlocks(base, local, remote)` mergt nicht-kollidierende Block-Edits still.
- **Kollisionsfrei** → `saveHtml = mergedToHtml(merged)`, Save mit `expectedUpdatedAt = remote.updated_at`, Editor-DOM auf merged gespiegelt (`_applyMergedToEditor`), Toast `edit.conflict.merged.silent`. Kein Banner.
- **Echte Block-Kollision** → `conflictResolution`-State + Modal ([partials/conflict-resolution.html](../public/partials/conflict-resolution.html)): pro Block Meine/Andere/Beide + Bulk; `submitConflictResolution` baut finales HTML via `buildResolvedHtml`. Block-Previews via `x-text` (escaped, kein x-html-Sink).
- **Fallback** auf klassisches Überschreib-Modal: Flag off, leere Base (frische Page → 2-Way) oder Merge wirft.

### quickSave ([edit/lifecycle.js](../public/js/editor/notebook/edit/lifecycle.js))
- Silent-Pfad: kein Modal, kein „bist du sicher". Auslöser: Ctrl+S, Autosave-Timer, Focus-Exit, Online-Retry.
- **Reihenfolge:** Erst Draft schreiben → dann Netzwerk versuchen. Offline-Tab kann jederzeit ohne Datenverlust geschlossen werden.
- `editSaving=true` früh setzen (Race-Schutz vs. Auto-Save-Tick + Ctrl+S + exitFocusMode-Save).
- Konflikt im Pre-Check oder 409 → `saveOffline=true` + `editConflict`-Banner; **keine** Modal-Frage (sonst Modal-Spam im Hintergrund-Save).
- Erfolg → Draft löschen, `editDirty=false`, `lastAutosaveAt` setzen, Statusleiste `editor.savedAt`.

### cancelEdit
- Bei `editDirty` → `appConfirm` „verwerfen?". Klick „nein" → kein Cleanup, Editor bleibt.
- Volles Teardown via `_teardownEditSession()`. Wenn `focusActive` → zusätzlich `exitFocusMode` (Focus folgt Edit aus dem Notebook-Pfad; gilt nur, solange Invariante `focusMode ⇒ editMode` aktiv ist).

### `_teardownEditSession({ keepDraft })` (SSoT für den Session-Abbau)
**Drei** Aufrufer bauen die Edit-Session über **denselben** Helper ab — kein Copy-Paste je Pfad, sonst leckt ein vergessener Teardown-Schritt Listener/Lock/Observer:

| Aufrufer | Draft | Warum |
|---|---|---|
| `cancelEdit` | verworfen | User hat „verwerfen" bestätigt. |
| `saveEdit` (Non-Focus-Pfad) | schon von `_applySaveSuccess` geräumt | Inhalt liegt auf dem Server. |
| `resetPage` ([app-view/page.js](../public/js/app/app-view/page.js), via Trampoline) | **`keepDraft: true`** | Seitenwechsel/Karten-Schliessen: der Draft ist die einzige Kopie ungespeicherter Arbeit, der `pendingDraft`-Banner bietet sie beim nächsten Besuch wieder an. |

Reihenfolge = Pflicht-Invariante #11: Draft → Snapshot → Autosave → OnlineRetry → FormatMarks → Counter → Presence → Lock → History → `editMode=false` (+ Flags-Reset inkl. `editConflict`/`conflictResolution` + Synonym-/Figur-Menüs schliessen). Der Focus-Branch von `saveEdit` ruft ihn **nicht** (User schreibt weiter).

**Warum `resetPage` zwingend delegiert:** Lock- und Presence-Heartbeat erneuern sich selbst (5 min bzw. 30 s) und werden ausschliesslich hier abgeräumt. Ein Teilabbau im Root liesse beide auf der verlassenen Seite weiterlaufen — andere ACL-User sähen sie für den Rest der Session als „wird bearbeitet". Gegated: [tests/unit/notebook-teardown.test.mjs](../tests/unit/notebook-teardown.test.mjs).

## Undo/Redo (Session-scoped, pro Seite)

Eigener Stack in [editor/notebook/history.js](../public/js/editor/notebook/history.js) — Browser-eigener Undo-Stack kollabiert sobald wir `innerHTML` oder `replaceChild` aufrufen (Slash-Menü, HR, Paste-Cleaner), darum eine eigene Snapshot-Kette.

**Lifecycle:**
- `startEdit` → `_historyReset(initialHtml)` legt Baseline-Snapshot.
- `_markEditDirty` → `_historyPushSoon` (debounced 500 ms) — Tipp-Serien werden zu einem Schritt zusammengefasst. Dedup gegen Top-of-Stack.
- Undo/Redo flush'en pending Debounce, dann `idx--/idx++` und `_historyRestore(snap)` setzt `innerHTML` + Caret.
- `cancelEdit` / `saveEdit` (non-focus) → `_historyClear` — Session-Ende = Stack-Ende.

**State** (Initial-Felder in [cards/editor-notebook-card.js](../public/js/cards/editor-notebook-card.js)): `_undoStack` (Array `{ html, caretOffset }`, Cap 100), `_undoIdx`, `_undoTimer`, `_undoApplying`.

**Caret-Restore**: Text-Offset vom Editor-Root (Tree-Walker, SHOW_TEXT). Robust über strukturelle Mutationen (Slash, HR), bei reinen Text-Edits exakt.

**Restore-Pfad**: setzt `_undoApplying=true`, schreibt `innerHTML`, restored Caret, ruft `_scheduleDraftSave`/`_scheduleAutosave` (Draft + Autosave laufen weiter), dispatcht `input`-Event (LanguageTool re-check). `_markEditDirty` skipt während des Flags den Push — so wird das Restore nicht selbst zum neuen Stack-Eintrag.

**UI**: Buttons in [editor-notebook.html](../public/partials/editor-notebook.html) `.page-editor-toolbar` (icons `#undo`/`#redo`), Disabled via `notebookCanUndo()`/`notebookCanRedo()`. Keybinds in [toolbar.js](../public/js/editor/notebook/toolbar.js) `_onEditKeydown`: Cmd/Ctrl+Z = Undo, Cmd/Ctrl+Shift+Z + Ctrl+Y = Redo. Im Focus-Editor deaktiviert (Gate `!app.focusActive`).

## Autosave + Draft

| Pfad | Wann | Wohin | Debounce | Cap |
|---|---|---|---|---|
| Draft | bei jedem `_markEditDirty` | localStorage (`draft-storage.js`) | 500 ms | — |
| Autosave (silent) | Idle nach letztem Edit | Server (`quickSave`) | 60 s | 120 s ab erstem Dirty |
| Manual Save | Save-Button (`saveEdit`) | Server (mit Dialog bei Konflikt/Kürzung) | — | — |

`AUTOSAVE_IDLE_MS`/`AUTOSAVE_MAX_MS` liegen in [editor/shared/autosave.js](../public/js/editor/shared/autosave.js) (geteilt mit dem Bucheditor, damit beide Editoren im selben Rhythmus speichern); [edit/_shared.js](../public/js/editor/notebook/edit/_shared.js) re-exportiert sie und deklariert `DRAFT_DEBOUNCE_MS`. Die Timer-Handles bleiben am Root-Host (siehe unten). `_scheduleAutosave` resettet den Idle-Timer; Max-Timer läuft ab erstem Dirty durch und schlägt zu, wenn der User dauerhaft tippt.

`_flushDraftSaveNow` schreibt sofort + bricht Debounce ab. Aufruf vor jedem Übergang, der den Editor-Inhalt nicht mehr einfängt — insbesondere Focus-Mode-Entry ([focus/card.js](../public/js/editor/focus/card.js)).

## Snapshot-Wiederaufnahme

`writeNormalSnapshot(pageId)` ([notebook/storage.js](../public/js/editor/notebook/storage.js)) schreibt `{ pageId, ts }` in sessionStorage. TTL 1 h. Überlebt F5 + OIDC-Redirect, nicht Tab-Close.

Restore-Trigger sitzt im Root und mountet den Editor automatisch, wenn nach Reload die ursprüngliche Seite geladen ist. Pendant zum Focus-Snapshot — nur Mount-Signal, keine Content-Wiederherstellung (Content kommt aus dem localStorage-Draft).

Cleanup bei `cancelEdit` / `saveEdit` (Non-Focus-Pfad).

## Toolbar (Bubble + Slash)

Sub-Karte `editorToolbarCard` ([cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js)), Methods aus der Facade [notebook/toolbar.js](../public/js/editor/notebook/toolbar.js), die aus dem Subfolder `toolbar/` spreadet: `bubble.js` (Bubble-Toolbar + Link-Bar), `slash.js` (Slash-Menü), `keydown.js` (Keydown-Dispatcher), `_shared.js` (Modul-Helfer + `SLASH_ITEMS` + Block-Lookups). Beide Layer als teleportierte Templates in [partials/editor-toolbar.html](../public/partials/editor-toolbar.html) → `position:fixed` ist ausserhalb des `.card`-Transform-Kontextes.

| Layer | Trigger | Sichtbar wenn | Funktion |
|---|---|---|---|
| Bubble | non-collapsed Selection im Editor | `editMode && !focusActive && !sel.isCollapsed` | Bold/Italic (Inline) — Single-Word-Flag steuert zusätzliche Aktionen; dazu Link-, Beleg- und Querverweis-Einstieg |
| Slash | `/` in leerem Block | `editMode && !focusActive` | Block-Transform: `p`, `h2`, `h3`, `blockquote`, `.poem`, `ul/li`, `hr` |
| Beleg-Picker | Toolbar-Button, Bubble-Button oder **Klick auf einen bestehenden Chip** | `citeShow && editMode && !focusActive` | Quelle wählen/wechseln, Stellenangabe, Zitat-Art, Beleg entfernen |
| Querverweis-Picker | Bubble-Button | `xrefShow && editMode && !focusActive` | Kapitel/Abbildung als Ziel + Anzeigeform |

**Im Focus deaktiviert.** Bubble/Slash gaten via `if (app.focusActive) return;` ([toolbar.js#L56](../public/js/editor/notebook/toolbar.js#L56), [#L148](../public/js/editor/notebook/toolbar.js#L148)). Cmd/Ctrl+B/I und Cmd/Ctrl+Shift+H laufen weiter, weil B/I auch im Focus-Notwendig-Whitelist sind.

### Slash-Items ([toolbar.js#L14-22](../public/js/editor/notebook/toolbar.js#L14-L22))
`paragraph`, `h2`, `h3`, `blockquote` (mit innerem `<p>`), `poem` (`div.poem` + innerem `<p>`), `list` (`ul > li`), `hr` (+ Folge-`<p>`). Tag-Swap am ganzen Block; Caret landet im Replacement (oder im wrapP-`<p>`).

### Slash-Positionierung ([toolbar/slash.js](../public/js/editor/notebook/toolbar/slash.js)#`_updateSlashPosition`)

Das Menü ist nach `<body>` teleportiert (`position: fixed`) und wird per JS am Trigger-Block verankert. Vier Regeln, alle vier verhaltensrelevant:

1. **Bezug ist der `visualViewport`, nicht `window.innerHeight`.** Die Bildschirmtastatur schrumpft (und verschiebt, Android) das sichtbare Band, während `innerHeight` unverändert bleibt — nach `innerHeight` positioniert landet das Menü hinter der Tastatur. `visibleBand()` liefert `top`/`left`/`height`/`width` in Client-Koordinaten (dieselbe Ebene wie `getBoundingClientRect`), mit `innerHeight/innerWidth` als Fallback.
2. **Oberhalb ist Vorzugsrichtung, mit Flip nach unten.** Oben bleibt das Menü näher am Caret und springt in langen Texten nicht unter den Fold; passt die (gemessene) Höhe dort nicht bzw. ist unterhalb mehr Platz, klappt es unter den Block. Danach wird die Oberkante hart ins Band geklemmt.
3. **Höhe messen, nicht raten** (harte Regel „Flip-up-Popover messen statt raten" in [CLAUDE.md](../CLAUDE.md)): sie hängt an der gefilterten Trefferliste **und** am gedeckelten `max-height`. `_openSlashAt` positioniert mit dem Deckel als Schätzung vor und zieht über `_schedSlashPosition()` nach. Das läuft bewusst per `requestAnimationFrame` statt `$nextTick` — die Trefferliste ist ein verschachtelter `x-for` mit eigenem `x-show` je Gruppen-Header, dessen Effekte erst im Flush **nach** dem äusseren Tick laufen; ein einzelnes `$nextTick` misst eine veraltete Höhe.
4. **`max-height` folgt dem Band** (`slashMaxH`, inline gebunden): mit offener Tastatur bleiben oft weniger als die 360 px aus [edit-toolbar.css](../public/css/editor/notebook/edit-toolbar.css) übrig — dann wird die Liste kürzer und scrollt intern, statt aus dem Band zu ragen. Ist in beiden Fächern zu wenig Platz, darf das Menü den Trigger-Block überlappen (`SLASH_MIN_H`).

Nachziehen bei Bewegung: `scroll` (capture, auch interne Container), `visualViewport`-`resize`/`scroll` (Tastatur öffnet/schliesst) und `$watch('slashQuery')` (Liste schrumpft) — alle drei in `editorToolbarCard#init()` am AbortController-`signal`. Scrollt der Block aus dem Band, schliesst das Menü statt am Bandrand zu parken.

### Keydown-Dispatcher (`_onEditKeydown` in [toolbar/keydown.js](../public/js/editor/notebook/toolbar/keydown.js))
Statt eines Megaswitch eine geordnete Kette benannter Handler (`_kbSoftBreak`, `_kbTodoEnter`, `_kbPoemEnter`, `_kbDateStamp`, `_kbInlineFormat`, `_kbHorizontalRule`, `_kbLink`, `_kbUndoRedo`, dann Focus-Hard-Stop, dann `_kbSlashNav`, `_kbDeleteBlock`, `_kbTodoDelete`, `_kbFigureCaption`, `_kbBlockBoundary`, `_kbSlashTrigger`). Die drei Struktur-Handler stehen **spezifisch vor generisch**: die beiden Void-Element-Fälle (Checkbox, Bild) vor dem allgemeinen Wrapper-Grenz-Handler. Jeder Handler gibt `true` zurück, wenn er das Event konsumiert hat → der Dispatcher bricht ab. **Reihenfolge ist verhaltensrelevant** (z.B. Shift+Enter vor Enter-in-Todo); die Handler bis zum Focus-Hard-Stop laufen in beiden Modi, danach sind Slash + Block-Transforms tabu. Neuer Shortcut → eigenen `_kb*`-Handler ergänzen und an der richtigen Stelle in die Dispatcher-Kette hängen.

### Löschen in Checkbox-Listen (`_kbTodoDelete` in [toolbar/keydown.js](../public/js/editor/notebook/toolbar/keydown.js))

Eine Checkbox-Zeile ist `<li class="todo-item"><input type="checkbox"><span class="todo-text">…</span></li>`. Der native contenteditable-Default behandelt das `<input>` wie ein Textzeichen und ist damit an jeder Zeilengrenze falsch: er frisst erst die Checkbox (Zeile bleibt als `li.todo-item` **ohne** Checkbox zurück) und räumt die Zeile erst beim nächsten Druck; am Listenanfang tut er gar nichts (die Liste ist per Backspace nicht verlassbar); über die Listengrenze hinweg zieht er den Folgeabsatz mit einem Inline-`style`-Attribut ins `.todo-text`-Span und lässt ihn als Block verschwinden. Darum übernimmt der Editor alle Grenzfälle selbst — **die Checkbox ist Struktur, nie Löschziel, und ein Tastendruck bewirkt genau einen Schritt**:

| Caret | Taste | Verhalten |
|---|---|---|
| Zeilenanfang, Zeile darüber existiert | Backspace | Inhalt an die Zeile darüber anhängen, eigene Zeile weg. Der `checked`-Zustand der **bleibenden** Zeile gilt. |
| Zeilenanfang, erste Zeile der Liste | Backspace | Liste verlassen: Inhalt wandert in einen `<p>` **vor** der Liste (`_todoLiToParagraph`), leere Liste wird entfernt. Spiegelt `_kbTodoEnter` (leere Zeile → raus). |
| Zeilenende, Zeile darunter existiert | Delete | Zeile darunter hochziehen (deren Checkbox geht mit ihr; die eigene bleibt). |
| Zeilenende, letzte Zeile | Delete | Absatz-artigen Folgeblock hochziehen. Steht dort etwas anderes (Liste, Gedicht, `<hr>`) oder nichts → No-Op statt Default. |
| Anfang eines `<p>` direkt **nach** der Liste | Backspace | Inhalt an die letzte Checkbox-Zeile anhängen (`_kbTodoDeleteAdjacent`). |
| Ende eines `<p>` direkt **vor** der Liste | Delete | Erste Checkbox-Zeile in den Absatz ziehen. Die Checkbox fällt weg — ein Absatz hat keine, gleiche Semantik wie beim Verlassen der Liste. |
| mitten im Text | beide | Browser-Default. |

Nicht-collapsed Selektionen bleiben bewusst beim Default (Mehrzeilen-Löschen ist ein Inhalts-, kein Strukturfall). Der Merge läuft über den geteilten `_mergeBlocksManually`, der ein alleinstehendes `<br>` auf **beiden** Seiten als Platzhalter wegräumt — sonst bliebe beim Verschmelzen einer leeren Zeile eine sichtbare Leerzeile im Span stehen. Läuft nur im Notebook (hinter dem Focus-Hard-Stop).

### Löschen an Blockgrenzen (`_kbBlockBoundary`, `_kbFigureCaption`)

Dasselbe Problem wie in der Checkbox-Liste, nur breiter: **Chromium bäckt beim Merge über eine Blockgrenze die berechneten CSS-Werte des Quellblocks als Inline-`style` ein** („um das Aussehen zu erhalten"). Das ist keine Kosmetik — `cleanPageHtml` strippt `style`-Attribute **nicht**, der Müll wird persistiert, geht in jeden Export mit, und die eingebrannten Light-Mode-Farben sind im Dark-Mode falsch. Dazu verstösst er gegen die harte Regel „Styles nur in `public/css`". Betroffen war jede Grenze Absatz ↔ formatierter Block, in beiden Richtungen; `blockquote` und `pre` verschwanden dabei komplett.

Zwei Handler teilen sich das, spezifisch vor generisch:

- **`_kbFigureCaption`** schützt das `<img>` in `<figure><img><figcaption>` — der zweite Void-Element-Fall nach der Checkbox. Leere Legende + Backspace entfernt das ganze `figure` in **einem** Druck (der Default löschte erst die Legende, dann das Bild, und hinterliess dazwischen ein `<figure>` mit Rahmen ohne Inhalt). Legende mit Text + Backspace am Anfang ist ein **No-Op**: links steht das Bild, kein Zeichen — erst den Legendentext löschen, dann greift der Fall darüber. Delete am Legenden-Ende ebenfalls No-Op, statt den Folgeblock hereinzuziehen. Das Bild selbst löscht man von aussen: `_kbDeleteBlock` behandelt ein angrenzendes `<figure>` wie eine `<hr>` (`ATOMIC_BLOCK_TAGS`) — nötig, weil es für Bilder **keine** Klick-Auswahl gibt (anders als `hr.hr-selected`), also sonst überhaupt keinen Lösch-Pfad.
- **`_kbBlockBoundary`** deckt die formatierten Wrapper ab (`BOUNDARY_WRAPPER_SEL`: `blockquote`, `div.poem`, `pre`, `ul:not(.todo)`, `ol`). Vier symmetrische Fälle: Backspace am Anfang des ersten Kind-Blocks **verlässt den Wrapper** (Inhalt wird zum Absatz davor, `_blockToParagraph`); Delete am Ende des letzten Kind-Blocks zieht den Folgeabsatz herein; die Gegenstücke gelten für den Caret im Nachbarabsatz. Merges **innerhalb** eines Wrappers (Zeile 2 auf Zeile 1) bleiben beim Default — die sind nachweislich sauber. `<pre>` trägt seinen Text direkt und gilt über `wrapperInnerBlocks` als sein eigener einziger Kind-Block, damit es keinen Sonderzweig braucht.

`ul.todo` ist aus `BOUNDARY_WRAPPER_SEL` ausgenommen — dafür ist der spezifischere `_kbTodoDelete` zuständig, der zusätzlich die Checkbox als Struktur behandelt. Wo der Default schon sauber war, erzeugen die Handler bewusst **dasselbe** Ergebnis wie er (nur explizit statt implizit); die einzige gewollte Verhaltensänderung an einer bisher unauffälligen Stelle ist „Backspace im ersten Listenpunkt verlässt die Liste" bei `ul`/`ol` — vorher merkte er mit dem Absatz davor, jetzt konsistent zur Checkbox-Liste.

### Haken setzen in Checkbox-Listen (beide Modi)

Der Haken lebt als **Attribut** (`checked`) am `<input>`, nie nur als DOM-Property: nur das Attribut serialisiert in `innerHTML` und damit in die Persistenz. Wer `box.checked = true` setzt, sieht den Haken und speichert ihn nie. Beide Oberflächen des Notebook-Editors pflegen darum das Attribut, aber über getrennte Pfade — die Leseansicht ist kein contenteditable und hat keine Edit-Session, an die sich ein Dirty-Mark hängen könnte:

| Oberfläche | Pfad | Speichern |
|---|---|---|
| Edit-Modus (`.page-content-view--editing`) | delegierter Klick-Listener in [cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js) (contenteditable schluckt den nativen Toggle) | Attribut setzen + `_markEditDirty()` → normaler Save-/Autosave-Pfad. Deckt auch `.focus-editor__content` ab. |
| Leseansicht (`.page-content-view` ohne `--editing`) | `_handleViewTodoClick` → `_saveViewTodo` in [book/page-view.js](../public/js/book/page-view.js), aufgerufen als erster Zweig von `handleMarkClick` | Der Browser hat nativ schon getoggelt; der Haken wird via `setTodoCheckedAt` ([editor/shared/todo-html.js](../public/js/editor/shared/todo-html.js)) ins gespeicherte HTML gezogen und **sofort** per `savePage(source: 'main', expectedUpdatedAt)` persistiert. |

Invarianten der Leseansicht-Variante:
- **Index-Zuordnung** Live-DOM → gespeichertes HTML über `TODO_BOX_SEL` (`ul.todo > li.todo-item > input[type="checkbox"]`), identisch auf beiden Seiten. Trägt, weil `updatePageView` nur Inline-Marks (Lektorat/Chat) und `decorateMentions`-Spans einzieht — die ändern weder Zahl noch Reihenfolge der `input`-Elemente. Kein Treffer → **kein** Save (statt einen fremden Haken zu verschieben).
- **Schreibrecht**: ohne `canEdit()` wird der native Toggle zurückgedreht und nichts gesendet; zusätzlich macht `.page-content-view--readonly` (gesetzt in [editor-body-view.html](../public/partials/editor-body-view.html)) die Box für viewer/lektor klick-inert, damit sie nicht wie ein Klickziel aussieht.
- **Re-Entry-Guard** `_todoSaving`: zwei Haken in schneller Folge würden sonst mit demselben `expectedUpdatedAt` speichern und der zweite PUT liefe in einen 409 gegen den eigenen Write. Nach Erfolg wird `currentPage.updated_at` aus der Antwort nachgezogen.
- **Fehlerpfade drehen den Toggle zurück** (Ansicht und Persistenz laufen nie auseinander). Bei 409 kein Block-Merge für ein Bit: frischen Stand laden, `page.todo.conflict` melden, User setzt den Haken erneut.
- Jeder Haken erzeugt eine Page-Revision (Quelle `main`) — gewollt, es ist ein normaler Seiten-Write.

### Shortcuts (notebook + focus, im delegierten Listener)
- `Shift+Enter` → `insertLineBreak` (cross-browser Soft-Break statt Default-Absatzsplit).
- `Cmd/Ctrl+B` / `+I` → `_applyInline('bold'|'italic')` (auch im Focus).
- `Cmd/Ctrl+Shift+H` → `insertHorizontalRule` (auch im Focus).
- `/` in leerem Block → Slash-Menü öffnen.
- Slash-Menü offen: `↑/↓` Navigation, `Enter` Apply, `Esc` Schliessen, jedes Zeichen → Menü zu (Zeichen läuft durch).

## Void-/Caret-lose Block-Elemente: Klick-Selektion + Löschen

Manche Block-Elemente nehmen keinen Caret an (`<hr>` ist void; künftig denkbar: Bild-Block, Embed, Divider-Varianten). Im `contenteditable` lassen sie sich daher nicht selektieren und es gibt keinen natürlichen Lösch-Pfad. Muster, um ein solches Element editierbar (löschbar) zu machen — am Beispiel `<hr>`:

1. **Klick-Selektion** ([editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js), delegierter `click`-Listener im `init()` mit AbortController-`signal`): Klick auf das Element setzt eine transiente Klasse `.<tag>-selected` (z. B. `.hr-selected`). Klick irgendwo sonst im `.page-content-view--editing` hebt die Markierung aller Geschwister wieder auf. SSoT der Selektion ist die DOM-Klasse, kein Alpine-State.
2. **Visuelle Markierung** ([page-view.css](../public/css/page/page-view.css)): `.page-content-view--editing <tag> { cursor: pointer; }` + `.page-content-view--editing <tag>.<tag>-selected { … outline … }` (Akzent via `var(--color-accent)`). Nur unter `--editing` (Read-Modus bleibt unverändert). Zusätzlich `.page-content-view--editing:has(<tag>.<tag>-selected) { caret-color: transparent; }` — der Caret hat bei selektiertem void-Element keinen sinnvollen Slot und landet sonst quer zwischen Element und Folgeabsatz. Kommt zurück, sobald die Selektion (Klick woanders) die Klasse entfernt.
3. **Keyboard-Löschen** ([toolbar.js](../public/js/editor/notebook/toolbar.js) `_onEditKeydown`, Backspace/Delete-Branch): Liegt ein `<tag>.<tag>-selected` im Edit-Container, `e.preventDefault()` + `.remove()` + `_markEditDirty()`. Vor der normalen Caret-Nachbar-Logik.
4. **Transient halten** ([utils.js](../public/js/utils.js) `stripFocusArtefacts`): die `-selected`-Klasse ist reine Laufzeit-Dekoration und MUSS vor Save + Dirty-Compare gestrippt werden (gleicher Mechanismus wie `.focus-paragraph-active`). Sonst landet sie in der Revision und erzeugt Falsch-Dirty. `stripFocusArtefacts` läuft im Save- **und** Compare-Pfad (via `stripLektoratMarks`) — neue transiente Klasse dort in Guard + `querySelectorAll`-Selektor + `classList.remove`-Argumentliste ergänzen.

**Caret-Nachbar-Pfad als Ergänzung** (gleicher Backspace/Delete-Branch): Caret am Block-Anfang + Backspace löscht eine direkt davor liegende `<hr>`, Caret am Block-Ende + Delete eine dahinter. Nachbar-Lookup auf **Top-Level-Child** von `editEl` heben (nicht `block.previousElementSibling`), damit auch `<hr>` neben Listen/`figure`/`table` erreichbar ist (Caret-Block ist dort das tief verschachtelte `<li>`).

## Paste-Handler

`_onEditPaste` ([edit/input.js](../public/js/editor/notebook/edit/input.js)) verhindert, dass Computed-Styles inline aus anderen BookStack-Seiten / Websites in die DB wandern (sonst überschreiben sie `.poem` & Co.).

1. `e.preventDefault`.
2. Clipboard-HTML lesen → `cleanContentArtefacts(html)` ([public/js/utils.js](../public/js/utils.js)) — Cleaner-Kette zieht Font/Color/Span-Hüllen ab.
3. `execCommand('insertHTML', false, cleaned)`.
4. Fallback Plain-Text wenn kein HTML.
5. `_markEditDirty()`.

## Pflicht-Invarianten

1. **Save-Source explizit:** `buildSavePayload` verlangt `'main'` (Normal-Editor) oder `'focus'` — Aufrufer entscheidet, nicht die Lib. Quelle: `this.focusActive ? 'focus' : 'main'`.
2. **Pre-Save-Conflict-Check via `fresh: true`:** `_checkPageConflict` ruft `contentRepo.loadPage(id, { fresh: true })`. Ohne `fresh` liefert der SW-SWR-Cache stale `updated_at` und der Pre-Check passt fälschlich durch → Overwrite remote save. Siehe [feedback_stale_rmw](../.claude/projects/-Users-bd-ClaudeProjects-schreibwerkstatt/memory/feedback_stale_rmw.md).
3. **`stripLektoratMarks` vor jedem Save + jedem Dirty-Vergleich.** Verbindlich aus [shared/html-clean.js](../public/js/editor/shared/html-clean.js). Lokales Strip wäre Drift vs. Server-Sicht.
4. **`normalizeForCompare` für Dirty-Check.** `editDirty` darf nicht byte-genau vergleichen — Whitespace/Attribut-Ordnung weichen identisch-semantisch ab. Verwendet identische Cleaner-Kette wie Save.
5. **Draft IMMER zuerst.** `quickSave` schreibt erst localStorage, dann Netzwerk. Offline-Tab-Close darf nichts verlieren.
6. **`editSaving` früh setzen.** Race vs. parallelem Autosave-Tick + Ctrl+S + exitFocusMode-quickSave. In `saveEdit` **und** `quickSave` vor dem ersten `await` des Save-Vorgangs — insbesondere vor Kürzungs-Dialog und Pre-Save-Conflict-Read, die beide Wartezeit erzeugen. `_fireAutosave` gated nur auf `!editSaving`; steht das Flag noch auf false, setzt der Timer-Tick einen zweiten PUT ab, verschiebt `updated_at` und der bereits gefangene Stempel läuft garantiert in einen 409 gegen den eigenen Schreibvorgang. Gegated: [tests/unit/notebook-teardown.test.mjs](../tests/unit/notebook-teardown.test.mjs).
7. **`defaultParagraphSeparator='p'` einmal pro Edit-Session.** Sonst erzeugen WebKit/Blink `<div>` und Focus-`BLOCK_TAGS` (ohne DIV) erkennt den Block nicht.
8. **Caret-Slot `<br>` in leerem `<p>`.** Bei frischen Seiten / `cleanPageHtml`-`<p></p>`-Fallback hat eine kindlose `<p>` zero-height; Caret rendert nicht. Pendant: `ensureTrailingParagraph` aus [shared/auto-slot.js](../public/js/editor/shared/auto-slot.js).
9. **Conflict-Modal nur im manuellen `saveEdit`.** `quickSave` zeigt Banner statt Modal — Hintergrund-Save darf den User nicht unterbrechen.
10. **Counter `installEditCounter` läuft ab `startEdit`.** Tagesdelta muss alle Edits zählen, sonst sieht der Focus-Counter beim Wiedereintritt falsche Werte. Anzeige nur im Focus-Header (`x-show=focusActive`).
11. **Cleanup-Reihenfolge bei `cancelEdit`/`saveEdit`/`resetPage`:** Draft → Snapshot → Autosave → OnlineRetry → FormatMarks → Counter → Presence → Lock → History → `editMode=false`. Frühes `editMode=false` lässt Teardowns auf bereits genullten Refs laufen. **Jeder** Pfad, der den Edit-Modus verlässt, geht durch `_teardownEditSession` — auch der Seitenwechsel (`resetPage`, mit `keepDraft: true`). Ein handgepflegter Teilabbau leckt Lock- und Presence-Heartbeat.
12. **Edit + Prüfmodus forbidden.** `startEdit` bricht bei `checkDone === true` ab; Edit/Fokus-Buttons sind im Prüfmodus per `x-show="!checkDone"` ausgeblendet. Findings landen damit nie im contenteditable — Korrekturen werden ausschliesslich via `saveCorrections` aus dem Prüfmodus-Header angewandt.
13. **Findings-Filter nach jedem Save** (`_filterFindingsAfterSave`): Defensive Restbereinigung, falls Findings doch existieren — `original` per `findInHtml` (tolerant, gleiche Match-Funktion wie `sortByPosition`) nicht mehr im neuen HTML → raus. **Kein rohes `indexOf`** — sonst verwirft eine reine Markup-Änderung (z.B. `data-bid`) rund um den Textausschnitt ein noch gültiges Finding. Mit Invariante #12 üblicherweise No-Op.
14. **Konflikt-State ist session-gebunden.** `editConflict` und `conflictResolution` räumt ausschliesslich `_teardownEditSession` bzw. `_applySaveSuccess`. Der Banner in [editor-notebook.html](../public/partials/editor-notebook.html) hängt an `x-show="editConflict"` ohne `editMode`-Gate — bleibt der State stehen, zeigt der Lesemodus einen Banner, dessen Button `saveEdit()` auf dem noch im DOM hängenden (`display:none`) contenteditable auslöst. Gegenprobe dazu ist der `editMode`-Guard in `saveEdit` (Invariante-Paar).
15. **Overwrite schickt den frischen Remote-Stempel.** „Trotzdem speichern" → `expectedUpdatedAt = conflict.remoteUpdatedAt`. Der stale Editor-Stempel würde am OCC-Guard (`WHERE updated_at = expected_updated_at`) erneut 409 auslösen; die User-Entscheidung wäre wirkungslos und landete im Merge-/Draft-Fallback.
16. **Container-Selektor nur aus `shared/active-editor.js`.** `NORMAL_SELECTOR` ist SSoT; notebook-only Konsumenten (Steuerzeichen-Overlay) importieren ihn statt den String zu kopieren. Ebenso Block-Lookup: `CARET_BLOCK_SEL`/`findBlock`/`topLevelBlock` kommen aus [shared/dom-block.js](../public/js/editor/shared/dom-block.js), nicht aus einer zweiten lokalen Definition. Der Name ist bewusst familienspezifisch — `FOCUS_BLOCK_SEL`, `QUOTE_BLOCK_SEL` und `READER_BLOCK_SEL` haben anderen Inhalt und werden aus demselben `TEXT_BLOCK_TAGS`-Kern komponiert (siehe harte Regel „Editor-Blockstruktur" in [CLAUDE.md](../CLAUDE.md)).
17. **Todo-Markup nur aus [shared/todo-html.js](../public/js/editor/shared/todo-html.js).** Erzeugen über `createTodoList()`/`createTodoItem()`, Suchen über `TODO_LIST_SEL`/`TODO_ITEM_SEL`/`TODO_TEXT_SEL`/`TODO_BOX_SEL` — keine handgeschriebenen `todo`/`todo-item`/`todo-text`-Literale in JS. Konsumenten: `toolbar/slash.js` (Liste anlegen), `toolbar/keydown.js` (neue Zeile bei Enter + alle Lösch-Pfade), `toolbar/_shared.js` (`findTodoLi`), `cards/editor-toolbar-card.js` (Checkbox-Toggle), `book/page-view.js` (Leseansicht). **Why:** das Markup wurde vorher an zwei Stellen unabhängig gebaut, und `todo-html.js` behauptete dabei fälschlich, `slash.js` sei die SSoT. Zwei Selektor-Formen sind Absicht: `TODO_ITEM_SEL` ist klassenlos (`ul.todo > li`, damit Alt-/Import-Markup als Zeile zählt), `TODO_BOX_SEL` streng mit `.todo-item` (der Index ist persistenzrelevant und darf sich nicht verschieben). Die CSS-Seite kann diese Konstanten nicht lesen — dort bleiben die Klassennamen zwangsläufig gespiegelt.
18. **`BOUNDARY_WRAPPER_SEL` bleibt an `SLASH_ITEMS` gekoppelt.** Neues Wrapper-Slash-Item (Container mit Kind-Blöcken) → Selektor in [toolbar/_shared.js](../public/js/editor/notebook/toolbar/_shared.js) nachziehen, sonst verliert der Blocktyp lautlos seine Grenz-Behandlung und bäckt beim Löschen Inline-`style` ein. Gegated durch [tests/unit/notebook-toolbar.test.mjs](../tests/unit/notebook-toolbar.test.mjs) (prüft beide Richtungen: jeder Wrapper erfasst, `ul.todo` bewusst *nicht*).

## Entity-Linking (Figuren/Orte-Highlights + Kontext-Panel)

Opt-in pro Buch (`book_settings.entities_enabled`, Migration 157). Toggle in der Notebook-Toolbar + Checkbox in den BookSettings. Rückwärtsgerichtet — keine KI, nur sichtbar machen, was die Komplettanalyse in `figures` / `locations` / `figure_scenes` / `figuren[].lebensereignisse` abgelegt hat.

Code: pure Helpers + CSS-Highlight-API in [public/js/editor/notebook/entities.js](../public/js/editor/notebook/entities.js); Sub-Karte [public/js/cards/editor-entities-card.js](../public/js/cards/editor-entities-card.js); Partial [public/partials/editor-entities-panel.html](../public/partials/editor-entities-panel.html) (mounted in [editor-notebook.html](../public/partials/editor-notebook.html) via `partial-editor-entities-panel`-Placeholder); CSS [public/css/editor/notebook/entities.css](../public/css/editor/notebook/entities.css).

| Typ | Darstellung | Daten |
|---|---|---|
| Figur, Ort | Inline-Highlight via `CSS.highlights` (Register `entity-figure` / `entity-location`) | Name-Match auf `figures.name` / `locations.name` |
| Szene, Ereignis | Collapsible „Auf dieser Seite"-Panel (zwei Sektionen: page_id + chapter_id mit page_id IS NULL) | `figure_scenes`, `figuren[].lebensereignisse` |

**Match-Engine** (`buildRanges`, pure): case-insensitiv, ganze Wörter, Unicode-aware (`\p{L}\p{M}\p{N}` + Apostroph/Bindestrich). Kollisionsregel bei gleichem Namen: Figur > Ort. Overlap-Filter (längste Treffer-Region gewinnt am selben Start-Offset).

**Highlight-Priority `-10`** — bleibt unter LanguageTool-Squiggles (Default 0), damit Spellcheck sichtbar bleibt. `CSS.highlights` stapelt `text-decoration` nicht, höhere Priority überschreibt.

**Toggle-Sync:** Toolbar-Klick PUTtet `/booksettings/:id/entities-enabled` (Quick-Update-Endpoint, separat von `PUT /booksettings/:id` für die Volledit-Karte), dispatcht `book:settings:updated`; Root-Flag ist `entitiesEnabledForCurrentBook` (in [tree.js](../public/js/book/tree.js)).

**Kontext-Panel-Collapse:** Panel-Sichtbarkeit hängt am Buch-Level (`extractionEmpty()` — hat das Buch überhaupt Extraktionsdaten?), nicht an den Sektionen der aktuellen Seite — das Panel bleibt beim Seitenwechsel stehen statt zu verschwinden/reinzuploppen; Seiten ohne Einträge zeigen `entities.panel.empty` im Body. Der Header trägt Zähler-Badges pro Sektion (Figuren/Szenen/Ereignisse), damit der zugeklappte Zustand informativ ist. Auf/Zu animiert via Grid-Transition (`.figure-context-collapse`, `grid-template-rows` 0fr→1fr + Padding/Visibility, [entities.css](../public/css/editor/notebook/entities.css)) statt `x-show`-Snap; `visibility: hidden` hält zugeklappte Chips aus der Tab-Reihenfolge. Auf/Zu-State `entityPanelOpen` lebt am Root (localStorage `sw:entityPanelOpen`) und ist reine User-Wahl — der Entity-Toggle übersteuert ihn nicht.

**Pflicht-Invarianten:**
1. **Nur Notebook.** Focus-Editor und Bucheditor sind explizit out-of-scope — kein gemeinsamer Code mit `shared/`. Sub-Karte mountet sich gegen `#editor-card .page-content-view--editing`.
2. **Read-only.** Kein Markup im gespeicherten HTML, keine `data-bid`-Berührung. Highlights sind reine Range-Overlays. Save-Invariante getestet in [tests/unit/entities-save-invariant.test.mjs](../tests/unit/entities-save-invariant.test.mjs).
3. **Toggle lebt am Buch.** `book_settings.entities_enabled`, kein localStorage, kein User-Default über Bücher hinweg. Beim Buchwechsel wird der Buch-Status frisch geladen.
4. **Nur kanonischer Name.** Keine Alias-/Spitznamen-/Vorname-Nachname-Splits — wer mehr will, reichert die Extraktion an, nicht das Linking.
5. **Cleanup-Trigger:** Toggle-Off, Edit-Exit, Page-Exit, Buchwechsel → `clearHighlights()` leert beide Register. Sonst leaken Stale-Ranges auf altes DOM.
6. **Recompute debounced** (250 ms) nach Edit-Input — sonst rebuilded jeder Tastendruck die Ranges.

**Tests:** [entities-highlight.test.mjs](../tests/unit/entities-highlight.test.mjs) (`buildRanges`: Wortgrenzen, Case, Overlap, Figur/Ort-Kollision), [entities-panel-filter.test.mjs](../tests/unit/entities-panel-filter.test.mjs) (`selectScenesForView` / `selectEventsForView`), [entities-save-invariant.test.mjs](../tests/unit/entities-save-invariant.test.mjs) (kein Highlight-Markup im Save-Output).

### Quellen-Popover in der Leseansicht (dieselbe Sub-Karte, eigener Pfad)

Klick auf einen Beleg-Chip (`span.cite[data-src]`) in der **Leseansicht** öffnet dasselbe `.entity-popover` mit `kind: 'source'` — read-only: voller Verzeichniseintrag im Zitierstil des Buchs, Stellenangabe, „vgl."-Marke, Belegzahl, DOI/URL, Weg ins Quellenverzeichnis (`#book/<id>/quellen/<sourceId>`). Anzeigemodell pure in [sources/cite-popover.js](../public/js/sources/cite-popover.js), Klick-Pfad + `openSourcePopoverForChip` in der Sub-Karte, Quellenliste geteilt über [sources/source-cache.js](../public/js/sources/source-cache.js). Details: [docs/quellen.md](quellen.md).

Vier Abgrenzungen, die keine Schicht verwischen darf:
1. **Nicht am Entity-Toggle.** `entities_enabled` schaltet die Figuren-/Orte-Hervorhebung; ein Quellennachweis steht unabhängig davon im Text. Der Chip-Pfad prüft das Flag deshalb nicht.
2. **Lesen vs. Ändern.** Im **Edit-Modus** gehört der Chip-Klick dem Beleg-Picker ([cards/editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js)); der Lese-Pfad grenzt über `editMode`/`focusActive` ab. Zwei Pfade, ein Chip — nie beide gleichzeitig.
3. **`handleMarkClick` lässt Chips liegen.** Sonst klappt derselbe Klick zusätzlich ein Lektorat-Finding auf, wenn der Chip in einem Mark steht (Guard in [book/page-view.js](../public/js/book/page-view.js)).
4. **Der mousedown-Outside-Close lässt Chips durch** — räumt er den Anker vorher weg, öffnet der zweite Klick auf denselben Chip neu statt zu schliessen.

## Shared-Lib `public/js/editor/shared/`

Beide Editoren (Notebook + Focus) konsumieren ausschliesslich aus `shared/`:

| Modul | Was |
|---|---|
| [html-clean.js](../public/js/editor/shared/html-clean.js) | `stripLektoratMarks`, `normalizeEditorBlocks` (orphan-Run-Wrapping), `normalizeForCompare` (Dirty-Vergleichs-Normalform), `ROOT_BLOCK_TAGS` |
| [save-pipeline.js](../public/js/editor/shared/save-pipeline.js) | `buildSavePayload({ html, pageName, source, expectedUpdatedAt })`, `isNoChange` — pure, ohne DOM |
| [page-api.js](../public/js/editor/shared/page-api.js) | `savePage` (PUT-Wrapper über Content-Store), `isPageConflict`, `readConflictBody` (409 PAGE_CONFLICT) |
| [auto-slot.js](../public/js/editor/shared/auto-slot.js) | `ensureTrailingParagraph` + `removeAutoAddedParagraph` — Schreib-Slot bei leerer `<p>` |
| [mount-html.js](../public/js/editor/shared/mount-html.js) | `mountEditorHtml` (HTML setzen + Block-Normalisierung + Caret-Slot, meldet `repaired`), `ensureCaretSlot` — SSoT aller Pfade, die den Editor-Inhalt komplett ersetzen (startEdit, Undo/Redo-Restore, Merge-Spiegelung) |
| [dom-block.js](../public/js/editor/shared/dom-block.js) | `TEXT_BLOCK_TAGS` + `composeBlockSel` (Vokabular-SSoT aller Blockselektoren), `CARET_BLOCK_SEL`, `findBlock`, `topLevelBlock`, `caretAtBlockStart/End` — Block-Lookup im contenteditable (Toolbar-Keydown + Grenz-Handler + HR-Insert) |
| [edit-counter.js](../public/js/editor/shared/edit-counter.js) | `installEditCounter` (Re-Export; Container-Per-Instance) |
| [active-editor.js](../public/js/editor/shared/active-editor.js) | `getActiveEditorContainer`, `getActiveEditorMode` — Smart-Switch zwischen Notebook + Focus |
| [shortcuts.js](../public/js/editor/shared/shortcuts.js) | `matchInlineCommand` (Whitelist-Test), `bindInlineFormattingShortcuts` (Cmd/Ctrl+B/I/U Bindings) |

Kein Cross-Import `notebook/` ↔ `focus/`. Gemeinsames läuft strikt über `shared/`.

## Erweitern (Checkliste)

Neuer Toolbar-Button / Slash-Item / Shortcut:
1. Slash-Item: `SLASH_ITEMS` in [toolbar/_shared.js](../public/js/editor/notebook/toolbar/_shared.js) ergänzen + i18n-Key `editor.slash.<key>` in beiden Locale-Dateien.
2. Toolbar-Button: in [partials/editor-toolbar.html](../public/partials/editor-toolbar.html) — Bubble-Layer; Handler in [toolbar/bubble.js](../public/js/editor/notebook/toolbar/bubble.js) + im Focus `x-show="!focusActive"`-Guard (Bubble selbst schon gated).
3. Shortcut: neuen `_kb*`-Handler in [toolbar/keydown.js](../public/js/editor/notebook/toolbar/keydown.js) anlegen (gibt `true` bei Konsum zurück) und an der richtigen Stelle in die `_onEditKeydown`-Dispatcher-Kette hängen — wenn Focus auch reagieren soll, **vor** dem `if (app.focusActive) return;`-Branch. Sonst danach.
4. Save-Pfad anfassen: jede Mutation läuft durch `stripLektoratMarks` + `buildSavePayload`. Niemals direkt PUT — Content-Store-Facade ist Pflicht. Konflikt-Verhalten **nie** in `saveEdit`/`quickSave` duplizieren, sondern in den geteilten Helpern (`_resolveConflictBeforeSave` / `_retryAfterConflict` / `_keepAsDraft`) ändern — sonst driften Manual- und Silent-Pfad wieder auseinander.
5. Editor-Inhalt komplett ersetzen (neuer Restore-/Merge-Pfad): über `mountEditorHtml`, nie per rohem `el.innerHTML =`. Sonst fehlen Block-Normalisierung und Caret-Slot.
6. Session verlassen: über `_teardownEditSession` (mit `keepDraft`, wenn der Entwurf überleben soll), nie per Hand-Reset der Flags.
7. Tests: bei Save-/Dirty-Pfaden → [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) / [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) erweitern; bei Session-/Konflikt-Pfaden → [tests/unit/notebook-teardown.test.mjs](../tests/unit/notebook-teardown.test.mjs).

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/html-clean.test.js](../tests/unit/html-clean.test.js) | `stripLektoratMarks`, `normalizeEditorBlocks`, `normalizeForCompare` |
| [tests/unit/notebook-autosave.test.mjs](../tests/unit/notebook-autosave.test.mjs) | Autosave-Timing (Idle/Max/Reset via mock.timers), `_fireAutosave`-Gating, Online-Retry-Gating, `_flushDraftSaveNow` |
| [tests/unit/notebook-toolbar.test.mjs](../tests/unit/notebook-toolbar.test.mjs) | Slash-Transforms (`_applySlashItem` pro Blocktyp), `slashItems`-Filter, `_normalizeLinkUrl`, `_brLeftOfCaret`-Dedup |
| [tests/unit/slash-menu-position.test.mjs](../tests/unit/slash-menu-position.test.mjs) | Slash-Positionsgeometrie mit gestubbtem `visualViewport` — der Tastatur-Fall (Band schrumpft/verschiebt sich), Flip, Höhen-Deckel, Horizontal-Clamp, Schliessen ausserhalb des Bandes. Die Tastatur lässt sich in Chromium nicht öffnen, darum hier statt im E2E |
| [tests/e2e-app/notebook-slash-position.spec.js](../tests/e2e-app/notebook-slash-position.spec.js) | Slash-Position in der **echten** App (Mobile- + Desktop-Viewport): vollständig im Viewport, klebt am Trigger-Block, Flip an der oberen Kante, kein Abheben bei kurzer Trefferliste. Braucht echtes Shell-CSS, weil die Menühöhe erst daraus entsteht |
| [tests/e2e-app/notebook-todo-delete.spec.js](../tests/e2e-app/notebook-todo-delete.spec.js) | Backspace/Delete in `ul.todo` in der **echten** App: kein `li.todo-item` ohne Checkbox, ein Druck = ein Schritt, Liste-Verlassen, `checked`-Erhalt beim Merge, Listengrenze ohne Inline-`style`. Braucht einen echten Browser — der zu ersetzende contenteditable-Default existiert nur dort, in linkedom wäre jeder Fall trivial grün |
| [tests/unit/todo-html.test.mjs](../tests/unit/todo-html.test.mjs) | `setTodoCheckedAt`/`todoBoxIndex`: `checked` als Attribut (überlebt Serialisierung), n-ter Kasten trifft nur sich selbst, Durchzählen über mehrere Listen, Checkboxen ausserhalb `ul.todo` zählen nicht mit, Index ohne Treffer → `null` |
| [tests/e2e-app/notebook-todo-readmode.spec.js](../tests/e2e-app/notebook-todo-readmode.spec.js) | Haken in der **Leseansicht** in der echten App: persistiert reload-fest, zweiter Klick nimmt ihn zurück (setzt voraus, dass `updated_at` mitgezogen wird), trifft nur den angeklickten Kasten. Braucht die gebootete App — der native Klick aufs `<input>` im x-html-Container plus echter Save-Pfad existiert nur dort |
| [tests/e2e-app/notebook-block-boundaries.spec.js](../tests/e2e-app/notebook-block-boundaries.spec.js) | Löschen an den Grenzen von `figure`/`figcaption`, `blockquote`, `div.poem`, `pre`, `ul`/`ol` (22-Fall-Matrix, beide Tasten × beide Richtungen): nie ein Inline-`style`-Attribut, nie ein `figure` ohne `img`, Wrapper-Verlassen, Default bleibt bei Merges innerhalb. Gleiche Begründung für die Schicht wie bei der Checkbox-Spec |
| [tests/unit/notebook-restore.test.mjs](../tests/unit/notebook-restore.test.mjs) | Reload-Wiederaufnahme (`_tryRestoreNotebook`): Draft-Gating, richtige Seite, Snapshot-Einmal-Konsum |
| [tests/unit/notebook-teardown.test.mjs](../tests/unit/notebook-teardown.test.mjs) | Session-Abbau: Lock-/Presence-/Counter-/Overlay-Teardown + Reihenfolge, `keepDraft`-Semantik, `resetPage`-Delegation, Konflikt-State-Reset, `editMode`-Guard in `saveEdit`, Overwrite-Stempel, silent-Pfad ohne Modal, Autosave-Timer-Reset, `editSaving`-vor-`await` |
| [tests/unit/notebook-mount-html.test.mjs](../tests/unit/notebook-mount-html.test.mjs) | `mountEditorHtml` (Caret-Slot bei leerem `<p>`/trailing `<hr>`, `repaired`-Flag, Idempotenz) + Layout-Prefs inkl. Zoom-Clamping |
| [tests/unit/stale-write.test.mjs](../tests/unit/stale-write.test.mjs) | Pre-Save-Conflict-Check (`fresh: true`), 409 PAGE_CONFLICT-Handling |
| [tests/unit/page-stats-normalization.test.mjs](../tests/unit/page-stats-normalization.test.mjs) | `_syncPageStatsAfterSave` Frontend/Server-Parität |
| [tests/e2e/lektorat.spec.js](../tests/e2e/lektorat.spec.js) | Edit-Mode-Flow inkl. Findings-Apply, Save-Source `main` |
| [tests/e2e/clean-content.spec.js](../tests/e2e/clean-content.spec.js) | Paste-Pipeline (`cleanContentArtefacts`) |
