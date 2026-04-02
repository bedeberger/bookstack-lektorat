# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Läuft als eigenständiger Node.js-Service auf demselben LXC wie BookStack und proxied die BookStack-API intern.

## Architektur

```
Browser → Express (Port 3737) → /config         → .env-Credentials an Frontend
                              → /history/*      → JSON-History-Store (lektorat-history.json)
                              → /claude         → api.anthropic.com (ANTHROPIC_API_KEY-Injection)
                              → /api/*          → BookStack (localhost:80)
                              → /               → public/index.html
```

Der Express-Server übernimmt fünf Aufgaben: er served die Single-Page-App unter `/`, proxied alle `/api/*`-Requests an die lokale BookStack-Instanz, stellt unter `/config` die BookStack-Credentials aus `.env` dem Frontend bereit, proxied unter `/claude` alle Claude-Aufrufe mit serverseitiger Key-Injection, und persistiert unter `/history/*` alle Lektorat-Läufe in einer lokalen JSON-Datei. Da alles auf demselben Host läuft, gibt es kein CORS-Problem.

Der Claude-Aufruf läuft **nicht direkt aus dem Browser** gegen `api.anthropic.com`, sondern über `/claude` – der Server injiziert dabei den `ANTHROPIC_API_KEY` aus der `.env`.

## Projektstruktur

```
bookstack-lektorat/
├── server.js                # Express-Server + Proxies + History-Endpoints
├── package.json
├── .env                     # Credentials (nicht eingecheckt)
├── lektorat-history.json    # Persistierter History-Store (nicht eingecheckt, wird auto-erstellt)
├── lektorat.service         # systemd unit
├── install.sh               # Erstinstallation auf dem LXC
├── deploy.sh                # CD-Update (wird von GitHub Actions aufgerufen)
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Actions Workflow (push → deploy)
└── public/
    ├── index.html           # Single-Page-App (Alpine.js, kein Build-Step)
    ├── app.js               # Alpine-Komponente (Reaktivität, API-Calls, Claude-Integration)
    └── style.css            # Zentrales Stylesheet
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

### History-Store

`lektorat-history.json` wird beim ersten Lauf automatisch im Projektverzeichnis erstellt. Kein Setup nötig. Die Datei gehört nicht ins Git (analog zur `.env`). Beim Deploy bleibt sie unangetastet, weil `deploy.sh` sie nicht synchronisiert.

Die JSON-Datei hat zwei Arrays: `page_checks` und `book_reviews`. IDs werden beim Serverstart aus dem bestehenden Maximum initialisiert (`nextId`) und monoton hochgezählt – kein DBMS, kein Schema, kein ORM. Bei sehr vielen Einträgen (tausende) wird synchrones Lesen/Schreiben langsamer; für den Einzelnutzer-Betrieb kein Problem.

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

Nach dem Install erreichbar unter `http://<lxc-ip>:3737`.

### Automatisches Deployment via GitHub Actions

Bei jedem Push auf `main` läuft der Workflow `.github/workflows/deploy.yml` – er führt `deploy.sh` auf dem LXC aus: synchronisiert die Dateien nach `/opt/lektorat` (`.env` bleibt unangetastet), aktualisiert npm-Abhängigkeiten und startet den Service neu.

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

## Frontend-Architektur

Die Single-Page-App besteht aus drei Dateien:

- **[public/index.html](public/index.html)** – HTML-Struktur mit Alpine.js-Direktiven (`x-data`, `x-model`, `@click`, `x-show`, `x-cloak`, `x-for`, `x-if`, `x-html`, `x-text`). Alpine.js wird via CDN geladen (`cdn.jsdelivr.net/npm/alpinejs@3`). Der `<body>` trägt `x-data="lektorat"` – die gesamte App ist eine einzige Alpine-Komponente.
- **[public/app.js](public/app.js)** – Alpine-Komponente `lektorat`, registriert via `Alpine.data('lektorat', () => ({...}))` im `alpine:init`-Event. Enthält den gesamten reaktiven State, alle API-Calls, die Claude-Integration und die History-Verwaltung.
- **[public/style.css](public/style.css)** – Zentrales Stylesheet (alle Styles ausgelagert, kein Inline-CSS im HTML ausser einzelnen Layout-Overrides).

### Alpine-Komponente: State-Überblick

| Property | Zweck |
|----------|-------|
| `books`, `selectedBookId` | Bücherliste und Auswahl |
| `pages`, `tree` | Flache Seitenliste + hierarchische Kapitel/Seiten-Struktur für den Tree-View |
| `currentPage`, `correctedHtml`, `hasErrors` | Aktive Seite und Lektorat-Ergebnis |
| `showBookCard`, `showEditorCard`, `showBookReviewCard` | Sichtbarkeits-Flags der drei Karten |
| `status`, `statusSpinner` | Statuszeile (mit optionalem Spinner) |
| `analysisOut`, `bookReviewOut` | HTML-Output der Analyse/Bewertung (via `x-html`) |
| `checkLoading`, `bookReviewLoading`, `bookReviewProgress` | Lade-States und Progress-Bar (0–100) |
| `lastCheckId`, `pageHistory`, `selectedHistoryId` | History-State: ID des letzten Checks, geladene Einträge, aufgeklappter Eintrag |

### Tree-View

Die Seitenliste wird als Kapitel/Seiten-Baum dargestellt. `loadPages()` baut zwei Strukturen parallel auf: `pages` (flach, sortiert) und `tree` (hierarchisch: Kapitel mit `open`-Flag und `pages`-Array, plus kapitellose Seiten). Kapitel sind auf- und zuklappbar (`item.open`). Buttons «Alle ausklappen/einklappen» toggeln alle Kapitel auf einmal. Ein Klick auf `resetView()` (via H1-Klick) klappt alle Kapitel ein.

### Seitenvorschau

Beim Auswählen einer Seite (`selectPage`) wird sofort eine Textvorschau geladen (max. 600 Zeichen) und angezeigt, bevor der Nutzer «Prüfen» startet.

## Bekannte Einschränkungen

- Kein Authentifizierungsschutz auf Port 3737 – nur im lokalen Netz verwenden
- Sehr lange Seiten können das Claude-Token-Limit erreichen (konfigurierbar via `MODEL_TOKEN`, Default 64000)
- Kein Diff-View zwischen Original und korrigierter Version
- Buchbewertung kürzt Seitentexte auf 3000 Zeichen – sehr lange Seiten werden unvollständig analysiert
- History-Store ist eine JSON-Datei (kein echtes DBMS) – synchrones Lesen/Schreiben, für Einzelnutzer ausreichend
- History der Buchbewertungen wird im UI noch nicht angezeigt (nur serverseitig gespeichert)
