# bookstack-lektorat

KI-gestütztes Lektorat-Tool für BookStack. Läuft als eigenständiger Node.js-Service auf demselben LXC wie BookStack und proxied die BookStack-API intern.

## Architektur

```
Browser → Express (Port 3737) → /api/* → BookStack (localhost:80)
                              → /      → public/index.html
```

Der Express-Server übernimmt zwei Aufgaben: er served die Single-Page-App unter `/` und proxied alle `/api/*`-Requests an die lokale BookStack-Instanz. Da beides auf demselben Host läuft, gibt es kein CORS-Problem. Die HTML-App spricht Claude direkt über `api.anthropic.com` an (API-Key kommt aus der Anthropic-SDK-Konfiguration des Browsers, nicht vom Server).

## Projektstruktur

```
bookstack-lektorat/
├── server.js            # Express-Server + http-proxy-middleware
├── package.json
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

Token-Credentials werden im `localStorage` des Browsers gespeichert (einmalig einzugeben).

## Claude-Integration

Die App ruft `https://api.anthropic.com/v1/messages` direkt aus dem Browser auf. Modell: `claude-sonnet-4-20250514`.

Der Prompt instruiert Claude explizit, **Helvetismen nicht als Fehler zu werten** (grösseres, Strasse, gemäss usw.). Claude gibt strukturiertes JSON zurück:

```json
{
  "fehler": [{ "typ": "rechtschreibung|grammatik|stil", "original": "", "korrektur": "", "kontext": "", "erklaerung": "" }],
  "korrekturen_html": "<vollständiges korrigiertes HTML>",
  "stilanalyse": "...",
  "fazit": "..."
}
```

Der korrigierte HTML-String wird bei Bedarf per PUT direkt in BookStack gespeichert.

## Bekannte Einschränkungen

- Kein Authentifizierungsschutz auf Port 3737 – nur im lokalen Netz verwenden
- BookStack-Token wird im Browser-LocalStorage gespeichert, nicht server-seitig
- Sehr lange Seiten können das Claude-Token-Limit erreichen (max_tokens: 4000)
- Kein Diff-View zwischen Original und korrigierter Version