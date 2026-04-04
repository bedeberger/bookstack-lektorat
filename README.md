# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Läuft als eigenständiger Node.js-Service und bietet:

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung einzelner Seiten mit selektiver Fehlerkorrektur
- **Buchbewertung** – Gesamtbewertung mit Stärken, Schwächen und Empfehlungen
- **Figurenübersicht** – Automatische Charakterextraktion mit interaktivem Beziehungsgraph
- **Zwei KI-Provider** – Anthropic Claude (Cloud) oder Ollama (lokal/offline)

---

## Deployment

### Option A: Docker Compose (empfohlen)

**1. Repository klonen**

```bash
git clone https://github.com/<user>/bookstack-lektorat.git
cd bookstack-lektorat
```

**2. `.env` aus Vorlage erstellen und befüllen**

```bash
cp .env.example .env
```

Dann `.env` öffnen und mindestens diese Werte setzen:

| Variable | Beschreibung | Pflicht |
|----------|-------------|---------|
| `BOOKSTACK_URL` | URL der BookStack-Instanz, z.B. `http://192.168.1.10:80` | Ja |
| `TOKEN_ID` | BookStack API Token ID | Ja |
| `TOKEN_KENNWORT` | BookStack API Token Secret | Ja |
| `ANTHROPIC_API_KEY` | Anthropic API Key (nur bei `API_PROVIDER=claude`) | Ja* |
| `API_PROVIDER` | `claude` (Standard) oder `ollama` | Nein |
| `MODEL_NAME` | Claude-Modell, z.B. `claude-sonnet-4-6` | Nein |
| `MODEL_TOKEN` | Max. Output-Tokens (Standard: `64000`) | Nein |
| `OLLAMA_HOST` | URL der Ollama-Instanz (nur bei `API_PROVIDER=ollama`) | Ja* |
| `OLLAMA_MODEL` | Ollama-Modell, z.B. `llama3.2` (nur bei `API_PROVIDER=ollama`) | Ja* |

*Je nach gewähltem Provider.

BookStack API-Tokens erstellen: **BookStack → Profil → API-Tokens**.

**3. Container starten**

```bash
docker compose up -d
```

Die App ist jetzt erreichbar unter `http://localhost:3737`.

Die SQLite-Datenbank wird im Docker-Volume `lektorat_data` persistiert und bleibt bei Updates erhalten.

**Logs ansehen:**

```bash
docker compose logs -f
```

**Container stoppen:**

```bash
docker compose down
```

**Update auf neue Version:**

```bash
git pull
docker compose up -d --build
```

---

### Option B: Direkt auf einem LXC / Server

**Voraussetzungen:** Node.js v20+, npm

```bash
git clone https://github.com/<user>/bookstack-lektorat.git
cd bookstack-lektorat
cp .env.example .env
# .env befüllen (s. Tabelle oben)
npm install
node server.js
```

Für den Produktivbetrieb empfiehlt sich ein systemd-Service (siehe `lektorat.service` im Repository).

---

## Konfiguration

Alle Einstellungen werden über `.env` gesteuert. Eine vollständig kommentierte Vorlage liegt unter [`.env.example`](.env.example).

### KI-Provider wählen

**Claude (Standard):**
```env
API_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
# Optional: anderes Modell
MODEL_NAME=claude-opus-4-6
```

**Ollama (lokal, kein API-Key nötig):**
```env
API_PROVIDER=ollama
OLLAMA_HOST=http://host.docker.internal:11434
OLLAMA_MODEL=llama3.2
```

> Bei Docker muss `localhost` durch `host.docker.internal` ersetzt werden, um den Ollama-Service auf dem Host zu erreichen.

---

## Architektur

```
Browser → Express (Port 3737) → /config         → .env-Credentials an Frontend
                              → /claude         → api.anthropic.com (Key-Injection)
                              → /ollama         → Ollama /api/chat
                              → /api/*          → BookStack-Instanz
                              → /history/*      → SQLite (lektorat.db)
                              → /figures/*      → SQLite (lektorat.db)
                              → /               → Single-Page-App (Alpine.js)
```

KI-Calls laufen **nicht direkt aus dem Browser**, sondern über den Server-Proxy – alle Credentials bleiben serverseitig.

---

## Lokale Entwicklung

```bash
npm install
node server.js
# App läuft auf http://localhost:3737
```

---

## Sicherheitshinweis

Port 3737 hat keinen Authentifizierungsschutz. Den Service nur im lokalen Netz oder hinter einem Reverse-Proxy mit Auth betreiben.
