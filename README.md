# OpenChamber-Erweiterungen

Sammlung meiner Erweiterungen für OpenChamber. Jede Erweiterung liegt eigenständig unter [`extensions/`](extensions/) und behält ihr eigenes Manifest, ihre Versionsnummer, Tests und Installationspaket. Gemeinsame Bibliotheken oder ein gemeinsamer Laufzeitprozess sind nicht erforderlich.

## Erweiterungen

| Erweiterung | Beschreibung | Dokumentation | Aktuelle Pakete |
| --- | --- | --- | --- |
| **Ideenboard** (`ideenboard`) | Persönliches Kanban-Board für Ideen und aktuelle Arbeit | [README](extensions/ideenboard/README.md) | [GitHub-Releases](https://github.com/Broda24/openchamber-extensions/releases) |

Neue Erweiterungen werden als Geschwisterverzeichnisse ergänzt, zum Beispiel `extensions/meine-erweiterung/`. Die vorhandenen Unterordner sind voneinander unabhängig und teilen keine Nutzerdaten.

## Entwickeln

Voraussetzungen: Node.js 22+, npm, Python 3; für Browserprüfungen zusätzlich Chromium.

```bash
npm ci
npx playwright install chromium
npm run verify
```

Die Root-Befehle wenden das jeweilige Skript auf alle npm-Workspaces an, die es definiert haben. Für gezielte Arbeit am Ideenboard:

```bash
npm run typecheck --workspace openchamber-ideenboard
npm test --workspace openchamber-ideenboard
npm run test:browser --workspace openchamber-ideenboard
npm run package --workspace openchamber-ideenboard
```

`npm run package` baut und prüft das installierbare ZIP im jeweiligen Verzeichnis `extensions/<id>/dist/`. Build-Ausgaben und Abhängigkeiten werden nicht versioniert. Die optionale Installationsprüfung des Ideenboards gegen ein lokal installiertes OpenChamber ist in dessen [Entwicklungsanleitung](extensions/ideenboard/README.md#entwicklung-und-prüfung) beschrieben.

## Eine Erweiterung hinzufügen

1. Einen eigenen Ordner unter `extensions/<id>/` erstellen. `<id>` kurz, kleingeschrieben und stabil halten.
2. Eine eigene `package.json` mit eindeutigem npm-Workspace-Namen und den für diese Erweiterung passenden Skripten anlegen. OpenChamber-Metadaten und Berechtigungen gehören in das Manifest der jeweiligen Erweiterung, nicht in die Root-`package.json`.
3. Quellcode, Tests, Paketierung und eine README mit Installation, OpenChamber-Kompatibilität und Berechtigungen im eigenen Ordner halten. Ein separates `package-lock.json` pro Erweiterung ist nicht nötig; der Root-Lockfile verwaltet alle Workspaces.
4. `npm install` im Repository-Root ausführen, damit `package-lock.json` aktualisiert wird. Die Skripte `typecheck`, `test`, `test:browser`, `build`, `package` und `verify:install` sind optional; die Root-Befehle überspringen nicht vorhandene Skripte.
5. Vor dem Veröffentlichen `npm run verify` ausführen. Jede Erweiterung wird unabhängig versioniert und als ZIP paketiert. Für neue Releases Tags nach dem Muster `<id>-v<version>` verwenden; das historische Ideenboard-Release `v2.0.0` bleibt unverändert erhalten.

GitHub Actions führt Installations-, TypeScript-, Unit-, Browser- und Paketprüfungen für alle Workspaces aus. Releases werden bewusst manuell erstellt, damit nur die gewünschte Erweiterung veröffentlicht wird.
