# Konfiguration

**Deutsch** · [English](../en/configuration.md) · [Übersicht](../../README.md#deutsch)

Der Server läuft ohne Konfigurationsdatei. Willst du einen Standardwert ändern, leg `config.json`
im Konfigurationsordner an:

| Betriebssystem | Konfigurationsdatei                                                             |
| -------------- | ------------------------------------------------------------------------------- |
| Linux          | `$XDG_CONFIG_HOME/sevdesk-mcp/config.json` (Standard `~/.config/sevdesk-mcp/…`) |
| macOS          | `~/Library/Application Support/sevdesk-mcp/config.json`                         |
| Windows        | `%APPDATA%\sevdesk-mcp\config.json` (meist `C:\Users\<du>\AppData\Roaming\…`)   |

Jeder Schlüssel ist optional; ein Schlüssel, den du weglässt, behält seinen Standardwert. Die
Limits gelten für jeden Lauf von `search` und `execute`.

```json
{
  "baseUrl": "https://my.sevdesk.de/api/v1",
  "limits": { "timeoutSeconds": 30, "memoryMb": 64, "callsPerRun": 50, "outputChars": 20000 },
  "profiles": { "acme": { "company": "Acme GmbH", "readonly": false } },
  "audit": true
}
```

| Schlüssel               | Standard                       | Erlaubt                                                                   |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| `baseUrl`               | `https://my.sevdesk.de/api/v1` | eine `https://`-URL ohne Zugangsdaten, Query oder Fragment                |
| `limits.timeoutSeconds` | `30`                           | Zeit pro Lauf, ganze Sekunden von 1 bis 3600                              |
| `limits.memoryMb`       | `64`                           | Speicher der Sandbox in MB, 16 bis 2048                                   |
| `limits.callsPerRun`    | `50`                           | sevdesk-Aufrufe pro `execute`-Lauf, 1 oder mehr                           |
| `limits.outputChars`    | `20000`                        | Zeichen von Ergebnis und Konsolenausgabe, 1 oder mehr                     |
| `profiles.<name>`       | keiner                         | ein [Profil](einrichtung.md): Name aus 1 bis 32 Zeichen `a-z`, `0-9`, `-` |
| `….company`             | Pflicht                        | der Firmenname in sevdesk, ein nicht leerer String                        |
| `….readonly`            | `false`                        | `true` oder `false` ([Nur-Lesen-Modus](sicherheit.md#nur-lesen-modus))    |
| `….downloadDir`         | `~/Downloads/sevdesk/<name>`   | wohin seine [Dateien](dateien.md) gespeichert werden, ein absoluter Pfad  |
| `audit`                 | `true`                         | `true` oder `false` ([Audit-Log](sicherheit.md#audit-log))                |

Der Server liest die Datei beim Start; starte ihn (oder deinen MCP-Client) nach einer Änderung
also neu. Ist die Datei kein gültiges JSON oder hat sie einen unbekannten Schlüssel oder einen
ungültigen Wert, laufen beide Tools nicht und geben einen `invalid_config`-Fehler mit Datei und
Problem zurück; bei einer kaputten Datei greift der Server nie auf die Standardwerte zurück.

`sevdesk-mcp config` ändert Profile und das Audit-Log in einem Menü im Terminal (siehe
[Einrichtung und Profile](einrichtung.md#profile-und-einstellungen-ändern-config)).
