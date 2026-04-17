# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Deployment, Docker-Setup und Env-Variablen: siehe [README.md](README.md).

## Harte Regeln

- **Prompts nur in `public/js/prompts.js`** — einzige Quelle für alle Prompt-Schemas und Build-Logik. Server importiert via dynamic `import()`. NIEMALS Prompts in Route-Handlern, Config-Dateien oder anderswo duplizieren.
- **KI-Calls nur via Job-Queue** — neue Features implementieren einen Job-Typ in `routes/jobs/` (Funktion `runXxxJob` + `router.post`). Direkte synchrone KI-Calls aus Route-Handlern sind verboten. Einzige Ausnahme: Seiten-Chat (`/chat/send`) nutzt bewusst SSE-Streaming.
- **`callAI` gibt nur JSON zurück** — jeder Systemprompt muss JSON-Only erzwingen (`JSON_ONLY`-Konstante in `prompts.js`). Nach jedem `callAI`-Aufruf Pflichtfeld prüfen (z.B. `fehler`, `gesamtnote`, `figuren`). Fehler werfen statt falsche Daten rendern.
- **Styles nur in `style.css`** — keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML.
- **`bsGetAll` statt `bsGet` für Listen** — BookStack paginiert (Standard 20 Einträge). `bsGetAll` iteriert alle Seiten automatisch.
- **401-Handling zentral** — ein globaler `window.fetch`-Wrapper in `public/js/app.js` fängt alle 401-Antworten ab und dispatcht `session-expired`; Alpine zeigt daraufhin den Session-Banner. Feature-Module prüfen 401 nicht selbst und dürfen das Event nicht unterdrücken. Kein Auto-Redirect – User soll ungespeicherte Inhalte retten können.

## Neues Feature hinzufügen

### Backend (KI-Job)

1. Job-Datei in `routes/jobs/` anlegen (Pattern: siehe `routes/jobs/review.js`)
2. `runXxxJob`-Funktion + `router.post('/xxx', ...)` implementieren
3. Router in `routes/jobs.js` mounten
4. Prompt-Builder in `public/js/prompts.js` ergänzen
5. Schema-Validierung nach `callAI` nicht vergessen

### Frontend

1. Neues Modul in `public/js/` → Methoden-Objekt exportieren (z.B. `export const xxxMethods = { ... }`)
2. Methoden verwenden `this` (zeigt auf Alpine-Komponente)
3. In `public/js/app.js` per `...spread` einbinden

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Jedes Buchebenen-Toggle ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor)
- `selectPage()` schliesst alle Buchkarten bevor der Editor öffnet
- Neues Feature-Toggle immer nach diesem Muster implementieren

## Prompt-System

**Zwei Dateien, klare Trennung:**
- `prompt-config.json` (Projektroot, Pflichtdatei) — Rollenformulierungen, Basisregeln, Buchtypen pro Sprache. Fehlt sie → Server-Crash beim Start.
- `public/js/prompts.js` — JSON-Schemas, Build-Logik, `configurePrompts()`. Wird sowohl vom Server (dynamic `import()`) als auch vom Frontend (ESM) geladen.

**Ladereihenfolge:**
- Server: `routes/jobs.js` und `routes/chat.js` lesen `prompt-config.json` synchron beim Modulstart → `configurePrompts()` einmalig. `routes/proxies.js` liefert die Config lazy beim ersten `/config`-Call ans Frontend.
- Frontend: `app.js` → `init()` → `configurePrompts(cfg.promptConfig)` → setzt `SYSTEM_*`-Variablen via ESM-Live-Binding.

**Buchtypen:** In `prompt-config.json` unter `buchtypen`, aufgeteilt nach Sprachcode (`de`, `en`). Jeder Key hat `label` + `zusatz`. Neuer Typ: in beiden Sprachen ergänzen.

**Per-Buch-Kontext:** `getBookPrompts(bookId)` → `getLocalePromptsForBook()` augmentiert `baseRules` dynamisch mit Buchtyp-Zusatztext (`BUCHTYP-KONTEXT:`) und Freitext des Users (`VORRANGIGE ANGABEN DES AUTORS:` – übersteuert bei Konflikt die Basisregeln, insbesondere Stil/Ton/Format).

## Datenbank

Schema, Tabellen und Migrationslogik: siehe [db/schema.js](db/schema.js).

**Migration hinzufügen:** Neuen `if (version < N)`-Block in `runMigrations()` ergänzen (N = nächste fortlaufende Nummer, aktuell bei 40) + `UPDATE schema_version SET version = N`. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` — keine Versionierung nötig.

**Neuer Beziehungstyp:** Keine Schemaänderung. `figure_relations.typ` ist Freitext. Neuen Typ in der `BZ`-Konstante (Frontend-Rendering) und im Claude-Prompt (`FINAL_SCHEMA` in `prompts.js`) ergänzen.

## Architektur-Überblick

```
Browser → NGINX (HTTPS) → Express (Port 3737)
  /auth/*    → Google OIDC (Login/Callback/Logout/Me)
  /config    → Modell-Config + User (keine Credentials)
  /api/*     → BookStack-Proxy (Token aus Session, serverseitig)
  /claude    → api.anthropic.com (ANTHROPIC_API_KEY-Injection, SSE)
  /ollama    → Ollama /api/chat (NDJSON → SSE normalisiert)
  /jobs/*    → Hintergrund-Jobs (Status-Polling, alle KI-Analysen)
  /chat/*    → Seiten-Chat (SSE-Streaming) + Buch-Chat-Sessions
  /history/* → Job-Verlauf (SQLite)
  /figures/* → Figuren-CRUD (SQLite)
  /sync/*    → Buchstatistik-Sync (manuell + Cron)
  /          → public/index.html (SPA)

Cron (täglich 02:00) → syncAllBooks() → page_stats + book_stats_history
```

**Auth:** Alle Routen ausser `/auth/*` sind durch Session-Guard geschützt. HTML-Requests → Redirect auf Login. API-Requests → `401 JSON`.

**Credentials:** KI-Aufrufe laufen über Server-Proxies — der Server hält alle API-Keys. Der BookStack-Proxy injiziert `req.session.bookstackToken` serverseitig.

## KI-Provider

Drei Provider, konfiguriert via `API_PROVIDER` in `.env`:

| Provider | Env-Vars | Besonderheit |
|----------|----------|--------------|
| `claude` | `ANTHROPIC_API_KEY`, `MODEL_NAME` | Prompt-Caching (`cache_control: ephemeral`), grosses Kontextfenster |
| `ollama` | `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_TEMPERATURE` | Mutex-Serialisierung (VRAM-Schutz), dynamische `num_ctx`-Berechnung |
| `llama` | `LLAMA_HOST`, `LLAMA_MODEL`, `LLAMA_TEMPERATURE` | llama.cpp, ebenfalls Mutex-serialisiert |

**`MODEL_TOKEN`** setzt den globalen Output-Token-Cap (`MAX_TOKENS_OUT` in `lib/ai.js`, Default 64 000). Job-spezifische Overrides werden per `Math.min` gedeckelt.

**JSON-Parsing:** `lib/ai.js` hat mehrstufigen Fallback: `JSON.parse()` → `extractBalancedJson()` → `jsonrepair()`.

## Two-Tier-Analyse

Jobs in `routes/jobs/` verwenden ein Single-Pass/Multi-Pass-Muster. Limits und Batch-Grössen sind als Konstanten in `routes/jobs/shared.js` definiert — dort nachschlagen statt hier. Für `komplett-analyse` gilt ein höheres Limit bei Claude (passt ins 200K-Token-Kontextfenster).

## Komplettanalyse-Job

**Pipeline-Phasen und Abhängigkeiten:**

```
Phase 1 – Vollextraktion (parallel pro Kapitel oder Single-Pass)
          → figuren, orte, fakten, szenen(Namen), assignments(Namen)
          → Checkpoint 'p1_full_done'
                    ↓
Phase 2 – Figuren konsolidieren + Soziogramm (aus P2-Output, kein Extra-Call)
Phase 3 – Schauplätze konsolidieren
Phase 3b – Kapitelübergreifende Beziehungen (nur Multi-Pass, non-critical)
                    ↓
Block 2 [parallel]:
  Phase 5 – Szenen remappen (kein API-Call, Namen → IDs)
  Phase 6 – Zeitstrahl konsolidieren
  Phase 8 – Kontinuitätscheck (Single-Pass: voller Text, Multi-Pass: Fakten)
```

**Standalone-Kontinuitätscheck:** `POST /jobs/kontinuitaet` — läuft Phase 8 einzeln, ohne die volle Pipeline. Exportiert `runKontinuitaetJob` aus `routes/jobs/komplett.js`.

**Wichtige Mechanismen:**
- **Delta-Cache:** Phase 1 (Multi-Pass) prüft `chapter_extract_cache` in der DB. Cache-Key enthält `pages_sig` (sortierte `page_id:updated_at`-Paare). Ändert sich eine Seite → Cache-Miss → Neu-Extraktion. Single-Pass wird nicht gecacht.
- **Prompt-Caching:** System-Prompt mit eingebettetem Schema wird bei parallelen Kapitel-Calls gecacht (~10% des Input-Preises für Folge-Calls).
- **Checkpoint-Wiederaufnahme:** `p1_full_done` speichert alle 5 Arrays. Alte `p1_done`-Checkpoints werden verworfen → Job-Neustart.

## Chat

- **Seiten-Chat** (`/chat/send`): SSE-Streaming, kein Job-Queue. Antwortformat enthält `vorschlaege` mit zeichengenauem `original` für Textersetzung.
- **Buch-Chat** (`/jobs/book-chat`): Job-Queue, kein Vorschläge-System. Sessions nutzen `page_id=0`, `page_name='__book__'`.
- **SSE-Fehler:** `sseStarted`-Flag trennt Pre-Stream-Fehler (→ JSON 502) von Mid-Stream-Fehler (→ SSE `{ type: 'error' }` + `[DONE]`).

## Fehlerbehandlung

- **Jobs:** `try/catch` → `failJob(id, err)` setzt Status auf `'error'` oder `'cancelled'` (bei `AbortError`). Fehler werden in `job.error` gespeichert und geloggt.
- **API-Routen:** Fehlende Parameter → `400 JSON`, unauthentifiziert → `401 JSON`.
- **JSON-Parsing:** Mehrstufiger Fallback in `lib/ai.js` (siehe KI-Provider).
- **DB-Fehler:** Geloggt, blockieren nicht den Request.

## Logging

Winston (`logger.js`): Level `info`, Ausgabe in `lektorat.log` (5 MB, 3 Dateien rotiert) + Console. Jobs nutzen Child-Logger mit Kontext: `logger.child({ job, user, book })` → Format: `[INFO][lektorat|user@mail.com|42] Nachricht`.

## Projektstruktur

```
server.js              – Express-Setup, Auth-Guard, Cron, Route-Mounting
logger.js              – Winston-Config
lib/ai.js              – callAI(), Provider-Dispatch, JSON-Parsing
db/schema.js           – SQLite-Schema, Migrationen, alle DB-Funktionen
routes/
  auth.js              – Google OIDC
  proxies.js           – KI-Provider-Proxies + BookStack-Proxy
  jobs.js              – Job-Router (mountet Feature-Router)
  jobs/shared.js       – Job-Queue, Limits, loadPageContents, Hilfsfunktionen
  jobs/lektorat.js     – Seiten-Lektorat
  jobs/review.js       – Buchbewertung
  jobs/komplett.js     – Komplettanalyse-Pipeline
  jobs/chat.js         – Buch-Chat
  chat.js              – Seiten-Chat (SSE)
  figures.js, locations.js, history.js, sync.js, booksettings.js
public/
  index.html           – SPA-Shell
  style.css            – Alle Styles (einzige Quelle)
  js/app.js            – Alpine-Root, Feature-Module per ...spread
  js/prompts.js        – Prompt-Schemas + Build-Logik (shared Server/Frontend)
  js/utils.js          – Gemeinsame Hilfsfunktionen
  js/chat-base.js      – Geteilte Chat-Infrastruktur (Seiten- + Buch-Chat)
  js/*.js              – Feature-Module (lektorat, review, figuren, chat, etc.)
```

## Keine Tests

Das Projekt hat keine automatisierten Tests. Validierung erfolgt manuell.
