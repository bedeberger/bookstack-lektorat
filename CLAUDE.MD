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
├── mcp-server.mjs       # MCP-Server für Claude Desktop
├── package.json
├── .env                 # Credentials (nicht eingecheckt)
├── lektorat.service     # systemd unit
├── install.sh           # Installer für den LXC
└── public/
    └── index.html       # Single-Page-App (Vanilla JS, kein Build-Step)
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

Nützliche Befehle auf dem LXC:
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
| GET | `/api/search?query=X&count=N` | Volltextsuche (MCP) |

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

## MCP Server (Claude Desktop)

`mcp-server.mjs` ist ein MCP-Server für Claude Desktop, der direktes Chatten mit BookStack-Büchern ermöglicht. Er liest Credentials aus `.env` (nicht aus dem Browser-LocalStorage).

### Setup

1. `.env` im Projektverzeichnis anlegen:
   ```
   TOKEN_ID=...
   TOKEN_KENNWORT=...
   API_HOST=http://localhost:80    # oder BOOKSTACK_URL
   ANTHROPIC_API_KEY=...           # nur für lektorat_page benötigt
   ```
2. In `~/Library/Application Support/Claude/claude_desktop_config.json` eintragen:

```json
{
  "mcpServers": {
    "bookstack": {
      "command": "node",
      "args": ["/Users/bd/ClaudeProjects/bookstack-lektorat/mcp-server.mjs"]
    }
  }
}
```

3. Claude Desktop neu starten – im Hammer-Icon erscheinen die `bookstack`-Tools.

### Verfügbare Tools

| Tool | Parameter | Beschreibung |
|------|-----------|-------------|
| `list_books` | – | Alle Bücher auflisten |
| `list_chapters` | `book_id` | Kapitel eines Buchs |
| `list_pages` | `book_id` | Seiten eines Buchs |
| `get_page` | `page_id` | Seiteninhalt lesen (Text + HTML) |
| `search` | `query`, `count` (optional, default 20) | Volltextsuche |
| `update_page` | `page_id`, `html`, `name` (optional) | Seite speichern |
| `lektorat_page` | `page_id`, `auto_save` (optional) | Seite lektorieren; `max_tokens: 8000` |

---

## Bekannte Einschränkungen

- Kein Authentifizierungsschutz auf Port 3737 – nur im lokalen Netz verwenden
- Frontend sendet keinen `x-api-key` an Claude – Claude-Aufrufe aus dem Browser scheitern ohne externen Key-Proxy
- Sehr lange Seiten können das Claude-Token-Limit erreichen (Frontend: max_tokens 4000, MCP: 8000)
- Kein Diff-View zwischen Original und korrigierter Version
- Buchbewertung kürzt Seitentexte auf 3000 Zeichen – sehr lange Seiten werden unvollständig analysiert
