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

### Der Kopf am Beitrag — SSoT [lib/headline-render.js](../lib/headline-render.js)

Dachzeile, Titel und Lead stehen über dem Beitrag: in der Notebook-Leseansicht,
im Share-Reader und in **jedem** Export. Weil sie Metadata sind und nicht die
ersten Absätze, sieht sie kein Ausgabeweg von selbst — jeder muss sie auflösen,
bevor sein Walker läuft. Das ist dieselbe Eigenschaft, die `prepareCitations`
(Quellen) und `applyXrefsInGroups` (Querverweise) begründet, und derselbe Grund,
warum es genau **eine** Stelle dafür gibt.

**Der Titel ERSETZT den Seitennamen, er tritt nicht daneben.** `pages.page_name`
ist der Ordnungsname im Buchorganizer („Beitrag 12"), der Titel die Schlagzeile;
nebeneinander trüge jeder Beitrag zwei Überschriften. Ohne gesetzten Titel bleibt
der Seitenname — ein leerer Kopf wäre schlimmer als ein technischer Name. Der
Blog-Sync entscheidet seit jeher so; alle übrigen Wege folgen jetzt derselben
Regel. Der **Dateiname** (`resolveSlug`) folgt ihr bewusst *nicht*: eine Adresse
soll sich nicht ändern, weil jemand den Titel umformuliert hat.

**Der Teaser gehört nicht in den Beitrag.** Er ist der Anreisser für Übersichten
und Vorschaukarten; im Artikel selbst wäre er die Wiederholung des Leads mit
anderen Worten. Er verlässt die App weiterhin nur als WordPress-`excerpt` und
wird ausschliesslich in der Titel-Werkstatt gepflegt (Feldliste
[channels.js](../public/js/headline/channels.js)#`HEADLINE_HEAD_FIELDS` vs.
`HEADLINE_FIELDS`).

**Markup-Invariante:** der Kopf trägt seine Klasse (`ms-head__kicker` /
`ms-head__lead`) **und** eine Auszeichnung (`<strong>`/`<em>`). Beides mit
Absicht — die Wege mit eigenem Stylesheet (HTML, EPUB, Substack, Share-Reader)
hängen sich an die Klasse, die Wege durch den HTML-Walker (PDF, Word, Markdown)
kennen nur die Auszeichnung. Nicht das eine gegen das andere eintauschen.

**Angehängt wird an genau einer Stelle:** `attachHeadlines` in
[lib/load-contents.js](../lib/load-contents.js) hängt den geltenden Stand an die
Seiten-Metadaten (`x.p.hl`) — damit tragen alle Export-Wege und der Buch-/
Kapitel-Share ihn ohne eigenen Nachladepfad. Der **Seiten-Share** und die
Kapitel-Variante laufen nicht über `loadContents` und ziehen ihn selbst
(`attachPageHeadline`, [lib/share-helpers.js](../lib/share-helpers.js)).
No-op ausserhalb publizistischer Bücher, non-fatal bei Lookup-Fehlern: ein
Titelapparat ist Zutat, kein Inhalt.

**Wo die Ausgabewege sich unterscheiden** (und warum):

| Weg | Überschrift | Dachzeile / Lead |
|---|---|---|
| Share-Reader (Buch/Kapitel) | Stream-Titel, Klasse `ms-page__title--headline` — die Seiten-Caption ist sonst eine kleine gesperrte Marginalie, als Schlagzeile wäre das falsch | eigene Blöcke um die Überschrift |
| Share-Reader (Seite) | H1 der Leseansicht | Block über dem Text (eine zweite Überschrift wäre doppelt) |
| HTML · EPUB · Substack | eigene Überschrift, Kopf darum herum | eigenes Stylesheet |
| Markdown · Plaintext | Überschrift bzw. Zeile | `**…**` / `*…*` bzw. blosse Stellung — im Plaintext bewusst **keine** Versalien: das wäre eine Änderung am Wortlaut, um eine Formatierung zu ersetzen |
| Word | `_chapterHeading` | benannte Absatzformate `ArticleKicker` / `ArticleLead` (`allCaps` setzt Word, der gespeicherte Text bleibt unangetastet) |
| PDF `nested` | `it.heading` | `it.kicker` zeichnet [body.js](../lib/pdf-render/body.js), der Lead geht als HTML voran |
| PDF `flatten` / Seite ohne Kapitel | — | der Renderer zeichnet dort gar keine Seitenüberschrift, also geht der **komplette** Kopf inkl. `h3` ins HTML; sonst verschwände die Schlagzeile spurlos |

**Der Kopf zählt nirgends als Prosa.** Umfang und Lesezeit des Share-Readers
messen den Beitrag und schneiden ihn vorher heraus (`stripHeadBlocks`) — dieselbe
Regel, die ihn aus `page_stats`, Wortschatz und Lektorat heraushält, und genau der
Grund, warum er nicht im Fliesstext steht. Aus `pages.content` muss nichts
geschnitten werden: dort kommt er nie an.

### Blog-Sync

[routes/jobs/blog-sync.js](../routes/jobs/blog-sync.js) im Push-Pfad: ist ein
Titel bzw. Teaser gesetzt, gewinnen sie über den abgeleiteten Seitennamen und
gehen als `title`/`excerpt` an WordPress. **Nur gesetzte Felder** — ohne
Titel-Werkstatt bleibt der Push Byte für Byte der alte, und ein leeres Feld darf
einen in WordPress gepflegten Titel nicht überschreiben.

### Kopf im Notebook-Editor

`editorPageHeadCard` ([public/js/cards/editor-page-head-card.js](../public/js/cards/editor-page-head-card.js),
Partial [editor-page-head.html](../public/partials/editor-page-head.html), CSS
[editor/notebook/page-head.css](../public/css/editor/notebook/page-head.css)).
Damit steht beim Schreiben sichtbar, worauf der Text zuläuft — bisher sah man
den Titelapparat nur in der Titel-Werkstatt, also gerade nicht dort, wo man am
Text arbeitet.

**Die Eingabe sieht aus wie das Ergebnis.** Lese- und Bearbeitungsmodus teilen
dieselbe Typografie; die Felder sind randlos, ohne Padding, ohne Labels (die
Platzhalter tragen die Feldnamen), und beim Umschalten bewegt sich der Kopf
nicht. Ein Kasten mit Labels und Rahmen wäre ein Formular, das auf dem
Manuskript liegt — es verdeckte genau die Frage, die es beantworten soll. Alles,
was Bedienung ist und nicht Beitrag, erscheint erst auf Anforderung: Zeichenzahl
und Lineal bei Fokus (oder dauerhaft, sobald ein Kanal reisst), der Sprung in
die Werkstatt beim Überfahren. Die volle Kanal-Tabelle, die Varianten und der
Teaser bleiben dort — im Editor soll der Kopf schmal sein.

**Nur der Notebook-Editor.** Der Focus-Editor ist der Vollbild-Schreibmodus: ein
Kopf über der Schreiblinie griffe in seine Höhenkette ein, und er blendet mit
Absicht alles aus, was nicht der laufende Satz ist. Der Bucheditor zeigt den
Manuskript-Stream über das ganze Ressort — dort gehört der Kopf an jeden Beitrag
im Stream und nicht an eine Karte; eigenes Vorhaben.

**Ein-/ausblendbar** über das `heading`-Icon, und zwar **nur im
Bearbeitungsmodus** — Edit-Toolbar
([editor-page-toolbar.html](../public/partials/editor-page-toolbar.html), inline
plus Meatball-Menü), gegatet auf `isJournalistischesBuch()` (in einem Roman
schaltete er etwas, das nicht existiert). Die Lese-Kopfleiste
([editor-page-actions.html](../public/partials/editor-page-actions.html)) trägt
den Knopf bewusst **nicht**: beim Lesen gehört der Kopf zum Beitrag, man liest
ihn mit — der Schalter bewirkt dort nichts Nützliches und kostet einen Platz in
einer Leiste, die auf eine Zeile passen soll. Die Wahl wirkt trotzdem auf beide
Modi; wer den Kopf im Lesemodus zurückholen will, tut das im Bearbeitungsmodus.

Der Zustand ist **reine Anzeige** (`pageEditorShowHead`, in `editorPrefs`
persistiert wie Zoom und Steuerzeichen): er blendet den Kopf im Notebook-Editor
aus, ändert aber weder die gespeicherten Felder noch Share-Reader oder Export.
Wer beim Schreiben am Fliesstext den Kopf wegklappt, veröffentlicht ihn trotzdem.
Zwei Dinge folgen daraus:

- **Default AN** — als einzige der Editor-Prefs. Der Kopf ist Inhalt des
  Beitrags, keine Dekoration wie die Steuerzeichen; er wird ausgeblendet, wenn
  jemand ihn nicht braucht, nicht eingeschaltet, wenn jemand ihn sucht.
  `normalizePrefs` fällt darum auf `showHead: prefs?.showHead !== false` zurück:
  ein alter Eintrag ohne den Schlüssel lässt ihn stehen.
- **Die Anzeige-Wahl ist nicht die Lade-Bedingung** (`headVisible()` vs.
  `headAvailable()` in der Karte) — sonst stünde der Kopf nach dem
  Wiedereinschalten leer da, bis jemand die Seite wechselt.

**Zweiter Schreibpfad, bewusst getrennt:** gespeichert wird über
`PUT /headline/page/:id`, dieselbe Route wie in der Titel-Werkstatt, **nicht**
über den Seiten-Save. Der Kopf steht in `page_headline`, nicht in
`pages.content` — er kann den Konflikt-/Stale-Pfad des Editors also weder
auslösen noch stören, und `pages.updated_at` bewegt sich durch ihn nicht. Nach
dem Speichern feuert er `card:refresh` auf `titelwerkstatt`: die zeigt dieselben
Felder in ihrer Übersicht und stünde sonst auf dem alten Titel.

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
- **Der Titel-Kopf wird nie in `pages.content` persistiert.** Er ist ein
  Render-Artefakt aus `page_headline` — dieselbe Regel wie beim
  Quellenverzeichnis und beim Anmerkungsapparat. Wer ihn in den Fliesstext
  schreibt, macht ihn zu Prosa und nimmt dem Feature seinen Zweck.
- **Neuer Ausgabeweg ⇒ [lib/headline-render.js](../lib/headline-render.js)
  aufrufen, keine eigene Auflös-Logik.** Wer den Seitennamen direkt rendert,
  zeigt „Beitrag 12" statt der Schlagzeile.
- **Der Kopf zählt nirgends als Prosa** — messende Schichten schneiden ihn über
  `stripHeadBlocks` heraus.
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
