# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Läuft als eigenständiger Node.js-Service auf demselben LXC wie BookStack und proxied die BookStack-API intern.

## Architektur

```
Browser → Express (Port 3737) → /config         → .env-Credentials an Frontend
                              → /history/*      → SQLite-DB (lektorat.db)
                              → /figures/*      → SQLite-DB (lektorat.db)
                              → /claude         → api.anthropic.com (ANTHROPIC_API_KEY-Injection)
                              → /api/*          → BookStack (localhost:80)
                              → /               → public/index.html
```

Der Express-Server übernimmt fünf Aufgaben: er served die Single-Page-App unter `/`, proxied alle `/api/*`-Requests an die lokale BookStack-Instanz, stellt unter `/config` die BookStack-Credentials aus `.env` dem Frontend bereit, proxied unter `/claude` alle Claude-Aufrufe mit serverseitiger Key-Injection, und persistiert unter `/history/*` sowie `/figures/*` alle Daten in einer lokalen SQLite-Datei. Da alles auf demselben Host läuft, gibt es kein CORS-Problem.

Der Claude-Aufruf läuft **nicht direkt aus dem Browser** gegen `api.anthropic.com`, sondern über `/claude` – der Server injiziert dabei den `ANTHROPIC_API_KEY` aus der `.env`.

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
│   └── proxies.js           # /config, /claude (SSE-Proxy), /api/* (BookStack-Proxy)
├── package.json
├── .env                     # Credentials (nicht eingecheckt)
├── lektorat.db              # SQLite-Datenbank (nicht eingecheckt, wird auto-erstellt)
├── lektorat.service         # systemd unit
├── install.sh               # Erstinstallation auf dem LXC
├── deploy.sh                # CD-Update (wird von GitHub Actions aufgerufen)
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions Workflow (push → deploy)
└── public/
    ├── index.html           # Single-Page-App (Alpine.js, kein Build-Step)
    ├── style.css            # Zentrales Stylesheet
    └── js/                  # ES-Module (kein Build-Step, type="module")
        ├── app.js           # Alpine-Komponente: State, Computed, init/selectPage/resetView
        ├── utils.js         # escHtml(), htmlToText()
        ├── prompts.js       # SYSTEM_*-Strings, CLAUDE_API, buildLektoratPrompt()
        ├── api-bookstack.js # bsGet, bsGetAll, bsPut, _applyCorrections
        ├── api-claude.js    # callClaude (SSE-Streaming)
        ├── history.js       # loadPageHistory, loadBookReviewHistory
        ├── tree.js          # loadBooks, loadPages, loadTokenEstimates
        ├── lektorat.js      # runCheck, saveCorrections, toggleDiff, batchCheck, computeDiff
        ├── review.js        # runBookReview
        ├── figuren.js       # runFigurExtraction, loadFiguren, saveFiguren, toggleFiguresCard
        └── graph.js         # renderFigurGraph, _figTypColor
```

## Lokale Entwicklung

```bash
npm install
node server.js
# App läuft auf http://localhost:3737
```

Umgebungsvariablen (optional, defaults in Klammern):
- `PORT` – Port des Express-Servers (`3737`)
- `BOOKSTACK_URL` – Ziel für den API-Proxy (`http://localhost:80`)
- `API_HOST` – Alternative zu `BOOKSTACK_URL` (hat Vorrang)
- `TOKEN_ID` – BookStack Token ID (wird via `/config` an den Browser geliefert)
- `TOKEN_KENNWORT` – BookStack Token Passwort (wird via `/config` an den Browser geliefert)
- `ANTHROPIC_API_KEY` – API-Key für Claude (wird serverseitig in `/claude`-Requests injiziert)
- `MODEL_NAME` – Claude-Modell (`claude-sonnet-4-6`)
- `MODEL_TOKEN` – Maximale Output-Tokens für Claude-Aufrufe (`64000`)

Alle Variablen können in einer `.env`-Datei gesetzt werden (dotenv).

### Credential-Flow

Beim Start lädt die App via `GET /config` die Credentials aus der Server-`.env`. Sind `TOKEN_ID` und `TOKEN_KENNWORT` gesetzt, baut die App den Auth-Header automatisch auf und lädt die Bücher. Falls die Credentials fehlen, zeigt die App eine Fehlermeldung.

### Datenbank

`lektorat.db` wird beim ersten Start automatisch im Projektverzeichnis erstellt. Kein Setup nötig. Die Datei gehört nicht ins Git (analog zur `.env`). Beim Deploy bleibt sie unangetastet, weil `deploy.sh` sie von rsync ausschliesst.

**Einmalige Migration von JSON:** Existiert beim Start noch eine `lektorat-history.json`, wird sie automatisch in die SQLite-DB migriert und in `lektorat-history.json.migrated` umbenannt.

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

**Designprinzip Figuren:** Die vier Figuren-Tabellen sind bewusst flach gehalten. Neue Beziehungstypen entstehen einfach durch einen neuen `typ`-String – keine Schemaänderung nötig. Neue Figur-Eigenschaften, die noch nicht bekannt sind, kommen entweder als neue Spalte (via Migration, s.u.) oder als Einträge im `meta`-JSON-Feld.

## Datenbankmigrationen

### Wie Migrationen funktionieren

`server.js` enthält die Funktion `runMigrations()` direkt nach dem Schema-Setup. Sie liest `schema_version` und führt alle noch ausstehenden `ALTER TABLE`-Statements sequenziell aus. Neue Migrationen werden dort als kommentiertes Block-Template vorbereitet.

Das Muster für eine neue Migration in `server.js`:

```js
// In runMigrations():
if (version < 2) {
  db.exec('ALTER TABLE figures ADD COLUMN wohnort TEXT');
  db.prepare('UPDATE schema_version SET version = 2').run();
  logger.info('DB-Migration auf Version 2 abgeschlossen.');
}
// CURRENT_SCHEMA_VERSION oben auf 2 erhöhen
```

Beim nächsten Serverstart läuft die Migration einmalig durch – lokal wie auf dem LXC. Kein separater Deploy-Schritt nötig.

### Neue Spalte zu einer bestehenden Tabelle hinzufügen

1. `CURRENT_SCHEMA_VERSION` in `server.js` um 1 erhöhen (z.B. von `1` auf `2`).
2. In `runMigrations()` den Block ergänzen:
   ```js
   if (version < 2) {
     db.exec('ALTER TABLE figures ADD COLUMN wohnort TEXT');
     db.prepare('UPDATE schema_version SET version = 2').run();
   }
   ```
3. Im GET `/figures/:book_id` die neue Spalte ins zurückgegebene Objekt aufnehmen.
4. Im PUT `/figures/:book_id` → `_saveFigurenToDb()` die neue Spalte im INSERT berücksichtigen.
5. Pushen → beim nächsten Start auf dem LXC läuft die Migration automatisch.

### Neue Tabelle anlegen

Einfach ein weiteres `CREATE TABLE IF NOT EXISTS` im `db.exec()`-Block am Anfang von `server.js` ergänzen. Keine Versionierung nötig, da `IF NOT EXISTS` idempotent ist.

### Neue Beziehungstypen für Figuren

Keine Schemaänderung nötig. `figure_relations.typ` ist Freitext. Im Frontend (`app.js`) in der `BZ`-Konstante (Rendering) und im Claude-Prompt (`FINAL_SCHEMA`) den neuen Typ ergänzen.

### Notfall: DB-Schema auf dem LXC prüfen

```bash
sqlite3 /opt/lektorat/lektorat.db
.tables
.schema figures
SELECT * FROM schema_version;
```

## Deployment auf dem LXC

### Erstinstallation

```bash
scp lektorat.tar.gz root@<lxc-ip>:/tmp/
ssh root@<lxc-ip>
cd /tmp && tar -xzf lektorat.tar.gz && cd lektorat
bash install.sh
```

Der Installer:
1. Prüft Node.js (installiert v20 via NodeSource falls fehlend)
2. Kopiert alles nach `/opt/lektorat`
3. Führt `npm install --omit=dev` aus
4. Installiert und startet den systemd-Service `lektorat`

`better-sqlite3` enthält Prebuilt-Binaries für Linux x64 / Node 20 – `npm install` kompiliert in der Regel nichts. Falls doch (anderer Node/Arch), braucht der LXC: `apt-get install -y python3 make g++`.

Nach dem Install erreichbar unter `http://<lxc-ip>:3737`.

### Automatisches Deployment via GitHub Actions

Bei jedem Push auf `main` läuft der Workflow `.github/workflows/deploy.yml` – er führt `deploy.sh` auf dem LXC aus: synchronisiert die Dateien nach `/opt/lektorat` (`.env` und `lektorat.db` bleiben unangetastet), aktualisiert npm-Abhängigkeiten und startet den Service neu. Schema-Migrationen laufen automatisch beim Neustart.

Voraussetzung: **Self-hosted GitHub Actions Runner** auf dem LXC (verbindet sich outbound zu GitHub, kein Port-Forward nötig).

**Einmalige Runner-Einrichtung auf dem LXC:**

```bash
apt-get install -y rsync

# Runner herunterladen – genaue URL + Token: GitHub → Repo → Settings → Actions → Runners → New self-hosted runner
mkdir -p /opt/actions-runner && cd /opt/actions-runner
curl -sL <runner-download-url> | tar xz
./config.sh --url https://github.com/<user>/<repo> --token <TOKEN>

# Als systemd-Service (root, damit systemctl restart funktioniert)
./svc.sh install root
./svc.sh start
```

### Nützliche Befehle auf dem LXC

```bash
systemctl status lektorat
journalctl -u lektorat -f
systemctl restart lektorat
sqlite3 /opt/lektorat/lektorat.db "SELECT COUNT(*) FROM page_checks;"
```

## History-API

Der Server stellt folgende Endpunkte bereit (kein Auth nötig, da lokales Netz):

| Methode | Pfad | Zweck |
|---------|------|-------|
| POST | `/history/check` | Lektorat-Ergebnis speichern |
| PATCH | `/history/check/:id/saved` | Lauf als «in BookStack gespeichert» markieren |
| GET | `/history/page/:page_id` | Letzte 20 Läufe für eine Seite |
| POST | `/history/review` | Buchbewertung speichern |
| GET | `/history/review/:book_id` | Letzte 10 Bewertungen für ein Buch |
| GET | `/figures/:book_id` | Gespeicherte Figuren eines Buchs laden |
| PUT | `/figures/:book_id` | Figuren eines Buchs speichern (überschreibt) |

Jeder `page_checks`-Eintrag enthält: `id`, `page_id`, `page_name`, `book_id`, `checked_at`, `error_count`, `errors_json` (komplettes Fehler-Array), `stilanalyse`, `fazit`, `model`, `saved`, `saved_at`.

Jeder `book_reviews`-Eintrag enthält: `id`, `book_id`, `book_name`, `reviewed_at`, `review_json` (komplettes Review-Objekt), `model`.

Das Frontend ruft die History automatisch auf: nach `runCheck`, nach `saveCorrections` und beim Wechsel auf eine Seite (`selectPage`). Im Seiteneditor wird der Verlauf als kompakte, ausklappbare Liste angezeigt – jeder Eintrag zeigt Datum, Fehleranzahl, Gespeichert-Status und Modell. Beim Aufklappen erscheinen alle Fehlerdetails, Stilanalyse und Fazit des jeweiligen Laufs.

## BookStack API

Die App nutzt folgende BookStack-Endpunkte (Token-Auth via `Authorization: Token id:secret`):

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/books` | Alle Bücher laden |
| GET | `/api/chapters?book_id=X` | Kapitel eines Buchs |
| GET | `/api/pages?book_id=X` | Seiten eines Buchs |
| GET | `/api/pages/:id` | Seiteninhalt (HTML) |
| PUT | `/api/pages/:id` | Korrigierte Seite zurückschreiben |

Token-Credentials werden via `/config` vom Server geliefert und im `Authorization`-Header jedes Requests mitgeschickt.

## Claude-Integration

Modell überall: `claude-sonnet-4-6`. Alle Claude-Calls laufen über den lokalen `/claude`-Proxy (kein direkter Browser-Zugriff auf `api.anthropic.com`).

### Seitenlektorat (`runCheck`)

Lädt den Seiteninhalt via BookStack-API, extrahiert den Plaintext und schickt beides (Text + Original-HTML) an Claude. Der Prompt instruiert Claude, **Helvetismen nicht als Fehler zu werten** (grösseres, Strasse, gemäss usw.). Claude gibt strukturiertes JSON zurück:

```json
{
  "fehler": [{ "typ": "rechtschreibung|grammatik|stil", "original": "", "korrektur": "", "kontext": "", "erklaerung": "" }],
  "korrekturen_html": "<vollständiges korrigiertes HTML>",
  "stilanalyse": "...",
  "fazit": "..."
}
```

Der korrigierte HTML-String wird bei Bedarf per PUT direkt in BookStack gespeichert. Der «Korrekturen speichern»-Button erscheint nur wenn Rechtschreib- oder Grammatikfehler gefunden wurden (Stilanmerkungen allein lösen ihn nicht aus).

### Buchbewertung (`runBookReview`)

Lädt alle Seiten eines Buchs sequenziell (max. 3000 Zeichen Text pro Seite, Seiten unter 50 Zeichen werden übersprungen), zeigt eine Progress-Bar (0–85% beim Laden, 85–100% beim Claude-Call), und lässt Claude das ganze Buch kritisch bewerten. Ergebnis:

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

Wird als Sterne-Rating mit Stärken/Schwächen/Empfehlungen-Listen dargestellt.

### Figurenübersicht (`runFigurExtraction`)

**Read-only** – die Figuren werden einmalig von Claude ermittelt und gecacht; kein manuelles Bearbeiten. «Neu ermitteln» überschreibt den Cache.

Lädt alle Seiten batched (voller Text, keine Kürzung). Wie bei der Buchbewertung zwei Pfade:

- **Single-Pass** (Gesamttext ≤ 60 000 Zeichen): alle Seiten direkt an Claude.
- **Multi-Pass** (grössere Bücher): pro Kapitel eine Figuren-Analyse (vereinfachtes Schema, Beziehungen per Namen), dann ein Konsolidierungs-Call der dedupliziert, IDs vergibt und kapitelübergreifende Beziehungen zusammenführt.

Ergebnis wird unter `/figures/:book_id` persistiert (SQLite) und beim nächsten Öffnen direkt geladen (kein erneuter Scan).

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

`kapitel` ist absteigend nach Häufigkeit sortiert – das erste Kapitel ist das Hauptkapitel der Figur (hervorgehobener Badge). Beziehungstypen decken Familie (`elternteil`, `kind`, `geschwister`) und soziale/berufliche Verbindungen ab; jede Beziehung wird nur einmal eingetragen.

Die Figuren werden als interaktiver **vis-network**-Graph dargestellt (CDN: `unpkg.com/vis-network`). Kantentypen sind visuell unterscheidbar: Eltern-Kind-Pfeile (grau, gerichtet), Geschwister (blau gestrichelt), alle weiteren Beziehungstypen farbig gestrichelt. Hierarchisches Layout wird nur aktiviert wenn Eltern-Kind-Kanten vorhanden sind, sonst freies Force-Layout.

## Frontend-Architektur

Die Single-Page-App besteht aus `index.html`, `style.css` und ES-Modulen unter `public/js/` – **kein Build-Step**, kein Bundler. Alpine.js und vis-network werden via CDN geladen.

- **[public/index.html](public/index.html)** – HTML-Struktur mit Alpine.js-Direktiven (`x-data`, `x-model`, `@click`, `x-show`, `x-cloak`, `x-for`, `x-if`, `x-html`, `x-text`). Alpine.js via CDN (`cdn.jsdelivr.net/npm/alpinejs@3`). Der `<body>` trägt `x-data="lektorat"`. Script-Reihenfolge im `<head>`: erst `<script type="module" src="js/app.js">`, dann vis-network, dann Alpine mit `defer` – so ist der `alpine:init`-Listener garantiert vor Alpine registriert.
- **[public/js/app.js](public/js/app.js)** – Einstiegspunkt der Alpine-Komponente. Importiert alle Modul-Objekte und spreaed sie ins Alpine-Data-Objekt. Enthält nur: State-Definitionen, Computed-Properties (`get`), und die wenigen UI-Methoden die `this.*` direkt brauchen (`init`, `selectPage`, `resetView`, `setStatus`, `formatDate`, `setReviewStatus`, `cutAtSentence`).
- **[public/style.css](public/style.css)** – Zentrales Stylesheet. **Alle Styles gehören ausschliesslich hierher** – weder Inline-`style`-Attribute noch `<style>`-Blöcke im HTML sind erlaubt. Neue visuelle Anforderungen immer als CSS-Klasse in `style.css` umsetzen.

### Modul-Pattern

Alle `public/js/*.js`-Module (ausser `app.js`, `utils.js`, `prompts.js`) exportieren ein Methoden-Objekt (z.B. `export const lektoratMethods = { ... }`). Die Methoden verwenden `this`, das beim Aufruf auf die Alpine-Komponente zeigt – weil sie per `...spread` in das Alpine-Data-Objekt eingebettet sind. Neue Funktionalität: neues Modul anlegen, Methoden-Objekt exportieren, in `js/app.js` importieren und am Ende des Data-Objekts spreaden.

### Alpine-Komponente: State-Überblick

| Property | Zweck |
|----------|-------|
| `books`, `selectedBookId` | Bücherliste und Auswahl |
| `pages`, `tree` | Flache Seitenliste + hierarchische Kapitel/Seiten-Struktur für den Tree-View |
| `currentPage`, `correctedHtml`, `hasErrors` | Aktive Seite und Lektorat-Ergebnis |
| `showBookCard`, `showEditorCard`, `showBookReviewCard`, `showFiguresCard` | Sichtbarkeits-Flags der Karten |
| `status`, `statusSpinner` | Statuszeile (mit optionalem Spinner) |
| `analysisOut`, `bookReviewOut` | HTML-Output der Analyse/Bewertung (via `x-html`) |
| `checkLoading`, `bookReviewLoading`, `bookReviewProgress` | Lade-States und Progress-Bar (0–100) |
| `lastCheckId`, `pageHistory`, `selectedHistoryId` | History-State: ID des letzten Checks, geladene Einträge, aufgeklappter Eintrag |
| `figuren`, `figurenLoading`, `figurenProgress`, `figurenStatus` | Figurenübersicht: geladene Figuren, Lade-State, Fortschritt, Statuszeile |
| `selectedFigurId` | Aufgeklappte Figur in der Detailliste |

### Tree-View

Die Seitenliste wird als Kapitel/Seiten-Baum dargestellt. `loadPages()` baut zwei Strukturen parallel auf: `pages` (flach, sortiert) und `tree` (hierarchisch: Kapitel mit `open`-Flag und `pages`-Array, plus kapitellose Seiten). Kapitel sind auf- und zuklappbar (`item.open`). Buttons «Alle ausklappen/einklappen» toggeln alle Kapitel auf einmal. Ein Klick auf `resetView()` (via H1-Klick) klappt alle Kapitel ein.

### Seitenvorschau

Beim Auswählen einer Seite (`selectPage`) wird sofort eine Textvorschau geladen (max. 600 Zeichen) und angezeigt, bevor der Nutzer «Prüfen» startet.

## Bekannte Einschränkungen

- Kein Authentifizierungsschutz auf Port 3737 – nur im lokalen Netz verwenden
- Sehr lange Seiten können das Claude-Token-Limit erreichen (konfigurierbar via `MODEL_TOKEN`, Default 64000)
- Buchbewertung kürzt Seitentexte auf 3000 Zeichen – sehr lange Seiten werden unvollständig analysiert
- History der Buchbewertungen wird im UI noch nicht angezeigt (nur serverseitig gespeichert)
- Figurenübersicht ist read-only – keine manuelle Korrektur einzelner Figuren möglich, nur Neu-Ermittlung des gesamten Buchs
- vis-network wird via CDN geladen; ohne Internetverbindung kein Graph (Figurenliste bleibt verfügbar)
