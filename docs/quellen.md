# Quellen & Quellenverzeichnis

Wissenschaftliches Belegen: eine **Quellen-Bibliothek pro User**, pro Buch daraus ausgewählte Quellen, Quellenangaben im Seitentext, und daraus ein Verzeichnis in jedem Ausgabeweg. Rein rückwärtsgewandt — nie generativ im Buchtext.

Die harten Regeln stehen in [CLAUDE.md](../CLAUDE.md) („Editor-Blockstruktur → Quellen-Chips"); hier stehen die Details.

## Datenmodell

| Tabelle | Rolle |
|---|---|
| `sources` | die Bibliothek. **Pool pro User** (`owner_email`), nicht pro Buch — dieselbe Literatur trägt mehrere Arbeiten. Feldschnitt CSL-JSON-nah (`csl_type`, `authors`/`editors` als JSON `[{family,given}\|{literal}]`, `container_title`, `doi`, `isbn`, …). `citekey` ist **pro Bibliothek** eindeutig, nicht pro Buch. |
| `book_source_links` | M:N-Brücke Buch ↔ Quelle. Zuordnen ist eine Buch-Operation, Anlegen eine Bibliotheks-Operation. |
| `source_citations` | abgeleiteter Fund-Index („welche Quelle wird auf welcher Seite belegt"), zusätzlich `quote_chars` + `paraphrase_count` für die Zitat-Anteil-Kennzahl. |

**Wahrheit ist der Marker im Seiten-HTML.** `source_citations` ist reine Ableitung und wird pro Seiten-Write per Full-Replace neu geschrieben ([lib/cite-index.js](../lib/cite-index.js) am Content-Store-Chokepoint, Muster `page_figure_mentions`). Nie inkrementell fortschreiben.

**Buch-Guard beim Indizieren:** eine Quelle erzeugt nur eine Fundstelle, wenn sie dem Buch der Seite **zugeordnet** ist (`INSERT … FROM book_source_links l JOIN pages p … WHERE l.book_id = p.book_id`). Fängt zwei Fälle: Seite in ein anderes Buch verschoben, und Quelle aus dem Buch entfernt während der Marker im Text stehen bleibt.

## Markup

SSoT [public/js/sources/cite-html.js](../public/js/sources/cite-html.js) — nie von Hand schreiben.

```html
<span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>
<span class="cite" data-src="7" data-mode="paraphrase">(vgl. Müller, 2020)</span>
<blockquote data-src="7"> … wörtliches Blockzitat … </blockquote>
```

**Drei Zitat-Kategorien, zwei Attribute.** Kurzzitat (wörtlich, in Anführungszeichen im laufenden Text), Blockzitat (wörtlich, ab ~3 Zeilen eingerückt + kleiner + **ohne** Anführungszeichen) und Paraphrase („vgl."). Getragen von `data-mode` am Chip (**nur `paraphrase` wird persistiert**, Abwesenheit = `quote`, damit Alt-Inhalte ohne Migration gültig bleiben und kein „vgl." in bestehende Angaben leckt) und `data-src` am `<blockquote>` (dieser Absatz ist wörtlich aus Quelle N; treibt Zitat-Typografie **und** die Kennzahl „Zitat-Anteil").

Bewusst **kein** `data-loc` am blockquote — die Stellenangabe gehört zum sichtbaren Kurzbeleg, und der steht als Chip am Ende des Blocks.

**Fundstellen-Zählung:** der Chip zählt; ein belegtes Blockzitat **ohne** eigenen Chip zählt selbst als Fundstelle (sonst gäbe es keine), mit Chip nur einmal. Ein belegtes Blockzitat in einem belegten Blockzitat wird nicht doppelt geführt. Renderer erfahren es über `block.cited` aus dem [html-walker](../lib/pdf-render/html-walker.js); Zitat-Satz ist **aufrecht** (PDF kleiner via `CITED_QUOTE_SIZE_SCALE`, DOCX ohne Kursive) — das stilistische Zitat/Motto bleibt das blockquote **ohne** Zeiger.

`data-src` am blockquote überlebt bewusst den WordPress-Push ([lib/wp-html.js](../lib/wp-html.js)), weil der Blog-Sync zurückliest (LWW-Pull) und das Blockzitat sonst beim nächsten Pull seine Quelle verliert.

## Chip-Text ist ein Cache

`data-src` ist die Wahrheit. Jeder Ausgabeweg setzt den Text beim Rendern frisch ([lib/bibliography.js](../lib/bibliography.js)#`resolveCitesInHtml`, im Anmerkungsmodus [lib/endnotes.js](../lib/endnotes.js)) — im Export steht damit immer die aktuelle Form. **In der App bleibt der gespeicherte Text stehen:** nach einem Stilwechsel oder einer Quellenkorrektur zeigt der Editor bis zum nächsten Einfügen die alte Form. Bewusst so — es gibt keinen Pass, der Seiten hinter dem Rücken des Autors umschreibt.

**`contenteditable` steht nie in der Persistenz.** Der Editor setzt es beim Mount, [lib/html-clean.js](../lib/html-clean.js)#`stripEditorUiArtefacts` strippt es beim Save, und die Dirty-Vergleichsform ([editor/shared/html-clean.js](../public/js/editor/shared/html-clean.js)#`stripLektoratMarks`) ignoriert es. Ohne **beides** gilt jede Seite mit Quellenangabe beim Öffnen als geändert und wird ungefragt gespeichert.

Das Markup-Modul ist DOM-agnostisch, damit Browser und Server (linkedom) dieselbe Parse-Logik nutzen statt zweier driftender Kopien.

## Drei Schutzschichten

Quellenangaben dürfen von den Text-Prüfern nicht angefasst werden:

- **LanguageTool** — geschützte Offset-Bereiche statt Text-Schnitt. Siehe [docs/languagetool.md](languagetool.md).
- **TTS** — Sprechtext und Highlight teilen einen Offsetraum. Siehe [docs/tts.md](tts.md).
- **Lektorat-Prompts** — `_buildBelegBlock` in [prompts/blocks.js](../public/js/prompts/blocks.js), eingehängt nur bei `hatBelege`; das Flag gehört in **beide** Pässe und in die Lektorat-Cache-Signatur.

Dazu die **Paste-Allowlist** ([utils/html.js](../public/js/utils/html.js)): `SPAN` ist ausschliesslich als Chip erlaubt, alles andere wird unwrapped — sonst zerfällt ein kopierter Satz zu reinem Text und verliert den Zeiger.

**Zwei bewusste Selektor-KOPIEN** (nicht konsolidieren): `TTS_SKIP_SEL` in [tts-segment.js](../public/js/tts-segment.js) — das Modul steht in `PUBLIC_ASSETS` und muss pre-auth ohne App-Bundle-Kanten ladbar bleiben — und `CITE_SKIP_SEL` in [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js). Beide gegen `CITE_SEL` gegated.

## Einstellungen (pro Buch, nicht pro Exportprofil)

In `book_settings`, weil der Zitierstil für **alle** Ausgabewege gleichzeitig gilt: `citation_style` (`apa7`/`chicago-ad`/`numeric`), `bibliography_enabled`, `bibliography_title` (leer = Sprach-Default), `bibliography_scope` (`cited`/`all`), `bibliography_in_blog`, `citation_notes` (`inline`/`endnotes`). Oberfläche: BookSettings-Tab „Quellen" ([book-settings-sources.html](../public/partials/book-settings-sources.html), [book-settings/citation.js](../public/js/book/book-settings/citation.js)).

## Formatierung

[public/js/sources/format.js](../public/js/sources/format.js) — pures ESM, vom Server per dynamic `import()` geladen (Muster `prompts.js`). Drei Stile, Run-Modell (`[{text, italic?}]`) als gemeinsame Basis für Klartext, HTML und die PDF/DOCX-Walker. Sprach-Bausteine („Hrsg.", „o. J.", „S.") als lang-Map im Modul, **nicht** in `i18n/*.json`: sie folgen der Sprache des **Buchs**, nicht der UI-Locale, und im Render-Pfad gibt es keinen `t()`-Kontext.

Zwei Disambiguierungen: `assignNumbers` (numerischer Stil, Nummern folgen der **gerenderten Einheit**) und `assignYearSuffixes` („2020a"/„2020b", Bezugsmenge ist das **Buch**, damit derselbe Buchstabe im Kapitel- und im Buch-PDF dasselbe Werk meint).

## Verzeichnis und Anmerkungsapparat

[lib/bibliography.js](../lib/bibliography.js)#`buildBibliography({ bookId, pageIds, … })`. Zwei harte Regeln:

1. **Das Verzeichnis wird nie in `pages.content` persistiert** — Render-Artefakt, jedes Mal neu.
2. **Entweder Kurzbeleg oder Notenziffer, nie beides.** Die Weiche steht in [export-builders/shared.js](../lib/export-builders/shared.js)#`prepareCitations`; ein zweiter Pass würde das Ergebnis des ersten überschreiben. **Jeder** Ausgabeweg geht durch diese Weiche — auch DOCX (sonst ignoriert Word als einziger Weg die Buch-Einstellung).

Einheit = das Gerenderte: Buch-Export → Buch, Blog-Push → die Seite (ein Post). Bei Kapitel-/Seiten-Export werden die Chips aufgelöst, aber **kein** Verzeichnis angehängt — ein Kapitel ist keine Publikation mit eigenem Apparat.

Angebunden: Custom-PDF ([pdf-render/index.js](../lib/pdf-render/index.js), Font-Rolle `bibliography`), Custom-DOCX (benannte Styles `Bibliography` + `Endnotes`, hängender Einzug), EPUB/HTML/MD/TXT/Substack, WordPress + HubSpot.

**Blog-Sync-Invariante:** der Push umschliesst das Verzeichnis mit `BIBLIOGRAPHY_MARKER_CLASS`, und `wpToAppHtml` entfernt es beim Pull wieder. Ohne das wandert es beim Pull in den Seitentext und der nächste Push hängt ein zweites an — es akkumuliert. Details in [docs/blog-sync.md](blog-sync.md). Ein Chip, der ohne `data-src` zurückkommt (WordPress-KSES bei fehlendem `unfiltered_html`), wird zu reinem Text degradiert und gezählt (`stats.citesDegraded`) — nie auf eine Quelle geraten.

**Fassungs-Export** liest die Fundstellen aus dem eingefrorenen HTML der Fassung, nicht aus `source_citations`: der Index beschreibt den heutigen Stand. Die Quellen-Stammdaten bleiben live (eine korrigierte ISBN soll auch dort stimmen).

## Routen

```
GET    /sources?book_id=          Quellen eines Buchs (buch-skopierte Kennzahlen)
GET    /sources/pool              die Bibliothek des Users (exclude_book für den Picker)
GET    /sources/stats             Zitat-Anteil + Deckung pro Buch
GET    /sources/citations?book_id= Fund-Index des Buchs (für die Karten-Anzeige)
GET    /sources/:id               Einzel-Quelle (Owner ODER Viewer auf einem verknüpften Buch)
GET    /sources/:id/citations     Fundstellen; OHNE book_id buchübergreifend → nur Besitzer
GET    /sources/:id/books         welche Arbeiten nutzen sie → nur Besitzer
POST   /sources                   anlegen (+ optional gleich zuordnen)
PUT    /sources/:id               ändern (PATCH-artig)
POST   /sources/:id/link          zuordnen: Editor des Buchs UND Besitzer der Quelle
DELETE /sources/:id/link          aus dem Buch nehmen (Editor); Pool-Eintrag bleibt
DELETE /sources/:id               aus der Bibliothek löschen (Besitzer)
POST   /sources/import            BibTeX/RIS (lib/bib-parse.js)
GET    /sources/lookup?doi=|isbn= Crossref/OpenLibrary-Proxy, liefert einen Entwurf
POST   /sources/from-research      Recherche-Fundstück → Quelle
```

**Sichtbarkeits-Regel:** buchübergreifende Antworten (`/:id/citations` ohne `book_id`, `/:id/books`) sind **nur** für den Besitzer. Wer nur auf einem gemeinsamen Buch Viewer ist, könnte sonst aus einer geteilten Quelle die Seiten- und Kapitelnamen der übrigen Arbeiten ableiten.

## Oberfläche

- Karte `sourcesCard` ([cards/sources-card.js](../public/js/cards/sources-card.js), Methoden [sources/manage.js](../public/js/sources/manage.js), Partials [sources.html](../public/partials/sources.html) + [sources-form.html](../public/partials/sources-form.html)).
- Einfügen im **Notebook-Editor**: [toolbar/cite.js](../public/js/editor/notebook/toolbar/cite.js). Inline am Caret über die Range-API — **nicht** `execCommand('insertHTML')`: Chromium schleust den Fragment-String durch seinen Editing-Sanitizer, verwirft `class`/`data-*` und backt die CSS-Werte als Inline-`style` ein.
- **Nachschlagen in der Leseansicht des Notebook-Editors**: Klick auf einen Chip öffnet ein read-only Popover (voller Verzeichniseintrag im Stil des Buchs, Stellenangabe, „vgl."-Marke, Belegzahl, DOI/URL, Weg ins Quellenverzeichnis). Anzeigemodell pure in [sources/cite-popover.js](../public/js/sources/cite-popover.js), Host + Klick-Pfad in [cards/editor-entities-card.js](../public/js/cards/editor-entities-card.js) (`kind: 'source'` im geteilten `.entity-popover` — dieselbe Positionierung, Scroll-Nachführung und Close-Logik wie die Figuren-/Orte-Popover), Markup in [editor-entities-panel.html](../public/partials/editor-entities-panel.html). Bewusst **nicht** an `entities_enabled` gebunden: das Flag schaltet die Figuren-/Orte-Hervorhebung, ein Quellennachweis steht unabhängig davon im Text. Der **Edit-Modus** gehört dagegen dem Picker (Chip-Klick = Beleg ändern), darum grenzt der Lese-Pfad über `editMode` ab. Die Quellenliste teilen beide über einen Fetch pro Buch ([sources/source-cache.js](../public/js/sources/source-cache.js), invalidiert über `sources:changed`/`book:changed`).
- Zeigt der Chip auf eine Quelle, die dem Buch nicht (mehr) zugeordnet ist (Seite kopiert, Quelle entfernt), sagt das Popover das — es geht nie leer auf, und es bietet dann keinen Weg ins Verzeichnis an. Ein Ladefehler ist davon getrennt: sonst behauptet ein 500er, die Quelle sei entfernt worden.
- Focus-Editor und Bucheditor stellen Chips dar und zerstören sie nicht, bringen aber weder Einfüge- noch Nachschlage-Pfad mit.
- CSS: `span.cite` in [components/manuscript-content.css](../public/css/components/manuscript-content.css) (SSoT für alle drei Oberflächen inkl. Share-Reader), Picker in [editor/notebook/edit-toolbar.css](../public/css/editor/notebook/edit-toolbar.css), Karte in [entities/sources.css](../public/css/entities/sources.css).

## Tests

[cite-html](../tests/unit/cite-html.test.mjs) (Markup, Offsets, Zitat-Kategorien) · [cite-index](../tests/unit/cite-index.test.js) (Fund-Index am Chokepoint) · [cite-popover](../tests/unit/cite-popover.test.mjs) (Anzeigemodell des Lese-Popovers, verwaister Zeiger, DOI/URL-Schranke) · [cite-guard-drift](../tests/unit/cite-guard-drift.test.mjs) (die drei Schutzschichten + Selektor-Kopien) · [sources-format](../tests/unit/sources-format.test.mjs) (Stile, Jahres-Buchstaben) · [sources-db](../tests/unit/sources-db.test.js) (Pool/Brücke/CASCADE) · [bibliography](../tests/unit/bibliography.test.mjs) + [export-builders/bibliography](../tests/unit/export-builders/bibliography.test.mjs) · [endnotes](../tests/unit/endnotes.test.mjs) · [bib-parse](../tests/unit/bib-parse.test.mjs) + [source-lookup](../tests/unit/source-lookup.test.mjs) · [wp-html](../tests/unit/wp-html.test.mjs) + [hubspot-html](../tests/unit/hubspot-html.test.mjs) (Round-Trip + Akkumulation) · [sources-import](../tests/integration/sources-import.test.js) (Endpunkte + Sichtbarkeit) · App-E2E: [notebook-cite](../tests/e2e-app/notebook-cite.spec.js), [sources-card](../tests/e2e-app/sources-card.spec.js), [reference-sources-tab](../tests/e2e-app/reference-sources-tab.spec.js).
