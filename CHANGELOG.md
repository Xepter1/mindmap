# Änderungen

Versionsnummern folgen dem Schema `Major.Minor.Patch`. Ändert sich das Datenformat, steht es hier dabei.

## 1.0.0 – 2026-11-23

Erste selbst gehostete Version. Datenformat 1.

- Eigener Server (Node.js, ohne Abhängigkeiten) speichert jedes Board als JSON-Datei in `data/`
- Live-Abgleich zwischen mehreren offenen Geräten
- Tägliche Sicherungen, Sicherung vor Datenmigrationen, Papierkorb für gelöschte Boards
- Komplette Sicherung herunterladen und wieder einspielen
- Optionaler Passwortschutz
- Docker-Image für x86 und ARM (Raspberry Pi)
