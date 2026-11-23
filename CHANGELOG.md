# Änderungen

Versionsnummern folgen dem Schema `Major.Minor.Patch`. Ändert sich das Datenformat, steht es hier dabei.

## 1.1.0 – 2026-11-23

Datenformat bleibt 1. Neu ist nur das optionale Feld `dx`/`dy` an Mindmap-Knoten, alte Boards funktionieren unverändert.

- Mindmap-Äste lassen sich frei verschieben: Ins Leere ziehen setzt den Ast samt Unterthemen an die neue Stelle, die Verbindung bleibt
- Mit gedrückter Shift-Taste ins Leere ziehen löst den Ast wie bisher als eigene Mindmap
- Neuer Knopf „Anordnung zurücksetzen“ holt verschobene Äste an ihren automatischen Platz zurück, auf dem Hauptthema für die ganze Mindmap
- Mehrere ausgewählte Äste lassen sich gemeinsam verschieben, auch mit den Pfeiltasten

## 1.0.0 – 2026-11-23

Erste selbst gehostete Version. Datenformat 1.

- Eigener Server (Node.js, ohne Abhängigkeiten) speichert jedes Board als JSON-Datei in `data/`
- Live-Abgleich zwischen mehreren offenen Geräten
- Tägliche Sicherungen, Sicherung vor Datenmigrationen, Papierkorb für gelöschte Boards
- Komplette Sicherung herunterladen und wieder einspielen
- Optionaler Passwortschutz
- Docker-Image für x86 und ARM (Raspberry Pi)
- Portainer-Stack (`deploy/portainer.yml`), den der Release-Workflow bei jeder neuen Version automatisch aktualisiert
