#!/bin/bash
# Demo-Instanz: Golden-Snapshot verwalten und die Instanz darauf zuruecksetzen.
#
# Warum ueberhaupt: die Demo-Instanz ist der Zugang, den Apple/Google/Chrome
# Reviewer benutzen. Ohne Reset sieht Reviewer Nr. 2 die Textreste von Nr. 1 —
# und im schlimmsten Fall ein leeres Buch, weil Nr. 1 alles geloescht hat.
#
# Modi:
#   capture   Aktuellen Stand als Golden-Snapshot festschreiben (online-sicher
#             via `sqlite3 .backup`, Service darf laufen). Das ist der Stand,
#             auf den jeder Reset zurueckfaellt — nach dem Einrichten einmal
#             aufrufen, und danach immer, wenn der Demo-Inhalt bewusst
#             verbessert wurde.
#   reset     Service stoppen, Golden-Snapshot ueber die Live-DB legen, Service
#             starten. DESTRUKTIV fuer alles, was seit dem Capture entstand.
#   status    Zeigt Golden-Snapshot (Alter/Groesse) + Service-Zustand.
#
# Aufruf:
#   bash demo-reset.sh capture [/pfad/zur/.env]
#   bash demo-reset.sh reset   [/pfad/zur/.env]
#   bash demo-reset.sh status  [/pfad/zur/.env]
#
# Konfiguration via .env der Demo-Instanz (Defaults in Klammern):
#   DEMO_DB_FILE      Live-DB          (/opt/schreibwerkstatt-demo/schreibwerkstatt.db)
#   DEMO_GOLDEN_DB    Snapshot-Datei   (/opt/schreibwerkstatt-demo/demo-golden.db)
#   DEMO_SERVICE      systemd-Unit     (schreibwerkstatt-demo)
#
# SCHUTZ GEGEN PROD: der Modus `reset` verlangt BEIDES — die Marker-Datei
# `.demo-instance` neben der Live-DB und ein gesetztes DEMO_EMAIL in der .env.
# Ein versehentlicher Aufruf gegen /opt/schreibwerkstatt bricht dadurch ab,
# statt die Produktionsdatenbank zu ueberschreiben.

set -e
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

MODE="${1:-}"
ENV_FILE="${2:-/opt/schreibwerkstatt-demo/.env}"

case "$MODE" in
  capture|reset|status) ;;
  *)
    echo "Usage: bash demo-reset.sh {capture|reset|status} [/pfad/zur/.env]"
    exit 2
    ;;
esac

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "✗ .env nicht gefunden: $ENV_FILE"
  exit 1
fi

DEMO_DB_FILE="${DEMO_DB_FILE:-${DB_PATH:-/opt/schreibwerkstatt-demo/schreibwerkstatt.db}}"
DEMO_GOLDEN_DB="${DEMO_GOLDEN_DB:-$(dirname "$DEMO_DB_FILE")/demo-golden.db}"
DEMO_SERVICE="${DEMO_SERVICE:-schreibwerkstatt-demo}"
MARKER="$(dirname "$DEMO_DB_FILE")/.demo-instance"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "✗ sqlite3-CLI fehlt (apt-get install -y sqlite3)"
  exit 1
fi

# Doppelter Guard. Beide Bedingungen muessen zutreffen — der Marker allein
# koennte in ein Prod-Verzeichnis kopiert worden sein, DEMO_EMAIL allein steht
# auch in der .env eines Entwicklungsrechners.
_assert_demo_instance() {
  if [ ! -f "$MARKER" ]; then
    echo "✗ Marker-Datei fehlt: $MARKER"
    echo "  Das sieht nicht nach einer Demo-Instanz aus — Abbruch (kein Reset)."
    exit 1
  fi
  if [ -z "${DEMO_EMAIL:-}" ]; then
    echo "✗ DEMO_EMAIL ist in $ENV_FILE nicht gesetzt."
    echo "  Ohne aktiven Demo-Zugang ist das keine Demo-Instanz — Abbruch (kein Reset)."
    exit 1
  fi
}

case "$MODE" in

  capture)
    _assert_demo_instance
    if [ ! -f "$DEMO_DB_FILE" ]; then
      echo "✗ Live-DB nicht gefunden: $DEMO_DB_FILE"
      exit 1
    fi
    TMP="${DEMO_GOLDEN_DB}.new"
    rm -f "$TMP"
    # `.backup` statt cp: lock-frei und WAL-konsistent, der Service darf laufen.
    if ! sqlite3 "$DEMO_DB_FILE" ".backup '$TMP'"; then
      echo "✗ Snapshot fehlgeschlagen"
      rm -f "$TMP"
      exit 1
    fi
    # Atomar einschwenken, damit ein gleichzeitig laufender Reset nie eine halb
    # geschriebene Golden-Datei sieht.
    mv -f "$TMP" "$DEMO_GOLDEN_DB"
    chown --reference="$DEMO_DB_FILE" "$DEMO_GOLDEN_DB" 2>/dev/null || true
    echo "✓ Golden-Snapshot geschrieben: $DEMO_GOLDEN_DB ($(du -h "$DEMO_GOLDEN_DB" | cut -f1))"
    ;;

  reset)
    _assert_demo_instance
    if [ ! -f "$DEMO_GOLDEN_DB" ]; then
      echo "✗ Kein Golden-Snapshot vorhanden: $DEMO_GOLDEN_DB"
      echo "  Erst 'bash demo-reset.sh capture' aufrufen — ohne Snapshot gibt es kein Ziel."
      exit 1
    fi
    echo "→ Stoppe $DEMO_SERVICE…"
    systemctl stop "$DEMO_SERVICE"
    # WAL/SHM muessen mit: bleiben sie liegen, mischt SQLite die alten
    # Transaktionen ueber die frisch eingesetzte DB und der Reset ist teilweise
    # wieder aufgehoben.
    rm -f "${DEMO_DB_FILE}-wal" "${DEMO_DB_FILE}-shm"
    cp -f "$DEMO_GOLDEN_DB" "$DEMO_DB_FILE"
    chown --reference="$(dirname "$DEMO_DB_FILE")" "$DEMO_DB_FILE" 2>/dev/null || true
    echo "→ Starte $DEMO_SERVICE…"
    systemctl start "$DEMO_SERVICE"
    sleep 2
    if systemctl is-active --quiet "$DEMO_SERVICE"; then
      echo "✓ $(date '+%Y-%m-%d %H:%M:%S') – Demo-Instanz auf Golden-Snapshot zurueckgesetzt"
    else
      echo "✗ Service laeuft nach dem Reset nicht:"
      journalctl -u "$DEMO_SERVICE" -n 20 --no-pager
      exit 1
    fi
    ;;

  status)
    echo "Live-DB      : $DEMO_DB_FILE $( [ -f "$DEMO_DB_FILE" ] && echo "($(du -h "$DEMO_DB_FILE" | cut -f1))" || echo '(fehlt)')"
    if [ -f "$DEMO_GOLDEN_DB" ]; then
      echo "Golden       : $DEMO_GOLDEN_DB ($(du -h "$DEMO_GOLDEN_DB" | cut -f1), $(date -r "$DEMO_GOLDEN_DB" '+%Y-%m-%d %H:%M'))"
    else
      echo "Golden       : fehlt — 'bash demo-reset.sh capture' noch nicht gelaufen"
    fi
    echo "Marker       : $( [ -f "$MARKER" ] && echo "$MARKER" || echo 'FEHLT (reset wuerde abbrechen)')"
    echo "DEMO_EMAIL   : ${DEMO_EMAIL:-<nicht gesetzt>}"
    echo "Service      : $DEMO_SERVICE — $(systemctl is-active "$DEMO_SERVICE" 2>/dev/null || echo inaktiv)"
    echo "Reset-Timer  : $(systemctl is-active "${DEMO_SERVICE}-reset.timer" 2>/dev/null || echo inaktiv)"
    systemctl list-timers "${DEMO_SERVICE}-reset.timer" --no-pager 2>/dev/null | sed -n '2p' || true
    ;;

esac
