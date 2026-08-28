# Alters-Analyse der Figuren (Reiter „Alter" der Figuren-Karte)

Beantwortet **„wie alt ist diese Figur im Buch"** — als Tabelle über alle Figuren,
filterbar nach Figurentyp, mit Belegstelle im Manuskript.

## Warum neben der Komplettanalyse

Die Komplettanalyse extrahiert `figures.geburtstag` und die datierten Ereignisse als
Nebenprodukt eines teuren Gesamtlaufs. Wer danach weiterschreibt, hat ein Alter auf
dem Stand von damals — **und sieht das nicht**. Dieser Job ist klein genug für einen
Knopfdruck und liest den heutigen Text; er läuft bewusst **nicht** im Nacht-Cron
(er kostet KI-Calls, und die Frage stellt sich nicht täglich).

## Drei Schichten, in dieser Reihenfolge

| # | Wer | Was | Wo |
|---|-----|-----|----|
| 1 | deterministisch | **Kandidatensätze**: Muster (Ziffer, Zahlwort, Ordinal-Geburtstag, Geburtsjahr in beiden Leserichtungen, englische Formen) + Figurenname im Satzfenster, inkl. Pronomen-Anschluss aus dem Vorsatz | [lib/figure-age/patterns.js](../lib/figure-age/patterns.js), [scan.js](../lib/figure-age/scan.js) |
| 1b | deterministisch | **semantische Nachlese** (`semanticQuery`) für Figuren, bei denen die Muster wenig finden — „wie alt ist X" trifft ein Embedding-Index besser als eine Wortsuche. Non-fatal ohne Index | [routes/jobs/figur-alter.js](../routes/jobs/figur-alter.js) |
| 2 | Modell | **was behaupten diese Sätze** — ein Call pro Figuren-Bündel. Nur das Modell sieht, dass „an ihrem sechzehnten Geburtstag" ein Alter nennt und „1912 kehrte sie zurück" nur ein Bezugsjahr | [prompts/figur-alter.js](../public/js/prompts/figur-alter.js) |
| 3 | deterministisch | **Zitat nachschlagen, Zahl prüfen, Spanne bilden, Widerspruch melden** | [lib/figure-age/consolidate.js](../lib/figure-age/consolidate.js) |

**Das Modell rechnet nicht und rät nicht.** Sein Schema kennt kein Feld für ein
geschätztes Alter: ein Sprachmodell schätzt das Alter jeder Figur, nach der man
fragt, und in einer Tabelle sieht die Schätzung aus wie ein Befund. Gefragt ist nur,
was im vorgelegten Satz **steht** — samt wörtlichem Zitat.

## Zwei Prüfungen, ohne die das Feature nichts wert wäre

1. **Zitat-Prüfung.** Das Zitat muss in einer der **vorgelegten** Stellen dieser Figur
   stehen (normalisierter Vergleich). Gleiche Haltung wie bei den Belegzitaten der
   Bewertung ([lib/quote-verify.js](../lib/quote-verify.js)), hier nur mit engerem
   Heuhaufen.
2. **Zahl-Prüfung.** Der gemeldete Wert muss im Zitat vorkommen — als Ziffer **oder**
   als Zahlwort (`numbersIn`). Ohne diese Prüfung wandern gerechnete und geratene
   Werte als „belegt" in die Tabelle.

Beide Verwerfungs-Zähler stehen im Job-Ergebnis (`verworfen.zitat` / `.zahl` / `.figur`)
und im Log — ein stiller Filter liest sich wie „mehr gab es nicht".

## Der gerechnete Wert hängt am Ankerjahr der Figur

`gerechnet` = `jahr_im_roman − geburtsjahr`, wobei `jahr_im_roman` das **jüngste
datierte Ereignis dieser Figur** ist ([lib/figure-years.js](../lib/figure-years.js)) —
nicht das Ende des Buchs. Eine Figur, die 1987 aus der Geschichte verschwindet,
während das Buch bis 2003 läuft, ist fünf und nicht einundzwanzig. Vorrang hat
deshalb die kanonische Rechnung `alter_im_roman` (dieselbe Zahl, die der Figuren-
Katalog anzeigt); nur wenn die fehlt, weil das Geburtsjahr **nur im Text** steht
(`alter_im_roman` liest ausschliesslich das kuratierte Feld), zieht die Verdichtung
sie aus Bezugsjahr − Geburtsjahr nach.

Die buchweite Jahresspanne (`bookYearSpan`) ist deshalb **nur Rahmen für den
Prompt** und geht nicht in die Verdichtung ein.

## Datenmodell (abgeleiteter Index, Full-Replace pro Lauf)

- `figure_ages` — **eine Zeile pro Figur**: Altersspanne, Bezugsjahre, Geburtsjahr +
  dessen Quelle, `gerechnet`, Konfidenz, `widerspruch_json`.
- `figure_age_belege` — die Fundstellen: `art`/`wert`/`zitat`/`page_id` (Sprungziel).
- `figure_age_scans` — Lauf-Kopf pro Buch + User: „Stand vom", `content_sig` für den
  Delta-Skip, `embed_used`.

Schreibpfad ausschliesslich [db/figure-ages.js](../db/figure-ages.js)#`replaceFigureAges`
(eine Transaktion). Kein Delta: eine Figur, deren Altersangabe im Text gestrichen
wurde, müsste sonst aktiv gelöscht werden — und genau das vergisst man.

## Pflicht-Invarianten

- **`figures` wird nie geschrieben.** `geburtstag` gehört dem Autor. Weicht der
  Textfund davon ab, ist das ein **Befund** (`widerspruch.typ = 'geburtsjahr'`) und
  keine Korrektur. Beim Anzeigen gewinnt der Steckbrief.
- **Zwei Alters-Spalten bleiben zwei Spalten.** „Alter" = wörtliche Angabe (mit
  Beleg), „gerechnet" = Rekonstruktion aus Geburtsjahr + erzählter Zeit. Eine einzige
  Spalte müsste sich für eine Quelle entscheiden und würde den Widerspruch
  verschweigen — der Widerspruch ist der Mehrwert.
- **Die Tabelle funktioniert ohne Lauf.** Ohne Alters-Index zeigt sie, was Steckbrief
  und Zeitstrahl hergeben (`alter_im_roman` aus [lib/figure-years.js](../lib/figure-years.js)),
  plus den Hinweis, dass noch nichts analysiert wurde. Der Knopf ergänzt, er schaltet
  nicht frei.
- **Ein Alter ist eine Spanne.** Angezeigt wird `12–19`, nicht `12`: die Figur ist im
  Buch nicht zwölf, sie wird zwischen zwölf und neunzehn. Darum verteilt
  `selectCandidates` die Stellen über den Buchbogen (erste und letzte immer) statt die
  ersten N zu nehmen — sonst steht dort das Alter aus Kapitel 1.
- **Konfidenz in drei Stufen, nicht als Kommazahl** — und als **Ton der einen
  Herkunfts-Plakette**, nicht als zweite Plakette daneben: „aus dem Text" +
  „gerechnet" nebeneinander lesen sich wie zwei widersprüchliche Quellenangaben.
  Das Wort steht im Tooltip. Eine Zahl wie `0.75` behauptet ohnehin eine Präzision,
  die eine Heuristik nicht hat.
- **Ohne Alter kein Bezugsjahr.** `jahr_im_roman` fällt für eine undatierte Figur
  auf das späteste Jahr des Buchs zurück; neben „unbekannt" wäre diese Jahreszahl
  eine Scheinantwort.
- **„Alter sinkt im Buchverlauf" ist ein Hinweis, kein Fehler.** Rückblenden sind
  legitim. Das Badge heisst darum `prüfen`, nicht „falsch".
- **Nur die Zeitlinien-Achse ist gegated.** Der gerechnete Wert setzt
  `book_settings.zeitlinie_real` voraus (gleiche Regel wie `alter_im_roman`); eine
  wörtliche Angabe („war zwölf") gilt immer — auch in Büchern ohne Kalender-Zeitlinie.
- **`AGE_ANALYSIS_VERSION`** ([lib/figure-age.js](../lib/figure-age.js)) gehört in die
  `content_sig`. Wer Muster, Verdichtung oder Prompt ändert, erhöht sie — sonst
  überspringt der Delta-Skip den nächsten Lauf.
- **Der Figurenstamm gehört in die `content_sig`.** Eine neu angelegte Figur ändert das
  Ergebnis, ohne dass eine Seite angefasst wurde.

## Wege

- Karte: Reiter „Alter" in der Figuren-Karte
  ([partials/figuren-alter.html](../public/partials/figuren-alter.html),
  [js/book/figuren-alter.js](../public/js/book/figuren-alter.js), Methods gespreadet in
  `figurenCard`).
- Lesen: `GET /figures/:book_id/alter` ([routes/figures-alter.js](../routes/figures-alter.js), ab `viewer`).
  Zeilen sind nach `figures.fig_id` geschlüsselt — die Kennung, die der Katalog als
  `id` nach vorne gibt.
- Analysieren: `POST /jobs/figur-alter` (ab `editor`, `force: true` überspringt den
  Delta-Skip — manuell ausgelöst heisst „ich will jetzt eine Zahl sehen").
- Tests: [tests/unit/figure-age.test.js](../tests/unit/figure-age.test.js) (reine
  Schichten), [tests/integration/figur-alter.test.js](../tests/integration/figur-alter.test.js)
  (Naht der drei Schichten mit Mock-AI, inkl. der beiden Prüfungen),
  [tests/e2e-app/figuren-alter.spec.js](../tests/e2e-app/figuren-alter.spec.js)
  (Reiter in der echten App).

## Zwei Layout-Fallen, die hier schon zugeschnappt sind

- **`display:flex` gehört nie auf ein `<td>`.** Eine Zelle mit `display:flex` ist
  kein `table-cell` mehr, der Browser wickelt sie in eine anonyme Zelle — die Spalte
  verrutscht gegen ihren Kopf. Der Flex-Kontext gehört auf einen inneren Span
  (gebraucht wird er nur, damit `.figur-typ-dot` als inline-Span seine 8×8 bekommt).
- **Der Chevron-Platz bleibt immer reserviert** (`visibility: hidden`, nicht
  `x-show`), sonst beginnen Punkt und Name in Zeilen ohne Belege weiter links und
  die Namensspalte franst aus.
