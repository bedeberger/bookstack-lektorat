# Lebenslauf der Figuren (Reiter „Lebenslauf" der Figuren-Karte)

Beantwortet **„wo stand die eine Figur, als die andere X erlebte"** — Lebensphasen
als Zeilen, die gewählten Figuren als Spalten, deren datierte Lebensereignisse in
den Zellen.

## Kein Job, kein Index, keine Route

Der Reiter ist **reine Anzeige** auf Daten, die schon da sind: `lebensereignisse`
(mit `datum`, `subtyp`, `kapitel`, `page_id`) und das Geburtsjahr stehen im
Figuren-Katalog, `GET /figures/:book_id`, befüllt von der Komplettanalyse. Ein
eigener Extraktionslauf würde dieselbe Biografie ein zweites Mal erheben — und
dann konkurrierend. Zwei Wahrheiten über dasselbe Leben sind schlechter als eine.

Die ganze Sachlogik liegt darum in einer reinen Schicht,
[public/js/book/figuren-lebenslauf.js](../public/js/book/figuren-lebenslauf.js);
die Alpine-Methoden daneben sind dünne Leser darauf.

## Die Zeilen-Achse ist das ALTER, nicht das Jahr

Das ist die Existenzberechtigung des Reiters und die Invariante, an der er steht
oder fällt. Zwei Figuren, ein Jahr auseinander geboren, gehen im selben
Lebensabschnitt zur Schule — aber in verschiedenen Kalenderjahren. Nach Jahren
sortiert stünden sie versetzt, und der Vergleich wäre zerschnitten. Die Zelle
zeigt trotzdem **Jahr und Alter** (`1997 · 12 J.`): das Jahr verankert im Buch,
das Alter erklärt die Zeile.

Der Zeitstrahl-Reiter der Ereignisse-Karte ist das Gegenstück — dort **ist** die
Kalenderachse die Frage. Beide nebeneinander, keiner ersetzt den anderen.

## Die Phasen-Schnitte liegen an den biografischen Nähten

`LEBENSPHASEN` (SSoT im Modul): Vorgeschichte · Geburt (0) · Frühe Kindheit (1–5)
· Schulkind (6–11) · Jugend (12–17) · Junges Erwachsenenalter (18–29) ·
Erwachsenenalter (30–49) · Reifes Alter (50–64) · Hohes Alter (65+), dazu die
Sammelzeile „Ohne Jahresangabe".

Die Grenzen liegen bewusst **nicht** auf runden Zehnern, sondern an Einschulung,
Übertritt in die Oberstufe, Volljährigkeit und Pensionierung. Die Naht ist der
Grund, warum zwei Figuren überhaupt in einer Zeile stehen; ein Band 10–19 legte
Primar- und Oberstufenzeit derselben Figur übereinander. Die Bänder sind
lückenlos und überschneidungsfrei — gegated.

## Pflicht-Invarianten

- **Ohne Geburtsjahr keine Spalte.** Ohne Bezugspunkt fiele jedes Ereignis in die
  Sammelzeile, und die Spalte täuschte eine Aussage vor, die sie nicht macht. Wie
  viele Figuren das betrifft, wird **ausgewiesen** (`ohneJahr`) — eine stumm
  gekürzte Liste liest sich als „mehr Figuren gibt es nicht".
- **Undatierte und vorgeburtliche Ereignisse bekommen eigene Zeilen**, statt
  weggelassen zu werden. „Steht nicht in der Matrix" hiesse sonst „gibt es
  nicht"; ein Ereignis vor der Geburt ist kein Rechenfehler, sondern
  Vorgeschichte.
- **Leere Phasen erscheinen nicht.** Eine Zwischenzeile ohne Ereignis ist kein
  Befund, nur Luft. Eine leere **Zelle** in einer sonst gefüllten Zeile bleibt
  dagegen sichtbar — dass hier nichts passierte, während die andere Figur etwas
  erlebte, ist genau die Aussage.
- **Das Geburtsjahr folgt derselben Vorrangordnung wie die Alters-Analyse**
  (`figurGeburtsjahr`): Alters-Index → Katalog (`geburtsjahr` aus dem
  konsolidierten Zeitstrahl) → Stammfeld `geburtstag`. Der Reiter zieht den Index
  beim Öffnen über `ensureFigurenAlter()` mit — **non-fatal**: ohne Lauf trägt der
  Katalog die Matrix allein. Er **schaltet nichts frei**, er verbessert nur.
- **`jahrAusDatum` ist wortgleich mit
  [lib/figure-years.js](../lib/figure-years.js)#`yearFromString`** (erste
  vierstellige Zahl). Eine grosszügigere Variante hier liesse Lebenslauf und
  Alters-Spalte an genau den Datumsangaben auseinanderlaufen, an denen sie sich
  unterscheiden.
- **Die Spaltenzahl ist gedeckelt** (`LEBENSLAUF_MAX_SPALTEN`), am Deckel wird
  **gesperrt statt ignoriert**, und der Deckel steht als Konstante im Modul — nie
  als zweite Zahl im Template.
- **Kein `sortableTable`.** Die Zeilen sind eine Ordnung (früh nach spät), keine
  Liste; eine umsortierte Biografie ist keine mehr. Dieselbe Ausnahme wie
  Präsenz-Matrix und Heatmaps.
- **`figures` wird nie geschrieben** — wie im Alters-Reiter. Der Lebenslauf ist
  eine Lesart, keine Quelle.

## Verhältnis zum Alters-Reiter

Geschwister, nicht Alternativen: die Alterstabelle ist **eine Zeile pro Figur**
(wie alt ist sie im Buch, mit Beleg), der Lebenslauf eine **Matrix** (wie
verlaufen mehrere Leben nebeneinander). Die beiden Formen lassen sich nicht in
eine Tabelle legen — darum zwei Reiter, die sich denselben Index und dieselbe
Geburtsjahr-Auflösung teilen.

## Wege

- Karte: Reiter „Lebenslauf" in der Figuren-Karte
  ([partials/figuren-lebenslauf.html](../public/partials/figuren-lebenslauf.html),
  [js/book/figuren-lebenslauf.js](../public/js/book/figuren-lebenslauf.js), Methods
  gespreadet in `figurenCard`).
- Lesen: keine eigene Route — `GET /figures/:book_id` (Katalog) plus optional
  `GET /figures/:book_id/alter` (Geburtsjahre aus dem Text).
- Muster der Chip-Auswahl: DESIGN.md → „Auswahl-Chip-Reihe".
- Tests: [tests/unit/figuren-lebenslauf.test.mjs](../tests/unit/figuren-lebenslauf.test.mjs)
  (reine Schicht, Bandgrenzen, Lückenlosigkeit),
  [tests/e2e-app/figuren-lebenslauf.spec.js](../tests/e2e-app/figuren-lebenslauf.spec.js)
  (Reiter in der echten App; die Alters-Ausrichtung ist dort mutationsgeprüft).
