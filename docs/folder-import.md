# Folder-Import

> Die Import-Karte trägt drei Import-Arten: den hier beschriebenen Tagebuch-ZIP, den [Manuskript-Import](manuscript-import.md) (ein Word-/ODT-Dokument nach Überschriften-Ebenen zerlegt) und das [`.swbook`-Bundle](book-migration.md). Geteilt sind Karte, Drop-Zone und Job-Polling — sonst nichts.

Importiert Tagebuch-Archive mit Struktur `<YYYY>/<Monat>/<Tagesdatei>` aus ZIP. Erzeugt **ein Top-Level-Kapitel pro Jahr**, **ein Sub-Kapitel pro Monat** (parent_chapter_id zeigt aufs Jahr-Kapitel; Sub-Name-Format `YYYY Monatsname` z.B. `2020 November` — Monatsname aus der Buch-Locale via `getBookLocale`, DE/EN), **eine Seite pro Tagesdatei** unterhalb des Monat-Sub-Kapitels (Page-Name = ISO-Datum `YYYY-MM-DD`). Modi: `new-book` (Buch anlegen) oder `merge` (in bestehendes Buch importieren).

Bei `year-only`-Fallback (kein Monat ableitbar) hängt die Seite direkt am Year-Chapter, ohne Month-Sub.

**Kapitel-Gruppierung (Query-Param `grouping`, pro Import in der Karte wählbar):**

- `year-month` (Default) — Jahr-Kapitel → Monats-Sub-Kapitel → Seite pro Tag (oben beschrieben).
- `year` — nur Jahr-Top-Level-Kapitel, alle Tage hängen direkt darunter (keine Monats-Subs).
- `flat` — keine Kapitel; alle Seiten hängen kapitellos direkt am Buch (`chapter_id = null`), chronologisch sortiert. Im `merge`-Modus wird das Einlesen bestehender Kapitel übersprungen.

Unbekannte Werte fallen serverseitig auf `year-month` zurück (`GROUPINGS`-Set in [routes/jobs/folder-import.js](../routes/jobs/folder-import.js)).

## Architektur

- **Route:** `POST /jobs/folder-import` ([routes/jobs/folder-import.js](../routes/jobs/folder-import.js)). Body = raw ZIP (`application/zip`, Limit 200 MB). Query: `mode`, `book_name` (new-book) / `book_id` (merge), `grouping` (`year-month` | `year` | `flat`, Default `year-month`).
- **Buffer-Map:** ZIP landet in modulinterner `importBuffers`-Map (TTL 30 min), Worker konsumiert + cleart in `finally`.
- **Worker:** `runFolderImportJob` ist Job-Queue-konform (Pflicht: KI-Calls nur via Queue). Phasen via `updateJob({ statusText, statusParams })` als i18n-Keys (`job.folder-import.*`).
- **Parser:** [lib/import-parsers/](../lib/import-parsers/)
  - `docx.js` — `mammoth.convertToHtml`. Bilder droppen, Warnings sammeln.
  - `doc.js` — Legacy-Word (.doc, OLE) via `word-extractor`. Liefert Plain-Text → Absätze in `<p>` gewrappt. Formatting geht verloren (Trade-off für Pure-JS-Support).
  - `odt.js` — eigener Mini-Parser: ZIP-in-ZIP → `content.xml` via linkedom → Walker (h1-3, p, ul/ol, li, strong/em, br). Stil-Lookup via `office:automatic-styles` für fett/kursiv.
  - `abw.js` — AbiWord (.abw, reines XML). linkedom-Walker über `<section>/<p>/<c>`. Style-Lookup via `<styles>/<s>` für Heading-Level + Inline-Props (`font-weight:bold`, `font-style:italic`).
  - `dispatch.js` — Extension-Switch + `SUPPORTED_EXTS`-Set (`docx`, `doc`, `odt`, `abw`).
  - `date-detect.js` — Regel-basierte Datums-Heuristik. Zwei API-Layer:
    - `detectDate(filename, ctx)` — Filename + Pfad-Kontext (7 Patterns: `YYYY-MM-DD`, `DD-MM-YYYY`, `YYYYMMDD`, `DD-monthname`, `monthname-DD`, `DD-only`, `DD-anywhere`).
    - `detectDateInText(text, ctx)` — erste Text-Zeile des Dokuments. Eigene Regex-Tabelle ohne `_stripExt` (sonst frisst Extension-Strip das `.2024` am Ende einer Datumszeile). Verzichtet bewusst auf `DD-only`/`DD-anywhere` (eine einzelne Zahl in Text ist zu vieldeutig).
    - `firstLineFromHtml(html)` — erste nicht-leere Text-Zeile nach Tag-Strip.
    - `parseMonthToken(token)` — tokenize-tolerant: erkennt `November` in `November 2020`. Strikt: rein-numerische Strings → 1-12; gemischte Strings mit Zahlen → kein Monat (sonst Konflikt mit DD-anywhere-Pfad).
    - `scoreSample(samples)` für Filename-Confidence (Schwelle 80%).

### `DD-anywhere`-Fallback

Letzter Regel-Pfad bevor AI greift. Sucht im stripped Filename nach genau **einer** plausiblen Tageszahl (1-31). Aktiviert nur wenn `ctx.year` UND `ctx.month` aus dem Pfad-Kontext kommen.

Beispiele:
- `Tagebücher/2020/November 2020/Persönliches 16.docx` → `2020-11-16` ✓
- `Tagebücher/2020/November 2020/Datei 5 und 12.docx` → null (ambig: 5 oder 12?)
- `2020/November 2020/Notiz.docx` → null (keine Tageszahl)
- **AI-Fallback:** `buildDateDetectPrompt` ([public/js/prompts/import.js](../public/js/prompts/import.js)) wenn Filename-Confidence < 80%. Liefert ISO-Datum pro Datei, KI-Spend nur bei unklaren Formaten.

## Datums-Resolve-Reihenfolge (pro Datei)

1. **Filename** — `detectDate(filename, { year, month })` aus Pfad-Kontext (alle Patterns inkl. `DD-anywhere`)
2. **Erste Dokumentzeile** — `detectDateInText(firstLineFromHtml(html))`. Parse passiert deshalb VOR der Datums-Sortierung, HTML wird in `enriched[]` zwischengespeichert.
3. **AI-Map** — falls Filename-Confidence < 80% war und AI-Pass aufgerufen wurde
4. **mtime (ZIP-Entry-Modified-Date)** — Pfad-Jahr ist immer führend (User-Organisations-Intent schlägt Filesystem-Metadaten), mtime liefert nur Monat/Tag. Sanity-Cap: `mtime.year >= 1990` (filtert JSZip-Default 1980-01-01 für unset mtimes). Zwei Modi:
   - **Pfad-Monat bekannt (strict):** `mtime.year === ctx.year` Pflicht (sonst ist die mtime ein Repack-Artefakt). Pfad-Monat gewinnt, nur der Tag wird aus mtime gezogen.
   - **Pfad-Monat fehlt (relaxed):** Year-Match-Constraint fällt — mtime liefert Monat+Tag, Pfad-Jahr bleibt. Synthetisches `YYYY-06-15` (year-only) gibt sonst null Information über den Monat; mtime ist die einzige Quelle, die dem File einen echten Monat-Sub-Chapter zuweist. ZIP stört nur `mtime` (keine `ctime`), daher dieses Feld.
5. **Month-only-Fallback** — nur Jahr+Monat aus Pfad ableitbar. Synthetisches Datum `YYYY-MM-15` für Sortierung. Page-Name = `YYYY-MM <Thema>`. Thema-Quellen:
   1. **Erste Heading** (h1/h2/h3) aus dem geparsten HTML
   2. **Filename-Body** — Trenner zu Spaces, Tag-Zahl am Anfang/Ende abgeschnitten, pure-Zahl-Reste verworfen
   3. **Erste Text-Zeile** aus HTML
   4. Wenn nichts brauchbares: nur `YYYY-MM`
6. **Year-only-Fallback** — nur Pfad-Jahr ableitbar. Synthetisches `YYYY-06-15` für Sortierung. Page-Name = `YYYY <Thema>` (gleiche Thema-Pipeline).
7. **Skip** — `reason: 'NO_DATE'` (selbst Jahr nicht ableitbar)

### DD-anywhere-Robustheit

- **Underscore vor Zahl:** `persoenliches_23.abw` → `\b` matched nicht zwischen `_` und Digit. Pattern nutzt deshalb Lookarounds `(?<!\d)(\d{1,2})(?!\d)`.
- **Doppel-Extension:** `persoenliches_03.odt.docx` → Strip-Loop entfernt mehrere Alpha-Extensions, bis nur noch der Body übrig bleibt.
- **Eindeutigkeit Pflicht:** Nur wenn **genau eine** 1-31-Zahl im stripped Body steht (`Datei 5 und 12.docx` → null).

## Chapter-Hierarchie (Migration 135)

`chapters.parent_chapter_id` (FK auf `chapters(chapter_id)`, ON DELETE SET NULL). Content-Store-Backend ([lib/content-store/backends/localdb.js](../lib/content-store/backends/localdb.js)) propagiert das Feld in `createChapter`/`loadChapter`/`listChapters` und `_chapterRow`. Position-Scope bei `createChapter`: bei gesetztem `parent_chapter_id` zählt die Position innerhalb des Parents, sonst auf Top-Level. Worker-Caches:

- `chapterByYear: Map<number, chapter_id>` — Year-Chapter (Top-Level)
- `chapterByYearMonth: Map<"YYYY-MM", chapter_id>` — Month-Sub-Chapter

Im Merge-Modus werden bestehende Year- und Month-Sub-Chapter aus dem Buch eingelesen und wiederverwendet (Match via Name+Position).

**Frontend-Hinweis:** [public/js/book/tree.js](../public/js/book/tree.js) und der Book-Organizer rendern Chapter aktuell flach (alle Chapter als Siblings). Die Hierarchie liegt korrekt in der DB; eine nested-Rendering-UI ist separate Arbeit.

## Pflicht-Invarianten

- **Content-Store-Facade exklusiv** für Book/Chapter/Page-Create — HTML-Clean greift dort automatisch.
- **Job-Result `bookId`** für Frontend-Nav (lädt Buch + setzt Hash).
- **Kapitel-Cache by Year:** `chapterByYear`-Map verhindert Dubletten. Merge-Modus liest existierende Year-Chapters (Name = 4-stellige Zahl) und hängt an.
- **Sortierung chronologisch** vor Page-Create (sonst Position-Skew).
- **Duplikat-Daten** (echte Datums-Quellen `filename`/`first-line`/`ai`/`mtime`, gleicher Tag): Kollisions-Resolve in zwei Stufen.
  1. `extractTitle()` pro File: alle mit Thema → Page-Name = `YYYY-MM-DD <Thema>` (eigene Pages).
  2. Files ohne Thema werden in den ersten Eintrag des Tages **gemerged** (HTML konkateniert mit `<hr class="day-merge">`). Mixed-Fall: themaless-Files gehen ins erste themaful-Target. Garantiert: ein Tag = ein Eintrag pro „Thema", kein nackter `(2)`-Suffix mehr für reine Datums-Pages.
  - Restliches `(2)`-Suffix greift weiter für synthetische Datums-Quellen (`month-only`/`year-only`) bei identischem aufgelösten Page-Namen.
- **Datei-Limit 10 MB pro Datei**, ZIP-Limit 200 MB, Mac-Resource-Forks (`._*`, `__MACOSX/`, `.DS_Store`) gefiltert.

## Frontend

Karte [public/js/cards/folder-import-card.js](../public/js/cards/folder-import-card.js) + Partial [public/partials/folder-import.html](../public/partials/folder-import.html). Drop-Zone + File-Input. Job-Polling via `startPoll`. Hash-Permalink: `#import` (book-unabhängig, weil `new-book`-Modus kein Buch braucht).

## Skipped-Reasons

| Reason | Bedeutung |
|--------|-----------|
| `BAD_PATH` | Pfad matched nicht `YYYY/Monat/Datei` |
| `UNSUPPORTED_EXT` | Endung nicht in `SUPPORTED_EXTS` (`.docx`, `.doc`, `.odt`, `.abw`) |
| `NO_DATE` | Weder Regel noch AI konnten Datum ableiten |
| `FILE_TOO_LARGE` | > 10 MB pro Datei |
| `PARSE_FAILED` | mammoth/odt-Parser warf |
| `ZIP_READ_FAILED` | JSZip konnte Entry nicht entpacken |
| `CREATE_FAILED` | Content-Store-Page-Create warf |
