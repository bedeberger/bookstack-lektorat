#!/bin/bash
# CD-Deploy – läuft vom GitHub Actions Runner auf dem LXC
# Erster Install: bash install.sh (Prod) bzw. bash install-demo.sh (Demo)
# Updates: wird automatisch von GitHub Actions aufgerufen
#
# Zwei Ziele, ein Skript. SW_FLAVOUR waehlt das Profil:
#   prod (Default)  /opt/schreibwerkstatt,      Backup-Timer, User github-runner
#   demo            /opt/schreibwerkstatt-demo, Reset-Timer,  User swdemo
# Why kein zweites Deploy-Skript: die nicht-offensichtlichen Teile (rsync
# --delete-Begruendung, Lock-Stempel im node_modules-Baum, der explizite
# sw-manifest-Lauf, der schonende chown-Pass) muessten sonst doppelt gepflegt
# werden — und die Demo faellt beim ersten vergessenen Nachzug still aus.
# Werte muessen zur Installation passen; der Workflow setzt sie explizit.

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

FLAVOUR="${SW_FLAVOUR:-prod}"
case "$FLAVOUR" in
  prod)
    INSTALL_DIR="${SW_INSTALL_DIR:-/opt/schreibwerkstatt}"
    SERVICE="${SW_SERVICE:-schreibwerkstatt}"
    OWNER="${SW_OWNER:-github-runner}"
    ;;
  demo)
    INSTALL_DIR="${SW_INSTALL_DIR:-/opt/schreibwerkstatt-demo}"
    SERVICE="${SW_SERVICE:-schreibwerkstatt-demo}"
    OWNER="${SW_OWNER:-swdemo}"
    PORT="${SW_PORT:-3738}"
    RUN_USER="$OWNER"
    ;;
  *)
    echo "✗ SW_FLAVOUR muss 'prod' oder 'demo' sein (ist: '$FLAVOUR')"
    exit 2
    ;;
esac

echo "=== Deploy schreibwerkstatt ($FLAVOUR → $INSTALL_DIR, Service $SERVICE) ==="

if [ ! -d "$INSTALL_DIR" ]; then
  echo "✗ $INSTALL_DIR existiert nicht — Erst-Installation fehlt."
  echo "  Prod: bash deploy/install.sh   Demo: bash deploy/install-demo.sh --domain <host>"
  exit 1
fi

# DB-Backup vor Deploy via dediziertes Backup-Script.
# Skript aus Runner-Checkout nutzen (nicht $INSTALL_DIR/deploy/backup.sh) — rsync
# kommt erst danach, neu hinzugefuegte Skripte liegen sonst noch nicht im Ziel.
# Config (Pfad, Retention) via .env – siehe deploy/backup.sh.
#
# Nur auf Prod. Auf der Demo ist der Golden-Snapshot (deploy/demo-reset.sh) die
# Sicherung, und die Live-Daten sind per Definition wegwerfbar. Ein `capture` an
# dieser Stelle waere sogar schaedlich: es wuerde den Stand festschreiben, den
# der letzte Reviewer hinterlassen hat.
if [ "$FLAVOUR" = "prod" ] && [ -f "$INSTALL_DIR/schreibwerkstatt.db" ]; then
  if ! bash ./deploy/backup.sh "$INSTALL_DIR/.env"; then
    echo "✗ DB-Backup fehlgeschlagen – Deploy abgebrochen"
    exit 1
  fi
fi

# Dateien synchronisieren (.env und node_modules bleiben unangetastet).
# --delete: entfernt aus dem Repo geloeschte Dateien auch auf Prod. Ohne diesen
# Flag bleiben Stale-Module liegen und Node-Resolution kann sie statt der
# neuen Variante laden (z.B. lib/foo.js maskiert lib/foo/index.js).
#
# --chown: setzt die Ziel-Ownership direkt beim Transfer. Ohne das uebernimmt
# rsync (als root) den Owner aus dem Runner-Workspace und der chown-Pass unten
# muesste jede synchronisierte Datei nochmal anfassen.
RSYNC_EXCLUDES=(
  --exclude='.env' --exclude='node_modules' --exclude='.git'
  --exclude='schreibwerkstatt.db' --exclude='schreibwerkstatt.db-wal' --exclude='schreibwerkstatt.db-shm'
  --exclude='schreibwerkstatt.log*' --exclude='backup' --exclude='backups' --exclude='ai_parse_fails'
)

# Demo-Instanz: der Golden-Snapshot und die beiden Marker liegen IM
# Installationsverzeichnis, stehen aber nicht im Repo. Ohne diese Excludes
# raeumt `--delete` sie beim ersten Deploy weg — Snapshot verloren, und
# demo-reset.sh verweigert danach jeden Reset, weil sein Marker-Guard fehlt.
if [ "$FLAVOUR" = "demo" ]; then
  RSYNC_EXCLUDES+=(
    --exclude='demo-golden.db' --exclude='demo-golden.db.new'
    --exclude='.demo-instance' --exclude='.with-export-tools'
  )
fi

rsync -a --delete --chown="$OWNER:$OWNER" "${RSYNC_EXCLUDES[@]}" ./ "$INSTALL_DIR/"

# Ownership auf den App-User setzen — aber nur dort, wo sie abweicht.
# Ein pauschales `chown -R` schreibt sonst bei jedem Deploy ~12k Inodes in
# node_modules neu; auf dem Ceph-RBD-Storage ist das ein Metadaten-Write-Sturm,
# der die parallel laufende Prod-App in den IO-Stall zieht. Der find-Pass liest
# nur Metadaten (page-cached) und schreibt im Normalfall nichts.
find "$INSTALL_DIR" \( ! -user "$OWNER" -o ! -group "$OWNER" \) \
  -exec chown -h "$OWNER:$OWNER" {} +

# Deploy-Migrations: einmalige Scripts unter deploy/migrations/ (z.B. Dateisystem-
# Cleanup, chown-Fixes, sqlite3-Touches). Marker-Datei .deploy-migrations-applied
# in $INSTALL_DIR verhindert Doppellauf. Konvention + Beispiele siehe README.md.
#
# Auf der Demo nur, wenn die Instanz die Export-Werkzeuge ueberhaupt wollte
# (install-demo.sh --with-export-tools setzt den Marker). Die vorhandenen
# Migrations installieren veraPDF/Ghostscript/EPUBCheck, ~200 MB inkl. JRE — das
# soll kein CD-Deploy hinter dem Ruecken einer bewusst schlanken Demo nachziehen.
if [ "$FLAVOUR" = "prod" ] || [ -f "$INSTALL_DIR/.with-export-tools" ]; then
  bash "$INSTALL_DIR/deploy/apply-migrations.sh" "$INSTALL_DIR"
else
  echo "→ Deploy-Migrations uebersprungen (Demo ohne --with-export-tools)"
fi

# Abhängigkeiten aktualisieren — nur wenn sich das Lockfile geaendert hat.
# `npm install` stat't sonst bei jedem Deploy den kompletten node_modules-Baum,
# um dann nichts zu tun. Der Stempel liegt IM Baum: verschwindet node_modules,
# verschwindet er mit und die Installation laeuft wieder an.
cd "$INSTALL_DIR"
LOCK_STAMP="node_modules/.deployed-lock-sha"
LOCK_WANT=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat "$LOCK_STAMP" 2>/dev/null)" = "$LOCK_WANT" ]; then
  echo "→ Dependencies unveraendert (${LOCK_WANT:0:12}) – npm install uebersprungen"
else
  npm install --omit=dev --quiet
  echo "$LOCK_WANT" > "$LOCK_STAMP"
  # npm laeuft als root — Ownership hier nachziehen, solange der Baum warm ist.
  # Der find-Pass oben laeuft vorher und sieht diese Dateien nicht mehr.
  chown -R "$OWNER:$OWNER" node_modules
fi

# Service-Unit startet via `node server.js` (nicht `npm start`) → das prestart-Hook
# läuft auf Prod nie. Darum den Shell-Cache-Hash hier explizit aus dem deployten
# Asset-Stand regenerieren. Idempotent: rsync lieferte exakt die CI-getesteten
# Files, der Hash ist also identisch zum committeten Manifest.
node scripts/sw-manifest.js
# sw-manifest.js laeuft als root und schreibt public/sw-manifest.js neu, also
# NACH dem find-Pass oben. Ohne diese Zeile ist genau eine Datei im Baum
# root-owned, bis der naechste Deploy sie einsammelt — die Invariante "nach dem
# Deploy gehoert alles unter $INSTALL_DIR dem App-User" gilt sonst erst verzoegert.
chown "$OWNER:$OWNER" public/sw-manifest.js

if [ "$FLAVOUR" = "demo" ]; then
  # Units immer neu schreiben (Pfade/User/Port koennen sich aendern) — inkl.
  # Reset-Timer, der auf der Demo an die Stelle des Backup-Timers tritt.
  # shellcheck source=deploy/demo-units.sh
  . "$INSTALL_DIR/deploy/demo-units.sh"
  demo_install_units
else
  # Service-Unit immer aktualisieren (User, Pfade etc. können sich ändern)
  if [ -f "$INSTALL_DIR/deploy/schreibwerkstatt.service" ]; then
    cp "$INSTALL_DIR/deploy/schreibwerkstatt.service" /etc/systemd/system/
    systemctl daemon-reload
  fi

  # Backup-Service + Timer installieren / aktualisieren
  if [ -f "$INSTALL_DIR/deploy/schreibwerkstatt-backup.service" ]; then
    cp "$INSTALL_DIR/deploy/schreibwerkstatt-backup.service" /etc/systemd/system/
    cp "$INSTALL_DIR/deploy/schreibwerkstatt-backup.timer"   /etc/systemd/system/
    chmod +x "$INSTALL_DIR/deploy/backup.sh"
    systemctl daemon-reload
    systemctl enable --now schreibwerkstatt-backup.timer >/dev/null
  fi
fi

# Service starten oder neu starten
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
  systemctl restart "$SERVICE"
else
  systemctl enable "$SERVICE"
  systemctl start "$SERVICE"
fi

sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ $(date '+%Y-%m-%d %H:%M:%S') – deployed & running"
else
  echo "✗ Service konnte nicht gestartet werden:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi
