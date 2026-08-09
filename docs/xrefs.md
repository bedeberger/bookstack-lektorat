# Querverweise

„siehe Kapitel 3", „vgl. Abb. 3.2" — Verweise, die beim Rendern automatisch die richtige Nummer bekommen. Mechanisch der Zwilling der Quellenangabe ([docs/quellen.md](quellen.md)): Marker mit Zeiger im Seiten-HTML, aufgelöst im Render-Pfad.

Die harten Regeln stehen in [CLAUDE.md](../CLAUDE.md) („Editor-Blockstruktur → Querverweise"); hier stehen die Details.

## Markup

SSoT [public/js/xrefs/xref-html.js](../public/js/xrefs/xref-html.js) — erzeugen via `buildXrefHtml()`, finden via `XREF_SEL`/`isXrefEl()`/`closestXrefEl()`, auslesen via `collectXrefs()`/`xrefsByTarget()`, im Editor atomar machen via `markXrefsAtomic()`. Keine `'xref'`/`'data-xref'`/`'data-xref-id'`-Literale in JS.

```html
<span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span>
```

Ziel-Typen: `chapter` (→ `chapters.chapter_id`), `figure` und `table` (beide → `data-bid` aus `ensureBlockIds`, **kein eigenes Anker-Attribut**; Beschriftung aus `<figcaption>` bzw. `<caption>`) und reserviert `page` (braucht Zwei-Pass-Render, weil die Seitenzahl erst nach dem Umbruch feststeht).

## Nummern folgen der gerenderten Einheit

Die zentrale Invariante — schärfer als beim Quellen-Chip. „Kapitel 3" ist keine Eigenschaft des Kapitels, sondern des **Ausgabewegs**:

- PDF-Profil mit römischer Nummerierung → „Kapitel III"
- `numbering: 'none'` → der Verweis fällt auf den Kapiteltitel zurück
- Kapitel-Scope-Export → zählt ab 1

Darum ruft **jeder** Exporter [lib/xref-render.js](../lib/xref-render.js)#`applyXrefsInHtml`/`applyXrefsInGroups` auf dem Seiten-HTML, **bevor** sein Walker läuft — dieselbe Reihenfolge und derselbe Vertrag wie `resolveCitesInHtml`.

**Kein zweiter Zählautomat für Kapitel:** der PDF-Renderer reicht seine bereits für Überschriften + TOC berechneten Labels als `chapterLabels` herein ([pdf-render/numbering.js](../lib/pdf-render/numbering.js)#`computeChapterLabels` bleibt SSoT). Ausgabewege ohne eigene Kapitel-Nummerierung lassen die Map offen und bekommen die nested-arabische Vorgabe aus [xref-number.js](../public/js/xrefs/xref-number.js).

Abbildungen zählen **kapitelweise** („Abb. 3.2"); trägt auch nur eine Abbildung ein Kapitel ohne Label, kippt die **ganze** Einheit auf buchweite Zählung — sonst stünden „3.2" und „7" nebeneinander.

## Ein unauflösbarer Verweis wird nie überschrieben

Verwaistes Ziel oder Ziel ausserhalb des gerenderten Ausschnitts: der Cache-Text des Autors bleibt stehen, der Fund wird gemeldet (`meta.xrefUnresolved` im PDF-Job, Rückgabefeld `unresolved` sonst). Kein „???" im Manuskript.

## Abgeleitete Indexe, nie inkrementell

`xref_anchors` (Ziele im HTML) + `xref_links` (Verweise) werden pro Seiten-Write per Full-Replace aus dem HTML neu geschrieben ([lib/xref-index.js](../lib/xref-index.js) am Content-Store-Chokepoint, Muster `cite-index.js`). **Anker zuerst, dann Verweise** — der Buch-Guard prüft Abbildungs-Ziele gegen `xref_anchors`.

Beide Tabellen bedienen nur die Oberfläche (Ziel-Picker `GET /xrefs/targets`, Rückwärtsfrage `GET /xrefs/backlinks`); der **Renderer liest die Anker aus dem HTML, das er gerade rendert** — so stimmt der Scope automatisch und das Ergebnis hängt nicht an der Index-Frische.

## Dieselben Schutzschichten wie beim Quellen-Chip

- **Paste-Allowlist** ([utils/html.js](../public/js/utils/html.js)) — sonst zerfällt ein kopierter Satz zu einer toten Zahl.
- **LanguageTool**: `XREF_SKIP_SEL` als bewusste Kopie in [editor-spellcheck/mapping.js](../public/js/cards/editor-spellcheck/mapping.js), gegated durch [cite-guard-drift.test.mjs](../tests/unit/cite-guard-drift.test.mjs).
- **`contenteditable` nie in der Persistenz.**
- **TTS liest Querverweise bewusst MIT** — „siehe Kapitel 3" ist Teil des Satzes, anders als ein Klammerbeleg.

Nummerierte Abbildungslegenden („Abb. 3.2: …") und Tabellenbeschriftungen („Tab. 3.2: …") sind ein Render-Artefakt, gated über `book_settings.figure_numbering` bzw. `table_numbering` (buchweit, nicht pro Exportprofil — wie der Zitierstil).

**Abbildungen und Tabellen zählen GETRENNT** — zwei Zähler in [xref-number.js](../public/js/xrefs/xref-number.js), zwei Schalter. „Abb. 3.1" und „Tab. 3.1" stehen im Fachbuch nebeneinander; ein gemeinsamer Zähler machte aus der ersten Tabelle eines Kapitels „Tab. 3.4", nur weil davor drei Abbildungen stehen. Auch die Rückfallebene auf buchweite Zählung fällt pro Typ. Der Buch-Guard in [db/xrefs.js](../db/xrefs.js) prüft **Typ und Buch**: ein `data-xref="table"` auf das `data-bid` einer Abbildung bekommt keine Zeile. Details zum Tabellen-Feature: [docs/tabellen.md](tabellen.md).

## Routen und Oberfläche

```
GET /xrefs/targets?book_id=    Ziel-Picker (Kapitel + Abbildungen + Tabellen)
GET /xrefs/backlinks?…         wer verweist auf dieses Ziel
```

Einfügen im **Notebook-Editor**: [toolbar/xref.js](../public/js/editor/notebook/toolbar/xref.js), inline am Caret über die Range-API (gleiche Chromium-Falle wie beim Quellen-Chip, siehe [docs/quellen.md](quellen.md)). Focus-Editor und Bucheditor stellen Verweise dar, bringen aber keinen Einfügepfad mit.

## Tests

[xref-number](../tests/unit/xref-number.test.mjs) (Nummernvergabe, Kapitel-Kippen) · [xref-render](../tests/unit/xref-render.test.js) (Auflösung, unauflösbare Verweise) · [xref-index](../tests/unit/xref-index.test.js) (Anker/Links am Chokepoint) · [label-margin-drift](../tests/unit/label-margin-drift.test.mjs) · App-E2E [notebook-xref](../tests/e2e-app/notebook-xref.spec.js).
