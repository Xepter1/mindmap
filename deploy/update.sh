#!/bin/sh
# Ideenraum auf dem Server aktualisieren.
# Holt den neuesten Stand aus Git und baut den Container neu.
# Deine Daten in ./data werden dabei nicht angefasst.
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
echo "Fertig. Läuft jetzt: $(docker exec ideenraum wget -qO- http://127.0.0.1:8090/api/health)"
