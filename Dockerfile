# Ideenraum – läuft auf x86 (amd64) und ARM (Raspberry Pi: arm64, arm/v7).
# Es gibt keine npm-Abhängigkeiten, also auch keinen Build-Schritt und keine
# nativen Module, die pro Prozessor-Architektur kompiliert werden müssten.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# Läuft nicht als root. /data gehört dem Benutzer "node" (UID 1000).
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8090
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/api/health || exit 1

CMD ["node", "server/index.js"]
