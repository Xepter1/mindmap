# Ideenraum

Mindmaps und Whiteboards im Browser, gehostet auf deinem eigenen Server (Raspberry Pi oder jeder andere Rechner).

- Mindmaps per Tastatur: `Tab` für ein Unterthema, `Enter` für ein Thema auf derselben Ebene, Pfeiltasten zum Navigieren
- Haftnotizen, Text, Formen, Pfeile mit Beschriftung, Stift
- Mehrere Boards, Export als PNG oder JSON, komplette Sicherung mit einem Klick
- Mehrere Geräte gleichzeitig: Änderungen erscheinen sofort überall (Laptop, Tablet, Handy)
- Läuft auf x86 und ARM, ohne Datenbank und ohne npm-Abhängigkeiten

## Installation auf dem Raspberry Pi (oder jedem Server mit Docker)

Voraussetzung: Docker mit Compose-Plugin (`curl -fsSL https://get.docker.com | sh`).

```bash
git clone https://github.com/DEIN-GITHUB-NAME/ideenraum.git
cd ideenraum
mkdir -p data
docker compose up -d --build
```

Danach im Browser öffnen: `http://<IP-des-Servers>:8090` (oft auch `http://raspberrypi.local:8090`).

Der Container läuft als Benutzer mit der UID 1000. Auf dem Pi ist das normalerweise dein eigener Benutzer. Meldet der Start „Kein Schreibzugriff“, einmal `sudo chown -R 1000:1000 data` ausführen.

## Updates

```bash
./deploy/update.sh
```

Das holt den neuesten Stand per `git pull` und baut den Container neu. Deine Boards liegen im Ordner `data/` außerhalb des Containers und bleiben dabei erhalten.

## Wie deine Daten Updates überleben

- **Getrennt vom Programm:** Alles liegt in `data/`, eine JSON-Datei pro Board. Das Programm kann beliebig oft ersetzt werden.
- **Datenformat mit Versionsnummer:** Jedes Board trägt ein `format`. Ändert eine neue Version die Struktur, wandelt sie alte Boards beim Start automatisch um (Migration). Vorher legt sie eine Sicherung in `data/backups/…_vor-migration-…` an.
- **Kein Datenverlust durch Downgrade:** Stammen die Daten von einer neueren Version, startet eine ältere Version gar nicht erst und sagt dir das.
- **Unbekanntes bleibt erhalten:** Felder und Elementtypen, die eine Version nicht kennt, werden unverändert mitgespeichert.
- **Sicheres Schreiben:** Dateien werden erst vollständig geschrieben und dann ausgetauscht. Ein Stromausfall hinterlässt keine halbe Datei.

Für Entwickler: Wie eine Migration angelegt wird, steht oben in `public/shared/model.js`.

## Sicherungen

| Was | Wo | Wie lange |
| --- | --- | --- |
| Tägliche Sicherung (nur wenn sich etwas geändert hat) | `data/backups/<Zeitpunkt>_taeglich/` | 14 Tage (`BACKUP_KEEP_DAYS`) |
| Sicherung vor jeder Datenmigration | `data/backups/<Zeitpunkt>_vor-migration-…/` | die letzten 10 |
| Gelöschte Boards | `data/trash/` | 30 Tage (`TRASH_KEEP_DAYS`) |
| Komplette Sicherung als eine Datei | in der App: Export → „Komplette Sicherung herunterladen“ | so lange du willst |

Für eine Sicherung außerhalb des Pi reicht es, den Ordner `data/` zu kopieren, zum Beispiel jede Nacht per Cron auf ein NAS:

```bash
0 3 * * * rsync -a --delete /home/pi/ideenraum/data/ /mnt/nas/ideenraum-data/
```

**Wiederherstellen:** Container stoppen (`docker compose down`), die gewünschten Board-Dateien aus `data/backups/…` oder `data/trash/` nach `data/boards/` kopieren (bei Dateien aus dem Papierkorb den Zeitstempel vor `__` aus dem Namen entfernen), Container starten. Eine komplette Sicherungsdatei lässt sich in der App über Export → „Sicherung oder Board importieren“ einspielen.

## Umzug auf einen anderen Server

Repository auf dem neuen Server klonen, den Ordner `data/` vom alten Server mitnehmen, `docker compose up -d --build`. Ob der neue Rechner x86 oder ARM ist, spielt keine Rolle: Das Image wird für die jeweilige Architektur gebaut.

## Einstellungen

Als Umgebungsvariablen in `compose.yaml`:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8090` | Port im Container |
| `DATA_DIR` | `/data` | Datenordner |
| `IDEENRAUM_PASSWORD` | leer | Passwortschutz an, wenn gesetzt |
| `COOKIE_SECURE` | `false` | `true`, wenn die App nur über HTTPS erreichbar ist |
| `BACKUP_KEEP_DAYS` | `14` | Anzahl täglicher Sicherungen |
| `TRASH_KEEP_DAYS` | `30` | Tage im Papierkorb |

**Passwortschutz:** Ohne Passwort kann jeder in deinem Netz die Boards öffnen. Sobald Gäste in deinem WLAN sind, `IDEENRAUM_PASSWORD` setzen und den Container neu starten. Eine Passwortänderung meldet alle Geräte ab.

**Zugriff von unterwegs:** Den Port nicht einfach im Router freigeben. Besser über ein VPN wie WireGuard oder Tailscale ins Heimnetz gehen. Hinter einem Reverse-Proxy (nginx, Caddy, Traefik) muss der `Host`-Header durchgereicht werden, sonst lehnt der Server Änderungen ab.

## Ohne Docker

Node.js ab Version 20 genügt, es gibt nichts zu installieren:

```bash
npm start          # startet auf Port 8090, Daten in ./data
```

Als Dienst: `deploy/ideenraum.service` nach `/etc/systemd/system/` kopieren, Pfade anpassen, `sudo systemctl enable --now ideenraum`.

## Fertige Images über GitHub

Liegt das Projekt auf GitHub, baut `.github/workflows/docker.yml` bei jedem Versions-Tag (`git tag v1.1.0 && git push --tags`) ein Image für `linux/amd64`, `linux/arm64` und `linux/arm/v7` und legt es unter `ghcr.io/<dein-name>/ideenraum` ab. Auf dem Server dann in `compose.yaml` `build: .` entfernen, die `image:`-Zeile mit `ghcr.io/…` einkommentieren und mit `docker compose pull && docker compose up -d` aktualisieren. Ist das Repository privat, vorher einmal `docker login ghcr.io` ausführen.

## Entwicklung

```bash
npm run dev    # Server mit automatischem Neustart
npm test       # Server-Tests (Speichern, Migration, Backup, Login, Live-Sync)
```

```
server/        HTTP-Server, API, Speicherung, Backups, Login
public/        die App im Browser (index.html, app.js, styles.css)
public/shared/ Datenmodell und Migrationen, von App und Server gemeinsam genutzt
test/          Tests
deploy/        Update-Skript und systemd-Dienst
data/          deine Daten (nicht im Git)
```

Die Schriften (Figtree, Bricolage Grotesque) lädt der Browser von Google Fonts. Ohne Internet nimmt er die Systemschrift.
