# Ideenboard 2.0.0 für OpenChamber

Dein persönliches Kanban-Board für Ideen, Vorhaben und die aktuelle Arbeit. Läuft vollständig in OpenChamber; keine externen Dienste und kein zusätzlicher Serverprozess.

## Installation und Öffnen

Die fertige Installations-ZIP gibt es auf der [GitHub-Releases-Seite](https://github.com/Broda24/openchamber-extensions/releases/latest). Ältere Ideenboard-Releases und ihre Downloads bleiben erhalten.

1. Bei einem Update zuerst im bisherigen Board **Backup** anklicken und den Text als `.json`-Datei sichern. OpenChamber löscht beim Ersetzen einer ZIP-Erweiterung den zugehörigen Erweiterungsspeicher.
2. **Einstellungen → Erweiterungen → +** öffnen, `openchamber-ideenboard-2.0.0.zip` hinzufügen bzw. die bisherige Version ersetzen.
3. Die Berechtigungen **Sitzungen** und **Prompts senden** freigeben: nötig für die Projekt-/Chat-Anbindung und das bewusste Starten einer Arbeitssitzung mit erster Nachricht. Die Nachrichtenaktion erhält nur die jeweils ausgewählte Nachricht, nicht automatisch den gesamten Chat. Beim bloßen Öffnen der Erweiterung wird kein Prompt gesendet.
4. Board über das Ideenboard-Symbol oder das **+**-Menü öffnen. Für mehr Platz ist es zusätzlich als Vollbildseite im Menü für Erweiterungsseiten oberhalb der Sitzungsliste erreichbar.
5. Nach einem Update **Backup wiederherstellen** öffnen und die Datei auswählen oder ihren Text einfügen. Version-1-Backups werden automatisch übernommen.

Benötigt OpenChamber Web/Desktop ab 2.5.1. Die ZIP enthält fertige JavaScript-Dateien; kein eigener Build erforderlich.

## Die 13 Funktionen

1. **Drag-and-drop:** Karten zwischen Spalten und vor/hinter andere Karten ziehen. Alternativ Statusauswahl und „Nach oben/Nach unten“ verwenden, auch mit Tastatur oder Touch.
2. **Suche und Filter:** Titel, Notizen, Labels, Checklisten und Links durchsuchen; nach Status, Label, Priorität und Fälligkeit filtern.
3. **Labels:** Beim Bearbeiten durch Kommas getrennt eingeben.
4. **Priorität:** Niedrig, Normal, Hoch oder Dringend.
5. **Checklisten:** Im Editor ein Schritt pro Zeile; `[x]` bedeutet bereits erledigt. Direkt auf der Karte abhaken.
6. **Termine:** Datum ohne Zeitzonenverschiebung, Kennzeichnung „Heute“ bzw. „Überfällig“. Keine Benachrichtigungen im Hintergrund.
7. **Archiv:** Karten archivieren und in der Archivansicht zurückholen.
8. **Rückgängig und Papierkorb:** Die letzten zehn lokalen Änderungen rückgängig machen. Gelöschte Karten zunächst wiederherstellbar im Papierkorb; endgültiges Löschen braucht eine weitere Bestätigung. Rückgängig-Historie gilt nur, solange die Ansicht geöffnet ist.
9. **Mehrere Boards:** Boards erstellen/umbenennen und Karten im Editor einem anderen Board zuweisen. Jedes Board hat ein eigenes Fokus-Thema.
10. **Links und Anhänge:** HTTP(S)-Links öffnen über OpenChamber. Bis zu vier TXT-, MD-, JSON-, CSV-, PNG-, JPEG- oder WebP-Dateien je Karte hochladen, je maximal 64 KB. Text-/Bildvorschau im Board; der Originalinhalt wird vollständig im Backup mitgesichert. Andere Dateiformate werden nicht angenommen. Anhänge werden nicht automatisch an ein Modell gesendet.
11. **Chat-Verknüpfung:** Auf der Karte **Chat → Aktuellen Chat verknüpfen** auswählen. Verknüpfte Unterhaltungen später über die Karte öffnen.
12. **Aus Nachricht übernehmen:** Im Menü einer OpenChamber-Nachricht **Als Idee sammeln** wählen. Text und Herkunft werden in einen noch ungespeicherten Kartenentwurf übernommen.
13. **Arbeitssitzung starten:** **Chat**, Projekt wählen, dann bewusst **Arbeitssitzung starten**. Erst dann wird ein neuer Chat mit Karten-Prompt erstellt. Bei fehlendem Modell bleibt die angelegte Sitzung verknüpft; im vorhandenen Chat fortfahren, statt eine weitere Sitzung anzulegen. Unklare Timeout-Antworten lösen keine automatische Wiederholung aus.

## Alle erledigten/archivierten Karten auf einmal löschen

Über dem Board gibt es drei getrennte Sammelaktionen:

- **Alle Erledigten löschen**
- **Alle Archivierten löschen**
- **Erledigte + Archivierte löschen**

Diese Aktionen gelten für das **gesamte ausgewählte Board**, unabhängig von Suchfiltern. Die Bestätigung nennt Anzahl und Boardnamen. Andere Boards bleiben unverändert.

Karten kommen zunächst in den Papierkorb. **Papierkorb leeren** löscht alle dortigen Karten des ausgewählten Boards inklusive Anhängen nach erneuter Bestätigung endgültig. Dadurch wird auch die lokale Rückgängig-Historie geleert, damit sie endgültig Gelöschtes nicht zurückbringen kann. Vorher ein Backup kopieren, wenn du die Daten möglicherweise noch benötigst. „Endgültig“ bezieht sich auf das Board und nicht auf externe Backups oder eine sichere physische Löschung von Servermedien.

## Speicherung und Backup

Der Status **Gespeichert** bestätigt einen erfolgreichen Schreibvorgang auf dem verbundenen OpenChamber-Server. Bei Fehlern **Erneut speichern** verwenden oder vor dem Schließen ein Backup kopieren. Lesefehler führen niemals automatisch zum Löschen oder Zurücksetzen.

Alle Boards teilen sich einen begrenzten Erweiterungsspeicher. Maximal 20 Boards, 400 Karten einschließlich Papierkorb und 700 KB Boarddaten inklusive Anhängen. Große Daten werden in begrenzte Speicherteile aufgeteilt; erst nach vollständigem Schreiben wird der Speicherindex umgeschaltet. Alte Version-1-Daten bleiben bis zum ersten erfolgreichen Speichern erhalten.

**Backup** sichert sämtliche Boards, Fokus-Themen, Archiv, Papierkorb, Chat-Verknüpfungen und Anhänge. Bei großen Backups oder nicht verfügbarer Zwischenablage erscheint ein Dialog mit dem vollständigen Text: **Alles markieren**, Strg+C bzw. ⌘C, lokal als `.json` speichern. Wiederherstellung ersetzt nach Bestätigung sämtliche aktuellen Boards. Zugangsdaten sind nicht enthalten.

Das Board ist persönlich, nicht kollaborativ: Gleichzeitiges Bearbeiten in mehreren Fenstern oder in Panel und Vollbildseite ist nicht synchronisiert. Nur eine Ansicht zum Bearbeiten verwenden und auf **Gespeichert** warten, bevor du die Ansicht wechselst. Chat- und Projektaufrufe können durch Host-Berechtigungen oder eine nicht verfügbare Verbindung scheitern; angelegte Chats sind unabhängig von Kartenlöschungen.

## Entwicklung und Prüfung

Voraussetzungen: Node.js, npm, Python 3 zum Paketieren. Die Befehle werden vom Repository-Root ausgeführt:

```bash
npm ci
npm run typecheck --workspace openchamber-ideenboard
npm test --workspace openchamber-ideenboard
npx playwright install chromium
npm run test:browser --workspace openchamber-ideenboard
npm run package --workspace openchamber-ideenboard
```

Das Installations-ZIP liegt danach unter `extensions/ideenboard/dist/`. `npm run package` baut das Panel automatisch als IIFE neu. Kein TypeScript wird auf dem OpenChamber-Host kompiliert.

Optional gegen ein lokal installiertes OpenChamber testen, ohne Live-Daten zu berühren:

```bash
OPENCHAMBER_WEB_DIR=/pfad/zu/node_modules/@openchamber/web npm run verify:install --workspace openchamber-ideenboard
```

Die Integrationsprüfung erzeugt ausschließlich einen neuen Testordner unter `~/.cache/openchamber/tmp/opencode/`.
