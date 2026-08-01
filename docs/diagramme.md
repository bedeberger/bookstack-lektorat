# Diagramme (Mermaid)

Diagramme im Manuskript: Flussdiagramme, Abläufe, Zeitachsen, Mindmaps. Gedacht
für Sachbuch und wissenschaftliche Arbeit, nutzbar überall.

## Die zentrale Invariante: der Quelltext ist die Wahrheit

In `pages.content` steht **ausschliesslich** der Diagramm-Quelltext:

```html
<pre class="mermaid">flowchart TD
  A[Ausgangslage] --> B{Entscheidung}</pre>
```

Kein SVG, kein PNG, keine Bild-URL. Drei Gründe:

- Ein gerendertes SVG hängt an der Mermaid-Version. Persistiert trüge das
  Manuskript den Rendering-Stand vom Einfügetag bis in alle Ewigkeit, und ein
  Theme-Wechsel könnte ihn nicht mehr einholen.
- Der Quelltext ist diffbar. Ein Fassungs-Vergleich zeigt „Kante hinzugefügt",
  nicht „12 kB Binärdaten geändert".
- Dieselbe Regel wie beim Quellen-Chip: eine Schicht, die das Artefakt für die
  Wahrheit hält, friert einen Zwischenstand ein.

Daraus folgt die Arbeitsteilung: der **Browser** rendert für den Bildschirm, der
**Server** für den Export, beide aus demselben Quelltext, keiner schreibt zurück.

Und daraus folgt die zweite Invariante: **ein nicht renderbares Diagramm zeigt
seinen Quelltext**. Kein Platzhalter, kein Fehlerbild, keine Lücke. Genau dafür
ist der Träger ein `<pre>` — es fällt ohne jede Sonderbehandlung auf lesbaren
Text zurück, in jeder Schicht, die `pre` schon kennt (html-clean, Block-IDs,
PDF-Walker, alle Exporter).

## Markup-SSoT

[public/js/diagram/mermaid-html.js](../public/js/diagram/mermaid-html.js) —
erzeugen via `buildDiagramHtml()`, finden via `DIAGRAM_SEL`/`isDiagramEl()`/
`closestDiagramEl()`, auslesen via `collectDiagrams()`/`diagramCode()`, im Editor
atomar machen via `markDiagramsAtomic()`. Keine `'mermaid'`-Literale in JS.

DOM-agnostisch (Browser-DOM wie linkedom) — der Server lädt das Modul per
dynamic `import()`, Muster wie [cite-html.js](../public/js/sources/cite-html.js).

## Eingabe: nur der Notebook-Editor

Slash-Befehl `/diagramm` öffnet den **Diagramm-Dialog** (Quelltext links,
Live-Vorschau rechts, vier Startvorlagen). Code
[public/js/editor/notebook/toolbar/diagram.js](../public/js/editor/notebook/toolbar/diagram.js),
Markup [public/partials/editor-diagram-dialog.html](../public/partials/editor-diagram-dialog.html).

**Warum ein Dialog und kein Inline-Block** wie Gedicht oder Blockzitat:
Diagramm-Code ist mehrzeilig und einrückungsempfindlich. Chromium erzeugt in
einem `<pre>` im contenteditable pro Enter eine `<div>`-Zeile und bäckt beim
Verschmelzen von Blöcken berechnete CSS-Werte als Inline-`style` ein (siehe
harte Regel „Löschen an Blockgrenzen") — der Code wäre nach wenigen Handgriffen
kaputt.

Der persistierte Block ist darum **atomar**: `markDiagramsAtomic` setzt beim
Mount `contenteditable="false"`, ein Klick öffnet den Dialog erneut (Handler in
[editor-toolbar-card.js](../public/js/cards/editor-toolbar-card.js)), und der
Dialog trägt den einzigen Löschweg. `contenteditable` steht **nie** in der
Persistenz — der Server-Cleaner und die Dirty-Vergleichsform strippen es.

**Focus-Editor und Bucheditor bekommen keine Eingabe** (harte Regel
„Editor-Spezifikation"). Der Bucheditor *zeigt* Diagramme (siehe unten), der
Focus-Editor bleibt unberührt.

## Anzeige (Bildschirm)

| Oberfläche | Modul | Verhalten |
|---|---|---|
| Notebook-Leseansicht | [diagram/mermaid-view.js](../public/js/diagram/mermaid-view.js) via [notebook/card.js](../public/js/editor/notebook/card.js) | rendert; im Edit-Modus bleibt der Quelltext |
| Bucheditor | dasselbe Modul via [book-editor-card.js](../public/js/cards/book-editor-card.js) | inaktiver Block = Bild, aktiver Block = Quelltext |
| Share-Reader | [share-reader/diagrams.js](../public/js/share-reader/diagrams.js) (**bewusste Kopie**) | rendert einmal beim Laden |

Gerendert wird **nie durch Umschreiben**: der `<pre>` bleibt im DOM und wird nur
ausgeblendet (`.mermaid--rendered`), das SVG kommt als Geschwister-Knoten
(`.mermaid-render`) daneben. So bleibt der Quelltext die Wahrheit, auch wenn ein
Save-Pfad das DOM zurückliest.

Im **Bucheditor** ist das keine Kosmetik, sondern Pflicht: `_onBlockInput` liest
`el.innerHTML` in `block.html` — ein Render-Knoten im aktiven Block landete beim
ersten Tastendruck im Manuskript. Darum räumt `activateBlock` den aktiven Block
(`clearRenderedDiagrams`) und gibt dem verlassenen sein Bild zurück.

Die **Share-Reader-Kopie** ist Absicht: der Reader muss pre-auth ladbar sein und
darf nur aus `/js/share-reader/` importieren (`PUBLIC_ASSET_PREFIXES` in
[server.js](../server.js)). Dieselbe Lage wie `READER_BLOCK_SEL`. Die Vendor-Datei
selbst steht dafür einzeln in `PUBLIC_ASSETS`.

## Export

Jeder Ausgabeweg löst Diagramme **vor seinem Walker** auf — dieselbe Stelle und
derselbe Grund wie bei den Quellenangaben. Die Weiche ist `opts.diagramMode` in
[export-builders/shared.js](../lib/export-builders/shared.js)#`prepareCitations`;
die eigentliche Arbeit macht [lib/diagram-export.js](../lib/diagram-export.js).

| Ziel | Modus | Ergebnis |
|---|---|---|
| HTML | `svg` | `<figure class="diagram">` mit Inline-SVG |
| EPUB | `svg` | dito (XHTML-tauglich, weil ohne `foreignObject`) |
| PDF | `png` | `<img src="data:image/png;base64,…">` → vorhandener Bildpfad |
| DOCX | `png` | dito → `_resolvePageImages` → `ImageRun` |
| Markdown | `code` | ```` ```mermaid ````-Fence (der Ziel-Renderer zeichnet selbst) |
| Plaintext | `code` | Quelltext |
| Substack | `code` | Quelltext in `<pre>` (Substack strippt Klassen, kann kein `data:`-Bild) |
| WordPress | — | Quelltext als `wp:code`-Block, siehe unten |
| HubSpot | — | Quelltext in `<pre>` |

**Default ist `'code'`, also nichts tun.** Ein Builder, der Bilder tragen kann,
wählt aktiv `svg` oder `png`. Bewusst diese Richtung: ein vergessenes Opt-in
kostet ein Bild, ein falsches Opt-out ein kaputtes Dokument.

**PNG statt SVG bei PDF und DOCX**, weil weder pdfkit noch die docx-Lib SVG
einbetten können — beide verstehen aber `data:image/png;base64` in einem `<img>`.
Damit greifen ihre vorhandenen Bildpfade (Grössenrechnung, Seitenumbruch,
`ImageRun`) statt eines zweiten Bildmechanismus.

**Word geht nicht durch `prepareCitations`**, wenn der Word-eigene
Fussnoten-Mechanismus aktiv ist. Darum löst [docx.js](../lib/export-builders/docx.js)
die Diagramme **vor** beiden Zweigen selbst auf — läge es nur im
`prepareCitations`-Zweig, hätte ausgerechnet der Manuskript-Export für Lektorat
und Verlag keine Abbildungen.

## Blog-Sync: kein Bild, aber ein geschlossener Round-Trip

WordPress und HubSpot gehen **nicht** durch `prepareCitations`/`diagram-export` —
sie bekommen kein SVG und kein PNG, sondern den Quelltext als Codeblock
([wp-html.js](../lib/wp-html.js), [hubspot-html.js](../lib/hubspot-html.js)). Ein
Bild wäre ein Medien-Upload und damit ein eigener Mechanismus pro Plattform;
solange den keiner braucht, ist der Codeblock die ehrliche Degradation.

**Beim WordPress-Sync ist das aber nicht das Ende der Geschichte, denn er liest
zurück** (LWW-Pull). Darum schickt der Push die App-Klassen des `<pre>` als
Gutenberg-`className` mit (`<!-- wp:code {"className":"mermaid"} -->`), und der
Klassenfilter des Pulls behält genau diese Klassen — beide Richtungen lesen
`_isAppClass`, es gibt keine zweite Liste. Ohne das käme vom nächsten Pull ein
klassenloses `<pre>` zurück und machte den Diagramm-Block **im Manuskript
dauerhaft** zum gewöhnlichen Codeblock: derselbe Verlust-Mechanismus wie beim
Quellen-Chip ohne `data-src`, nur ohne Rettungsanker (der Chip behält seinen
lesbaren Text, ein Diagramm verliert sein Bild).

HubSpot braucht das nicht — dort gibt es keinen Pull zurück (einmaliger
Initial-Import, danach nur Create-Draft-Push).

## Serverseitiges Rendering

[lib/mermaid-render.js](../lib/mermaid-render.js) fährt ein Headless-Chromium über
Playwright (bereits Dependency), lädt die Vendor-Lib von der Platte und liefert
SVG **und** PNG aus einem Lauf — das Aufsetzen der Seite ist die teure Operation,
nicht das Rendern.

- **`htmlLabels: false` ist Pflicht, nicht Geschmack.** Mit HTML-Labels steckt
  mermaid `<foreignObject>` ins SVG; das rendert der Browser, aber kein
  EPUB-Reader und kein Rasterizer. Dieselbe Einstellung im Frontend, sonst sähe
  der Export anders aus als der Bildschirm.
- **`securityLevel: 'strict'`** — der Diagramm-Code ist User-Eingabe und darf
  kein Skript in die Seite tragen.
- **Kein Netzzugriff**: die Seite blockt alle Requests. Ein Diagramm, das eine
  externe URL zöge, wäre ein SSRF-Pfad.
- **Die SVG-Wurzel-ID ist inhaltsabgeleitet.** Mermaid schreibt eine
  `<style>`-Sektion ins SVG, die genau diese ID als Präfix nutzt. Eine feste ID
  kollidierte im HTML-Export und liesse den EPUB-Builder beim Deduplizieren die
  Wurzel umbenennen, während das Stylesheet auf die alte ID zeigte.
- **Non-fatal, immer.** Fehlt Chromium (`npx playwright install chromium`),
  läuft ein Timeout ab oder ist der Code ungültig, liefert das Modul `null` und
  der Exporter lässt den Quelltext stehen. Muster wie veraPDF/Ghostscript.
  Die Diagnose „Chromium fehlt" steht **einmal** im Log, nicht pro Diagramm.
- Der Browser schliesst sich nach 60 s Leerlauf.

**Cache:** `mermaid_cache` (Migration 264), inhaltsadressiert über
SHA-1(Render-Version + Theme + Quelltext). Kein Buch-, Seiten- oder User-Bezug —
dasselbe Diagramm sieht überall gleich aus. Gemessen: 807 ms für den ersten
Lauf, 2 ms für den Treffer. `last_used_at` treibt das Aufräumen; der Cache ist
rein rekonstruierbar, es geht nichts verloren.

## Was Diagramme NICHT sind: Prosa

Fünf Schichten müssen den Quelltext auslassen, sonst zählt Diagramm-Notation als
Text:

1. **Textstatistik + Volltextindex** — [lib/html-text.js](../lib/html-text.js)
   (+ Frontend-Kopie [public/js/html-text.js](../public/js/html-text.js))
   schneidet `pre.mermaid` **vor** dem Tag-Strip aus. Ohne das zählte
   `flowchart TD` als Wörter, `A[Ausgangslage] --> B` ginge in die Satzlängen des
   Rhythmus-Bands ein, und der Wortschatz führte `TD` als Lieblingswort.
   Konsumenten der SSoT sind alle Zähl-Pfade: `page_stats` (Server-Sync **und**
   Frontend-Save-Pfad), Wortschatz, FTS, Revisions-Diff, der dem Share-Leser
   gezeigte Umfang ([share-helpers.js](../lib/share-helpers.js)#`htmlToPlainLength`)
   und die Wortzahl auf dem Shunn-Titelblatt des DOCX-Exports.
2. **TTS / Vorlesen** — `TTS_SKIP_BLOCK_SEL` in
   [tts-segment.js](../public/js/tts-segment.js) verwirft Quelltext-Block **und**
   Render-Knoten. Vorzulesen wäre entweder die Notation oder die Knoten-Labels in
   Layout-Reihenfolge; beides ist kein Satz. Die Bildbeschreibung für Screenreader
   hängt am SVG (`role="img"`).
3. **LanguageTool** — `DIAGRAM_SKIP_SEL` in
   [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js).
   Anders als beim Quellen-Chip wird hier **geschnitten** statt geschützt: der
   Block steht für sich, es gibt keine Nachbar-Textknoten, die zusammenklebten.
4. **Der KI-Pfad** — die zweite, unabhängige HTML→Text-Kette in
   [routes/jobs/shared/ai.js](../routes/jobs/shared/ai.js) (`htmlToText` +
   `htmlToTextForPrompt`) ruft dieselbe SSoT-Funktion
   `stripDiagramBlocks`. Sie kann nicht `htmlToPlainText` *sein* — die
   Prompt-Variante hält Absatzgrenzen als `\n\n`, weil die Dialogformat-Regel nur
   dagegen prüfbar ist —, muss aber denselben Ausschnitt machen. Der teuerste Ort
   der Liste: hier kostet Notation echte Input-Tokens (und ließe die dem User
   gezeigte Schätzung aus `page_stats.tok` zu klein aussehen), das Lektorat
   meldete Findings auf dem Quelltext (ein angewendeter Fix schreibt in den
   Diagramm-Code), und über `loadPageContents` speist derselbe Text den
   **Embedding-Index** — Diagramm-Notation wäre eine semantisch auffindbare
   Passage, während die FTS-Hälfte derselben Hybrid-Suche sie ausschneidet.
5. Die Selektor-Kopien (Reader, TTS, LanguageTool, html-text-Regex) sind
   **bewusst** und gegated durch
   [tests/unit/mermaid-drift.test.mjs](../tests/unit/mermaid-drift.test.mjs) —
   dort liegt auch der Funktionstest des KI-Pfads.

## Pflicht-Invarianten

1. **Nur der Quelltext wird persistiert.** Kein Ausgabeweg schreibt ein
   gerendertes Artefakt in `pages.content` zurück.
2. **Nicht renderbar ⇒ Quelltext bleibt stehen.** Kein Platzhalter, keine Lücke,
   kein abgebrochener Export.
3. **`contenteditable` gehört nie in die Persistenz.** Setzt der Editor beim
   Mount, strippt der Cleaner beim Speichern.
4. **Der aktive Bucheditor-Block trägt nie einen Render-Knoten.** Sonst wandert
   er beim ersten Tastendruck ins Manuskript.
5. **`htmlLabels: false` in beiden Renderern.** Sonst ist das Export-SVG
   unbrauchbar und Bildschirm und Export driften auseinander.
6. **Neuer Exportweg ⇒ `diagramMode` setzen.** Ohne den Schalter zeigt er den
   Quelltext (korrekt, aber nicht gemeint). Und: **jeder Block-Serializer braucht
   einen `pre`-Zweig** — ein `default: return ''` lässt das Diagramm nicht auf
   den Quelltext zurückfallen, sondern verschwinden (Invariante 2).
7. **Diagramm-Notation zählt nirgends als Prosa** (die fünf Schichten oben).
   Neuer HTML→Text-Pfad ⇒ `stripDiagramBlocks` aus
   [lib/html-text.js](../lib/html-text.js), keine eigene Regex-Kette.
8. **Ein Sync-Weg, der zurückliest, muss die Diagramm-Klasse zurückbekommen.**
   Sonst degradiert der Pull den Block im Manuskript dauerhaft (siehe
   Blog-Sync-Abschnitt).
9. **Mermaid-Version aktualisieren heisst:** Vendor-Datei ersetzen, den Pfad in
   [lazy-libs.js](../public/js/lazy-libs.js), [share-reader/diagrams.js](../public/js/share-reader/diagrams.js)
   und `PUBLIC_ASSETS` in [server.js](../server.js) mitziehen und
   `RENDER_VERSION` in [lib/mermaid-render.js](../lib/mermaid-render.js) erhöhen
   (sonst liefert der Cache Bilder der alten Version). Der Drift-Test prüft die
   drei Pfade gegeneinander, die `RENDER_VERSION` nicht.

## Ops

mermaid ist mit ~3,5 MB (~1 MB gzip) die grösste Vendor-Datei im Bestand. Sie
lädt ausschliesslich on demand — wenn eine Seite tatsächlich ein Diagramm
enthält oder der Dialog geöffnet wird. `public/vendor/` liegt bewusst ausserhalb
des Shell-Precache (siehe CLAUDE.md „Shell-Cache") im generationsunabhängigen
`VENDOR_CACHE`.

Für den Export braucht der Server das Playwright-Chromium. Fehlt es, ist das
sichtbar (Log + Quelltext im Export), aber kein Fehler.
