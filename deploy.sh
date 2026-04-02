#!/bin/bash
# CD-Deploy – läuft vom GitHub Actions Runner auf dem LXC
# Erster Install: bash install.sh
# Updates: wird automatisch von GitHub Actions aufgerufen

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

INSTALL_DIR="/opt/lektorat"
SERVICE="lektorat"

echo "=== Deploy lektorat ==="

# Dateien synchronisieren (.env und node_modules bleiben unangetastet)
rsync -a --exclude='.env' --exclude='node_modules' --exclude='.git' \
  ./ "$INSTALL_DIR/"

# Ownership auf github-runner setzen
chown -R github-runner:github-runner "$INSTALL_DIR"

# Abhängigkeiten aktualisieren
cd "$INSTALL_DIR"
npm install --omit=dev --quiet

# Service starten oder neu starten
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
  systemctl restart "$SERVICE"
else
  # Service noch nicht registriert – Unit-Datei installieren und starten
  if [ -f "$INSTALL_DIR/lektorat.service" ]; then
    cp "$INSTALL_DIR/lektorat.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable "$SERVICE"
  fi
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
