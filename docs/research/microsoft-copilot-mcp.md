# Microsoft Copilot und sevdesk-mcp

- Stand: 2026-11-10, alle Quellen an diesem Tag abgerufen (Liste am Ende).
- Frage (Kai): „Könnte der sevdesk MCP auch mit Microsoft Copilot funktionieren?“, Anlass:
  [Copilot Studio: Agent mit MCP erweitern][cs-extend-de].
- Lesart: Aussagen mit Link stammen aus der verlinkten Erstquelle (Microsoft Learn,
  code.visualstudio.com, docs.github.com, modelcontextprotocol.io, das npm-Paket des MCP-SDK).
  Ein **Schluss:** ist meine Ableitung für sevdesk-mcp und steht so in keiner Quelle. „Entscheidung N“
  meint die Produktentscheidungen in `CLAUDE.md`, „0002 Nr. N“ den Eintrag in
  `docs/decisions/0002-product-decisions.md`.

## Kurzantwort

Teilweise. **GitHub Copilot** (VS Code, Visual Studio, JetBrains, Copilot CLI) startet lokale
stdio-Server und kann sevdesk-mcp schon heute nutzen: von Hand eingetragen, ohne Codeänderung. Eine
neue `CLIENTS`-Zeile für `~/.copilot/mcp-config.json` würde das in `setup` übernehmen, und VS Code
liest diese Datei standardmäßig mit. **Copilot Studio**, **Microsoft 365 Copilot** (deklarative
Agenten, Teams, Cowork) und das **Agent-365-Register** sprechen nur Remote-MCP über Streamable HTTP
an einer HTTPS-URL, die aus Microsofts Cloud erreichbar sein muss. An einen lokalen stdio-Prozess
kommen sie nicht heran, und Microsoft dokumentiert dafür auch kein Gateway. Dafür bräuchte
sevdesk-mcp eine gehostete HTTP-Variante mit eigener Anmeldung, einem sevDesk-Token pro Nutzer:in,
einem neuen Weg für PDFs und einem geteilten Bestätigungsspeicher. Das widerspricht heute PRD §5.5
und §11 sowie den Entscheidungen 7 und 9 und wäre ein eigenes Projekt. **MCP on Windows (ODR)** ist
Preview und bringt nichts, was VS Code nicht schon kann. Für die **Copilot-App unter Windows** habe
ich keinen dokumentierten Weg für fremde MCP-Server gefunden.

## Übersicht

| Copilot-Produkt                                                    | MCP-Transport                                       | lokal/Cloud                   | Auth                                                        | Status                                            | Urteil für sevdesk-mcp                                              |
| ------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| GitHub Copilot in VS Code                                          | stdio, HTTP (Streamable, SSE-Fallback)              | lokal: startet den Prozess    | stdio: keine; HTTP: OAuth, Header                           | kein Preview-Label (MCP-Registry: Public Preview) | **geht heute**; `setup`-Zeile (s. u.) deckt es mit ab               |
| GitHub Copilot CLI                                                 | `local`/`stdio`, `http`, `sse`                      | lokal                         | `env`, Header                                               | kein Status-Label                                 | **geht heute**; kleine Änderung: neue `CLIENTS`-Zeile               |
| GitHub Copilot in Visual Studio                                    | stdio, HTTP/SSE                                     | lokal (Windows)               | Remote: OAuth                                               | kein Preview-Label                                | **geht heute** von Hand; optionale `CLIENTS`-Zeile                  |
| GitHub Copilot in JetBrains, Xcode, Eclipse                        | stdio, HTTP                                         | lokal                         | Remote: Header                                              | laut GitHub Docs unterstützt                      | geht von Hand, nicht einzeln geprüft                                |
| GitHub Copilot cloud agent                                         | `local`/`stdio` im Actions-Runner, `http`, `sse`    | Cloud (GitHub)                | Secrets `COPILOT_MCP_*`                                     | –                                                 | technisch möglich, **nicht sinnvoll** (keine Rückfrage an Menschen) |
| Copilot Studio, Standard-Harness                                   | nur Streamable HTTP                                 | Cloud → öffentliche HTTPS-URL | keine, API-Key, OAuth 2.0 (DCR mit Discovery, DCR, manuell) | kein Preview-Label                                | **braucht Remote-Variante**                                         |
| Copilot Studio, GitHub-Copilot-Harness                             | HTTPS-URL                                           | Cloud                         | je nach Server                                              | Preview                                           | **braucht Remote-Variante**                                         |
| Microsoft 365 Copilot: deklarative Agenten (Copilot Chat, Teams)   | `RemoteMCPServer` (absolute URL)                    | Cloud                         | None, OAuth statisch, OAuth DCR, Entra SSO                  | kein Preview-Label                                | **braucht Remote-Variante**                                         |
| Microsoft 365 Copilot: Plugins (`agentConnectors`), Copilot Cowork | Streamable HTTP, HTTPS ab TLS 1.2, Tool-Call < 30 s | Cloud                         | None, OAuth-/API-Key-Vault, DCR u. a.                       | WIQD Preview, `plugin add connector` alpha        | **braucht Remote-Variante**, dazu 30-s-Grenze                       |
| Agent 365, BYO MCP                                                 | Remote, öffentlich erreichbar                       | Cloud-Gateway                 | NoAuth, APIKey, ExternalOAuth, EntraOAuth                   | Preview                                           | nur Governance-Schicht über einer Remote-Variante                   |
| MCP on Windows (ODR)                                               | lokal (MSIX, MCPB) und Remote                       | lokal                         | –                                                           | Prerelease / Public Preview                       | **lohnt nicht** (dynamische Tool-Liste, Containment)                |
| Copilot-App unter Windows                                          | nicht dokumentiert                                  | –                             | –                                                           | –                                                 | **kein Weg gefunden**                                               |
| Security Copilot                                                   | Streamable HTTP (SSE abschaltbar)                   | Cloud                         | OAuth, AADDelegated                                         | Preview                                           | **nicht machbar** (destruktive Tools ausgeschlossen)                |

## 1. Microsoft Copilot Studio

Belegt:

- MCP in Copilot Studio unterstützt **Tools und Ressourcen**, keine Prompts; **generative
  Orchestrierung** muss an sein ([agent-extend-action-mcp][cs-extend], ms.date 2026-08-26,
  aktualisiert 2026-10-17, kein Preview-Hinweis). Die Seite gilt für die „standard harness“.
- Transport: „Currently, Copilot Studio supports the Streamable transport type“; SSE wird seit
  August 2025 nicht mehr unterstützt. Zwei Wege: der MCP-Onboarding-Assistent (empfohlen; Name,
  Beschreibung, **Server-URL**, Auth) oder ein benutzerdefinierter Connector in Power Apps aus einer
  OpenAPI-YAML mit `x-ms-agentic-protocol: mcp-streamable-1.0`. Auth: keine, API-Key (Header oder
  Query; „The user of the agent provides the API key“) oder OAuth 2.0 als „Dynamic discovery“ (DCR
  mit Discovery), „Dynamic“ (DCR ohne Discovery) oder „Manual“. MCP läuft über
  Power-Platform-Connectors, also gelten DLP-Richtlinien des Tenants auch für MCP-Server. Dritter
  Weg: Registrierung im Agent-365-Register (siehe §2) ([mcp-add-existing-server-to-agent][cs-add],
  ms.date 2026-10-30).
- Custom Connectors brauchen OpenAPI 2.0, unter 1 MB; für On-Premises-APIs verweist die Seite auf das
  Datengateway ([define-openapi-definition][pp-openapi], ms.date 2026-06-03).
- Bekannte Probleme mit Tool-Schemas: `exclusiveMinimum` als Zahl wirft eine
  `System.FormatException`, ein `type` als Array schneidet das Schema ab, Tools mit Referenztypen
  werden ausgefiltert, Enums werden als String behandelt ([mcp-troubleshooting][cs-trouble], ms.date
  2025-10-20, aktualisiert 2026-10-15).
- Für eigene Server nennt Microsoft nur die MCP-SDKs und API-Key oder OAuth 2.0
  ([mcp-create-new-server][cs-create], ms.date 2026-08-25).
- Copilot Studio hat drei „Harnesses“: Standard, GitHub Copilot (nicht der GitHub-Copilot-Dienst,
  abgerechnet in Copilot Credits) und Customer Conversation ([harnesses-overview][cs-harness], ms.date
  2026-10-19).
- GitHub-Copilot-Harness (Preview): eigener MCP-Server per **HTTPS**-URL, „reachable from Copilot
  Studio“; die Zahl gleichzeitig laufender MCP-Server je Unterhaltung ist gedeckelt (ohne Zahl)
  ([tools-add-mcp-server][cs-gh-mcp], ms.date 2026-10-16). Tool-Call-Timeout 120 s, 200 Tool-Calls je
  Turn; diese Agenten laufen auch in Teams und Microsoft 365 Copilot ([runtime-limits][cs-limits],
  ms.date 2026-10-13).

Lokaler Server, Gateway, Dev Tunnel:

- Keine Copilot-Studio-Seite beschreibt einen lokalen MCP-Server, ein Datengateway oder einen Dev
  Tunnel für MCP. Für MCP über das On-Premises-Datengateway habe ich keine Microsoft-Seite gefunden,
  nur Erfahrungsberichte Dritter (nicht verwendet).
- Für lokale MCP-Server empfiehlt Microsoft auf der Microsoft-365-Seite einen Dev Tunnel mit
  anonymem Zugang, ausdrücklich zum Debuggen ([plugin-debug-local][m365-debug]), ebenso die
  Cowork-Doku ([cowork-plugin-development][cowork]).
- **Schluss:** Gateway und Tunnel lösen nur die Erreichbarkeit, nicht den Transport; beide leiten
  HTTP weiter. sevdesk-mcp spricht nur stdio (`serveStdio` in `src/cli.ts`), jeder Copilot-Studio-Weg
  braucht also zuerst einen HTTP-Endpunkt. Ein anonymer Tunnel auf den eigenen Rechner öffnet die
  Buchhaltung für alle, die die URL kennen, solange der Server selbst keine Anmeldung prüft.

Passt sevdesk-mcp zu den Grenzen? (**Schluss**, aus dem Code)

- Schemas: `search` hat `{ code: string }` (Pflicht), `execute` hat `code`, `confirm` und `account`
  (Enum) ohne `required`. Keiner der bekannten Problemfälle trifft; dass das `account`-Enum als String
  ankommt, fängt `selectProfile()` ab.
- Annotations, MCP-`instructions` und Elicitation erwähnt Copilot Studio nicht. Die Bestätigungsregel
  steht aber auch in der `execute`-Beschreibung, das trägt.
- 120 s Tool-Timeout liegen über dem längsten `execute` (siehe Laufzeit unten).

**Urteil:** braucht eine Remote-Variante.

## 2. Microsoft 365 Copilot und Agent 365

Belegt:

- MCP- und API-Plugins gibt es nur als Aktionen deklarativer Agenten, nicht als eigenständige
  Funktion in Microsoft 365 Copilot ([plugin-confirmation-prompts][m365-confirm], ms.date 2026-07-14).
- Weg 1, deklarativer Agent: Agents Toolkit ab 6.12.0 → „Declarative Agent“ → „Start with an MCP
  Server“ → URL; Auth OAuth statisch, OAuth mit DCR, Entra SSO oder keine. Das Plugin-Manifest
  „connects the agent to a remote MCP server; it doesn't package or host the running server“. Zum
  Sideloaden müssen „Custom App Upload Enabled“ und „Copilot Access Enabled“ gesetzt sein
  ([build-mcp-plugins][m365-build], ms.date 2026-09-30).
- Plugin-Manifest 2.4: Runtime `RemoteMCPServer`, `spec.url` „MUST be a valid absolute URL“; Tools
  gepinnt (`mcp_tool_description` im Format von `tools/list`) oder dynamisch
  (`run_for_functions: ["*"]`); Strings „SHOULD be limited to 4K characters“; Funktionsnamen `^[A-Za-z0-9_]+$`
  ([plugin-manifest-2.4][m365-manifest]). Bei dynamischer Discovery prüfen RAI- und XPIA-Klassifikatoren
  jedes neue oder geänderte Tool, bevor es aktiv wird ([plugin-dynamic-tool-discovery][m365-dynamic],
  ms.date 2026-10-28).
- Weg 2, Plugin über das Microsoft-365-App-Manifest: `agentConnectors[].toolSource.remoteMcpServer`
  mit `mcpServerUrl`, Voraussetzung „publicly accessible HTTPS endpoint, TLS 1.2 or later“; Auth
  `None`, `OAuthPluginVault`, `ApiKeyPluginVault`, `DynamicClientRegistration`, `AzureKeyVault`,
  `ConnectionVault` (Developer Preview). Entra ID bietet keinen RFC-7591-Endpunkt
  ([configure-plugin-mcp-servers][m365-connectors], ms.date 2026-10-28). Werkzeug sind die Work IQ Dev
  Tools (WIQD, Preview; `wiqd plugin add connector` ist alpha); Anforderungen an den Server:
  Streamable HTTP, `tools/list` und `tools/call`, **Tool-Calls unter 30 s**
  ([build-reuse-mcp-servers][m365-reuse], ms.date 2026-10-28).
- Bestätigung: Beim ersten Aufruf fragt Copilot immer. Danach fragt es bei jedem Tool ohne
  `readOnlyHint: true` erneut und zeigt die zu sendenden Daten. Bei dynamischer Discovery ist die
  Tool-`description` aus `tools/list` der Bestätigungstext ([plugin-confirmation-prompts][m365-confirm]).
  Ob `destructiveHint` bei deklarativen Agenten wirkt, steht nicht da.
- Copilot Cowork: Connectors sind Remote-MCP-Server (Streamable HTTP, HTTPS ab TLS 1.2, unter 30 s je
  Tool-Call). Bestätigung bei `readOnlyHint == false` oder `destructiveHint == true`; Tools ohne
  Annotations gelten als destruktiv. Für große APIs empfiehlt Microsoft dort ausdrücklich „Search +
  execute“ ([cowork-plugin-development][cowork], ms.date 2026-10-02, aktualisiert 2026-11-03).
- Lizenz: Custom Actions in deklarativen Agenten gehen auch in Copilot Chat ohne
  Microsoft-365-Copilot-Lizenz; mit dem Agents Toolkit entwickelst du ohne Lizenz, das Hochladen
  eigener Apps muss im Teams Admin Center erlaubt sein ([prerequisites][m365-prereq], ms.date
  2026-09-30).
- Agent 365, „Bring your own MCP server“ (Preview): öffentlich erreichbare Server-URL, Auth `NoAuth`,
  `APIKey`, `ExternalOAuth` oder `EntraOAuth`; Registrierung per
  `a365 develop-mcp register-external-mcp-server` mit fester Tool-Liste, danach Freigabe durch
  Admin:innen im Microsoft 365 Admin Center. Clients in der Preview: Copilot Studio, VS Code, Claude
  Code, GitHub Copilot CLI; **deklarative Agenten nicht**. In der Preview lassen sich keine neuen
  Versionen nachreichen ([manage-byo-mcp-server][a365-byo], ms.date 2026-11-05).

**Schluss:** Jeder Weg hier ist remote. Gut passt, dass M365 und Cowork vor jedem `execute` selbst
nachfragen: Das ist eine zweite, menschliche Sicherung vor der Token-Bestätigung. Weniger gut: Die
rund 2.300 Zeichen lange `execute`-Beschreibung würde zum Bestätigungstext, und die 30-s-Grenze von
Cowork und WIQD ist knapper als ein langes `execute`.

**Urteil:** braucht eine Remote-Variante, für Cowork zusätzlich ein `execute` unter 30 s.

## 3. Windows: MCP on Windows (ODR) und die Copilot-App

Belegt:

- Das Windows On-device Agent Registry (ODR) listet lokale (MSIX, MCPB) und Remote-Server, CLI
  `odr.exe`; die Seite trägt einen Prerelease-Hinweis. Als Konsumenten nennt sie den
  Windows-Settings-Connector, GitHub Copilot Agent Mode in Visual Studio und VS Code sowie das
  Microsoft Agent Framework ([MCP on Windows overview][win-overview], ms.date 2025-12-06, aktualisiert
  2026-06-04).
- Zur Ignite 2025 waren MCP on Windows und das ODR in Public Preview; Microsoft 365 Copilot taucht nur
  über den Dynamics-365-Agenten mit dem File-Explorer-Connector auf. Ob Microsofts
  Copilot-Erlebnisse fremde ODR-Server nutzen, steht nicht da ([Windows Developer Blog][win-ignite]).
- Registrierung: `odr.exe mcp add <mcpb-manifest.json>` (lokal) oder `--uri` (remote), ab Windows
  Build 26220.7262 ([mcp-manual][win-manual]). Ein MCPB braucht
  `_meta["com.microsoft.windows"].static_responses` für `initialize` und `tools/list`, die zur
  Laufzeit exakt stimmen müssen; der Server „must not dynamically change the set of tools, their
  descriptions, or input or output schemas“ ([mcp-mcpb][win-mcpb], ms.date 2025-11-11).
- Containment: Standardmäßig läuft ein Server in einer eigenen Agent-Sitzung unter eigenem Konto,
  ohne Zugriff auf Nutzerdateien (nur mit Zustimmung), Einstellungen, Registry und **Anmeldedaten**
  des Nutzers. Voraussetzung ist ein `.exe` mit Paketidentität (MSIX). MCPB-Server laufen nicht
  contained und sind nur mit „Reduce protections for agent connectors“ erreichbar, gedacht zum Testen
  ([mcp-containment][win-contain], ms.date 2025-11-11).

**Schluss:**

- sevdesk-mcp liefert absichtlich eine dynamische `tools/list`: Das `account`-Enum hängt an den
  eingerichteten Profilen, die Beschreibungen an den Limits der Konfigurationsdatei (`src/execute.ts`,
  `src/search.ts`). Das verträgt sich nicht mit `static_responses`.
- Contained gäbe es keinen Zugriff auf den Windows Credential Manager, also keine
  Schlüsselbund-Profile (Entscheidung 9), und `~/Downloads/sevdesk` nur nach Zustimmung. Ein Node-Skript
  ist kein `.exe`; nötig wären ein Single-Executable-Build, MSIX und eine Signatur.
- Die Konsumenten sind dieselben GitHub-Copilot-Hosts, die sevdesk-mcp ohnehin direkt starten. Kein
  Mehrwert.
- Copilot-App unter Windows: Ich habe keine Erstquelle gefunden, die dort fremde MCP-Server anbindet.

**Urteil:** ODR lohnt nicht; für die Copilot-App gibt es keinen dokumentierten Weg.

## 4. GitHub Copilot

Belegt:

- **VS Code:** zwei Formate. `.vscode/mcp.json` bzw. `mcp.json` im Nutzerprofil mit `servers`, dazu
  `inputs` (`promptString` mit `password: true`), `envFile` und Sandbox (nur macOS/Linux; mit Sandbox
  werden Tool-Bestätigungen automatisch erteilt). Das portable Copilot-Format liegt in `.mcp.json` oder
  `$COPILOT_HOME/mcp-config.json` (Fallback `~/.copilot/mcp-config.json`) mit `mcpServers`.
  Transporte stdio, HTTP, SSE. VS Code **entdeckt die Copilot-CLI-Datei standardmäßig**, Claude
  Desktop nur auf Wunsch (`chat.mcp.discovery.enabled`); Copilot-Harness-Sitzungen lesen das portable
  Format direkt, Server mit `${input:…}` bekommen sie nicht ([MCP configuration reference][vsc-conf],
  DateApproved 11/4/2026).
- VS Code unterstützt Tools, Prompts, Ressourcen, Elicitation, Sampling, Authentifizierung,
  Server-Instructions, Roots und MCP Apps. Für Tools mit `readOnlyHint` fragt es nicht nach, für alle
  anderen zeigt es einen Bestätigungsdialog mit editierbaren Parametern; Installation auch per
  `code --add-mcp` oder `vscode:mcp/install` ([MCP developer guide][vsc-api]). Höchstens 128 Tools je
  Anfrage ([Use tools with agents][vsc-tools]).
- **Copilot CLI:** `~/.copilot/mcp-config.json` (bzw. `COPILOT_HOME`) mit `mcpServers`. Lokaler
  Server: `type` `"local"` oder `"stdio"` (Standard `local`), `command` und `args` Pflicht, **`tools`
  Pflicht** (`["*"]` für alle), `env` mit `$VAR`/`${VAR}`/`${VAR:-default}`, `cwd`, `timeout`
  (Standard 30000 ms für Discovery und Tool-Calls). `copilot mcp add NAME -- COMMAND ARGS` schreibt
  dorthin. Vorrang: `--additional-mcp-config` vor Plugins vor `.mcp.json`/`.github/mcp.json` vor der
  Nutzerdatei. Server-Instructions kommen nur bei allowlisteten Servern gleich in den Systemprompt,
  sonst bei Bedarf. MCP-Aufrufe unterliegen den Rechten der Sitzung, z. B.
  `--allow-tool='MyMCP(create_issue)'` ([CLI command reference][gh-cli-ref]).
- Copilot CLI: „The `PATH` variable is automatically inherited from your environment. All other
  environment variables must be configured here.“ Registry-URL und Allowlist der Organisation gelten
  auch hier ([Adding MCP servers for Copilot CLI][gh-cli-mcp]).
- **Visual Studio** (2022 ab 17.14, 2026): liest `%USERPROFILE%\.mcp.json` (global),
  `<SOLUTIONDIR>\.vs\mcp.json`, `.mcp.json`, `.vscode\mcp.json`, `.cursor\mcp.json`; Format
  `servers`; stdio und HTTP/SSE. Jeder Tool-Aufruf wird bestätigt (merkbar für Sitzung, Solution oder
  immer), neue Tools sind zunächst **deaktiviert**, ab 18.7 fragt ein Trust-Dialog nach, wenn sich
  Tools oder Instructions ändern; Allowlist-Richtlinien der Organisation gelten
  ([Visual Studio: MCP servers][vs-mcp], ms.date 2026-05-26, aktualisiert 2026-10-14).
- **JetBrains, Xcode, Eclipse:** lokale und Remote-Server, Format `servers`, eingerichtet über die IDE
  ([Extending Copilot Chat with MCP][gh-ide]).
- **Richtlinie:** „MCP servers in Copilot“ gilt für Copilot Business und Enterprise und ist
  **standardmäßig aus**; Free, Pro, Pro+ und Max betrifft sie nicht ([Extending Copilot Chat with
  MCP][gh-ide]).
- **Cloud agent:** nutzt MCP-Tools autonom, ohne zu fragen; nur Tools, keine Ressourcen oder Prompts;
  Secrets nur mit Präfix `COPILOT_MCP_`. Copilot Code Review nutzt nur Tools mit `readOnlyHint: true`
  ([Configure MCP servers for your repository][gh-cloud]).

**Schluss:**

- Funktioniert heute ohne Codeänderung. Ein Eintrag in `~/.copilot/mcp-config.json` reicht für Copilot
  CLI und VS Code; bis zum npm-Release mit dem lokalen Build statt `npx` (wie `launchArgv()`):

  ```json
  {
    "mcpServers": {
      "sevdesk": {
        "type": "local",
        "command": "npx",
        "args": ["-y", "@erwins-enkel/sevdesk-mcp", "--profile", "manufare"],
        "tools": ["*"],
        "timeout": 120000
      }
    }
  }
  ```

  Den `timeout` von 120 s schlage ich vor (siehe Laufzeit unten); er ist keine Vorgabe von GitHub.
  Visual Studio braucht dasselbe als `servers` mit `"type": "stdio"` in `%USERPROFILE%\.mcp.json`. Ob
  Visual Studio `npx` unter Windows ohne `cmd /c` startet (bei Claude Code nötig), ist ungeprüft.

- Annotations passen: `search` (`readOnlyHint`) läuft in VS Code ohne Rückfrage, `execute`
  (`destructiveHint`) fragt jedes Mal, zusätzlich zur eigenen Token-Bestätigung.
- Umgebung: Wenn die Copilot CLI wirklich nur `PATH` weitergibt, fehlen dem Server unter Linux
  womöglich `DBUS_SESSION_BUS_ADDRESS` (Secret Service für den Schlüsselbund) und ein angepasstes
  `XDG_CONFIG_HOME` (dann findet er die Konfigurationsdatei nicht). macOS und Windows trifft das
  weniger, weil `src/paths.ts` auf `homedir()` zurückfällt. Vor einem `setup`-Eintrag per Smoke-Test
  prüfen; Abhilfe wäre `env` mit `${DBUS_SESSION_BUS_ADDRESS}` usw.
- Cloud agent: Niemand bestätigt dort, das Modell könnte das `confirm`-Token selbst einlösen; der
  sevDesk-Token läge als Repository-Secret bei GitHub, PDFs im flüchtigen Runner. Nicht verfolgen.

**Urteil:** geht heute; mit einer neuen `CLIENTS`-Zeile auch über `setup`.

## 5. Weitere „Copilot“ mit MCP

- **Security Copilot** (Preview): YAML-Manifest mit `Endpoint`, `UseStreamableHttp`, `AllowedTools`,
  `TimeoutInSeconds`; nur Tools; Tools mit `destructiveHint: true` werden nicht importiert; nur
  primitive Eingabetypen ([Security Copilot MCP plugins][sec-mcp], ms.date 2025-11-13, aktualisiert
  2026-04-28). **Schluss:** `execute` fiele weg, und fachlich passt Buchhaltung dort nicht hin.
- **Copilot Studio, Customer-Conversation-Harness:** hat eine eigene MCP-Seite (Preview), nicht
  einzeln geprüft; laut [harnesses-overview][cs-harness] nutzt er MCP wie die anderen Harnesses.

## Was das für sevdesk-mcp heißt

### Host-Grenzen gegen sevdesk-mcp

| Punkt          | sevdesk-mcp heute                                                              | Grenze beim Host                                                                                           | Folge                                                         |
| -------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Transport      | nur stdio (`serveStdio`)                                                       | Microsoft-Cloud-Hosts: nur Streamable HTTP an HTTPS-URL                                                    | Copilot Studio, M365, Agent 365 brauchen eine Remote-Variante |
| Tool-Schemas   | 2 Tools, nur Strings, `account` als Enum, `execute` ohne `required`            | Copilot Studio: Enum → String; Security Copilot: nur primitive Typen; ODR: statisch                        | passt überall außer ODR                                       |
| Annotations    | `search` read-only; `execute` destructive (read-only im Read-only-Modus)       | VS Code, VS, M365, Cowork fragen bei nicht-read-only nach; Security Copilot schließt destruktive Tools aus | doppelte Bestätigung, gut; Security Copilot fällt weg         |
| Laufzeit       | Sandbox 30 s; Kontoprüfung und Vorschau-Lesen haben je ein eigenes 30-s-Signal | Copilot CLI 30 s (einstellbar), Cowork/WIQD < 30 s, Copilot Studio 120 s                                   | siehe unten                                                   |
| Ergebnisgröße  | auf 20.000 Zeichen gekürzt                                                     | für MCP nirgends beziffert                                                                                 | unkritisch                                                    |
| Dateien        | `~/Downloads/sevdesk/<profil>`                                                 | Cloud-Host sieht dein Dateisystem nicht                                                                    | Remote braucht einen neuen Weg                                |
| `instructions` | Teil des 1.500-Token-Budgets                                                   | VS Code nutzt sie; CLI lädt sie bei Bedarf; Microsoft-Cloud: nicht dokumentiert                            | Regeln stehen zum Glück auch in den Tool-Beschreibungen       |

**Schluss, Laufzeit:** `execute` setzt Sandbox (`limits.timeoutMs`, Standard 30 s), Kontoprüfung
(`checkAccount()`) und Vorschau (`previewHeld()`) je mit eigenem `AbortSignal.timeout(timeoutMs)` auf
(`src/execute.ts`). Im ungünstigsten Fall dauert ein Aufruf also länger als 30 s. Bricht der Host
dann ab, kommt das Ergebnis mit der `writes`-Liste nie beim Modell an, und ein schon angelegter
Entwurf bleibt unbemerkt (nur das Audit-Log weiß davon). Das widerspricht dem Zweck von 0002 Nr. 11.

### Was eine Remote-HTTP-Variante konkret bedeutet

1. **Transport:** `@modelcontextprotocol/server` 2.4.0 bringt `createMcpHandler(factory, options)`
   mit: Er bedient die Protokollrevision 2026-07-28 pro Anfrage und fällt für 2025er-Clients standardmäßig
   auf zustandsloses Streamable HTTP zurück (`legacy: 'stateless'`); für `node:http` gibt es
   `toNodeHandler` aus `@modelcontextprotocol/node` (2.1.2, neue Abhängigkeit). Eine Token-Prüfung
   macht der Handler nicht; dafür gibt es `requireBearerAuth`, `verifyBearerToken` und
   `buildOAuthProtectedResourceMetadata` (Typdefinitionen im [npm-Paket][sdk-server]). Die Revision
   2026-07-28 streicht Sitzungen und `Mcp-Session-Id`; Zustand über mehrere Aufrufe läuft über vom
   Server ausgegebene Handles in normalen Tool-Argumenten ([MCP changelog 2026-07-28][mcp-changelog]).
2. **Zustand pro Anfrage (Schluss):** Die Factory läuft pro HTTP-Anfrage. `createServer()` passt
   formal als Factory, aber `registerExecuteTool()` legt `createConfirmations()` und die `checks`-Map in
   seiner Closure an, also wäre beides bei jeder Anfrage leer und kein `confirm`-Token je einlösbar.
   Beides muss aus der Factory heraus in den Prozess; bei mehreren Instanzen in einen geteilten
   Speicher, oder das Token trägt die zurückgehaltenen Aufrufe verschlüsselt selbst und nur ein
   Replay-Schutz bleibt als Zustand. Das `confirm`-Token ist genau so ein Handle, wie ihn die Spec
   vorsieht.
3. **Anmeldung und Mandant (Schluss):** Heute kommen Profile aus der Konfigurationsdatei und dem
   Schlüsselbund (`src/profile.ts`, `src/keychain.ts`), das `account`-Enum entsteht beim Registrieren.
   Remote liefert die Factory `authInfo` pro Anfrage; daraus müssten Profile und Enum werden. Zwei
   Wege: (a) Copilot Studio im API-Key-Modus, Schlüssel = sevDesk-Token der Nutzer:in. Der Server
   bleibt zustandslos, aber der Token liegt in Microsofts Verbindung und reist bei jedem Aufruf zum
   Server. (b) OAuth (Copilot Studio und M365 können DCR; die Spec 2026-07-28 stuft DCR zugunsten von
   Client ID Metadata Documents als veraltet ein) plus ein serverseitiger Tresor, der Nutzer:innen auf
   sevDesk-Tokens abbildet. Ob sevDesk selbst OAuth anbietet, habe ich nicht geprüft.
4. **Dateien (Schluss):** `savePdf` und Nicht-JSON-Antworten schreiben nach `defaultDownloadDir()`
   (`src/paths.ts`, `src/downloads.ts`). Remote bleiben: das PDF als MCP-Ressource zurückgeben
   (Copilot Studio kann Ressourcen; die Binärdaten kämen dann in die Nähe des Kontexts, gegen
   0002 Nr. 14), ein kurzlebiger signierter Download-Link (Speicher, also Zustand) oder ein
   Upload nach OneDrive/SharePoint (Graph-Zugriff, noch eine Anmeldung).
5. **Audit-Log (Schluss):** `src/audit.ts` schreibt pro Profil eine lokale JSONL-Datei mit
   `O_APPEND`. Gehostet braucht es einen persistenten Ablageort pro Mandant, bei mehreren Instanzen
   keinen gemeinsamen Dateipfad.
6. **Betrieb (Schluss):** öffentliches HTTPS (TLS ab 1.2), Verfügbarkeit (Cowork empfiehlt 99,9 % für
   Store-Apps), Ratenbegrenzung pro Mandant, weil eine Instanz mehrere sevDesk-Konten bedient; ein
   Fehler in der Sandbox trifft dann alle. DLP-Richtlinien und die Agent-365-Freigabe liegen beim
   Kunden-Tenant. Update-Check (§5.6) und `setup` entfallen dort.
7. **Laufzeit:** `execute` muss sicher unter 30 s bleiben, wenn Cowork/WIQD Ziel sind (siehe oben).

### Konflikte mit Produktentscheidungen

- **PRD §5.5** („kein Server-Zustand außer Profilen“): Bestätigungsspeicher über Anfragen hinweg,
  Token-Tresor, Audit-Ablage und PDF-Speicher sind Server-Zustand.
- **PRD §11** („Kein Webhosting“): Eine Remote-Variante ist Webhosting. PRD §9 nennt sie nur als
  „später: evtl.“.
- **Entscheidung 9 / 0002 Nr. 4** (Token nur im Schlüsselbund oder `SEVDESK_API_TOKEN`) und **§5.3**
  („Der API-Token verlässt den Host-Prozess nie“): Beides gilt remote nicht mehr wörtlich; im
  API-Key-Modus liegt der Token bei Microsoft und wandert pro Aufruf zum Server.
- **Entscheidung 7 / 0002 Nr. 21, 22** (Netz nur sevDesk und npm): Remote kommt eingehendes HTTP aus
  Microsofts Cloud dazu. Dass Ergebnisse an den KI-Anbieter gehen, sagt das README schon.
- **0002 Nr. 14, 15** (Ablage im Download-Ordner): Remote gibt es keinen.
- **Entscheidung 3 / 0002 Nr. 5** (Bestätigung): bleibt intakt, solange ein Mensch im Dialog sitzt;
  im GitHub Copilot cloud agent sitzt keiner.
- **Entscheidung 1** (`account`-Enum aus den erreichbaren Profilen): verträgt sich nicht mit den
  statischen `tools/list`-Antworten, die das ODR verlangt.

### Empfehlungen, nach Aufwand und Nutzen

| #   | Was                                                 | Aufwand  | Nutzen                                       | Konkret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------- | -------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GitHub Copilot von Hand testen und im README zeigen | XS       | mittel                                       | Priorität A einmal in VS Code und Copilot CLI mit dem Eintrag oben; README-Abschnitt mit Copilot-CLI- und Visual-Studio-Eintrag und dem Hinweis auf die Business/Enterprise-Richtlinie                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2   | `setup` trägt in GitHub Copilot ein                 | S        | mittel bis hoch                              | neue `CLIENTS`-Zeile „GitHub Copilot (CLI, VS Code)“ in `src/clients.ts`: `copilotHome()` in `src/paths.ts` (`COPILOT_HOME`, sonst `~/.copilot`; relativ → unbekannt, wie `codexHome()`), Datei `mcp-config.json`, Format `CLAUDE_JSON` wiederverwendbar (Schlüssel `mcpServers`, Rest bleibt), Eintrag `{ type: 'local', command, args, tools: ['*'], timeout }`; `profileEntries()` liest `command`/`args` schon. `test/setup.ts` muss `COPILOT_HOME` löschen; PRD §3 und 0002 Nr. 18 ergänzen. VS Code braucht keine eigene Zeile (Discovery). Vorher Smoke-Test zur Umgebung (oben) |
| 3   | `execute` an Host-Timeouts anpassen                 | S        | mittel                                       | Gesamtfrist für Lauf, Kontoprüfung und Vorschau statt drei einzelner, oder `timeout` im Client-Eintrag dokumentieren; sonst gehen `writes` bei Abbruch verloren                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Visual Studio in `setup`                            | S        | niedrig                                      | Windows-only, `%USERPROFILE%\.mcp.json` mit `servers`: braucht ein JSON-Format mit wählbarem Schlüssel; erst nach Nr. 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Remote-Variante für Copilot Studio, M365, Teams     | L bis XL | hoch, falls Kund:innen in M365 das Ziel sind | erst eine ADR, die PRD §5.5/§11 und Entscheidungen 7/9 neu fasst; dann ein Spike: eigener Befehl (z. B. `serve --http`), `createMcpHandler`, Bestätigungsspeicher aus der Factory, ein Mandant, API-Key-Modus in Copilot Studio, Dev Tunnel nur zum Testen                                                                                                                                                                                                                                                                                                                              |
| 6   | Nicht verfolgen                                     | –        | –                                            | ODR/MSIX (dynamische Tool-Liste, Containment), Security Copilot (destruktive Tools ausgeschlossen), Copilot cloud agent (kein Mensch für `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Offene Fragen an dich

1. Wen meinst du mit „Microsoft Copilot“: dich selbst in VS Code/Copilot CLI, oder Kund:innen, die in
   Teams bzw. Microsoft 365 Copilot arbeiten? Nur das Zweite braucht die Remote-Variante.
2. Ist Webhosting überhaupt eine Option (PRD §11)? Wenn ja: zentral von dir betrieben oder pro Kund:in
   im eigenen Azure-Tenant?
3. Token-Modell: sevDesk-Token als API-Key durch Copilot Studio (liegt dann bei Microsoft), oder
   eigener OAuth-Server mit Tresor? Bietet sevDesk OAuth an?
4. Wohin sollen PDFs remote: OneDrive/SharePoint, Download-Link oder gar nicht (nur sevDesk-Versand)?
5. Welche Lizenzen haben die Zielkund:innen (Copilot Studio, Microsoft 365 Copilot, Pay-as-you-go)?

### Nicht aus Erstquellen belegt

- Ob die Copilot-App unter Windows fremde MCP-/ODR-Server nutzt: keine Erstquelle gefunden.
- MCP über das On-Premises-Datengateway: keine Microsoft-Seite, nur Berichte Dritter.
- Copilot Studio: Umgang mit Annotations, `instructions` und Elicitation; konkrete Obergrenzen für
  gleichzeitige MCP-Server, Tools je Agent und Antwortgröße bei MCP.
- Microsoft 365 Copilot: Wirkung von `destructiveHint` bei deklarativen Agenten; Timeout und
  Antwortgröße außerhalb von WIQD/Cowork.
- Ob die Copilot CLI tatsächlich nur `PATH` weitergibt und was das für den Schlüsselbund heißt (Doku
  sagt es so, Folgen sind abgeleitet).
- Konfigurationspfad von GitHub Copilot in JetBrains, Xcode und Eclipse (nur „über die IDE“).
- OAuth bei sevDesk (nicht recherchiert).

## Quellen

Alle abgerufen am 2026-11-10. „Stand“ ist das `ms.date` bzw. `DateApproved` der Seite, sofern sie
eins trägt; „aktualisiert“ das `updated_at`.

| Quelle                                                                                         | Stand                               | Label                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| [Copilot Studio: Extend your agent with MCP (de-de, Kais Link)][cs-extend-de]                  | wie en-us                           | –                               |
| [Copilot Studio: Extend your agent with MCP][cs-extend]                                        | 2026-08-26, aktualisiert 2026-10-17 | –                               |
| [Copilot Studio: Connect your agent to an existing MCP server][cs-add]                         | 2026-10-30, aktualisiert 2026-11-02 | –                               |
| [Copilot Studio: Troubleshooting MCP integration][cs-trouble]                                  | 2025-10-20, aktualisiert 2026-10-15 | –                               |
| [Copilot Studio: Create a new MCP server][cs-create]                                           | 2026-08-25                          | –                               |
| [Copilot Studio: Harnesses][cs-harness]                                                        | 2026-10-19                          | –                               |
| [Copilot Studio: Add an MCP server as a tool (GitHub Copilot harness)][cs-gh-mcp]              | 2026-10-16                          | Preview                         |
| [Copilot Studio: Agent runtime limits][cs-limits]                                              | 2026-10-13                          | –                               |
| [Power Platform: Custom connector from an OpenAPI definition][pp-openapi]                      | 2026-06-03                          | –                               |
| [Agent 365: Bring your own MCP server][a365-byo]                                               | 2026-11-05                          | Preview                         |
| [M365 Copilot: Build a plugin for a declarative agent from an MCP server][m365-build]          | 2026-09-30                          | –                               |
| [M365 Copilot: Dynamic tool discovery for MCP plugins][m365-dynamic]                           | 2026-10-28                          | –                               |
| [M365 Copilot: Plugin manifest schema 2.4][m365-manifest]                                      | 2026-09-30                          | –                               |
| [M365 Copilot: Configure remote MCP servers for plugins][m365-connectors]                      | 2026-10-28                          | –                               |
| [M365 Copilot: Build or reuse MCP servers][m365-reuse]                                         | 2026-10-28                          | WIQD Preview                    |
| [M365 Copilot: Debug MCP and API plugins locally][m365-debug]                                  | 2026-04-23                          | –                               |
| [M365 Copilot: Confirmation prompts for MCP and API plugins][m365-confirm]                     | 2026-07-14                          | –                               |
| [M365 Copilot: Set up your development environment][m365-prereq]                               | 2026-09-30                          | –                               |
| [Copilot Cowork: Build plugins][cowork]                                                        | 2026-10-02, aktualisiert 2026-11-03 | –                               |
| [MCP on Windows overview][win-overview]                                                        | 2025-12-06, aktualisiert 2026-06-04 | Prerelease                      |
| [Windows: Manually register MCP servers][win-manual]                                           | 2025-08-12                          | Prerelease                      |
| [Windows: Register an MCP server with an MCP bundle][win-mcpb]                                 | 2025-11-11                          | Prerelease                      |
| [Windows: Securely containing MCP servers][win-contain]                                        | 2025-11-11                          | Prerelease                      |
| [Windows Developer Blog: Ignite 2025][win-ignite]                                              | 2025-11-18                          | Public Preview (MCP on Windows) |
| [VS Code: MCP configuration reference][vsc-conf]                                               | 11/4/2026                           | –                               |
| [VS Code: MCP developer guide][vsc-api]                                                        | 11/4/2026                           | –                               |
| [VS Code: Use tools with agents][vsc-tools]                                                    | 11/4/2026                           | –                               |
| [Visual Studio: Use MCP servers][vs-mcp]                                                       | 2026-05-26, aktualisiert 2026-10-14 | –                               |
| [GitHub Docs: Extending Copilot Chat with MCP][gh-ide]                                         | –                                   | MCP-Registry Public Preview     |
| [GitHub Docs: Copilot CLI command reference][gh-cli-ref]                                       | –                                   | –                               |
| [GitHub Docs: Adding MCP servers for Copilot CLI][gh-cli-mcp]                                  | –                                   | –                               |
| [GitHub Docs: Configure MCP servers for your repository (cloud agent)][gh-cloud]               | –                                   | –                               |
| [Security Copilot: MCP plugins][sec-mcp]                                                       | 2025-11-13, aktualisiert 2026-04-28 | Preview                         |
| [MCP-Spezifikation 2026-07-28: Changelog][mcp-changelog]                                       | 2026-07-28                          | –                               |
| [npm: @modelcontextprotocol/server 2.4.0][sdk-server] (Typdefinitionen von `createMcpHandler`) | 2.4.0                               | –                               |
| [npm: @modelcontextprotocol/node][sdk-node]                                                    | 2.1.2                               | –                               |

[cs-extend-de]: https://learn.microsoft.com/de-de/microsoft-copilot-studio/agent-extend-action-mcp
[cs-extend]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp
[cs-add]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent
[cs-trouble]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-troubleshooting
[cs-create]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-create-new-server
[cs-harness]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/harnesses-overview
[cs-gh-mcp]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/tools-add-mcp-server
[cs-limits]: https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/runtime-limits
[pp-openapi]: https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition
[a365-byo]: https://learn.microsoft.com/en-us/microsoft-agent-365/admin/manage-byo-mcp-server
[m365-build]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins
[m365-dynamic]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-dynamic-tool-discovery
[m365-manifest]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4
[m365-connectors]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/configure-plugin-mcp-servers
[m365-reuse]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-reuse-mcp-servers
[m365-debug]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-debug-local
[m365-confirm]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-confirmation-prompts
[m365-prereq]: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/prerequisites
[cowork]: https://learn.microsoft.com/en-us/copilot/cowork/cowork-plugin-development
[win-overview]: https://learn.microsoft.com/en-us/windows/ai/mcp/overview
[win-manual]: https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-manual
[win-mcpb]: https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-mcpb
[win-contain]: https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-containment
[win-ignite]: https://blogs.windows.com/windowsdeveloper/2025/11/18/ignite-2025-furthering-windows-as-the-premier-platform-for-developers-governed-by-security/
[vsc-conf]: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
[vsc-api]: https://code.visualstudio.com/api/extension-guides/ai/mcp
[vsc-tools]: https://code.visualstudio.com/docs/agents/run/tools
[vs-mcp]: https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=visualstudio
[gh-ide]: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp
[gh-cli-ref]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
[gh-cli-mcp]: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
[gh-cloud]: https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers
[sec-mcp]: https://learn.microsoft.com/en-us/copilot/security/plugin-mcp
[mcp-changelog]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[sdk-server]: https://www.npmjs.com/package/@modelcontextprotocol/server
[sdk-node]: https://www.npmjs.com/package/@modelcontextprotocol/node
