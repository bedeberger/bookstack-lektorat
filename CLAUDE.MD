# bookstack-lektorat – Technische Referenz

KI-gestütztes Lektorat-Tool für BookStack. Deployment, Konfiguration und Docker-Setup: siehe [README.md](README.md).

## Architektur

```
Browser → NGINX (HTTPS) → Express (Port 3737)
                              → /auth/login     → redirect zu Google (OIDC)
                              → /auth/callback  → Token validieren, Session anlegen
                              → /auth/logout    → Session löschen
                              → /auth/me        → aktueller User (JSON)
                              → /config         → Modell-Config + User (keine Credentials)
                              → /history/*      → SQLite-DB (lektorat.db)
                              → /figures/*      → SQLite-DB (lektorat.db)
                              → /sync/*         → Buchstatistik-Sync (manuell + Cron)
                              → /jobs/*         → Hintergrund-Jobs (Status-Polling)
                              → /claude         → api.anthropic.com (ANTHROPIC_API_KEY-Injection)
                              → /ollama         → Ollama /api/chat (OLLAMA_HOST, lokales Modell)
                              → /api/*          → BookStack (Token aus req.session.bookstackToken, serverseitig)
                              → /               → public/index.html

Cron (täglich 02:00) → syncAllBooks() → getAllUserTokens() → page_stats + book_stats_history
```

**Auth-Flow:** Alle Routen ausser `/auth/*` sind durch einen Session-Guard geschützt. Nicht authentifizierte Requests auf HTML-Pfade → Redirect `/auth/login` → Google → `/auth/callback` → Session → `/`. API-Pfade (JSON-Requests) → `401 JSON`.

KI-Aufrufe laufen **nicht direkt aus dem Browser**, sondern über den jeweiligen Proxy-Endpunkt – der Server hält alle Credentials. Der BookStack-Proxy injiziert den per-User-Token aus `req.session.bookstackToken` serverseitig; das Frontend sendet keinen Authorization-Header.

## Projektstruktur

```
bookstack-lektorat/
├── server.js                # Express-Setup + Session + Auth-Guard + Route-Mounting + Cron
├── logger.js                # Winston-Logger (Singleton, von allen Modulen importiert)
├── db/
│   └── schema.js            # DB-Setup, Schema, Migrationen, saveFigurenToDb(), Token-Helpers
├── routes/
│   ├── auth.js              # /auth/* Endpunkte (Google OIDC: login, callback, logout, me, token)
│   ├── history.js           # /history/* Endpunkte (Checks, Reviews, Page-Stats, Book-Stats)
│   ├── figures.js           # /figures/:book_id Endpunkte (per-User)
│   ├── jobs.js              # /jobs/* Endpunkte (Hintergrund-Jobs: Review, Figurenextraktion)
│   ├── sync.js              # /sync/* Endpunkte + syncAllBooks() (Cron-Entry-Point)
│   └── proxies.js           # /config, /claude (SSE-Proxy), /ollama, /api/* (BookStack-Proxy)
└── public/
    ├── index.html           # Single-Page-App (Alpine.js, kein Build-Step)
    ├── style.css            # Zentrales Stylesheet
    └── js/                  # ES-Module (kein Build-Step, type="module")
        ├── app.js           # Alpine-Komponente: State, Computed, init/selectPage/resetView
        ├── utils.js         # escHtml(), htmlToText()
        ├── prompts.js       # SYSTEM_*-Strings, buildLektoratPrompt(), buildStilkorrekturPrompt() – EINZIGE QUELLE für alle Prompts. Server-seitiger Code (jobs.js) importiert diese Datei via dynamic import(). NIEMALS Prompts anderswo duplizieren.
        ├── api-bookstack.js # bsGet, bsGetAll, bsPut, _applyCorrections
        ├── api-ai.js        # callAI(userPrompt, systemPrompt?, onProgress?) → Promise<Object>
        ├── history.js       # loadPageHistory, loadBookReviewHistory
        ├── tree.js          # loadBooks, loadPages, loadTokenEstimates
        ├── lektorat.js      # runCheck, saveCorrections, toggleDiff, batchCheck, computeDiff
        ├── review.js        # runBookReview
        ├── figuren.js       # runFigurExtraction, loadFiguren, saveFiguren, toggleFiguresCard
        ├── graph.js         # renderFigurGraph, _figTypColor
        ├── bookstats.js     # toggleBookStatsCard, loadBookStats, syncBookStats, renderStatsChart
        └── two-tier.js      # loadPageContents(), groupByChapter(), SINGLE_PASS_LIMIT
```

## Datenbankschema

```sql
-- BookStack API-Tokens pro User (verknüpft mit Google-E-Mail)
user_tokens (email TEXT PRIMARY KEY,
             token_id TEXT, token_pw TEXT,  -- werden nie ans Frontend gesendet
             updated_at TEXT)

-- Lektorat-Checks pro Seite
page_checks (id, page_id, page_name, book_id, checked_at, error_count,
             errors_json TEXT,          -- JSON-Array der Fehler
             stilanalyse, fazit, model,
             saved INTEGER, saved_at,
             applied_errors_json TEXT)  -- welche Fehler tatsächlich ins BookStack gespeichert wurden

-- Buchbewertungen
book_reviews (id, book_id, book_name, reviewed_at,
              review_json TEXT,  -- JSON-Objekt der Gesamtbewertung
              model)

-- Figuren: eine Zeile pro Figur, Kernfelder fix (per-User via user_email)
figures (id, book_id, user_email TEXT, fig_id TEXT,  -- "fig_1" etc., stabil über Saves
         name, kurzname, typ, geburtstag, geschlecht, beruf, beschreibung,
         sort_order INTEGER, meta TEXT,  -- JSON für zukünftige Zusatzfelder
         updated_at)
-- UNIQUE auf (book_id, fig_id, user_email)

-- Eigenschaften/Tags einer Figur (eine Zeile pro Tag)
figure_tags (figure_id → figures.id, tag TEXT)

-- Kapitelauftritte (eine Zeile pro Figur + Kapitel)
figure_appearances (figure_id → figures.id, chapter_name TEXT, haeufigkeit INTEGER)

-- Beziehungen: flat, typ ist Freitext → neue Typen ohne Schemaänderung
figure_relations (id, book_id, user_email TEXT, from_fig_id TEXT, to_fig_id TEXT,
                  typ TEXT,          -- elternteil|freund|… oder beliebig neuer Typ
                  beschreibung TEXT)

-- Seiten-Stats-Cache (befüllt vom Sync-Job, für schnelles UI-Laden)
page_stats (page_id INTEGER PRIMARY KEY, book_id, tok, words, chars, updated_at, cached_at)

-- Tägliche Buchstatistik-Snapshots (für Zeitliniendiagramm)
book_stats_history (id, book_id, book_name, recorded_at,
                    page_count, words, chars, tok)
-- UNIQUE auf (book_id, recorded_at) → je Buch ein Snapshot pro Tag

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

**User-Isolation:** Alle inhaltlichen Tabellen (`page_checks`, `book_reviews`, `figures`, `figure_relations`) enthalten eine `user_email`-Spalte. Queries in den Route-Handlern filtern grundsätzlich auf `req.session.user.email`. `page_stats` und `book_stats_history` sind geteilter Cache ohne User-Filter. Schema-Version 4 hat die UNIQUE-Constraint von `figures` auf `(book_id, fig_id, user_email)` angepasst.

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
| PATCH | `/history/check/:id/saved` | Lauf als «in BookStack gespeichert» markieren (inkl. `applied_errors_json`) |
| DELETE | `/history/check/:id` | Check-Eintrag löschen |
| GET | `/history/page/:page_id` | Letzte 20 Läufe für eine Seite |
| POST | `/history/review` | Buchbewertung speichern |
| GET | `/history/review/:book_id` | Letzte 10 Bewertungen für ein Buch |
| DELETE | `/history/review/:id` | Review-Eintrag löschen |
| GET | `/history/page-stats/:book_id` | Gecachte Seiten-Stats (Map `page_id → {tok, words, chars}`) |
| POST | `/history/page-stats/batch` | Batch-Upsert für page_stats-Cache |
| GET | `/history/book-stats/:book_id` | Tägliche Buchstatistik-Snapshots (für Zeitliniendiagramm) |
| GET | `/figures/:book_id` | Gespeicherte Figuren eines Buchs laden (per-User) |
| PUT | `/figures/:book_id` | Figuren eines Buchs speichern – überschreibt (per-User) |
| POST | `/sync/book/:book_id` | Manueller Sync-Trigger für ein Buch |
| POST | `/sync/all` | Manueller Sync aller Bücher (wird auch vom Cron aufgerufen) |
| GET | `/jobs/active` | Alle laufenden/wartenden Jobs |
| GET | `/jobs/:id` | Status + Details eines Jobs |
| POST | `/jobs/review` | Buchbewertungs-Job starten |
| POST | `/jobs/figures` | Figurenextraktions-Job starten |
| GET | `/auth/token` | Ob ein BookStack-Token hinterlegt ist (`{ hasToken: bool }`) |
| PUT | `/auth/token` | BookStack-Token speichern (`{ tokenId, tokenPw }` → DB + Session) |

## User-Token-Verwaltung

BookStack-Tokens werden **pro User in der DB** gespeichert (Tabelle `user_tokens`, Schlüssel: Google-E-Mail). Kein gemeinsamer Service-Account-Token mehr in `.env`.

**Flow:**
1. Google-Login → `getUserToken(email)` → falls vorhanden: `req.session.bookstackToken = { id, pw }`
2. BookStack-Proxy liest Token aus `req.session.bookstackToken` (synchron, kein DB-Lookup pro Request)
3. Cron-Sync: `getAnyUserToken()` → nimmt irgendeinen gespeicherten Token
4. Kein Token → Token-Setup-Card im Frontend; `PUT /auth/token` speichert in DB + Session

**Hilfsfunktionen** (exportiert aus `db/schema.js`):
- `getUserToken(email)` → `{ token_id, token_pw }` oder `undefined`
- `setUserToken(email, tokenId, tokenPw)` → UPSERT
- `getAnyUserToken()` → erster verfügbarer Token (für Hintergrundprozesse)
- `getAllUserTokens()` → Array aller gespeicherten Tokens – wird vom Sync-Job verwendet, um alle User-Bücher zu synchronisieren

## Sync & Buchstatistik

### Automatischer Cron-Sync

`server.js` registriert via `node-cron` täglich um 02:00 einen Sync-Job:

```js
cron.schedule('0 2 * * *', () => syncAllBooks());
```

`syncAllBooks()` (exportiert aus `routes/sync.js`) iteriert alle gespeicherten User-Tokens via `getAllUserTokens()` und ruft für jedes gefundene Buch `syncBook(bookId, token)` auf.

### `syncBook(bookId, token)`

- Holt alle Seiten des Buchs via BookStack-API
- Berechnet pro Seite: Token-Schätzung, Wortanzahl, Zeichenanzahl
- Schreibt Ergebnisse in `page_stats` (Upsert, gecacht für schnelles UI-Laden)
- Legt einen täglichen Snapshot in `book_stats_history` an (UNIQUE auf `book_id + recorded_at` → ein Eintrag pro Buch pro Tag)

### `bookstats.js` (Frontend)

Exportiert `bookstatsMethods` mit:
- `toggleBookStatsCard()` – Statistik-Panel öffnen/schliessen + Daten nachladen
- `loadBookStats(bookId)` – GET `/history/book-stats/:book_id`
- `syncBookStats()` – POST `/sync/book/:book_id` → manueller Sync
- `renderStatsChart()` – Chart.js-Zeitliniendiagramm mit konfigurierbarer Metrik (`words`, `chars`, `tok`, `page_count`) und Datumsbereich

**Abhängigkeiten:** Chart.js via CDN in `index.html` eingebunden.

**Relevante State-Properties:** `showBookStatsCard`, `bookStatsData`, `bookStatsLoading`, `bookStatsSyncStatus`, `bookStatsMetric`, `bookStatsRange`, `_statsChart` (Chart.js-Instanz, intern).

## BookStack API

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/books` | Alle Bücher laden |
| GET | `/api/chapters?book_id=X` | Kapitel eines Buchs |
| GET | `/api/pages?book_id=X` | Seiten eines Buchs |
| GET | `/api/pages/:id` | Seiteninhalt (HTML) |
| PUT | `/api/pages/:id` | Korrigierte Seite zurückschreiben |

**`bsGetAll(path)`** ist der wichtigste Helfer: BookStack paginiert Listenendpunkte (Standard: 20 Einträge). `bsGetAll` iteriert automatisch alle Seiten und gibt ein flaches Array zurück. Immer `bsGetAll` statt `bsGet` verwenden wenn eine vollständige Liste benötigt wird.

## Prompt-Konfiguration

### `prompt-config.json`

Admins können die **inhaltlichen** Teile aller System-Prompts in `prompt-config.json` (Projektroot) anpassen – ohne Code-Änderung, nur Serverrestart nötig.

```json
{
  "baseRules": "Freitext: Schweizer-Kontext-Regeln, Fehler-Entscheidungsregeln …",
  "systemPrompts": {
    "lektorat":       "Du bist …",
    "buchbewertung":  "Du bist …",
    "kapitelanalyse": "Du bist …",
    "figuren":        "Du bist …",
    "stilkorrektur":  "Du bist …"
  }
}
```

**Konfigurierbar:** `baseRules` (Schweizer-Kontext-Regeln, Superregeln) und die Rollenformulierung jedes System-Prompts.

**Hartkodiert (nicht konfigurierbar):** Die JSON-Only-Anweisung (`Antworte ausschliesslich mit einem JSON-Objekt…`), alle JSON-Schema-Definitionen und Feldnamen in den Build-Funktionen.

**Ladereihenfolge:**
- `routes/proxies.js` liest die Datei beim Serverstart (lazy singleton) und liefert sie über `/config` als `promptConfig` ans Frontend.
- `public/js/app.js` ruft `configurePrompts(cfg.promptConfig)` in `init()` auf → aktualisiert die `export let SYSTEM_*`-Variablen in `prompts.js` via ESM-Live-Binding.
- `routes/jobs.js` liest die Datei synchron beim Modulstart und ruft `configurePrompts()` einmalig nach dem dynamischen `import()` von `prompts.js` auf.

Fehlt `prompt-config.json`, loggen beide Server-Module eine Warnung und `prompts.js` verwendet seine eingebauten Defaults – der Server startet normal.

**Single Source of Truth:** Alle Prompts bleiben ausschliesslich in `public/js/prompts.js`. `prompt-config.json` überschreibt nur die konfigurierbaren Teile über `configurePrompts()`.

## KI-Integration

### `callAI` – Wichtige Einschränkung

`callAI` (in `api-ai.js`) gibt immer ein **geparstes JSON-Objekt** zurück. Ist die Antwort kein valides JSON, wirft die Funktion einen Fehler. Jeder Systemprompt muss JSON-Only erzwingen:
```
Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach
```
`callAI` kann nicht für Free-Text-Antworten verwendet werden.

### Provider-Proxy

- **`/claude`** – injiziert `ANTHROPIC_API_KEY`, leitet an `api.anthropic.com/v1/messages` weiter, streamt als SSE. `model` und `max_tokens` werden aus `.env` (MODEL_NAME / MODEL_TOKEN) erzwungen – das Frontend kann diese Werte nicht übersteuern.
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

Alle `public/js/*.js`-Module (ausser `app.js`, `utils.js`, `prompts.js`, `two-tier.js`) exportieren ein Methoden-Objekt (z.B. `export const lektoratMethods = { ... }`). Die Methoden verwenden `this`, das auf die Alpine-Komponente zeigt – per `...spread` in das Alpine-Data-Objekt eingebettet. `bookstats.js` folgt demselben Pattern (`bookstatsMethods`).

**Neue Funktionalität:** Neues Modul anlegen → Methoden-Objekt exportieren → in `app.js` importieren und am Ende des Data-Objekts spreaden.

### Script-Reihenfolge in `index.html`

Erst `<script type="module" src="js/app.js">`, dann vis-network, dann Chart.js, dann Alpine mit `defer` – so ist der `alpine:init`-Listener garantiert vor Alpine registriert.

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
| `currentUser` | Eingeloggter User `{ email, name }` aus `/config` (via Session) |
| `books`, `selectedBookId` | Bücherliste und Auswahl |
| `pages`, `tree` | Flache Seitenliste + hierarchische Kapitel/Seiten-Struktur |
| `pageSearch` | Suchfeld (filtert `filteredTree` computed) |
| `showTreeCard` | Sichtbarkeits-Flag für den Tree-Panel |
| `currentPage`, `correctedHtml`, `hasErrors` | Aktive Seite und Lektorat-Ergebnis |
| `currentPageEmpty` | Flag: Seite hat keinen Text |
| `currentPageUpdatedAt` | Letztes Update-Datum der Seite (aus BookStack) |
| `originalHtml` | Original-HTML vor Korrekturen |
| `lektoratErrors`, `selectedErrors` | Alle Fehler aus dem letzten Check; davon selektierte (werden angewendet) |
| `lektoratStyles`, `selectedStyles` | Stilanmerkungen; rein informativ, fliessen nie ins HTML |
| `checkDone` | Flag: Lektorat-Check abgeschlossen |
| `showDiff`, `diffHtml` | Diff-Ansicht: Toggle + gecachtes HTML (LCS-basiert, Wort-Ebene) |
| `showBookCard`, `showEditorCard`, `showBookReviewCard`, `showFiguresCard` | Sichtbarkeits-Flags |
| `showTokenSetup`, `tokenSetupId`, `tokenSetupPw`, `tokenSetupError`, `tokenSetupLoading` | Token-Setup-Card (kein BookStack-Token hinterlegt) |
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
| `showBookStatsCard`, `bookStatsData` | Buchstatistik-Panel: Sichtbarkeit + geladene History-Daten |
| `bookStatsLoading`, `bookStatsSyncStatus` | Lade-State + Sync-Statusmeldung |
| `bookStatsMetric`, `bookStatsRange` | Angezeigte Metrik (`words`\|`chars`\|`tok`\|`page_count`) + Datumsbereich |
| `_statsChart` | Chart.js-Instanz (intern) |

### Wichtige Verhaltensdetails

**Selektive Fehlerkorrektur:** `_recomputeCorrectedHtml()` wendet nur `selectedErrors` via `_applyCorrections` auf `originalHtml` an. Claudes `korrekturen_html` wird ignoriert. Stilanmerkungen fliessen nie ins HTML – sie sind rein informativ.

**`resetPage()` vs. `resetView()`:** `resetPage()` deselektiert nur die Seite. `resetView()` setzt alles zurück (Karten, History, Figuren, Graph, Kapitel) – gebunden an H1-Klick.

**Token-Schätzung:** Startet nach `loadPages()` im Hintergrund. `_tokenEstGen` wird bei Buchwechsel inkrementiert – veraltete Batches brechen ab.

## Robustheit – Patterns

- **Schema-Validierung**: Nach jedem `callAI`-Aufruf wird das Pflichtfeld geprüft (`fehler` in `lektorat.js`, `gesamtnote` in `review.js`, `figuren` in `figuren.js`). Fehlt es, Fehler werfen statt falsche Daten rendern.
- **Timeout-Fehlerbehandlung**: `bsGet` und `bsPut` fangen `AbortError` mit sprechender Meldung ab.
- **Graph-Caching**: `renderFigurGraph()` baut vis-network nur neu auf wenn sich Figuren-IDs geändert haben (`_figurenHash`).
- **Chart-Caching**: `renderStatsChart()` zerstört die Chart.js-Instanz (`_statsChart.destroy()`) vor jedem Neuaufbau.
- **Benannte Limits**: `MIN_HTML_RATIO` / `SAFETY_HTML_RATIO` in `lektorat.js`, `PREVIEW_MAX_CHARS` in `app.js`, `SINGLE_PASS_LIMIT` / `BATCH_SIZE` in `two-tier.js`.
