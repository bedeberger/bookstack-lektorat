# Journalistisches Arbeiten

Der Buchtyp `journalismus` macht aus einem Werk ein Ressort: jede Seite ist ein
Beitrag mit eigener Textsorte, und der Apparat drumherum ist redaktionell statt
literarisch. `blog` ist der zweite publizistische Typ — er teilt den Titelapparat
und die Freigabe-Stufen, hat aber WordPress statt Druck als Ziel.

Diese Datei beschreibt die **redaktionelle Werkbank**. Was daneben liegt und
eigene Dokus hat: [quellen.md](quellen.md) (Belegen, inkl. der O-Ton-Felder an
der Quelle), [blog-sync.md](blog-sync.md), [semantic-search.md](semantic-search.md).

## Buchtyp-Gate

`lib/buchtyp.js` ist die SSoT der serverseitigen Typ-Gates. Zwei bewusst
getrennte Fragen:

| Helper | Typen | Wofür |
|---|---|---|
| `isBlogBook` / `requireBlogTypeRoute` / `assertBlogBook` | `blog` | Blog-**Sync** (WordPress, HubSpot) — eine Anbindung |
| `isJournalisticBook` | `journalismus`, `blog` | der redaktionelle **Apparat** — Titel, Freigabe, Transkription |

**Warum getrennt:** redaktionell arbeiten kann man ohne Anbindung. Ein Ressort
ohne WordPress braucht Dachzeile und Freigabe genauso.

Im Frontend läuft das Gate über `requiresBuchtyp` in
[feature-registry.js](../public/js/cards/feature-registry.js) — das Feld nimmt
**einen Key oder eine Liste**. Alle drei Stellen (Palette-Sichtbarkeit,
Verfügbarkeit, Toggle) fragen `matchesRequiredBuchtyp`; ein nachgebautes `===`
irgendwo daneben lässt eine Karte in der Palette erscheinen, die der Toggle
verweigert.

---

## Titel-Werkstatt

**Dachzeile, Titel, Lead und Teaser sind Metadata der Seite, nicht ihre ersten
Absätze.** Das ist der ganze Punkt: stehen sie im Fliesstext, sind sie für jede
Maschine Prosa — sie zählen in die Zeichenstatistik, in den Wortschatz und ins
Lektorat, der Blog-Sync muss den Titel aus der ersten Zeile raten, und ein
Zeichenlimit lässt sich gar nicht prüfen, weil niemand weiss, wo der Titel
aufhört. Als Spalten sind sie adressierbar.

### Datenmodell (Migration 269)

- **`page_headline`** — der geltende Stand, genau eine Zeile je Seite.
- **`page_headline_variants`** — die Kandidaten daneben, beliebig viele, je mit
  `feld` (CHECK) und `herkunft` (`user`|`ki`).

Zwei Tabellen, weil zwei verschiedene Dinge: eine Variante ist kein halber Titel,
sondern ein Vorschlag. Zusammengelegt (etwa über ein `aktiv`-Flag) wäre jede
Leseabfrage ein Filter, und „genau einer ist aktiv" nur noch Konvention statt
Constraint.

**Übernehmen tauscht.** `promoteVariant` macht die Variante zum geltenden Stand
**und sichert den bisherigen als Variante** — jede Übernahme bleibt umkehrbar,
ohne dass es dafür eine eigene Undo-Historie braucht.

**Teil-PUT ist Pflicht-Semantik:** `setHeadline` schreibt nur die *übergebenen*
Felder. Ohne diese Unterscheidung leerte ein Speichern aus einer alten
Tab-Sitzung die inzwischen woanders gesetzten Felder. Sind am Ende alle vier
leer, fällt die Zeile ganz weg (sonst zählt „wie viele Beiträge haben schon
einen Titel" falsch).

### Zeichenlimits sind Anzeige, keine Validierung

SSoT: [public/js/headline/channels.js](../public/js/headline/channels.js) —
`print` · `web` · `seo` · `social`, je mit Limits pro Feld.

**Der Server kennt diese Limits nicht, und das ist Absicht.** Ein zu langer Titel
ist kein Fehler, sondern ein noch nicht fertiger Titel; die Werkstatt zeigt an,
in welche Kanäle eine Formulierung passt, und kürzt nichts. Es gibt deshalb
**bewusst keinen CJS-Spiegel** dieser Datei — serverseitig bräuchte sie niemand.

Ein Feld ohne Limit in einem Kanal (eine Dachzeile in der Suchergebnis-Vorschau)
fehlt dort schlicht: kein Limit heisst „gilt nicht", nicht „unbegrenzt".

### KI-Varianten

Job `POST /jobs/headline-variants` ([routes/jobs/headline.js](../routes/jobs/headline.js)),
Prompt [prompts/headline.js](../public/js/prompts/headline.js), Rolle
`SYSTEM_HEADLINE` in [prompts/core.js](../public/js/prompts/core.js).

- **Ein Beitrag pro Lauf, kein Buch-weiter Modus.** Titelarbeit ist
  Einzelstückarbeit; ein Stapellauf über vierzig Beiträge produziert vierzig
  Listen, die niemand durchsieht, und kostet vierzig Calls.
- Der Prompt kennt die **Textsorte** — ein Titel folgt nicht aus dem Text,
  sondern aus der Form. Ohne sie bekommt man vier Varianten desselben braven
  Sachtitels.
- Der **Bestand** (geltender Stand + vorhandene Varianten) geht mit in den
  Prompt, sonst liefert der zweite Lauf dieselben naheliegenden Formulierungen.
- Vorschläge landen als Varianten (`herkunft='ki'`), **übernommen wird von
  Hand**. Ein Titel ist eine redaktionelle Entscheidung.

### Blog-Sync

[routes/jobs/blog-sync.js](../routes/jobs/blog-sync.js) im Push-Pfad: ist ein
Titel bzw. Teaser gesetzt, gewinnen sie über den abgeleiteten Seitennamen und
gehen als `title`/`excerpt` an WordPress. **Nur gesetzte Felder** — ohne
Titel-Werkstatt bleibt der Push Byte für Byte der alte, und ein leeres Feld darf
einen in WordPress gepflegten Titel nicht überschreiben.

### Karte

`titelwerkstatt` ([public/js/cards/titelwerkstatt-card.js](../public/js/cards/titelwerkstatt-card.js),
Methoden [book/titelwerkstatt.js](../public/js/book/titelwerkstatt.js), Partial
[titelwerkstatt.html](../public/partials/titelwerkstatt.html)). Übersichtstabelle
aller Beiträge (`sortableTable`), aufgeklappte Zeile mit den vier Feldern,
Kanal-Linealen und Varianten. Gespeichert wird beim **Verlassen des Feldes**, nicht
bei jedem Anschlag — sonst bewegte sich `pages.updated_at` im Sekundentakt, woran
unter anderem die Stale-Erkennung des Redaktions-Status hängt.

---

## Redaktions-Status

Rohfassung → gegengelesen → schlussredigiert → freigegeben. Plakette pro Zeile im
**Buchorganizer**.

**Neben den Fassungen, nicht in ihnen:** eine Fassung
([fassungen.md](fassungen.md)) ist ein Zustand des TEXTES (Archiv,
wiederherstellbar), der Redaktions-Status eine Aussage über den PROZESS („darf
das raus?"). Die Fassungs-Mechanik bleibt unangetastet.

### Datenmodell (Migration 268)

`page_editorial_status` — eine Zeile je Seite, CHECK über die vier Stufen,
`updated_by` als FK auf `app_users(email)`.

SSoT der Kette: [public/js/redaktion/status.js](../public/js/redaktion/status.js)
(ESM) mit CJS-Spiegel in [db/redaktion.js](../db/redaktion.js). Die Liste ist
**geordnet** — sie ist der Weg durch die Redaktion, nicht eine Menge erlaubter
Werte; daraus kommen Anzeige-Reihenfolge und `statusRank`.

### Die Stale-Erkennung ist der Kern

Eine Freigabe auf einem Text, der sich seither geändert hat, ist keine Freigabe
mehr — „freigegeben" auf einem inzwischen überarbeiteten Beitrag ist die
gefährlichste Anzeige, die dieses Feature haben kann. Darum hält
`content_updated_at` fest, **worauf** sich der Status bezog, und `_mapRow`
berechnet `stale` an **genau einer Stelle**.

**Anker ist `pages.updated_at`, nicht `page_stats.content_sig`.** Den
Signatur-Index schreibt nur der Sync-Cron
([lib/page-index.js](../lib/page-index.js)#`writePageIndex`, gerufen aus
[routes/sync.js](../routes/sync.js)); ein vor einer Stunde überarbeiteter Beitrag
sähe darüber weiterhin „freigegeben, unverändert" aus.

Der Anker kommt aus der Seite, **nie vom Aufrufer** — sonst könnte ein Client
einen Status auf einen Textstand stempeln, den es nie gab.

### Route

`GET /redaktion/:book_id` (ab `viewer` — ein Gegenleser muss den Stand sehen),
`PUT /redaktion/page/:page_id` (ab `editor` — eine Stufe weiterzuschalten ist
eine Entscheidung). Nicht-journalistische Bücher bekommen `enabled: false` mit
leerer Map statt eines Fehlers: die Organizer-Zeile fragt unabhängig vom Buchtyp
und soll nicht in einen Fehlerpfad laufen.

---

## Interview-Transkription

Aufnahme hochladen → Wortlaut mit Zeitmarken (und Sprechern, wenn das Backend
sie liefert) → O-Töne per Klick in den Artikel.

### Das Transkript IST ein Recherche-Fundstück

`research_items.kind = 'transcript'`, der Volltext in `doc_text`. **Genau dadurch
ist es ohne eine Zeile Extra-Code durchsuchbar:** FTS
([lib/search.js](../lib/search.js)#`upsertResearch`) und Embedding-Index
(`semantic_chunks`, kind `research`) hängen bereits an diesem Feld. Eine eigene
Transkript-Tabelle mit eigenem Textfeld hätte beide Indexe erneut anschliessen
müssen.

`kind` bekam dafür in Migration 270 einen neuen Wert (Recreate-Pattern, weil
SQLite CHECK-Constraints nicht per ALTER ändert). Bewusst **nicht** `'document'`
mit Audio-Anhang: die Oberfläche muss ein Gespräch von einem PDF unterscheiden
können, und ein `kind`, das zwei Dinge meint, ist an jeder Abfrage eine
Fallunterscheidung.

Daneben drei Tabellen: `interview_transcripts` (Audio + Lauf-Metadaten, eigene
Tabelle wegen des BLOBs), `interview_segments` (Full-Replace pro Lauf),
`interview_speakers` (Handarbeit — **überlebt** einen zweiten Lauf, weil sie am
Sprecher-Schlüssel hängt, nicht an den Segment-Zeilen).

### Sprechertrennung wird nicht geraten

[lib/interview-transcribe.js](../lib/interview-transcribe.js) schickt
`diarize=true` an den OpenAI-kompatiblen Whisper-Endpunkt und **wertet aus, was
kommt**: Segmente mit `speaker` → Sprechertrennung (`diarisiert = true`), ohne →
ein Sprecher, und die Karte sagt das ausdrücklich.

**Es gibt keinen Fallback, der Sprecherwechsel aus Sprechpausen rät.** Eine
erfundene Zuordnung im Interview ist schlimmer als gar keine: sie legt einer
Person Sätze in den Mund, die eine andere gesagt hat.

Reines faster-whisper kann keine Diarisierung; WhisperX, whisper-diarization und
einige speaches-Builds können sie. Host/Model/Key sind **dieselbe Konfiguration
wie das Diktat** (`stt.*`, siehe [stt.md](stt.md)) — ein zweiter Host wäre ein
zweiter Ort, an dem dasselbe stehen muss.

### Job statt Sync-Proxy

`POST /jobs/interview-transcribe`. Abgrenzung zum Diktat: dort geht ein
Sprechpausen-Segment von Sekunden synchron durch, hier eine Aufnahme von einer
Stunde — das dauert Minuten. **Kein `callAI`**: Whisper transkribiert, es
formuliert nicht; kein Token-Budget, kein Prompt. Die Job-Queue liefert nur
Lifecycle, Fortschritt und Wiederaufnahme.

Der Fehler landet **an der Transkript-Zeile** (`status='error'`, `fehler`), nicht
nur im Job-Protokoll: die Karte zeigt das Fundstück weiter an und muss sagen
können, warum dort kein Wortlaut steht.

Whisper schneidet alle paar Sekunden; `mergeBySpeaker` fasst zu **Redebeiträgen**
zusammen (Deckel `maxChars`, sonst wäre ein Monolog ein unzitierbarer Block). Die
Zeitmarke des Beitrags spannt vom ersten bis zum letzten Schnipsel.

### O-Töne in den Artikel

**Im Referenz-Panel neben dem Editor**, nicht im Recherche-Board: das Board ist
eine Hauptkarte und schliesst den Editor, in den der O-Ton soll. Links das
Gespräch, rechts der Text.

Ein Klick auf einen Redebeitrag (`POST /research/:id/oton`) legt eine **Quelle vom
CSL-Typ `interview`** an bzw. verwendet die des Sprechers wieder, und setzt den
Beitrag als **belegtes Blockzitat** in den Artikel — dasselbe
`<blockquote data-src>` + `span.cite`, das auch der Quellen-Picker erzeugt
([cite-html.js](../public/js/sources/cite-html.js) bleibt die einzige
Markup-Quelle, `insertOTonBlock` in
[toolbar/cite.js](../public/js/editor/notebook/toolbar/cite.js) der Einfügeweg).

Daraus folgt ohne Zutun: der O-Ton trägt bis ins Quellenverzeichnis, in den
Anmerkungsapparat, in die Zitat-Anteil-Kennzahl und in jeden Exportweg, und die
Warnung bei fehlender Zitatautorisierung (`oton_auth`, siehe
[quellen.md](quellen.md)) greift wie bei jeder anderen Quelle. Ein zweiter
Zitat-Träger daneben müsste all das nachbauen.

- **Die Stellenangabe ist die Zeitmarke.** Bei einem Gespräch ist sie das, was
  die Seitenzahl bei einem Buch ist.
- **`oton_auth` startet auf `ausstehend`** — ein frisch aus dem Transkript
  gezogener O-Ton *ist* unautorisiert. Das ist kein Platzhalter.
- **Ohne benannten Sprecher kein O-Ton** (`400 SPEAKER_UNNAMED`): ein Zitat
  braucht eine Person, der es zugeschrieben wird.
- Die Route legt **nur die Quelle** an und liefert Text und Stellenangabe zurück
  — ins Manuskript schreibt sie nicht. Wo ein O-Ton steht, entscheidet der Autor
  (gleiche Trennung wie bei der Quellen-Erkennung).
- Kanal und Datum des Gesprächs werden **nicht geraten**; das Quellen-Formular
  fragt sie ab, und ein leeres Feld ist dort sichtbar, eine erfundene Angabe
  nicht.

Trampolin `EVT.EDITOR_OTON_INSERT`: das Referenz-Panel löst aus, die
Editor-Toolbar fügt ein (dort liegt die Markup-SSoT). `detail.ack` trägt die
Ja/Nein-Antwort synchron zurück — `dispatchEvent` läuft synchron, ein
Rückkanal-Event wäre für eine Ja/Nein-Antwort zu viel Apparat.

### Sprecher benennen

Aus `SPEAKER_01` wird «Maria Keller, Stadträtin». Danach setzt der Server den
**Volltext neu**, damit der Name auch in Suche und Semantik-Index steht — sonst
fände man das Zitat nur unter dem Schlüssel, den niemand kennt.

Erlaubt sind nur Schlüssel, die in den Segmenten vorkommen (`UNKNOWN_SPEAKER`):
ein Name für `SPEAKER_09` bei zwei Stimmen legte eine Zeile an, die nie jemand
sieht.

### Aufnahme

Bis 200 MB, Range-fähig ausgeliefert (ohne `Accept-Ranges` lädt der Browser bei
jedem Klick auf eine Zeitmarke die ganze Datei neu). Die Aufnahme lässt sich
verwerfen, ohne den Wortlaut zu verlieren — sie ist der grosse Teil im Backup.

---

## Was der journalistische Strang sonst noch mitbringt

- **Textsorte pro Beitrag** (`page_textsorte`, Buch-Default in
  `book_settings.textsorte`) — SSoT
  [prompts/textsorten.js](../public/js/prompts/textsorten.js),
  Vorrangregel nur in [db/textsorte.js](../db/textsorte.js)#`effectiveTextsorte`.
- **Struktur-Check** (`page_structure_checks`, Job `struktur-check`): prüft die
  FORM gegen den Soll-Katalog der Textsorte, nicht die Sprache.
- **Lektorat-Profil**: die Textsorte schneidet `wertung` in den Meinungsformen
  aus dem Typ-Set — im Kommentar ist die Wertung der Zweck, nicht der Mangel.
- **O-Ton-Felder an der Quelle** (`sources.oton_*`) — siehe
  [quellen.md](quellen.md).

## Pflicht-Invarianten

- **Nichts davon schreibt generativ in den Manuskript-Text.** Der einzige
  generative Pfad ist die Titel-Werkstatt, und sie legt Varianten daneben.
- **Kein Zitat ohne Beleg auf dem O-Ton-Weg**: erst die Quelle, dann der Text.
  Schlägt das Anlegen fehl, wird nichts eingefügt.
- **Keine erfundene Sprecherzuordnung**, keine erfundenen Quellen-Metadaten,
  keine geratene Formtreue.
- **Zeichenlimits validieren nicht.** Wer das ändert, dreht das Feature um.
- Neue Stufe/neues Feld/neue Textsorte ⇒ ESM-SSoT **und** CJS-Spiegel **und**
  CHECK-Constraint **und** beide Locales. Gegated durch
  [redaktion-status.test.mjs](../tests/unit/redaktion-status.test.mjs),
  [headline-drift.test.mjs](../tests/unit/headline-drift.test.mjs),
  [textsorten-drift.test.mjs](../tests/unit/textsorten-drift.test.mjs).

## Tests

- Unit: [redaktion-status.test.mjs](../tests/unit/redaktion-status.test.mjs)
  (Kette, CHECK, Stale-Erkennung, Verteilung, CASCADE),
  [headline-drift.test.mjs](../tests/unit/headline-drift.test.mjs) (Felder,
  Kanäle, Teil-PUT, Varianten-Tausch),
  [interview-transcribe.test.mjs](../tests/unit/interview-transcribe.test.mjs)
  (Zeitmarken-Drift Server↔Browser, Redebeiträge, Volltext, Format-Whitelist),
  [textsorten-drift.test.mjs](../tests/unit/textsorten-drift.test.mjs).
- Smoke: die Titel-Werkstatt läuft registry-getrieben in
  [smoke.spec.js](../tests/e2e-app/smoke.spec.js) mit.
