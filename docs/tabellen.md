# Tabellen

Tabellen im Manuskript: Eingabe über einen Gitter-Dialog, Satz in jedem Ausgabeweg, Beschriftung und Nummerierung über das Querverweis-System.

**Markup-SSoT:** [public/js/table/table-html.js](../public/js/table/table-html.js) — jeder Pfad, der Tabellen erzeugt, findet, zählt oder rendert, geht dort durch.

---

## 1 · Das Markup

```html
<table data-bid="a1b2c3d4">
  <caption>Umsatz nach Jahr</caption>
  <thead><tr><th scope="col">Jahr</th><th scope="col" data-align="right">Umsatz</th></tr></thead>
  <tbody><tr><td>2023</td><td data-align="right">1.2 Mio</td></tr></tbody>
</table>
```

Vier Festlegungen, die keine Schicht verwischen darf:

**Kein Marker-Klassenname.** Jedes `<table>` ist eine Tabelle (`TABLE_SEL = 'table'`) — anders als beim Diagramm, das sich von einem gewöhnlichen Codeblock unterscheiden muss. **Why:** Tabellen liegen schon im Bestand. Der DOCX-Import behält sie ([import-parsers/docx.js](../lib/import-parsers/docx.js), mammoth), der ODT-Import baut sie ([odt.js](../lib/import-parsers/odt.js)). Ein Marker hätte daraus Bürger zweiter Klasse gemacht, die weiterhin still zu Fliesstext plattgedrückt werden.

**Die Nummer gehört nicht in die Beschriftung.** In `<caption>` steht der Text des Autors, nie „Tab. 3.2:". Die Nummer ist eine Eigenschaft des Ausgabewegs (kapitelweise; im Kapitel-Scope-Export zählt es ab 1; ohne Kapitelnummern zählt das Buch durch) und entsteht bei jedem Export neu — [lib/xref-render.js](../lib/xref-render.js) setzt sie, genau wie bei der Abbildungslegende. Wäre sie persistiert, trüge das Manuskript die Zählung vom Einfügetag bis in alle Ewigkeit.

**Ausrichtung hat einen Träger:** `data-align` an der Zelle, und die **Kopfzelle ist für ihre Spalte autoritativ**. Die kompaktere Alternative (`data-align="l,r,r"` an der Tabelle) scheitert daran, dass CSS `text-align` nicht aus einer Spaltenangabe ableiten kann; `style` ist per harter Regel ausgeschlossen. Zwei Träger wären eine Drift-Quelle.

**Zellen tragen nur Inline-Inhalt** (Auszeichnung, Quellen-Chip, Querverweis). Keine Blöcke, keine verschachtelten Tabellen, kein `colspan`/`rowspan`. Der Gitter-Dialog erzwingt das ohnehin; für den PDF-Messer ist es die Grenze zwischen „Spaltenbreiten berechnen" und „Textsatz-Projekt". Trifft `tableModel()` auf verbundene Zellen oder Blockinhalt (Import-Markup), meldet es `lossy: true` — der Dialog warnt **vor** dem Speichern, statt still zu planieren.

**`scope="col"`** an den Kopfzellen ist Pflicht: die Angabe, aus der ein Screenreader die Spaltenzuordnung liest.

---

## 2 · Eingabe: notebook-only, Gitter-Dialog

Slash-Item `/tabelle` → [toolbar/table.js](../public/js/editor/notebook/toolbar/table.js), Partial [editor-table-dialog.html](../public/partials/editor-table-dialog.html), CSS [table-dialog.css](../public/css/editor/notebook/table-dialog.css).

**Warum ein Dialog und keine bearbeitbare Tabelle im Text:** Chromium bäckt beim Verschmelzen von Zellen die berechneten CSS-Werte als Inline-`style` ein (dieselbe Ursache wie bei den Blockgrenzen von `figure`/`blockquote`/`pre`), und `style` darf nach der Regel „Styles nur in public/css" nicht in die Persistenz. Dazu kämen Zell-Selektion, Löschen über Zellgrenzen und ein eigener Undo-Pfad.

Der Block ist deshalb **atomar** (`contenteditable="false"` via `markTablesAtomic`, gesetzt in [mount-html.js](../public/js/editor/shared/mount-html.js)) und wird ausschliesslich im Dialog bearbeitet; ein Klick darauf öffnet ihn ([editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js)). Focus-Editor und Bucheditor **stellen nur dar** — gleiche Regel wie beim Diagramm.

**Tabellen stehen bewusst NICHT in `ATOMIC_BLOCK_TAGS`.** Dort landet, was ein einzelnes Backspace am Anfang des Folgeabsatzes löschen darf (`<hr>`, `<figure>`). Eine Datentabelle so zu verlieren wäre zu teuer; der Löschweg ist der „Tabelle entfernen"-Knopf im Dialog — dieselbe Wahl wie beim Diagramm.

**Auszeichnung überlebt, solange die Zelle unangetastet bleibt.** Das Modell führt pro Zelle `{ html, text, rich }`; der Dialog bindet `text`. Ändert der Nutzer den Text, fällt `rich` auf false und die Auszeichnung wird durch den Klartext ersetzt. Eine nicht angefasste Zelle behält ihr `html` — inklusive Quellen-Chip und Querverweis.

**Geprüft wird, wo geschrieben wird.** Im Manuskript ist die Tabelle aus dem LanguageTool-Stream geschnitten (der Block ist nicht editierbar, ein Vorschlag hätte keine Schreibstelle); die Zellenfelder des Dialogs tragen `data-spellcheck="spelling"`.

---

## 3 · Zählt eine Tabelle als Prosa?

Pro Schicht eine Entscheidung. Sie ist **nicht** „überall weg" wie beim Diagramm — Zellinhalt ist Text des Autors.

| Schicht | Entscheidung | Warum |
|---|---|---|
| `page_stats.chars/words`, FTS, Revisions-Diff ([html-text.js](../lib/html-text.js)) | **zählt mit** | Wer eine Tabelle schreibt, hat geschrieben. Zellinhalt muss findbar sein. |
| Wortschatz-Analyse ([lexicon/analyze.js](../lib/lexicon/analyze.js)) | **ausgeschnitten** | MATTR, MTLD und die Lieblingswörter sind über laufenden Text definiert. Eine Spalte mit 40 Jahreszahlen ist kein Vokabular, treibt aber die Hapax-Quote und liefert „2023" als Lieblingswort. |
| Stil-Metriken ([page-index.js](../lib/page-index.js) via [routes/sync.js](../routes/sync.js)) | **ausgeschnitten** | Satzlängen, Satzanfänge, Flesch/LIX. Eine Zelle ist kein Satz. |
| Figuren-Erwähnungen | **zählt mit** | Eine in einer Zelle genannte Figur ist genannt. |
| KI-Prompt ([jobs/shared/ai.js](../routes/jobs/shared/ai.js)) | **verdichtet** | `summarizeTableBlocks` → `[Tabelle 4×3: Umsatz nach Jahr — Kopf: Jahr \| Umsatz \| Quote]`. Volltext kostet Tokens, zu denen das Lektorat nichts zu sagen hat; ganz weglassen liesse das Modell den Absatz davor als abgebrochen melden. |
| LanguageTool ([editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js)) | **geschnitten** | Siehe oben: geprüft wird im Dialog. |
| TTS ([tts-segment.js](../public/js/tts-segment.js)) | **übersprungen** | Vorgelesen wäre sie eine Folge von Zellen ohne Satzbau; der Zusammenhang der Spalten entsteht beim Hören nicht. Die Beschriftung fällt mit weg (`<caption>` liegt innerhalb der Tabelle). |

Der Ausschnitt läuft über `stripTableBlocks` — **zwei Zwillinge** ([lib/html-text.js](../lib/html-text.js) + [public/js/html-text.js](../public/js/html-text.js)), Regex-gleich, gegated durch [tests/unit/table-drift.test.mjs](../tests/unit/table-drift.test.mjs).

---

## 4 · Ausgabe

**Der Walker ist geteilt:** [html-walker.js](../lib/pdf-render/html-walker.js) liefert `{ kind: 'table', caption, align, header, rows }` — Zellen als Run-Arrays. PDF, DOCX, Markdown und Substack lesen dieselbe Blockliste. **Ein neuer Blocktyp braucht in jedem dieser Konsumenten einen Zweig**; fehlt er, fällt der Block in deren `default` und verschwindet lautlos.

| Weg | Umsetzung |
|---|---|
| **PDF** | [lib/pdf-render/table.js](../lib/pdf-render/table.js) — misst und bricht selbst, pdfkit bringt keine Tabelle mit. Spaltenbreiten aus dem natürlichen Bedarf, Zeilenumbruch in der Zelle, Seitenumbruch mit wiederholter Kopfzeile. Profil: `config.table.*` ([pdf-export-defaults/table.js](../lib/pdf-export-defaults/table.js)), Oberfläche im Apparat-Tab. |
| **DOCX** | [lib/export-builders/docx-table.js](../lib/export-builders/docx-table.js) — echte Word-Tabelle, **Word setzt sie selbst**. `tableHeader: true` lässt Word die Kopfzeile wiederholen; `cantSplit` bleibt ungesetzt, damit eine hohe Zeile umbrechen darf. |
| **HTML / EPUB** | Markup geht durch. EPUB braucht die Klassen-Abbildung (siehe unten). |
| **Markdown** | GFM-Pipe-Tabelle mit Ausrichtungszeile. Eine Tabelle ohne Kopf bekommt eine **leere** Kopfzeile — GFM rendert ohne Trennzeile keine Tabelle, und die erste Datenzeile zur Überschrift zu machen wäre eine Falschaussage. |
| **TXT** | Pipe-getrenntes Zeilenraster. Keine ausgerichteten Spalten: Plaintext hat keine garantierte Monospace-Anzeige. |
| **Substack** | HTML-Tabelle; Beschriftung als kursiver Absatz darunter (ein `<caption>` überlebt den Import nicht verlässlich). |
| **WordPress** | `wp:table` mit `<figure class="wp-block-table">`-Wrapper, **Push und Pull** — siehe unten. |

### PDF-Satz: die drei Invarianten

1. **Spaltenbreiten passen in den Satzspiegel.** Natürlicher Bedarf, bei `width: 'full'` proportional aufgefüllt; passt er nicht, proportional gekürzt, aber keine Spalte unter ihren Mindestbedarf. Letzte Sicherung skaliert alles herunter.
2. **Die Kopfzeile wiederholt sich nach jedem Seitenumbruch** (`headerRepeat`). Ohne das steht die Fortsetzung ohne Spaltenbeschriftung da.
3. **Eine Zeile darf höher sein als die Seite.** Dann bricht sie an der Textzeile und läuft weiter. Ohne diese Trennung schiebt der Layouter sie ewig auf die nächste Seite — eine **Endlosschleife**, kein Layoutfehler. Reissleine: es wird immer mindestens eine Textzeile gesetzt.

Alle drei sind in [tests/unit/pdf-table.test.mjs](../tests/unit/pdf-table.test.mjs) mutationsgeprüft (Verhalten brechen ⇒ Test rot).

### EPUB: `data-*` überlebt nicht

`epub-gen-memory` filtert jedes Attribut gegen eine feste Allowlist. Darin stehen `class`, `style`, `colspan`/`rowspan` und `aria-*` — **kein `data-*` und kein `scope`**. Jeder `[data-…]`-Selektor im EPUB-Stylesheet ist damit wirkungslos, und zwar lautlos.

`_applyDataClasses` ([epub/content.js](../lib/export-builders/epub/content.js)) bildet darum vor der Übergabe ab: `data-align` → `.ta-center`/`.ta-right`, `data-src` am belegten Blockzitat → `.cited-quote`. `scope="col"` lässt sich nicht retten (keine erlaubte Entsprechung); ein `<th>` in `<thead>` ist per HTML-Semantik ohnehin Spaltenkopf.

### WordPress: der Pull ist der kritische Weg

Gutenberg verpackt seinen Tabellenblock in `<figure class="wp-block-table">`. Der Pull entfernt „Figuren ohne Bild" — **ohne die Entpackung löscht ein Abgleich damit die ganze Tabelle aus dem Manuskript**, bei jedem Pull erneut, ohne dass jemand etwas gelöscht hätte. [wp-html.js](../lib/wp-html.js) entpackt sie deshalb **vor** dieser Regel, hebt `has-text-align-*` auf `data-align` (der Klassenfilter wirft `has-`-Klassen weg) und setzt `scope="col"` an den Kopfzellen wieder. Gegated + mutationsgeprüft in [tests/unit/wp-html.test.mjs](../tests/unit/wp-html.test.mjs).

---

## 5 · Beschriftung, Nummerierung, Verzeichnis

Läuft vollständig auf der vorhandenen Querverweis-Maschinerie — der Anker ist das `data-bid`, das [ensureBlockIds](../lib/html-clean.js) ohnehin setzt (`table` steht in `_BID_BLOCK_SEL`). Es gibt kein eigenes Anker-Attribut und keinen zweiten Write-Path.

- **Anker:** `collectAnchors` ([xref-anchor.js](../public/js/xrefs/xref-anchor.js)) liefert Abbildungen und Tabellen in **einem** Durchlauf — nur so stimmt `ord` mit der Leserichtung, wenn beide auf einer Seite gemischt stehen.
- **Nummern:** `buildXrefNumbers` ([xref-number.js](../public/js/xrefs/xref-number.js)) zählt **getrennt**. „Abb. 3.1" und „Tab. 3.1" stehen im Fachbuch nebeneinander; ein gemeinsamer Zähler machte aus der ersten Tabelle eines Kapitels „Tab. 3.4", nur weil davor drei Abbildungen stehen. Auch die Rückfallebene auf buchweite Zählung fällt **pro Typ**.
- **Schalter:** `book_settings.table_numbering` (0/1), Spiegel von `figure_numbering`. Buchweit, nicht pro Exportprofil — ob ein Werk nummeriert, ist eine Aussage über das Werk. Ohne Nummerierung fällt der Verweis auf die Beschriftung zurück („vgl. „Umsatz nach Jahr""), statt eine Zahl zu nennen, die nirgends steht.
- **Die beiden Schalter sind unabhängig, und der Vorab-Test in [applyXrefsInHtml](../lib/xref-render.js) prüft sie getrennt** (`wantFigCaptions` / `wantTableCaptions`, je mit eigenem Billig-Test auf `<figure>` bzw. `<table>` im HTML). Ein gemeinsamer Gate über `figureNumbering` **und** `<figure>` lässt zwei Fälle still durchfallen: das Fachbuch, das Tabellen nummeriert und Abbildungen nicht, und die Seite, die ausschliesslich Tabellen trägt. Beide Male bleibt die Beschriftung ohne Nummer, während [anchor-directory.js](../lib/anchor-directory.js) — die nur an `number` hängt — im Verzeichnis schon „Tab. 3.1" ausweist. Mutationsgeprüft in [xref-render.test.js](../tests/unit/xref-render.test.js).
- **Ziel-Typ:** `data-xref="table"` ([xref-html.js](../public/js/xrefs/xref-html.js)); der Buch-Guard in [db/xrefs.js](../db/xrefs.js) prüft **Typ und Buch** — ein `table`-Verweis auf das `data-bid` einer Abbildung bekommt keine Zeile.
- **Verzeichnis:** [lib/anchor-directory.js](../lib/anchor-directory.js), Quelle ist der Xref-Kontext (kein zweiter Zählautomat). In HTML, Markdown, TXT und DOCX; Sichtbarkeit wie beim Quellenverzeichnis — **nur beim ganzen Buch**.

**Offen:** im Custom-PDF fehlt das Verzeichnis. Dort gehört die Seitenzahl dazu, und die steht erst nach dem Umbruch fest — es braucht den Zwei-Pass-Mechanismus des Inhaltsverzeichnisses ([pdf-render/pages.js](../lib/pdf-render/pages.js)) plus eine Anker→Seite-Zuordnung, die der Walker heute nicht durchreicht. Im DOCX steht das Verzeichnis bewusst **ohne** Seitenzahlen (Word hat für unsere Text-Nummern kein Feld).

---

## 6 · Pflicht-Invarianten

1. Markup, Selektoren und das Auslesen **nur** über [table-html.js](../public/js/table/table-html.js). Keine `'table'`-/`'data-align'`-Literale in JS.
2. Die Nummer steht **nie** in `<caption>`.
3. Ausrichtung hat **einen** Träger: `data-align` an der Zelle, Kopfzelle autoritativ.
4. Eingabe ist **notebook-only**. Die anderen zwei Editoren stellen dar.
5. `contenteditable` steht **nie** in der Persistenz (Editor setzt beim Mount, [html-clean.js](../lib/html-clean.js) strippt beim Speichern).
6. Abbildungs- und Tabellen-Nummerierung werden **getrennt gegated** — je eigener Schalter, je eigener Vorab-Test auf das Markup. Kein gemeinsamer `figureNumbering`-Gate.
7. Der PDF-Satz bricht Zeilen, die höher als die Seite sind — sonst Endlosschleife.
8. Der WordPress-Pull entpackt `figure.wp-block-table` **vor** der „Figuren ohne Bild"-Regel.
9. Ein neuer Blocktyp im geteilten Walker braucht einen Zweig in **jedem** Konsumenten (PDF, DOCX, Markdown, Substack).
10. Die vier bewussten Selektor-Kopien (`stripTableBlocks` ×2, `TTS_SKIP_BLOCK_SEL`, `TABLE_SKIP_SEL` im LanguageTool-Mapping) dürfen existieren, aber nicht driften — gegated durch [tests/unit/table-drift.test.mjs](../tests/unit/table-drift.test.mjs).

---

## 7 · Tests

[table-html](../tests/unit/table-html.test.mjs) (Markup-Vertrag, Round-Trip, verlustbehaftete Fälle) ·
[table-drift](../tests/unit/table-drift.test.mjs) (die vier bewussten Selektor-Kopien + die Schicht-Entscheidungen) ·
[pdf-table](../tests/unit/pdf-table.test.mjs) (Spaltenbreiten, Seitenumbruch, Endlosschleifen-Schutz — **mutationsgeprüft**) ·
[anchor-directory](../tests/unit/anchor-directory.test.mjs) (Verzeichnis) ·
[pdf-html-walker](../tests/unit/pdf-html-walker.test.mjs) (Block-Erzeugung, colspan) ·
[export-builders/builders](../tests/unit/export-builders/builders.test.mjs) (alle Ausgabewege gegen dieselbe Zusage) ·
[wp-html](../tests/unit/wp-html.test.mjs) (WordPress-Round-Trip, **mutationsgeprüft**) ·
[xref-number](../tests/unit/xref-number.test.mjs) + [xref-index](../tests/unit/xref-index.test.js) (getrennte Zähler, Typ-Guard) ·
App-E2E [notebook-table](../tests/e2e-app/notebook-table.spec.js) (Gitter-Dialog gegen die echte App — die verschachtelten `x-for` fängt keine andere Schicht).
