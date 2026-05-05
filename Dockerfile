FROM node:20-alpine

# Build-Dependencies für better-sqlite3 (falls kein Prebuilt-Binary passt)
# + libvips/sharp-Runtime + optional veraPDF-CLI für PDF/A-Validierung.
# - vips-dev: Build-Time-Headers für sharp (Prebuilts decken die meisten Plattformen ab)
# - openjdk17-jre-headless + curl: veraPDF braucht JRE; CLI wird im Image entpackt
RUN apk add --no-cache python3 make g++ vips-dev openjdk17-jre-headless curl unzip

# Optional: veraPDF-CLI installieren. PDF/A-Validierung läuft sonst im
# „skip"-Modus und liefert das PDF mit Warnung statt Fehler. Für Production
# empfohlen.
RUN set -e; \
    VERAPDF_VERSION=1.26.2; \
    curl -sSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o /tmp/verapdf.zip && \
    mkdir -p /opt/verapdf && unzip -q /tmp/verapdf.zip -d /opt/verapdf && \
    cd /opt/verapdf/verapdf-greenfield-${VERAPDF_VERSION} && \
    java -cp installer-${VERAPDF_VERSION}.jar org.verapdf.apps.Installer -options auto-install-options.xml && \
    rm /tmp/verapdf.zip || true

ENV PATH="/opt/verapdf-installation:${PATH}"
# Falls veraPDF-Install fehlschlägt, lib/pdfa-validate.js skippt automatisch.

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Datenbankverzeichnis als Volume-Einhängepunkt
VOLUME ["/app/data"]

# Datenbank in /app/data ablegen (via Umgebungsvariable, die db/schema.js liest)
ENV DB_PATH=/app/data/lektorat.db
ENV PORT=3737

EXPOSE 3737

CMD ["node", "server.js"]
