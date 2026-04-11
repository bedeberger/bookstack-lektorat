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

`server.js`, `logger.js`, `db/`, `routes/`, `public/` – Struktur folgt dem Architekturdiagramm oben.

Nicht-offensichtliche Dateien:

- `public/js/prompts.js` – EINZIGE QUELLE für alle Prompt-Schemas und Build-Logik. Server importiert via dynamic `import()`. NIEMALS Prompts anderswo duplizieren.
- `public/js/two-tier.js` – Exportiert `loadPageContents`, `groupByChapter`, `SINGLE_PASS_LIMIT` (wird aktuell nicht importiert; gleiche Logik lebt dupliziert in `routes/jobs.js`).
- `public/js/app.js` – Alpine-Root; alle Feature-Module per `...spread` eingebunden.

## Datenbank

Schema, Tabellen und Migrationslogik: siehe [db/schema.js](db/schema.js).

**Migrationen:** `CURRENT_SCHEMA_VERSION` erhöhen, `if (version < N)`-Block in `runMigrations()` ergänzen. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` – keine Versionierung nötig.

**Neue Beziehungstypen:** Keine Schemaänderung. `figure_relations.typ` ist Freitext. Im Frontend in der `BZ`-Konstante (Rendering) und im Claude-Prompt (`FINAL_SCHEMA`) den neuen Typ ergänzen.

**DB auf dem LXC prüfen:**
```bash
sqlite3 /opt/lektorat/lektorat.db
.tables
SELECT * FROM schema_version;
```

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

**Feature-Exklusivität (Standardverhalten):** Features überschreiben sich gegenseitig – es ist immer nur eine Hauptansicht aktiv. Buchebenen-Features (Figuren, Szenen, Ereignisse, Orte, Kontinuität, Buchbewertung, Buchstatistik, Buch-Chat) und Seitenebenen-Features (Lektorat-Editor) sind gegenseitig exklusiv. Jedes Buchebenen-Toggle ruft `_closeOtherMainCards(keep)` in `app.js` auf – das schliesst alle anderen Buchkarten und ruft `resetPage()` auf (schliesst Editor + Seiten-Features). `selectPage()` schliesst seinerseits alle Buchkarten bevor es den Editor öffnet. Neues Feature-Toggle immer nach diesem Muster implementieren.

**Two-Tier-Analyse-Pattern:** `routes/jobs.js` implementiert für Review, Figurenextraktion und Buch-Chat ein Two-Tier-Muster: `SINGLE_PASS_LIMIT` = 60 000 Zeichen – darunter Single-Pass direkt an Claude, darüber Multi-Pass pro Kapitel + Konsolidierungs-Call.

## Komplettanalyse-Job (`komplett-analyse`)

Der Button **«Alles aktualisieren»** ruft seit der Umstellung nicht mehr einzelne Jobs nacheinander auf, sondern einen einzigen serverseitigen Job `/jobs/komplett-analyse`. Dieser ersetzt die frühere frontend-gesteuerte Sequenz aus 7 Jobs und ist ~50 % token-effizienter, weil jeder Kapiteltext nur zweimal statt fünfmal an die API gesendet wird.

**Pipeline (intern, ein einziger Job):**

```
Phase 1 – Figuren + Schauplätze kombiniert (parallel pro Kapitel)
          buildExtraktionFigurenOrteChapterPrompt()  ← Compositor über FIGUREN_BASIS_SCHEMA + ORTE_SCHEMA
          → Checkpoint 'p1_done' nach Abschluss

Phase 2 – Figuren konsolidieren
          buildFiguresBasisConsolidationPrompt()     ← bestehend, unverändert
          → saveFigurenToDb()

Phase 3 – Schauplätze konsolidieren
          buildLocationsConsolidationPrompt()        ← bestehend, unverändert
          → saveOrteToDb()

Phase 4 – Soziogramm
          buildFigurSoziogrammEnrichmentPrompt()     ← bestehend, unverändert

Phase 5 – Szenen + Ereignisse kombiniert (parallel pro Kapitel, konsolidierte Figuren als Kontext)
          buildExtraktionSzenenEreignisseChapterPrompt()  ← Compositor, dynamisch
          → figure_scenes speichern + updateFigurenEvents()

Phase 6 – Zeitstrahl konsolidieren
          buildZeitstrahlConsolidationPrompt()       ← bestehend, unverändert

Phase 7 – Entwicklungsbögen
          buildEntwicklungsbogenChapterPrompt() + buildEntwicklungsbogenConsolidationPrompt()
          ← bestehend, unverändert
```

**Prompt-Komposition ohne Duplikation:** `buildExtraktionFigurenOrteChapterPrompt()` und `buildExtraktionSzenenEreignisseChapterPrompt()` leben in `public/js/prompts.js` und referenzieren die bestehenden Schema-Konstanten (`FIGUREN_BASIS_SCHEMA`, `ORTE_SCHEMA` etc.) via `_schemaBody()`. Einzelne Jobs (figuren, locations, szenen, etc.) bleiben unverändert und teilen dieselben Schema-Konstanten.

**Checkpoint:** Der Job setzt nach Phase 1 einen Checkpoint (`phase: 'p1_done'` mit `chapterFiguren` + `chapterOrte`). Bei einem Neustart nach Fehler wird Phase 1 übersprungen und direkt mit der Konsolidierung fortgefahren.

**UI:** `alleAktualisieren()` in `app.js` startet nur noch `/jobs/komplett-analyse` und pollt den Fortschritt. Nach Abschluss werden `loadFiguren`, `loadOrte`, `loadSzenen` und `loadCharacterArcs` parallel neu geladen.
