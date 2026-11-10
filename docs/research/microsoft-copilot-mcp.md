# Microsoft Copilot and sevdesk-mcp

- As of: 2026-11-10; all sources accessed that day (list at the end).
- Question: "Could sevdesk-mcp also work with Microsoft Copilot?", prompted by
  [Copilot Studio: extend an agent with MCP][cs-extend-de].
- Status: **not pursued for now** (operator decision, 2026-11-10). This note is the reference for a
  later decision on a remote variant (PRD §9, "later").
- Reading guide: statements with a link come from the linked primary source (Microsoft Learn,
  code.visualstudio.com, docs.github.com, modelcontextprotocol.io, the MCP SDK's npm package). An
  **Inference:** is a conclusion for sevdesk-mcp that no source states. "Decision N" means the
  product decisions in `CLAUDE.md`, "0002 No. N" the entry in
  `docs/decisions/0002-product-decisions.md`.

## Summary

Partly. **GitHub Copilot** (VS Code, Visual Studio, JetBrains, Copilot CLI) starts local stdio
servers and can use sevdesk-mcp today: added by hand, without a code change. A new `CLIENTS` row for
`~/.copilot/mcp-config.json` would let `setup` do it, and VS Code reads that file by default.
**Copilot Studio**, **Microsoft 365 Copilot** (declarative agents, Teams, Cowork) and the **Agent 365
registry** only talk to remote MCP servers over Streamable HTTP at an HTTPS URL that Microsoft's cloud
can reach. They cannot reach a local stdio process, and Microsoft documents no gateway for it.
**MCP on Windows (ODR)** is in preview and adds nothing VS Code cannot already do. For the **Copilot
app on Windows** no documented way to add third-party MCP servers was found.

What the Microsoft cloud hosts (Copilot Studio, Microsoft 365 Copilot, Agent 365) require:

1. **A reachable HTTPS URL, wherever it is hosted.** Azure is not a category of its own: Microsoft
   only requires a URL its cloud can reach. Azure, another provider or an own server all qualify,
   and an own instance in Azure is just as reachable from outside. No Microsoft page describes a
   private-network or On-premises data gateway route for MCP.
2. **Reachable does not mean open.** The server has to authenticate every request itself, with an
   API key or OAuth; Copilot Studio supports both. Without that, anyone with the URL reaches the
   bookkeeping.
3. **Hosting alone is not enough.** sevdesk-mcp speaks only stdio today. It first needs an HTTP
   variant, and that means rebuilding parts of it: sign-in per user, a sevDesk token per user, a new
   way to deliver PDFs and a confirmation store that survives across requests. Today that conflicts
   with PRD §5.5 and §11 and with decisions 7 and 9, so it would be a project of its own.

## Overview

| Copilot product                                                    | MCP transport                                          | Local/cloud               | Auth                                                       | Status                                          | Verdict for sevdesk-mcp                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------- | ---------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| GitHub Copilot in VS Code                                          | stdio, HTTP (Streamable, SSE fallback)                 | local: starts the process | stdio: none; HTTP: OAuth, headers                          | no preview label (MCP registry: public preview) | **works today**; the `setup` row (below) covers it too   |
| GitHub Copilot CLI                                                 | `local`/`stdio`, `http`, `sse`                         | local                     | `env`, headers                                             | no status label                                 | **works today**; small change: a new `CLIENTS` row       |
| GitHub Copilot in Visual Studio                                    | stdio, HTTP/SSE                                        | local (Windows)           | remote: OAuth                                              | no preview label                                | **works today** by hand; optional `CLIENTS` row          |
| GitHub Copilot in JetBrains, Xcode, Eclipse                        | stdio, HTTP                                            | local                     | remote: headers                                            | supported per GitHub Docs                       | works by hand, not checked individually                  |
| GitHub Copilot cloud agent                                         | `local`/`stdio` in the Actions runner, `http`, `sse`   | cloud (GitHub)            | secrets `COPILOT_MCP_*`                                    | –                                               | technically possible, **not sensible** (no human to ask) |
| Copilot Studio, standard harness                                   | Streamable HTTP only                                   | cloud → public HTTPS URL  | none, API key, OAuth 2.0 (DCR with discovery, DCR, manual) | no preview label                                | **needs a remote variant**                               |
| Copilot Studio, GitHub Copilot harness                             | HTTPS URL                                              | cloud                     | depends on the server                                      | preview                                         | **needs a remote variant**                               |
| Microsoft 365 Copilot: declarative agents (Copilot Chat, Teams)    | `RemoteMCPServer` (absolute URL)                       | cloud                     | none, static OAuth, OAuth DCR, Entra SSO                   | no preview label                                | **needs a remote variant**                               |
| Microsoft 365 Copilot: plugins (`agentConnectors`), Copilot Cowork | Streamable HTTP, HTTPS with TLS 1.2+, tool call < 30 s | cloud                     | none, OAuth/API key vault, DCR and others                  | WIQD preview, `plugin add connector` alpha      | **needs a remote variant**, plus the 30 s limit          |
| Agent 365, BYO MCP                                                 | remote, publicly reachable                             | cloud gateway             | NoAuth, APIKey, ExternalOAuth, EntraOAuth                  | preview                                         | only a governance layer on top of a remote variant       |
| MCP on Windows (ODR)                                               | local (MSIX, MCPB) and remote                          | local                     | –                                                          | prerelease / public preview                     | **not worth it** (dynamic tool list, containment)        |
| Copilot app on Windows                                             | not documented                                         | –                         | –                                                          | –                                               | **no way found**                                         |
| Security Copilot                                                   | Streamable HTTP (SSE can be turned off)                | cloud                     | OAuth, AADDelegated                                        | preview                                         | **not feasible** (destructive tools excluded)            |

## 1. Microsoft Copilot Studio

Verified:

- MCP in Copilot Studio supports **tools and resources**, not prompts; **generative orchestration**
  must be on ([agent-extend-action-mcp][cs-extend], ms.date 2026-08-26, updated 2026-10-17, no
  preview note). The page applies to the "standard harness".
- Transport: "Currently, Copilot Studio supports the Streamable transport type"; SSE has not been
  supported since August 2025. Two ways in: the MCP onboarding wizard (recommended; name,
  description, **server URL**, auth) or a custom connector in Power Apps from an OpenAPI YAML with
  `x-ms-agentic-protocol: mcp-streamable-1.0`. Auth: none, API key (header or query; "The user of the
  agent provides the API key") or OAuth 2.0 as "Dynamic discovery" (DCR with discovery), "Dynamic"
  (DCR without discovery) or "Manual". MCP runs through Power Platform connectors, so the tenant's
  DLP policies apply to MCP servers too. A third way: registration in the Agent 365 registry (see
  §2) ([mcp-add-existing-server-to-agent][cs-add], ms.date 2026-10-30).
- Custom connectors need OpenAPI 2.0, under 1 MB; for on-premises APIs the page points to the data
  gateway ([define-openapi-definition][pp-openapi], ms.date 2026-06-03).
- Known problems with tool schemas: `exclusiveMinimum` as a number throws a
  `System.FormatException`, a `type` given as an array truncates the schema, tools with reference
  types are filtered out, enums are treated as strings ([mcp-troubleshooting][cs-trouble], ms.date
  2025-10-20, updated 2026-10-15).
- For own servers Microsoft names only the MCP SDKs and API key or OAuth 2.0
  ([mcp-create-new-server][cs-create], ms.date 2026-08-25).
- Copilot Studio has three "harnesses": standard, GitHub Copilot (not the GitHub Copilot service;
  billed in Copilot Credits) and customer conversation ([harnesses-overview][cs-harness], ms.date
  2026-10-19).
- GitHub Copilot harness (preview): own MCP server by **HTTPS** URL, "reachable from Copilot
  Studio"; the number of MCP servers running at once per conversation is capped (no number given)
  ([tools-add-mcp-server][cs-gh-mcp], ms.date 2026-10-16). Tool call timeout 120 s, 200 tool calls
  per turn; these agents also run in Teams and Microsoft 365 Copilot ([runtime-limits][cs-limits],
  ms.date 2026-10-13).

Local server, gateway, dev tunnel:

- No Copilot Studio page describes a local MCP server, a data gateway or a dev tunnel for MCP. For
  MCP through the On-premises data gateway no Microsoft page was found, only third-party reports
  (not used).
- For local MCP servers Microsoft recommends, on the Microsoft 365 page, a dev tunnel with anonymous
  access, explicitly for debugging ([plugin-debug-local][m365-debug]); so do the Cowork docs
  ([cowork-plugin-development][cowork]).
- **Inference:** a gateway or a tunnel only solves reachability, not the transport; both forward
  HTTP. sevdesk-mcp speaks only stdio (`serveStdio` in `src/cli.ts`), so every Copilot Studio route
  first needs an HTTP endpoint. An anonymous tunnel to the own machine opens the bookkeeping to
  anyone who knows the URL, as long as the server itself checks no sign-in.

Does sevdesk-mcp fit the limits? (**Inference**, from the code)

- Schemas: `search` has `{ code: string }` (required); `execute` has `code`, `confirm` and `account`
  (enum) without `required`. None of the known problem cases applies; that the `account` enum
  arrives as a string is handled by `selectProfile()`.
- Copilot Studio does not mention annotations, MCP `instructions` or elicitation. The confirmation
  rule is also in the `execute` description, which carries it.
- The 120 s tool timeout is above the longest `execute` (see runtime below).

**Verdict:** needs a remote variant.

## 2. Microsoft 365 Copilot and Agent 365

Verified:

- MCP and API plugins exist only as actions of declarative agents, not as a standalone feature of
  Microsoft 365 Copilot ([plugin-confirmation-prompts][m365-confirm], ms.date 2026-07-14).
- Route 1, declarative agent: Agents Toolkit 6.12.0 or later → "Declarative Agent" → "Start with an
  MCP Server" → URL; auth static OAuth, OAuth with DCR, Entra SSO or none. The plugin manifest
  "connects the agent to a remote MCP server; it doesn't package or host the running server".
  Sideloading needs "Custom App Upload Enabled" and "Copilot Access Enabled"
  ([build-mcp-plugins][m365-build], ms.date 2026-09-30).
- Plugin manifest 2.4: runtime `RemoteMCPServer`, `spec.url` "MUST be a valid absolute URL"; tools
  pinned (`mcp_tool_description` in the `tools/list` format) or dynamic (`run_for_functions: ["*"]`);
  strings "SHOULD be limited to 4K characters"; function names `^[A-Za-z0-9_]+$`
  ([plugin-manifest-2.4][m365-manifest]). With dynamic discovery, RAI and XPIA classifiers check
  every new or changed tool before it becomes active
  ([plugin-dynamic-tool-discovery][m365-dynamic], ms.date 2026-10-28).
- Route 2, plugin through the Microsoft 365 app manifest: `agentConnectors[].toolSource.remoteMcpServer`
  with `mcpServerUrl`, requirement "publicly accessible HTTPS endpoint, TLS 1.2 or later"; auth
  `None`, `OAuthPluginVault`, `ApiKeyPluginVault`, `DynamicClientRegistration`, `AzureKeyVault`,
  `ConnectionVault` (developer preview). Entra ID offers no RFC 7591 endpoint
  ([configure-plugin-mcp-servers][m365-connectors], ms.date 2026-10-28). The tooling is the Work IQ
  Dev Tools (WIQD, preview; `wiqd plugin add connector` is alpha); server requirements: Streamable
  HTTP, `tools/list` and `tools/call`, **tool calls under 30 s**
  ([build-reuse-mcp-servers][m365-reuse], ms.date 2026-10-28).
- Confirmation: on the first call Copilot always asks. After that it asks again for every tool
  without `readOnlyHint: true` and shows the data to be sent. With dynamic discovery the tool's
  `description` from `tools/list` is the confirmation text
  ([plugin-confirmation-prompts][m365-confirm]). Whether `destructiveHint` has an effect for
  declarative agents is not stated.
- Copilot Cowork: connectors are remote MCP servers (Streamable HTTP, HTTPS with TLS 1.2+, under 30 s
  per tool call). Confirmation when `readOnlyHint == false` or `destructiveHint == true`; tools
  without annotations count as destructive. For large APIs Microsoft explicitly recommends "Search +
  execute" there ([cowork-plugin-development][cowork], ms.date 2026-10-02, updated 2026-11-03).
- Licensing: custom actions in declarative agents also work in Copilot Chat without a Microsoft 365
  Copilot licence; with the Agents Toolkit you develop without a licence, and uploading custom apps
  must be allowed in the Teams admin center ([prerequisites][m365-prereq], ms.date 2026-09-30).
- Agent 365, "Bring your own MCP server" (preview): publicly reachable server URL, auth `NoAuth`,
  `APIKey`, `ExternalOAuth` or `EntraOAuth`; registration with
  `a365 develop-mcp register-external-mcp-server` and a fixed tool list, then approval by admins in
  the Microsoft 365 admin center. Clients in the preview: Copilot Studio, VS Code, Claude Code,
  GitHub Copilot CLI; **not declarative agents**. New versions cannot be submitted during the preview
  ([manage-byo-mcp-server][a365-byo], ms.date 2026-11-05).

**Inference:** every route here is remote. A good fit: Microsoft 365 Copilot and Cowork ask before
every `execute` themselves, a second, human check before the token confirmation. Less good: the
roughly 2,300-character `execute` description would become the confirmation text, and the 30 s limit
of Cowork and WIQD is tighter than a long `execute`.

**Verdict:** needs a remote variant, and for Cowork also an `execute` under 30 s.

## 3. Windows: MCP on Windows (ODR) and the Copilot app

Verified:

- The Windows On-device Agent Registry (ODR) lists local (MSIX, MCPB) and remote servers, CLI
  `odr.exe`; the page carries a prerelease note. As consumers it names the Windows Settings
  connector, GitHub Copilot agent mode in Visual Studio and VS Code, and the Microsoft Agent
  Framework ([MCP on Windows overview][win-overview], ms.date 2025-12-06, updated 2026-06-04).
- At Ignite 2025, MCP on Windows and the ODR were in public preview; Microsoft 365 Copilot appears
  only through the Dynamics 365 agent with the File Explorer connector. Whether Microsoft's Copilot
  experiences use third-party ODR servers is not stated ([Windows Developer Blog][win-ignite]).
- Registration: `odr.exe mcp add <mcpb-manifest.json>` (local) or `--uri` (remote), from Windows
  build 26220.7262 ([mcp-manual][win-manual]). An MCPB needs
  `_meta["com.microsoft.windows"].static_responses` for `initialize` and `tools/list`, which must
  match exactly at runtime; the server "must not dynamically change the set of tools, their
  descriptions, or input or output schemas" ([mcp-mcpb][win-mcpb], ms.date 2025-11-11).
- Containment: by default a server runs in its own agent session under its own account, without
  access to the user's files (only with consent), settings, registry and **credentials**. It
  requires an `.exe` with package identity (MSIX). MCPB servers do not run contained and are only
  reachable with "Reduce protections for agent connectors", meant for testing
  ([mcp-containment][win-contain], ms.date 2025-11-11).

**Inference:**

- sevdesk-mcp deliberately serves a dynamic `tools/list`: the `account` enum depends on the
  configured profiles, the descriptions on the config file's limits (`src/execute.ts`,
  `src/search.ts`). That does not fit `static_responses`.
- Contained, there would be no access to the Windows Credential Manager, so no keychain profiles
  (decision 9), and `~/Downloads/sevdesk` only after consent. A Node script is no `.exe`; it would
  need a single-executable build, MSIX and a signature.
- The consumers are the same GitHub Copilot hosts that start sevdesk-mcp directly anyway. No added
  value.
- Copilot app on Windows: no primary source was found that connects third-party MCP servers there.

**Verdict:** ODR is not worth it; for the Copilot app there is no documented way.

## 4. GitHub Copilot

Verified:

- **VS Code:** two formats. `.vscode/mcp.json` or `mcp.json` in the user profile with `servers`,
  plus `inputs` (`promptString` with `password: true`), `envFile` and a sandbox (macOS/Linux only;
  with the sandbox, tool confirmations are granted automatically). The portable Copilot format lives
  in `.mcp.json` or `$COPILOT_HOME/mcp-config.json` (fallback `~/.copilot/mcp-config.json`) with
  `mcpServers`. Transports stdio, HTTP, SSE. VS Code **discovers the Copilot CLI file by default**,
  Claude Desktop's only on request (`chat.mcp.discovery.enabled`); Copilot harness sessions read the
  portable format directly, servers with `${input:…}` do not reach them
  ([MCP configuration reference][vsc-conf], DateApproved 11/4/2026).
- VS Code supports tools, prompts, resources, elicitation, sampling, authentication, server
  instructions, roots and MCP Apps. It does not ask for tools with `readOnlyHint`; for all others it
  shows a confirmation dialog with editable parameters; installation also via `code --add-mcp` or
  `vscode:mcp/install` ([MCP developer guide][vsc-api]). At most 128 tools per request
  ([Use tools with agents][vsc-tools]).
- **Copilot CLI:** `~/.copilot/mcp-config.json` (or `COPILOT_HOME`) with `mcpServers`. Local server:
  `type` `"local"` or `"stdio"` (default `local`), `command` and `args` required, **`tools`
  required** (`["*"]` for all), `env` with `$VAR`/`${VAR}`/`${VAR:-default}`, `cwd`, `timeout`
  (default 30000 ms for discovery and tool calls). `copilot mcp add NAME -- COMMAND ARGS` writes
  there. Precedence: `--additional-mcp-config` over plugins over `.mcp.json`/`.github/mcp.json` over
  the user file. Server instructions go straight into the system prompt only for allowlisted
  servers, otherwise on demand. MCP calls are subject to the session's permissions, e.g.
  `--allow-tool='MyMCP(create_issue)'` ([CLI command reference][gh-cli-ref]).
- Copilot CLI: "The `PATH` variable is automatically inherited from your environment. All other
  environment variables must be configured here." The organisation's registry URL and allowlist
  apply here too ([Adding MCP servers for Copilot CLI][gh-cli-mcp]).
- **Visual Studio** (2022 from 17.14, 2026): reads `%USERPROFILE%\.mcp.json` (global),
  `<SOLUTIONDIR>\.vs\mcp.json`, `.mcp.json`, `.vscode\mcp.json`, `.cursor\mcp.json`; format
  `servers`; stdio and HTTP/SSE. Every tool call is confirmed (rememberable for the session, the
  solution or always), new tools start **disabled**, from 18.7 a trust dialog asks when tools or
  instructions change; the organisation's allowlist policies apply
  ([Visual Studio: MCP servers][vs-mcp], ms.date 2026-05-26, updated 2026-10-14).
- **JetBrains, Xcode, Eclipse:** local and remote servers, format `servers`, set up through the IDE
  ([Extending Copilot Chat with MCP][gh-ide]).
- **Policy:** "MCP servers in Copilot" applies to Copilot Business and Enterprise and is **off by
  default**; Free, Pro, Pro+ and Max are not affected ([Extending Copilot Chat with MCP][gh-ide]).
- **Cloud agent:** uses MCP tools autonomously, without asking; tools only, no resources or prompts;
  secrets only with the prefix `COPILOT_MCP_`. Copilot code review uses only tools with
  `readOnlyHint: true` ([Configure MCP servers for your repository][gh-cloud]).

**Inference:**

- Works today without a code change. One entry in `~/.copilot/mcp-config.json` covers Copilot CLI
  and VS Code; until the npm release, with the local build instead of `npx` (as `launchArgv()`
  writes it):

  ```json
  {
    "mcpServers": {
      "sevdesk": {
        "type": "local",
        "command": "npx",
        "args": ["-y", "@erwins-enkel/sevdesk-mcp", "--profile", "my-profile"],
        "tools": ["*"],
        "timeout": 120000
      }
    }
  }
  ```

  The 120 s `timeout` is a suggestion (see runtime below), not a GitHub default. Visual Studio needs
  the same as `servers` with `"type": "stdio"` in `%USERPROFILE%\.mcp.json`. Whether Visual Studio
  starts `npx` on Windows without `cmd /c` (needed for Claude Code) is unverified.

- Annotations fit: `search` (`readOnlyHint`) runs in VS Code without a prompt, `execute`
  (`destructiveHint`) asks every time, on top of the own token confirmation.
- Environment: if the Copilot CLI really passes only `PATH`, the server on Linux may lack
  `DBUS_SESSION_BUS_ADDRESS` (Secret Service for the keychain) and a custom `XDG_CONFIG_HOME` (then
  it does not find the config file). macOS and Windows are less affected because `src/paths.ts`
  falls back to `homedir()`. Check with a smoke test before adding a `setup` entry; the remedy would
  be `env` with `${DBUS_SESSION_BUS_ADDRESS}` and so on.
- Cloud agent: nobody confirms there, the model could redeem the `confirm` token itself; the sevDesk
  token would sit at GitHub as a repository secret, PDFs in the ephemeral runner. Do not pursue.

**Verdict:** works today; with a new `CLIENTS` row also through `setup`.

## 5. Other "Copilots" with MCP

- **Security Copilot** (preview): YAML manifest with `Endpoint`, `UseStreamableHttp`,
  `AllowedTools`, `TimeoutInSeconds`; tools only; tools with `destructiveHint: true` are not
  imported; primitive input types only ([Security Copilot MCP plugins][sec-mcp], ms.date 2025-11-13,
  updated 2026-04-28). **Inference:** `execute` would be dropped, and bookkeeping does not belong
  there anyway.
- **Copilot Studio, customer conversation harness:** has its own MCP page (preview), not checked
  individually; per [harnesses-overview][cs-harness] it uses MCP like the other harnesses.

## What this means for sevdesk-mcp

### Host limits against sevdesk-mcp

| Topic          | sevdesk-mcp today                                                             | Host limit                                                                                         | Consequence                                                     |
| -------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Transport      | stdio only (`serveStdio`)                                                     | Microsoft cloud hosts: Streamable HTTP to an HTTPS URL only                                        | Copilot Studio, M365, Agent 365 need a remote variant           |
| Tool schemas   | 2 tools, strings only, `account` as an enum, `execute` without `required`     | Copilot Studio: enum → string; Security Copilot: primitive types only; ODR: static                 | fits everywhere except ODR                                      |
| Annotations    | `search` read-only; `execute` destructive (read-only in read-only mode)       | VS Code, VS, M365, Cowork ask for non-read-only tools; Security Copilot excludes destructive tools | double confirmation, good; Security Copilot is out              |
| Runtime        | sandbox 30 s; account check and preview reads each have their own 30 s signal | Copilot CLI 30 s (configurable), Cowork/WIQD < 30 s, Copilot Studio 120 s                          | see below                                                       |
| Result size    | cut at 20,000 characters                                                      | not quantified for MCP anywhere                                                                    | uncritical                                                      |
| Files          | `~/Downloads/sevdesk/<profile>`                                               | a cloud host cannot see your file system                                                           | remote needs a new way                                          |
| `instructions` | part of the 1,500-token budget                                                | VS Code uses them; the CLI loads them on demand; Microsoft cloud: not documented                   | the rules are also in the tool descriptions, which is fortunate |

**Inference, runtime:** `execute` sets up the sandbox (`limits.timeoutMs`, default 30 s), the
account check (`checkAccount()`) and the preview (`previewHeld()`) each with its own
`AbortSignal.timeout(timeoutMs)` (`src/execute.ts`). In the worst case one call therefore takes
longer than 30 s. If the host aborts then, the result with the `writes` ledger never reaches the
model, and an already created draft goes unnoticed (only the audit log knows about it). That defeats
the purpose of 0002 No. 11.

### What a remote HTTP variant concretely means

1. **Transport:** `@modelcontextprotocol/server` 2.4.0 ships `createMcpHandler(factory, options)`:
   it serves protocol revision 2026-07-28 per request and by default falls back to stateless
   Streamable HTTP for 2025-era clients (`legacy: 'stateless'`); for `node:http` there is
   `toNodeHandler` from `@modelcontextprotocol/node` (2.1.2, a new dependency). The handler does no
   token check; for that there are `requireBearerAuth`, `verifyBearerToken` and
   `buildOAuthProtectedResourceMetadata` (type definitions in the [npm package][sdk-server]).
   Revision 2026-07-28 drops sessions and `Mcp-Session-Id`; state across calls goes through
   server-minted handles in ordinary tool arguments ([MCP changelog 2026-07-28][mcp-changelog]).
2. **State per request (inference):** the factory runs per HTTP request. `createServer()` fits
   formally as the factory, but `registerExecuteTool()` creates `createConfirmations()` and the
   `checks` map in its closure, so both would be empty on every request and no `confirm` token could
   ever be redeemed. Both must move out of the factory into the process; with several instances into
   a shared store, or the token carries the held calls itself, encrypted, and only a replay guard
   remains as state. The `confirm` token is exactly such a handle as the spec intends.
3. **Sign-in and tenant (inference):** today profiles come from the config file and the keychain
   (`src/profile.ts`, `src/keychain.ts`), and the `account` enum is built at registration. Remotely
   the factory gets `authInfo` per request; profiles and the enum would have to come from it. Two
   options: (a) Copilot Studio in API-key mode, key = the user's sevDesk token. The server stays
   stateless, but the token sits in Microsoft's connection and travels to the server with every
   call. (b) OAuth (Copilot Studio and M365 support DCR; spec 2026-07-28 deprecates DCR in favour of
   Client ID Metadata Documents) plus a server-side vault that maps users to sevDesk tokens. Whether
   sevDesk itself offers OAuth was not checked.
4. **Files (inference):** `savePdf` and non-JSON responses write to `defaultDownloadDir()`
   (`src/paths.ts`, `src/downloads.ts`). Remote options: return the PDF as an MCP resource (Copilot
   Studio supports resources; the binary data would come close to the context, against 0002 No. 14),
   a short-lived signed download link (storage, so state) or an upload to OneDrive/SharePoint (Graph
   access, one more sign-in).
5. **Audit log (inference):** `src/audit.ts` writes one local JSONL file per profile with `O_APPEND`.
   Hosted, it needs persistent storage per tenant, and with several instances no shared file path.
6. **Operations (inference):** public HTTPS (TLS 1.2+), availability (Cowork recommends 99.9 % for
   store apps), rate limiting per tenant, because one instance serves several sevDesk accounts; a
   sandbox bug then hits everyone. DLP policies and the Agent 365 approval sit with the customer
   tenant. The update check (§5.6) and `setup` do not apply there.
7. **Runtime:** `execute` must stay safely under 30 s if Cowork/WIQD are targets (see above).

### Conflicts with product decisions

- **PRD §5.5** ("no server state besides profiles"): a confirmation store across requests, a token
  vault, audit storage and PDF storage are server state.
- **PRD §11** ("no web hosting"): a remote variant is web hosting. PRD §9 lists it only as "later:
  maybe".
- **Decision 9 / 0002 No. 4** (token only in the keychain or `SEVDESK_API_TOKEN`) and **§5.3** ("the
  API token never leaves the host process"): neither holds literally when remote; in API-key mode
  the token sits at Microsoft and travels to the server with every call.
- **Decision 7 / 0002 No. 21, 22** (network only to sevDesk and npm): remote adds inbound HTTP from
  Microsoft's cloud. That results go to the AI provider is already in the README.
- **0002 No. 14, 15** (files in the download folder): remote there is none.
- **Decision 3 / 0002 No. 5** (confirmation): stays intact as long as a human is in the dialogue; in
  the GitHub Copilot cloud agent there is none.
- **Decision 1** (`account` enum from the reachable profiles): does not fit the static `tools/list`
  responses the ODR requires.

### Recommendations by effort and value

Not pursued for now (see Status); kept as the starting point for a later decision.

| #   | What                                                  | Effort  | Value                                     | Concretely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------- | ------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Test GitHub Copilot by hand and show it in the README | XS      | medium                                    | Run Priority A once in VS Code and the Copilot CLI with the entry above; a README section with the Copilot CLI and Visual Studio entries and a note on the Business/Enterprise policy                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | `setup` registers in GitHub Copilot                   | S       | medium to high                            | New `CLIENTS` row "GitHub Copilot (CLI, VS Code)" in `src/clients.ts`: `copilotHome()` in `src/paths.ts` (`COPILOT_HOME`, else `~/.copilot`; relative → unknown, like `codexHome()`), file `mcp-config.json`, the `CLAUDE_JSON` format can be reused (key `mcpServers`, the rest stays), entry `{ type: 'local', command, args, tools: ['*'], timeout }`; `profileEntries()` already reads `command`/`args`. `test/setup.ts` must unset `COPILOT_HOME`; amend PRD §3 and 0002 No. 18. VS Code needs no row of its own (discovery). Smoke-test the environment first (above) |
| 3   | Fit `execute` to host timeouts                        | S       | medium                                    | One overall deadline for the run, the account check and the preview instead of three separate ones, or document `timeout` in the client entry; otherwise `writes` are lost on an abort                                                                                                                                                                                                                                                                                                                                                                                      |
| 4   | Visual Studio in `setup`                              | S       | low                                       | Windows only, `%USERPROFILE%\.mcp.json` with `servers`: needs a JSON format with a configurable key; only after No. 2                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | Remote variant for Copilot Studio, M365, Teams        | L to XL | high, if customers in M365 are the target | First an ADR that revises PRD §5.5/§11 and decisions 7/9; then a spike: own command (e.g. `serve --http`), `createMcpHandler`, confirmation store out of the factory, one tenant, API-key mode in Copilot Studio, dev tunnel for testing only                                                                                                                                                                                                                                                                                                                               |
| 6   | Do not pursue                                         | –       | –                                         | ODR/MSIX (dynamic tool list, containment), Security Copilot (destructive tools excluded), Copilot cloud agent (no human for `confirm`)                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Open questions for a later decision

1. Who is "Microsoft Copilot" meant for: the operator in VS Code/Copilot CLI, or customers working in
   Teams or Microsoft 365 Copilot? Only the second needs the remote variant.
2. Is web hosting an option at all (PRD §11)? If so: run centrally by the operator or per customer in
   their own Azure tenant?
3. Token model: the sevDesk token as an API key through Copilot Studio (it then sits at Microsoft),
   or an own OAuth server with a vault? Does sevDesk offer OAuth?
4. Where should PDFs go remotely: OneDrive/SharePoint, a download link or nowhere (sevDesk mail
   only)?
5. Which licences do the target customers have (Copilot Studio, Microsoft 365 Copilot,
   pay-as-you-go)?

### Not verified from primary sources

- Whether the Copilot app on Windows uses third-party MCP/ODR servers: no primary source found.
- MCP through the On-premises data gateway: no Microsoft page, only third-party reports.
- Copilot Studio: handling of annotations, `instructions` and elicitation; concrete caps on
  concurrent MCP servers, tools per agent and response size for MCP.
- Microsoft 365 Copilot: the effect of `destructiveHint` for declarative agents; timeout and response
  size outside WIQD/Cowork.
- Whether the Copilot CLI really passes only `PATH` and what that means for the keychain (the docs
  say so, the consequences are inferred).
- Config file path of GitHub Copilot in JetBrains, Xcode and Eclipse (only "through the IDE").
- OAuth at sevDesk (not researched).

## Sources

All accessed on 2026-11-10. "As of" is the page's `ms.date` or `DateApproved` where it carries one;
"updated" is its `updated_at`.

| Source                                                                                         | As of                          | Label                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------- |
| [Copilot Studio: Extend your agent with MCP (de-de, the link in the question)][cs-extend-de]   | same as en-us                  | –                               |
| [Copilot Studio: Extend your agent with MCP][cs-extend]                                        | 2026-08-26, updated 2026-10-17 | –                               |
| [Copilot Studio: Connect your agent to an existing MCP server][cs-add]                         | 2026-10-30, updated 2026-11-02 | –                               |
| [Copilot Studio: Troubleshooting MCP integration][cs-trouble]                                  | 2025-10-20, updated 2026-10-15 | –                               |
| [Copilot Studio: Create a new MCP server][cs-create]                                           | 2026-08-25                     | –                               |
| [Copilot Studio: Harnesses][cs-harness]                                                        | 2026-10-19                     | –                               |
| [Copilot Studio: Add an MCP server as a tool (GitHub Copilot harness)][cs-gh-mcp]              | 2026-10-16                     | Preview                         |
| [Copilot Studio: Agent runtime limits][cs-limits]                                              | 2026-10-13                     | –                               |
| [Power Platform: Custom connector from an OpenAPI definition][pp-openapi]                      | 2026-06-03                     | –                               |
| [Agent 365: Bring your own MCP server][a365-byo]                                               | 2026-11-05                     | Preview                         |
| [M365 Copilot: Build a plugin for a declarative agent from an MCP server][m365-build]          | 2026-09-30                     | –                               |
| [M365 Copilot: Dynamic tool discovery for MCP plugins][m365-dynamic]                           | 2026-10-28                     | –                               |
| [M365 Copilot: Plugin manifest schema 2.4][m365-manifest]                                      | 2026-09-30                     | –                               |
| [M365 Copilot: Configure remote MCP servers for plugins][m365-connectors]                      | 2026-10-28                     | –                               |
| [M365 Copilot: Build or reuse MCP servers][m365-reuse]                                         | 2026-10-28                     | WIQD preview                    |
| [M365 Copilot: Debug MCP and API plugins locally][m365-debug]                                  | 2026-04-23                     | –                               |
| [M365 Copilot: Confirmation prompts for MCP and API plugins][m365-confirm]                     | 2026-07-14                     | –                               |
| [M365 Copilot: Set up your development environment][m365-prereq]                               | 2026-09-30                     | –                               |
| [Copilot Cowork: Build plugins][cowork]                                                        | 2026-10-02, updated 2026-11-03 | –                               |
| [MCP on Windows overview][win-overview]                                                        | 2025-12-06, updated 2026-06-04 | Prerelease                      |
| [Windows: Manually register MCP servers][win-manual]                                           | 2025-08-12                     | Prerelease                      |
| [Windows: Register an MCP server with an MCP bundle][win-mcpb]                                 | 2025-11-11                     | Prerelease                      |
| [Windows: Securely containing MCP servers][win-contain]                                        | 2025-11-11                     | Prerelease                      |
| [Windows Developer Blog: Ignite 2025][win-ignite]                                              | 2025-11-18                     | Public preview (MCP on Windows) |
| [VS Code: MCP configuration reference][vsc-conf]                                               | 11/4/2026                      | –                               |
| [VS Code: MCP developer guide][vsc-api]                                                        | 11/4/2026                      | –                               |
| [VS Code: Use tools with agents][vsc-tools]                                                    | 11/4/2026                      | –                               |
| [Visual Studio: Use MCP servers][vs-mcp]                                                       | 2026-05-26, updated 2026-10-14 | –                               |
| [GitHub Docs: Extending Copilot Chat with MCP][gh-ide]                                         | –                              | MCP registry public preview     |
| [GitHub Docs: Copilot CLI command reference][gh-cli-ref]                                       | –                              | –                               |
| [GitHub Docs: Adding MCP servers for Copilot CLI][gh-cli-mcp]                                  | –                              | –                               |
| [GitHub Docs: Configure MCP servers for your repository (cloud agent)][gh-cloud]               | –                              | –                               |
| [Security Copilot: MCP plugins][sec-mcp]                                                       | 2025-11-13, updated 2026-04-28 | Preview                         |
| [MCP specification 2026-07-28: changelog][mcp-changelog]                                       | 2026-07-28                     | –                               |
| [npm: @modelcontextprotocol/server 2.4.0][sdk-server] (type definitions of `createMcpHandler`) | 2.4.0                          | –                               |
| [npm: @modelcontextprotocol/node][sdk-node]                                                    | 2.1.2                          | –                               |

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
