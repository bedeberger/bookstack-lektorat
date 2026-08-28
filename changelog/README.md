# changelog/

Eine JSON-Datei pro veroeffentlichter Version — die SSoT der Release-Notizen,
die den Usern in der App unter **Hilfe → Neuigkeiten** angezeigt werden.

    changelog/4.0.0.json

```json
{
  "version": "4.0.0",
  "date": "2026-08-08",
  "entries": [
    { "kind": "neu", "de": "Quellen & Quellenverzeichnis", "en": "Sources and bibliography" }
  ]
}
```

- `version` — muss dem Dateinamen entsprechen (`x.y.z`).
- `date` — Release-Datum, `YYYY-MM-DD`.
- `entries[].kind` — `neu` | `verbessert` | `behoben`. Label kommt aus i18n
  (`changelog.kind.<kind>`), steht also **nicht** im Text.
- `entries[].de` / `.en` — beide Pflicht. Der Changelog ist User-Text und faellt
  damit unter die i18n-Regel; die Ansicht zeigt die UI-Sprache des Betrachters.

**Geschrieben wird eine neue Datei ausschliesslich vom `/release`-Befehl**
(`.claude/commands/release.md`), im selben Commit wie der Versions-Bump.
`tests/unit/changelog.test.mjs` haelt das zusammen: fehlt die Datei zur aktuellen
`VERSION`, ist CI rot.

**Ton:** aus Sicht des Users, nicht des Codes. „Figuren-Alter wird jetzt aus dem
Buchtext gelesen" statt „figure-ages Job + Konsolidierung". Interne Refactorings,
Testarbeit und Doku-Pflege gehoeren nicht hinein — sie aendern fuer den Leser nichts.
