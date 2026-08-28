# Buchorganizer

Karte zum Reordern/Verschieben/Umbenennen/Anlegen/Löschen von Kapiteln und Seiten. Direkter Storage-Zugriff via `contentRepo` (kein KI, keine Job-Queue). DnD via SortableJS (lazy). Undo/Redo bis 10 Aktionen.

Code: [public/js/cards/book-organizer-card.js](../public/js/cards/book-organizer-card.js) (Card-Definition) + [public/js/book-organizer.js](../public/js/book-organizer.js) (Facade) + [public/js/book-organizer/](../public/js/book-organizer/) (Slices).

## Modul-Layout

| Slice | Verantwortung |
|-------|---------------|
| `book-organizer/constants.js` | `MAX_CHAPTER_DEPTH` (Frontend-Spiegel von db/book-order.js), `COLLAPSE_THRESHOLD`. Einziges Modul, das mehrere Slices importieren. |
| `book-organizer/dnd.js` | Sortable-Setup, `_onChapterDrop`/`_onPageDrop`, `_reattachSortables`, `_setSubtreeDepth` + die Struktur-Moves `movePageToChapter` (Combobox), `promoteChapter`/`demoteChapter`. |
| `book-organizer/persist.js` | `_rerender`, `_snapshotFromNav`, `_snapshotWorkstate`, `_runMutation`, `_persistOrder`, `_applyMirror`, `_buildTreeFromWorkstate`. |
| `book-organizer/mirror.js` | In-Place-Spiegelung `workTree`/`soloPages` → `nav.tree`/`nav.pages` + Depth-First-Reordering + Order-Maps + Chapter-Stats. |
| `book-organizer/crud.js` | Create/Rename/Delete für Kapitel + Seiten + `movePageToBook`, jeweils Server-Call + Mirror + History-Push. |
| `book-organizer/history.js` | Undo/Redo-Stacks (FIFO max 10), Record-Typen, `_applyInverse`/`_applyForward`. |
| `book-organizer/view.js` | Collapse-State pro Kapitel, Suchfilter (`filteredWorkTree`/`filteredSoloPages`), Combobox-Optionen, Jump-to-Chapter, `_findChapter`, Kapitel-Längenverteilung. |

Spread-Reihenfolge in der Facade: dnd → persist → mirror → crud → history → view. Slices teilen `this`-State, kein Cross-Import zwischen Slices — geteilte Konstanten kommen aus `constants.js`.

## Markup-Layout

[buchorganizer.html](../public/partials/buchorganizer.html) enthält nur noch Toolbar, Solo-Liste, die drei Level-Wrapper und die Längenverteilungs-Tile. Der Zeileninhalt ist SSoT in zwei string-seitigen Fragment-Includes (`<!-- @include … -->`, [app-ui.js](../public/js/app/app-ui.js)#`_resolveIncludes`):

- [organizer-chapter-body.html](../public/partials/organizer-chapter-body.html) — Kapitel-Kopfzeile + Seitenliste, 3× geklont (eine pro Tiefe).
- [organizer-page-row.html](../public/partials/organizer-page-row.html) — eine Seitenzeile, 4× geklont (Solo-Liste + 3 Tiefen); enthält selbst `organizer-page-actions`.

**Alle drei Kapitel-Tiefen nutzen denselben `x-for`-Alias `ch`** (Level 2/3 iterieren `ch in (ch.subchapters || [])`; Alpine shadowed den äusseren Alias im Kind-Scope). Nur dadurch ist der Include tiefenunabhängig. Tiefenabhängiges kommt aus `ch.depth` bzw. `maxChapterDepth` (Card-Feld aus `constants.js`), nicht aus dem Markup — im Wrapper stehen ausschliesslich `data-organizer-depth` + `data-parent-chapter-id` für die Sortable-Drop-Validierung. Gegated: [tests/e2e/organizer-hierarchy.spec.js](../tests/e2e/organizer-hierarchy.spec.js) (echtes Partial + Include-Auflösung gegen echte Alpine-Runtime).

## State auf der Card

```js
workTree         // [{ id, name, pages: [{ id, name, chapter_id }] }]  — Kapitel + ihre Seiten
soloPages        // [{ id, name, chapter_id: 0 }]                      — Seiten ohne Kapitel
chapterOpen      // { [chapter_id]: bool }                             — Per-Kapitel-Collapse-State
organizerSearch  // String — Filter (UI-only, kein Server-Call)
jumpToChapterId  // String — Wert der Jump-Combobox
_sortables       // Sortable-Instanzen (DnD-Lebenszyklus)
_undoStack       // Record[]
_redoStack       // Record[]
_inHistoryFlight // Boolean — verhindert Re-Entry während Undo/Redo
_lifecycle       // setupCardLifecycle-Handle (AbortController, $watch-Setup)
_onHistoryKeydown// window-Listener-Ref (Cmd/Ctrl+Z/Y)
_memos           // Memo-Cache (view.js#_memo)
maxChapterDepth  // Number — MAX_CHAPTER_DEPTH für Template-Guards
organizerSaving  // Boolean — Mutation läuft
organizerStatus  // String — i18n-Label während Persist
```

`workTree`/`soloPages` sind die **Edit-Repräsentation** des Buchorganizers; `Alpine.store('nav').tree`/`.pages` ist der App-weite Tree (Sidebar). Mutationen passieren zuerst lokal, dann werden Server + Store in-place gespiegelt.

Der buch-skopierte Teil des States kommt aus **einer** Factory `freshState()` in [book-organizer-card.js](../public/js/cards/book-organizer-card.js) — Initialwert, `book:changed` und `view:reset` lesen dieselbe SSoT. Factory statt Konstante, weil `Object.assign` sonst dieselben Array-Referenzen über mehrere Resets teilen würde. `resetState` im Lifecycle-Cfg wird bewusst **nicht** gesetzt: beide Reset-Pfade sind überschrieben (sie müssen zusätzlich Sortable destroyen), der Helper-Default käme nie zum Zug.

## Lifecycle

`setupCardLifecycle` mit folgenden Hooks:

- **`onShow`** — `loadSortable()` (lazy), dann `_rerender()` (Snapshot + Sortable-Init).
- **`onBookChanged`** — Sortable destroyen, gesamten Card-State leeren. **Vor `loadPages`** — der nachfolgende `pages:loaded`-Listener triggert dann den neuen Snapshot.
- **`onCardRefresh`** — nur `_rerender()`. **Kein `loadPages`** — Drag/Rename/CRUD mutieren `nav.tree` in-place, Server-Stand und Card-State sind synchron. `loadPages` würde Sidebar-Tree clearen und neu fetchen → Flicker.
- **`onViewReset`** — Sortable destroyen + State leeren.
- **`pages:loaded`- + `page:removed`-Listener** — separat über `extraListeners`. Beide greifen nur, wenn die Karte sichtbar ist: `pages:loaded` nach echten Server-Reloads (Buchwechsel, `loadPages`) → `_rerender()`; `page:removed` immer dann, wenn eine Seite aus dem Store verschwindet — **lokales Löschen (`deletePageById`), Remote-Delete aus dem Collab-Feed, Move in ein anderes Buch**. In allen drei Fällen hat `tree/load.js#_removePageFromTree` `nav.tree`/`nav.pages` bereits in-place bereinigt (ohne Reload); der Listener zieht die daraus **abgeleiteten** Sichten nach: `_rebuildPageOrderMaps()`, `_invalidateDiaryCache()`, `_rerender()` (Workstate-Snapshot). Ohne das bliebe die Zeile stehen bzw. zeigten Order-Maps und Diary-Kalender auf eine Seite, die es nicht mehr gibt. **Kein `$watch(nav.tree)`** — eigene Reassignments im Tree würden Selbst-Reentry erzeugen.

Tastatur (window-Listener via Lifecycle-Signal): Cmd/Ctrl+Z → `historyUndo`, Cmd/Ctrl+Shift+Z bzw. Cmd/Ctrl+Y → `historyRedo`. **Greift nicht** in INPUT/TEXTAREA (native Edit-Undo der Rename-Felder soll funktionieren) und nur bei sichtbarer Karte.

`$watch('organizerSearch')` → `_reattachSortables()`: der Such-Toggle erzeugt/entfernt `x-if`-gatete Page-ULs, also müssen die Instanzen neu binden — und `_reattachSortables` zieht `_refreshSortableDisabled()` mit, das bei aktiver Suche alle Instanzen disabled (Reorder über gefiltertem DOM würde die Reihenfolge brechen).

## Mutationspfad (Pflicht-Sequenz)

```
User-Action  (Drag, Click, Rename-Blur, Combobox-Pick)
  ↓
_snapshotWorkstate()         — Vor-State für History-Record cloneen (Reorder)
  ↓
Lokal mutieren              — workTree/soloPages in-place
  ↓
_persistOrder({ mirror })   — bzw. _runMutation(...) bei CRUD
  contentRepo.saveOrder()    — Single-PUT mit gesamtem Tree (atomic)
       /createChapter/createPage/updateChapter/updatePage/deleteChapter/deletePage
  _applyMirror(mirror)       — nav.tree + nav.pages in-place patchen
  ↓
History-Push (nur bei ok)
```

`_runMutation` setzt `organizerSaving=true`, fängt Errors via `setStatus`, ruft bei Fehler **einmal `root.loadPages()`** (defensiver Resync — Server-State könnte partiell mutiert sein), resettet Status-Flags im `finally`.

`_persistOrder` ist Single-Tree-PUT an `/content/books/:id/order`: Server materialisiert `chapters.position`, `chapters.parent_chapter_id`, `pages.position`, `pages.chapter_id` in einer Transaction. Kein Per-Item-Update.

### Mirror-Modi

`_persistOrder({ mirror, affectedChapters })` wählt, wie der Sidebar-Store nachgezogen wird — SSoT der Verzweigung ist `_applyMirror`:

| Modus | Wann | Wirkung |
|-------|------|---------|
| `'chapters'` | Kapitel-Struktur geändert (DnD auf jeder Tiefe, promote/demote, Kapitel-Delete) | `_mirrorChapterOrderInRoot()` |
| `'pages'` | Seiten-Zugehörigkeit/-Reihenfolge (Page-DnD, Move-Combobox) | `_mirrorPageMembershipInRoot(affectedChapters)` |
| `'both'` | History-Replay — ein Snapshot kann beides enthalten | Chapter-Struktur zuerst, dann Page-Membership über alle Kapitel |
| `'reload'` | volles `loadPages()` | **nur** `createSubchapter` |

`'reload'` ist bewusst der Ausnahmefall: ein **neues** Sub-Kapitel existiert im Workstate noch nicht, seine Einsortierungsposition im flachen `nav.tree` ist daraus nicht ableitbar. Alle anderen Pfade (auch Cross-Level-Moves und Seiten in Sub-Kapiteln) spiegeln granular und flackern deshalb nicht.

## In-Place-Mirror

Pflichtprinzip: **kein `loadPages()` nach erfolgreicher Mutation**. `loadPages` würde `nav.pages`/`nav.tree` neu zuweisen → ganze App-UI rendert neu (sichtbarer Flicker, Sidebar-Scroll springt). Stattdessen mutiert die Card `nav.tree`/`nav.pages` in-place. Alpine-Deep-Reactivity erkennt nur die geänderten Items.

### Ordnungs-Invariante (drift-kritisch)

`nav.tree` ist **flach, aber depth-first**: Solo-Seiten zuerst, dann Kapitel in Lese-Reihenfolge, Sub-Kapitel direkt hinter ihrem Parent ([tree/build.js](../public/js/book/tree/build.js)#`_buildTreeFromResponse`, aufgerufen aus [tree/load.js](../public/js/book/tree/load.js)#`loadPages`). Die Sidebar ([app.js](../public/js/app.js)#`filteredTree`) **filtert nur** und rendert in Array-Reihenfolge.

Daraus folgt: **`nav.tree` nie global nach `priority` sortieren.** `priority` ist die Position *innerhalb des Parents*; ein globaler Sort mischt Sub-Kapitel zwischen fremde Top-Level-Kapitel. Massgeblich ist stattdessen die Depth-First-Reihenfolge des Workstates:

- **`_chapterDfsRank()`** — chapter-id → Depth-First-Rang aus `workTree`. Basis für beide Sortierungen.
- **`_reorderNavTree()`** — ordnet `nav.tree`: Solo-Items (in `soloPages`-Reihenfolge) zuerst, dann Kapitel nach DFS-Rang. Stabiler Sort, unbekannte Items behalten ihre relative Position am Ende.
- Neu angelegte Items werden **eingefügt**, nicht einsortiert: ein neues Top-Level-Kapitel gehört ans Ende (`push`), ein neuer Solo-Entry direkt hinter die bestehenden Solo-Items (`splice`).

Ausserhalb des Organizers gilt dasselbe: die Kapitel-Anlage in der Sidebar und die Tagebuch-Jahreskapitel nutzen `insertChapterItem(tree, item, { afterChapterId, beforeChapterId })` aus [tree/load.js](../public/js/book/tree/load.js) — `afterChapterId` überspringt den **kompletten Subtree** des Ankers.

### Mirror-Helper

- **`_mirrorChapterOrderInRoot()`** — Kapitel-Struktur. Schreibt `priority` (Position im Parent), `depth`, `parent_id` und `hasChildren` auf **alle** Kapitel-Items in `nav.tree`, ruft `_reorderNavTree`, rebuildt `_chapterOrderMap`, resortiert `nav.pages`, rebuildt `_pageOrderMap`/`_pageIdOrderMap`, ruft `_refreshChapterStats()`. Deckt damit auch Cross-Level-Moves ab.
- **`_mirrorPageMembershipInRoot(affectedChapterIds)`** — Page-Zugehörigkeit. Sammelt `chapter_id`/`priority`/`name` **rekursiv** über alle Tiefen (Seiten in Sub-Kapiteln müssen mit) und spiegelt sie auf `nav.pages`; rebuildt die `pages`-Arrays der betroffenen Tree-Einträge (`null` = alle Kapitel), dann Solo-Entries, Reorder, Resort, Maps, Stats.
- **`_rebuildSoloEntries()`** — Solo-Tree-Items löschen + frisch nach `soloPages`-Reihenfolge anlegen (`_buildSoloEntry`, Shape muss zu `tree/load.js` passen); `_reorderNavTree` schiebt sie anschliessend vor die Kapitel.
- **`_resortRootPages()`** — `nav.pages` nach Kapitel-DFS-Rang + Page-Position. Kapitellose Seiten zuerst (Rang `-1`).

`_mirrorCreatedChapter`/`_mirrorCreatedPage` (CRUD-Slice) übernehmen die Spiegelung für neu angelegte Items. Bei neu angelegter Seite in frisch erstelltem Kapitel wird `treeCh.pages` **per Reassignment** statt `push` aktualisiert — Alpine-Reaktivität greift bei nested Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich selbst gepusht wurde.

## Snapshot-Quelle

`_snapshotFromNav()` baut `workTree`/`soloPages` **aus dem Sidebar-Store**, ohne eigenen Server-Fetch: `nav.tree` enthält alle Kapitel jeder Tiefe mit `depth` + `parent_id`, das Nesting ist daraus verlustfrei rekonstruierbar (zwei Pässe — Knoten sammeln, dann über `parent_id` verlinken; die Array-Reihenfolge liefert die Geschwister-Reihenfolge). `depth` wird aus dem rekonstruierten Nesting neu abgeleitet statt dem Store geglaubt.

Ein Erst-Render vor abgeschlossenem `loadPages` liefert einen leeren Snapshot; das anschliessende `pages:loaded` triggert den echten. Echter Server-Resync läuft über `loadPages()` → `pages:loaded` → `_rerender()` (Fehlerpfad von `_runMutation`, `createSubchapter`, Buchwechsel).

## DnD (SortableJS)

Zwei Sortable-Gruppen:

- **`chapter-list`** (Kapitel reordern, eine Liste pro Tiefe): `group: { name: 'chapters', pull: true, put: ['chapters'] }`. Erlaubt Kapitel-Wandern zwischen Levels; Ziel-Validierung (max-depth, kein-eigener-Subtree, kein-self) im `onMove`-Hook `_validateChapterMove`.
- **`page-list`** (eine pro Kapitel + eine für Solo-Seiten): `group: { name: 'pages', pull: true, put: ['pages'] }`. Erlaubt Page-Drops aus jeder anderen page-list.

Der drift-anfällige SortableJS-Kern (Prototype-Patch, Revert, Präzisions-Tuning, x-ignore) liegt geteilt mit der Plot-Werkstatt in [public/js/sortable-dnd.js](../public/js/sortable-dnd.js) — beim Sortable-Versionssprung dort verifizieren. Feature-Spezifisches (Gruppen, Handles, `onMove`-Validierung, Drop-Logik, nested-Tiefen) bleibt im Organizer-`dnd.js`.

`onChoose`/`onUnchoose`: setzen via `markDragIgnore`/`unmarkDragIgnore` (aus dem geteilten Modul) `x-ignore` auf das Drag-Item. Sortable klont das Item als Fallback-Ghost (`cloneNode(true)`) in `<body>`. Ohne `x-ignore` würde Alpines MutationObserver `:value="page.name"` ausserhalb des `x-for`-Scopes evaluieren und „page is not defined" werfen.

**Revert-vor-Mutation (Pflicht).** SortableJS und Alpine `x-for` besitzen dieselben `<li>`/`<div>`-Nodes. Drop-Handler rufen darum **als Erstes** `revertSortable(evt)` (geteiltes Modul) — der schiebt den von Sortable physisch verschobenen Node zurück an seinen Ursprungsplatz (Quell-Container, `oldIndex`). Erst danach mutieren sie das Modell (`workTree`/`soloPages`); Alpine rendert die finale Position aus dem Modell. Ohne Revert zeigt nach einem Cross-Container-Move Alpines `key→el`-Map einer anderen `x-for`-Scope weiter auf den verschobenen Node → Orphan/Duplikat-Nodes, driftender DOM, kumulativ falsche Positionen.

`_onChapterDrop`: liest `movedId`/`toParentId`/`targetDepth`/`newIndex` aus dem `evt` (nicht aus dem DOM), revertet, entfernt den Node via `_findChapter` aus seiner Quell-Liste, setzt `parent_id` + rekursiv `depth` (`_setSubtreeDepth`) und splice't ihn an `newIndex` in die Ziel-Liste (`workTree` bei Top-Level, sonst `parent.subchapters`). Persistiert mit `mirror: 'chapters'` — auch bei Cross-Level; bei Container-Wechsel folgt `_reattachSortables()` (die `x-if`-gateten Subchapter-Divs erscheinen/verschwinden).

`_onPageDrop` liest `fromChapId`/`toChapId` aus `dataset.chapterId` der `<ul>`-Wrapper und den Ziel-Index aus `evt.newIndex`, revertet, entfernt Page aus Source-Bucket, setzt neue `chapter_id`, fügt am Ziel-Index ein. Persistiert mit `mirror: 'pages'` + `affectedChapters: [toChapId, fromChapId]` — der Mirror rebuildt nur diese beiden Buckets, greift aber auf jeder Tiefe.

**Sortable-Options (Präzisions-Tuning):** `_initSortables` spreadet `BASE_SORTABLE_OPTS` aus dem geteilten Modul — `forceFallback: true` (konsistenter Klon-Ghost via `<body>`, umgeht HTML5-DnD-Quirks), `swapThreshold: 0.65` (Swap erst bei 65% Cursor-im-Ziel — Default 1.0 swappt schon bei minimaler Überlappung → Nachbar-Flackern), `invertSwap: true` (stabile Backward-Drops in nested Listen), `fallbackTolerance: 5` (5px-Move bevor Drag startet), `revertOnSpill: true` (Drop ausserhalb gültiger Liste springt zurück), `direction: 'vertical'`. Organizer-Overrides: `emptyInsertThreshold: 8`, `scroll: false`, Drag-Visuals via eigene Klassen `organizer-ghost`/`organizer-chosen`/`organizer-drag-active` (CSS in `book/buchorganizer.css`).

`patchSortableOnce` (geteiltes Modul) patcht `Sortable.prototype._onDragOver` (v1.15.6): bei `this.el === null` (destroyte Instanz, Alpine `x-for`-Reconciliation läuft parallel) wird no-op statt zu crashen.

`movePageToChapter` (Combobox-Pfad) nutzt dieselbe Mutations-/Persist-Sequenz wie `_onPageDrop`, inkl. History-Push. `promoteChapter`/`demoteChapter` (Buttons + Tab/Shift+Tab im Kapitel-Input) sind die button-getriebenen Pendants zum Chapter-Drop: gleiche Splice-Mutation, `_setSubtreeDepth`, `mirror: 'chapters'`, Reorder-Record, danach `_reattachSortables()`.

**Re-Init nur über `_reattachSortables()`.** Jedes `_initSortables()` braucht ein nachfolgendes `_refreshSortableDisabled()`, sonst sind die Instanzen nach einem Re-Init bei aktiver Suche wieder aktiv und Reorder läuft über gefiltertem DOM. `_reattachSortables` bündelt destroy → `$nextTick` → init → disabled und ist der einzige zugelassene Weg (Delete, Move-to-Book, History-Replay, Collapse-Toggle, Such-Toggle nutzen ihn alle).

## Seite in anderes Buch verschieben (`movePageToBook`)

Zweite Combobox „In anderes Buch…" pro Seitenzeile (`bookMoveOptions()` = alle zugänglichen Bücher ausser dem aktuellen). Re-Parent unter Beibehaltung der `page_id` über `POST /content/pages/:id/move` (Facade `contentStore.movePage` → `localdb.movePage`, eine Transaction): `pages.book_id`/`chapter_id` umgehängt, seiten-intrinsische Daten ziehen mit (Revisionen/Stats/Lektorat-Befunde/Schreibzeit/Seiten-Chat/Page-Share — `book_id` nachgeführt), **buchwelt-bezogene Analyse der Quelle wird gekappt** (Figuren-Erwähnungen/Zeitstrahl-Links/Erst-Erwähnungen/Szenen-+Event-Anker/Recherche-Links/Lektorat-Cache; im Zielbuch via Komplettanalyse neu aufgebaut), Integrations-Spiegel (Blog/HubSpot) + Locks/Presence gelöscht. `book_order` beider Bücher heilt der Facade-Wrapper via `ensureTree`/`reconcile` (gleiche Konvention wie create/delete). Editor-Recht auf **beiden** Büchern + fremder Page-Lock blockiert (423). UI: Bestätigungs-Modal mit Kappen-Warnung; danach lokales `_forgetPageLocally` → Root-`_removePageFromTree` (SSoT, dispatcht `page:removed`) — die Seite verlässt dieses Buch, landet im Zielbuch top-level. **Nicht** via Undo/Redo reversibel → History-Clear. Die geteilte Aktions-Spalte (Sync-Badges + beide Move-Comboboxen + Löschen) ist SSoT in [public/partials/organizer-page-actions.html](../public/partials/organizer-page-actions.html) (string-Include `<!-- @include organizer-page-actions -->`, 4× geklont über Solo-Liste + 3 Kapitel-Tiefen; aktuelles Kapitel aus `page.chapter_id`).

## Undo/Redo

Records (siehe `history.js`):

```
{ kind: 'reorder',         before, after }                  // workstate-Snapshots
{ kind: 'rename-chapter',  id, oldName, newName }
{ kind: 'rename-page',     id, oldName, newName }
{ kind: 'create-chapter',  id, name }
{ kind: 'create-page',     id, chapterId, name }
```

`HISTORY_MAX = 10` pro Stack, FIFO-Drop bei Überlauf.

**Reorder-Undo** (`_applyReorderSnapshot`) rebuildet workstate aus dem `before`-Snapshot, ruft `_reattachSortables()` und persistiert dann über den normalen `_persistOrder({ mirror: 'both' })`-Pfad — kein eigener `saveOrder`-Aufruf. `'both'` läuft beide Mirror-Pfade nacheinander (Chapter-Struktur zuerst, dann Page-Membership über **alle** Kapitel mit aktualisierten Prios), weil ein Snapshot beides enthalten kann. Snapshot-Deep-Clone via `JSON.parse(JSON.stringify(…))` — `structuredClone` wirft auf Alpine-Proxys.

**Create-Undo** löscht das frisch erstellte Kapitel/Seite via `_deleteChapterRaw`/`_deletePageRaw`. **Redo-Stack wird komplett invalidiert** — beim erneuten Anlegen würde der Server eine neue ID vergeben, andere Records im Redo-Stack referenzieren aber die alten IDs (z.B. Reorder-Snapshots mit alten `chapter.id`). Saubere Wiederherstellung müsste der User manuell auslösen.

**Delete (Kapitel/Seite) ist nicht reversibel.** Hard-Delete in SQLite, keine Content-Snapshots. `deleteChapter`/`deletePage` rufen `_clearHistory()` und blocken damit Undo komplett, statt einen inkonsistenten Stack zu hinterlassen. `deleteChapter` verweigert ausserdem nicht-leere Kapitel und Kapitel, deren Seite gerade im Editor offen ist.

`_inHistoryFlight` blockt parallele Undo/Redo-Calls. `_pushUndo` während eines Replay-Schritts ist no-op (sonst würde der Replay sich selbst in den Stack pushen).

`_applyForward` für Reorder spielt das `after`-Snapshot ein. Für Rename ruft es `_doRenameChapter/_doRenamePage` mit `newName`. Create-Forward gibt es nicht — `_pushRedo` wird in `historyUndo` für Create-Records explizit übersprungen.

## View-State

`_recomputeInitialOpenState` (in `view.js`): beim allerersten Snapshot wird `COLLAPSE_THRESHOLD` (8, aus `constants.js`) geprüft. Mehr als 8 Kapitel → alles zu, sonst alles auf. Bei späteren `pages:loaded`-Re-Snapshots bleibt der User-Zustand erhalten, nur neue/entfernte Kapitel-IDs werden ergänzt bzw. entfernt.

`toggleChapter`/`expandAll`/`collapseAll` weisen `chapterOpen` jeweils ein **neues Objekt** zu (Alpine-Reaktivität für Object-Props) und rufen `_reattachSortables()`; `expandAll`/`collapseAll` teilen `_setAllChaptersOpen(bool)`.

`filteredWorkTree`/`filteredSoloPages` sind **Methoden, keine Getter**. Beim `{...viewMethods}`-Spread in der Facade würden Getter-Definitionen aufgerufen (`this` = POJO, `workTree` = undefined) und das Ergebnis als statisches Property eingefroren. Methoden bleiben durch Spread reaktiv.

`chapterMoveOptions(currentChId)` (Move-Combobox, mit „ohne Kapitel"-Option) und `jumpChapterOptions()` (Sprung-Combobox) sind zwei Aufrufe desselben `_chapterOptions({ exclude })`-Walks. Aufruf im `x-effect` der Combobox — die gelesenen Reactive-Felder (`workTree`, `ch.name`) sind Alpine-getrackt.

## Pflicht-Invarianten

- **Kein `loadPages()` nach erfolgreicher Mutation.** Nur im Error-Path von `_runMutation`.
- **Kein `$watch(nav.tree)`.** `pages:loaded`-Event ist die einzige zugelassene Re-Snapshot-Quelle.
- **`nav.tree` nie global nach `priority` sortieren.** Reihenfolge kommt aus `_reorderNavTree()` (Depth-First aus dem Workstate), neue Items werden an berechneter Position eingefügt. Gilt auch für Nachbar-Features: `insertChapterItem` in [tree/load.js](../public/js/book/tree/load.js).
- **Sortable-Re-Init ausschliesslich über `_reattachSortables()`** — nie `_destroySortables()` + `_initSortables()` von Hand (sonst fehlt `_refreshSortableDisabled`).
- **Page-Membership-Mirror rekursiert über alle Tiefen.** Seiten in Sub-Kapiteln dürfen nicht durchs Raster fallen.
- **Drop-Handler revertieren Sortables DOM-Move zuerst** (`revertSortable(evt)`, geteiltes Modul), dann mutieren sie das Modell. Indizes/Parent/Tiefe kommen aus dem `evt`, nicht aus dem DOM. Alpine bleibt alleiniger DOM-Besitzer.
- **Snapshots via `JSON.parse(JSON.stringify(…))`**, nicht `structuredClone`.
- **Delete clear't History.** Create-Undo invalidiert Redo-Stack.
- **Suche disabled Sortable**, nicht das Suchfeld.
- **`x-ignore` aufs Drag-Item** während des Drags (Alpine-MutationObserver-Schutz).
- **Move-Combobox via `movePageToChapter`** — gleiche Persist-Sequenz wie DnD, kein Direct-Mutate.

## Error-Pfad

`_runMutation`-`catch`:
1. `setStatus` mit i18n-Key (`bookOrganizer.saveFailed` etc.) + `error.message`.
2. `root.loadPages()` — defensiver Resync, weil Server möglicherweise partiell mutiert ist (z.B. Atomic-PUT fehlgeschlagen, aber DB-Trigger lief schon teilweise).
3. `organizerSaving=false`, `organizerStatus=''` im `finally`.

Rename-Pfad ist anders: kein `_runMutation`-Wrapper, sondern direkter `try/catch` in `_doRenameChapter`/`_doRenamePage`. Bei Fehler wird das `<input>`-Element auf den alten Namen zurückgesetzt (`inputEl.value = ch.name`).

## Neue Mutation hinzufügen

1. Methode in passenden Slice. Struktur-/Drag-Mutation → `dnd.js`, sonst `crud.js` oder `persist.js`.
2. `_snapshotWorkstate()` vor lokaler Mutation aufrufen (für History-Record).
3. Lokal mutieren (workTree/soloPages in-place).
4. Reorder/Move: `_persistOrder({ mirror, affectedChapters })` — Modus-Tabelle oben. CRUD: `_runMutation(async () => { contentRepo.xxx(); _mirrorXxx(); })`.
5. Bei Erfolg: passenden `_recordXxx`-Helper in `history.js` rufen. Wenn Operation nicht reversibel ist (Delete, Cross-Book-Move): `_clearHistory()`.
6. Ändert die Operation Page-Membership → `mirror: 'pages'` + `affectedChapters`; ändert sie Kapitel-Struktur → `mirror: 'chapters'`. Nur ein **neu angelegtes** Kapitel rechtfertigt `'reload'`.
7. Wenn die Operation DOM-Container umbaut (Kapitel wechselt Ebene, Item verschwindet): `await this._reattachSortables()` am Ende.
8. Bei UI-Pfaden mit nestedem Reassignment (Page in neues Kapitel pushen): `treeCh.pages = [...treeCh.pages, p]` statt `push` — Alpine-Reaktivität.
