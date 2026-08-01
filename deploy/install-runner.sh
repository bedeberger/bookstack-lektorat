#!/bin/bash
# Schreibwerkstatt – GitHub-Actions-Runner auf einem LXC einrichten
#
# Registriert einen self-hosted Runner fuer dieses Repo und installiert ihn als
# systemd-Service. Gedacht fuer die Demo-LXC (Label `demo`), taugt aber fuer
# jedes weitere Ziel — das Label entscheidet, welche Jobs dort landen.
#
# Usage (im Container, als root):
#   bash deploy/install-runner.sh --token <REGISTRATION_TOKEN>
#   bash deploy/install-runner.sh --token <T> --label demo --name schreibwerkstatt-demo
#   bash deploy/install-runner.sh --status          # nur Zustand zeigen
#   bash deploy/install-runner.sh --uninstall       # Service + Registrierung entfernen
#
# Registration-Token holen (gilt EINE STUNDE, danach neu erzeugen):
#   gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token
# oder GitHub → Settings → Actions → Runners → "New self-hosted runner".
# Das Token ist ein Einweg-Registrierungsschluessel, kein Zugriffstoken — es
# gehoert trotzdem nicht ins Repo und wird darum nur als Argument gereicht.
#
# Optionen:
#   --token <t>     Registration-Token (Pflicht ausser bei --status/--uninstall)
#   --label <l>     Zusatz-Label, ueber das der Workflow den Runner adressiert
#                   (Default: demo). `self-hosted`, `Linux` und `X64` vergibt
#                   GitHub automatisch — hier NICHT mit angeben.
#   --name <n>      Runner-Name in der GitHub-Oberflaeche (Default: Hostname)
#   --repo <url>    Repo-URL (Default: das origin dieses Checkouts)
#   --version <v>   Runner-Version, z.B. v2.336.0 (Default: neuestes Release)
#   --force         Bereits konfigurierten Runner neu registrieren
#
# LAEUFT ALS ROOT — bewusst: deploy/deploy.sh ruft systemctl, schreibt nach
# /etc/systemd/system und chownt auf den App-User, alles ohne sudo. Die LXC ist
# hier die Isolationsgrenze, nicht der Unix-User. Wer das enger will, legt einen
# eigenen Runner-User an und stellt den Workflow-Step auf `sudo bash
# deploy/deploy.sh` um (plus passende sudoers-Regel).

set -e

RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"
LABEL="demo"
RUNNER_NAME="$(hostname)"
REPO_URL=""
VERSION=""
TOKEN=""
FORCE=0
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --token)     TOKEN="$2"; shift 2 ;;
    --label)     LABEL="$2"; shift 2 ;;
    --name)      RUNNER_NAME="$2"; shift 2 ;;
    --repo)      REPO_URL="$2"; shift 2 ;;
    --version)   VERSION="$2"; shift 2 ;;
    --force)     FORCE=1; shift ;;
    --status)    MODE="status"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help)   sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (--help zeigt die Nutzung)"; exit 2 ;;
  esac
done

# Unit-Name kennt nur der Runner selbst (er setzt ihn aus Owner, Repo und
# Runner-Name zusammen). svc.sh legt ihn nach der Installation in .service ab —
# das ist die einzige verlaessliche Quelle, jede Nachbildung waere geraten.
_unit_name() {
  [ -f "$RUNNER_DIR/.service" ] && cat "$RUNNER_DIR/.service" || echo ""
}

# ── Status ───────────────────────────────────────────────────────────────────
if [ "$MODE" = "status" ]; then
  UNIT="$(_unit_name)"
  echo "Runner-Dir   : $RUNNER_DIR $( [ -d "$RUNNER_DIR" ] && echo '(vorhanden)' || echo '(fehlt)')"
  echo "Konfiguriert : $( [ -f "$RUNNER_DIR/.runner" ] && echo 'ja' || echo 'nein')"
  if [ -f "$RUNNER_DIR/.runner" ]; then
    echo "Registrierung: $(grep -oE '"(gitHubUrl|agentName)": *"[^"]*"' "$RUNNER_DIR/.runner" | tr '\n' ' ')"
  fi
  echo "Unit         : ${UNIT:-<nicht installiert>}"
  [ -n "$UNIT" ] && echo "Service      : $(systemctl is-active "$UNIT" 2>/dev/null || echo inaktiv)"
  exit 0
fi

# Usage-Fehler vor Umgebungs-Fehler: wer das Token vergisst, soll das lesen und
# nicht erst "bitte als root" — sonst sucht man am falschen Ende.
if [ "$MODE" = "install" ] && [ -z "$TOKEN" ]; then
  echo "✗ --token fehlt. Holen mit:"
  echo "    gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token"
  echo "  (gilt eine Stunde; alternativ GitHub → Settings → Actions → Runners)"
  exit 2
fi

if [ "$(id -u)" != "0" ]; then
  echo "✗ Bitte als root ausfuehren (systemd-Service, /opt, Paketinstallation)."
  exit 1
fi

# ── Deinstallation ───────────────────────────────────────────────────────────
if [ "$MODE" = "uninstall" ]; then
  if [ ! -d "$RUNNER_DIR" ]; then
    echo "✗ $RUNNER_DIR existiert nicht — nichts zu tun."
    exit 1
  fi
  cd "$RUNNER_DIR"
  export RUNNER_ALLOW_RUNASROOT=1
  [ -f .service ] && { ./svc.sh stop || true; ./svc.sh uninstall || true; }
  if [ -f .runner ]; then
    # Ohne Token nur lokal abmelden; der Eintrag in GitHub bleibt dann als
    # "offline" stehen und muss dort von Hand entfernt werden.
    if [ -n "$TOKEN" ]; then
      ./config.sh remove --token "$TOKEN"
    else
      echo "→ Kein --token: lokale Konfiguration wird entfernt, der Eintrag in"
      echo "  GitHub bleibt als 'offline' stehen (dort manuell loeschen)."
      rm -f .runner .credentials .credentials_rsaparams
    fi
  fi
  echo "✓ Runner entfernt (Verzeichnis $RUNNER_DIR bleibt liegen)"
  exit 0
fi

# ── Installation ─────────────────────────────────────────────────────────────
# Repo-URL aus dem Checkout ableiten, damit man sie nicht doppelt pflegt.
if [ -z "$REPO_URL" ]; then
  REPO_URL="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || true)"
  REPO_URL="${REPO_URL%.git}"
fi
if [ -z "$REPO_URL" ]; then
  echo "✗ Repo-URL unbekannt — ausserhalb eines Checkouts bitte --repo setzen."
  exit 2
fi

case "$(uname -m)" in
  x86_64)  ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "✗ Nicht unterstuetzte Architektur: $(uname -m)"; exit 1 ;;
esac

echo ""
echo "=== GitHub-Actions-Runner einrichten ==="
echo "    Repo : $REPO_URL"
echo "    Name : $RUNNER_NAME     Label: $LABEL     Arch: $ARCH"
echo "    Dir  : $RUNNER_DIR"
echo ""

echo "→ Systempakete…"
apt-get update -qq
# rsync + git braucht deploy.sh bzw. actions/checkout; curl/tar den Download.
apt-get install -y -qq curl ca-certificates tar git rsync >/dev/null

# node ist keine Runner-Abhaengigkeit, aber deploy.sh ruft `npm install` und
# `node scripts/sw-manifest.js`. Auf der Demo-LXC hat install-demo.sh es schon
# gesetzt — der Hinweis faengt die Reihenfolge "Runner zuerst" ab.
command -v node >/dev/null || echo "  ! node fehlt — deploy.sh braucht es (deploy/install-demo.sh installiert es)."

if [ -z "$VERSION" ]; then
  echo "→ Neueste Runner-Version ermitteln…"
  VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
             | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)"
  if [ -z "$VERSION" ]; then
    echo "✗ Version nicht ermittelbar (API-Rate-Limit?) — bitte --version vXX.Y.Z setzen."
    exit 1
  fi
fi
VER="${VERSION#v}"
echo "  Version: $VERSION"

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# Erneuter Lauf mit gleicher Version laedt nicht nochmal 200 MB. Der Stempel
# haengt am entpackten Baum: faellt der weg, faellt er mit.
STAMP="$RUNNER_DIR/.installed-version"
if [ -x ./config.sh ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$VERSION" ]; then
  echo "→ Runner-Binaries $VERSION bereits vorhanden — Download uebersprungen."
else
  TARBALL="actions-runner-linux-${ARCH}-${VER}.tar.gz"
  echo "→ Lade $TARBALL…"
  curl -fsSL -o "$TARBALL" \
    "https://github.com/actions/runner/releases/download/${VERSION}/${TARBALL}"
  tar xzf "$TARBALL"
  rm -f "$TARBALL"
  echo "$VERSION" > "$STAMP"
fi

# .NET-Abhaengigkeiten (libicu u.a.). Auf einem minimalen Debian-LXC fehlen sie,
# und der Runner stirbt sonst beim Start mit einem Globalization-Fehler, dessen
# Meldung nicht nach "fehlendes Paket" aussieht.
echo "→ Abhaengigkeiten des Runners…"
./bin/installdependencies.sh >/dev/null

# config.sh und run.sh verweigern den Dienst als root, solange man es nicht
# ausdruecklich erlaubt.
export RUNNER_ALLOW_RUNASROOT=1

if [ -f .runner ] && [ "$FORCE" != "1" ]; then
  echo "→ Runner ist bereits konfiguriert — Registrierung uebersprungen (--force erzwingt neu)."
else
  echo "→ Registriere bei $REPO_URL…"
  # --replace: ein Runner gleichen Namens (z.B. aus einem frueheren Lauf) wird
  # ersetzt statt mit einem Namenskonflikt abzulehnen.
  # --labels: NUR das Zusatz-Label. `self-hosted`/`Linux`/`X64` setzt GitHub
  # selbst; sie hier zu wiederholen erzeugt keine Fehler, aber Rauschen.
  ./config.sh \
    --url "$REPO_URL" \
    --token "$TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABEL" \
    --unattended --replace
fi

echo "→ systemd-Service…"
if [ -f .service ]; then
  ./svc.sh stop >/dev/null 2>&1 || true
  ./svc.sh uninstall >/dev/null 2>&1 || true
fi
./svc.sh install

UNIT="$(_unit_name)"
if [ -z "$UNIT" ]; then
  echo "✗ svc.sh hat keinen Unit-Namen hinterlassen (.service fehlt)."
  exit 1
fi

# Drop-in statt Template-Patch: svc.sh generiert die Unit bei jeder
# Neuinstallation neu, eine direkte Aenderung waere beim naechsten Lauf weg.
# Ohne die Variable bricht runsvc.sh als root ab — genau der Fall hier.
mkdir -p "/etc/systemd/system/${UNIT}.d"
cat > "/etc/systemd/system/${UNIT}.d/runasroot.conf" <<EOF
[Service]
Environment=RUNNER_ALLOW_RUNASROOT=1
EOF
systemctl daemon-reload

./svc.sh start
sleep 2

if systemctl is-active --quiet "$UNIT"; then
  echo ""
  echo "✓ Runner laeuft — Unit: $UNIT"
else
  echo "✗ Runner-Service laeuft nicht:"
  journalctl -u "$UNIT" -n 30 --no-pager
  exit 1
fi

cat <<EOF

Pruefen:
  bash $0 --status
  journalctl -u $UNIT -f
  # von aussen:
  gh api repos/\${OWNER}/\${REPO}/actions/runners --jq '.runners[] | {name, status, labels: [.labels[].name]}'

Der naechste Push auf main faehrt den Job, dessen \`runs-on\` das Label
\`$LABEL\` enthaelt — fuer die Demo ist das \`deploy-demo\`
(.github/workflows/deploy.yml).
EOF
