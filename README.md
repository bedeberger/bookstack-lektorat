# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Läuft als eigenständiger Node.js-Service und bietet:

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung einzelner Seiten mit selektiver Fehlerkorrektur
- **Buchbewertung** – Gesamtbewertung mit Stärken, Schwächen und Empfehlungen
- **Figurenübersicht** – Automatische Charakterextraktion mit interaktivem Beziehungsgraph
- **Buchstatistik** – Tägliche Snapshots von Wortanzahl, Zeichenanzahl und Tokenverbrauch als Zeitliniendiagramm
- **Zwei KI-Provider** – Anthropic Claude (Cloud) oder Ollama (lokal/offline)

---

## Voraussetzungen

> **Die App muss öffentlich aus dem Internet erreichbar sein.**
> Google OAuth2 benötigt eine HTTPS-Callback-URL, die Google nach dem Login ansteuern kann. Ein lokaler `localhost`-Betrieb reicht dafür nicht aus. Typisch: Reverse-Proxy (NGINX, Caddy, Traefik) mit öffentlicher Domain und TLS-Zertifikat.

---

## Google OAuth2 einrichten

Die App verwendet Google als Login-Provider. Alle Benutzer müssen explizit in der `.env` freigegeben werden – es reicht nicht, ein Google-Konto zu besitzen.

**Empfehlung:** Wenn BookStack bereits mit Google OAuth angebunden ist, nutze **dasselbe Google Cloud Projekt** – spart einen separaten OAuth-Consent-Screen.

### Schritt-für-Schritt

**1. Google Cloud Console öffnen:** [console.cloud.google.com](https://console.cloud.google.com)

**2. Projekt auswählen** (bestehendes BookStack-Projekt oder neues erstellen)

**3. OAuth 2.0 Credentials anlegen:**
- *APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth 2.0-Client-ID*
- Anwendungstyp: **Webanwendung**
- Name: z.B. `bookstack-lektorat`
- Autorisierte Weiterleitungs-URI: `https://deine-domain.ch/auth/callback`

**4. Client-ID und Client-Secret kopieren** → in `.env` eintragen (s. unten)

**5. OAuth-Consent-Screen prüfen:**
- Wenn das Projekt bereits für BookStack konfiguriert ist, ist der Consent-Screen vorhanden
- Ansonsten: *APIs & Dienste → OAuth-Zustimmungsbildschirm* → Benutzerdefiniert konfigurieren
- Für interne Tools genügt «Intern» (nur Konten der eigenen Organisation) oder «Extern» mit manuell gepflegter Testnutzerliste

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

Dann `.env` öffnen und alle Pflichtfelder setzen:

| Variable | Beschreibung | Pflicht |
|----------|-------------|---------|
| `BOOKSTACK_URL` | URL der BookStack-Instanz, z.B. `http://192.168.1.10:80` | Ja |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client-ID aus der Google Cloud Console | Ja |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client-Secret | Ja |
| `APP_URL` | Öffentliche HTTPS-URL der App, z.B. `https://lektorat.example.ch` | Ja |
| `SESSION_SECRET` | Zufälliger Schlüssel (min. 32 Zeichen) zur Session-Signierung | Ja |
| `ALLOWED_EMAILS` | Kommaseparierte Liste erlaubter Google-Konten | **Ja** |
| `ANTHROPIC_API_KEY` | Anthropic API Key (nur bei `API_PROVIDER=claude`) | Ja* |
| `API_PROVIDER` | `claude` (Standard) oder `ollama` | Nein |
| `MODEL_NAME` | Claude-Modell, z.B. `claude-sonnet-4-6` | Nein |
| `MODEL_TOKEN` | Max. Output-Tokens (Standard: `64000`) | Nein |
| `OLLAMA_HOST` | URL der Ollama-Instanz (nur bei `API_PROVIDER=ollama`) | Ja* |
| `OLLAMA_MODEL` | Ollama-Modell, z.B. `llama3.2` (nur bei `API_PROVIDER=ollama`) | Ja* |
| `DB_PATH` | Pfad zur SQLite-Datenbank (Standard: `./lektorat.db`; bei Docker via Compose gesetzt) | Nein |

*Je nach gewähltem Provider.

> **ALLOWED_EMAILS ist Pflicht.** Ohne diese Variable hat jedes Google-Konto Zugriff auf die App. Der Server warnt beim Start, falls die Variable fehlt.

`SESSION_SECRET` generieren:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**3. Reverse-Proxy konfigurieren**

Die App läuft intern auf Port 3737. Ein Reverse-Proxy macht sie unter einer öffentlichen HTTPS-Domain erreichbar.

> **Warum sind die Proxy-Einstellungen wichtig?**
> Der KI-Streaming-Endpunkt `/claude` liefert Server-Sent Events (SSE). Ohne die richtigen Einstellungen puffert der Proxy die Chunks – der Fortschrittsbalken hängt, bis die KI komplett fertig ist.

---

#### Nginx Proxy Manager / NPMplus (empfohlen für Heimserver)

NPM und NPMplus bieten eine Web-GUI zur Proxy-Verwaltung mit automatischem Let's-Encrypt-Zertifikat.

**Proxy Host anlegen:**

1. *Hosts → Proxy Hosts → Add Proxy Host*
2. **Domain Names:** `lektorat.example.ch`
3. **Scheme:** `http` · **Forward Hostname / IP:** `localhost` (oder Container-Name, z.B. `lektorat`) · **Forward Port:** `3737`
4. **Cache Assets:** aus · **Block Common Exploits:** ein
5. Tab **SSL** → *Request a new SSL Certificate* → *Force SSL* ein → speichern
6. Tab **Advanced** → folgenden Block einfügen und speichern:

```nginx
proxy_buffering         off;
proxy_cache             off;
proxy_read_timeout      300s;
proxy_send_timeout      300s;
proxy_set_header        X-Real-IP          $remote_addr;
proxy_set_header        X-Forwarded-For    $proxy_add_x_forwarded_for;
proxy_set_header        X-Forwarded-Proto  $scheme;
```

> **Docker-Netzwerk:** Laufen NPM und die Lektorat-App im selben Docker-Compose-Stack, lautet der Forward-Hostname der **Service-Name** aus der `docker-compose.yml` (z.B. `lektorat`), nicht `localhost`.

---

**4. Container starten**

```bash
docker compose up -d
```

Die SQLite-Datenbank wird im Docker-Volume `lektorat_data` persistiert und bleibt bei Updates erhalten.

**Logs ansehen:**

```bash
docker compose logs -f
```

**Container stoppen / Update:**

```bash
docker compose down
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

### Benutzer und BookStack-Tokens verwalten

Wer sich einloggen darf, steuert `ALLOWED_EMAILS` in der `.env`. Nach dem ersten Login erscheint automatisch ein Formular zum Hinterlegen des persönlichen BookStack API-Tokens:

1. In BookStack einloggen → **Profil → API-Tokens → Token erstellen**
2. Token ID und Token Secret in das Formular der Lektorat-App eintragen
3. Der Token wird in der Datenbank gespeichert und künftig automatisch geladen

Jeder Nutzer hinterlegt seinen eigenen Token – die App nutzt damit die individuellen BookStack-Berechtigungen der jeweiligen Person.

**Benutzer aus ALLOWED_EMAILS entfernen** → Server neu starten → Person kann sich nicht mehr einloggen. Der gespeicherte Token bleibt in der DB (kann manuell gelöscht werden: `DELETE FROM user_tokens WHERE email = 'person@example.com'`).

`ALLOWED_EMAILS` in der `.env`:

```env
ALLOWED_EMAILS=alice@gmail.com,bob@example.com
```

Nach jeder Änderung muss der Server neu gestartet werden (`docker compose restart` oder `systemctl restart lektorat`).

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

### Prompts anpassen (`prompt-config.json`)

Die KI-Prompts können ohne Code-Änderung über `prompt-config.json` im Projektroot angepasst werden. Änderungen werden beim nächsten Serverstart aktiv.

**Konfigurierbar:**
- `baseRules` – kontextuelle Regeln für alle Analysen (Schweizer Schreibkonventionen, Fehlerentscheidungsregeln etc.)
- `systemPrompts` – die Rollenformulierung für jeden der fünf KI-Einsatzbereiche (`lektorat`, `buchbewertung`, `kapitelanalyse`, `figuren`, `stilkorrektur`)

**Nicht konfigurierbar** (hartkodiert): JSON-Schemata, Feldnamen, Formatanweisungen – diese sind technische Verträge zwischen Prompt und App-Logik.

```json
{
  "baseRules": "SCHWEIZER KONTEXT – STRIKTE REGEL: …",
  "systemPrompts": {
    "lektorat":       "Du bist ein deutschsprachiger Lektor …",
    "buchbewertung":  "Du bist ein erfahrener Literaturkritiker …",
    "kapitelanalyse": "Du bist ein erfahrener Literaturkritiker …",
    "figuren":        "Du bist ein Literaturanalytiker …",
    "stilkorrektur":  "Du bist ein deutschsprachiger Lektor …"
  }
}
```

Fehlt die Datei oder ist sie ungültig, startet der Server normal und verwendet die eingebauten Defaults.

---

## Architektur

```
Browser → NGINX (HTTPS, öffentlich)
        → Express (Port 3737)
            → /auth/login     → redirect zu Google
            → /auth/callback  → Session anlegen, redirect /
            → /auth/logout    → Session löschen
            → /config         → Modell-Config + eingeloggter User (keine Credentials)
            → /claude         → api.anthropic.com (Key-Injection, serverseitig)
            → /ollama         → Ollama /api/chat
            → /api/*          → BookStack (Token-Injection, serverseitig)
            → /history/*      → SQLite (lektorat.db)
            → /figures/*      → SQLite (lektorat.db)
            → /jobs/*         → Hintergrund-Jobs (Buchbewertung, Figurenextraktion)
            → /sync/*         → Buchstatistik-Sync (manuell + Cron täglich 02:00)
            → /               → Single-Page-App (Alpine.js)
```

Alle geschützten Routen erfordern eine gültige Session. KI-Calls und BookStack-Credentials verlassen den Server nie – der Browser sieht weder API-Keys noch BookStack-Tokens.

---

## Lokale Entwicklung

Google OAuth2 erfordert eine öffentlich erreichbare Callback-URL und funktioniert lokal nicht ohne Weiteres. Für die Entwicklung gibt es einen Dev-Modus, der den OAuth-Flow komplett überspringt und automatisch eine Dummy-Session anlegt.

**Dev-Modus aktivieren:**

```env
# .env (lokal)
LOCAL_DEV_MODE=true
BOOKSTACK_URL=http://<host>:80

# Optional: BookStack API-Token direkt in der .env setzen,
# damit kein manuelles Token-Setup im Browser nötig ist
TOKEN_ID=<token-id>
TOKEN_KENNWORT=<token-secret>
```

```bash
npm install
node server.js
# App läuft auf http://localhost:3737
# Session: dev@local / "Dev (lokal)" – kein Login nötig
```

> **Achtung:** `LOCAL_DEV_MODE=true` niemals in Produktion setzen. Der Auth-Guard wird vollständig deaktiviert – jeder hat ohne Login Zugriff.

---

## Sicherheitshinweise

- Port 3737 darf **nicht direkt öffentlich** zugänglich sein – nur über den NGINX-Reverse-Proxy.
- `ALLOWED_EMAILS` **immer setzen** – sonst haben alle Google-Konten Zugriff.
- `SESSION_SECRET` mit einem zufällig generierten Wert belegen – nicht leer lassen.
- Nach dem Entfernen eines Benutzers aus `ALLOWED_EMAILS` und Server-Restart kann die Person sich nicht mehr einloggen. Bestehende Sessions laufen nach 7 Tagen ab.

---

## Credits

Dieses Projekt wurde mit Hilfe von [Claude Code](https://claude.ai/code) komplett **vibecoded** – entstanden durch iterative Zusammenarbeit mit KI, ohne klassische Planung auf dem Reißbrett.

Die Anwendung steht auf den Schultern folgender grossartiger Open-Source-Projekte und Dienste:

- **[BookStack](https://www.bookstackapp.com/)** – die offene, selbst hostbare Wiki-Plattform, um die sich alles dreht. Danke an Dan Brown und alle Contributors.
- **[Ollama](https://ollama.com/)** – macht lokale LLMs auf eigener Hardware unkompliziert möglich. Kein Cloud-Zwang, volle Kontrolle.
- **[Anthropic Claude](https://www.anthropic.com/)** – das KI-Modell hinter dem Cloud-Provider-Modus, und gleichzeitig das Werkzeug, mit dem diese App gebaut wurde.
- **[Claude Code](https://claude.ai/code)** – der KI-Coding-Assistent, der dieses Projekt von der ersten Zeile bis zum letzten Fix begleitet hat.
- **[Alpine.js](https://alpinejs.dev/)** – leichtgewichtiges reaktives Framework, das ohne Build-Step auskommt.
- **[vis-network](https://visjs.github.io/vis-network/)** – die Bibliothek hinter dem interaktiven Figurenbeziehungsgraphen.
- **[Chart.js](https://www.chartjs.org/)** – für die Diagramme in der Buchbewertung und den Statistiken.
