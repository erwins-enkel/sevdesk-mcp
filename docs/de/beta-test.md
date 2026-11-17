# Beta-Test aus einem lokalen Checkout

**Deutsch** · [English](../en/local-checkout.md) · [Übersicht](../../README.md#deutsch)

Solange das Paket nicht auf npm ist, kann sein `npx`-Eintrag nicht starten. Um den ganzen Ablauf
vorher in echten Clients auszuprobieren, führst du `setup` aus einem lokalen Checkout aus: `setup`
gilt als installiert, wenn es aus einem Ordner unter `node_modules` läuft (wie mit `npx` oder einer
globalen Installation), sonst als lokaler Checkout. Du brauchst [Bun](https://bun.sh) ≥ 1.4.4 und
Node.js ≥ 22.

1. Klon das Repository in einen Ordner, der bleibt, wo er ist, kein temporärer Worktree, und bau
   es: `git clone https://github.com/erwins-enkel/sevdesk-mcp.git`, dann darin
   `bun install && bun run build`. Die Client-Einträge zeigen in diesen Ordner.
2. Führ dort `node dist/cli.js setup` aus. Es sagt, dass es aus dem lokalen Checkout läuft, und
   jeder Client-Eintrag, den es schreibt, startet den Build des Checkouts: den absoluten Pfad des
   Node.js, mit dem du es gestartet hast (GUI-Clients kennen deinen `PATH` oft nicht), die
   `dist/cli.js` des Checkouts, `--profile <name>` und `--reload`, zum Beispiel
   `"command": "/usr/local/bin/node", "args": ["/home/du/sevdesk-mcp/dist/cli.js", "--profile", "acme", "--reload"]`.
   Einen Eintrag von vor `--reload` bietet `setup` beim nächsten Lauf zum Ersetzen an. Alles andere
   ist wie unter [MCP-Clients](einrichtung.md#mcp-clients) beschrieben: dieselben Eintragsnamen,
   erst ein Backup, eine Frage pro Client, nichts wird ohne ausdrückliches Ja ersetzt.
3. Nach jedem `git pull` führst du `bun install && bun run build` erneut aus; die Einträge bleiben,
   wie sie sind. Mit `--reload` braucht der Client keinen Neustart: Vor jedem Aufruf prüft der
   Server, ob sich der Build (`dist/`) oder die Spezifikation (`spec/`) geändert hat, und sobald
   kein Aufruf läuft, startet er den eigentlichen Server mit dem neuen Build neu, hinter derselben
   Verbindung. Ein Server, der endet (ein Absturz, ein kaputter Build), beantwortet seine offenen
   Aufrufe mit einem Fehler und startet beim nächsten Aufruf neu. Einen Neustart des Clients
   brauchst du weiterhin für das, was der Client einmal beim Verbinden holt (Tool-Namen,
   Eingabeschemas, Beschreibungen, die Instructions), für Änderungen am Reload selbst
   (`src/reload.ts`, `src/cli.ts`) und für Änderungen an der Konfigurationsdatei. Ein Neustart
   verwirft die Bestätigungstokens zurückgehaltener Aufrufe; lass dir die Vorschau dann noch einmal
   zeigen. Verschiebst du den Checkout oder entfernst du dieses Node.js (etwa mit einem
   Versionsmanager), führ `setup` erneut aus und ersetz die Einträge. `setup --remove <name>` aus
   dem Checkout bietet auch an, seine Einträge zu entfernen.
4. Oder frag den Client nach der Version des sevdesk-MCP. Ein Server aus einem lokalen Checkout hat
   ein drittes Tool, `version` (das installierte Paket behält seine zwei): Es meldet die
   Paketversion, Branch und Commit des Checkouts und, nach einem `git fetch` des Upstreams des
   Branches, die Commits, die dort warten. Warten welche, fragt dich das Modell, und nach deinem Ja
   spult der Server den Checkout genau auf den angebotenen Commit vor (Fast-Forward), führt
   `bun install --frozen-lockfile` aus, wenn sich `package.json` oder `bun.lock` geändert haben,
   und dann `bun run build`; mit `--reload` nutzt der nächste Aufruf den neuen Build. Es ändert
   nichts, wenn versionierte Dateien nicht committete Änderungen haben, der Branch eigene Commits oder
   keinen Upstream hat oder bun weder im `PATH` des Clients noch in `~/.bun/bin` liegt. Scheitern
   Installation oder Build nach dem Vorspulen, sagt es das, und nichts wird zurückgerollt: Führ
   `bun install && bun run build` im Checkout aus. Ein Client holt die Tool-Liste einmal; starte ihn
   also nach dem Build, der `version` erstmals mitbringt, einmal neu. `sevdesk-mcp config` zeigt
   denselben Stand und bietet dasselbe Update im Terminal an
   ([`config`](einrichtung.md#profile-und-einstellungen-ändern-config)).
5. Sobald das Paket veröffentlicht ist, wechselst du mit `npx @erwins-enkel/sevdesk-mcp setup` und
   demselben Profilnamen: Ersetz das Profil (es fragt den Token erneut ab) und antworte mit Ja, wenn
   es anbietet, den Eintrag jedes Clients durch den `npx`-Eintrag zu ersetzen.
