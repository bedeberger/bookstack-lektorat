FROM node:20-alpine

# Build-Dependencies für better-sqlite3 (falls kein Prebuilt-Binary passt)
RUN apk add --no-cache python3 make g++

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
