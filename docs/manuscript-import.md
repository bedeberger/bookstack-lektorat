# Manuskript-Import (Word/ODT nach Überschriften-Ebenen)

Ein **einzelnes** Dokument (`.docx`, `.doc`, `.odt`, `.abw`) wird an seinen Überschriften-Ebenen in Kapitel und Seiten zerlegt. Import-Art `manuscript` in der Import-Karte, neben dem [Folder-Import](folder-import.md) (Tagebuch-ZIP) und dem [`.swbook`-Bundle](book-migration.md); die drei teilen sich Karte, Drop-Zone und Job-Polling, sonst nichts.

**Warum konfigurierbar:** Es gibt keine Konvention, an der ein Parser erkennen könnte, ob ein `h2` ein Unterkapitel oder eine Seite sein soll — das hängt daran, wie der Autor sein Dokument gegliedert hat. Eine feste Abbildung wäre für die Hälfte aller Manuskripte falsch, und die Korrektur danach wären hunderte Handgriffe im Buchorganizer. Also entscheidet der User pro Ebene, **bevor** etwas angelegt wird.

## Die fünf Rollen

Pro Ebene `h1`…`h6` genau eine Rolle:

| Rolle | Wirkung |
|---|---|
| `chapter` | Kapitel auf Ebene 1 |
| `subchapter` | Kapitel auf Ebene 2 (unter dem zuletzt geöffneten Kapitel) |
| `subsubchapter` | Kapitel auf Ebene 3 — die tiefste erlaubte |
| `page` | neue Seite im aktuell offenen Kapitel |
| `content` | keine Struktur; die Überschrift bleibt als Überschrift im Seitentext |

Default: `h1 = chapter`, `h2 = page`, `h3…h6 = content` (`DEFAULT_HEADING_MAP`). Die drei Kapitel-Rollen decken `MAX_CHAPTER_DEPTH = 3` ab (siehe [chapter-hierarchy.md](chapter-hierarchy.md)) — eine vierte Kapitel-Rolle gibt es bewusst nicht.

Dazu ein Schalter **Überschrift zusätzlich im Seitentext behalten** (`keepHeadings`): per Default trägt die Überschrift nur noch den Kapitel-/Seitennamen und verschwindet aus dem Fliesstext (sonst steht sie doppelt da — einmal als Seitenname, einmal als `<h2>` in der ersten Zeile).

## Zerlegung — SSoT [lib/import-parsers/manuscript-split.js](../lib/import-parsers/manuscript-split.js)

`splitManuscript(html, { headingMap, keepHeadings, untitledPage, untitledChapter })` ist eine **reine Funktion** über den Top-Level-Blöcken des geparsten HTML und liefert `{ nodes, chapterCount, pageCount, headingCounts, warnings }`. `nodes` ist der Baum aus `{ type: 'chapter', name, children }` und `{ type: 'page', name, html }`.

**Warum pure und warum hier:** Vorschau und Import müssen dieselbe Gliederung liefern. Läge die Logik im Job, hätte die Vorschau eine zweite Implementierung — und der User bekäme eine Zusage, die der Import nicht einhält.

Regeln, die dabei aus der Praxis kommen und nicht aus dem Datenmodell:

- **Text vor der ersten Überschrift** (Vorwort, Motto) landet auf einer eigenen Seite statt verworfen zu werden.
- **Ein Kapitel ohne Seiten-Überschrift** bekommt genau eine Seite, die den Kapitelnamen trägt — ein Kapitel ohne Seite hätte keinen Ort für seinen Text.
- **Fehlende Elternebene** (`h2 = subchapter`, aber das Dokument beginnt mit `h2`) zieht die Tiefe hoch statt das Kapitel zu verwerfen; Warnung `DEPTH_CLAMPED`.
- **Kein Text geht verloren:** eine Kapitel-Überschrift mit `keepHeadings` wartet als Prefix auf die nächste Seite des Kapitels; kommt keine, wird sie selbst zur Seite.
- **`MAX_NODES = 5000`** als Reissleine gegen entartete Dokumente (jede Zeile eine Überschrift) — Warnung `TOO_MANY_NODES`.

`countHeadings(html)` zählt die Ebenen unabhängig von der Zuordnung. Das ist die Zeile «im Dokument gefunden: 2× Überschrift 1, 4× Überschrift 2» in der Vorschau — ohne sie rät der User, welche Ebenen sein Dokument überhaupt benutzt.

Die Zuordnung reist als Positions-String `chapter,page,content,content,content,content` (`serializeHeadingMap`/`parseHeadingMap`, Position = `h1`…`h6`). Eine unbekannte Rolle und eine zu kurze Angabe fallen auf den Default zurück statt zu werfen.

## Zwei Eintrittspunkte, eine Logik — [routes/jobs/manuscript-import.js](../routes/jobs/manuscript-import.js)

- **`POST /jobs/manuscript-import/preview`** — synchron, schreibt nichts. Liefert `chapterCount`, `pageCount`, `headingCounts`, die Gliederung (Namen + Zeichenzahl, **kein** HTML — der Body eines Romans soll nicht zweimal über die Leitung) und `outlineTruncated` ab `PREVIEW_NODE_CAP = 400` Knoten. **Kein KI-Call**, darum ausserhalb der Job-Queue (Muster wie `/sources/lookup`).
- **`POST /jobs/manuscript-import`** — Job-Queue, legt an. Query: `filename` (Pflicht, bestimmt den Parser), `map`, `keep_headings=1`, `mode` (`new-book`/`merge`), `book_name` bzw. `book_id`.

Body ist in beiden Fällen das rohe Dokument (`application/octet-stream`, Limit 50 MB). Der Buffer landet in `manuscriptBuffers` (TTL 30 min) und wird vom Worker konsumiert — Muster wie der Folder-Import.

Parser sind dieselben wie dort ([lib/import-parsers/dispatch.js](../lib/import-parsers/dispatch.js), `SUPPORTED_EXTS`). Der ODT-Parser deckelt Überschriften bei `h3`; tiefere Ebenen gibt es dort also nicht zu verteilen.

### Fehlerformen

| Code | Lage |
|---|---|
| `UNSUPPORTED_EXT` | `filename` fehlt oder trägt keine unterstützte Endung |
| `EMPTY_BODY` | kein Dokument im Body |
| `DOCUMENT_TOO_LARGE` | > 50 MB |
| `PARSE_FAILED` | Parser warf (nur Vorschau; im Job wird der Job rot) |
| `BOOK_NAME_REQUIRED` / `BOOK_ID_REQUIRED` | Modus-Pflichtfeld fehlt |
| `job.error.noPagesFound` | Zerlegung ergab keine Seite — praktisch immer eine unpassende Zuordnung |

## Pflicht-Invarianten

- **Content-Store-Facade exklusiv** für Book-/Chapter-/Page-Create (HTML-Clean und Block-IDs greifen dort).
- **Namens-Dedup unter Geschwistern, nicht buchweit.** Zwei gleichnamige Überschriften nebeneinander wären im Organizer nicht unterscheidbar; dieselbe Überschrift in zwei verschiedenen Teilen dagegen schon. Kapitel und Seiten zählen getrennt — eine Seite trägt bewusst den Namen ihres Kapitels, wenn das Dokument keine eigene Seiten-Überschrift hat.
- **Die verwendete Zuordnung steht im Job-Ergebnis** (`headingMap`) und wird in der Karte angezeigt: sie ist die Erklärung dafür, warum die Gliederung so aussieht, wie sie aussieht.
- **Vorschau schreibt nie.** Sie ist der einzige Grund, warum ein Fehlgriff bei der Zuordnung keinen Import kostet.
- **`ACL`:** `merge` verlangt `editor` auf dem Zielbuch (`requireBookAccess`), `new-book` legt an und macht den User zum Owner.

## Frontend

Import-Karte [public/js/cards/folder-import-card.js](../public/js/cards/folder-import-card.js) (`importKind: 'manuscript'`) + Fragment [public/partials/folder-import-manuscript.html](../public/partials/folder-import-manuscript.html), string-seitig via `<!-- @include -->` in [folder-import.html](../public/partials/folder-import.html) eingehängt. Zuordnung als Combobox pro Ebene (`h1`–`h3` offen, `h4`–`h6` im `collapsible`-Zusatz). Jede Änderung an Zuordnung, Schalter oder Datei verwirft die Vorschau — eine Vorschau zu einer anderen Einstellung wäre eine Lüge. Hash-Permalink `#import`.

## Tests

- [tests/unit/manuscript-split.test.js](../tests/unit/manuscript-split.test.js) — Zerlegung, Rollen, Clamping, Serialisierung.
- [tests/e2e-app/manuscript-import.spec.js](../tests/e2e-app/manuscript-import.spec.js) — die Kette Combobox → Query → Vorschau → angelegte Gliederung gegen die echte App. Das Probe-Dokument wird zur Laufzeit aus der `docx`-Lib erzeugt (kein Binär-Fixture im Repo).
