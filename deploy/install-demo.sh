#!/bin/bash
# Schreibwerkstatt – Installer fuer die DEMO-Instanz (Store-Reviews / Testzugang)
#
# Abgeleitet von deploy/install.sh; laeuft wie dieses IM Container. Quelle ist
# ein Repo-Checkout — entweder der, in dem das Skript liegt, oder ein selbst
# geklonter (siehe unten). Unterschiede zur Prod-Installation:
#   • eigenes Verzeichnis, eigener Service, eigener Port  → kann neben Prod laufen
#   • eigener System-User (nicht der CD-Runner)           → schreibt nur ins eigene Dir
#   • generiert die .env inkl. aller Demo-Credentials     → Ausgabe fuer Reviewer-Notes
#   • naechtlicher Reset-Timer statt Backup-Timer         → Wegwerf-Daten
#   • kein Google-OAuth noetig                            → Login via Demo-Passwort
#
# Usage (im Container, als root; das Arbeitsverzeichnis ist egal):
#   bash deploy/install-demo.sh --domain demo.example.com
#   bash deploy/install-demo.sh --print-credentials      # Zugangsdaten erneut anzeigen
#
# Auf einem frischen LXC genuegt das Skript allein — liegt es nicht in einem
# Repo-Checkout, klont es das Repo selbst nach /root/schreibwerkstatt:
#   curl -fsSL https://raw.githubusercontent.com/bedeberger/schreibwerkstatt/main/deploy/install-demo.sh \
#     | bash -s -- --domain demo.example.com
#
# Optionen:
#   --domain <host>        Oeffentliche URL der Demo-Instanz (setzt app.public_url)
#   --repo <url>           Quell-Repo fuers Selbst-Klonen (Default: GitHub-Origin)
#   --ref <branch|tag>     Auszucheckender Ref (Default: main)
#   --with-export-tools    veraPDF/Ghostscript/ICC/EPUBCheck mitinstallieren
#                          (~200 MB inkl. JRE; ohne das laufen PDF/EPUB-Export
#                           trotzdem, nur ohne Normvalidierung)
#   --print-credentials    Nur die Zugangsdaten aus der bestehenden .env zeigen
#
# Ueberschreibbar per Env-Var:
#   INSTALL_DIR (/opt/schreibwerkstatt-demo)  SERVICE (schreibwerkstatt-demo)
#   PORT (3738)                               RUN_USER (swdemo)
#   REPO_URL / REPO_REF                       SRC_CACHE (/root/schreibwerkstatt)
#
# LXC vorher anlegen (auf dem Proxmox-Host, Debian-12-Template):
#   pct create 210 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
#     --hostname schreibwerkstatt-demo --cores 2 --memory 2048 --swap 512 \
#     --rootfs local-lvm:12 --net0 name=eth0,bridge=vmbr0,ip=dhcp \
#     --features nesting=1 --unprivileged 1 --onboot 1 --start 1
#   pct exec 210 -- bash -c 'apt-get update && apt-get install -y curl'
#   pct exec 210 -- bash -c 'curl -fsSL https://raw.githubusercontent.com/bedeberger/schreibwerkstatt/main/deploy/install-demo.sh | bash -s -- --domain demo.example.com'
#
# Reverse-Proxy: dieselbe Konfiguration wie Prod (deploy/nginx.conf bzw.
# deploy/nginx-npmplus.conf), nur `<DOMAIN>` = Demo-Domain und Upstream-Port
# 3738 statt 3737. TLS ist Pflicht — Apples App Transport Security laesst einen
# nativen Client sonst nicht gegen den Server sprechen.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/schreibwerkstatt-demo}"
SERVICE="${SERVICE:-schreibwerkstatt-demo}"
PORT="${PORT:-3738}"
RUN_USER="${RUN_USER:-swdemo}"
REPO_URL="${REPO_URL:-https://github.com/bedeberger/schreibwerkstatt.git}"
REPO_REF="${REPO_REF:-main}"
SRC_CACHE="${SRC_CACHE:-/root/schreibwerkstatt}"

DOMAIN=""
WITH_EXPORT_TOOLS=0
PRINT_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)             DOMAIN="$2"; shift 2 ;;
    --repo)               REPO_URL="$2"; shift 2 ;;
    --ref)                REPO_REF="$2"; shift 2 ;;
    --with-export-tools)  WITH_EXPORT_TOOLS=1; shift ;;
    --print-credentials)  PRINT_ONLY=1; shift ;;
    # Kopfkommentar als Hilfe ausgeben, bis zur ersten Nicht-Kommentarzeile.
    # Keine feste Zeilenzahl: die waechst mit dem Header und laeuft dann in den
    # Code hinein.
    # `$0` ist bei `curl … | bash` die Shell selbst — dann gibt es keine lesbare
    # Quelldatei und awk braeche mit einem irrefuehrenden Fehler ab.
    -h|--help)
      if [ -r "${BASH_SOURCE[0]:-}" ]; then
        awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/,""); print }' "${BASH_SOURCE[0]}"
      else
        echo "Hilfe steht im Kopf von deploy/install-demo.sh — beim Aufruf ueber eine"
        echo "Pipe ist die Quelldatei nicht lesbar. Wichtigste Optionen:"
        echo "  --domain <host> --repo <url> --ref <branch> --with-export-tools --print-credentials"
      fi
      exit 0 ;;
    *) echo "Unbekannte Option: $1 (--help zeigt die Nutzung)"; exit 2 ;;
  esac
done

ENV_FILE="$INSTALL_DIR/.env"

# ── Zugangsdaten anzeigen ────────────────────────────────────────────────────
# Eigener Modus, damit man die Werte fuer die Store-Formulare nachschlagen kann,
# ohne die Installation erneut anzufassen (und ohne die Secrets zu rotieren).
print_credentials() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "✗ Keine .env gefunden: $ENV_FILE — erst installieren."
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  local url="${APP_PUBLIC_URL:-https://<domain>}"
  cat <<EOF

╔══════════════════════════════════════════════════════════════════════════════
║  ZUGANGSDATEN DEMO-INSTANZ — fuer die Store-Reviewer-Angaben
╠══════════════════════════════════════════════════════════════════════════════
║  Server-URL ............ $url
║
║  Web-Login (Apple "Sign-In required", Play "App access"):
║    E-Mail ............... ${DEMO_EMAIL:-<nicht gesetzt>}
║    Passwort ............. ${DEMO_PASSWORD:-<nicht gesetzt>}
║
║  Device-Token macOS + Android (in der App einsetzen):
║    ${DEMO_DEVICE_TOKEN:-<nicht gesetzt>}
║
║  Device-Token Chrome-Erweiterung (Reviewer-Notes):
║    ${DEMO_CAPTURE_TOKEN:-<nicht gesetzt>}
║
║  Admin-Konsole dieser Instanz (NICHT an Reviewer geben):
║    ${ADMIN_EMAIL:-<nicht gesetzt>} / ${ADMIN_PASSWORD:-<nicht gesetzt>}
╚══════════════════════════════════════════════════════════════════════════════

Erneut anzeigen: bash $INSTALL_DIR/deploy/install-demo.sh --print-credentials
EOF
}

if [ "$PRINT_ONLY" = "1" ]; then
  print_credentials
  exit 0
fi

if [ "$(id -u)" != "0" ]; then
  echo "✗ Bitte als root ausfuehren (systemd-Units, System-User, /opt)."
  exit 1
fi

echo ""
echo "=== Schreibwerkstatt Demo-Installer ==="
echo "    Ziel: $INSTALL_DIR   Service: $SERVICE   Port: $PORT   User: $RUN_USER"
echo ""

# ── Pakete ───────────────────────────────────────────────────────────────────
# sqlite3-CLI ist hier PFLICHT (nicht optional wie auf Prod): der Golden-Snapshot
# und der Reset laufen ueber `sqlite3 .backup`.
echo "→ Systempakete…"
apt-get update -qq
apt-get install -y -qq curl ca-certificates sqlite3 git >/dev/null

if ! command -v node &>/dev/null; then
  echo "→ Node.js 20 installieren…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  Node: $(node -v)"

# ── System-User ──────────────────────────────────────────────────────────────
if ! id "$RUN_USER" &>/dev/null; then
  echo "→ System-User $RUN_USER anlegen…"
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi

# ── Quelle: Checkout finden oder selbst klonen ───────────────────────────────
# Quelle ist das Repo, in dem DIESES Skript liegt — nicht das Arbeitsverzeichnis
# des Aufrufers. Wer `bash schreibwerkstatt/deploy/install-demo.sh` aus dem
# Home-Verzeichnis startet, kopierte sonst sein Home nach $INSTALL_DIR und das
# nachfolgende `npm install` scheiterte an der fehlenden package.json.
#
# Liegt das Skript nicht in einem Checkout (einzeln auf den frischen LXC kopiert
# oder per `curl | bash` gestartet), klont der Installer das Repo selbst nach
# $SRC_CACHE. Der Klon bleibt liegen, damit ein Re-Install ihn aktualisiert
# statt neu zu klonen.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." 2>/dev/null && pwd || true)"

if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/package.json" ]; then
  SRC_DIR="$SRC_CACHE"
  if [ -d "$SRC_DIR/.git" ]; then
    echo "→ Checkout $SRC_DIR aktualisieren ($REPO_REF)…"
    git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF"
    git -C "$SRC_DIR" checkout -q FETCH_HEAD
  elif [ -n "$(ls -A "$SRC_DIR" 2>/dev/null || true)" ]; then
    # Nicht blind ueberschreiben: hier koennte ein halber Checkout oder etwas
    # ganz anderes liegen, das der Installer nicht angelegt hat.
    echo "✗ $SRC_DIR ist nicht leer und kein Git-Checkout."
    echo "  Bitte pruefen und entfernen — oder SRC_CACHE auf ein anderes Verzeichnis setzen."
    exit 1
  else
    echo "→ Repo klonen nach $SRC_DIR ($REPO_URL, $REPO_REF)…"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR"
  fi
fi

if [ ! -f "$SRC_DIR/package.json" ]; then
  echo "✗ $SRC_DIR ist kein Repo-Checkout (package.json fehlt) — Abbruch."
  exit 1
fi

echo "→ Installiere nach $INSTALL_DIR (Quelle: $SRC_DIR)…"
mkdir -p "$INSTALL_DIR"
if [ "$SRC_DIR" = "$(cd "$INSTALL_DIR" && pwd)" ]; then
  # Checkout liegt bereits am Zielort: Kopieren wuerde das Verzeichnis in sich
  # selbst entpacken.
  echo "  Quelle == Ziel — Kopierschritt uebersprungen."
else
  # .env, DB und node_modules ueberleben eine Neuinstallation.
  # pipefail, weil sonst nur der Exit-Code des entpackenden tar zaehlt und ein
  # Fehler beim Einlesen der Quelle unbemerkt eine halbe Installation hinterlaesst.
  ( set -o pipefail
    tar -cf - -C "$SRC_DIR" --exclude=.git --exclude=node_modules --exclude=.env \
        --exclude='schreibwerkstatt.db*' --exclude='demo-golden.db' . \
      | tar -xf - -C "$INSTALL_DIR" )
fi

cd "$INSTALL_DIR"
echo "→ npm install…"
npm install --omit=dev --quiet

# ── .env aus der Vorlage generieren ──────────────────────────────────────────
# SSoT des ENV-Layouts ist .env.demo.example im Repo-Root — dort steht jede
# Variable samt Begruendung. Hier werden nur die __PLATZHALTER__ ersetzt. Ein
# zweiter Heredoc mit denselben Keys wuerde bei jeder Aenderung an einem der
# beiden Orte auseinanderlaufen.
#
# Idempotent und bewusst NICHT ueberschreibend: eine erneute Installation darf
# die Credentials nicht rotieren, sonst laufen die bereits bei Apple/Google
# eingetragenen Zugangsdaten ins Leere und das Review scheitert an einem
# Login-Fehler, dessen Ursache man dort nicht sieht.
gen_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
gen_pw()  { node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"; }

TEMPLATE="$INSTALL_DIR/.env.demo.example"

if [ -f "$ENV_FILE" ]; then
  echo "→ .env existiert — Credentials bleiben unveraendert."
else
  if [ ! -f "$TEMPLATE" ]; then
    echo "✗ Vorlage fehlt: $TEMPLATE (gehoert ins Repo)"
    exit 1
  fi
  echo "→ .env aus .env.demo.example generieren (Credentials EINMALIG erzeugt)…"
  ENV_DOMAIN="${DOMAIN:-demo.local}"
  # Werte vorab in Variablen, damit jeder Platzhalter genau EINEN Wert bekommt
  # (ein gen_* im sed-Ausdruck wuerde pro Vorkommen neu wuerfeln).
  V_SECRET="$(gen_hex 32)"
  V_ADMIN_PW="$(gen_pw)"
  V_DEMO_PW="$(gen_pw)"
  V_TOK_DEVICE="swd_$(gen_hex 32)"
  V_TOK_CAPTURE="swd_$(gen_hex 32)"

  # Erst in eine Nebendatei schreiben und nur bei fehlerfreiem Ergebnis
  # einschwenken. Direkt nach $ENV_FILE zu schreiben waere gefaehrlich: bricht
  # sed ab, bleibt eine LEERE .env liegen, und der naechste Lauf haelt sie fuer
  # eine bestehende Konfiguration ("Credentials bleiben unveraendert") und
  # startet die Instanz ohne Secrets.
  #
  # Das `\$#` im PORT-Ausdruck muss escaped sein — unescaped expandiert bash
  # `$#` zur Anzahl der Positionsparameter und der sed-Ausdruck bricht ab.
  TMP_ENV="${ENV_FILE}.new"
  sed -e "s#__SESSION_SECRET__#${V_SECRET}#g" \
      -e "s#__ADMIN_PASSWORD__#${V_ADMIN_PW}#g" \
      -e "s#__DEMO_PASSWORD__#${V_DEMO_PW}#g" \
      -e "s#__DEMO_DEVICE_TOKEN__#${V_TOK_DEVICE}#g" \
      -e "s#__DEMO_CAPTURE_TOKEN__#${V_TOK_CAPTURE}#g" \
      -e "s#__INSTALL_DIR__#${INSTALL_DIR}#g" \
      -e "s#__SERVICE__#${SERVICE}#g" \
      -e "s#__DOMAIN__#${ENV_DOMAIN}#g" \
      -e "s#^PORT=3738\$#PORT=${PORT}#" \
      "$TEMPLATE" > "$TMP_ENV"

  # Guard: ein uebersehener Platzhalter wuerde die App mit einem 18-Zeichen-
  # "Secret" oder einem formal ungueltigen Token starten lassen — der Server
  # prueft die SESSION_SECRET-Laenge nicht, das fiele nirgends auf.
  # Nur Wertzeilen pruefen: die Vorlage nennt das Platzhalter-Muster in ihren
  # Kommentaren als Beispiel, und ein echter unersetzter Wert steht immer auf
  # einer `KEY=`-Zeile.
  LEFTOVER="$(grep -vE '^[[:space:]]*#' "$TMP_ENV" | grep -oE '__[A-Z_]+__' | sort -u || true)"
  if [ -n "$LEFTOVER" ]; then
    echo "✗ Unersetzte Platzhalter in der generierten .env:"
    echo "$LEFTOVER" | sed 's/^/    /'
    echo "  Vorlage (.env.demo.example) und Installer sind auseinandergelaufen — Abbruch."
    rm -f "$TMP_ENV"
    exit 1
  fi
  chmod 600 "$TMP_ENV"
  mv -f "$TMP_ENV" "$ENV_FILE"
fi

# Marker: zweiter der beiden Guards, ohne die demo-reset.sh keinen Reset macht.
touch "$INSTALL_DIR/.demo-instance"

chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/deploy/demo-reset.sh"

# ── Optionale Export-Werkzeuge ───────────────────────────────────────────────
# Der Marker ist nicht bloss Dokumentation: deploy/deploy.sh liest ihn und laesst
# die Deploy-Migrations auf einer bewusst schlanken Demo aus, statt bei jedem
# CD-Lauf ~200 MB Werkzeuge nachzuziehen, die hier niemand bestellt hat.
if [ "$WITH_EXPORT_TOOLS" = "1" ]; then
  echo "→ Export-Werkzeuge (veraPDF/Ghostscript/ICC/EPUBCheck)…"
  bash "$INSTALL_DIR/deploy/apply-migrations.sh" "$INSTALL_DIR"
  touch "$INSTALL_DIR/.with-export-tools"
else
  echo "→ Export-Werkzeuge uebersprungen (--with-export-tools aktiviert sie)."
  rm -f "$INSTALL_DIR/.with-export-tools"
fi

# ── systemd ──────────────────────────────────────────────────────────────────
# Unit-Installation liegt in deploy/demo-units.sh, weil deploy/deploy.sh sie bei
# jedem CD-Deploy erneut braucht (Pfade/User/Port koennen sich aendern).
echo "→ systemd-Units…"
# shellcheck source=deploy/demo-units.sh
. "$INSTALL_DIR/deploy/demo-units.sh"
demo_install_units

systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ── Warten bis die App antwortet ─────────────────────────────────────────────
# Der Boot legt Demo-User, Device-Tokens und Beispielbuch an (lib/demo-user.js
# → ensureDemoAccess + seedDemoContent). Erst danach ist ein Golden-Snapshot
# sinnvoll, sonst faellt jeder Reset auf eine leere DB zurueck.
# Probe ist /login: die einzige Pre-Auth-Seite, die den vollen Boot voraussetzt
# (Router gemountet, app_settings lesbar, i18n geladen). Einen /health-Endpunkt
# hat die App nicht.
echo -n "→ Warte auf die App"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/login" 2>/dev/null; then break; fi
  echo -n "."
  sleep 1
done
echo ""

if ! systemctl is-active --quiet "$SERVICE"; then
  echo "✗ Service laeuft nicht:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
fi

# ── App-Settings, die kein ENV-Pendant haben ─────────────────────────────────
# app.public_url lebt in app_settings (Share-Links, Invite-URLs, EPUB-Metadaten),
# das Monatsbudget des Demo-Users in app_users. Beides ueber die bestehenden
# Module setzen statt per SQL — die Validierung bleibt so drin.
#
# Zwingend als $RUN_USER (runuser statt sudo: util-linux ist immer da, sudo in
# einem minimalen Debian-LXC oft nicht). Als root wuerde SQLite die
# -wal/-shm-Dateien root-owned neu anlegen und die App koennte danach nicht mehr
# schreiben.
DEMO_SECRET="$(grep -E '^SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
as_app_user() {
  runuser -u "$RUN_USER" -- env DB_PATH="$INSTALL_DIR/schreibwerkstatt.db" \
    SESSION_SECRET="$DEMO_SECRET" DEMO_EMAIL="$(grep -E '^DEMO_EMAIL=' "$ENV_FILE" | cut -d= -f2-)" \
    DEMO_PASSWORD=x node -e "$1"
}

if [ -n "$DOMAIN" ]; then
  echo "→ app.public_url = https://$DOMAIN"
  as_app_user "require('$INSTALL_DIR/lib/app-settings').set('app.public_url','https://$DOMAIN',{updatedBy:'install-demo'})" \
    || echo "  (fehlgeschlagen — in der Admin-Konsole nachtragen)"
fi

# Kostendeckel: ein Reviewer kann Analysen starten, und die kosten echtes Geld.
# 'hard' bricht ab statt nur zu warnen.
DEMO_BUDGET_USD="${DEMO_BUDGET_USD:-5}"
echo "→ Monatsbudget des Demo-Users: ${DEMO_BUDGET_USD} USD (hard)"
as_app_user "
  const u = require('$INSTALL_DIR/db/app-users');
  const email = require('$INSTALL_DIR/lib/demo-user').demoEmail();
  if (!u.getUser(email)) { console.error('Demo-User fehlt'); process.exit(1); }
  u.setBudget(email, { usd: $DEMO_BUDGET_USD, mode: 'hard' });
" || echo "  (fehlgeschlagen — im Admin-Tab 'Users' nachtragen)"

# ── Golden-Snapshot ──────────────────────────────────────────────────────────
echo "→ Golden-Snapshot anlegen (Ziel jedes naechtlichen Resets)…"
bash "$INSTALL_DIR/deploy/demo-reset.sh" capture "$ENV_FILE"

echo ""
echo "✓ Demo-Instanz laeuft auf http://$(hostname -I | awk '{print $1}'):${PORT}"
print_credentials

cat <<EOF
Naechste Schritte:
  1. Reverse-Proxy auf 127.0.0.1:${PORT} zeigen lassen (deploy/nginx.conf,
     <DOMAIN> ersetzen) — TLS ist Pflicht fuer die nativen Clients.
  2. KI-Provider in der Admin-Konsole setzen (/admin → Settings). Ohne Provider
     sehen Reviewer die Analyse-Features nicht arbeiten; mit teurem Provider
     kostet die Review Geld. Empfehlung: lokales Modell oder guenstiges Tier.
  3. Demo-Inhalt nach Wunsch herrichten, dann den Stand festschreiben:
       bash $INSTALL_DIR/deploy/demo-reset.sh capture
  4. Zustand pruefen:  bash $INSTALL_DIR/deploy/demo-reset.sh status

Befehle:
  systemctl status $SERVICE
  journalctl -u $SERVICE -f
  bash $INSTALL_DIR/deploy/demo-reset.sh {capture|reset|status}
EOF
