# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Läuft als eigenständiger Node.js-Service und bietet:

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung einzelner Seiten mit selektiver Fehlerkorrektur
- **Seiten-Chat** – Freier KI-Dialog zu einer Seite inkl. Kontext (Figuren, Buchbewertung); Änderungsvorschläge direkt in BookStack übernehmen
- **Buch-Chat** – KI-Dialog über das gesamte Buch; relevante Seiten werden automatisch nach Thema ausgewählt
- **Buchbewertung** – Gesamtbewertung mit Stärken, Schwächen und Empfehlungen
- **Figurenübersicht** – Automatische Charakterextraktion mit interaktivem Beziehungsgraph
- **Ereignisse / Schauplätze / Szenen** – Automatische Übersichten pro Kapitel
- **Kontinuitätsprüfer** – Findet Widersprüche im Buch
- **Buchstatistik** – Tägliche Snapshots (Wortanzahl, Tokens) als Zeitliniendiagramm
- **Bucheinstellungen** – Sprache, Buchtyp und freier Kontext werden in alle KI-Prompts eingebettet

---

## Voraussetzungen

- **Öffentlich erreichbare HTTPS-URL** – Google OAuth2 benötigt eine Callback-URL. Typisch: Reverse-Proxy (NGINX, Caddy, Traefik) mit Domain und TLS-Zertifikat.
- **Google OAuth2 Credentials** – In der [Google Cloud Console](https://console.cloud.google.com) unter *APIs & Dienste → Anmeldedaten* eine OAuth 2.0-Client-ID anlegen. Weiterleitungs-URI: `https://<deine-domain>/auth/callback`. Tipp: Dasselbe Projekt wie BookStack verwenden, spart einen separaten Consent-Screen.

---

## Quick Start (Docker Compose)

```bash
git clone https://github.com/<user>/bookstack-lektorat.git
cd bookstack-lektorat
cp .env.example .env
# .env öffnen und Pflichtfelder setzen (alle Variablen sind in .env.example dokumentiert)
docker compose up -d
```

### Reverse-Proxy: SSE-Buffering deaktivieren

Der KI-Streaming-Endpunkt nutzt Server-Sent Events. Ohne passende Proxy-Config puffert der Reverse-Proxy die Chunks und der Fortschrittsbalken hängt. Im Advanced-Block des Proxy-Hosts:

```nginx
proxy_buffering         off;
proxy_cache             off;
proxy_read_timeout      300s;
proxy_send_timeout      300s;
```

### Container verwalten

```bash
docker compose logs -f          # Logs ansehen
docker compose down && git pull && docker compose up -d --build   # Update
```

---

## Direkt auf einem Server (ohne Docker)

Node.js v20+ und npm nötig.

```bash
git clone https://github.com/<user>/bookstack-lektorat.git
cd bookstack-lektorat
cp .env.example .env
npm install
node server.js    # Port 3737
```

Für Produktivbetrieb: systemd-Service (siehe `lektorat.service`).

---

## BookStack-Token einrichten

Nach dem ersten Login erscheint ein Formular zum Hinterlegen des persönlichen BookStack API-Tokens:

1. In BookStack: **Profil → API-Tokens → Token erstellen**
2. Token ID und Secret in das Formular der Lektorat-App eintragen

Jeder Nutzer hinterlegt seinen eigenen Token – die App nutzt damit die individuellen BookStack-Berechtigungen.

---

## Prompts anpassen (`prompt-config.json`)

Die KI-Prompts können ohne Code-Änderung über `prompt-config.json` im Projektroot angepasst werden. Änderungen werden beim nächsten Serverstart aktiv.

**Konfigurierbar:**
- `locales` – Locale-Map (`de-CH`, `de-DE`, `en-US`, `en-GB`) mit sprachspezifischen Regeln, Rollenformulierungen und Stoppwortlisten
- `buchtypen` – Genre-Typen nach Sprachcode (`de`, `en`) mit Label und KI-Kontext-Text
- `erklaerungRule` – globale Regel zur Fehlerfilterung
- `defaultLocale` – Standard-Locale wenn kein Buch konfiguriert ist

**Per-Buch über die UI einstellbar** (Bucheinstellungen):
- **Buchtyp** – wählt einen Genre-Kontext aus `buchtypen`
- **Weiterer Kontext** – Freitext für Schauplatz, Epoche, Besonderheiten etc.

Fehlt die Datei, startet der Server nicht.

---

## Lokale Entwicklung

`LOCAL_DEV_MODE=true` in der `.env` überspringt Google OAuth und legt automatisch eine Dev-Session an (`dev@local`). Details und optionale Variablen: siehe `.env.example`.

> **Niemals in Produktion setzen** – der Auth-Guard wird vollständig deaktiviert.

---

## BookStack PDF-Export anpassen

Im Repository liegt [`book.blade.php`](book.blade.php) als Beispiel für ein Buch-Export-Template (B5, Playfair Display / EB Garamond, automatisches Inhaltsverzeichnis, laufende Kopfzeilen).

**Installation:**
```
themes/custom/exports/book.blade.php
```
Theme-Name in der BookStack `.env` setzen (`APP_THEME=custom`).

> Das Template lädt Google Fonts via `@import url()` – der Server braucht Internetzugang für die PDF-Generierung.

---

## Credits

Dieses Projekt wurde mit [Claude Code](https://claude.ai/code) komplett **vibecoded**.

- **[BookStack](https://www.bookstackapp.com/)** – offene, selbst hostbare Wiki-Plattform
- **[Ollama](https://ollama.com/)** – lokale LLMs auf eigener Hardware
- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell und Coding-Assistent
- **[Alpine.js](https://alpinejs.dev/)** – leichtgewichtiges reaktives Framework
- **[vis-network](https://visjs.github.io/vis-network/)** – interaktiver Beziehungsgraph
- **[Chart.js](https://www.chartjs.org/)** – Diagramme
