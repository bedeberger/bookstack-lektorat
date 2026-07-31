# schreibwerkstatt.app

Schreiben, Lektorat und Buchanalyse mit KI. Eigenständiger Node.js-Service, Multi-User mit Rollen-ACL pro Buch. Inhalte (Bücher/Kapitel/Seiten) liegen lokal in SQLite — keine externe Storage-Abhängigkeit.

## Features

### Schreiben & Editor
- **Bearbeitungsmodus** (Notebook-Editor) – Seiten direkt bearbeiten. Auto-Save (Idle 60 s / Max 120 s), lokaler Draft (localStorage), Offline-Modus mit Retry, Block-Level-Merge bei parallelen Edits mit Konflikt-Auflösung.
- **Fokusmodus** (Cmd/Ctrl+Shift+E) – Vollbild, Typewriter-Scroll, Absatz-Hervorhebung. Auto-Save, Schreibzeit-Tracking, Live-Zeichen-/Wortzähler, Mobile-/IME-Support. Auch als native Clients (offline-first, lokaler SQLite-Store + Sync) verfügbar: **macOS** [schreibwerkstatt-focuseditor](https://github.com/bedeberger/schreibwerkstatt-focuseditor), **Android** [schreibwerkstatt-mobile](https://github.com/bedeberger/schreibwerkstatt-mobile).
- **Bucheditor** – Ganzes Buch als scrollbarer Stream mit Kapitel-Trennern und Outline. Inline-Edit pro Seite, Save-All sequenziell. Buchweite Suche & Ersetzen (Case/Whole-Word, Treffer-Navigation, Replace-All).
- **Live-Rechtschreibung** – Optionale LanguageTool-Integration (self-hosted, regelbasiert) auf allen drei Editoren und Prosa-Formularfeldern, mit eigenem Wörterbuch.
- **Diktat** – Speech-to-Text im Notebook-Editor über einen self-hosted Whisper-Endpunkt (browserseitige Sprachpausen-Erkennung, Text verbatim am Cursor). [docs/stt.md](docs/stt.md).
- **Vorlesen** – Text-to-Speech / Proof-Listening in der Notebook-Leseansicht über einen self-hosted Speech-Endpunkt (satzweise, aktueller Satz hervorgehoben, schwebender Vorlese-Dock). [docs/tts.md](docs/tts.md).
- **Volltextsuche** – FTS5-Index über alle Seiten, Filterung nach Kapitel/Buch.
- **Buchorganizer** – Kapitel & Seiten per Drag&Drop ordnen, anlegen, umbenennen, löschen. Kapitel-Hierarchie bis 3 Ebenen.
- **Ordner-Import** – Tagebuch-Archive (ZIP mit Jahr/Monat/Tag-Struktur, Formate docx/doc/odt/abw) mit regelbasierter Datumserkennung + KI-Fallback.
- **Seiten-Verlauf** – Revisionen pro Seite mit Vergleich + Restore.
- **Fassungen** – Ganze-Buch-Snapshots als Manuskript-Meilensteine: Capture, Liste, Side-by-Side-Diff und (destruktiver) Restore ins selbe Buch. [docs/fassungen.md](docs/fassungen.md).

### KI-Lektorat & Chat
- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung mit selektiver Korrekturübernahme.
- **Synonym-Finder** – Wort markieren → Rechtsklick → Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) + KI mit Satzkontext.
- **Seiten-Chat** – KI-Dialog zu einer Seite. Änderungsvorschläge übernehmbar.
- **Buch-Chat** – Agentischer KI-Dialog über das ganze Buch mit Werkzeugen (Pronomen-Zählung, Figurenverteilung, Volltextsuche, Seitenabruf) auf vorberechnetem Index; optional Bild-Generierung (`generate_image`) über einen self-hosted, OpenAI-kompatiblen Bild-Endpunkt zur Welt-/Chat-Visualisierung (nie in den Manuskript-Text). [docs/image.md](docs/image.md).
- **Buchbewertung / Kapitelbewertung** – Stärken, Schwächen, Empfehlungen.
- **Lektorat-Verlauf** – Frühere Korrekturen als Inline-Highlights, selektiv nachträglich übernehmbar.

### Analyse & Übersichten
- **Buch-Übersicht** – Dashboard pro Buch: Zeichen-Trend, Schreib-Heatmap, Lektorat-Abdeckung, Top-Fehlertypen, Kapitel-Qualität, Figuren-/Orts-Präsenz.
- **Komplettanalyse** – Pipeline, die Figuren, Schauplätze, Szenen, Ereignisse, Weltfakten, Soziogramm und Kontinuität aus dem Buch extrahiert (Delta-Cache + Checkpoint, Nacht-Cron). [docs/komplett.md](docs/komplett.md).
- **Figurenübersicht** – Charakterextraktion mit Beziehungsgraph (Vollbild); Figurenkontext im Lektorat einblendbar.
- **Figuren-Werkstatt** – jsMind-Mindmap-Editor mit KI-Brainstorm pro Knoten + Konsistenz-Check. [docs/figur-werkstatt.md](docs/figur-werkstatt.md).
- **Plot-Werkstatt** – Beat-Board zum Planen der Handlung: Akte & Handlungspunkte als Kanban, optionale Handlungsstränge als Swimlanes (Raster Akt × Strang), KI-Brainstorm pro Akt/Zelle + Konsistenz-Check gegen die Buchrealität (nie generativ im Text). [docs/plot.md](docs/plot.md).
- **Ereignisse / Schauplätze / Szenen** – Übersichten pro Kapitel, Ereignisse zusätzlich als Jahres-Zeitstrahl.
- **Orte-Karte** – Geocodierte Schauplätze auf interaktiver Leaflet-Karte; KI-gestützte Verortung, Geocoding via Nominatim/Photon. [docs/geocode.md](docs/geocode.md).
- **Weltfakten** – Sammlung von Weltregeln/Lore/Kanon aus der Komplettanalyse.
- **Kontinuitätsprüfer** – Findet Widersprüche.
- **Stil-Heatmap / Fehler-Heatmap** – Satzlänge, Adverbien, Füllwörter, Fehlertypen pro Kapitel.
- **Buchstatistik** – Tägliche Snapshots (Zeichen, Wörter, Tokens) als Zeitliniendiagramm.
- **Ideen-Sammlung** – Notiz-Sammelbox pro Buch oder Seite.
- **Recherche** – Buchweites Wissensboard: Notizen, Links, Zitate, Faktensplitter und Bilder, mit Buch-Entitäten (Kapitel/Seite/Figur/Ort/Szene/Beat) verknüpfbar und über Tags filterbar; KI-gestützte Verknüpfungs-Vorschläge zu bestehenden Entitäten.
- **Musikbibliothek** – Pro Buch kuratierte Tracks (Titel, Interpret, Genre, Stimmung, Kontext-Typ) als Schreib-Inspiration; KI-gestützter Stimmungs-Match.
- **Tagebuch-Rückblick** – Rückwärtsgewandte KI-Verdichtung für Bücher vom Typ Tagebuch.

### Multi-User & Kollaboration
- **Rollen-ACL pro Buch** – owner / editor / lektor / viewer. Apply-only-Pfad für Lektoren (Korrekturen anwenden ohne freie Edit-Rechte).
- **Presence** – Mit-Anwesende pro Seite/Buch sichtbar (Avatar-Pip im Sidebar-Tree, Banner im Editor).
- **Page-Locks** – Soft-Lock beim Edit, automatische Heartbeats, Banner bei fremdem Lock.
- **Registrierung mit Approval** – Selbst-Registrierung mit Admin-Approval; Anti-Enumeration; optional Captcha.
- **Share-Links** – Seiten/Kapitel über opaken Token öffentlich (read-only) teilen; SSR-Reader-View, Rate-Limit + Honeypot, GDPR-IP-Hashing, Unread-Tracking für den Owner. [docs/share-link.md](docs/share-link.md).
- **Admin-Konsole** – Web-UI für User, Bücher, Settings, Kategorien, Usage.

### Export & Tooling
- **Command-Palette** (Cmd/Ctrl+K bzw. `/`) – Fuzzy-Suche über Karten, Aktionen, Seiten, Kapitel, Figuren, Orte, Szenen. Prefix-Modi: `>` `#` `!` `@` `$` `%`.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten (Stil, Szenen, Dialoge, Q&A, Korrekturen). [docs/finetuning.md](docs/finetuning.md).
- **Buch-Export** – PDF, HTML, Markdown, Plaintext, EPUB mit Timestamp-Filename.
- **Custom-PDF-Export** – Eigener pdfkit-Renderer mit druckfertiger PDF/A-2B- bzw. PDF/X-3-Konformität, freier Schriftwahl aus Google Fonts (30-Tage-Cache), Cover (inkl. Umschlagbogen mit Rücken/EAN-13), TOC, Profile pro Buch+User. Optional Server-Validierung via veraPDF.
- **EPUB-Export** – Reflow-fähiges E-Book mit eigenem Builder (Cover, Frontmatter, TOC, Blocksatz). Optionale Validierung via EPUBCheck.
- **Custom-Word-Export** – Lektorats-/Verlags-Manuskript als DOCX über die programmatische `docx`-Lib (Shunn-Kopfzeile mit Seitenzahl, echtes Word-TOC-Feld, benannte Heading-Styles, Titelei aus den Publikations-Metadaten), Profile pro Buch+User wie beim PDF. [docs/word-export.md](docs/word-export.md).
- **Publikations-Metadaten** – Zentrale Pflege (Titel, Autor, ISBN, Impressum, Widmung …) als gemeinsame Quelle für PDF- und EPUB-Export. [docs/publikation-export.md](docs/publikation-export.md).
- **Buch-Migration** – Verlustfreier Buch-Round-Trip zwischen Instanzen als `.swbook`-Bundle (Export + Import-Job). [docs/book-migration.md](docs/book-migration.md).
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit, Freitext-Kontext fliessen in alle Prompts.
- **Theme** – Hell/Dunkel/Auto, Sprachumschaltung Deutsch/Englisch.

### Integrationen & Monitoring
- **Blog-Sync (WordPress)** – Bücher vom Typ `blog` mit WordPress synchronisieren: Initial-Import, Pull, Push, LWW-Konfliktstrategie, Gutenberg-Block-Mapping. [docs/blog-sync.md](docs/blog-sync.md).
- **HubSpot-Sync** – Initial-Import + Push als Blog-Draft (kein Update/Pull-back). [docs/hubspot-sync.md](docs/hubspot-sync.md).
- **Browser-Erweiterung (Chrome)** – `schreibwerkstatt-browser-extension`: Webseiten beim Surfen als Recherche-Fundstück und/oder Quelle erfassen — ein transaktionaler Aufruf (`POST /capture`), Dublettenprüfung über die normalisierte URL, Metadaten liest die Erweiterung aus dem DOM (auch hinter Login/Paywall). Läuft mit einem eigenen Geräte-Token, das **ausschliesslich erfassen** darf und nie am Manuskript schreibt. [docs/clients.md](docs/clients.md).
- **Metrics-API** – `GET /metrics` im Prometheus-Format (Bearer-Token mit Scopes); fertige Dashboards für Home Assistant und Grafana. [docs/metrics-api.md](docs/metrics-api.md).

## Voraussetzungen

- Node.js v20–25 (`engines: >=20 <26`; Node 26 noch nicht unterstützt: better-sqlite3 11.x baut nicht gegen das V8 in Node 26 — Bump auf 12.x ausstehend). Empfohlen: `.nvmrc` (Node 24).
- Öffentliche HTTPS-URL (Reverse-Proxy mit TLS) für Produktion.
- Login-Pfad: **Admin-Bootstrap** (Email+Passwort via ENV) und/oder **Google OAuth2** (Callback `https://<domain>/auth/callback`). Mindestens einer muss konfiguriert sein.

## Quick Start

```bash
git clone https://github.com/<user>/schreibwerkstatt.git
cd schreibwerkstatt
cp .env.example .env   # SESSION_SECRET (32+ Hex) ist Pflicht
npm ci --omit=dev
node server.js         # Port 3737
```

KI-Provider, Google-OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF/EPUBCheck sowie die optionalen self-hosted Dienste (LanguageTool, Whisper-Diktat) konfiguriert die **Admin-Konsole** (Tabelle `app_settings`, kein Restart nötig).

Produktiv: systemd-Service via [deploy/schreibwerkstatt.service](deploy/schreibwerkstatt.service), Erst-Install `bash deploy/install.sh`, CD `bash deploy/deploy.sh`.

### Deploy-Migrations

Einmalige Prod-Anpassungen (Dateisystem-Cleanup, chown-Fixes, sqlite3-Touches) gehören als idempotente Shell-Scripts unter [deploy/migrations/](deploy/migrations/) — Konvention `NNN-slug.sh` (3-stellige fortlaufende Nummer). [deploy/apply-migrations.sh](deploy/apply-migrations.sh) läuft nach jedem Deploy (nach rsync + chown, vor `npm install`), führt nur Scripts aus, deren `NNN` nicht in `$INSTALL_DIR/.deploy-migrations-applied` steht, und appendet bei Erfolg. Script erhält `$INSTALL_DIR` als `$1`. Fehler bricht Deploy ab. Migration trotzdem idempotent schreiben (Marker könnte verloren gehen).

### Reverse-Proxy

Fertige, kommentierte NGINX-Konfiguration: [deploy/nginx.conf](deploy/nginx.conf) (TLS-Terminierung, HTTP→HTTPS-Redirect, ungepufferte SSE-Streams, ZIP-Import bis 200 MB, STT-Audio, Long-Cache für Vendor/Fonts). `<DOMAIN>` + Zertifikatspfade ersetzen, nach `/etc/nginx/sites-available/` kopieren, symlinken, `nginx -t && systemctl reload nginx`.

Wer **NPMplus / Nginx Proxy Manager** nutzt: [deploy/nginx-npmplus.conf](deploy/nginx-npmplus.conf) — die UI-Feldwerte (Forward `http://…:3737`, Cache/HSTS aus) plus den Override-Block für den „Advanced"-Tab des Proxy-Hosts. Der `X-Forwarded-*`-Block darin ist Pflicht, damit die App über `trust proxy` die **echte Client-IP** (`req.ip`) in ihre Audit-/Sicherheits-Logs schreibt statt der Proxy-IP.

Wesentlich: Die App lauscht auf `127.0.0.1:3737`, terminiert kein TLS und liest `X-Forwarded-Proto` (`trust proxy`). SSE braucht ungepufferte Verbindungen (`proxy_buffering off`), und die Kompression macht die App selbst — NGINX-gzip daher aus.

### Optional: veraPDF (PDF/A-Validierung)

Ohne veraPDF läuft die Validierung im Skip-Modus, das PDF wird trotzdem geliefert. Für strikte Validierung:

```bash
apt-get install -y default-jre-headless curl unzip   # oder: apk add openjdk17-jre-headless curl unzip

VERAPDF_VERSION=1.26.2
curl -sSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o /tmp/verapdf.zip
mkdir -p /opt/verapdf && unzip -q /tmp/verapdf.zip -d /opt/verapdf
cd /opt/verapdf/verapdf-greenfield-${VERAPDF_VERSION}
java -cp installer-${VERAPDF_VERSION}.jar org.verapdf.apps.Installer -options auto-install-options.xml
# /opt/verapdf-installation in PATH oder VERAPDF_BIN setzen
```

### Optional: EPUBCheck (EPUB-Validierung)

Auf Prod erledigt das die Deploy-Migration [deploy/migrations/004-install-epubcheck.sh](deploy/migrations/004-install-epubcheck.sh) automatisch (läuft bei jedem Deploy, idempotent). Ohne EPUBCheck läuft die EPUB-Validierung im Skip-Modus, das EPUB wird trotzdem geliefert. Manuell (W3C-Referenzvalidator, Java):

```bash
# Einfachster Weg: paketverwalteter Wrapper (liefert ein 'epubcheck'-Executable in PATH)
apt-get install -y epubcheck            # oder: apk add epubcheck / brew install epubcheck

# Alternativ ein eigenes Wrapper-Skript anlegen und via EPUBCHECK_BIN referenzieren —
# EPUBCHECK_BIN muss ein aufrufbares Executable sein (kein "java -jar …"-String):
#   #!/bin/sh
#   exec java -jar /opt/epubcheck/epubcheck.jar "$@"
# Deaktivieren ohne Deinstallation: app_settings epub.validate.disabled = true
```

### Optional: GITHUB_TOKEN (macOS-App-Download)

Das Profil (`/me`) zeigt eingeloggten Usern Version + Download-Link der nativen macOS-App. Der Server liest dafür das `latest`-Release des öffentlichen Repos [schreibwerkstatt-focuseditor](https://github.com/bedeberger/schreibwerkstatt-focuseditor) über die GitHub-Public-API ([lib/macclient-release.js](lib/macclient-release.js), In-Memory-Cache ~10 min). Kein Token nötig. Wird ein GitHub-Token (PAT) hinterlegt, wird es als Bearer mitgeschickt, um das API-Rate-Limit anzuheben (60→5000 Requests/h). Konfiguration: **Admin-Settings → Erweitert → `macclient.github_token`** (verschlüsselt in `app_settings` gespeichert). `GITHUB_TOKEN` in `.env` dient nur noch als einmaliger Boot-Seed in die DB.

### Update

```bash
git pull && npm ci --omit=dev && systemctl restart schreibwerkstatt
```

## Admin-Konsole

Unter `/admin` für User mit `global_role = 'admin'`:
- **Users** — Rollen, Sperren, Provider-Override pro User.
- **Books** — alle Bücher mit ACL-Einsicht/Übertragung.
- **Registrierungs-Anfragen** — Approval-Queue für `/register`-Selbstanmeldungen.
- **Settings** — KI-Provider + Keys, Google OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF/EPUBCheck, LanguageTool + Diktat, Metrics-Token.
- **Kategorien** — globaler Pool, Zuordnung pro Buch via ACL.
- **Usage** — Token-Verbrauch pro User/Provider/Job-Typ.

`ADMIN_EMAIL` in `.env` wird beim Start als globale Admin-Rolle gespiegelt (idempotent). Passwort lebt ausschliesslich in der ENV (timing-safe Vergleich, Rate-Limit pro IP).

## Demo-Zugang (Store-Reviews, Testinstanz)

Dritter Login-Pfad neben Google-OIDC und Admin-Passwort: ein **fixer Passwort-Login mit Rolle `user`**. Existenzgrund sind die App-Store-Reviews — Apple (Guideline 2.1, Feld „Sign-in required") und Google Play (`App access`) verlangen einen funktionierenden Demo-Account als Pflichtangabe, der Chrome Web Store Test-Credentials in den Reviewer-Notes. Ein Google-Konto lässt sich Reviewern nicht geben (2FA, Googles ToS, Login-Blocks aus Datacenter-IPs), und der Admin-Pfad würde `/admin/*` und fremde Bücher freigeben.

Aktivierung ausschliesslich über `.env` — fehlt eines der beiden, existiert der Pfad nicht:

```bash
DEMO_EMAIL=demo@example.com
DEMO_PASSWORD=<langes Zufallspasswort>
```

Verhalten ([lib/demo-user.js](lib/demo-user.js), Route `POST /auth/demo-login` in [routes/auth.js](routes/auth.js)):

- **Rolle ist immer `user`**, kein Invite-Recht. Wird die Row von Hand auf `admin` gehoben, drückt sie der nächste Demo-Login zurück — der Zugang ist öffentlich bekannt.
- **Gleiche Härtung wie der Admin-Login** (geteilte Factory: Rate-Limit pro IP, ALTCHA, timing-safe Vergleich, Audit-Event mit `method: 'demo'`) und **derselbe IP-Bucket** — Brute-Force gegen den einen Pfad deckelt auch den anderen.
- **Beispielbuch wird bei jedem Login geseedet** (idempotent über den Buchnamen, gemeinfreie Prosa, kein KI-Call). Ein Reviewer landet nie in einer leeren App, auch wenn der vorige alles gelöscht hat.
- **Status-Gate greift:** `suspended`/`deleted` im Admin-Tab → `403 USER_NOT_ACTIVE`. So lässt sich der Zugang ohne ENV-Änderung stilllegen.
- **`DEMO_EMAIL === ADMIN_EMAIL` deaktiviert den Demo-Pfad** (sonst streiten sich beide Routen um die Rolle derselben Row).

### Fixe Device-Tokens für die Clients

Die nativen Clients (macOS/Android) und die Browser-Erweiterung authentisieren per Bearer-Token und sehen die Login-Seite nie — ein Reviewer müsste sich sonst erst im Browser einloggen, im Profil ein Token minten und es in die App kopieren. Darum lassen sich beide Token-Arten in der ENV festnageln:

```bash
DEMO_DEVICE_TOKEN=swd_$(openssl rand -hex 32)    # macOS + Android (content:write)
DEMO_CAPTURE_TOKEN=swd_$(openssl rand -hex 32)   # Chrome-Erweiterung (capture:write)
```

Der Klartext gehört danach in die Store-Reviewer-Notes (zusammen mit der Server-URL); die DB kennt weiter nur den SHA-256-Hash. Registriert werden sie beim **Serverstart** ([lib/demo-user.js](lib/demo-user.js)#`ensureDemoAccess`, aufgerufen in [server.js](server.js)) — nicht erst beim ersten Login, denn genau diese Clients loggen sich nie über den Browser ein. Die Scopes folgen den bestehenden Token-Arten aus [lib/device-scopes.js](lib/device-scopes.js); der Demo-Zugang bekommt damit **keine** Sonderrechte, die Erweiterung bleibt auf die Capture-Allowlist beschränkt.

- **Format ist Pflicht:** `swd_` + 64 Hex-Zeichen. Ein formal ungültiger Wert wird abgelehnt und **nicht** registriert (Log-Error) — sonst wandert ein `swd_test` als vollwertiger Schreibzugang auf eine öffentlich erreichbare Instanz.
- **Rotation entzieht wirklich:** neuer Wert in derselben Variable + Neustart → das alte Token gilt nicht mehr (der Slot wird über den `device_name` identifiziert und aufgeräumt).
- **Nicht über die UI entziehbar:** die Tokens erscheinen im Demo-Profil wie jedes andere Gerät, aber Widerrufen/Löschen antwortet `403 DEMO_TOKEN_FIXED` — sonst schaltet ein neugieriger Reviewer den Zugang für alle folgenden ab. Entzogen wird über die ENV.
- **Beide Slots brauchen unterschiedliche Werte** (`token_hash` ist UNIQUE — derselbe Wert in beiden würde die Scopes des ersten überschreiben). Wird das verletzt, bleibt der zweite Slot unregistriert.
- Sichtbar im Admin-Tab „Geräte" unter `Demo-Client (macOS/Android)` bzw. `Demo-Erweiterung (Chrome)` — inkl. `last_used_at` und gemeldeter Client-Version, sodass man sieht, ob ein Reviewer die App tatsächlich gestartet hat.

Ein Token teilt sich macOS und Android bewusst (dasselbe Device-Token darf laut [docs/clients.md](docs/clients.md) auf mehreren Geräten laufen, `X-Client-Platform` unterscheidet sie zur Laufzeit). Wer die beiden trennen will, ergänzt einen weiteren Slot in `TOKEN_SLOTS` ([lib/demo-user.js](lib/demo-user.js)).

> **Nur auf einer separaten Demo-Instanz setzen, nie auf Prod.** Reviewer schreiben, und KI-Jobs kosten Geld. Auf der Demo-Instanz zusätzlich: eigene DB, günstiger/lokaler `ai.provider`, Budget-Cap für den Demo-User, eigener API-Key mit Hard Limit — und ein Reset-Job, der die DB nachts auf einen Snapshot zurücksetzt.

## Backup

Tägliches Online-Backup der SQLite-DB via systemd-Timer (`schreibwerkstatt-backup.timer`, Default 03:00). `sqlite3 .backup` (lock-frei, WAL-konsistent), gzip-komprimiert, Retention nach `mtime`. Pre-Deploy zusätzlicher Snapshot.

Konfig via `.env`: `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_DB_FILE`. Script + Units: [deploy/backup.sh](deploy/backup.sh), [deploy/schreibwerkstatt-backup.service](deploy/schreibwerkstatt-backup.service), [deploy/schreibwerkstatt-backup.timer](deploy/schreibwerkstatt-backup.timer).

Backup-Ordner offsite spiegeln (rsync nach NAS/S3) — sonst Single-Point-of-Failure.

## Prompts anpassen

`prompt-config.json` im Projektroot (Pflichtdatei). Konfigurierbar: `locales` (`de-CH`/`de-DE`/`en-US`/`en-GB` mit Regeln, Rollen, Stoppwortlisten), `buchtypen` (Genre pro Sprache mit Label + Kontext), `erklaerungRule` (globale Fehlerfilter-Regel), `defaultLocale`. Per-Buch in der UI: Buchtyp + Freitext-Kontext. Änderungen beim nächsten Serverstart aktiv.

## Lokale Entwicklung

`LOCAL_DEV_MODE=true` in `.env` überspringt OAuth, legt Dev-Session an (`dev@local`).

> Niemals in Produktion – Auth-Guard wird komplett deaktiviert.

## Credits

### Plattformen & Modelle

- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell (Anthropic Usage Policies; Outputs frei nutzbar)
- **[Ollama](https://ollama.com/)** (MIT) / **[llama.cpp](https://github.com/ggerganov/llama.cpp)** (MIT) / **[LM Studio](https://lmstudio.ai/)** – lokale LLMs
- **[OpenThesaurus](https://www.openthesaurus.de/)** – Synonyme (LGPL/CC-BY-SA; Nutzung via öffentliche API, keine Redistribution)
- **[veraPDF](https://verapdf.org/)** – PDF/A-Validierung (GPL-3.0; externer Prozess)

### Frontend-Libraries (vendored in [public/vendor/](public/vendor/))

- **[Alpine.js](https://alpinejs.dev/)** (MIT), **[vis-network](https://visjs.github.io/vis-network/)** (Apache-2.0 + MIT), **[Chart.js](https://www.chartjs.org/)** (MIT), **[SortableJS](https://github.com/SortableJS/Sortable)** (MIT), **[jsMind](https://github.com/hizzgdev/jsmind)** (BSD-3-Clause).

Originallizenztexte: [public/vendor/LICENSES/](public/vendor/LICENSES/).

### Fonts

- **[Inter](https://rsms.me/inter/)** © Rasmus Andersson – SIL Open Font License 1.1
- **[Source Serif 4](https://github.com/adobe-fonts/source-serif)** © Adobe – SIL Open Font License 1.1

Schriftdateien in [public/fonts/](public/fonts/), Lizenz [public/fonts/OFL.txt](public/fonts/OFL.txt). Custom-PDF-Export bettet zur Laufzeit Google-Fonts-Familien ein (jeweils SIL OFL 1.1 oder Apache-2.0).

### Server-Dependencies

Vollständige Liste in [package.json](package.json) – durchgehend OSI-genehmigte permissive Lizenzen (MIT/Apache-2.0/BSD/ISC). Auswahl: Express, better-sqlite3, pdfkit, sharp, linkedom, jsonrepair, winston, helmet, openid-client, node-cron, xmlbuilder2, epub-gen-memory, docx.

## Lizenz

**GNU Affero General Public License v3.0** (AGPL-3.0) – siehe [LICENSE](LICENSE). Wer den Dienst über ein Netzwerk anbietet, muss den modifizierten Quellcode den Nutzern verfügbar machen (§ 13 AGPL).

Drittsoftware-Lizenzen: [public/vendor/LICENSES/](public/vendor/LICENSES/), Schriften [public/fonts/OFL.txt](public/fonts/OFL.txt).
