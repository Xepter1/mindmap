# Änderungen

Versionsnummern folgen dem Schema `Major.Minor.Patch`. Ändert sich das Datenformat, steht es hier dabei.

## 1.3.0 – 2026-11-24

Datenformat bleibt 1. Neu sind der Elementtyp `image` und Bilder in Notizen (eine Zeile `![Bild](bild:…)`). Die Bilddateien liegen im Datenordner unter `images/`. Ältere Versionen behalten Bilder unverändert, zeigen sie aber nicht an.

- Bilder auf der Fläche: mit `⌘ V` einfügen, aus dem Finder oder der Fotomediathek hineinziehen oder über den Bild-Knopf (`B`) auswählen. Ziehen verschiebt ein Bild, die Ecke ändert die Größe, das Seitenverhältnis bleibt dabei erhalten. Ein Doppelklick zeigt das Bild groß.
- Bilder in den Notizen: Sie landen an der Schreibmarke, auch beim Hineinziehen oder über den Bild-Knopf im Notizfeld. Ein Klick zeigt das Bild groß. Entfernen geht mit `×` oder mit `Entf`, und `⌘ Z` holt das Bild zurück.
- Große Fotos werden vor dem Hochladen verkleinert (höchstens 2560 Pixel Kantenlänge). Bilder mit durchsichtigen Stellen behalten ihre Transparenz.
- Neuer Knopf „Nach hinten“ für Haftnotizen, Formen, Texte und Bilder.
- PNG-Export, JSON-Export und die komplette Sicherung enthalten die Bilder. Der Import überträgt sie wieder auf den Server.
- Aufräumen: Ein Bild, das weder ein Board noch eine Sicherung noch der Papierkorb braucht, löscht der Server nach 7 Tagen.

## 1.2.0 – 2026-11-24

Datenformat bleibt 1. Neu ist nur das optionale Feld `note` an Mindmap-Knoten, alte Boards funktionieren unverändert.

- Notizen zu jedem Thema: Ein Doppelklick auf ein Thema öffnet rechts ein Notizfeld, etwa für einen Verfahrensablauf. Auf dem Handy erscheint es unten.
- Das Notizfeld folgt der Auswahl. Ein Klick auf ein anderes Thema zeigt dessen Notizen, oben steht der Pfad dorthin.
- Themen mit Notizen tragen ein kleines Symbol. Ein Klick darauf öffnet die Notizen.
- Listen mit „1.“ oder „-“ setzt `Enter` von selbst fort.
- `⌘ Enter` (Windows: `Strg Enter`) springt zwischen Mindmap und Notizen hin und her.
- Geändert: Den Text eines Themas bearbeitest du jetzt mit `F2`, durch Lostippen oder oben im Notizfeld, weil der Doppelklick die Notizen öffnet. Bei Haftnotizen, Formen und Text bleibt der Doppelklick wie bisher.

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
