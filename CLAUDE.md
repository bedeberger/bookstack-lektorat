# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Deployment, Docker-Setup und Env-Variablen: siehe [README.md](README.md).

**Lokal starten:** `npm install && npm start` (Port 3737). Tests: `npm test` (Playwright, erstmalig `npx playwright install chromium`).

## Harte Regeln

- **Prompts nur in `public/js/prompts.js`** — einzige Quelle für alle Prompt-Schemas und Build-Logik. Server importiert via dynamic `import()`. NIEMALS Prompts in Route-Handlern, Config-Dateien oder anderswo duplizieren.
- **KI-Calls nur via Job-Queue** — neue Features implementieren einen Job-Typ in `routes/jobs/` (Funktion `runXxxJob` + `router.post`). Direkte synchrone KI-Calls aus Route-Handlern sind verboten. Einzige Ausnahme: Seiten-Chat (`/chat/send`) nutzt bewusst SSE-Streaming.
- **`callAI` gibt nur JSON zurück** — jeder Systemprompt muss JSON-Only erzwingen (`JSON_ONLY`-Konstante in `prompts.js`). Nach jedem `callAI`-Aufruf Pflichtfeld prüfen (z.B. `fehler`, `gesamtnote`, `figuren`). Fehler werfen statt falsche Daten rendern. **`truncated`-Flag IMMER vor `parseJSON` prüfen und werfen** — `jsonrepair` ist tolerant und liefert sonst Partial-Daten zurück (verhindert „silent partial"-Bug).
- **Styles nur in `style.css`** — keine Inline-`style`-Attribute, keine `<style>`-Blöcke im HTML.
- **UI-Strings nur in `public/js/i18n/{de,en}.json`** — keine hartcodierten deutschen/englischen Texte in HTML-Partials, JS-Modulen oder Alpine-Templates. Immer `t('bereich.feld')` (bzw. `tRaw()` ausserhalb von Alpine) verwenden. Neuer String → Key in **beiden** Locale-Dateien ergänzen (de = Fallback, en = Übersetzung). Key-Konvention: `bereich.feld` (z.B. `profile.title`). Platzhalter via `{name}` + Parameter-Map.
  - **Gilt auch serverseitig:** `updateJob`/`failJob`-`statusText` immer als i18n-Key setzen (z.B. `'job.phase.aiReply'`), dynamische Werte als `statusParams`-Objekt. Job-Labels via `{ key, params }` an `createJob`. Fehler-Messages, die der User sieht, ebenfalls als Key.
  - **Automatisch übersetzen, ungefragt:** jeder neue User-sichtbare String wird beim Hinzufügen sofort in beide Locale-Dateien eingetragen — egal ob Frontend-Label, Server-Status, Fehlertext, Placeholder oder Tooltip. Nie nur DE (oder nur EN) committen und auf „mach ich später" verschieben.
  - **Persistierte User-Nachrichten (z.B. Chat-Fallbacks in DB):** als `__i18n:bereich.feld__`-Marker speichern; Frontend löst beim Rendern via `t()` auf. So bleibt die Locale-Wahl des späteren Betrachters massgeblich.
  - **Ausnahme:** Winston-Logs (`logger.info/warn/error`) bleiben vorläufig deutsch — sie gehen nur in `lektorat.log`/Console, nicht an den User.
- **`bsGetAll` statt `bsGet` für Listen** — BookStack paginiert (Standard 20 Einträge). `bsGetAll` iteriert alle Seiten automatisch.
- **401-Handling zentral** — ein globaler `window.fetch`-Wrapper in `public/js/app.js` fängt alle 401-Antworten ab und dispatcht `session-expired`; Alpine zeigt daraufhin den Session-Banner. Feature-Module prüfen 401 nicht selbst und dürfen das Event nicht unterdrücken. Kein Auto-Redirect – User soll ungespeicherte Inhalte retten können.
- **`x-html` nur mit vorab-escaptem Content** — jede Stelle, die ins `x-html` fliesst, muss KI-/User-Felder vor der Interpolation durch `escHtml()` aus `utils.js` geschleust haben. Gilt für Status-Strings (`_runningJobStatus`), Review-Renderer (`_renderReviewHtml`, `_renderKapitelReviewHtml`), Lektorat-Output (`analysisOut`), Chat-Markdown (`renderChatMarkdown` escaped als erstes). Keine neuen `x-html`-Sinks ohne dieses Escape. Keine Runtime-Sanitizer wie DOMPurify – die Escape-Invariante reicht.
- **A11y: klickbare Nicht-Buttons** — Elemente mit Klasse `.internal-link` (spans/divs mit `@click`) werden global in `app.js` via MutationObserver + Event-Delegation tastatur-erreichbar gemacht (`role="button"`, `tabindex="0"`, Enter/Space → click). Nicht pro Element wiederholen. Neue klickbare Nicht-Buttons → einfach `.internal-link` setzen.
- **Progress-Bars** — `.progress-bar` liest die Breite aus CSS-Custom-Prop `--progress`. Binding: `:style="{ '--progress': xProgress + '%' }"`, nicht `:style="'width:' + ... + '%'"`.
- **Card-Animationen nur via CSS** — `.card` fadet via `cardFadeIn` (style.css) ein. Kein `x-transition` zusätzlich auf `.card`-Elementen, sonst doppelt (CSS translateY + Alpine scale konkurrieren, wirkt wabbelig — sichtbar v.a. bei grossen Karten wie Szenen). Neue Karte: nur `x-show="..." x-cloak`, keine Alpine-Transition.
- **`SHELL_CACHE` bumpen** — bei JS/CSS-Änderungen Konstante in [public/sw.js](public/sw.js) hochzählen. Sonst halten Mobile-Browser via Service-Worker alte Bundle-Versionen fest.
- **Combobox statt `<select>`** — alle Auswahlfelder nutzen `Alpine.data('combobox')` aus [public/js/app.js:219](public/js/app.js#L219). Kein natives `<select>` für neue Features, ausser bei zwingendem Grund (z.B. native Mobile-Picker erwünscht — dann begründen). `init()` rendert Trigger + Dropdown + Search + Liste komplett selbst und überschreibt `innerHTML` des Wrapper-Divs. Wrapper-Div daher **leer lassen**, nur Attribute setzen. Pflicht-Pattern (sonst Liste rendert nicht / Selection bricht / Updates kommen nicht durch):
  ```html
  <div x-data="combobox(placeholder, emptyLabel?)"
       x-modelable="value" x-model="selectedRef"
       x-effect="options = computeOptions()"
       @combobox-change="onChange?($event.detail)"
       @click.outside="close()" @keydown="onKeydown($event)"
       class="combobox-wrap"></div>
  ```
  - `options`: Array `[{ value, label }]`. Niemals Markup ins Wrapper-Div schreiben — `init()` killt es.
  - **`x-effect` statt `:options`-Attribut** — sonst keine Reaktivität bei Änderung der Datenquelle (Hauptursache für „Liste leer / nicht aktualisiert"-Bug).
  - `x-modelable="value" x-model="ref"` koppelt internen `value`-State an äusseres Feld. Ohne `x-modelable` greift `@combobox-change` nicht in den Parent-State durch.
  - `emptyLabel` (2. Argument) erzeugt „Alle"-Option mit Wert `''`. Weglassen für Pflichtauswahl.
  - Optional `combobox-wrap--compact` für kleine Variante.
  - Referenz: [public/index.html:90](public/index.html#L90) (Buchwahl), [public/partials/szenen.html:76](public/partials/szenen.html#L76).

## Neues Feature hinzufügen

### Backend (KI-Job)

1. Job-Datei in `routes/jobs/` anlegen (Pattern: siehe `routes/jobs/review.js`)
2. `runXxxJob`-Funktion + `router.post('/xxx', ...)` implementieren
3. Router in `routes/jobs.js` mounten
4. Prompt-Builder in `public/js/prompts.js` ergänzen — **bei schemarelevanter Änderung `PROMPTS_VERSION` bumpen** (invalidiert `chapter_extract_cache`-Einträge der Komplettanalyse)
5. Schema-Validierung nach `callAI` nicht vergessen
6. Dedup-Check im POST-Handler: `findActiveJobId(type, entityId, userEmail)` aus `routes/jobs/shared.js` (NICHT `runningJobs.get(...) && jobs.has(...)` — matcht sonst auch fertige Jobs)

### Frontend (neue Karte als `Alpine.data`-Sub-Komponente)

Der Frontend-Scope ist in **Alpine.data-Sub-Komponenten** aufgeteilt:
- **Root** (`x-data="lektorat"` am `<body>`): Navigation (`selectedBookId`, `pages`, `tree`), Session, i18n, `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität), Job-Queue-Footer, globale Cross-Cutting-Methoden (`t`, `bsGet`, `loadFiguren`, `selectPage`, `gotoStelle` …).
- **25 Sub-Komponenten** in [public/js/cards/](public/js/cards/) — eine pro UI-Karte. Buchebene: Figuren, Orte, Szenen, Ereignisse, Stil, Fehler-Heatmap, BookStats, BookSettings, UserSettings, Kontinuität, Ideen, Finetune-Export, Buch-Chat, Buch-Review, Kapitel-Review. Editor-Subs: editor-find, editor-synonyme, editor-figur-lookup, editor-toolbar, editor-focus, lektorat-findings, page-history. Plus Seiten-Chat. Jede besitzt fachlichen State + Lifecycle.
- **Im Root** verbleibt: `page-view`, `editor-edit`, `editor-utils`, Hash-Router, Auto-Save, Selection-Management, Navigation. Editor-UI-Slices wurden in eigene Cards extrahiert (Trampoline-Events aus dem Root, z.B. `editor:focus:toggle`).

**Neue Karte anlegen:**
1. Fachmodul in `public/js/` → Methods-Export (`export const xxxMethods = { ... }`), Root-Zugriffe via `window.__app.xxx` (siehe unten).
2. Sub-Komponente in `public/js/cards/xxx-card.js` → `Alpine.data('xxxCard', () => ({ ...state, init(), destroy(), ...xxxMethods }))`, registriert als `registerXxxCard()` und in `app.js` aufgerufen.
3. Partial in `public/partials/xxx.html` mit `x-data="xxxCard"` am Wurzel-`<div class="card">`. Root-Zugriffe im Template via `$app.xxx`.
4. Root-Methode `toggleXxxCard()` in `app-view.js` — reiner Flag-Toggle + `_closeOtherMainCards`. Bei Karten, die bei erneutem Klick refreshen sollen (statt schliessen): `window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'xxx' } }))`.
5. `showXxxCard`-Flag in `app-state.js` → `cardsState`.

### Root-Zugriff aus Sub-Komponenten (`$app` / `window.__app`)

Alpine's `$root` zeigt auf das **nächste x-data-Element** (bei Sub-Komponenten also die Sub selbst), nicht auf die `lektorat`-Root. Darum gibt es `$app`:
- **In Templates** (Alpine-Expressions): `$app.t('key')`, `$app.selectedBookId`, `$app.figuren`. Funktioniert über die Custom-Magic `Alpine.magic('app', …)` in [app.js](public/js/app.js).
- **In JS-Methoden/Gettern** (Sub-Komponenten): `window.__app.xxx` — der Root cached sich in `init()` in `window.__app` (garantiert reaktiver Alpine-Proxy). Alpine-Magics sind in JS-Getter-Ausführungen **nicht** zuverlässig verfügbar; `window.__app` ist robust.

### Geteilter Fach-State: `Alpine.store('catalog')`

`figuren`, `orte`, `szenen`, `globalZeitstrahl` leben in [public/js/cards/catalog-store.js](public/js/cards/catalog-store.js). Der Root exponiert sie als Getter/Setter-Proxy — alter Root-Code (`this.figuren = …`) funktioniert unverändert. Sub-Komponenten lesen via `$app.figuren` oder direkt `Alpine.store('catalog').figuren`.

### Events zwischen Root und Subs

Root dispatched, Subs hören:
- **`book:changed`** — aus `_resetBookScopedState()`; Subs resetten State + laden bei offener Karte neu.
- **`view:reset`** — aus `resetView()`; Subs nullen lokalen State komplett.
- **`card:refresh` `{ name }`** — erneuter Klick auf offene Karte; bildet das alte `onOpenWhenOpen`-Verhalten von `createJobFeature` nach.
- **`job:reconnect` `{ type, jobId, job, extra? }`** — aus `checkPendingJobs()`; Review/Kapitel-Review-Subs übernehmen Loading-State + starten Polling.
- **`chat:reset` / `book-chat:reset`** — Root dispatcht beim Seitenwechsel / User-Settings-Danger-Reset; Chat-Subs leeren Session.
- **`kapitel-review:select` `{ chapterId }`** — aus Sidebar/Hash-Router; Sub setzt ihre `kapitelReviewChapterId`.

### Job-Polling (shared utilities)

Pure Funktionen in [public/js/cards/job-helpers.js](public/js/cards/job-helpers.js):
- `startPoll(ctx, config)` — generischer Job-Poller mit explizitem ctx.
- `runningJobStatus(translate, …)` — Status-HTML mit Token-Info.

Für createJobFeature-ähnliche Karten: [public/js/cards/job-feature-card.js](public/js/cards/job-feature-card.js) exportiert `createCardJobFeature(cfg)` — Sub-Variante der Root-Factory mit Flag am `$app` statt lokal.

### Feature-Toggle (Exklusivität)

Immer nur eine Hauptansicht aktiv. Buchebenen-Features und Seitenebenen-Features (Editor) sind gegenseitig exklusiv.
- Root-Toggle-Methode (`app-view.js`) ruft `_closeOtherMainCards(keep)` auf (schliesst alle anderen Karten + Editor)
- `selectPage()` schliesst alle Buchkarten bevor der Editor öffnet
- Sub-Komponenten haben **keine** eigenen `showXxxCard`-Flags — der Root ist SSoT. Subs hören auf `$watch(() => window.__app.showXxxCard)`.
- Seiten-Chat ist eine Ausnahme: läuft neben dem Editor, kein `_closeOtherMainCards` beim Öffnen.

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

DB-Code ist auf 6 Files in [db/](db/) verteilt: [connection.js](db/connection.js) (better-sqlite3-Setup), [migrations.js](db/migrations.js) (Schema + `runMigrations`), [schema.js](db/schema.js), [figures.js](db/figures.js), [pages.js](db/pages.js), [tokens.js](db/tokens.js).

**Migration hinzufügen:** Neuen `if (version < N)`-Block in `runMigrations()` (in [db/migrations.js](db/migrations.js)) ergänzen (N = nächste fortlaufende Nummer, aktuell bei 62) + `UPDATE schema_version SET version = N`. Neue Tabellen als `CREATE TABLE IF NOT EXISTS` — keine Versionierung nötig.

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

**`MODEL_CONTEXT`** setzt das gesamte Kontextfenster (Input + Output, Default 200 000). Daraus leitet `lib/ai.js` das `INPUT_BUDGET_TOKENS` (= `MODEL_CONTEXT − MODEL_TOKEN − 2000`) ab. Alle kontextabhängigen Grenzen skalieren automatisch: `SINGLE_PASS_LIMIT`/`PER_CHUNK_LIMIT` (Komplettanalyse), `BOOK_CHAT_TOKEN_BUDGET`-Default, Buch-Chat-Tool-Result-Caps und das Classic-Buch-Chat-Text-Budget. Bei lokalen Modellen auf die native Kontextgrösse setzen (Mistral-Small3.2 / Gemma3 / Llama-3.1: 128 000, ältere: 32 000 / 8 000).

**JSON-Parsing:** `lib/ai.js` hat mehrstufigen Fallback: `JSON.parse()` → `extractBalancedJson()` → `jsonrepair()`.

## Two-Tier-Analyse

Jobs in `routes/jobs/` verwenden ein Single-Pass/Multi-Pass-Muster. Limits und Batch-Grössen sind als Konstanten in `routes/jobs/shared.js` definiert — `SINGLE_PASS_LIMIT` und `PER_CHUNK_LIMIT` skalieren dynamisch aus `INPUT_BUDGET_CHARS` (70% / 35%).

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

## Finetune-Export

Ziel: Buch im Modell **internalisieren** (Stil, Welt, Figuren, Fakten, Plot). Darum **maximal grosszügig extrahieren** — lieber zu viele Trainingssamples als zu wenige. Alles, was sich aus Text/Figuren/Szenen/Schauplätzen/Ereignissen/Lektorats-Findings als Q&A, Stil-Fortsetzung, Dialog, Szenen-Generierung, Fakten-Recall etc. ableiten lässt, mitnehmen. Keine künstlichen Sample-Caps, keine vorsichtigen Limits per Sampler — Modell soll Buch nach Finetune möglichst vollständig „kennen". Neue Sampler/Datenquellen tendenziell hinzufügen, nicht filtern. Code: [routes/jobs/finetune-export/](routes/jobs/finetune-export/).

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
db/                    – SQLite split: connection, migrations, schema,
                         figures, pages, tokens
routes/
  auth.js                  – Google OIDC
  proxies.js               – KI-Provider-Proxies + BookStack-Proxy
  jobs.js                  – Job-Router (mountet alle Feature-Router)
  jobs/shared.js           – Job-Queue, Limits, loadPageContents, Hilfsfunktionen
  jobs/lektorat.js         – Seiten-Lektorat + Batch-Check
  jobs/review.js           – Buchbewertung
  jobs/kapitel.js          – Kapitelbewertung
  jobs/komplett.js         – Komplettanalyse-Pipeline (inkl. Kontinuitätscheck)
  jobs/chat.js             – Buch-Chat (klassisch + Agentic-Dispatch)
  jobs/book-chat-tools.js  – Tool-Implementierungen für Agentic Buch-Chat
  jobs/synonyme.js         – Synonym-Vorschläge
  jobs/finetune-export/    – Finetune-Sample-Generator (eigener Router)
  jobs/narrative-labels.js – POV-/Tempus-Labels (Helper, kein Router)
  chat.js                  – Seiten-Chat (SSE)
  figures.js, locations.js, history.js, sync.js, booksettings.js,
  usersettings.js, ideen.js
public/
  index.html           – SPA-Shell
  style.css            – Alle Styles (einzige Quelle)
  partials/            – HTML-Partials, geladen per _loadPartials()
  js/app.js            – Alpine-Root (`x-data="lektorat"`), Methoden-Spreads,
                         `$app`-Magic, window.__app-Referenz
  js/app-state.js      – Root-State-Slices (shell, ai, navigation, editor,
                         cards-Flags, Editor-Findings, …)
  js/app-view.js       – Root-Toggle-Methoden (toggleXxxCard), selectPage,
                         resetView/_resetBookScopedState mit Event-Dispatches
  js/app-ui.js         – Filter-/Sort-Helper, Partial-Loader
  js/app-jobs-core.js  – Job-Queue, checkPendingJobs, _startPoll-Wrapper
  js/app-hash-router.js, app-navigation.js, app-chrome.js, app-komplett.js
  js/cards/            – Alpine.data-Sub-Komponenten (25 Karten + Shared)
    catalog-store.js          – Alpine.store('catalog') für figuren/orte/szenen/globalZeitstrahl
    job-helpers.js            – pure `startPoll(ctx, cfg)` + `runningJobStatus(translate, …)`
    job-feature-card.js       – `createCardJobFeature(cfg)` für Sub-Komponenten
    stil-card.js, fehler-heatmap-card.js, book-stats-card.js
    book-settings-card.js, user-settings-card.js
    kontinuitaet-card.js, ereignisse-card.js, orte-card.js, szenen-card.js
    figuren-card.js           – inkl. vis-network-Graph-Lifecycle
    book-review-card.js, kapitel-review-card.js
    chat-card.js, book-chat-card.js
    ideen-card.js, finetune-export-card.js
    editor-find-card.js, editor-synonyme-card.js, editor-figur-lookup-card.js,
    editor-toolbar-card.js, editor-focus-card.js
    lektorat-findings-card.js, page-history-card.js
  js/prompts.js        – Prompt-Schemas + Build-Logik (shared Server/Frontend)
  js/utils.js          – Gemeinsame Hilfsfunktionen
  js/chat-base.js      – Geteilte Chat-Methoden (spreaded in chat-card + book-chat-card)
  js/*.js              – Fachmodule, die in Sub-Komponenten oder Root gespreadet werden
                         (figuren, orte, szenen, kontinuitaet, graph, review,
                          stil-heatmap, fehler-heatmap, bookstats, writing-time,
                          book-settings, user-settings, kapitel-review, ereignisse,
                          chat, book-chat)
                       – Editor-/Findings-Module (bleiben im Root-Spread):
                          page-view, editor-edit, editor-utils,
                          shortcuts, tree, history,
                          api-ai, api-bookstack, bookstack-search, offline-sync,
                          i18n
                       – Module hinter eigenen Cards (gespreaded in *-card.js):
                          editor-focus, editor-toolbar, editor-find,
                          editor-synonyme, editor-figur-lookup, lektorat,
                          ideen, finetune-export
```

## Tests

`npm test` führt Unit- und E2E-Tests nacheinander aus. Einzeln: `npm run test:unit` (Node built-in, Millisekunden, kein Browser) oder `npm run test:e2e` (Playwright, Chromium nötig). Setup: [tests/](tests/), [playwright.config.js](playwright.config.js).

**Unit** (`tests/unit/*.test.js`, `node --test`):
- [tests/unit/ai.test.js](tests/unit/ai.test.js) – `parseJSON`/`extractBalancedJson`: JSON-Fallback-Kette in [lib/ai.js](lib/ai.js).
- [tests/unit/bookstack.test.js](tests/unit/bookstack.test.js) – `authHeader`, `bsGet`, `bsGetAll`-Paginierung aus [lib/bookstack.js](lib/bookstack.js) (fetch gestubbt).
- [tests/unit/page-index.test.js](tests/unit/page-index.test.js) – Stil-/Figuren-Metriken (`computeStyleStats`, `computeFigureMentions`, Tokenizer).

**E2E** (`tests/e2e/*.spec.js`, Playwright):
- [tests/e2e/focus-editor.spec.js](tests/e2e/focus-editor.spec.js) – Fokus-Editor: Toggle, Recenter, Pointer-Schonfrist, Cleanup/Leak-Freiheit.
- [tests/e2e/clean-content.spec.js](tests/e2e/clean-content.spec.js) – `cleanContentArtefacts` aus [public/js/utils.js](public/js/utils.js): Paste-Artefakt-Stripping.
- [tests/e2e/lektorat.spec.js](tests/e2e/lektorat.spec.js) – Lektorat-Flow mit Mock-Server und Harness-Szenarien.

**Bei grösseren UI-Änderungen** (besonders am Editor, Fokus-Modus, Scroll-/Selection-Verhalten, Lektorat-Flow) vor dem Commit automatisch `npm test` ausführen. Schlägt etwas fehl, Ursache klären statt Tests anpassen. Übrige Bereiche weiterhin manuell validieren.
