# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Läuft als eigenständiger Node.js-Service auf demselben LXC wie BookStack und proxied die BookStack-API intern.

## Architektur

```
Browser → Express (Port 3737) → /config      → .env-Credentials an Frontend
                              → /api/*       → BookStack (localhost:80)
                              → /            → public/index.html
```

Der Express-Server übernimmt drei Aufgaben: er served die Single-Page-App unter `/`, proxied alle `/api/*`-Requests an die lokale BookStack-Instanz, und stellt unter `/config` die BookStack-Credentials aus `.env` dem Frontend bereit. Da alles auf demselben Host läuft, gibt es kein CORS-Problem.

**Achtung:** Die HTML-App ruft `https://api.anthropic.com/v1/messages` direkt aus dem Browser auf, sendet aber **keinen `x-api-key`-Header** – der Claude-Aufruf funktioniert nur wenn der Browser oder ein Proxy den Key ergänzt.

## Projektstruktur

```
bookstack-lektorat/
├── server.js            # Express-Server + http-proxy-middleware + /config-Endpoint
├── package.json
├── .env                 # Credentials (nicht eingecheckt)
├── lektorat.service     # systemd unit
├── install.sh           # Erstinstallation auf dem LXC
├── deploy.sh            # CD-Update (wird von GitHub Actions aufgerufen)
├── .github/
│   └── workflows/
│       └── deploy.yml   # GitHub Actions Workflow (push → deploy)
└── public/
    ├── index.html       # Single-Page-App (Alpine.js, kein Build-Step)
    ├── app.js           # Alpine-Komponente (Reaktivität, API-Calls, Claude-Integration)
    └── style.css        # Zentrales Stylesheet
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

Alle Variablen können in einer `.env`-Datei gesetzt werden (dotenv).

### Credential-Flow

Beim Start lädt die App via `GET /config` die Credentials aus der Server-`.env`. Falls dort nichts steht, können sie manuell im Browser eingegeben und im `localStorage` gespeichert werden. Die Reihenfolge: `.env` → `localStorage` → manuelle Eingabe.

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

## BookStack API

Die App nutzt folgende BookStack-Endpunkte (Token-Auth via `Authorization: Token id:secret`):

| Methode | Pfad | Zweck |
|---------|------|-------|
| GET | `/api/books` | Alle Bücher laden |
| GET | `/api/chapters?book_id=X` | Kapitel eines Buchs |
| GET | `/api/pages?book_id=X` | Seiten eines Buchs |
| GET | `/api/pages/:id` | Seiteninhalt (HTML) |
| PUT | `/api/pages/:id` | Korrigierte Seite zurückschreiben |
| GET | `/api/search?query=X&count=N` | Volltextsuche |

Token-Credentials werden im `localStorage` des Browsers gespeichert oder via `/config` vom Server geliefert.

## Claude-Integration

Modell überall: `claude-sonnet-4-6`.

### Seitenlektorat (`runCheck`)

Ruft Claude direkt aus dem Browser auf (`max_tokens: 8000`). Der Prompt instruiert Claude, **Helvetismen nicht als Fehler zu werten** (grösseres, Strasse, gemäss usw.). Claude gibt strukturiertes JSON zurück:

```json
{
  "fehler": [{ "typ": "rechtschreibung|grammatik|stil", "original": "", "korrektur": "", "kontext": "", "erklaerung": "" }],
  "korrekturen_html": "<vollständiges korrigiertes HTML>",
  "stilanalyse": "...",
  "fazit": "..."
}
```

Der korrigierte HTML-String wird bei Bedarf per PUT direkt in BookStack gespeichert. Der «Korrekturen speichern»-Button erscheint nur wenn Rechtschreib- oder Grammatikfehler gefunden wurden.

### Buchbewertung (`runBookReview`)

Lädt alle Seiten eines Buchs (max. 3000 Zeichen Text pro Seite), fasst sie zusammen und lässt Claude das ganze Buch kritisch bewerten (`max_tokens: 8000`). Ergebnis:

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

- **[public/index.html](public/index.html)** – HTML-Struktur mit Alpine.js-Direktiven (`x-data`, `x-model`, `@click` usw.). Alpine.js wird via CDN geladen (`cdn.jsdelivr.net/npm/alpinejs@3`).
- **[public/app.js](public/app.js)** – Alpine-Komponente `lektorat`: reaktiver State, API-Calls gegen den lokalen Proxy, Claude-Integration.
- **[public/style.css](public/style.css)** – Zentrales Stylesheet (alle Styles ausgelagert, kein Inline-CSS im HTML).

## Bekannte Einschränkungen

- Kein Authentifizierungsschutz auf Port 3737 – nur im lokalen Netz verwenden
- Frontend sendet keinen `x-api-key` an Claude – Claude-Aufrufe aus dem Browser scheitern ohne externen Key-Proxy
- Sehr lange Seiten können das Claude-Token-Limit erreichen (`max_tokens: 8000`)
- Kein Diff-View zwischen Original und korrigierter Version
- Buchbewertung kürzt Seitentexte auf 3000 Zeichen – sehr lange Seiten werden unvollständig analysiert
