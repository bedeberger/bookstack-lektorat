# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Läuft als eigenständiger Node.js-Service und bietet:

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung einzelner Seiten mit selektiver Fehlerkorrektur
- **Bearbeitungsmodus** – Seiteninhalt direkt in der App editieren und nach BookStack zurückspeichern. Auto-Save alle 30 s, lokaler Draft (localStorage) mit Wiederherstellungs-Prompt, Offline-Modus mit automatischem Retry bei Reconnect
- **Fokusmodus** – Ablenkungsfreier Vollbild-Schreibmodus (F11):
  - Typewriter-Scroll – die Cursor-Zeile bleibt automatisch mittig im Viewport
  - Absatz-Hervorhebung – der aktuelle Absatz bleibt hell, der Rest wird abgedunkelt
  - Offline-fähig – Auto-Save alle 30 s, lokaler Draft (localStorage), automatischer Retry bei Reconnect; beim Verlassen wird gespeichert
  - Figuren-Lookup und Synonym-Finder (Rechtsklick) bleiben im Fokusmodus verfügbar
  - Schreibzeit-Tracking – Editier- und Fokuszeit werden pro Buch summiert (Heartbeat alle 15 s)
  - Mobile- und IME-Support – passt sich der Bildschirmtastatur (`visualViewport`) an und respektiert CJK-Composition sowie `prefers-reduced-motion`
- **Synonym-Finder** – Im Bearbeitungsmodus: Wort markieren → Rechtsklick → kombinierte Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) (deutsch) und der KI mit Satzkontext; Klick ersetzt direkt im Text
- **Seiten-Chat** – Freier KI-Dialog zu einer Seite inkl. Kontext (Figuren, Buchbewertung); Änderungsvorschläge direkt in BookStack übernehmen
- **Buch-Chat** – KI-Dialog über das gesamte Buch. Der Assistent nutzt Werkzeuge (Pronomen-Zählung, Figurenverteilung, Volltextsuche, Seitenabruf), die auf einen vorberechneten Index zugreifen, und kann so auch Häufigkeits- und Verteilungsfragen über das ganze Buch präzise beantworten (z.B. „Kommt der Ich-Erzähler häufiger vor?"). Index wird beim täglichen Sync (02:00) aktualisiert
- **Buchbewertung** – Gesamtbewertung des Buchs mit Stärken, Schwächen und Empfehlungen
- **Kapitelbewertung** – Fokussierte Einzelbewertung eines Kapitels (Dramaturgie, Erzähltempo, Kohärenz, Perspektive); unabhängig von der Gesamt-Buchbewertung
- **Figurenübersicht** – Automatische Charakterextraktion mit interaktivem Beziehungsgraph; Figurenkontext-Panel auch während des Lektorats einer Seite einblendbar
- **Ereignisse / Schauplätze / Szenen** – Automatische Übersichten pro Kapitel
- **Kontinuitätsprüfer** – Findet Widersprüche im Buch
- **Stil-Heatmap** – Visualisiert stilistische Kennzahlen (Satzlänge, Adverbien, Füllwörter, Wiederholungen …) pro Kapitel
- **Fehler-Heatmap** – Clustert die Befunde aller bisherigen Lektorats-Läufe nach Kapitel und Fehlertyp
- **Lektorat-Verlauf mit Vorschau** – Alle bisherigen Prüfungen einer Seite chronologisch einsehbar; vergangene Korrekturen per Klick als Inline-Highlights im Editor anzeigen und selektiv nachträglich übernehmen. Einzelne Verlaufseinträge lassen sich löschen
- **Buchstatistik** – Tägliche Snapshots (Wortanzahl, Tokens) als Zeitliniendiagramm
- **Fine-Tuning-Export** – Erzeugt JSONL-Trainingsdaten aus Buchtext, Figuren, Szenen und Schauplätzen (Stil-Fortsetzung, Szenen-Generierung, Dialog pro Figur, Autor-Chat-Q&A, Lektorats-Korrekturen); Chat-Format mit Train/Val-Split, kompatibel zu Mistral-Fine-Tune und OpenAI-Style-Tools. Anleitung zum eigentlichen Training eines Ministral-Modells: [docs/finetuning.md](docs/finetuning.md)
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit und freier Kontext werden in alle KI-Prompts eingebettet
- **Hell/Dunkel/Auto-Design** – Theme-Umschalter in der Kopfzeile; „Auto" folgt dem Betriebssystem
- **Session-Banner bei Ablauf** – Bei `401`-Antworten blendet die App einen Banner ein statt hart umzuleiten; ungespeicherte Inhalte im Editor/Chat bleiben dadurch erreichbar

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
- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell und Coding-Assistent
- **[Ollama](https://ollama.com/)** und **[llama.cpp](https://github.com/ggerganov/llama.cpp)** / **[LM Studio](https://lmstudio.ai/)** – lokale LLMs auf eigener Hardware (wahlweise per `API_PROVIDER=ollama` oder `API_PROVIDER=llama`)
- **[OpenThesaurus](https://www.openthesaurus.de/)** – deutscher Community-Thesaurus (Synonym-Finder)
- **[Alpine.js](https://alpinejs.dev/)** – leichtgewichtiges reaktives Framework
- **[vis-network](https://visjs.github.io/vis-network/)** – interaktiver Beziehungsgraph
- **[Chart.js](https://www.chartjs.org/)** – Diagramme
