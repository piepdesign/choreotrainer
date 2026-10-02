# ChoreoTrainer

WebApp zum Nachlernen von Tanz-Choreografien anhand eigener Kursvideos.

- **Hub:** letzte Choreos (Vorschau beim Hovern), Songs, Classes (per Drag & Drop sortierbar), Übungsstatistik
- **Upload:** Video ablegen, Class, Song (Suche über Deezer oder automatische Erkennung), Aufnahmedatum, Notizen
- **Training:** Spiegeln, Tempo (ohne Tonhöhenänderung), Lautstärke, Helligkeit/Kontrast, In/Out-Loop, 8er-Count (automatisch erkanntes Tempo, Tap-Korrektur, Halbe „+“), Marker, Song-Zeitleiste mit erkanntem Startpunkt, Vollbild, Tastaturkürzel

Alle Videos und Daten bleiben **lokal im Browser** (IndexedDB). Es gibt keinen Server, kein Konto und kein Hochladen.

## Nutzen

Online: **https://piepdesign.github.io/choreotrainer/**

Lokal (mit eigenem Durchreicher für die Songerkennung):

```bash
python3 server.py
```

Dann `http://localhost:8417` öffnen.

## Dienste

- Songsuche und BPM: [Deezer API](https://developers.deezer.com/api), ohne Schlüssel
- Songerkennung: Shazam-kompatibler Fingerabdruck per [vibra](https://github.com/BayernMuller/vibra) (WebAssembly, im Browser). Die Abfrage läuft lokal über `server.py`, online über den öffentlichen Durchreicher des vibra-Projekts. Inoffizielle Schnittstelle, sie kann jederzeit ausfallen. Übertragen wird nur der Fingerabdruck, kein Audio.

## Lizenz

GPL-3.0, wegen des enthaltenen vibra-Moduls (`vendor/vibra/`, ebenfalls GPL-3.0).
