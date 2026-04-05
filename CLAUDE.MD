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
                              → /chat/*         → SQLite-DB (lektorat.db) + KI-Streaming (Seiten-Chat)
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
│   ├── chat.js              # /chat/* Endpunkte (Sessions, Nachrichten, SSE-Streaming)
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
        ├── chat.js          # toggleChatCard, sendChatMessage (SSE-Streaming), applyChatVorschlag, Session-CRUD
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

-- Chat-Sessions: eine Session pro Seite + User (mehrere möglich)
chat_sessions (id INTEGER PRIMARY KEY, book_id, book_name, page_id, page_name,
               user_email TEXT, created_at TEXT, last_message_at TEXT)

-- Chat-Nachrichten: eine Zeile pro Nachricht (user + assistant)
chat_messages (id INTEGER PRIMARY KEY, session_id → chat_sessions.id,
               role TEXT,         -- 'user' | 'assistant'
               content TEXT,      -- Freitext der Antwort (antwort-Feld aus KI-JSON)
               vorschlaege TEXT,  -- JSON-Array | NULL (nur bei 'assistant')
               tokens_in INTEGER, tokens_out INTEGER,
               created_at TEXT)

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

**User-Isolation:** Alle inhaltlichen Tabellen (`page_checks`, `book_reviews`, `figures`, `figure_relations`, `chat_sessions`, `chat_messages`) enthalten eine `user_email`-Spalte (bei `chat_messages` indirekt über `session_id`). Queries in den Route-Handlern filtern grundsätzlich auf `req.session.user.email`. `page_stats` und `book_stats_history` sind geteilter Cache ohne User-Filter.

**DB auf dem LXC prüfen:**
```bash
sqlite3 /opt/lektorat/lektorat.db
.tables
.schema figures
SELECT * FROM schema_version;
```

## Endpunkte

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/books` | Alle Bücher laden |
| GET | `/api/chapters?book_id=X` | Kapitel eines Buchs |
| GET | `/api/pages?book_id=X` | Seiten eines Buchs |
| GET | `/api/pages/:id` | Seiteninhalt (HTML) |
| PUT | `/api/pages/:id` | Korrigierte Seite zurückschreiben |
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
| POST | `/chat/session` | Neue Chat-Session erstellen `{ book_id, book_name, page_id, page_name }` |
| GET | `/chat/sessions/:page_id` | Alle Sessions einer Seite (neueste zuerst, max. 20) |
| GET | `/chat/session/:id` | Session + alle Nachrichten laden |
| DELETE | `/chat/session/:id` | Session löschen (kaskadiert auf Nachrichten) |
| POST | `/chat/send` | Nachricht senden + KI-Antwort als SSE streamen; Body: `{ session_id, message, page_text }` |
| GET | `/auth/token` | Ob ein BookStack-Token hinterlegt ist (`{ hasToken: bool }`) |
| PUT | `/auth/token` | BookStack-Token speichern (`{ tokenId, tokenPw }` → DB + Session) |

**`bsGetAll(path)`** ist der wichtigste Helfer: BookStack paginiert Listenendpunkte (Standard: 20 Einträge). `bsGetAll` iteriert automatisch alle Seiten und gibt ein flaches Array zurück. Immer `bsGetAll` statt `bsGet` verwenden wenn eine vollständige Liste benötigt wird.

## User-Token-Verwaltung

BookStack-Tokens werden **pro User in der DB** gespeichert (Tabelle `user_tokens`, Schlüssel: Google-E-Mail).

- Google-Login → `getUserToken(email)` → falls vorhanden: `req.session.bookstackToken = { id, pw }`
- BookStack-Proxy liest Token aus der Session (synchron, kein DB-Lookup pro Request)
- Cron-Sync: `getAnyUserToken()` → erster verfügbarer Token; `getAllUserTokens()` → alle
- Kein Token → Token-Setup-Card im Frontend; `PUT /auth/token` speichert in DB + Session

Hilfsfunktionen exportiert aus `db/schema.js`: `getUserToken`, `setUserToken`, `getAnyUserToken`, `getAllUserTokens`.

## Sync & Buchstatistik

Täglich um 02:00 (`node-cron` in `server.js`) ruft `syncAllBooks()` für alle gespeicherten User-Tokens `syncBook(bookId, token)` auf. `syncBook` berechnet pro Seite Token-Schätzung, Wort- und Zeichenanzahl, schreibt in `page_stats` (Upsert) und legt einen täglichen Snapshot in `book_stats_history` an (ein Eintrag pro Buch pro Tag).

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
    "stilkorrektur":  "Du bist …",
    "chat":           "Du bist …"
  }
}
```

**Konfigurierbar:** `baseRules` und die Rollenformulierung jedes System-Prompts.

**Hartkodiert:** Die JSON-Only-Anweisung, alle JSON-Schema-Definitionen und Feldnamen in den Build-Funktionen.

**Ladereihenfolge:**
- `routes/proxies.js` liest die Datei beim Serverstart (lazy singleton) und liefert sie über `/config` als `promptConfig` ans Frontend.
- `public/js/app.js` ruft `configurePrompts(cfg.promptConfig)` in `init()` auf → aktualisiert die `export let SYSTEM_*`-Variablen in `prompts.js` via ESM-Live-Binding.
- `routes/jobs.js` und `routes/chat.js` lesen die Datei beim Modulstart und rufen `configurePrompts()` einmalig nach dem dynamischen `import()` von `prompts.js` auf.

Fehlt `prompt-config.json`, verwendet `prompts.js` seine eingebauten Defaults – der Server startet normal.

**Single Source of Truth:** Alle Prompts (inkl. JSON-Schemas der KI-Antworten) ausschliesslich in `public/js/prompts.js`.

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

Die kanonischen JSON-Schemas stehen in `public/js/prompts.js` (Build-Funktionen). Pflichtfelder zur Schema-Validierung nach dem Call: `fehler` (Lektorat), `gesamtnote` (Buchbewertung), `figuren` (Figurenextraktion).

## Seiten-Chat

Der Chat funktioniert anders als Review/Figuren: kein Job-Queue, sondern **direktes SSE-Streaming** über `/chat/send`.

**Ablauf `/chat/send`:**
1. Session + User-Berechtigung validieren
2. User-Nachricht in `chat_messages` speichern
3. Kontext server-seitig aufbauen: Figuren + letzte Buchbewertung aus DB, Seitentext aus dem Request
4. `buildChatSystemPrompt()` aus `prompts.js` aufrufen (via dynamischem `import()`)
5. Konversationshistorie der Session laden (alle bisherigen Nachrichten)
6. SSE-Headers setzen, KI-Stream starten und direkt an den Browser durchleiten
7. Nach Stream-Ende: Antwort-JSON parsen (`antwort` + `vorschlaege`), Assistant-Nachricht in DB speichern
8. `meta`-SSE-Event mit IDs, Token-Counts und `vorschlaege` senden, dann `[DONE]`

**KI-Antwortformat (Chat):** `{ "antwort": "Freitext (Markdown)", "vorschlaege": [{ "original", "ersatz", "begruendung" }] }`. `original` muss zeichengenau im Seitentext vorkommen – dasselbe Prinzip wie `_applyCorrections` im Lektorat.

**Fehlerbehandlung:** Der gesamte Handler ist in einem einzigen try/catch. Das Flag `sseStarted` trennt Fehler vor dem Stream-Start (→ JSON 502) von Fehlern während des Streams (→ SSE `{ type: 'error' }` + `[DONE]`). Express 4 fängt Fehler aus `async`-Handlern nicht automatisch – ohne diesen Wrapper schliesst Node die Verbindung ohne HTTP-Antwort, was im Browser als `fetch failed` erscheint.

**Frontend-Streaming:** `sendChatMessage()` in `chat.js` liest den SSE-Stream mit `fetch` + `ReadableStream`. JSON-Parse-Fehler einzelner Chunks werden ignoriert (`continue`). Server-Fehler-Events werden in `streamError` gemerkt und erst nach dem Stream-Ende geworfen.

**Vorschläge übernehmen:** `applyChatVorschlag()` ersetzt `original` zeichengenau in `this.originalHtml` und ruft `bsPut` auf – identisch zum Lektorat-Flow. `this.originalHtml` wird beim ersten `sendChatMessage()` aus der API geladen falls noch nicht gesetzt.

## Frontend-Architektur

SPA aus `index.html`, `style.css` und ES-Modulen – **kein Build-Step**, kein Bundler. Alpine.js und vis-network via CDN.

### Modul-Pattern

Alle `public/js/*.js`-Module (ausser `app.js`, `utils.js`, `prompts.js`, `two-tier.js`) exportieren ein Methoden-Objekt (z.B. `export const lektoratMethods = { ... }`). Die Methoden verwenden `this`, das auf die Alpine-Komponente zeigt – per `...spread` in das Alpine-Data-Objekt eingebettet.

**Neue Funktionalität:** Neues Modul anlegen → Methoden-Objekt exportieren → in `app.js` importieren und am Ende des Data-Objekts spreaden.

### Style-Regel

**Alle Styles ausschliesslich in `style.css`** – keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML. Die Datei beginnt mit einem Table of Contents (Abschnitte mit `/* === Name === */`).

### Two-Tier-Analyse-Pattern

`review.js` und `figuren.js` teilen dasselbe Lade-Muster via `two-tier.js`:

- `loadPageContents(bsGet, pages, chMap, minLength, onBatch)` – lädt in 5er-Batches, überspringt Seiten kürzer als `minLength`. Gibt `{ title, chapter_id, chapter, text }[]` zurück.
- `groupByChapter(pageContents)` – gruppiert für Multi-Pass nach Kapitel-ID.
- `SINGLE_PASS_LIMIT` = 60 000 Zeichen: darunter Single-Pass direkt an Claude, darüber Multi-Pass pro Kapitel + Konsolidierungs-Call.

### Wichtige Verhaltensdetails

**Selektive Fehlerkorrektur:** `_recomputeCorrectedHtml()` wendet nur `selectedErrors` via `_applyCorrections` auf `originalHtml` an. Claudes `korrekturen_html` wird ignoriert.

**Stilanmerkungen:** Werden separat verwaltet (`lektoratStyles`/`selectedStyles`). Beim Speichern (wenn selektierte Stile vorhanden) folgt ein zweiter AI-Call mit `buildStilkorrekturPrompt`, der die Stilkorrekturen auf `correctedHtml` anwendet bevor es in BookStack geschrieben wird.

**`resetPage()` vs. `resetView()`:** `resetPage()` deselektiert nur die Seite. `resetView()` setzt alles zurück (Karten, History, Figuren, Graph, Kapitel) – gebunden an H1-Klick. Beide rufen `resetChat()` auf, damit Chat-State bei Seitenwechsel geleert wird.

**Token-Schätzung:** Startet nach `loadPages()` im Hintergrund. `_tokenEstGen` wird bei Buchwechsel inkrementiert – veraltete Batches brechen ab.

## Robustheit – Patterns

- **Schema-Validierung**: Nach jedem `callAI`-Aufruf wird das Pflichtfeld geprüft (`fehler` in `lektorat.js`, `gesamtnote` in `review.js`, `figuren` in `figuren.js`). Fehlt es, Fehler werfen statt falsche Daten rendern.
- **Timeout-Fehlerbehandlung**: `bsGet` und `bsPut` fangen `AbortError` mit sprechender Meldung ab.
- **Graph-Caching**: `renderFigurGraph()` baut vis-network nur neu auf wenn sich Figuren-IDs geändert haben (`_figurenHash`).
- **Chart-Caching**: `renderStatsChart()` zerstört die Chart.js-Instanz (`_statsChart.destroy()`) vor jedem Neuaufbau.
- **Benannte Limits**: `MIN_HTML_RATIO` / `SAFETY_HTML_RATIO` in `lektorat.js`, `PREVIEW_MAX_CHARS` in `app.js`, `SINGLE_PASS_LIMIT` / `BATCH_SIZE` in `two-tier.js`.
