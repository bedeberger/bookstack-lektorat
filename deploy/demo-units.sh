#!/bin/bash
# Schreibt die drei systemd-Units der Demo-Instanz nach /etc/systemd/system und
# passt Unit-Namen, Pfade, User und Port an die tatsaechliche Installation an.
#
# Wird von ZWEI Aufrufern gesourced und ist damit deren SSoT:
#   • deploy/install-demo.sh  — Erst-Installation
#   • deploy/deploy.sh        — jeder CD-Deploy (SW_FLAVOUR=demo)
# Why: sonst leben zwei sed-Bloecke mit derselben Ersetzungsreihenfolge
# nebeneinander, und ein spaeter ergaenzter Platzhalter fehlt garantiert in
# einem von beiden.
#
# Erwartet im Environment: INSTALL_DIR, SERVICE, PORT, RUN_USER.
# Legt zusaetzlich den Reset-Timer an und aktiviert ihn (idempotent) — beide
# Aufrufer wollen genau das.

demo_install_units() {
  # Reihenfolge ist wesentlich: die Unit-Namen zuerst (anhand des `.service`-
  # Suffix, damit das Muster keine Pfade trifft), der Pfad DANACH. Umgekehrt
  # wuerde bei ueberschriebenem SERVICE und Default-INSTALL_DIR das
  # `schreibwerkstatt-demo` IM Pfad mitersetzt und die WorkingDirectory-Zeile
  # zeigte ins Leere.
  _install_unit() { # $1 = Quelldatei unter deploy/, $2 = Zielname
    sed -e "s#schreibwerkstatt-demo-reset\.service#${SERVICE}-reset.service#g" \
        -e "s#schreibwerkstatt-demo\.service#${SERVICE}.service#g" \
        -e "s#/opt/schreibwerkstatt-demo#$INSTALL_DIR#g" \
        -e "s#^User=swdemo\$#User=$RUN_USER#" \
        -e "s#^Environment=PORT=3738\$#Environment=PORT=$PORT#" \
        "$INSTALL_DIR/deploy/$1" > "/etc/systemd/system/$2"
  }

  _install_unit schreibwerkstatt-demo.service       "${SERVICE}.service"
  _install_unit schreibwerkstatt-demo-reset.service "${SERVICE}-reset.service"
  _install_unit schreibwerkstatt-demo-reset.timer   "${SERVICE}-reset.timer"

  chmod +x "$INSTALL_DIR/deploy/demo-reset.sh"
  systemctl daemon-reload
  systemctl enable --now "${SERVICE}-reset.timer" >/dev/null
}
