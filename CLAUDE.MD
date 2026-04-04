# bookstack-lektorat – Technische Referenz

KI-gestütztes Lektorat-Tool für BookStack. Deployment, Konfiguration und Docker-Setup: siehe [README.md](README.md).

## Architektur

```
Browser → Express (Port 3737) → /config         → .env-Credentials an Frontend
                              → /history/*      → SQLite-DB (lektorat.db)
                              → /figures/*      → SQLite-DB (lektorat.db)
                              → /claude         → api.anthropic.com (ANTHROPIC_API_KEY-Injection)
                              → /ollama         → Ollama /api/chat (OLLAMA_HOST, lokales Modell)
                              → /api/*          → BookStack (localhost:80)
                              → /               → public/index.html
```

KI-Aufrufe laufen **nicht direkt aus dem Browser**, sondern über den jeweiligen Proxy-Endpunkt – der Server hält alle Credentials. Welcher Provider aktiv ist, steuert `API_PROVIDER` in der `.env`.

## Projektstruktur

```
bookstack-lektorat/
├── server.js                # Express-Setup + Route-Mounting (Einstiegspunkt)
├── logger.js                # Winston-Logger (Singleton, von allen Modulen importiert)
├── db/
│   └── schema.js            # DB-Setup, Schema, Migrationen, saveFigurenToDb()
├── routes/
│   ├── history.js           # /history/* Endpunkte (Lektorat-Checks + Buchbewertungen)
│   ├── figures.js           # /figures/:book_id Endpunkte
│   ├── jobs.js              # /jobs/* Endpunkte (Hintergrund-Jobs)
│   └── proxies.js           # /config, /claude (SSE-Proxy), /ollama, /api/* (BookStack-Proxy)
└── public/
    ├── index.html           # Single-Page-App (Alpine.js, kein Build-Step)
    ├── style.css            # Zentrales Stylesheet
    └── js/                  # ES-Module (kein Build-Step, type="module")
        ├── app.js           # Alpine-Komponente: State, Computed, init/selectPage/resetView
        ├── utils.js         # escHtml(), htmlToText()
        ├── prompts.js       # SYSTEM_*-Strings, buildLektoratPrompt()
        ├── api-bookstack.js # bsGet, bsGetAll, bsPut, _applyCorrections
        ├── api-ai.js        # callAI(userPrompt, systemPrompt?, onProgress?) → Promise<Object>
        ├── history.js       # loadPageHistory, loadBookReviewHistory
        ├── tree.js          # loadBooks, loadPages, loadTokenEstimates
        ├── lektorat.js      # runCheck, saveCorrections, toggleDiff, batchCheck, computeDiff
        ├── review.js        # runBookReview
        ├── figuren.js       # runFigurExtraction, loadFiguren, saveFiguren, toggleFiguresCard
        ├── graph.js         # renderFigurGraph, _figTypColor
        └── two-tier.js      # loadPageContents(), groupByChapter(), SINGLE_PASS_LIMIT
```

## Datenbankschema

```sql
-- Lektorat-Checks pro Seite
page_checks (id, page_id, page_name, book_id, checked_at, error_count,
             errors_json TEXT,   -- JSON-Array der Fehler
             stilanalyse, fazit, model, saved INTEGER, saved_at)

-- Buchbewertungen
book_reviews (id, book_id, book_name, reviewed_at,
              review_json TEXT,  -- JSON-Objekt der Gesamtbewertung
              model)

-- Figuren: eine Zeile pro Figur, Kernfelder fix
figures (id, book_id, fig_id TEXT,  -- "fig_1" etc., stabil über Saves
         name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order INTEGER, meta TEXT,  -- JSON für zukünftige Zusatzfelder
         updated_at)

-- Eigenschaften/Tags einer Figur (eine Zeile pro Tag)
figure_tags (figure_id → figures.id, tag TEXT)

-- Kapitelauftritte (eine Zeile pro Figur + Kapitel)
figure_appearances (figure_id → figures.id, chapter_name TEXT, haeufigkeit INTEGER)

-- Beziehungen: flat, typ ist Freitext → neue Typen ohne Schemaänderung
figure_relations (id, book_id, from_fig_id TEXT, to_fig_id TEXT,
                  typ TEXT,          -- elternteil|freund|… oder beliebig neuer Typ
                  beschreibung TEXT)

-- Schemaversion für Migrationen
schema_version (version INTEGER)
```

**Designprinzip Figuren:** Die vier Figuren-Tabellen sind bewusst flach gehalten. Neue Beziehungstypen entstehen einfach durch einen neuen `typ`-String – keine Schemaänderung nötig. Neue Figur-Eigenschaften kommen entweder als neue Spalte (via Migration) oder als Einträge im `meta`-JSON-Feld.

## Datenbankmigrationen

`db/schema.js` enthält `runMigrations()`. Sie liest `schema_version` und führt alle ausstehenden `ALTER TABLE`-Statements sequenziell aus.

**Neue Spalte hinzufügen:**

1. `CURRENT_SCHEMA_VERSION` in `db/schema.js` um 1 erhöhen.
2. In `runMigrations()` den Block ergänzen:
   ```js
   if (version < 2) {
     db.exec('ALTER TABLE figures ADD COLUMN wohnort TEXT');
     db.prepare('UPDATE schema_version SET version = 2').run();
     logger.info('DB-Migration auf Version 2 abgeschlossen.');
   }
   ```
3. Im GET `/figures/:book_id` die neue Spalte ins zurückgegebene Objekt aufnehmen.
4. Im `_saveFigurenToDb()` die neue Spalte im INSERT berücksichtigen.

**Neue Tabelle:** `CREATE TABLE IF NOT EXISTS` im Schema-Block – keine Versionierung nötig, da idempotent.

**Neue Beziehungstypen:** Keine Schemaänderung. `figure_relations.typ` ist Freitext. Im Frontend in der `BZ`-Konstante (Rendering) und im Claude-Prompt (`FINAL_SCHEMA`) den neuen Typ ergänzen.

**DB auf dem LXC prüfen:**
```bash
sqlite3 /opt/lektorat/lektorat.db
.tables
.schema figures
SELECT * FROM schema_version;
```

## History-API

| Methode | Pfad | Zweck |
|---------|------|-------|
| POST | `/history/check` | Lektorat-Ergebnis speichern |
| PATCH | `/history/check/:id/saved` | Lauf als «in BookStack gespeichert» markieren |
| GET | `/history/page/:page_id` | Letzte 20 Läufe für eine Seite |
| POST | `/history/review` | Buchbewertung speichern |
| GET | `/history/review/:book_id` | Letzte 10 Bewertungen für ein Buch |
| GET | `/figures/:book_id` | Gespeicherte Figuren eines Buchs laden |
| PUT | `/figures/:book_id` | Figuren eines Buchs speichern (überschreibt) |

## BookStack API

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/books` | Alle Bücher laden |
| GET | `/api/chapters?book_id=X` | Kapitel eines Buchs |
| GET | `/api/pages?book_id=X` | Seiten eines Buchs |
| GET | `/api/pages/:id` | Seiteninhalt (HTML) |
| PUT | `/api/pages/:id` | Korrigierte Seite zurückschreiben |

**`bsGetAll(path)`** ist der wichtigste Helfer: BookStack paginiert Listenendpunkte (Standard: 20 Einträge). `bsGetAll` iteriert automatisch alle Seiten und gibt ein flaches Array zurück. Immer `bsGetAll` statt `bsGet` verwenden wenn eine vollständige Liste benötigt wird.

## KI-Integration

### `callAI` – Wichtige Einschränkung

`callAI` (in `api-ai.js`) gibt immer ein **geparstes JSON-Objekt** zurück. Ist die Antwort kein valides JSON, wirft die Funktion einen Fehler. Jeder Systemprompt muss JSON-Only erzwingen:
```
Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach
```
`callAI` kann nicht für Free-Text-Antworten verwendet werden.

### Provider-Proxy

- **`/claude`** – injiziert `ANTHROPIC_API_KEY`, leitet an `api.anthropic.com/v1/messages` weiter, streamt als SSE.
- **`/ollama`** – konvertiert Anthropic-Request-Format → Ollama `/api/chat`-Format, normalisiert NDJSON → SSE. Frontend-Parser bleibt für beide Provider identisch.

### KI-Rückgabeformate

**Seitenlektorat (`runCheck`):**
```json
{
  "fehler": [{ "typ": "rechtschreibung|grammatik|stil", "original": "", "korrektur": "", "kontext": "", "erklaerung": "" }],
  "korrekturen_html": "<vollständiges korrigiertes HTML>",
  "stilanalyse": "...",
  "fazit": "..."
}
```

**Buchbewertung (`runBookReview`):**
```json
{
  "gesamtnote": "1–5",
  "gesamtnote_begruendung": "...",
  "zusammenfassung": "...",
  "struktur": "...",
  "stil": "...",
  "staerken": ["..."],
  "schwaechen": ["..."],
  "empfehlungen": ["..."],
  "fazit": "..."
}
```

**Figurenübersicht (`runFigurExtraction`):**
```json
{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle",
      "beschreibung": "2–3 Sätze",
      "eigenschaften": ["..."],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [
        { "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "..." }
      ]
    }
  ]
}
```

## Frontend-Architektur

SPA aus `index.html`, `style.css` und ES-Modulen – **kein Build-Step**, kein Bundler. Alpine.js und vis-network via CDN.

### Modul-Pattern

Alle `public/js/*.js`-Module (ausser `app.js`, `utils.js`, `prompts.js`, `two-tier.js`) exportieren ein Methoden-Objekt (z.B. `export const lektoratMethods = { ... }`). Die Methoden verwenden `this`, das auf die Alpine-Komponente zeigt – per `...spread` in das Alpine-Data-Objekt eingebettet.

**Neue Funktionalität:** Neues Modul anlegen → Methoden-Objekt exportieren → in `app.js` importieren und am Ende des Data-Objekts spreaden.

### Script-Reihenfolge in `index.html`

Erst `<script type="module" src="js/app.js">`, dann vis-network, dann Alpine mit `defer` – so ist der `alpine:init`-Listener garantiert vor Alpine registriert.

### Style-Regel

**Alle Styles ausschliesslich in `style.css`** – keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML. Die Datei beginnt mit einem Table of Contents (Abschnitte mit `/* === Name === */`).

### Two-Tier-Analyse-Pattern

`review.js` und `figuren.js` teilen dasselbe Lade-Muster via `two-tier.js`:

- `loadPageContents(bsGet, pages, chMap, minLength, onBatch)` – lädt in 5er-Batches, überspringt Seiten kürzer als `minLength`. Gibt `{ title, chapter_id, chapter, text }[]` zurück.
- `groupByChapter(pageContents)` – gruppiert für Multi-Pass nach Kapitel-ID.
- `SINGLE_PASS_LIMIT` = 60 000 Zeichen: darunter Single-Pass direkt an Claude, darüber Multi-Pass pro Kapitel + Konsolidierungs-Call.

### Alpine State

| Property | Zweck |
|----------|-------|
| `books`, `selectedBookId` | Bücherliste und Auswahl |
| `pages`, `tree` | Flache Seitenliste + hierarchische Kapitel/Seiten-Struktur |
| `pageSearch` | Suchfeld (filtert `filteredTree` computed) |
| `currentPage`, `correctedHtml`, `hasErrors` | Aktive Seite und Lektorat-Ergebnis |
| `currentPageEmpty` | Flag: Seite hat keinen Text |
| `originalHtml` | Original-HTML vor Korrekturen |
| `showDiff`, `diffHtml` | Diff-Ansicht: Toggle + gecachtes HTML (LCS-basiert, Wort-Ebene) |
| `showBookCard`, `showEditorCard`, `showBookReviewCard`, `showFiguresCard` | Sichtbarkeits-Flags |
| `status`, `statusSpinner` | Statuszeile |
| `analysisOut`, `bookReviewOut` | HTML-Output (via `x-html`) |
| `checkLoading`, `bookReviewLoading`, `bookReviewProgress` | Lade-States |
| `batchLoading`, `batchProgress`, `batchStatus` | Batch-Check-Status |
| `lastCheckId`, `pageHistory`, `selectedHistoryId` | History-State |
| `bookReviewHistory`, `selectedBookReviewId` | Buchbewertungs-History |
| `tokEsts`, `_tokenEstGen` | Token-Schätzungen (Map `page_id → {tok, words, chars}`); `_tokenEstGen` bricht veraltete Batches ab |
| `figuren`, `figurenLoading`, `figurenProgress`, `figurenStatus` | Figurenübersicht |
| `selectedFigurId` | Aufgeklappte Figur |
| `_figurenNetwork` | vis-network-Instanz (intern) |

### Wichtige Verhaltensdetails

**Selektive Fehlerkorrektur:** `_recomputeCorrectedHtml()` wendet nur `selectedErrors` via `_applyCorrections` auf `originalHtml` an. Claudes `korrekturen_html` wird ignoriert. Stilanmerkungen fliessen nie ins HTML – sie sind rein informativ.

**`resetPage()` vs. `resetView()`:** `resetPage()` deselektiert nur die Seite. `resetView()` setzt alles zurück (Karten, History, Figuren, Graph, Kapitel) – gebunden an H1-Klick.

**Token-Schätzung:** Startet nach `loadPages()` im Hintergrund. `_tokenEstGen` wird bei Buchwechsel inkrementiert – veraltete Batches brechen ab.

## Robustheit – Patterns

- **Schema-Validierung**: Nach jedem `callAI`-Aufruf wird das Pflichtfeld geprüft (`fehler` in `lektorat.js`, `gesamtnote` in `review.js`, `figuren` in `figuren.js`). Fehlt es, Fehler werfen statt falsche Daten rendern.
- **Timeout-Fehlerbehandlung**: `bsGet` und `bsPut` fangen `AbortError` mit sprechender Meldung ab.
- **Graph-Caching**: `renderFigurGraph()` baut vis-network nur neu auf wenn sich Figuren-IDs geändert haben (`_figurenHash`).
- **Benannte Limits**: `MIN_HTML_RATIO` / `SAFETY_HTML_RATIO` in `lektorat.js`, `PREVIEW_MAX_CHARS` in `app.js`, `SINGLE_PASS_LIMIT` / `BATCH_SIZE` in `two-tier.js`.
