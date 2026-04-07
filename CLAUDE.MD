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
                              → /chat/*         → SQLite-DB (lektorat.db) + KI-Streaming (Seiten-Chat) + Buch-Chat-Sessions
                              → /sync/*         → Buchstatistik-Sync (manuell + Cron)
                              → /jobs/*         → Hintergrund-Jobs (Status-Polling, inkl. Buch-Chat)
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
│   ├── jobs.js              # /jobs/* Endpunkte (Hintergrund-Jobs: Review, Figurenextraktion, Buch-Chat)
│   ├── chat.js              # /chat/* Endpunkte (Sessions, Nachrichten, SSE-Streaming, Buch-Chat-Sessions)
│   ├── sync.js              # /sync/* Endpunkte + syncAllBooks() (Cron-Entry-Point)
│   └── proxies.js           # /config, /claude (SSE-Proxy), /ollama, /api/* (BookStack-Proxy)
└── public/
    ├── index.html           # Single-Page-App (Alpine.js, kein Build-Step)
    ├── style.css            # Zentrales Stylesheet
    └── js/                  # ES-Module (kein Build-Step, type="module")
        ├── app.js           # Alpine-Komponente: State, Computed, init/selectPage/resetView
        ├── utils.js         # escHtml(), htmlToText()
        ├── prompts.js       # SYSTEM_*-Strings, Build-Funktionen – EINZIGE QUELLE für Prompt-Schemas und Build-Logik. Server-seitiger Code importiert via dynamic import(). NIEMALS Prompts anderswo duplizieren.
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
        ├── book-chat.js     # toggleBookChatCard, sendBookChatMessage (Job-Polling), Session-CRUD, resetBookChat
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
-- Buch-Chat-Sessions: page_id=0, page_name='__book__'
chat_sessions (id INTEGER PRIMARY KEY, book_id, book_name, page_id, page_name,
               user_email TEXT, created_at TEXT, last_message_at TEXT)

-- Chat-Nachrichten: eine Zeile pro Nachricht (user + assistant)
chat_messages (id INTEGER PRIMARY KEY, session_id → chat_sessions.id,
               role TEXT,         -- 'user' | 'assistant'
               content TEXT,      -- Freitext der Antwort (antwort-Feld aus KI-JSON)
               vorschlaege TEXT,  -- JSON-Array | NULL (nur Seiten-Chat, bei 'assistant')
               tokens_in INTEGER, tokens_out INTEGER,
               context_info TEXT, -- JSON | NULL (nur Buch-Chat: {pages, totalPages, figuren, review})
               created_at TEXT)

-- Schemaversion für Migrationen
schema_version (version INTEGER)
```

**Designprinzip Figuren:** Die vier Figuren-Tabellen sind bewusst flach gehalten. Neue Beziehungstypen entstehen einfach durch einen neuen `typ`-String – keine Schemaänderung nötig. Neue Figur-Eigenschaften kommen entweder als neue Spalte (via Migration) oder als Einträge im `meta`-JSON-Feld.

**User-Isolation:** Alle inhaltlichen Tabellen enthalten eine `user_email`-Spalte (bei `chat_messages` indirekt über `session_id`). Queries filtern grundsätzlich auf `req.session.user.email`. `page_stats` und `book_stats_history` sind geteilter Cache ohne User-Filter.

**DB auf dem LXC prüfen:**
```bash
sqlite3 /opt/lektorat/lektorat.db
.tables
.schema figures
SELECT * FROM schema_version;
```

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

## Prompt-Konfiguration

**Pflichtdatei:** `prompt-config.json` (Projektroot) muss vorhanden sein. Fehlt sie, wirft der Server beim Start einen Fehler – es gibt keine eingebauten Defaults. Struktur und Inhalt: siehe `prompt-config.json`.

**Hartkodiert in `prompts.js`:** Die JSON-Only-Anweisung, alle JSON-Schema-Definitionen und Feldnamen in den Build-Funktionen.

**Ladereihenfolge:**
- `routes/proxies.js` liest die Datei beim ersten `/config`-Aufruf (lazy singleton) und liefert sie als `promptConfig` ans Frontend.
- `routes/jobs.js` und `routes/chat.js` lesen die Datei beim Modulstart (synchron) und rufen `configurePrompts()` einmalig nach dem dynamischen `import()` von `prompts.js` auf.
- `public/js/app.js` ruft `configurePrompts(cfg.promptConfig)` in `init()` auf → setzt die `export let SYSTEM_*`-Variablen in `prompts.js` via ESM-Live-Binding.

**Single Source of Truth:** Rollenformulierungen und Basisregeln in `prompt-config.json`; JSON-Schemas und Build-Logik aller Prompts ausschliesslich in `public/js/prompts.js`.

## KI-Integration

**Regel: Alle serverseitigen KI-Calls laufen über die Job-Queue (`/jobs/*`).** Neue Features die einen KI-Call benötigen, implementieren einen Job-Typ in `routes/jobs.js` (Funktion `runXxxJob` + `router.post('/xxx', ...)`). Direkte synchrone KI-Calls aus Route-Handlern (ohne Job-Queue) sind nicht erlaubt – auch nicht für kurze/einfache Operationen. Das Frontend pollt den Job-Status via `_startPoll()`. Ausnahme: Seiten-Chat (`/chat/send`) nutzt bewusst SSE-Streaming statt Jobs.

**`callAI`** (in `lib/ai.js`, importiert von `routes/jobs.js`) gibt immer ein **geparstes JSON-Objekt** zurück – kann nicht für Freitext-Antworten verwendet werden. Jeder Systemprompt muss JSON-Only erzwingen (die `JSON_ONLY`-Konstante in `prompts.js`).

**Schema-Validierung:** Nach jedem `callAI`-Aufruf wird das Pflichtfeld geprüft (`fehler` in `lektorat.js`, `gesamtnote` in `review.js`, `figuren` in `figuren.js`). Fehlt es, Fehler werfen statt falsche Daten rendern.

**Provider-Proxy:**
- **`/claude`** – injiziert `ANTHROPIC_API_KEY`, leitet an `api.anthropic.com/v1/messages` weiter, streamt als SSE. `model` und `max_tokens` werden aus `.env` (MODEL_NAME / MODEL_TOKEN) erzwungen.
- **`/ollama`** – konvertiert Anthropic-Request-Format → Ollama `/api/chat`-Format, normalisiert NDJSON → SSE. Frontend-Parser bleibt für beide Provider identisch.

## Chat

**Seiten-Chat** (`/chat/send`): Direktes SSE-Streaming, kein Job-Queue. KI-Antwortformat: `{ "antwort": "Markdown", "vorschlaege": [{ "original", "ersatz", "begruendung" }] }`. `original` muss zeichengenau im Seitentext vorkommen. `applyChatVorschlag()` ersetzt es identisch zum Lektorat-Flow via `_applyCorrections`.

**Buch-Chat** (`/jobs/book-chat`): Job-Queue statt SSE, kein Vorschläge-System. Buch-Chat-Sessions nutzen `page_id=0` und `page_name='__book__'` in der `chat_sessions`-Tabelle. KI-Antwortformat: `{ "antwort": "Markdown" }`.

**SSE-Fehlerbehandlung:** Das Flag `sseStarted` trennt Fehler vor dem Stream-Start (→ JSON 502) von Fehlern während des Streams (→ SSE `{ type: 'error' }` + `[DONE]`). Express 4 fängt Fehler aus `async`-Handlern nicht automatisch – ohne den try/catch-Wrapper schliesst Node die Verbindung ohne HTTP-Antwort.

**`bsGetAll(path)`:** BookStack paginiert Listenendpunkte (Standard: 20 Einträge). `bsGetAll` iteriert automatisch alle Seiten. Immer `bsGetAll` statt `bsGet` verwenden wenn eine vollständige Liste benötigt wird.

## Frontend-Architektur

SPA aus `index.html`, `style.css` und ES-Modulen – **kein Build-Step**, kein Bundler. Alpine.js und vis-network via CDN.

**Modul-Pattern:** Alle `public/js/*.js`-Module (ausser `app.js`, `utils.js`, `prompts.js`, `two-tier.js`) exportieren ein Methoden-Objekt (z.B. `export const lektoratMethods = { ... }`). Die Methoden verwenden `this`, das auf die Alpine-Komponente zeigt – per `...spread` in das Alpine-Data-Objekt eingebettet. Neue Funktionalität: Modul anlegen → exportieren → in `app.js` spreaden.

**Style-Regel:** Alle Styles ausschliesslich in `style.css` – keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML.

**Two-Tier-Analyse-Pattern:** `review.js` und `figuren.js` laden via `two-tier.js`. `SINGLE_PASS_LIMIT` = 60 000 Zeichen: darunter Single-Pass direkt an Claude, darüber Multi-Pass pro Kapitel + Konsolidierungs-Call.

**Selektive Fehlerkorrektur:** `_recomputeCorrectedHtml()` wendet nur `selectedErrors` via `_applyCorrections` auf `originalHtml` an. Claudes `korrekturen_html` wird ignoriert.

**Stilanmerkungen:** Beim Speichern (wenn selektierte Stile vorhanden) folgt ein zweiter AI-Call mit `buildStilkorrekturPrompt`, der die Stilkorrekturen auf `correctedHtml` anwendet bevor es in BookStack geschrieben wird.
