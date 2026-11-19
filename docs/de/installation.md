# Installation ohne Vorkenntnisse

**Deutsch** · [English](../en/installation.md) · [Übersicht](../../README.md#deutsch)

Du brauchst weder Git noch Bun noch einen Build. Du brauchst ein sevdesk-Konto mit dem
Buchhaltungssystem 2.0 und dessen API-Token: in sevdesk unter Erweiterungen → API. Behandle den
Token wie ein Passwort, denn er gibt vollen Zugriff auf deine Buchhaltung.

## Claude Desktop (Windows und macOS)

Für Claude Desktop gibt es sevdesk-mcp ab Version 0.1.1 als Erweiterung. Node.js bringt Claude
Desktop selbst mit, ein Terminal brauchst du nicht.

1. Lade die neueste
   [sevdesk-mcp.mcpb](https://github.com/erwins-enkel/sevdesk-mcp/releases/latest/download/sevdesk-mcp.mcpb)
   herunter.
2. Öffne in Claude Desktop die Einstellungen, dort **Desktop app**, und klick neben **Extensions**
   auf **Manage**. Dann **Advanced settings** und im Bereich **Extension Developer** auf
   **Install Extension…**. Wähl die heruntergeladene Datei aus. In älteren Versionen steht
   **Extensions** direkt in den Einstellungen; je nach Version und Sprache heißen die Menüpunkte
   etwas anders.
3. Claude Desktop fragt nach zwei Einstellungen:
   - **sevdesk API token:** dein API-Token. Claude Desktop legt ihn im Schlüsselbund deines
     Systems ab (Windows-Anmeldeinformationsverwaltung, macOS-Schlüsselbund); die KI sieht ihn nie.
   - **Read-only:** Schalt das für den Anfang ein. Dann liest die KI in sevdesk nur und kann nichts
     anlegen, ändern, versenden oder löschen. Eine Ausnahme: Speichert sie das PDF eines Entwurfs,
     lässt sie es in sevdesk vorher neu erzeugen, ohne seinen Status zu ändern
     ([mehr](sicherheit.md#nur-lesen-modus)). Ausschalten kannst du es später in den Einstellungen
     der Erweiterung.
4. Fertig. Frag Claude zum Beispiel: „Welche Rechnungen sind seit mehr als 30 Tagen überfällig?“

PDFs und Exporte landen in `~/Downloads/sevdesk/claude-desktop/` (unter Windows
`C:\Users\<du>\Downloads\sevdesk\claude-desktop\`). Für eine neue Version lädst du die Datei
wieder herunter und installierst sie genauso. Die Erweiterung verbindet genau ein sevdesk-Konto;
für mehrere Konten richtest du sevdesk-mcp mit `setup` ein (nächster Abschnitt). Nutz für Claude
Desktop nur einen der beiden Wege, sonst hat es zwei sevdesk-Server.

## ChatGPT Desktop und andere Clients

ChatGPT Desktop, die Codex CLI, Claude Code und OpenCode haben keine Erweiterung zum Anklicken. Du
installierst Node.js und gibst einmal einen Befehl ein.

1. Lade auf [nodejs.org](https://nodejs.org/) den Installer der LTS-Version für dein System und
   führ ihn mit den vorgegebenen Einstellungen aus.
2. Öffne ein Terminal. Unter Windows: Startmenü öffnen, „Terminal“ eintippen, Enter. Unter macOS:
   Programme → Dienstprogramme → Terminal.
3. Kopier diesen Befehl hinein und drück Enter. Unter Windows:

   ```sh
   npx.cmd -y @erwins-enkel/sevdesk-mcp setup
   ```

   Unter macOS:

   ```sh
   npx -y @erwins-enkel/sevdesk-mcp setup
   ```

   Unter Windows steht dort `npx.cmd`, weil PowerShell ein einfaches `npx` oft wegen der
   Ausführungsrichtlinie blockiert.

4. `setup` fragt nacheinander nach einem Profilnamen (zum Beispiel `acme`: Kleinbuchstaben,
   Ziffern und `-`), dem API-Token (er bleibt beim Einfügen unsichtbar), ob das Profil nur lesen
   darf (für den Anfang: Ja) und für jeden gefundenen KI-Client, ob es den Server dort eintragen
   soll. Der Token landet im Schlüsselbund deines Systems, nie in einer Datei.
5. Starte den KI-Client neu.

Taucht ChatGPT Desktop bei `setup` nicht auf, hat `setup` dessen Konfigurationsordner nicht
gefunden. Ist die Umgebungsvariable `CODEX_HOME` leer oder nicht gesetzt, sucht `setup` den Ordner
`.codex` in deinem Benutzerordner; ist sie gesetzt, nur den Ordner, den sie nennt, und bei einem
relativen Pfad lässt es ChatGPT Desktop ganz aus, auch wenn `.codex` existiert. Dann trägst du den
Server in ChatGPT selbst ein: in den Einstellungen bei den MCP-Servern als neuen STDIO-Server mit
dem Befehl `npx` und den Argumenten `-y @erwins-enkel/sevdesk-mcp --profile <name>`, mit deinem
Profilnamen statt `<name>`. Den Token liest der Server aus dem Schlüsselbund; er gehört nicht in
dieses Formular.

OpenCode 2 (in dessen Konfiguration steht unter `mcp` ein Abschnitt `servers`) bearbeitet `setup`
noch nicht: Es meldet die Datei und zeigt am Ende den Befehl für andere Clients,
`npx -y @erwins-enkel/sevdesk-mcp --profile <name>`. Den trägst du in OpenCode selbst als lokalen
MCP-Server ein. Mehr zu Profilen und Clients: [Einrichtung und Profile](einrichtung.md).

## Windows: nicht in WSL

Richte sevdesk-mcp unter Windows direkt ein, nicht im Windows-Subsystem für Linux (WSL): Dort gibt
es keinen Schlüsselbund, und `setup` fände die KI-Clients von Windows nicht.

## Entfernen

Die Erweiterung entfernst du in Claude Desktop unter Einstellungen → Desktop app → Extensions
(**Manage**). Ein Profil aus `setup` entfernst
du mit `npx.cmd -y @erwins-enkel/sevdesk-mcp setup --remove <name>` (macOS: `npx`); es löscht den
Token aus dem Schlüsselbund und bietet an, die Einträge in den Clients zu entfernen.
