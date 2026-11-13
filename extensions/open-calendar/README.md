# OpenCalendar 0.2.1

Ein lokaler Kalender als OpenChamber-Erweiterung: Termine manuell pflegen, optional per KI-Eingabefeld anlegen oder abfragen und einen Posteo-Kalender ausschließlich lesend als ICS-Snapshot einblenden.

Die Erweiterung läuft vollständig im Panel. Es gibt keinen Server, keine Datenbank, keinen Container und kein Startskript.

## Installation

1. `open-calendar-0.2.1.zip` (gebaut mit `npm run package`, siehe unten) in OpenChamber unter **Einstellungen → Erweiterungen** als Update installieren/ersetzen. Nicht vorher deinstallieren: Eine Deinstallation löscht den Erweiterungsspeicher. Vorher ein Backup exportieren.
2. Die Berechtigungsabfrage bestätigen. Verlangt wird ausschließlich **Modellzugriff** (`model`) für das KI-Eingabefeld.
3. OpenCalendar als Panel in der Seitenleiste oder als Vollbildseite öffnen.

Die ZIP enthält nur die Laufzeitdateien (`package.json`, `icon.svg`, `README.md`, `panel/index.html`, `panel/styles.css`, `panel/main.js`). Nach der Installation liegt sie kopiert im Erweiterungsverzeichnis von OpenChamber; die Originaldatei kann danach verschoben werden.

## Neu in 0.2.1

- **KI mit Gesprächsbezug:** Bis zu sechs vorherige Nachrichten werden mitgegeben, damit Antworten auf Rückfragen verständlich bleiben. Nach dem Update wird deshalb vor dem nächsten Modellaufruf erneut um Zustimmung gebeten. „Neuer Chat“ entfernt den Verlauf und offene Vorschläge, keine gespeicherten Termine. Fehlgeschlagene Anfragen können erneut versucht werden.
- **Modell wählen:** In OpenChamber unter **Einstellungen → Sitzungen → Kleines Modell (Small Model)** Anbieter und Modell auswählen. Das gilt auch für andere Hintergrundfunktionen. Die SDK-API `host.generate` unterstützt weder eine separate Modellauswahl noch die Abfrage des Modellnamens. „Modell wählen“ im Kalender erklärt diesen Weg; es ist keine eigene Modellauswahl.
- **Fehler behoben:** Ungültige Datums-/Zeitfelder werden abgelehnt statt still entfernt. Explizite Enddaten bleiben erhalten; Metadatenänderungen behalten die ursprünglichen Zeitpunkte einschließlich Sommerzeit-Offset. Frei-/Belegt-Prüfung berücksichtigt Termine anderer Zeitzonen korrekt.
- **Vollständige Vorschau:** Auch Ort und Beschreibung werden vor dem Speichern gezeigt, bei Änderungen als Vorher/Nachher. Beide Felder lassen sich jetzt leeren. Mehrfaches Bestätigen speichert denselben KI-Vorschlag nicht parallel.
- **Neues Icon:** Kalender mit Häkchen und Uhr, passend zu Terminen und Planung; im Panel und im Erweiterungsmanifest einheitlich.

## Funktionsumfang

- **Vier Ansichten:** Tag, Woche und Monat als echte Kalenderansichten sowie eine Agenda für die nächsten 60 Tage. Die Wochen- und Tagesansicht zeigt ein Zeitraster mit Stundenachse, laufender Uhrzeit, Ganztagsleiste und überschneidungsfreier Nebeneinander-Darstellung paralleler Termine.
- **Schnell anlegen:** Klick auf eine freie Fläche im Zeitraster öffnet den Termin vorausgefüllt mit Datum und Uhrzeit; Klick auf die Ganztagsleiste legt einen Ganztagstermin an.
- **Tastatur:** `T` springt zu heute, `D`/`W`/`M`/`A` wechseln die Ansicht, `←`/`→` blättert vor und zurück. In der Monatsansicht öffnet `Enter` den gewählten Tag.
- **Lokaler Kalender:** Termine anlegen, bearbeiten, löschen, Suche, Ganztags- und Mehrtagstermine, Überschneidungswarnung vor dem Speichern. Die Monatsansicht zeigt die Termine des gewählten Tages direkt darunter.
- **Zeitzonen:** IANA-Zeitzonen je Termin, inklusive Sommerzeitwechsel und Sonderfällen wie der im Frühjahr fehlenden Stunde. Gespeicherte Termine behalten ihre Zeitzone auch beim Bearbeiten.
- **KI-Eingabe:** Fragen wie „Was steht morgen an?“, „Bin ich Freitag um 15 Uhr frei?“ oder „Trage am Dienstag um 14 Uhr Zahnarzt ein.“
  - Lesen ist deterministisch: Antworten stammen aus den gespeicherten Terminen, nicht aus dem Modell.
  - Das Modell liefert nur eine Absicht im streng geprüften JSON-Format. Ungültiges JSON oder ein Modellfehler ändern nichts; der Kalender bleibt manuell nutzbar.
  - Schreibaktionen (anlegen, ändern, löschen) erscheinen zuerst als Vorschau und werden erst nach ausdrücklicher Bestätigung gespeichert.
  - Mehrdeutige Treffer führen zu einer Rückfrage statt zu einer Änderung.
  - Vor dem ersten Modellaufruf erscheint ein Datenschutzhinweis. Ohne Zustimmung wird kein Modell aufgerufen.
- **Posteo (optional):** ICS-Datei manuell wählen, Termine schreibgeschützt anzeigen, Snapshot wieder entfernen.
- **Backup:** Export und Import der lokalen Termine als JSON, ohne Posteo-Daten und ohne Zugangslinks.

## Posteo: manueller ICS-Import, kein Direktabruf

Der Posteo-Kalender wird **nicht automatisch** über einen Freigabelink geladen. Diese Version liest ausschließlich eine `.ics`-Datei, die du selbst auswählst.

Grund: `https://posteo.de` antwortet auf einen Prüfabruf mit `403` und ohne `Access-Control-Allow-Origin`. Die abgeschottete Erweiterung darf eine solche Antwort nicht lesen, und OpenChamber erlaubt Netzwerkzugriffe nur zu ausdrücklich im Manifest genehmigten Origins. Deshalb enthält das Manifest **keine** `origins`-Berechtigung und die Erweiterung versucht keinen Linkabruf.

Der Freigabelink selbst wird zu keinem Zeitpunkt gespeichert, exportiert oder an das Modell gesendet. Im Speicher liegen nur die aus der Datei gelesenen Termine.

Unterstützt werden `VEVENT`, `UID`, `DTSTART`/`DTEND`/`DURATION`, `TZID` mit IANA-Zeitzone oder `VTIMEZONE`, Ganztagstermine, `RRULE`, `EXDATE` und `RECURRENCE-ID`. Nicht unterstützte oder fehlerhafte Angaben werden übersprungen und im Import sichtbar als Hinweis gemeldet, statt still zu verschwinden. Der Import betrachtet ein Fenster von einem Jahr rückwärts bis drei Jahre vorwärts und begrenzt sich auf 800 Termine je Snapshot.

## Berechtigungen

| Berechtigung | Zweck |
| --- | --- |
| `model` | Text an das in OpenChamber konfigurierte Modell senden und die geprüfte Absicht zurücklesen. |

Nicht angefordert werden Netzwerk-Origins, Dateisystemzugriff, Shell, Dienste oder Benachrichtigungen. Dateien (`.ics`, Backup-JSON) werden ausschließlich über die Dateiauswahl des Browsers gelesen; die Erweiterung erhält nur die ausgewählte Datei.

Der Erweiterungsspeicher von OpenChamber wird über `host.storage` genutzt. Er liegt auf dem Server der verbundenen OpenChamber-Instanz, nicht in einem eigenen Backend. Beim Deinstallieren löscht OpenChamber diesen Speicher; vorher ein Backup exportieren.

## Datenschutz und Grenzen

- **KI:** Die eingegebene Nachricht, maximal sechs vorherige Chatnachrichten und ein zeitlich begrenzter Terminausschnitt (höchstens 120 Termine, zusätzlich größenbegrenzt) werden an OpenChambers Kleines Modell gesendet. Der Ausschnitt wird heuristisch anhand von Datumsangaben bestimmt, ist nicht garantiert vollständig und kann weitere Termine desselben Zeitraums enthalten. Bei einem Cloud-Modell können diese Daten den Rechner verlassen. Maximal 20 Chatnachrichten bleiben im Erweiterungsspeicher und lassen sich über „Neuer Chat“ löschen. Antworten auf Kalenderabfragen werden aus allen sichtbaren Terminen berechnet, nicht allein aus dem Modellkontext.
- **Posteo:** Nur lesend. Die Erweiterung ändert Posteo nie und schreibt keine Termine dorthin zurück.
- **Kein Mehrmutzerbetrieb:** Es gibt keine Zusammenführung paralleler Änderungen. Nicht gleichzeitig in mehreren Fenstern bearbeiten.
- **Speicher:** Ein Schlüssel je Termin, höchstens 1.000 lokale Termine; die Erweiterung warnt ab 80 % und blockiert Schreibvorgänge, bevor die 2-MiB-Grenze des Namespaces erreicht ist.
- **Grenzen des ICS-Imports:** Exotische Zeitzonen ohne IANA-Entsprechung, sehr große Serien und Dateien über 5 MB werden sichtbar abgelehnt oder begrenzt. Der Import ersetzt jeweils den vorherigen Posteo-Snapshot.
- **Kein Kalender-Abo:** Es gibt keine automatische Aktualisierung. Ein neuer Posteo-Stand erfordert eine neue `.ics`-Datei.
- **Barrierefreiheit:** Die Oberfläche nutzt native Formularelemente und sichtbare Fokusführung, ist aber nicht vollständig mit Screenreadern getestet.
- **Keine Synchronisierung:** Kein CalDAV, kein Google-/Apple-Kalender, keine Freigabe zwischen Geräten. Der Stand hängt am Erweiterungsspeicher der OpenChamber-Instanz.

## Entwicklung und Prüfung

Für OpenCalendar gibt es keinen TypeScript-Quellstand: Als Basis für 0.2.1 lag nur das lesbare JavaScript-Bundle von 0.2.0 vor. Änderungen werden daher direkt in `panel/main.js` gepflegt; es findet keine TypeScript-Kompilierung statt. Die Abschnittsmarken im Bundle (`// panel/model.ts`, `// panel/storage.ts`, `// panel/ics.ts`, `// panel/ai.ts`, `// panel/main.ts`) zeigen, wo der eigene Code nach dem eingebundenen `@openchamber/sdk` beginnt.

Die Node- und Browsertests sowie die Installationsprüfung aus der Entwicklung von 0.2.1 sind nicht in diesem Repository enthalten. Hier vorhanden sind:

```sh
npm run build --workspace open-calendar    # Syntaxprüfung des gepflegten JavaScript-Bundles
npm run package --workspace open-calendar  # baut extensions/open-calendar/dist/open-calendar-0.2.1.zip
```
