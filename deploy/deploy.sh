#!/bin/bash
# CD-Deploy – läuft vom GitHub Actions Runner auf dem LXC
# Erster Install: bash install.sh
# Updates: wird automatisch von GitHub Actions aufgerufen

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

INSTALL_DIR="/opt/schreibwerkstatt"
SERVICE="schreibwerkstatt"

echo "=== Deploy schreibwerkstatt ==="

# DB-Backup vor Deploy via dediziertes Backup-Script.
# Skript aus Runner-Checkout nutzen (nicht $INSTALL_DIR/deploy/backup.sh) — rsync
# kommt erst danach, neu hinzugefuegte Skripte liegen sonst noch nicht im Ziel.
# Config (Pfad, Retention) via .env – siehe deploy/backup.sh.
if [ -f "$INSTALL_DIR/schreibwerkstatt.db" ]; then
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
rsync -a --delete --chown=github-runner:github-runner \
  --exclude='.env' --exclude='node_modules' --exclude='.git' \
  --exclude='schreibwerkstatt.db' --exclude='schreibwerkstatt.db-wal' --exclude='schreibwerkstatt.db-shm' \
  --exclude='schreibwerkstatt.log*' --exclude='backup' --exclude='backups' --exclude='ai_parse_fails' \
  ./ "$INSTALL_DIR/"

# Ownership auf github-runner setzen — aber nur dort, wo sie abweicht.
# Ein pauschales `chown -R` schreibt sonst bei jedem Deploy ~12k Inodes in
# node_modules neu; auf dem Ceph-RBD-Storage ist das ein Metadaten-Write-Sturm,
# der die parallel laufende Prod-App in den IO-Stall zieht. Der find-Pass liest
# nur Metadaten (page-cached) und schreibt im Normalfall nichts.
find "$INSTALL_DIR" \( ! -user github-runner -o ! -group github-runner \) \
  -exec chown -h github-runner:github-runner {} +

# Deploy-Migrations: einmalige Scripts unter deploy/migrations/ (z.B. Dateisystem-
# Cleanup, chown-Fixes, sqlite3-Touches). Marker-Datei .deploy-migrations-applied
# in $INSTALL_DIR verhindert Doppellauf. Konvention + Beispiele siehe README.md.
bash "$INSTALL_DIR/deploy/apply-migrations.sh" "$INSTALL_DIR"

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
  chown -R github-runner:github-runner node_modules
fi

# Service-Unit startet via `node server.js` (nicht `npm start`) → das prestart-Hook
# läuft auf Prod nie. Darum den Shell-Cache-Hash hier explizit aus dem deployten
# Asset-Stand regenerieren. Idempotent: rsync lieferte exakt die CI-getesteten
# Files, der Hash ist also identisch zum committeten Manifest.
node scripts/sw-manifest.js

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
