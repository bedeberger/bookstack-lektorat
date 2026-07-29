# Publikations-Metadaten & EPUB-Export

Buch-weite Publikations-Metadaten (Cover, Titelei, Autor-Bio) leben in **`book_publication`** (1:1 zu `books`) und sind die **Single Source of Truth** für PDF-, EPUB- *und* Word-Export ([docs/word-export.md](word-export.md); DOCX nutzt die Titelei-Texte, kein Cover). Sprache bleibt SSoT in `book_settings.language` (hier nicht geführt).

## Datenmodell

`book_publication` (PK = `book_id`, FK → `books` ON DELETE CASCADE, Migration 166):

- **BLOBs:** `cover_image`/`cover_mime`, `author_image`/`author_image_mime` (sharp-gehärtet via [lib/cover-prepare.js](../lib/cover-prepare.js)).
- **Titelei (Text):** `author_name` (Publikations-/Autorname, Pseudonym — Migration 169; übersteuert in **beiden** Exporten den Account-/Owner-Anzeigenamen), `isbn`, `subtitle`, `year`, `dedication`, `imprint`, `copyright`, `frontmatter`, `author_bio`.
- **Buchhandels-Metadaten (Text, Migration 167, fliessen in EPUB-OPF):** `description` (Klappentext), `publisher`, `series` + `series_index`, `keywords` (kommagetrennt). `description` faellt im EPUB-Builder auf `books.description` zurueck, wenn leer.
- **EPUB-Reflow-Toggles:** `epub_css_style` (Schriftfamilie: `serif`|`sans`|`georgia`|`palatino`|`garamond`|`times`|`baskerville`|`helvetica`|`verdana` — CSS-Stack, kein Embedding), `epub_justify` (0/1), `epub_toc_title` (Override; leer → Sprach-Default).
- **EPUB-Typografie (Migration 168):** `epub_font_size` (`small`|`normal`|`large`), `epub_line_height` (`tight`|`normal`|`relaxed`), `epub_paragraph_style` (`indent` Belletristik | `spaced` Sachbuch), `epub_indent_size` (`small`|`medium`|`large`, nur bei `indent`), `epub_hyphenation` (0/1), `epub_drop_caps` (0/1, Initiale am Kapitelanfang).
- **EPUB-Struktur (Migration 168):** `epub_chapter_pagebreak` (0/1, `.epub-chapter-head` → `page-break-before`), `epub_nest_pages_in_toc` (0/1, Seiten eines Mehrseiten-Kapitels im TOC/NavMap), `epub_scene_separator` (`line`|`asterism`|`stars`|`blank`|`fleuron` — klassenlose `<hr>` werden in `_applyBreaks` ersetzt), `epub_titlepage_mode` (`generated`|`cover`|`none`).
- **EPUB-Kapitelnumerierung (Migration 171):** `epub_chapter_numbering` (`none`|`arabic`|`roman`|`word`) + `epub_chapter_numbering_mode` (`flat`|`nested`) — Pendant zur PDF-Option (`pdf_export_profile.config.chapter.numbering`). Das Label (`_chapterLabelNested` aus `lib/pdf-render/layout.js`, geteilt mit dem PDF-Renderer) erscheint im Inhaltsverzeichnis (NavMap + nav.xhtml) flach als `1. Kapitelname`. In der generierten Kapitelüberschrift ist es dagegen **gestapelt**: Nummer → Strich-Trenner (`———`, dekorativ `aria-hidden`) → Titel, zentriert mit grosszügigen Abständen (`.epub-chapter-title--numbered` in `EPUB_CSS_BASE`, gebaut von `chapterHeadingHtml` in `lib/export-builders/epub.js`). Der Strich-Trenner ist über `epub_chapter_number_divider` (Migration 180, Default 1 = an) abschaltbar — dann folgt der Titel direkt unter der Nummer ohne `———`; UI im „Struktur"-Tab, nur sichtbar bei aktiver Numerierung. Nicht zu verwechseln mit `epub_chapter_rule` (Strich **unter** dem ganzen Kapiteltitel). Nur numerierte Kapitel werden gestapelt; unnumerierte Kapitel und Solo-Seiten bekommen die schlichte einzeilige `<h1>`. Nur echte Kapitel zählen; Solo-Seiten ohne Kapitel bleiben unnumeriert. Eigenes Kapitel-Intro (`description_html`) ersetzt die generierte Überschrift — dort steuert der Autor das Markup, der Counter läuft trotzdem mit.
- **EPUB-Kapitel ohne Nummer (Migration 177):** `epub_unnumbered_chapter_ids` (TEXT, JSON-Array von Kapitel-IDs) — Pendant zur PDF-Option `pdf_export_profile.config.chapter.unnumberedChapterIds`. Markierte Kapitel erscheinen ohne Label in Titel + TOC; die Zählung läuft ohne Lücke weiter (unnumerierte Kapitel inkrementieren den Counter nicht, tiefere Sub-Counter werden trotzdem zurückgesetzt). Cascade: ein markiertes Top-Kapitel zieht alle Sub-Kapitel mit (`ancestorInSet` in `lib/export-builders/shared.js`, geteilte Logik mit dem PDF-Renderer `coalesce.js`). Bewusst als JSON-Konfig-Liste in einer TEXT-Spalte (kein FK) — verwaiste IDs nach Kapitel-Löschung matchen beim Render schlicht kein Kapitel. `validateMeta._idList` (in `lib/publication-meta.js`) normalisiert Array **oder** JSON-String zu deduplizierten positiven Integern (max 500); `db/book-publication.js` serialisiert beim Upsert via `_JSON_COLS`. UI: EPUB-Export-Karte → Tab „Struktur" (Multi-Combobox + entfernbare Chips, nur sichtbar wenn Numerierung aktiv).
- **EPUB-OPF-Metadaten (nur EPUB, Migration 168):** `epub_rights` (`dc:rights`), `epub_pubdate` (`dc:date`, übersteuert das Freitext-`year`), `epub_translator`/`epub_illustrator`/`epub_editor_name` (`dc:contributor` + MARC-Relator `trl`/`ill`/`edt`), `epub_uuid` (OPF-`id`/Identifier; leer → Lib-Auto-UUID). Aufgebaut in `_buildOpfExtraMeta`.
- **Selfpublishing-Belletristik (Migration 178):** `author_file_as` (Sortiername des Hauptautors „Nachname, Vorname" → file-as auf dem Lib-`#creator`, per Regex ins OPF-Template gesetzt in `_buildContentOPF`; sonst sortieren Katalog/Reader-Bibliothek unter dem Vornamen). `co_authors` (JSON `[{name, file_as}]`) → Schreib-Duos als zusätzliche `dc:creator` mit Rolle `aut` + file-as (in `_buildOpfExtraMeta`); der Anzeige-Autorenstring „A & B" steht auf Titelseite + NCX-`docAuthor`, der Lib-`#creator` bleibt der Hauptautor allein (ein `dc:creator`-Element je Person). `extra_sections` (JSON `[{placement: front|back, title, body, link_url, link_label, toc}]`) → freie Vor-/Nachsatz-Seiten (Newsletter-CTA, Auch-von, Rezensions-Bitte, Leseprobe, Danksagung, Content-Warnungen): `_buildExtraSections` rendert sie escaped (Body als Prosa via `_proseToXhtml`, optionaler CTA-Link nur bei `http(s):`/`mailto:`), `front` mit `beforeToc` zwischen Motto und Inhalt, `back` nach der Autor-Bio; im TOC nur mit Titel **und** `toc !== false`. `co_authors`/`extra_sections` sind Konfig-Blobs analog `epub_unnumbered_chapter_ids` (kein FK, JSON-TEXT, `_JSON_COLS`-Serialisierung); `validateMeta` clampt/whitelistet (max 10 Co-Autoren, 30 Sektionen). **Nur der EPUB-Builder liest sie; PDF ignoriert sie.**
- **Weitere PDF-Pendant-Optionen (Migration 179):** Spiegeln Felder aus `pdf_export_profile.config` ins reflowbare EPUB.
  - `epub_imprint_position` (`front`|`back` — `extras.imprintPosition`): Impressum vorne (nach Titelseite, `front_imprint.xhtml` via `_buildFrontmatter`) oder als Colophon ans Buchende (`back_imprint.xhtml` via `_buildImprintBackmatter`).
  - `epub_chapter_title_style` (`centered-large`|`left-rule`|`minimal` — `chapter.titleStyle`) + `epub_chapter_rule` (0/1 — `chapter.titleRule`) + `epub_page_rule` (0/1 — `chapter.pageTitleRule`): Ausrichtung/Grösse der Kapitelüberschrift via Wrapper-Klasse `.epub-chapter-head--ts-<style>` (CSS in `EPUB_CSS_BASE`); dekorativer Strich (`.epub-title-rule`) unter dem Kapiteltitel bei Stil `left-rule` **oder** `epub_chapter_rule` (nur Top-Level), unter dem Seitentitel (`.epub-page-rule`) bei `epub_page_rule`.
  - `epub_heading_font` (`match` = wie Fliesstext, sonst `serif`|`sans`|… — `font.heading.family`) + `epub_heading_scale` (`small`|`normal`|`large` — `font.heading.sizes`, `normal` = Reader-Default ohne Override): eigener Heading-Font-Stack + proportionale h1/h2/h3-Skala in `_buildCss`.
  - `epub_subchapter_pagebreak` (0/1 — `chapter.breakBeforeSubchapter`): Seitenumbruch vor Sub-Kapiteln (`.epub-chapter-head--sub`); `epub_chapter_pagebreak` greift jetzt nur noch auf Top-Kapitel (`.epub-chapter-head--top`).
  - `epub_cover_fit` (`contain`|`cover` — `cover.fit`): Cover-SVG `preserveAspectRatio` `meet` (ganz sichtbar) vs. `slice` (randfüllend/beschnitten), `<img>`-Fallback via `.cover-page--cover`.
  - `epub_numerals` (`default`|`lining`|`oldstyle` — `font.body.numerals`): `font-variant-numeric` (nur wirksam, wenn die Reader-Font das OpenType-Feature mitbringt).
  - `epub_toc_enabled` (0/1 — `toc.enabled`) + `epub_toc_depth` (INTEGER `1`|`2` — `toc.depth`): `epub_toc_enabled=false` entfernt den `toc.xhtml`-`<itemref>` aus der Spine (Lesereihenfolge) via `_finalizeEpub`, das mandatory Nav-Dokument (`properties="nav"`) bleibt fürs Reader-Menü im Manifest. `epub_toc_depth=1` blendet alle Level-1-Einträge (Sub-Kapitel + verschachtelte Seiten) aus NavMap **und** nav.xhtml aus (begrenzt auf 2, da die NavMap nur zwei Ebenen kann). UI: EPUB-Export-Karte, Tabs „Typografie" (Heading-Font/-Grösse, Ziffernstil) + „Struktur" (Rest).

Validator + Defaults: [lib/publication-meta.js](../lib/publication-meta.js) (`defaultMeta`/`validateMeta`, strict; `isValidIsbn13` non-blocking). CRUD: [db/book-publication.js](../db/book-publication.js) (`getMeta`/`upsertMeta`/`set|clear|getCover`/`…AuthorImage`).

## Pflege (UI)

Tab **Publikation** in der BookSettings-Karte ([public/partials/book-settings.html](../public/partials/book-settings.html), Methoden in [public/js/book/book-settings.js](../public/js/book/book-settings.js)). Cover-/Foto-Upload nutzt das DESIGN.md-Pattern „Bild-Upload mit Vorschau" (`.pub-image-*`). Keine eigene Karte/Registry/Hash-Router — bewusst als Tab.

**Ein Save-Button, zwei Stores:** Der Header-Save (`saveActiveTab`) schreibt auf jedem Klick **beide** Backends parallel — `book_settings` (`/booksettings`) **und** `book_publication` (`/publication`). Beide sind unabhängige Full-Replace-Writes auf getrennte Tabellen; ein Klick persistiert alles, egal in welchem Tab editiert wurde. **Why:** Tab-abhängiges Dispatch verlor stillschweigend die jeweils andere Seite (Publikation-Edit ging verloren, wenn aus einem anderen Tab gespeichert wurde). `savePublication` ist gegen `bookPublicationLoaded` geschützt — vor erfolgreichem GET kein PUT, sonst überschriebe der strikte Upsert den DB-Stand mit leeren Defaults.

## Route

[routes/publication.js](../routes/publication.js), gemountet `/publication`, ACL via `aclParamGuard` (viewer lesen, editor schreiben), `/publication` in `NEVER_CACHE_PREFIXES` ([public/sw.js](../public/sw.js)):

- `GET/PUT /publication/:book_id` — Metadaten.
- `POST/DELETE/GET /publication/:book_id/cover` + `…/author-image` — BLOBs (raw body, `prepareCover`).

**Invariante (drift-kritisch): PUT ist ein Voll-Replace, kein Merge.** `upsertMeta` → `validateMeta` startet bei `defaultMeta()` und überlagert nur gesendete Keys — jedes **fehlende** Feld fällt auf seinen Default zurück. Beide schreibenden Frontends (BookSettings-Publikation-Tab **und** EPUB-Export-Card) editieren nur einen Ausschnitt der Felder, müssen aber die **volle geladene Meta** zurückschicken, sonst löscht ein Tab die Felder des anderen (Tab editiert Titelei → würde `epub_*` killen; Card editiert Reflow → würde `author_name` killen). Mechanismus: beide spreaden die GET-Antwort (`body: { ...p }`); `validateMeta` whitelistet serverseitig, Extra-Keys (`has_cover`, `created_at`, …) werden ignoriert. Kein Hand-Listen einzelner Felder im Body — driftet bei jeder neuen Spalte.

## EPUB-Export

Builder [lib/export-builders/epub.js](../lib/export-builders/epub.js) `buildEpub(bundle, opts)` mit `opts = { lang, author, meta, cover, authorImage, tocTitle }`:

- **Cover** wird vor dem Einbetten via `prepareCoverPortrait` ([lib/cover-prepare.js](../lib/cover-prepare.js)) auf Buch-Hochformat (~1:1.6, sRGB-JPEG) **mittig gecroppt** — sonst rendert ein quadratisches/Querformat-Cover im Reader-Regal klein/letterboxed. Übergabe als `new File([buf], …)` an epub-gen-memory (`cover` akzeptiert `string|File`); die Lib legt es als `OEBPS/cover.jpeg` ab (Endung aus MIME via `mime.getExtension`, **nicht** `jpg`) und referenziert es im OPF als `image_cover`. **`_buildContentOPF` ergänzt `properties="cover-image"`** (EPUB3-konforme Cover-Kennzeichnung — die Lib emittiert nur das Legacy-`<meta name="cover">`) + eine Guide-`<reference type="cover">`.
- **Cover-Seite** (`_buildCoverXhtml`): Vollbild-`<svg>` mit `viewBox`/`preserveAspectRatio` (skaliert verzerrungsfrei). Läuft **nicht** durch die epub-gen-memory-Content-Pipeline (deren `fixHTML` lowercased Attribute → zerstört `viewBox`, und schreibt `<img src>` um) — stattdessen nach `genEpub()` via `_injectCoverPage` direkt in die ZIP injiziert: `OEBPS/front_cover.xhtml` (komplettes XHTML-Dokument mit XHTML-Namespace, nicht nur ein Fragment) + Manifest-Item `cover-page` **mit `properties="svg"`** (EPUBCheck OPF-014 verlangt das für Inline-SVG-Content-Dokumente; entfällt beim `<img>`-Fallback) + Spine-`<itemref>` als **erste Leseseite**. `mimetype` wird dabei explizit als STORE-Entry neu gesetzt (JSZip würde es beim Regenerieren sonst DEFLATE-packen → OCF-Verstoß). Mit EPUBCheck 5.3.0 verifiziert: 0 Fehler/0 Warnungen.
- **Frontmatter** (Titelseite/Impressum/Widmung/Motto) als XHTML-Entries `beforeToc: true`, **Autor-Bio** als Backmatter (+ Foto als data-URI). Aus dem custom-NCX/Nav-TOC ausgeschlossen via `__toc: false` (beide TOC-Builder filtern darauf).
- **OPF-Metadaten** aus `book_publication`: `description` (Fallback `books.description`) + `publisher` + `date` (aus `year`) als native epub-gen-memory-Optionen; `keywords` → `<dc:subject>` (eins pro kommagetrenntem Term), `series`/`series_index` → EPUB3-`belongs-to-collection` + calibre-Legacy-Meta und **`isbn` → zusätzlicher `<dc:identifier>urn:isbn:…</dc:identifier>`** (Bindestriche gestrippt, `identifier-type`-Refine onix:codelist5 `15`=ISBN-13/`02`=ISBN-10; der Package-`unique-identifier` bleibt die UUID, ISBN tritt als weiterer Identifier hinzu — vom Buchhandel/Distributoren erkannt) via **Custom-`contentOPF`** (`_buildContentOPF` injiziert Extra-Zeilen vor `</metadata>` ins zur Laufzeit gezogene Lib-Template — driftfest, kein Copy). `date` nur setzen wenn vorhanden (Lib wirft sonst bei `new Date(undefined)`).
- **Barrierefreiheits-Metadaten** (`_buildAccessibilityMeta`, EPUB Accessibility 1.1 / schema.org) werden **immer** ins OPF injiziert — Discovery-Pflicht für den EU-Vertrieb (European Accessibility Act, seit 06/2025): `schema:accessMode` (`textual`, plus `visual` nur wenn Cover/Autorfoto/Inline-`<img>` vorhanden), `accessModeSufficient`, `accessibilityFeature` (`tableOfContents`/`readingOrder`/`structuralNavigation`), `accessibilityHazard none`, `accessibilitySummary` (sprachabhängig) + `dcterms:conformsTo`-Link (WCAG 2.0 AA). Auto-generiert, keine UI-Toggles — beschreibt den strukturell sauberen reflowbaren Text faktisch; EPUBCheck validiert die Struktur separat.
- **Landmarks-nav** (`_buildLandmarksNav`): versteckter EPUB3-`<nav epub:type="landmarks">` im nav.xhtml (an `_buildTocXhtmlBody` angehängt) mit `cover` → `front_cover.xhtml` (nur wenn Cover vorhanden), `toc` → Lib-`toc.xhtml` und `bodymatter` → erste echte Inhalts-Datei (`epubChapters[0].filename`).
- **Stylesheet:** `_buildCss(meta)` baut das komplette `css`-Feld aus `EPUB_CSS_BASE` + den Reflow-/Typografie-Optionen (Schriftfamilie via `FONT_STACKS`, `font-size`/`line-height`, Einzug- vs. Absatzstil, Blocksatz, Silbentrennung, Drop-Caps, `.epub-chapter-head`-Umbruch). Ein eigenes `css`-Feld ersetzt das Lib-Default-Stylesheet komplett — darum die Lib-Defaults (Author/TOC/hr) in `EPUB_CSS_BASE` mitgeführt.
- `lang`/Autor: Autor = `book_publication.author_name` (wenn gesetzt), sonst Buch-Owner-Anzeigename — beide Pfade (Job `_resolveAuthor`, Sync). `lang` aus `book_settings.language`. Das Domain-Shape (`mapBook`) führt Autor nicht; `_resolveEpubMeta` faellt zusaetzlich auf `book.created_by`/`owned_by` zurueck.
- Inline-`<img>`: einbettbar sind `http(s)`-URLs **und** `data:`-URIs (Letzteres trägt das Autorfoto-Backmatter); alles andere wird geloggt, nicht still verworfen (`_countUnfetchableImages`).

Zwei Pfade, beide lesen `book_publication`:

- **Job** [routes/jobs/epub-export.js](../routes/jobs/epub-export.js) — `POST /jobs/epub-export` (Dedup, ACL viewer, `scope` book/chapter/page + `include_subchapters`) + `GET /jobs/epub-export/:id/file` (Stream, TTL-Map). Von der **EPUB-Export-Card** getriggert (Poll + Download). Kein KI-Call. Nach dem Render läuft **EPUBCheck** ([lib/epubcheck-validate.js](../lib/epubcheck-validate.js), W3C-Referenzvalidator) — **non-fatal**, exakt das veraPDF-Muster: fehlt das Binary, wird übersprungen (`{ available:false }`); meldet es Fehler, wird das EPUB trotzdem geliefert und das Job-Result trägt `epubcheck: { validatorAvailable, passed, errors, warnings, fatals, reason }`. Die Card zeigt bei `validatorAvailable && !passed` `epubExport.checkWarning` (8 s statt 3.5 s). Konfiguration: `EPUBCHECK_BIN` (ENV, Default `epubcheck` im PATH), `epub.validate.disabled` (app_settings → überspringt komplett).
- **Sync** [routes/export.js](../routes/export.js) `GET /export/:scope/:id/epub` — Schnellpfad, lädt `meta`/Cover/Foto lazy nur für `epub`. (Nicht mehr aus dem generischen Export-Dialog verlinkt — der reicht via `_handoffToEpubCustom()` an die Card durch.)

### EPUB-Export-Card

Eigene Karte analog Custom-PDF: [public/js/cards/epub-export-card.js](../public/js/cards/epub-export-card.js) (`Alpine.data('epubExportCard')`, registriert via `registerEpubExportCard`), Partial [public/partials/epub-export.html](../public/partials/epub-export.html), CSS [public/css/book/epub-export.css](../public/css/book/epub-export.css), Akzent `--card-accent-epubexport`. Registry-Eintrag `epubExport` in [feature-registry.js](../public/js/cards/feature-registry.js) (FEATURES + EXCLUSIVE_CARDS), Hash-View `epub`, Usage-Key `epubExport` in [routes/usage.js](../routes/usage.js).

Inhalt: Scope-Picker (Buch/Kapitel/Seite, inkl. Subkapitel-Toggle) + die **EPUB-Reflow-Toggles** (`epub_css_style`/`epub_justify`/`epub_toc_title`) live editierbar über denselben `PUT /publication/:book_id` wie der Publikation-Tab — daher wird die volle Meta geladen und vollständig zurückgeschrieben (sonst setzt der strikte Upsert isbn/subtitle/… auf Defaults). Cover/Titelei/Autor-Bio bleiben buch-weit im Publikation-Tab (Karte verlinkt dorthin). Der frühere EPUB-Export-Button im Publikation-Tab entfällt — EPUB läuft nur noch über die Card.

Handoff aus dem generischen Export-Dialog ([public/js/book/export.js](../public/js/book/export.js)#`_handoffToEpubCustom`): Event `export:epub:preset` (+ `window.__app.__epubExportPreset` als Cold-Open-Fallback) trägt den gewählten Scope rüber.

## PDF-Export liest dieselbe Quelle

Der PDF-Job ([routes/jobs/pdf-export.js](../routes/jobs/pdf-export.js)) spiegelt bei `scope==='book'` die `book_publication`-Felder vor dem Render in `profile.config.extras` (`getBookPublication`-Alias von `getMeta`); Cover/Autorfoto kommen aus `book_publication`. `pages.js`/`index.js` lesen unverändert `config.extras` — kein Render-Code-Umbau.

**Aufteilung (drift-kritisch):**

- **Buch-weit (`book_publication`):** Cover, Autorfoto, Autorname (`author_name` → PDF spiegelt ihn als `extras.authorName`, EPUB nutzt ihn als Autor — von **beiden** gelesen), ISBN, Subtitle, Jahr, Widmung, Impressum, Copyright, Frontmatter, Bio + Buchhandels-Metadaten (Description/Publisher/Series/Keywords) + **alle `epub_*`-Optionen** (Typografie/Struktur/OPF-Metadaten) + `co_authors`/`extra_sections` (Selfpublishing-Belletristik). `author_file_as` wird nur vom EPUB genutzt. **Sämtliche `epub_*`-Felder, `co_authors`/`extra_sections`/`author_file_as` sowie Description/Publisher/Series/Keywords liest ausschliesslich der EPUB-Builder — PDF ignoriert sie bewusst** (EPUB ist reflowbar, PDF hat sein eigenes Profil-Layout in `pdf_export_profile.config`).
- **Profil-spezifisch (`pdf_export_profile.config`):** Layout/Print/Fonts/TOC + Render-Toggles `barcode`, `imprintPosition` + **Rückseiten-Bild** (`back_cover_image`, Umschlag-PDF).

Die PDF-Export-Card editiert die Titelei-/Cover-Felder **nicht** mehr (Hinweis auf den Publikation-Tab).

## Quellenverzeichnis in den Exporten

Datenquelle ist [lib/bibliography.js](../lib/bibliography.js)#`buildBibliography({ bookId, pageIds, citations, userEmail })` — Einstellungen aus `book_settings` (`citation_style`, `bibliography_enabled`, `bibliography_title`, `bibliography_scope`), Quellen aus dem User-Pool `sources` (dem Buch über `book_source_links` zugeordnet), Fundstellen aus dem abgeleiteten Index `source_citations`, formatiert über die Zitierstil-SSoT [public/js/sources/format.js](../public/js/sources/format.js) (ESM, per dynamic `import()` geladen — Muster [lib/prompts-loader.js](../lib/prompts-loader.js)).

**Zwei harte Invarianten:**

- Das Verzeichnis wird **nie** in `pages.content` persistiert — es ist ein Render-Artefakt und entsteht bei jedem Export neu.
- `resolveCitesInHtml` ersetzt ausschliesslich den **Textknoten** eines Quellen-Chips; `class`/`data-src`/`data-loc` bleiben unberührt, und bei unveränderter Ausgabe kommt der Eingabe-String zurück (keine Neu-Serialisierung).

**Pflicht im Render-Pfad:** `resolveCitesInGroups(groups, bib)` läuft in [lib/pdf-render/index.js](../lib/pdf-render/index.js), **bevor** `_coalesceGroups`/der HTML-Walker die Seiten anfassen. Grund: `data-src` ist die Wahrheit, der Chip-Text nur ein Cache vom Einfüge-Zeitpunkt — im numerischen Stil steht dort noch die Autor-Jahr-Form, weil die Nummer erst beim Rendern feststeht.

**Nummern folgen der gerenderten Einheit:** `scope='book'` → Buch-Leserichtung (`listBookCitations`); `scope='chapter'/'page'` → nur die Fundstellen dieser Seiten, beginnend bei 1 (`pageIdsFromGroups(groups)` im Job). Damit stimmen Chip-Text und Verzeichnisnummer in jedem Fall zusammen.

**Jahres-Buchstaben folgen dem BUCH**, nicht der Einheit ([format/sort.js](../public/js/sources/format/sort.js)#`assignYearSuffixes`): Hat derselbe Urheber im selben Jahr zwei Titel, zeigt „(Müller, 2020)" in den Autor-Jahr-Stilen auf zwei Verzeichniseinträge gleichzeitig — APA und Chicago hängen darum einen Kleinbuchstaben an, im Kurzbeleg **und** im Eintrag (`suffixes`-Map im Rückgabeobjekt, von beiden Seiten gelesen). Vergeben wird alphabetisch nach Titel innerhalb der Gruppe, nicht nach Erstzitat — sonst verschiebt sich der Buchstabe beim Umstellen eines Kapitels. Bezugsmenge sind alle Quellen des Buchs, damit `2020a` im Kapitel-PDF dasselbe Werk meint wie im Buch-PDF. Eindeutige und undatierte Werke bleiben ohne Buchstaben; der numerische Stil bekommt keinen (die Nummer ist bereits eindeutig). Der Editor setzt beim Einfügen **keinen** Buchstaben — er hängt an allen Quellen des Buchs, nicht an der ausgewählten, und entsteht wie die Nummer erst im Render-Pfad.

**Fassungs-Export liest die Fundstellen aus dem eingefrorenen HTML** (`citationsFromGroups(groups)` in [routes/snapshots.js](../routes/snapshots.js), übersteuert `pageIds`): `source_citations` beschreibt den heutigen Seitenstand, die Fassung aber einen alten — sonst trägt ein Chip im numerischen Stil eine Nummer, die zum Verzeichnis dieser Fassung nicht passt. Die Quellen-Stammdaten bleiben bewusst live (eine korrigierte ISBN soll auch dort stimmen).

## Anmerkungsapparat (Endnoten pro Kapitel)

`book_settings.citation_notes` (Migration 256) wählt die **Belegdarstellung** — buchweit, wie `citation_style`, weil sie eine Eigenschaft des Werks ist und nicht des Exports:

| Wert | Wirkung |
|------|---------|
| `inline` (Default) | Kurzbeleg in Klammern im Fliesstext — bisheriges Verhalten |
| `endnotes` | hochgestellte Notenziffer im Text, Notenliste am Ende **jedes Kapitels** |

**Nie beide:** `prepareCitations` ([shared.js](../lib/export-builders/shared.js)) und [pdf-render/index.js](../lib/pdf-render/index.js) rufen entweder `resolveCitesInGroups` **oder** `buildEndnotes` — hintereinander würde der Notenpass den frisch gesetzten Kurzbeleg wieder überschreiben.

**Engine:** [lib/endnotes.js](../lib/endnotes.js) (DOM-Seite, linkedom) + [public/js/sources/format/notes.js](../public/js/sources/format/notes.js) (pure Note-Form). Aufteilung wie bei bibliography.js/format.js: der Server macht den Walk, die Form ist ein reines Modul.

- **Zählung pro Kapitel**, nicht pro Seite und nicht pro Buch — ein Apparat, der bei 340 anfängt, ist unlesbar. Ein Kapitel, das durch Unterkapitel in mehrere Gruppen zerfällt, zählt trotzdem durch; der Apparat hängt an der **letzten** Gruppe des Kapitels.
- **Drei Formen:** `full` (Erstnennung im Kapitel: voller Eintrag + Stellenangabe) → `ibid` (unmittelbar davor dieselbe Quelle: „Ebd."/„Ibid.", Stellenangabe nur bei Änderung) → `opCit` (im Kapitel schon belegt, aber nicht direkt davor: Kurzname + „a. a. O."/„op. cit.").
- **Kein „ders."/„dies."** — die Kurzform existiert im Deutschen nur grammatisch gegendert, und das Geschlecht einer realen Person steht nicht im Datenmodell (`authors` führt family/given/literal). Ein geratenes „Ders." vergendert Autorinnen in einem gedruckten Buch; der Apparat wiederholt stattdessen den Nachnamen, was in jedem Stil zulässig ist.
- **Belegte Blockzitate ohne eigenen Chip** bekommen ihre Note ans Ende des letzten Absatzes im Zitat — sonst wäre `<blockquote data-src>` die einzige Zitat-Kategorie ohne sichtbaren Nachweis.
- **Der Zeiger bleibt unberührt:** ersetzt wird nur der Chip-**Inhalt** (`<sup>n</sup>` statt Kurzbeleg), `data-src`/`data-loc` bleiben. Das weicht bewusst von Invariante B ab (die gilt für den Inline-Pfad). Wie das Verzeichnis ist der Apparat ein **Render-Artefakt** und wird nie persistiert — darum steht `sup` auch in keiner html-clean-Allowlist.

**Hochstellung durch alle Renderer:** der Walker ([html-walker.js](../lib/pdf-render/html-walker.js)) mappt `<sup>` auf ein Run-Flag `sup`; PDF rechnet Grösse (`SUP_SCALE`) und Grundlinien-Anhebung (`SUP_RISE`) selbst ([justify.js](../lib/pdf-render/justify.js) — pdfkit setzt `y` auf die Zeilenoberkante, nicht auf die Grundlinie, darum die Rückrechnung über die Oberlänge der Schrift), DOCX nutzt `superScript`, HTML/EPUB/Substack/Markdown geben `<sup>` aus, Plaintext die blosse Ziffer. **Bewusst keine Unicode-Hochzahlen** (¹²³): die gibt es nur für wenige Ziffern zuverlässig in jeder Schrift, und eine fehlende Glyphe wäre im PDF eine Leerstelle mitten im Satz.

**PDF-Einbau:** der Apparat ist ein zusätzliches **Item am Ende des Kapitel-Blocks**, kein eigener Block — sonst bekäme er Kolumnentitel und TOC-Eintrag und stünde als Pseudo-Kapitel im Verzeichnis. Über `isEndnotes` erbt das Item den Verzeichnis-Satz aus [body.js](../lib/pdf-render/body.js) (Font-Rolle `bibliography`, hängender Einzug).

**Nicht im Blog-Push:** [lib/wp-html.js](../lib/wp-html.js) bleibt auf dem Inline-Pfad. Ein Blog-Post ist genau eine Seite; ein Apparat „pro Kapitel" hat dort keinen Bezugsrahmen.

## Fussnoten am Seitenfuss

Dritter Wert von `citation_notes`: `footnotes`. Datenseitig identisch zu `endnotes` — derselbe Notenpass, dieselbe Nummerierung pro Kapitel, dieselben Kurzformen. Unterschied ist allein die **Platzierung**.

| Ausgabeweg | Was passiert |
|-----------|--------------|
| PDF | echter Apparat am Seitenfuss ([lib/pdf-render/footnotes.js](../lib/pdf-render/footnotes.js)) |
| DOCX | **native Word-Fussnoten** (`FootnoteReferenceRun` + `Document({ footnotes })`) — Word übernimmt Platz, Umbruch und Anzeige-Nummerierung selbst |
| EPUB · HTML · MD · TXT · Substack | Kapitelapparat wie bei `endnotes` — diese Formate haben keine Seiten ([shared.js](../lib/export-builders/shared.js)) |

**Der Hebel im PDF:** `doc.page.margins.bottom`. Das ist der einzige Wert, den *alle* Umbruchprüfungen sehen — [justify.js](../lib/pdf-render/justify.js) über `doc.page.maxY()`, Witwenkontrolle, Bild-Umbruch und DropCap über `height - margins.bottom` von Hand. Wer ihn aufbläht, verkleinert den Satzspiegel für jeden Konsumenten auf einmal. Das summiert sich nicht über Seiten: pdfkit leitet die Ränder einer neuen Seite aus `doc.options` ab, nicht von der Vorseite.

**`margins.bottom` ist der Hebel, nicht die Wahrheit.** Zurückgelesen wird er nie — [chrome.js](../lib/pdf-render/chrome.js) setzt die Ränder jeder Body-Seite am Ende auf die Basiswerte (`origMargins = outerMargins`, eine Überschreibung, keine Restauration). Die Wahrheit ist das seiteninterne Register in `footnotes.js`.

**Umbruchentscheidung:** Trägt eine Zeile Notenmarker, steckt der Platz ihrer Noten schon in der Passt-noch-Prüfung — sonst passt die Zeile, die Reserve wächst danach, und die letzte Zeile der Seite steht im Apparat. **Terminierung ist strukturell:** pro Zeile gibt es höchstens einen Seitenumbruch (kein Re-Check nach dem `addPage`), und der Deckel (`maxHeightPct`, Default 45 %) hält die Reserve unter einem Bruchteil des Satzspiegels.

**Gezeichnet wird nachgelagert**, in einem Stamp-Pass nach dem Body (Muster [stamp.js](../lib/pdf-render/stamp.js)) — der Platz ist da längst reserviert. Zwei harte Regeln dort: die Ränder für die Dauer auf 0 (sonst hängt pdfkit mitten im Stamp eine Seite an und kippt `padToEvenPages` samt Seitenzahlen), und die Notenbreite aus den **Basis**-Rändern ableiten, nie aus `doc.page.margins` (im Blockquote ist `left` verschoben).

**Mess- und Zeichenweg sind derselbe Code:** beide laufen durch `_tokenize`/`_breakLines`/`_renderLine` aus justify.js. Weichen sie um eine Zeile ab, ragt der Apparat in die Fusszeile oder die Seite verschenkt Platz.

### Was der Apparat nicht kann

- **Nummerierung pro Kapitel, nicht pro Seite.** Seitenweise ab 1 ist strukturell ausgeschlossen: die Nummer wird vor dem Layout vergeben und ihre Glyphenbreite geht in den Zeilenumbruch ein — nachträglich umnummerieren würde den Umbruch invalidieren.
- **Keine Fortsetzung auf die Folgeseite.** Eine Note über dem Deckel wird trotzdem vollständig gesetzt und kann in den unteren Rand ragen; der Job meldet das als `meta.footnoteOverflowPages` (non-fatal, Muster `dpiWarnings`).
- **Zweispaltensatz** fällt auf den Kapitelapparat zurück (`meta.footnoteFallback`) — pdfkit paginiert die Spalten selbst, es gibt dort keinen Per-Zeilen-Hook.

### Nebenbefunde, die dabei behoben wurden

Beide betrafen schon den Endnoten-Modus:

- **Marker konnte auf die falsche Seite rutschen.** `_tokenize` machte aus `Text<sup>12</sup>` zwei benachbarte Tokens ohne Leerzeichen; der Layouter brach genau dort um. Jetzt bilden sie einen **Verbund** (`parts`), der nur gemeinsam umbrochen wird.
- **Hochgestellter Satzpunkt.** Die Klebelogik hängte den Punkt *nach* dem Marker ans Marker-Token und vererbte dessen `sup`-Style. Verbund-Teile behalten jetzt ihren eigenen Style — was auch den Punkt nach `</em>` aufrecht setzt.

Ausserdem geschlossen: [dropcap.js](../lib/pdf-render/dropcap.js) und der poem/pre-Zweig in [blocks.js](../lib/pdf-render/blocks.js) setzen ihren Text aus `runs.map(r => r.text).join('')` — dort wäre eine Note **lautlos verschwunden**. Beide weichen bei einem Notenmarker auf den normalen Absatzpfad aus. Listen laufen aus demselben Grund über `_renderRunsJustified` mit `align: 'left'`.

### Die übrigen Ausgabewege

Alle Builder in [lib/export-builders/](../lib/export-builders/) rufen als erstes `prepareCitations(bundle, opts)` ([shared.js](../lib/export-builders/shared.js)) und rendern danach dessen `groups` statt `bundle.groups`. Der Helper kapselt die drei Regeln, die für jeden Weg gleich gelten: Chips auflösen, Verzeichnis nur bei `scope='book'`, ohne `opts.bibliography` unverändert durchreichen. `opts.bibliography` befüllt [lib/export-send.js](../lib/export-send.js)#`buildExportMeta` zentral für beide Sync-Routen (`/export`, Fassungs-Export).

| Weg | Verzeichnis-Form |
|-----|------------------|
| PDF (Job + Sync) | synthetische Kapitel-Gruppe, siehe unten |
| DOCX | eigener Absatz-Style `BIB_STYLE_ID`, Überschrift als Heading-1 (erscheint im Word-TOC) |
| EPUB | eigene Backmatter-Datei `back_bibliography.xhtml`, **im** Inhaltsverzeichnis (anders als Autor-Bio/Impressum), hängender Einzug via `.bibliography p` |
| HTML | `<section class="bibliography">` mit `<h2>`, hängender Einzug im Print-CSS |
| Markdown | `## <Titel>` + Einträge durch denselben Walker wie der Buchtext (kursiver Titel wird `*…*` statt rohem `<em>`) |
| Plaintext | Klartext-Form `entries[].text`, `[n]`-Präfix vorangestellt |
| Substack | Einträge durch den Block-Serializer (überlebt Substacks Paste-Filter: nur `<p>`/`<em>`) |

Eintrags-Markup kommt überall aus `bibliographyItemHtml(bib)` — die `[n]`-Spalte des numerischen Stils entsteht dort einmal, nicht je Renderer.

### PDF im Detail

**Render-Weg:** Das Verzeichnis wird als **synthetische Kapitel-Gruppe** hinter die Buchkapitel in `blocks` geschoben (`{ isChapter: true, isBibliography: true, unnumbered: true, items: [{ html: bibliographyItemHtml(bib) }] }`, Eintrags-Markup ein `<p>` pro Eintrag, im numerischen Stil mit `[n]`-Präfix). Ab da ist es ein Block wie jeder andere: `computeChapterLabels` → `tocPlan` → `renderBody` liefern Kolumnentitel, Seitenzahlen und TOC-Eintrag ohne Sonderpfad. Angehängt nur bei `bibliography_enabled` **und** `scope='book'` — bei Kapitel-/Seiten-Export werden die Chips zwar aufgelöst, aber kein Verzeichnis angehängt.

**Satz der Einträge:** eigene Font-Rolle `bibliography` ([lib/pdf-export-defaults.js](../lib/pdf-export-defaults.js), Schrift-Tab-Gruppe „Backmatter"; Profile ohne den Key fallen in [lib/pdf-render/fonts.js](../lib/pdf-render/fonts.js) auf `body` zurück) plus **hängender Einzug** statt Erstzeilen-Einzug: [body.js](../lib/pdf-render/body.js) gibt den Verzeichnis-Items einen eigenen Render-Kontext (`textRole: 'bibliography'`, `bodyFirstLineIndentPt: 0`, `hangingIndentPt`), den der Blocksatz-Layouter [justify.js](../lib/pdf-render/justify.js) pro Zeile auswertet (erste Zeile am Rand, Folgezeilen eingerückt — im numerischen Stil sitzt die Nummer damit in eigener Spalte). Der hängende Einzug hängt am Einspalten-Blocksatz-Layouter; bei `layout.columns > 1` läuft der pdfkit-Pfad und der Einzug entfällt.

## Seed

Migration 166 seedet `book_publication` je Buch aus dem Gewinner-PDF-Profil (`is_default`, sonst zuletzt aktualisiert) — Metadaten aus `config.extras` + Cover/Autorfoto-BLOBs. Hält PDF + EPUB ab Einführung konsistent.

## Tests

- Unit Quellenverzeichnis: [tests/unit/bibliography.test.mjs](../tests/unit/bibliography.test.mjs) (Buch- vs. Seiten-Scope, Nummernvergabe, `cited`/`all`, Titel-Default je Sprache, abgeschaltet → leer, Chip-Text-Ersetzung + Attribut-Invariante); PDF-Seite in [tests/unit/pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs) (eigene Seite + Outline-Eintrag, nur bei `scope='book'`, ersetzter Kurzbeleg im gerenderten Text via `extractPdfText`).
- Unit übrige Ausgabewege: [tests/unit/export-builders/bibliography.test.mjs](../tests/unit/export-builders/bibliography.test.mjs) — fährt HTML/TXT/MD/Substack/EPUB gegen **dieselbe** Zusage (frischer Kurzbeleg statt Cache, Verzeichnis nur beim Buch, abgeschaltetes Verzeichnis löst trotzdem auf, ohne `bibliography`-Option unverändert). Genau hier lief das Feature zuletzt auseinander: PDF und DOCX konnten es, der Rest nicht.
- Unit Fussnotenapparat: [tests/unit/footnotes.test.mjs](../tests/unit/footnotes.test.mjs) — Reserve/Deckel/Separator als Einheiten, dazu drei Zusagen am gerenderten PDF: jede Note auf der Seite ihres Markers, der Apparat **überlagert den Fliesstext nicht** (geometrisch über die y-Positionen aus pdf.js — im reinen Text sieht eine Überlappung genauso aus wie ein sauberer Seitenfuss), und überlange Noten werden gemeldet statt zu verschwinden. Mutationsprobe gemacht: Reserve abschalten ⇒ Geometrie-Test rot.
- Unit Anmerkungsapparat: [tests/unit/endnotes.test.mjs](../tests/unit/endnotes.test.mjs) (Zählung pro Kapitel inkl. unterbrochener Kapitel-Läufe, Ebd./a. a. O.-Auswahl, Stellenangabe nur bei Änderung, Blockzitat mit/ohne eigenen Chip, unbekannte Quelle, Zeiger-Invariante, Enum-Deckung gegen `db/schema.js`); PDF-Seite in [tests/unit/pdf-render.test.mjs](../tests/unit/pdf-render.test.mjs) (Notenziffer statt Klammerform, Apparat hinter jedem Kapitel, Vollform pro Kapitel).
- Unit Jahres-Buchstaben: [tests/unit/sources-format.test.mjs](../tests/unit/sources-format.test.mjs) (`assignYearSuffixes`: nur mehrdeutige Paare, Reihenfolge nach Titel, undatiert bleibt aussen vor, >26 Werke kollidieren nicht, Buchstabe in Kurzbeleg **und** Eintrag, numerischer Stil unberührt).
- Unit: [tests/unit/publication-meta.test.mjs](../tests/unit/publication-meta.test.mjs) (Validator/ISBN-Checksum, `author_file_as`/`co_authors`/`extra_sections`-Normalisierung), [tests/unit/epub-export.test.mjs](../tests/unit/epub-export.test.mjs) (Meta-Resolver, Frontmatter/Backmatter, Bild-Zähler, ISBN-`dc:identifier`, Accessibility-Meta, Landmarks-nav, file-as-Override + Co-Autoren-`dc:creator`, freie Vor-/Nachsatz-Seiten, genEpub-Smoke).
- E2E: [tests/e2e/publication.spec.js](../tests/e2e/publication.spec.js) (Tab, Speichern, Cover-Upload, EPUB-Download) — Harness [tests/fixtures/publication-harness.html](../tests/fixtures/publication-harness.html), Mocks in [tests/server.js](../tests/server.js).
