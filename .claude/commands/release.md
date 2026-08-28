---
description: Versionsnummer erhöhen + Git-Tag + GitHub-Release erstellen
argument-hint: "[patch|minor|major|x.y.z]  (Default: patch)"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(npm run version:sync), Bash(npm run sw:manifest), Bash(npm run squash:regen), Bash(npm run test:unit), Read, Write
---

Du führst einen Release der App durch. SSoT der Version ist die Datei `VERSION` im Projektroot; `package.json#version` folgt via `npm run version:sync`. Zu **jeder** Version gehören Release-Notizen in `changelog/<version>.json` — die App zeigt sie den Usern unter **Hilfe → Neuigkeiten** ([changelog/README.md](../../changelog/README.md)).

Bump-Argument: `$ARGUMENTS` (leer = `patch`).

**Ein Release endet immer gepusht.** Commit, Tag, `git push` und GitHub-Release gehören zum Befehl — sie sind nicht optional und werden nicht zurückgestellt. Ein Lauf, der nur `VERSION` hochzählt und den Tree liegen lässt, ist ein fehlgeschlagener Lauf. **Es wird nicht nachgefragt** — weder für die Release-Notizen noch sonst. Der Lauf hält nur an, wenn ein Schritt fehlschlägt oder die Änderungslage nicht eindeutig ist (Schritt 9); andernfalls läuft er von Schritt 1 bis zum Abschlussbericht in einem Zug durch.

## Vorprüfung

1. `git status --porcelain` lesen. **Der gesamte Working Tree wird mit dem Release committet** — egal was drin liegt. Es darf nur kein laufender Merge/Rebase-Konflikt (ungemergte Pfade) vorliegen; falls doch: abbrechen und melden.
2. Aktuelle Version aus `VERSION` lesen. **Abgleich mit dem letzten Tag** (`git describe --tags --abbrev=0`): steht `VERSION` bereits über dem letzten Tag, hat ein früherer Lauf abgebrochen, bevor er committen/taggen konnte. Dann **nicht erneut bumpen** — diesen Stand als `<neueVersion>` übernehmen, fehlende Release-Notizen nachschreiben und ab Schritt 10 normal weiterfahren.
3. Neue Version berechnen:
   - `patch` → letzte Stelle +1 (1.2.3 → 1.2.4)
   - `minor` → mittlere +1, Patch auf 0 (1.2.3 → 1.3.0)
   - `major` → erste +1, Rest auf 0 (1.2.3 → 2.0.0)
   - Explizites `x.y.z` → genau dieser Wert (Semver-Format validieren).
4. Sicherstellen, dass der Tag `v<neueVersion>` noch nicht existiert (`git tag -l`). Falls doch: abbrechen und melden.

## Version setzen

5. Neue Version in `VERSION` schreiben (nur die Zahl + Newline).
6. `npm run version:sync` ausführen (schreibt `package.json#version`).

## Release-Notizen schreiben

Das ist der Teil, den nur du machen kannst — der Rest ist Mechanik.

7. `git log --format='%s%n%b' v<letzteVersion>..HEAD` lesen (plus `git diff --stat` für den Umfang). Bei sehr vielen Commits zusätzlich `git log --format='%s' … | sort -u`, um Themen zu bündeln statt Commits aufzuzählen.

8. `changelog/<neueVersion>.json` schreiben — Format und Ton stehen in [changelog/README.md](../../changelog/README.md). Verbindlich:
   - **Ein Eintrag pro Änderung, die ein User merkt**, nicht pro Commit. Zehn Commits an einem Feature sind ein Eintrag; „tests", „doku", „refactoring", „anpassungen", Versions-Bumps und interne Umbauten kommen **gar nicht** vor — sie ändern für den Leser nichts.
   - **Aus Sicht des Users formuliert**, nicht des Codes: „Das Alter einer Figur wird jetzt aus dem Buchtext gelesen" statt „figure-ages-Job + Konsolidierungs-Pass". Keine Datei-, Tabellen- oder Job-Namen, keine internen Begriffe, die in der Oberfläche nicht vorkommen.
   - `kind` ist `neu` (gab es vorher nicht) | `verbessert` (gab es, ist jetzt besser) | `behoben` (war kaputt). Im Zweifel `verbessert`.
   - **`de` UND `en` sind Pflicht** (i18n-Regel — der Changelog ist User-Text). Übersetze selbst, verschiebe es nicht.
   - Reihenfolge: das Wichtigste zuerst, nicht chronologisch. `neu` vor `verbessert` vor `behoben`.
   - `date` = heutiges Datum (`YYYY-MM-DD`).
   - Bringt eine Version **nichts** User-Sichtbares (reiner Wartungs-Release), schreibe genau einen ehrlichen Eintrag dazu (`kind: 'verbessert'`, z. B. „Wartung und interne Verbesserungen ohne Änderungen an der Oberfläche.") — eine Version ohne Datei lässt `npm run test:unit` rot werden, und das ist Absicht.

9. Die geschriebenen Notizen **ohne Rückfrage** übernehmen und weiterfahren — sie werden im Abschlussbericht ohnehin gezeigt, und der User kann danach jederzeit korrigieren lassen. **Warten ist die Ausnahme, nicht die Regel:** nachgefragt wird nur, wenn (a) ein Schritt fehlschlägt, (b) der Commit-Log die Änderung nicht eindeutig hergibt — mehrere plausible Lesarten, unklar ob überhaupt User-sichtbar, oder Fremdarbeit im Tree, die du nicht zuordnen kannst. Dann die kompakte DE-Liste zeigen, bestätigen lassen und bei Korrekturwünschen die Datei anpassen und erneut zeigen. Im Normalfall läuft der Befehl ohne Halt durch.

## Drift-Artefakte + Tests (vor dem Tag)

Schritt 11 committet den **gesamten** Tree — auch Fremdarbeit, die nicht durch die PostToolUse-Hooks dieser Session gelaufen ist. Darum vor dem Tag selbst regenerieren und prüfen, sonst geht ein Release mit rotem CI raus:

10a. `npm run sw:manifest` — Content-Hash `__SHELL_BUILD` in `public/sw-manifest.js` neu berechnen (gegated durch `sw-manifest-drift.test`).
10b. Enthält der Tree eine neue Migration in `db/migrations.js`: `npm run squash:regen` (bei Recreate-Pattern `FORCE_LEGACY_MIGRATIONS=1 npm run squash:regen`) und [docs/erd.md](../../docs/erd.md)-Stand prüfen.
10c. `npm run test:unit` — deckt `sw-manifest-drift`, `squash-drift`, `erd-drift`, `loc-limits` **und `changelog`** ab. Letzteres läuft erst hier scharf, weil `VERSION` schon auf dem neuen Wert steht: fehlt `changelog/<neueVersion>.json` oder fehlt einem Eintrag `de`/`en`, ist der Lauf rot. **Rot ⇒ abbrechen**, kein Tag, kein Push. Stand melden.

## Durchführung

11. **Gesamten** Working Tree stagen: `git add -A` (inkl. `VERSION`, `package.json` + `changelog/<neueVersion>.json`).
12. Committen mit Message `release: v<neueVersion>`. Liegen ausser dem Versions-Bump noch andere Änderungen im Tree, eine kurze, sinnvolle Zusammenfassung dieser Änderungen als zweite Zeile (Body) ergänzen. `Co-Authored-By:`-Trailer mit dem **aktuell vorgegebenen Modellnamen** anhängen (steht in den Umgebungs-/Harness-Vorgaben — nicht aus älteren Commits kopieren, der Name wandert mit jeder Modellgeneration).
13. Annotated Tag setzen: `git tag -a v<neueVersion> -m "v<neueVersion>"`.
14. Pushen — **beides, in dieser Reihenfolge, und jeweils den Erfolg prüfen**:
    - `git push origin HEAD` (schlägt er wegen fremder Commits fehl: `git pull --rebase origin main`, dann erneut pushen).
    - `git push origin v<neueVersion>` — ein Tag reist **nicht** mit `git push` mit; ohne diesen zweiten Push kennt GitHub den Tag nicht und Schritt 15 legt ein Release auf einer Referenz an, die es dort nicht gibt.
    - **Verifizieren statt annehmen:** `git ls-remote --tags origin v<neueVersion>` muss eine Zeile liefern und `git rev-parse v<neueVersion>^{commit}` denselben Commit wie `git rev-parse HEAD`. Leere Ausgabe oder Abweichung ⇒ stoppen und melden, kein `gh release create`.
15. GitHub-Release erstellen — **Body sind die Release-Notizen aus Schritt 8**, nicht `--generate-notes` (das listet rohe Commit-Betreffs; die kuratierte Fassung ist die bessere und steht ohnehin schon da):
    - Aus `changelog/<neueVersion>.json` eine Markdown-Notiz bauen: die `de`-Texte, gruppiert nach `kind` unter den Überschriften `### Neu` / `### Verbessert` / `### Behoben`, je ein `- `-Punkt.
    - In eine Temp-Datei schreiben und `gh release create v<neueVersion> --title "v<neueVersion>" --notes-file <datei>` aufrufen.

## Verifikation (Pflicht, nicht überspringen)

16. Erst wenn das durchläuft, gilt der Release als erfolgt:
    - `git status --porcelain` ist leer (nichts liegen geblieben).
    - `git log origin/main -1 --oneline` zeigt den Release-Commit — der Push ist wirklich angekommen.
    - `gh release view v<neueVersion> --json tagName,url` antwortet mit dem Tag und der URL.
    Schlägt eines davon fehl: den fehlenden Schritt nachholen (nochmal pushen, Tag nachpushen, Release neu anlegen) und erneut prüfen. Nicht mit einem halb fertigen Release aufhören.

## Abschluss

Melde knapp: alte → neue Version, Anzahl Release-Notizen, Commit-Hash, Tag, und die URL des erstellten GitHub-Releases. Erwähne, dass die Notizen den Usern beim nächsten Laden unter **Hilfe → Neuigkeiten** erscheinen (mit Punkt am „?"-Knopf, bis sie gelesen sind).

Bei jedem Fehlschlag eines Schritts **stoppen** und den Stand berichten — mit der Angabe, was schon committet/gepusht/getaggt ist und was fehlt, damit der nächste Lauf dort aufsetzt. Kein `gh release create` ohne gepushten Tag, und kein „mache ich später" für Commit oder Push.
