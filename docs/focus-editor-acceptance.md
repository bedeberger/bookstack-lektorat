# Focus-Editor — Akzeptanzliste (2 Minuten, vor jedem Commit)

Pflicht bei **jeder** Änderung an `public/js/editor/focus/`, `public/js/editor/shared/`
(Konsument Focus), `public/css/editor/focus/` oder `public/partials/editor-focus.html`
— siehe harte Regel „Focus-Editor ist stabilisiert" in [CLAUDE.md](../CLAUDE.md).

**Geklickt, nicht gelesen.** Die Liste existiert, weil Code-Lesen und grüne Tests
beides schon gleichzeitig richtig waren, während der Editor sich falsch anfühlte:
die Schreiblinien-Geometrie hängt an der CSS-Höhenkette der echten Shell, und die
sieht kein Fixture-Harness.

## Vorbereitung

```
npm start          # Port 3737, echte DB
```

Beliebiges Buch, eine Seite mit **mindestens 30 Absätzen** (kurze Seiten verstecken
genau die Tail-Puffer-Fehler). Fokusmodus über den Button in der Seiten-Kopfzeile
bzw. Cmd/Ctrl+Shift+E.

## Die elf Griffe

| # | Handgriff | Erwartung |
|---|-----------|-----------|
| 1 | Fokusmodus betreten | Overlay füllt den Bildschirm, Caret blinkt am Buchende, Schreibzeile auf der Bildschirmmitte |
| 2 | Drei Absätze tippen (mit Enter dazwischen) | Zeile bleibt auf der Mitte, wandert **nicht** schrittweise nach unten |
| 3 | Cmd/Ctrl+Home, dann in die **erste** Zeile klicken und tippen | Erste Zeile liegt auf der Schreiblinie, nicht am oberen Rand |
| 4 | In den **letzten** Absatz klicken und tippen | Letzte Zeile erreicht die Schreiblinie (nicht „man kommt nur bis zum zweitletzten") |
| 5 | Mit dem Mausrad durch die ganze Seite scrollen | Spotlight folgt dem Absatz in der Bildschirmmitte; kein Springen, kein Flattern |
| 6 | Mitten in einen Absatz klicken | Caret landet dort, **kein** Recenter-Sprung (Pointer-Schonfrist) |
| 7 | Ein Wort doppelklicken, dann eine Passage über zwei Absätze ziehen | Auswahl bleibt stehen, Viewport springt nicht |
| 8 | Granularität in den Einstellungen umschalten (Absatz ↔ Satz) | Umschaltung sofort, ohne Exit/Re-Entry, Markierung korrekt |
| 9 | Escape (bzw. Exit-Button) | Speichert, Overlay weg, zurück in die Leseansicht, Kennzahlen aktualisiert |
| 10 | Wieder betreten, Fenster schmal ziehen (< 500 px) | Schreiblinie sitzt weiter auf der Mitte, kein horizontaler Overflow |
| 11 | Kurz vor der Umbruchkante weiterschreiben (Wörter mit Leerschlag), danach Shift+Enter mitten im Absatz **und** am Absatzende; Escape, Seite erneut öffnen | Das letzte Wort bleibt beim Leerschlag auf seiner Zeile (fällt nicht ab und springt zurück). Shift+Enter erzeugt an beiden Stellen eine sichtbare neue Zeile, die nach dem erneuten Öffnen noch da ist |

Zusätzlich bei Änderungen an Save/Draft/Exit:

- **12** — Tippen, dann Netzwerk in den DevTools offline schalten, Escape drücken:
  User bleibt im Edit-Modus, Draft ist erhalten (kein stiller Verlust).

Bei Änderungen, die Mobile/Tastatur berühren (`viewport.js`, `--focus-vh`,
`cursor-hide.js`): Punkt 1–5 zusätzlich in der Chrome-Device-Emulation (iPhone-Profil)
mit eingeblendeter Tastatur-Simulation.

## Danach

```
npm run test:focus     # Harness-Suite + App-Suite (echtes CSS)
```

Grün ist die **Untergrenze**, nicht der Beweis: die App-Suite deckt Höhenkette,
Schreiblinie, erste/letzte Zeile, Tipp-Recenter, Spotlight-bei-Scroll und Exit-Cleanup
ab. Punkt 6 ist im Harness gegated, Punkt 11 in beiden Suiten; von 7, 8 und 12 jeweils nur die eine Hälfte
(Doppelklick / Klassen-Tausch / Save-Reject-Stub), und **Punkt 10 gar nicht** —
die Aufschlüsselung steht in [focus-editor.md](focus-editor.md#tests).

Darum bleibt diese Liste geklickt: was hier fehlt, fehlt in der Automatisierung
genau dort, wo sich der Editor falsch anfühlen kann, ohne rot zu werden.
