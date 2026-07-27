# Kapitel-Hierarchie

Kapitel können in Kapitel verschachtelt werden (max 3 Ebenen). SSoT der Verschachtelung lebt in `book_order.order_json` (Tree) **und** materialisiert in `chapters.parent_chapter_id` (FK, ON DELETE SET NULL). Tiefe wird nicht persistiert — sie wird bei Bedarf aus der Parent-Kette berechnet.

## Harte Grenzen

- **`MAX_CHAPTER_DEPTH = 3`** — Konstante in [db/book-order.js](../db/book-order.js) (Backend-SSoT) + gespiegelt als Frontend-Konstante in [public/js/book-organizer/view.js](../public/js/book-organizer/view.js).
  - **Why:** PDF-Renderer mapped 1→h1, 2→h2, 3→h3; tiefer wäre ohne neue Heading-Stufen unsauber. UX bei tieferer Verschachtelung wird unübersichtlich. Beispiele wie Bibel-Bücher (Buch → Teil → Kapitel) decken 3 Ebenen ab.
- **Validator wirft** `MAX_DEPTH` bei Versuch tieferer Verschachtelung — gilt für PUT auf `/content/books/:id/order` und für DnD-Drop-Targets.
- **Zyklen-Schutz** kommt strukturell durch JSON-Tree-Form (kein Kapitel kann sich selbst enthalten); Organizer-DnD prüft zusätzlich `_descendantIdsOf` vor Drop.

## Schema

```sql
chapters.parent_chapter_id INTEGER REFERENCES chapters(chapter_id) ON DELETE SET NULL
CREATE INDEX idx_chapters_parent ON chapters(parent_chapter_id);
```

- Migration **135** ([db/migrations.js](../db/migrations.js)). FK-Recreate nicht nötig — `ALTER TABLE ADD COLUMN` mit FK ist erlaubt für nullable Spalten ohne DEFAULT.
- `ON DELETE SET NULL` (statt CASCADE): **Why** — konsistent mit `pages.chapter_id`. Löscht ein User das Eltern-Kapitel, werden Sub-Kapitel top-level statt mitgelöscht (User-Daten-Schutz).

## SSoT: `book_order.order_json`

Children-Arrays sind gemischt — chapter-nodes können chapter+page-children enthalten, bis MAX_CHAPTER_DEPTH:

```json
[
  { "type": "chapter", "id": 42, "children": [
      { "type": "chapter", "id": 50, "children": [
          { "type": "page", "id": 200 }
      ]},
      { "type": "page", "id": 101 }
  ]},
  { "type": "page", "id": 103 }
]
```

`materializeTree` ([db/book-order.js](../db/book-order.js)) setzt in einer Transaction:
- `chapters.parent_chapter_id` (NULL für top-level, sonst FK auf Eltern-Kapitel)
- `chapters.position` (0-basiert, **lückenlos in Depth-First-Tree-Reihenfolge** — globaler Sort-Hint für `listChapters`)
- `pages.chapter_id` (NULL für top-level, sonst FK auf **direkt** enclosing Kapitel)
- `pages.position` (0-basiert, lückenlos **pro Bucket**: Eltern-Kapitel oder Top-Level)

`reconcile` (Lese-Pfad nach externen CRUD-Inserts) ist rekursiv: verwaiste Sub-Kapitel werden anhand `parent_chapter_id` unter ihren Parent gehängt, sofern Tiefe ≤ MAX. Sonst Fallback auf top-level.

## Backend-Helper

In [db/book-order.js](../db/book-order.js):

```js
getDescendantChapterIds(chapterId, { includeSelf = false })
```
Rekursive CTE auf `parent_chapter_id`. Liefert alle Nachfahren. Genutzt von:
- **Kapitel-Review** ([routes/jobs/kapitel.js](../routes/jobs/kapitel.js)) bei `include_subchapters: true` — lädt Seiten aller Sub-Kapitel rekursiv.

In [lib/content-store/index.js](../lib/content-store/index.js):

- **`bookTree(bookId, ctx)`** — Output: `{ chapters: [top-level], topPages: [] }`. Jedes Kapitel hat `{ ...meta, pages: [], subchapters: [] }` (rekursiv selbe Shape). Direkt verbrauchbar für nested UI.
- **`flattenTree(tree)`** — depth-first Liste `[{ page, chapterId, chapterName, depth }]`. `chapterName` ist das direkt umschliessende Kapitel. Genutzt von [routes/book-editor.js](../routes/book-editor.js) für flache Page-Liste.
- **`walkAllChapters(tree, cb)`** — Iterator über alle Kapitel-Ebenen.

In [lib/content-mapper.js](../lib/content-mapper.js): `mapChapter` exposed `parent_chapter_id` — Pflicht, damit `coalesce.js`/Export-Builder die Tiefe berechnen können.

## Frontend: Buchorganizer

[public/js/book-organizer/](../public/js/book-organizer/) — alle Slices nested-aware.

- **`workTree`-Shape** ([persist.js](../public/js/book-organizer/persist.js)): rekursiv, `{ id, name, depth, parent_id, pages, subchapters }`. Snapshot via `_snapshotFromNav` rekonstruiert das Nesting aus `nav.tree` — der ist flach, enthält aber alle Kapitel jeder Tiefe mit `depth` + `parent_id` (kein eigener Tree-Fetch nötig). `depth` wird aus dem rekonstruierten Nesting neu abgeleitet.
- **3-Level-Render** ([public/partials/buchorganizer.html](../public/partials/buchorganizer.html)): Unrolled (Alpine kennt keine Template-Rekursion), aber der Zeileninhalt ist SSoT im Fragment-Include [organizer-chapter-body.html](../public/partials/organizer-chapter-body.html). **Alle Tiefen nutzen denselben x-for-Alias `ch`** (Level 2/3: `ch in (ch.subchapters || [])`, Alpine shadowed im Kind-Scope) — nur dadurch ist das Fragment tiefenunabhängig. Gegated: [tests/e2e/organizer-hierarchy.spec.js](../tests/e2e/organizer-hierarchy.spec.js).
- **DnD** ([dnd.js](../public/js/book-organizer/dnd.js)): Alle Chapter-Listen teilen Gruppe `chapters`. `_validateChapterMove` (Sortable.onMove) blockt:
  - Drop in eigenen Subtree (via `_descendantIdsOf`)
  - Tiefe-Überschreitung (`targetDepth + subtreeDepth - 1 > MAX_CHAPTER_DEPTH`, Konstante aus [constants.js](../public/js/book-organizer/constants.js))
- **Tab / Shift+Tab** ([view.js](../public/js/book-organizer/view.js#onChapterTab)): Im Kapitel-Input ruft `onChapterTab` → `demoteChapter` / `promoteChapter`. preventDefault nur wenn Aktion möglich, sonst native Tab-Navigation.
- **`promoteChapter` / `demoteChapter`** ([dnd.js](../public/js/book-organizer/dnd.js)): mutieren workTree (raus aus aktueller parentList, in neuer einfügen), `_setSubtreeDepth` rekursiv für Subtree (Tiefe + `parent_id`), dann `_persistOrder({ mirror: 'chapters' })` + `_reattachSortables()`.
- **Persist-Strategie** — `_persistOrder({ mirror })` mit vier Modi (`'chapters'`/`'pages'`/`'both'`/`'reload'`, Tabelle in [buchorganizer.md](buchorganizer.md#mirror-modi)). Der Mirror ist tiefen-vollständig: `_mirrorChapterOrderInRoot` schreibt `priority`/`depth`/`parent_id`/`hasChildren` aller Kapitel und ordnet `nav.tree` depth-first (`_reorderNavTree`), `_mirrorPageMembershipInRoot` sammelt Seiten rekursiv. Deshalb laufen **auch Cross-Level-Moves und Seiten in Sub-Kapiteln über den granularen Mirror** (kein Sidebar-Flicker); `'reload'` bleibt allein für `createSubchapter` (neues Kapitel, Position im flachen Store nicht aus dem Workstate ableitbar).
- **`canPromoteChapter` / `canDemoteChapter`** — Demote braucht Vor-Geschwister + `newDepth + movingSubtreeDepth - 1 ≤ MAX_CHAPTER_DEPTH`.

## Frontend: Sidebar-Tree

[public/js/book/tree.js](../public/js/book/tree.js) — flach mit Depth-Annotation:

- `loadPages` walkt nested `tree.chapters` rekursiv → `this.tree` als flacher depth-first Array. Jedes Item: `{ ..., depth, parent_id, hasChildren }`.
- `hasChildren` (true wenn das Kapitel Sub-Kapitel hat) erlaubt Chevron + Collapse auch für Kapitel ohne eigene Seiten.
- `filteredTree` ([public/js/app.js](../public/js/app.js)): zwei-Pass-Filter. Pass 1 matcht Pages. Pass 2 fügt Vorfahren matchender Sub-Kapitel hinzu (mit leerer Page-Liste), damit Deep-Treffer Kontext zeigen.
- Indent via CSS-Custom-Prop `--depth` ([public/css/page/tree-history.css](../public/css/page/tree-history.css)): `.tree-chapter--depth-2/3` → `padding-inline-start` + abgestufte Schrift.
- Sub-Chapter-Stats: `_refreshChapterStats` aggregiert rekursiv pro Subtree (children-Map via `parent_id`), inkl. Chapter-Name-Beitrag.

## Kapitel-Review

[routes/jobs/kapitel.js](../routes/jobs/kapitel.js):

- POST-Body: `include_subchapters: boolean`.
- Bei `true`: `getDescendantChapterIds(chapterIdInt, { includeSelf: true })` → Set aller relevanten Kapitel-IDs → Pages-Filter via `chapterIds.has(p.chapter_id)`.
- Cache-Key (`pagesSig`) enthält `chaptersSig` (sortierte ID-Liste) + `optionsSig` (mit `includeSubchapters`-Flag). Cache-Miss bei:
  - Sub-Kapitel-Drift (neues Sub-Kapitel, verschoben, gelöscht)
  - Mode-Switch (User toggelt Checkbox)
  - Direkter Page-Change

Frontend [public/js/cards/kapitel-review-card.js](../public/js/cards/kapitel-review-card.js):

- `_includeSubchaptersByChapter`-Map mit Auto-Default: `true` wenn `kapitelReviewHasSubchapters(chapterId)`.
- UI-Toggle ([public/partials/kapitelreview.html](../public/partials/kapitelreview.html)) erscheint nur wenn Kapitel Sub-Kapitel hat.
- Helper `_kapitelReviewDescendantIds` traversiert root.tree-parent_id-Kette (Frontend-Mirror der CTE).

## PDF-Export

[lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js):

- **`chapter.numberingMode: 'nested' | 'flat'`** — Default `'nested'` (1, 1.1, 1.1.1). `'flat'` zählt durchlaufend (1, 2, 3).
- **`chapter.breakBeforeSubchapter: boolean`** — Default `false`. Sub-Kapitel bleiben inline; `true` erzwingt Pagebreak vor jeder Tiefe.
- **`toc.depth: [1, 2, 3]`** — TOC-Tiefe steuert, bis welche Ebene Einträge in das Inhaltsverzeichnis kommen.

[lib/pdf-render/layout.js](../lib/pdf-render/layout.js#_chapterLabelNested): Roman/Word-Numbering nur für Top-Level; Sub-Ebenen sind immer arabisch (Lesbarkeit). Beispiel `nested`+`roman`: `IV.2.1`.

[lib/pdf-render/coalesce.js](../lib/pdf-render/coalesce.js): jedes Block-Element trägt `depth`, berechnet via `_depthByChapterId` aus `parent_chapter_id`-Kette.

[lib/pdf-render/index.js](../lib/pdf-render/index.js):

- **TOC-Plan**: `tocCounters[3]`; bei depth d → `counters[d-1]++`, tiefere reset; Label via `_chapterLabelNested`; TOC-Level = `depth - 1`.
- **Body-Loop**: depth → Heading-Größe (h1/h2/h3), Align (centered nur depth=1), `spaceBeforeMm`-Faktor (1.0 / 0.4 / 0.2), Break-Verhalten (depth>1 nur bei `breakBeforeSubchapter`), DropCap nur depth=1, `titleRule` nur depth=1.

## Andere Export-Builder

[lib/export-builders/shared.js](../lib/export-builders/shared.js) exportiert `chapterDepth(chapter, byId, max=3)` + `buildChaptersById(groups)` als gemeinsamen Helper.

- **HTML/MD**: Kapitel-Heading via depth+1 (Top = h2 / `##`, depth 2 = h3 / `###`, depth 3 = h4 / `####`); Page-Heading eine Stufe tiefer, gecapped bei 6.
- **DOCX**: depth → `h${depth}`; `page-break-before: always` nur für depth=1.
- **EPUB**: NavMap-NCX hat 2 Ebenen — depth-1 wird auf `__level: min(1, depth-1)` gemapped (Sub-Sub-Kapitel kollabiert in Outline auf Level 1, Content vollständig erhalten).
- **TXT**: unverändert (Plain-Text ohne Heading-Markup).

## Andere `chapter_id`-Konsumenten

Alle referenzieren das **direkt** enclosing Kapitel (`pages.chapter_id`). Sub-Kapitel sind selbst Kapitel — Konsumenten funktionieren transparent ohne Code-Änderung:

- `figure_appearances`, `location_chapters`, `song_chapters`, `figure_events`, `figure_scenes`
- `continuity_issue_chapters`, `zeitstrahl_event_chapters`
- `ideen` (XOR mit `page_id`)
- `page_checks`, `chapter_reviews`, `chapter_extract_cache`, `chapter_macro_review_cache`
- FTS5 `search_index` — Kapitel-Entities (Name + Description) werden mit eigener `entity_id` indexiert, durchsuchbar
- Komplettanalyse Phase 3b (kapitelübergreifende Beziehungen) — iteriert alle Kapitel, Sub-Kapitel automatisch enthalten
- Finetune-Export — sample-generation behandelt Sub-Kapitel wie reguläre Kapitel

Falls eine Aggregation auf **Top-Level-Kapitel rollupen** soll (z.B. „Häufigkeit pro Hauptteil"), via `getDescendantChapterIds` + SUM. Aktuell nicht im UI exponiert.

## Folder-Import nutzt Hierarchie

[routes/jobs/folder-import.js](../routes/jobs/folder-import.js) erzeugt Jahr-Kapitel (top-level) + Monat-Sub-Kapitel (`parent_chapter_id = Jahr-ID`). Siehe [docs/folder-import.md](folder-import.md).

## Pflicht-Invarianten

1. **PUT auf `/content/books/:id/order`** ist einzige Stelle, die `chapters.parent_chapter_id` mutiert. CRUD-Routen (`POST /chapters`) akzeptieren `parent_chapter_id` nur beim Anlegen; Re-Parent läuft ausschliesslich über order_json.
2. **`MAX_CHAPTER_DEPTH = 3`** ist gespiegelte Konstante. Bei Bumpen: beide Stellen ändern + PDF-Renderer (h1/h2/h3-Mapping) erweitern + Frontend-Indent-CSS-Stufen ergänzen.
3. **`chapters.position`** ist depth-first global lückenlos. Wer sortiert nach `position` über `listChapters`, bekommt depth-first Tree-Reihenfolge automatisch.
4. **`pages.position`** ist per-Bucket lückenlos. Mixed chapter+page-children eines Eltern-Kapitels werden in order_json sortiert; aus pages.position allein lässt sich die mixed-Reihenfolge nicht rekonstruieren. SSoT bleibt order_json.
5. **`mapChapter` muss `parent_chapter_id` exposeen** — alle Export-Builder + PDF-Renderer berechnen Tiefe daraus. Drop = stille Flach-Darstellung.
6. **DnD-Validierung** prüft Self-Cycle + Max-Depth bevor Drop akzeptiert wird (`onMove`). Server-Validator ist letzte Verteidigungslinie; UI-Validation gibt visuelles Feedback (Cursor + ggf. Drop-Verbot-Indicator).

## Tests

- [tests/integration/book-order.test.js](../tests/integration/book-order.test.js)
  - Validator: akzeptiert depth ≤ 3, wirft `MAX_DEPTH` bei 4
  - bookTree: `subchapters[]` nested-Output
  - `flattenTree`: depth-first Page-Liste + chapterName-Mapping
  - `getDescendantChapterIds`: rekursive CTE
- [tests/unit/pdf-export-defaults.test.js](../tests/unit/pdf-export-defaults.test.js)
  - `numberingMode` Default `nested`, akzeptiert `flat`, verwirft Bogus
  - `breakBeforeSubchapter` Default false, akzeptiert true
  - `toc.depth: 3` akzeptiert
