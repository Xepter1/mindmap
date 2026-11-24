# Ideenraum

Mindmaps und Whiteboards im Browser, gehostet auf deinem eigenen Server (Raspberry Pi oder jeder andere Rechner).

- Mindmaps per Tastatur: `Tab` für ein Unterthema, `Enter` für ein Thema auf derselben Ebene, Pfeiltasten zum Navigieren
- Notizen zu jedem Thema in einer Seitenleiste, zum Beispiel für Abläufe oder Lernstoff (Doppelklick aufs Thema)
- Haftnotizen, Text, Formen, Pfeile mit Beschriftung, Stift
- Mehrere Boards, Export als PNG oder JSON, komplette Sicherung mit einem Klick
- Mehrere Geräte gleichzeitig: Änderungen erscheinen sofort überall (Laptop, Tablet, Handy)
- Läuft auf x86 und ARM, ohne Datenbank und ohne npm-Abhängigkeiten

## Installation mit Portainer

So läuft es: GitHub baut bei jedem Release das Docker-Image für x86 und ARM. Portainer holt sich den Stack aus dem Repository und spielt neue Versionen von selbst ein. Deine Boards liegen im Docker-Volume `ideenraum-data` und bleiben dabei erhalten.

Das Repository liegt öffentlich unter [github.com/Xepter1/mindmap](https://github.com/Xepter1/mindmap).

**1. Release abwarten.** Jeder Versions-Tag (der erste ist `v1.0.0`) startet auf GitHub unter „Actions“ den Workflow „Release“. Er testet, baut das Image und trägt es in `deploy/portainer.yml` ein. Das dauert ein paar Minuten.

**2. Image öffentlich machen (einmalig).** Auf github.com/Xepter1 unter „Packages“ das Paket `ideenraum` öffnen. Steht dort „Private“, unter „Package settings“ → „Change visibility“ auf Public stellen. Soll es privat bleiben: auf GitHub einen Token (classic) mit dem Recht `read:packages` anlegen und in Portainer unter Registries eine „Custom registry“ mit URL `ghcr.io`, deinem GitHub-Namen und dem Token eintragen.

**3. Stack anlegen:** Portainer → Stacks → Add stack → Repository

| Feld | Wert |
| --- | --- |
| Repository URL | `https://github.com/Xepter1/mindmap` |
| Repository reference | `refs/heads/main` |
| Compose path | `deploy/portainer.yml` |
| Authentication | aus (das Repository ist öffentlich) |
| GitOps updates | an, Mechanismus „Polling“, Intervall `5m` |
| Environment variables | optional, siehe [Einstellungen](#einstellungen), z. B. `IDEENRAUM_PASSWORD` |

„Deploy the stack“ klicken, danach im Browser `http://<IP-des-Servers>:8090` öffnen.

## Neue Version ausrollen

1. Änderungen committen und kurz in `CHANGELOG.md` notieren.
2. Version erhöhen und hochladen:

   ```bash
   npm version minor        # 1.0.0 → 1.1.0, legt Commit und Tag an (für kleine Fixes: patch)
   git push --follow-tags
   ```

3. GitHub testet und baut das Image und trägt die neue Version in `deploy/portainer.yml` ein. Portainer bemerkt das beim nächsten Polling und tauscht den Container aus. Das Volume mit deinen Daten bleibt bestehen.

Schlagen die Tests fehl, wird nichts gebaut und nichts ausgerollt.

## Wie deine Daten Updates überleben

- **Getrennt vom Programm:** Alles liegt im Datenordner (unter Portainer im Volume `ideenraum-data`), eine JSON-Datei pro Board. Das Programm kann beliebig oft ersetzt werden.
- **Datenformat mit Versionsnummer:** Jedes Board trägt ein `format`. Ändert eine neue Version die Struktur, wandelt sie alte Boards beim Start automatisch um (Migration). Vorher legt sie eine Sicherung in `backups/…_vor-migration-…` an.
- **Kein Datenverlust durch Downgrade:** Stammen die Daten von einer neueren Version, startet eine ältere Version gar nicht erst und sagt dir das im Log.
- **Unbekanntes bleibt erhalten:** Felder und Elementtypen, die eine Version nicht kennt, werden unverändert mitgespeichert.
- **Sicheres Schreiben:** Dateien werden erst vollständig geschrieben und dann ausgetauscht. Ein Stromausfall hinterlässt keine halbe Datei.

Für Entwickler: Wie eine Migration angelegt wird, steht oben in `public/shared/model.js`.

## Sicherungen

| Was | Wo (im Datenordner) | Wie lange |
| --- | --- | --- |
| Tägliche Sicherung (nur wenn sich etwas geändert hat) | `backups/<Zeitpunkt>_taeglich/` | 14 Tage (`BACKUP_KEEP_DAYS`) |
| Sicherung vor jeder Datenmigration | `backups/<Zeitpunkt>_vor-migration-…/` | die letzten 10 |
| Gelöschte Boards | `trash/` | 30 Tage (`TRASH_KEEP_DAYS`) |
| Komplette Sicherung als eine Datei | in der App: Export → „Komplette Sicherung herunterladen“ | so lange du willst |

Die Sicherungen liegen auf demselben Gerät. Für eine Kopie außerhalb, etwa auf einem NAS, das Volume als Archiv sichern (per SSH auf dem Server):

```bash
docker run --rm -v ideenraum-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/ideenraum-$(date +%F).tgz -C /data .
```

**Wiederherstellen einzelner Boards:** Stack stoppen, die Board-Datei aus `backups/…` oder `trash/` nach `boards/` kopieren (bei Dateien aus dem Papierkorb den Zeitstempel vor `__` aus dem Namen entfernen), Stack starten. Eine komplette Sicherungsdatei lässt sich in der App über Export → „Sicherung oder Board importieren“ einspielen.

## Umzug auf einen anderen Server

Ob der neue Rechner x86 oder ARM ist, spielt keine Rolle, das Image gibt es für beide.

1. Auf dem alten Server das Volume als Archiv sichern (Befehl oben).
2. Auf dem neuen Server das Archiv in ein frisches Volume entpacken:

   ```bash
   docker volume create ideenraum-data
   docker run --rm -v ideenraum-data:/data -v "$PWD":/backup alpine \
     sh -c "tar xzf /backup/ideenraum-JJJJ-MM-TT.tgz -C /data && chown -R 1000:1000 /data"
   ```

3. In Portainer den Stack wie oben anlegen.

Einfacher, aber ohne Backups und Papierkorb: in der App „Komplette Sicherung herunterladen“ und auf dem neuen Server importieren.

## Einstellungen

Unter Portainer als „Environment variables“ des Stacks, sonst in `compose.yaml`:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `IDEENRAUM_PORT` | `8090` | Port auf dem Server (nur `deploy/portainer.yml`) |
| `IDEENRAUM_PASSWORD` | leer | Passwortschutz an, wenn gesetzt |
| `BACKUP_KEEP_DAYS` | `14` | Anzahl täglicher Sicherungen |
| `TRASH_KEEP_DAYS` | `30` | Tage im Papierkorb |
| `TZ` | `Europe/Berlin` | Zeitzone |
| `COOKIE_SECURE` | `false` | `true`, wenn die App nur über HTTPS erreichbar ist |

**Passwortschutz:** Ohne Passwort kann jeder in deinem Netz die Boards öffnen. Sobald Gäste in deinem WLAN sind, `IDEENRAUM_PASSWORD` setzen und den Stack neu ausrollen. Eine Passwortänderung meldet alle Geräte ab.

**Zugriff von unterwegs:** Den Port nicht einfach im Router freigeben. Besser über ein VPN wie WireGuard oder Tailscale ins Heimnetz gehen. Hinter einem Reverse-Proxy (nginx, Caddy, Traefik, Nginx Proxy Manager) muss der `Host`-Header durchgereicht werden, sonst lehnt der Server Änderungen ab.

## Ohne Portainer

**Mit Docker Compose** (baut das Image direkt auf dem Server, Daten im Ordner `./data`):

```bash
git clone https://github.com/Xepter1/mindmap.git && cd mindmap
mkdir -p data && docker compose up -d --build
```

Updates: `./deploy/update.sh` (holt den neuesten Stand per `git pull` und baut neu). Meldet der Start „Kein Schreibzugriff“, einmal `sudo chown -R 1000:1000 data` ausführen.

**Ganz ohne Docker:** Node.js ab Version 20 genügt, es gibt nichts zu installieren. `npm start` startet auf Port 8090 mit Daten in `./data`. Als Dienst: `deploy/ideenraum.service` nach `/etc/systemd/system/` kopieren, Pfade anpassen, `sudo systemctl enable --now ideenraum`.

## Entwicklung

```bash
npm run dev    # Server mit automatischem Neustart auf http://localhost:8090
npm test       # Tests (Speichern, Migration, Backup, Login, Live-Sync)
```

```
server/          HTTP-Server, API, Speicherung, Backups, Login
public/          die App im Browser (index.html, app.js, styles.css)
public/shared/   Datenmodell und Migrationen, von App und Server gemeinsam genutzt
test/            Tests
deploy/          Portainer-Stack, Update-Skript, systemd-Dienst
.github/         Tests bei jedem Push, Release-Workflow für Images
```

Die Schriften (Figtree, Bricolage Grotesque) lädt der Browser von Google Fonts. Ohne Internet nimmt er die Systemschrift.
