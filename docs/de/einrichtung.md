# Einrichtung und Profile

**Deutsch** · [English](../en/setup.md) · [Übersicht](../../README.md#deutsch)

Ein Profil ist ein sevdesk-Konto. Die [Konfigurationsdatei](konfiguration.md) enthält seinen
Namen, die Firma und ob es nur lesend ist; sein API-Token liegt nur im Schlüsselbund des
Betriebssystems (macOS-Schlüsselbund, Windows-Anmeldeinformationsverwaltung, Linux Secret
Service), unter dem Dienst `sevdesk-mcp` mit dem Profilnamen als Konto. Ein Token wird nie aus
einer Datei gelesen; ein Schlüssel `token` in der Konfigurationsdatei ist ein Fehler.

## Profil hinzufügen: `setup`

Ein Profil fügst du im Terminal mit `npx @erwins-enkel/sevdesk-mcp setup` hinzu (`setup --add`
macht dasselbe). Solange das Paket nicht auf npm ist, führst du stattdessen
`node dist/cli.js setup` in einem lokalen Checkout aus ([Beta-Test](beta-test.md)).

1. Es fragt nach dem Profilnamen (1 bis 32 Zeichen `a-z`, `0-9`, `-`). Ein vorhandenes Profil
   wird nur nach einem ausdrücklichen Ja ersetzt.
2. Es fragt verdeckt nach dem API-Token, prüft ihn bei sevdesk und zeigt Firma und
   Buchhaltungssystem. Ein abgelehnter Token oder ein Konto auf einem anderen System als 2.0 wird
   abgewiesen. Den Token findest du in sevdesk unter Erweiterungen → API.
3. Es fragt, ob das Profil nur lesend ist (Standard nein; beim Ersetzen die bisherige
   Einstellung des Profils).
4. Es speichert den Token im Schlüsselbund und das Profil (Name, Firma, nur lesend) in der
   Konfigurationsdatei.
5. Es bietet an, das Profil in jedem installierten MCP-Client einzutragen (siehe
   [MCP-Clients](#mcp-clients)), und zeigt den Befehl für jeden anderen Client:
   `npx -y @erwins-enkel/sevdesk-mcp --profile <name>` oder, aus einem lokalen Checkout, den
   Befehl, der dessen Build startet ([Beta-Test](beta-test.md)).

Bis Schritt 4 wird nichts gespeichert. Einen Rückfall auf Klartext gibt es nicht: Ohne
Schlüsselbund (Linux ohne Desktop, WSL, Docker) bricht `setup` ab und erklärt, warum: Einen Token
in einer einfachen Datei kann jeder Prozess und jedes Backup lesen, und er gibt vollen Zugriff auf
die Buchhaltung. Nimm dort stattdessen `SEVDESK_API_TOKEN`. Ohne Terminal (Skripte, CI) bricht
`setup` mit demselben Hinweis ab; es hat keine nicht interaktiven Optionen. Der Exit-Code ist 0,
wenn das Profil gespeichert ist und jede berührte Client-Konfiguration gelesen und geschrieben
werden konnte, sonst 1.

## Profile auflisten und entfernen

`setup --list` zeigt jedes Profil der Konfigurationsdatei mit Firma und ob es nur lesend ist. Es
liest nur die Konfigurationsdatei, nie den Schlüsselbund, zeigt also nie einen Token, und braucht
kein Terminal.

`setup --remove <name>` fragt, bevor es das Profil entfernt (Standard nein). Nach einem Ja löscht
es den Token aus dem Schlüsselbund und dann das Profil aus der Konfigurationsdatei; alle anderen
Schlüssel der Datei bleiben. Für die Frage braucht es ein Terminal. Der Exit-Code ist 0, wenn das
Profil entfernt ist, sonst 1: nach einem Nein, bei einem unbekannten Profil oder wenn Schlüsselbund
oder Konfigurationsdatei scheitern. Scheitert nur die Konfigurationsdatei, ist der Token schon
weg; korrigier die Datei und führ `setup --remove` noch einmal aus. Ist das Profil entfernt,
bietet es an, die Client-Einträge zu entfernen, die es starten (siehe [MCP-Clients](#mcp-clients)).

## Profile und Einstellungen ändern: `config`

`sevdesk-mcp config` öffnet ein Menü im Terminal. Zuerst zeigt es die laufende Version und ihre
Updates, die Konfigurationsdatei, ob das Audit-Log an ist und wo es liegt, und jedes Profil mit
Firma, Lesemodus, Download-Ordner und, für jeden installierten MCP-Client, den Einträgen, die es
starten, samt ihrer Art (`npx` oder lokaler Build). Die Übersicht liest nur die
Konfigurationsdatei und die Client-Konfigurationen, nie den Schlüsselbund. Du bewegst dich mit den
Pfeiltasten oder tippst die Nummer eines Eintrags (1 bis 9), wählst mit Enter und gehst mit Esc
oder q zurück. Die Ausgabe ist Text ohne Farben und liest sich mit `NO_COLOR` genauso.

- **Pro Profil:** nur lesend machen oder wieder Schreiben erlauben, den Download-Ordner festlegen
  (ein absoluter Pfad) oder auf den Standard zurücksetzen, in die installierten MCP-Clients
  eintragen oder daraus austragen (dieselben Fragen und Backups wie bei `setup`, siehe
  [MCP-Clients](#mcp-clients)), die Verbindung prüfen (der Token aus dem Schlüsselbund gegen
  sevdesk, mit Firma und Buchhaltungssystem, nie mit dem Token) und das Profil entfernen (wie
  `setup --remove`).
- **Profil hinzufügen:** startet den Dialog von `setup`.
- **Audit-Log:** aus- oder einschalten.
- **Update** (nur lokaler Checkout, siehe unten): steht ganz oben, wenn Commits warten.

Aus einem lokalen Checkout holt `config` beim Öffnen einmal den Upstream des Branches
(`git fetch`, ohne Nutzerdaten) und zeigt die Version mit Branch, Commit und Datum und ob Commits
warten. Kann es das nicht prüfen, sagt es warum („unbekannt“) und behauptet nie, aktuell zu sein.
Warten Commits, hat der Branch keine eigenen und ist keine versionierte Datei geändert, bietet das
Menü „Auf <commit> aktualisieren“ an. Es listet die wartenden Commits, fragt (Standard ja) und aktualisiert
dann genau wie das Tool `version` (siehe [Beta-Test](beta-test.md)). Nach einem Update endet
`config`; starte es erneut, um die neue Version zu sehen. Ein installiertes Paket zeigt seine
Version und sucht hier nicht nach Updates.

Jede Änderung wird sofort geschrieben, alle anderen Schlüssel der Datei bleiben; starte die
MCP-Clients neu, damit sie sie übernehmen. Mit Strg+C gehst du jederzeit raus, ohne halb
geschriebene Änderung. Wie `setup` braucht `config` ein Terminal und endet ohne eines mit Exit-Code
1; es nimmt keine Optionen (eine Option oder ein Argument ist ein Aufruffehler, Exit-Code 2). Der
Exit-Code ist 0, wenn du das Menü verlässt und jede Änderung geklappt hat, und 1, wenn eine
gescheitert ist (etwa eine Client-Konfiguration, die nicht geschrieben werden konnte, oder eine
gescheiterte Verbindungsprüfung).

## MCP-Clients

`setup` trägt den Server in diese Clients ein, wenn sie installiert sind, und `setup --remove`
bietet an, ihre Einträge wieder zu entfernen:

| Client                  | Konfigurationsdatei                                                                                                                                                                                  | Installiert, wenn             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Claude Desktop          | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`                                                                                                                             | der Ordner `Claude` existiert |
|                         | Windows: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` (aktuelle Installer), sonst `%APPDATA%\Claude\`                                                                   |                               |
|                         | Linux: `$XDG_CONFIG_HOME/Claude/` (Standard `~/.config/Claude/`)                                                                                                                                     |                               |
| Claude Code             | `~/.claude.json`, oder `.claude.json` in `CLAUDE_CONFIG_DIR`, wenn das gesetzt ist                                                                                                                   | die Datei existiert           |
| ChatGPT Desktop / Codex | `config.toml` in `CODEX_HOME`, wenn das gesetzt ist, sonst `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`); ChatGPT Desktop und die Codex CLI teilen sie                        | der Ordner existiert          |
| OpenCode                | in `$XDG_CONFIG_HOME/opencode/` (Standard `~/.config/opencode/`, auch unter macOS und Windows): die erste vorhandene von `opencode.jsonc`, `opencode.json` und `config.json`, sonst `opencode.jsonc` | der Ordner existiert          |

Der Eintrag heißt `sevdesk`, bei mehreren Profilen `sevdesk-<profil>`, und startet
`npx -y @erwins-enkel/sevdesk-mcp --profile <name>` (Claude Code unter Windows: `cmd /c npx …`).
Aus einem lokalen Checkout statt aus einem installierten Paket schreibt `setup` einen Eintrag, der
den Build des Checkouts startet ([Beta-Test](beta-test.md)); es sagt, welche Art es schreibt. Der
Eintrag enthält nie einen Token. In der `config.toml` von Codex ist er die Tabelle
`mcp_servers.sevdesk` mit `command` und `args`; in OpenCode ist er
`"sevdesk": { "type": "local", "command": [...] }` in dessen Abschnitt `mcp`. Ein relativer
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` oder (für OpenCode) `XDG_CONFIG_HOME` hängt vom Ordner ab, in
dem der Client startet; `setup` lässt diesen Client deshalb in Ruhe. `setup` fragt einmal pro
Client und zeigt die Datei:

- Ein neuer Eintrag kommt nach einem Ja (Standard) dazu.
- Ein vorhandener Eintrag dieses Namens, der etwas anderes startet, wird nur nach einem
  ausdrücklichen Ja ersetzt; sonst bleibt die Datei Byte für Byte, wie sie war. Ein Eintrag, der
  schon denselben Befehl startet, bleibt ohne Frage, wie er ist.
- Bevor es schreibt, sichert `setup` die bisherige Datei daneben als
  `<datei>.sevdesk-mcp-<zeit>.bak` und zeigt ihren Pfad. Alle anderen Schlüssel und Einträge, die
  Rechte der Datei und ein Symlink bleiben. In Codex' TOML und OpenCodes JSONC ändert es nur den
  Eintrag und behält die Kommentare; die Claude-Konfigurationen sind JSON ohne Kommentare und
  werden neu geschrieben, mit zwei Leerzeichen eingerückt. Hat sich die Datei geändert, während du
  geantwortet hast, bleibt sie, wie sie ist.
- `setup --remove <name>` bietet an, jeden Eintrag zu entfernen, der dieses Paket (oder, aus einem
  lokalen Checkout, dessen Build) mit `--profile <name>` startet (Standard ja), mit demselben
  Backup.
- Eine Client-Konfiguration, die sich nicht lesen oder schreiben lässt, wird gemeldet und bleibt,
  wie sie ist; der Exit-Code ist dann 1. Dazu gehört eine OpenCode-Konfiguration, deren Abschnitt
  `mcp` den Schlüssel `servers` enthält, das Format von OpenCode 2, das `setup` noch nicht
  bearbeitet; trag den angezeigten Befehl dort selbst ein.

Starte den Client danach neu. Bei jedem anderen Client trägst du den angezeigten Befehl selbst
ein.

## Welches Konto ein Aufruf nutzt

Der Server rät nie, für welches Konto ein Aufruf ist:

1. Ist `SEVDESK_API_TOKEN` gesetzt, hat er genau dieses eine Profil (benannt durch
   `SEVDESK_PROFILE`, Standard `env`) und liest den Schlüsselbund nicht; sonst hat er die Profile
   der Konfigurationsdatei.
2. `sevdesk-mcp --profile <name>` legt den Server auf eines davon fest; `execute` nimmt dann kein
   anderes `account` an. (`--reload` für die Einträge eines lokalen Checkouts ist unter
   [Beta-Test](beta-test.md) beschrieben.)
3. Sonst nutzt `execute` bei genau einem Profil dieses.
4. Bei mehreren braucht `execute` `account`; ohne antwortet es `account_required` mit den
   Profilnamen und Firmen.
