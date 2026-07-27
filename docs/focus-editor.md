# Focus-Editor

Vollbild-Schreibmodus **für eine Seite** mit Absatz-/Satz-Spotlight, Typewriter-Scroll und Live-Word-/Char-Counter. Einer von drei unabhängigen Editoren der App; die anderen beiden sind der [Notebook-Editor](notebook-editor.md) (klassischer Einzelseiten-Edit-Modus, auf dem der Focus-Editor als Vollbild-Aufsatz läuft) und der [Bucheditor](book-editor.md) (eigenständige Karte mit Manuskript-Stream über das ganze Buch). Bei Änderungswünschen muss der User immer nennen, welcher Editor gemeint ist (Harte Regel in [CLAUDE.md](../CLAUDE.md)).

Heilige Kuh: jede Änderung an diesem Modul muss dieses Dokument konsultieren. Drift in den Invarianten = sichtbares „Flattern", verlorene Edits oder Phantom-Revisionen im Storage-Backend.

**Stale-Write-Konflikt:** Der Focus-Editor läuft auf der Notebook-Save-Pipeline (`saveEdit`/`quickSave` mit `source: 'focus'`) und erbt damit den **Block-Level-Merge** — kollisionsfreie Block-Edits zweier Geräte mergen still, echte Block-Kollisionen öffnen das Auflösungs-Modal. Details + Invarianten in [notebook-editor.md → Block-Level-Merge](notebook-editor.md#block-level-merge-bei-stale-write).

Code: [public/js/editor/focus.js](../public/js/editor/focus.js) (Facade) → [public/js/editor/focus/](../public/js/editor/focus/) (Submodule), [public/js/cards/editor-focus-card.js](../public/js/cards/editor-focus-card.js) (Alpine.data-Sub), [public/css/editor/focus/focus-mode.css](../public/css/editor/focus/focus-mode.css). Tests: [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js), [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs), [tests/unit/focus-granularity.test.mjs](../tests/unit/focus-granularity.test.mjs).

Trigger: Hotkey `Cmd/Ctrl+Shift+E` (überall im Editor; aus Lesemodus → startet Edit + Fokus in einem). Body-Listener in [public/index.html](../public/index.html#L227) routet via `handleFocusHotkey`.

## Root vs. Sub: Trampoline-Pattern

Root hält **sichtbare** Flags + Anzeigewerte, Sub hält **Lifecycle-State**. Trennung, weil Templates/CSS/andere Subs nur die Flag brauchen — Listener-Setup, Generation-Counter und RAF gehören zur Card-Lifecycle.

| Wohnt im Root (`focusState` + `shellState`) | Wohnt in Sub (`editorFocusCard`) |
|---|---|
| `focusActive` (bool, Template-Guard, body-class) | `_focusState` (`idle`/`entering`/`active`/`exiting`) |
| `focusGranularity` (`paragraph`/`sentence`/`window-3`/`typewriter-only`) | `_focusGen` (Re-Entry-Guard für async Nachzügler) |
| `focusCountWords` / `focusCountChars` (Live-Anzeige) | `_focusListeners` (ctx mit AbortController, Timer, Pointer-Flag, IO/MO, expectedScroll, …) |
| `focusCountWordsDelta` / `focusCountCharsDelta` (Tages-Delta) | `_focusVisibleBlocks` (IO-getrackte Block-Refs) |
|  | `_focusRaf` (cancellable RAF-Handle für Recenter) |
|  | `_focusAutoAddedP` (Auto-`<p>`-Slot — Referenz auf Exit-Cleanup) |
|  | `_restoreSnapshot` (Reload-Wiederaufnahme) |

Root-Methoden ([editor/focus/trampoline.js](../public/js/editor/focus/trampoline.js)) sind **reine Event-Dispatcher** — sie feuern `editor:focus:{toggle|enter|exit|start-edit}` aufs Window. Sub abonniert in `init()` mit `AbortController`-Signal. Root-Spread (`focusMethods`) bleibt minimal, damit Hot-Reload/HMR keine doppelten Listener anhängt.

## State-Machine

```
idle ──enterFocusMode──▶ entering ──$nextTick──▶ active ──exitFocusMode──▶ exiting ──await save──▶ idle
                            │                       │                          │
                            └───install fails───▶ idle                         └── Re-Entry blockt (Generation-Check)
```

- **Re-Entry-Guard:** Jeder `enter`/`exit`-Aufruf erhöht `_focusGen`. Async-Nachzügler (RAFs, `await quickSave`) prüfen `gen !== this._focusGen` → no-op. Schneller exit→enter→exit-Cycle hinterlässt keinen Geisterstand.
- **Doppel-Trigger im `entering`/`exiting`:** `toggleFocusMode` ignoriert beide Übergänge — kein Double-Enter, kein Halt-im-Halbgang.
- **`enterFocusMode` Pflicht-Sequenz** ([card.js:50-119](../public/js/editor/focus/card.js#L50-L119)): `_flushDraftSaveNow` → `focusActive=true` + body-class → `$nextTick` → `_focusInstall` → `_focusUpdateActive(true)` → `writeFocusSnapshot`. Fehler im Install → `_focusTeardown` + Snapshot-clear + Flag zurück, State zurück auf `idle`.
- **`exitFocusMode` Pflicht-Sequenz** ([card.js:398-490](../public/js/editor/focus/card.js#L398-L490)): Auto-`<p>` abräumen → `await quickSave` (wenn dirty) → `_focusTeardown` → Snapshot-clear → body-classes weg → `--focus-vh*` zurück → restliche `.focus-paragraph-*`-Klassen + Custom-Highlight aufräumen → wenn clean: `editMode=false` + Autosave/Counter/OnlineRetry abreissen → `_syncPageStatsAfterSave` + `updatePageView` (idempotent zu Save-Pfad). Reihenfolge ist Pflicht: Cleanup VOR `editMode=false`, sonst rufen Autosave-Teardown auf bereits genullten Refs.

## Submodul-Karte

Facade re-exportiert; externer Import läuft über [editor/focus.js](../public/js/editor/focus.js). Submodule sind interne Aufteilung.

| Modul | Verantwortlich für |
|---|---|
| [shared/editor-host.js](../public/js/editor/shared/editor-host.js) | **Host-Facade** `editorHost()`/`setEditorHost()` — einziger Zugang zur Root (liegt unter `shared/`, weil auch `shared/active-editor.js` sie nutzt). `focus/`-Code greift NICHT direkt auf `window.__app` zu. Default = `window.__app` (SPA, reaktiver Proxy); fremde Schalen (nativer Mac-Focus-Writer in WKWebView, ohne Alpine) injizieren via `setEditorHost()` einen eigenen Host mit demselben Vertrag (Felder/Methoden im File-Kopf dokumentiert). |
| [constants.js](../public/js/editor/focus/constants.js) | `BLOCK_TAGS` (P/H1-H6/BLOCKQUOTE/LI/PRE/TD/TH/FIGURE/FIGCAPTION — **DIV bewusst nicht drin**), Timing (`POINTER_GRACE_MS=300`, `VV_DEBOUNCE_MS=100`, `CURSOR_HIDE_MS=2000`, `COUNTER_DEBOUNCE_MS=220`), Feature-Detects (`HAS_IO`/`HAS_MO`), `prefersReducedMotion`, `reportError`-Sink |
| [trampoline.js](../public/js/editor/focus/trampoline.js) | Root-Methoden: 4 Event-Dispatcher + `handleFocusHotkey` (Body-Listener-Routing je nach `focusActive`/`editMode`) |
| [card.js](../public/js/editor/focus/card.js) | Sub-Methoden: `toggleFocusMode`/`enterFocusMode`/`startFocusEdit`/`exitFocusMode`/`_focusInstall`/`_focusTeardown`/`_focusUpdateActive`. **Listener-Setup + RAF-Recenter-Pipeline** |
| [dom-blocks.js](../public/js/editor/focus/dom-blocks.js) | `findBlockFromNode` (outermost-Ancestor!), `findBlockAtViewportCenter`/`pickCenterBlock`, `setActiveBlock`/`setNearBlocks`/`clearAllFocusMarks` (Defense gegen Chromium-Split-Bug + `class=""`-Residual), `isEmptyParagraph`/`jumpToTrailingParagraph`/`getScrollContainer` |
| [sentence.js](../public/js/editor/focus/sentence.js) | `findSentenceRanges` (Intl.Segmenter mit Regex-Fallback), `findSentenceAtCaret`, `applySentenceHighlight` (CSS Custom Highlight API — kein DOM-Diff!) |
| [typewriter.js](../public/js/editor/focus/typewriter.js) | `dynamicTypewriterThreshold` (line-height/2 als Untergrenze), `getCaretRect`, `visibleViewportRect` (Anker-Bezug), `computeTypewriterDelta` (pure), `caretWithinViewport` (pure, Sichtbarkeits-Gate für den IME-Notnagel), `typewriterScroll` (mit `expectedScroll`-Counter, `prefers-reduced-motion`-Pfad + Fallback auf einen scrollbaren Vorfahr, wenn die Box selbst nicht scrollen kann) |
| [standalone.js](../public/js/editor/focus/standalone.js) | **Bootstrap für fremde Schalen** (Mac-Focus-Writer in WKWebView): `mountStandaloneFocus({ mount, bridge })` — baut das contenteditable-Scaffold, injiziert einen bridge-gestützten Host (`setEditorHost`), lädt/speichert über die `bridge` (loadPage/savePage), renutzt die Engine via `focusCardMethods`. Escape standalone = speichern (kein Lese-Modus). NICHT Teil des SPA-Pfads. |
| [storage.js](../public/js/editor/focus/storage.js) | sessionStorage-Snapshot (`focus.snapshot`, TTL 1h) für Reload-Wiederaufnahme. **Counter-Logik liegt nicht hier**, sondern in [shared/edit-counter.js](../public/js/editor/shared/edit-counter.js) (`installEditCounter`, localStorage-Tagesbaseline, **läuft im Edit-Mode, nicht erst im Fokus**) |

## Granularitäten

`focusGranularity` lebt im Root (`shellState`) und ist **live umschaltbar** — Sub-`init()` setzt `$watch` ([editor-focus-card.js:41-48](../public/js/cards/editor-focus-card.js#L41-L48)) und tauscht body-Class + Re-Render ohne exit/enter.

| Wert | Was passiert |
|---|---|
| `paragraph` (default) | Aktiver Block hell, alle anderen via `:not(.focus-paragraph-active)` opacity 0.5 |
| `sentence` | Plus: aktiver Satz im aktiven Block hell, restliche Sätze via `::highlight(focus-sentence-dim)` (CSS Custom Highlight, kein DOM-Diff). **Teurer Pfad** — Range-Iteration via TreeWalker; nur bei Block/Granularity-Wechsel oder bei `sentence`-Live-Update |
| `window-3` | Aktiver + direkter Vorgänger + direkter Nachfolger (`.focus-paragraph-near`) hell |
| `typewriter-only` | Keine Block-Markierung, alle Blöcke hell. Nur Caret-Scroll bleibt |

`_focusUpdateActive` ([card.js:492-586](../public/js/editor/focus/card.js#L492-L586)) hat einen **Short-Circuit-Cache** (`ctx._lastBlock` / `ctx._lastGranularity`): bleibt der aktive Block beim Tippen gleich, werden `setActiveBlock`/`setNearBlocks`/Sentence-Highlight übersprungen.

**Absatz-/Zeilen-Split synchron im `input`-Handler** ([card.js](../public/js/editor/focus/card.js) `onInput`): bei `inputType insertParagraph/insertLineBreak` wird der neue aktive Block **synchron im selben Task** (vor dem Paint) gesetzt + `ctx._lastBlock` darauf gecacht — NICHT erst im RAF einen Frame später. **Why:** Chromium kopiert beim Split die `.focus-paragraph-active`-Klasse auf beide `<p>`. Würde der RAF erst im nächsten Frame aufräumen, leuchteten kurz zwei Absätze. Das frühere Clearen im `beforeinput` (`setActiveBlock(null)`) vermied zwar den Doppelflash, erzeugte aber einen **Dim-Flash**: für einen Frame ist nichts aktiv → der ganze sichtbare Text snappt auf `opacity 0.35` und zurück (sichtbares „Ruckeln" vor dem ersten Buchstaben, weil die Dim-Regel bewusst ohne Transition snappt). Da `input` synchron vor dem Paint feuert, rendert die synchrone Markierung keinen Zwischenzustand — kein `beforeinput`-Listener mehr nötig.

## Recenter-Pipeline

### Zielverhalten (Typewriter)

**Die Schreibzeile ruht auf dem Anker.** Schreibzeile = die visuelle Zeile, in der der Caret sitzt. Anker = `typewriterAnchor` × Höhe des **sichtbaren** Bereichs (Default `0.5` → Bildschirmmitte). Die Position ist über die ganze Seite konstant — erster Absatz, Mitte, letzter Absatz gleich. Beim Schreiben wandert der Text unter der Zeile nach oben, nicht die Zeile im Bild.

- **Anker-Knopf `typewriterAnchor`**: Root-`shellState` ([app-state.js](../public/js/app/app-state.js), Default `0.5`) und Teil des editor-host-Vertrags ([shared/editor-host.js](../public/js/editor/shared/editor-host.js)) — eine fremde Schale (Mac-Client via [standalone.js](../public/js/editor/focus/standalone.js)) setzt ihn beim Bootstrap. Kein SPA-UI-Setting. `0` = oberer Rand, `0.5` = Mitte, `0.33` = oberes Drittel; ungültig/fehlend → `0.5` (`normAnchorRatio` in [typewriter.js](../public/js/editor/focus/typewriter.js)).
- **Seitenanfang und Seitenende sind keine Ausnahme**: die Puffer-Formeln (Invariante 9) sind so gesetzt, dass auch die erste und die letzte Zeile den Anker erreichen. Klemmt es dort, ist der Puffer falsch — nicht der Typewriter.

**Abschliessende Liste der Fälle, in denen die Zeile bewusst nicht auf den Anker gezogen wird** — alles andere ist ein Bug:

1. **Unter der Schwelle** `max(16px, line-height × 0.5)`: Tippen innerhalb derselben Zeile scrollt nicht (Jitter-Filter, Details unten).
2. **Klick-Schonfrist** `POINTER_GRACE_MS`: der Caret sitzt, wo der User hingeklickt hat.
3. **Aktive Textmarkierung**: kein Recenter, solange eine Auswahl offen ist.
4. **Lese-Scroll** (`preferCenter`): Spotlight folgt dem Viewport-Center, Typewriter-Scroll läuft gar nicht.
5. **Kein Caret-Rect ermittelbar**: Scroll bleibt aus statt auf die Block-Mitte auszuweichen (Invariante 14).
6. **Laufende IME-Composition**, solange die Caret-Zeile sichtbar bleibt (`imeSafe`, Details unten).

### Ablauf

Trigger feuern `_focusUpdateActive(scroll: boolean)`. Recenter passiert in einem **gecancelten RAF** — Burst-Inputs (Paste, Auto-Korrektur, IME) kollabieren auf einen Frame.

```
selectionchange / input / scroll / focus → _focusUpdateActive(…)
                                              │
                                       cancelAnimationFrame(_focusRaf)
                                              │
                                              ▼
                              ┌──── RAF-Body (try/catch) ────┐
                              │ 1. Generation-Check          │
                              │ 2. Block aus Caret-Anchor    │
                              │    (Fallback: Viewport-Center│
                              │    via IO-Set / QSA;         │
                              │    preferCenter → direkt     │
                              │    Viewport-Center)          │
                              │ 3. setActiveBlock + nearBlocks│
                              │    (Cache-Short-Circuit)     │
                              │ 4. Sentence-Highlight        │
                              │ 5. Typewriter-Scroll wenn:   │
                              │    scroll && block && !sel   │
                              └──────────────────────────────┘
```

- **Hervorhebung übersteht transiente `block === null`-Ticks** — zwei Schutzschichten gegen das „Hervorhebung verschwindet kurz"-Phänomen (Caret sitzt nach Merge/Voll-Löschen kurz direkt auf dem Container → `findBlockFromNode` = null):
  1. **QSA-Fallback in [findBlockAtViewportCenter](../public/js/editor/focus/dom-blocks.js)**: liefert der bevorzugte IO-Pool (`visibleBlocks`) `null` (alle getrackten Blöcke transient Höhe 0 / abgehängt), wird auf den vollständigen `querySelectorAll`-Scan zurückgefallen, statt aufzugeben.
  2. **`_lastBlock`-Beibehaltung in [_focusUpdateActive](../public/js/editor/focus/card.js#L492)**: ist `block` trotz Fallback `null` (paragraph/window-3/sentence), wird der vorige aktive Block beibehalten, solange er noch im Container hängt (`container.contains`). Der nächste echte Tick reconciliiert. **Greift nicht bei `typewriter-only`** (dort ist nie ein Block aktiv) und **nicht nach Blur** — `onBlur` setzt `ctx._lastBlock=null` und clear't bewusst, der absichtliche Blur-Clear bleibt also erhalten.
- **Manueller Scroll verschiebt das Spotlight** ([card.js](../public/js/editor/focus/card.js) `onScroll` → `_focusUpdateActive(false, { preferCenter: true })`): beim Lese-/Scroll-Durchlauf bestimmt nicht der (unsichtbare) Caret den aktiven Block, sondern der Absatz in der Viewport-Mitte. Die Granularitäts-Regel (paragraph/sentence/window-3) greift unverändert auf diesen Block. `preferCenter` gilt **ausschliesslich** für den User-Scroll-Pfad — `applyViewport` (Mobile-Tastatur/Resize) bleibt caret-basiert (ohne `preferCenter`), sonst springt das Spotlight bei jedem KB-Frame. Programmatischer Typewriter-Scroll wird vom `expectedScroll`-Counter verschluckt und löst kein Center-Pick aus.
- **Aktive Textmarkierung blockt Recenter** — User zieht Auswahl auf, Viewport darf nicht springen.
- **Klick markiert `pointerIntent`** ([card.js](../public/js/editor/focus/card.js) `markPointer`) — folgender `selectionchange` recentert NICHT (Klick ist absichtliche Positionsänderung). Flag fällt automatisch zurück (Klick in leeren Margin erzeugt keinen selectionchange): nach `POINTER_GRACE_MS=300` ms, bei `pointerType === 'touch'` nach `POINTER_GRACE_TOUCH_MS=700` ms.
- **Typewriter-Schwelle dynamisch** ([typewriter.js:18-25](../public/js/editor/focus/typewriter.js#L18-L25)): `max(16, line-height * 0.5)`. Statisches 16 px scrollte schon bei subpixel-Jitter — halbe Zeilenhöhe ist die natürliche „echte Zeilenwechsel"-Grenze. Die Schwelle ist der **einzige** Jitter-Filter: die Ruheposition der Schreibzeile bleibt exakt der Anker.
- **Anker-Bezug ist der sichtbare Bildschirm, nicht die Scroll-Box** (`visibleViewportRect()` → `computeTypewriterDelta(…, viewportRect)`): die Box `.focus-editor__content` beginnt unter der Focus-Topbar und läuft mobil hinter der Tastatur weiter, ihre Mitte liegt also unter der Bildschirmmitte. Bezug ist `visualViewport` (`offsetTop` + `height`, Android Chrome schiebt den fixed Container nach oben), Fallback `window.innerHeight`. Der Anker wird in die Box geclampt, sonst wäre er für den Caret unerreichbar und der Scroll liefe ins Leere.
- **`expectedScroll`-Counter** ([typewriter.js](../public/js/editor/focus/typewriter.js)): programmatischer Scroll inkrementiert; `onScroll` dekrementiert und feuert kein Recenter. Counter > Zeitfenster, weil ScrollEnd nicht zuverlässig in allen Engines. **Inkrementiert wird erst nach dem Scroll und nur, wenn `scrollTop` sich tatsächlich verschoben hat** (`behavior: 'auto'` schreibt synchron, die Strecke ist sofort messbar): ein am Anschlag geklemmter `scrollBy` feuert kein `scroll`-Event, ein Increment dafür bliebe für immer stehen und liesse `onScroll` danach jeden echten User-Scroll verschlucken.
- **`getCaretRect`-Dreistufenpfad** ([typewriter.js](../public/js/editor/focus/typewriter.js)):
  1. `range.getClientRects()[0]` — Standardfall, deckt 95 %.
  2. `range.getBoundingClientRect()` — Fallback bei leerer Rect-Liste.
  3. **Probe-Range-Expansion**: Range um 1 Position erweitern (`setEnd(off+1)`, sonst `setStart(off-1)`), Rect lesen, Probe verwerfen. Fängt den collapsed-Range-Bug am Soft-Wrap-Bruch und direkt nach `<br>`, wo Browser sonst Höhe 0 / leere Rects liefern. Non-collapsed Ranges liefern deterministisch das Rect der angrenzenden Glyphe → korrekte visuelle Zeile.
- **Kein Block-BBox-Fallback im Recenter** ([card.js:558-578](../public/js/editor/focus/card.js#L558-L578)): Wenn `getCaretRect` `null` liefert, bleibt der Scroll aus — kein Rückfall auf `block.getBoundingClientRect()`. Begründung: bei langen Absätzen ohne neue Absatzmarken (User schreibt Riesensatz mit Soft-Wraps und shift-enter-Brüchen) bewegt sich die Block-Mitte nicht mit dem Caret. Block-BBox als Ziel hätte den Typewriter stehenbleiben lassen, obwohl der Cursor visuell mehrere Zeilen tiefer sitzt. Wenn das Caret-Rect wirklich nicht ermittelbar ist (leerer Absatz ohne Text-Kind, kein Fokus), liefert der nächste echte Input bereits valides Rect.

## Lifecycle-Sequenzen (Pflichtreihenfolge)

### Enter
1. Guards: nur aus `idle` heraus, nur wenn `showEditorCard && editMode`.
2. `_flushDraftSaveNow` — offene Debounce-Drafts ins Backend, damit kein getippter Inhalt verloren geht, falls späterer Cancel im Fokus.
3. `_focusGen++` → `focusActive=true`, body-class `focus-mode` setzen; die `focus-mode--<granularity>`-Klasse sitzt auf `.focus-editor` (nicht am Body — der Dim-Selektor scoped via `.focus-editor.is-active:not(.focus-mode--typewriter-only)`).
4. `$nextTick(_focusInstall)`: erst nach Alpine-Render → `--editing`-Container existiert.
5. `_focusInstall`: Container holen, `AbortController` aufmachen, IO/MO setzen, alle Listener mit `{ signal }` registrieren, `applyViewport` direkt (ohne Debounce), Cursor zeigen, `--editing`-Container fokussieren, `jumpToTrailingParagraph` (legt Auto-`<p>` an oder recycelt leeren letzten Absatz).
6. `_focusState='active'` → erstes `_focusUpdateActive(true)` → `writeFocusSnapshot(pageId)`.

### Exit
1. `_focusState='exiting'`, `_focusGen++` (RAFs werden no-op).
2. Auto-`<p>`-Slot prüfen: wenn unverändert leer → entfernen. Sonst bleibt er stehen (User hat darin getippt).
3. `await quickSave` wenn `editMode && editDirty && !editSaving`. Offline/Fehler → `editDirty` bleibt true, Draft im LocalStorage, User bleibt im Edit-Modus (Banner zeigt Status, kein erzwungener Exit).
4. Race-Check: wer in der Zwischenzeit `enter` gerufen hat → abbrechen, kein Cleanup.
5. `_focusTeardown`: AbortController killt alle Listener auf einen Schlag, IO/MO disconnect, Timer clear, RAF cancel.
6. `clearFocusSnapshot`, body-classes weg, `--focus-vh*` löschen, Restklassen + `::highlight(focus-sentence-dim)` defensiv aufräumen.
7. Wenn `editMode && !editDirty` (sauberer Save): `_stopAutosave` → `_uninstallOnlineRetry` → `_editCounterCtx.teardown` → `editMode=false` + `editSaving=false` + `saveOffline=false`. **Reihenfolge Pflicht.** Synonym-Menü, Synonym-Picker, Figur-Lookup zu.
8. Idempotent: `_syncPageStatsAfterSave` + `updatePageView` — garantiert dass Stats-Badges + View-HTML den aktuellen `originalHtml` reflektieren.
9. `_focusState='idle'`.

## Auto-`<p>`-Slot

Beim Enter springt der Caret an Buchende. `jumpToTrailingParagraph` ([dom-blocks.js:23-56](../public/js/editor/focus/dom-blocks.js#L23-L56)):
- Letzter Block ist leerer `<p>` → recyceln, `added = null`.
- Sonst neuen `<p><br></p>` anhängen, `added = p`.

**Pflicht-Eigenschaften:**
- NICHT als dirty markieren (kein `_markEditDirty`). Der Slot ist nur Schreibanker; tippt der User, greift `@input`-Handler regulär.
- Exit räumt den Slot ab, falls noch leer — sonst Phantom-Revision (Backend-agnostisch via Content-Store) bei jedem Open-Close-Cycle.
- Nur `<p>` recyceln, keine leeren Headings/Listen — sonst zerstört Recycling User-Struktur.

## Snapshot-Wiederaufnahme

`writeFocusSnapshot(pageId)` schreibt `{ pageId, ts }` in sessionStorage. Überlebt F5 + OIDC-Roundtrip, nicht Tab-Close. TTL 1 h. Sub-`init` ([editor-focus-card.js:54-62](../public/js/cards/editor-focus-card.js#L54-L62)) liest und wartet via `$watch` auf `currentPage.id` + `renderedPageHtml` + `showEditorCard` — wenn alle drei matchen → `startFocusEdit`. Snapshot wird **vor** dem Restore-Versuch konsumiert (`_restoreSnapshot=null` + `clearFocusSnapshot`), sonst Loop bei kaputter Seite.

## Counter (Wörter/Zeichen + Tagesdelta)

`installEditCounter` ([shared/edit-counter.js:63-102](../public/js/editor/shared/edit-counter.js#L63-L102)) wird **im Edit-Mode** gestartet, nicht erst beim Focus-Enter. Damit zählen Edits ausserhalb des Fokusmodus zum „heute"-Delta.

- `compute()` liest `container.textContent`, debounced (`COUNTER_DEBOUNCE_MS=220`).
- Tagesbaseline pro `pageId` in localStorage. Erste Messung des Tages = Baseline; spätere Messungen liefern Delta. Stale Einträge (andere Tage) werden lazy bei jedem Read entfernt.
- `fmtSigned`: `+12` / `−5` (Unicode-Minus für Tabulator-Look) / `±0`.
- Idempotent: zweiter Install-Aufruf liefert dieselbe Teardown-Funktion ohne Listener-Doppelung. Teardown nullt `_editCounterCtx`.

## IME / Mobile-Tastatur / Resize

- **IME-Composition**: `compositionstart` setzt `ctx.composing=true`, `onSelection`/`onInput` laufen ab da im **`imeSafe`-Modus** (`_focusUpdateActive(scroll, { imeSafe: true })`): das DOM wird **nicht** angefasst (keine Block-Klassen, kein Satz-Highlight, `_lastBlock`/`_lastGranularity` bleiben stehen), damit weder das Kandidatenfenster wandert noch composition-empfindliche IMEs abbrechen. Der Typewriter bleibt als **Notnagel** scharf, greift aber nur, wenn die Caret-Zeile den sichtbaren Bereich verlassen hat (`caretWithinViewport(rect, visibleViewportRect(), threshold * 2)` — ein Zeilenumbruch bleibt also unbeantwortet). **Why:** ein harter Block wäre nur für CJK richtig — Android-Soft-Keyboards halten auch für gewöhnliche lateinische Wörter eine Composition offen, teils über ganze Sätze; die Schreibzeile liefe dort unter die Tastatur weg. `compositionend` triggert das volle Reconcile inkl. Recenter (durch das stehengelassene `_lastBlock` schlägt es als Blockwechsel durch).
- **visualViewport** (Mobile-Tastatur): `applyViewport` setzt `--focus-vh` (Höhe) und `--focus-vh-top` (offsetTop — Android Chrome schiebt fixed-Container nach oben). Debounced via `VV_DEBOUNCE_MS=100`. Ohne Höhenwechsel wird nur der aktive Block re-validiert (`_focusUpdateActive(false)`) — ein Recenter pro Viewport-Tick liesse den Editor bei jedem KB-Frame, URL-Leisten-Scroll und Pinch-Zoom flattern. **Ändert sich die Höhe** (Tastatur auf/zu, Rotation, echtes Resize) und sitzt der Fokus im Editor (`document.activeElement`), wird **einmal** recentert: der Anker liegt in der Mitte des sichtbaren Bereichs und springt mit. Sass der Caret exakt auf dem Anker, kompensiert die Puffer-Formel (Invariante 9) das ohnehin; ist er vorher weggedriftet (Lese-Scroll, lange Composition), stünde er sonst hinter der Tastatur.
- **Touch** (`markPointer`): Fingertipp bekommt `POINTER_GRACE_TOUCH_MS=700` statt `POINTER_GRACE_MS=300`. Tippen ist mobil die einzige Art, den Caret zu setzen, und das `selectionchange` kommt dort spät (Soft-Keyboard-Animation, langsame Geräte) — mit der Maus-Karenz wäre das Flag abgelaufen und der Recenter risse die getippte Stelle weg.
- **Resize/Orientation/DevTools-Sidebar**: `window.resize` deckt den Desktop-Fall ab, wenn visualViewport-Event nicht feuert. Beide Pfade abonniert.

## Pflicht-Invarianten (zusätzlich zu CLAUDE.md)

0. **`focus/` + `shared/active-editor.js` greifen nie direkt auf `window.__app` zu.** Root-Zugriff ausschliesslich über `editorHost()` aus [shared/editor-host.js](../public/js/editor/shared/editor-host.js) — Voraussetzung dafür, dass der Editor in einer fremden Schale (nativer Mac-Focus-Writer in WKWebView, ohne Alpine-Root) per `setEditorHost()` lauffähig ist. SPA-Glue ([cards/editor-focus-card.js](../public/js/cards/editor-focus-card.js), `$watch`) darf `window.__app` nutzen — das ist die SPA-Adaption, kein Bestandteil des bündelbaren Editor-Kerns.
1. **`focusActive → editMode`** (CLAUDE.md schon). Sub-`enterFocusMode` bricht ab, wenn `!app.editMode`. `cancelEdit` ruft `exitFocusMode` zuerst.
2. **Listener nur via `AbortController`-Signal.** Jeder `addEventListener` im `_focusInstall` bekommt `{ signal }`. Kein manueller `removeEventListener`. Teardown ist ein `abort()`.
3. **IO observe nur addedNodes, unobserve removedNodes.** Vollscan bei jeder Mutation = O(n²) bei grossen Pastes. Removed-Nodes müssen aus `visibleBlocks` raus, sonst IO-Refs auf abgehängten Knoten.
4. **`setActiveBlock` querySelectorAll, nicht querySelector.** Chromium kopiert beim Paragraph-Split die `.focus-paragraph-active`-Klasse auf beide `<p>` — Vollscan räumt die Leiche ab.
5. **`classList.remove` + `removeAttribute('class')` wenn leer.** Sonst bleibt `class=""` stehen → unnötige Revision beim nächsten Save (Diff zur ursprünglich attributlosen Fassung).
6. **`findBlockFromNode` liefert outermost-Ancestor.** Innermost-Match würde bei `<blockquote><p>…</p></blockquote>` nur den inneren `<p>` aktiv markieren — der äussere Wrapper bleibt opacity-gedimmt und multipliziert auf das Kind.
7. **DIV NICHT in `BLOCK_TAGS`.** Chromium Default-Paragraph-Separator soll `<p>` erzeugen; DIV-Aufnahme würde Garantie aushebeln und Margin-/Spacing-Annahmen kippen.
8. **`_focusUpdateActive` RAF in try/catch.** Ein DOM-Edge-Case (Shadow-Root-Range, obskurer Range-Fehler) darf den Editor nicht stillstellen. Fehler → `reportError('updateActive', err)`, nächster Tick versucht neu.
9. **`expectedScroll` ist Counter, nicht Zeitfenster** — und zählt nur echte Bewegung. Mehrere prog-Scrolls in Folge müssen alle vom `onScroll` verschluckt werden; ein Scroll ohne `scrollTop`-Änderung (Anschlag, Sub-Pixel-Rundung) darf dagegen **nicht** zählen, sonst leakt der Counter und der Editor ignoriert danach dauerhaft User-Scrolls. Gegated: [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) (`typewriterScroll`-Block).
    - Folge für das Layout: der Tail-Puffer unter dem Text muss gross genug bleiben, dass auch die **letzte** Zeile die Schreiblinie (Anker 0.5 → Mitte des sichtbaren Bereichs) erreicht. Deshalb ist er als Formel gesetzt statt als Magic-Number: `padding-bottom: calc(100vh - var(--focus-vh, 100vh) * 0.5)` auf `.focus-editor__content` — die Box reicht bis zum Layout-Ende (mobil hinter die Tastatur), die Schreiblinie liegt in der Mitte des sichtbaren Bereichs, also muss genau die Differenz scrollbar bleiben (Desktop: 50 vh; Mobile mit offener Tastatur wächst der Tail automatisch mit, kein eigener Media-Query-Wert). Ein kürzerer Tail klemmt den Typewriter am Seitenende: die letzten Absätze werden nicht mehr nachgezogen. Oben spiegelbildlich `padding-top: calc(var(--focus-vh, 100vh) * 0.5)` — negativen Scroll gibt es nicht, also muss der Kopf-Puffer die Strecke Anker − Boxoberkante hergeben, sonst klemmt der Seitenanfang leicht über der Linie. Gilt genauso für schalen-seitige Overrides (macOS-/Android-Client, die dasselbe Bundle-CSS laden). Gegated: [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js) („Letzter/Erster Absatz erreicht die Schreiblinie").
10. **Sentence-Highlight nur via `CSS.highlights`.** Keine DOM-Span-Wraps — sonst Save-Diff bei jedem Caret-Move. Browser ohne Custom-Highlight-API → Sentence-Mode degradiert lautlos auf Paragraph-Visual.
11. **`overflow-anchor: none`** auf `.focus-editor__content`. Chrome's Scroll-Anchoring kämpft sonst mit Typewriter-Scroll → sichtbares „Flattern".
12. **`x-show="!focusActive"`-Guards für Findings-Close-Button, Toolbar, Bubble.** Findings sind im Fokus ohnehin via CSS ausgeblendet; Buttons trotzdem mit `x-show` raus, damit Tab-Reihenfolge sauber bleibt.
13. **Scroll-Box ist `.focus-editor__content` — mit Rettungspfad.** Der Typewriter scrollt den Container aus `getScrollContainer()`. Fremde Schalen (macOS-/Android-Client) laden dasselbe Bundle-CSS, bringen aber eigenes Host-CSS mit; **unlayered** Host-Regeln schlagen jede Regel aus `focus-mode.css` (`@layer components`) unabhängig von Spezifität, der Editor kann sich per CSS also nicht wehren. Kann der Container grundsätzlich nicht scrollen (`scrollHeight <= clientHeight`), weicht `typewriterScroll` auf den nächsten scrollbaren Vorfahr bzw. das Dokument aus — sonst wäre der Typewriter dort ein stiller No-op. **Am regulären Scroll-Anschlag greift der Pfad nicht** (Box ist scrollbar, steht nur am Ende), sonst zöge er die Seite unter dem Editor weg. Fallback-Scrolls zählen **nicht** in `expectedScroll` (das `scroll`-Event feuert am Fallback-Ziel, `onScroll` hängt am Container). Gegated: [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) (`typewriterScroll`-Block).
14. **Typewriter folgt ausschliesslich dem Caret-Rect.** Kein Block-BBox-Fallback im Recenter. `getCaretRect` ist die einzige Ziel-Rect-Quelle; liefert sie `null`, bleibt der Scroll aus. Block-Mitte als Ersatz täuscht Stabilität vor und blockiert Typewriter in langen Absätzen mit Soft-Wraps / `<br>`-Brüchen — `getCaretRect` deckt diese Edge-Cases via Probe-Range-Expansion ab.

## Tests

| Datei | Deckt ab |
|---|---|
| [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) | `findBlockFromNode` outermost, `pickCenterBlock` Distanz-Logik (inkl. „alle Höhe 0 → null"), `findBlockAtViewportCenter` QSA-Fallback wenn IO-Pool nur Höhe-0-Einträge hält, `computeTypewriterDelta` Schwellen-Verhalten + Bildschirm-Anker (Topbar-Offset, `visualViewport`-`offsetTop`, Clamp in die Scroll-Box), `setActiveBlock` class=""-Cleanup, `findSentenceRanges` Intl.Segmenter + Regex-Fallback, `dailyDelta` Baseline + Prune, `getCaretRect` Probe-Range-Expansion am Soft-Wrap-Bruch |
| [tests/unit/focus-granularity.test.mjs](../tests/unit/focus-granularity.test.mjs) | Body-Class-Wechsel bei `focusGranularity`-Live-Switch, Cache-Invalidation, `dynamicTypewriterThreshold` aus computed line-height |
| [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js) | Toggle, Recenter beim Tippen, Pointer-Schonfrist (Klick recentert NICHT), Cleanup (keine Listener-Leaks nach Exit), Auto-`<p>`-Slot räumt sich ab, transienter null-Tick behält Markierung (`_lastBlock`-Schutz, Caret- **und** Scroll-/`preferCenter`-Pfad) + Blur clear't trotz Schutz |
| [tests/e2e/focus-standalone.spec.js](../tests/e2e/focus-standalone.spec.js) | **Standalone-Bootstrap** ([standalone.js](../public/js/editor/focus/standalone.js)) in fremder Schale OHNE `window.__app`/Alpine (Bridge-Stub via [standalone-harness.html](../tests/fixtures/standalone-harness.html)): Mount + Engine aktiv, Tippen → Autosave über Bridge, Escape speichert ohne Teardown, `destroy()` räumt ab. Beweist die Host-Portabilität. |

**Pflicht:** Bei jeder Änderung im Focus-Editor `npm test` laufen lassen. Schlägt etwas fehl, Ursache klären, nicht Tests anpassen.

## Erweitern (Checkliste)

Neuer Granularitätsmodus, neue Hotkey, neuer Listener-Pfad:
1. Konstante in [constants.js](../public/js/editor/focus/constants.js) oder neues Sub-File anlegen — Submodule sind nach Verantwortung geschnitten (dom/sentence/typewriter/storage), nicht nach Reihenfolge.
2. Wenn neuer Body-Class-Marker: in `_focusInstall` add, in `exitFocusMode` remove, in `$watch(focusGranularity)`-Switch berücksichtigen.
3. Wenn neuer Listener: ausschliesslich am `ctx.container` oder `window` registrieren mit `{ signal }` aus `_focusInstall`. KEIN globaler `window.addEventListener` ohne AbortController.
4. State-Machine berühren? Generation-Check im async-Body Pflicht (`if (gen !== this._focusGen) return`).
5. CSS für neue Markierungs-Klasse in [focus-mode.css](../public/css/editor/focus/focus-mode.css) — selber `@layer components`, Container-Selektor ist `.focus-editor__content` (entkoppelt von Notebook-Editor / `.page-content-view`).
6. Tests in [tests/unit/editor-focus.test.mjs](../tests/unit/editor-focus.test.mjs) ergänzen (pure Helpers) und ggf. E2E-Case in [tests/e2e/focus-editor.spec.js](../tests/e2e/focus-editor.spec.js).
7. CLAUDE.md „Editor-Modi"-Tabelle prüfen — bei strukturellen Änderungen am Modus-Set Invarianten-Liste updaten.
