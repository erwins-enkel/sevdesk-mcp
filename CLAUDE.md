# sevdesk-mcp

A local, open-source MCP server (stdio) that makes the whole sevDesk API usable for AI
assistants through two tools, `search` and `execute`, in Code Mode: the model writes small
JavaScript snippets that run in a local QuickJS sandbox against the sevDesk API, and only the
result goes back into the context. Published as `@erwins-enkel/sevdesk-mcp` (MIT).

- Product source of truth: `docs/prd/PRD-sevdesk.md` (German).
- Foundation decisions and their rationale: `docs/decisions/0001-foundation.md`.
- Product decisions and their rationale: `docs/decisions/0002-product-decisions.md`.
- Status: the M0 Code Mode spine is in place (version 0.0.0, not yet on npm). `search` runs in the
  QuickJS sandbox with the patched spec and the guides; `execute` reads sevDesk, runs reversible
  writes (listed in the result's `writes` ledger), holds every irreversible call until
  `execute({ confirm })`, and saves PDFs (`savePdf`) and non-JSON responses in the profile's
  download directory, within the limits and base URL of the optional config file. Profiles come
  from `SEVDESK_API_TOKEN` or the config file, their tokens from the OS keychain. Read-only mode
  (`SEVDESK_READONLY` or a profile's `readonly`) rejects every write and irreversible call; every
  write call gets a line in the monthly audit log unless the config file sets `audit: false`.
  `sevdesk-mcp setup` adds a profile (token into the OS keychain) and registers it in the
  installed Claude Desktop, Claude Code, ChatGPT Desktop / Codex and OpenCode (run from a local
  checkout, with an entry that starts its build, for the beta before npm), `setup --list`
  lists the profiles and `setup --remove <name>` removes one with its token and client entries;
  `sevdesk-mcp config` changes profiles, client entries and the audit switch in a terminal menu.
  Priority A runs end to end against the spec-following mock in `bun run test`, and by hand
  against a real account with `bun run test:e2e`. Not built yet (PRD §9): the update checks, the
  `.mcpb`, the release workflow, receipt upload, elicitation and the curated v2 tools.

## Orientation

- `src/cli.ts`: the `sevdesk-mcp` bin. No command starts the MCP server on stdio,
  `--profile <name>` starts it pinned to that profile; `setup` (or `setup --add`) adds a profile
  through `runSetup()`, `setup --remove <name>` removes one through `runRemove()` and `config` opens
  the menu through `runConfig()`, all only on a terminal (stdin and stdout TTYs, else exit 1;
  `interactive()`); `setup --list` lists the profiles through `runList()` without one; `--help` prints the usage, `--version` the version from
  `src/manifest.ts` (the same source `createServer()` reports). Exit codes: 0 success, 1 runtime
  failure, 2 usage error (unknown command or option); the usage text documents them.
- `src/setup.ts`: `runSetup(locale, io)`, the setup dialogue (PRD §7, decisions 4, 18, 19):
  profile name, keychain probe before the token is asked, hidden token, bookkeeping system and
  company checked against sevDesk (`bookkeepingSystem()`, `companyName()` via the undocumented
  `GET /SevClient`), read-only (default no, or the replaced profile's value), then the token into
  the keychain and the profile into the config file (`saveProfile()`). Every stop before that stores
  nothing. Then it says which kind of entry the clients get (`launchKind()`: `npx` or the local
  build), `registerClients()` asks per installed client (`installedClients()`) and
  `unregisterClients()` does the same after `--remove`; a cancel there reports `setup.clientsLeft`,
  and a client config that fails makes the run resolve false. `runList(locale, out)` prints every
  profile with company and read-only state in columns from the config file alone (never the keychain). `runRemove(locale, io, name)` asks (default no), then
  deletes the token (`deleteToken()`) before the config entry (`deleteProfile()`), so no token is
  left without a profile. `SetupOutput` has four channels: `print` (info), `heading`, `success`
  (an outcome that went well) and `fail` (stderr); the commands pass unmarked text and the terminal
  edge marks it. `src/prompt.ts`: `createPrompter()`, Node's readline with hidden input;
  Ctrl+C or the end of the input resolves `undefined`, for `ask()` and `choose()` alike.
- `src/terminal.ts`: how `setup` and `config` look on a terminal (decision 19). `MARKS` (`?` question,
  `❯` marked item, `✔` success and picked menu, `›`, `✖` failure; text after a mark starts in the
  third column, unmarked lines are indented by two), `stylesFor()` (SGR only when the stream's
  `hasColors()` is true, which already honours `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb`, so no env
  var is read), `createOutput()` (the `SetupOutput` of `src/cli.ts`), `columns()` and `widthOf()`.
- `src/config-menu.ts`: `runConfig(locale, io)`, the `config` menu (issue #46): an overview
  (config file, audit log, each profile with company, read-only state, download directory and its
  entries per installed client with their kind, `profileEntries()`; never the keychain) and menus
  through `Prompter.choose()` that toggle `readonly` and set or reset `downloadDir`
  (`setProfileKey()`), toggle `audit` (`setAudit()`), and hand off to setup's `runRegister()`,
  `runUnregister()`, `runCheck()` (keychain token against `GET /SevClient` and the bookkeeping
  system), `runRemove()` and `runSetup()`. A cancelled menu leaves every menu at once. The overview
  is laid out with `columns()` and shows paths under the home directory as `~` (`displayPath()`).
  `createPrompter().choose()` draws a menu (`?` title, `❯` marks the item, the key hint below; arrow
  keys, 1 to 9, Enter, Esc or q) on readline's keypress events, muting readline's echo meanwhile.
  It redraws and erases itself by its row count (wrapped rows included): a pick leaves its empty
  line and `✔ title › item`, going back or cancelling leaves nothing.
- `src/server.ts`: `createServer({ pinnedProfile })`, the single place where MCP tools and the
  MCP `instructions` get registered; it reads the config file once per server.
- `src/paths.ts`: `localDirs()`, the OS-standard config and data/state directories (XDG on
  Linux, `~/Library/Application Support` on macOS, `%APPDATA%`/`%LOCALAPPDATA%` on Windows),
  `defaultDownloadDir()`, `~/Downloads/sevdesk/<profile>` unless the profile sets `downloadDir`,
  and the client config locations `claudeDesktopDirs()` (MSIX folder first on Windows),
  `claudeCodeFile()` (`CLAUDE_CONFIG_DIR`), `codexHome()` (`CODEX_HOME`, else `~/.codex`) and
  `openCodeDir()` (`XDG_CONFIG_HOME/opencode` on every OS); a relative override makes the client
  unknowable (undefined). `src/clients.ts`: the MCP clients `setup` registers in (decision 18):
  `CLIENTS` (one row per client: name, installed config file, config format, entry shape; Claude
  Desktop, Claude Code, ChatGPT Desktop / Codex, OpenCode), `entryName()`, `launchKind()` (`npx`
  when `root` of `src/manifest.ts`, the package root, lies under `node_modules`, else `local`),
  `launchArgv()` (never a token; `local` runs `process.execPath` with the checkout's
  `dist/cli.js`), `entryState()`, `entriesUsing()` (this package or this root's build; `profileEntries()` adds each entry's kind) and
  `rewriteServers()` (fresh re-read, a `<file>.sevdesk-mcp-<time>.bak` of the bytes read, then
  the write in the client's format).
  `src/client-formats.ts`: `ConfigFormat` (the servers in a file's text, the text with new servers)
  and its rows: `CLAUDE_JSON` (`mcpServers`, written anew), `CODEX_TOML` (`mcp_servers`, edited with
  `@decimalturn/toml-patch` so comments stay, re-parsed before it is written) and `OPENCODE_JSONC`
  (`mcp`, edited in place with `jsonc-parser` as `opencode mcp add` does; OpenCode 2's
  `mcp.servers` layout is refused). `src/json-file.ts`: `readTextFile()` and `writeTextFile()`
  (temp file then rename, keeps the mode, follows a symlink), with `readJsonFile()` and
  `writeJsonFile()` on top, shared by the config file and the client configs.
  `src/config.ts`: `loadConfig()` reads `config.json` there (`baseUrl`, `limits`, `profiles`
  without tokens, `audit`; documented in the README). No file means `DEFAULT_CONFIG`; an
  unreadable or invalid file is an `invalid_config` error that both tools return instead of
  running. A new config key extends `toConfig()` and the README table. `saveProfile()` adds or
  updates one profile, `deleteProfile()` removes one, `setProfileKey()` sets or removes a profile's
  `readonly` or `downloadDir` and `setAudit()` sets `audit`; all keep every other key.
- `src/sandbox.ts`: `runSnippet()`, the QuickJS sandbox (a fresh WASM module per run, by
  default 30 s and 64 MB, captured `console.log`, error kinds
  `timeout`/`memory_limit`/`snippet_error`). Host functions (`HostFunction`) return promises to
  the code; a `HostError` is catchable there and, uncaught, ends the run with its structured
  error; a fatal one ends the run at once. `src/envelope.ts`: `toToolResult()`, the JSON result
  envelope (`result`, `error`, `console`, `writes`, `confirmation`, `notes`; results over the
  output limit, by default 20,000 characters, are cut), and `confirmedResult()`, the result of a
  confirmation run (`confirmed`, one outcome per held call). `src/search.ts`: the `search` tool.
  `src/guides.ts`: `GUIDES`, the curated recipes `search` offers as `guides` (system 2.0 only;
  endpoints written `METHOD /path`, checked against the patched spec by `test/guides.test.ts`).
- `src/execute.ts`: the `execute` tool (`code` or `confirm`, bookkeeping-system check per profile
  and session, destructive annotation or `readOnlyHint` when `SEVDESK_READONLY` is on or the
  pinned profile is read-only; a run with held calls gets their previews and a token, a failed run
  or preview read drops them). `src/sevdesk.ts`: `createClient()`, the host side of
  `sevdesk.request`, `sevdesk.paginate` and `sevdesk.savePdf` (HTTPS base URL, relative paths only,
  JSON bodies, token added host-side, shared call budget, pages of 1,000, structured errors;
  `request` saves a non-JSON response and holds an irreversible call in `held` as `{ held: true }`;
  with `readOnly` set, `build()` rejects every write and irreversible call as `read_only` first;
  `savePdf` the PDF of a `PDF_TYPES` document with `preventSendBy=true`; `writes` is the run's
  ledger of sent writes with status and object id; `readDocument()` is the preview's counted read);
  `send()` resolves to the 2xx response and retries per decision 10 (`retry: false` sends once);
  `replay()` sends confirmed calls once each, in order, stopping at the first failure. Every write
  call passes the client's `Gate` (read-only reason + audit log): `build()`/`prepare()` write
  `rejected`, `hold()` writes `held`, `sendWrite()` checks the log before sending and writes
  `executed` once settled, `replay()` writes `confirmed`; `settled()` waits for in-flight writes and
  returns the run's first audit failure, which `run()` turns into the run's error.
  `src/audit.ts`: `auditLog()`, the audit log of a profile (decision 16;
  `<state>/audit/<YYYY-MM>.jsonl` per UTC month, one synchronous `O_APPEND` write per line so
  several processes never tear lines; time, profile, method, path, query, status, object id,
  SHA-256 body hash, outcome; never a body or the token; an unwritable log is a fatal
  `audit_error`), and `NO_AUDIT` for `audit: false`.
  `src/confirm.ts`: `previewHeld()`, the structured English preview of held calls (decision 9;
  document kind, number, ISO date, amount with currency, recipient, subject), and
  `createConfirmations()`, the in-memory token store (single use, 10 minutes, bound to the profile
  and the exact stored calls). `src/downloads.ts`: `fileStem()` (a file name that cannot leave its
  directory) and `saveFile()` (temp file, then rename; replace or next free name;
  `download_error`). `src/profile.ts`: tenant resolution (decision 1):
  `reachableProfiles()` (env profile or config profiles, narrowed by `--profile`) and
  `selectProfile()` (`account`, else the only one, else `account_required`). `src/keychain.ts`:
  `readToken()`, a profile's token from the OS keychain via `@napi-rs/keyring` (service
  `sevdesk-mcp`, account = profile name, Linux Secret Service only), loaded lazily on first use;
  `probeKeychain()`, `storeToken()` and `deleteToken()` for `setup`.
- `src/classify.ts`: the classification (PRD §6, decisions 6 and 7). `OPERATIONS` gives every
  operation of the patched spec (`METHOD /path template`) the effect `read`, `reversible` or
  `irreversible`; `confirmationReason()` says why a call needs confirmation (DELETE, the table,
  unknown write paths, `getPdf` without `preventSendBy=true`, a status change in the body, an
  enshrine flag). `test/classify.test.ts` fails on any spec operation the table lacks, so a spec
  update that adds a path needs a classification here.
- `spec/sevdesk-openapi.json`: the embedded sevDesk OpenAPI spec (`$ref`s resolved, © sevDesk,
  not MIT). Never edit it by hand: `bun run update-spec` regenerates it
  (`scripts/update-spec.ts`, `scripts/resolve-refs.ts`). It applies `spec/patches.json` first, the
  corrections of known spec errors (`scripts/patch-spec.ts`): every change names the upstream value
  it expects (`from`), so a patch that no longer applies stops `update-spec`. A new or changed
  patch takes effect only after `bun run update-spec`; `test/patch-spec.test.ts` fails until then.
- `src/i18n/`: human-facing CLI messages. `en.json` is the reference catalog, `de.json`
  mirrors it, `index.ts` exposes `resolveLocale()` and `t()`.
- `test/`: vitest; `test/budget.test.ts` is the 1,500-token gate for instructions and tool
  descriptions. `test/mock-sevdesk.ts` starts a mock sevDesk on port 0 with per-test routes
  (JSON, text or raw bytes), records each request with its body, and stubs the global `fetch` to
  send calls for the real HTTPS base URL there (any other URL throws, `test/redirect-fetch.ts`), so
  the code under test keeps its HTTPS rule and tests never reach sevDesk. The mock follows the
  embedded spec (PRD §8): a route that is no spec operation fails its start, and a request that is
  none answers 404 without reaching a route; the one exception is the undocumented
  `GET /SevClient`. A spawned server reaches the mock with `node --import <serverImport>`.
  `test/priority-a.test.ts` drives PRD §4 Priority A over stdio with the guides' templates as
  `search` returns them, and checks after each test that no send or delete reached the mock
  outside an accepted `confirm`. `test/setup.ts` (vitest `setupFiles`) gives every test a fresh `mkdtemp` home
  and points `HOME`, `USERPROFILE`, `XDG_*` and `APPDATA`/`LOCALAPPDATA` there, so in-process and
  spawned servers never touch the real local directories or `~/Downloads`; it also unsets
  `SEVDESK_API_TOKEN` and mocks `@napi-rs/keyring` with the in-memory `test/fake-keychain.ts`
  (seed `tokens`, assert `accesses`). Spawned servers use the real keychain, so they must never read a token.
  `test/config-file.ts` writes a config file into the temporary home. `test/setup-dialogue.ts`
  drives `setup` and `config` through a scripted prompter (menus answered by item text or `BACK`) against the Acme mock and writes fake client configs
  (`writeClient()`, `backupsOf()`); `test/setup.ts` also unsets `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME`, so client registration only ever finds fake configs in the temporary home.
  Tests run from a local checkout, so `setup` writes local-build entries there
  (`test/setup-clients-local.test.ts`); the test files that check the `npx` entry mock
  `src/manifest.ts` with `test/installed-package.ts`, whose `root` lies under `node_modules`.
  `test/guide-template.ts`: `template()` and `fill()`, a guide's JSON template as snippet code.
  `test/e2e/`: the manual E2E run against a real account (decision 29; `bun run test:e2e` with
  `vitest.e2e.config.ts`; `*.e2e.ts` never matches `bun run test`, so neither `verify` nor CI
  runs it). `live.e2e.ts` spawns the server over stdio with `SEVDESK_E2E_TOKEN` and its own
  temporary home, drives Priority A on the persistent fixtures "MCP Test GmbH" and tag
  `mcp-test`, records what `getPdf` without `preventSendBy=true` does to the status, and prints
  a report without token or mail address. `cleanup.ts`: `cleanUp()` deletes only this run's
  tagged drafts, all or none (`cleanupGuard()`), through `confirm`; `test/e2e-cleanup.test.ts`
  checks it offline.
  `scripts/`: the i18n drift gate, the pinned actionlint runner and `update-spec`.
- While serving, stdout belongs to the MCP protocol: log to stderr only.
- Model-facing text (tool descriptions, guides, errors returned to the model) is English and
  stays lean: all tool descriptions together under 1,500 tokens (PRD §10).
- Irreversible sevDesk calls (DELETE, send, enshrine/book, cancel, reset) never run without
  the confirmation token flow from PRD §6.

## Pinned stack

- Use `svelte@5` (npm, resolved 5.57.3 on 2026-11-09), NEVER an older version.
- Use `@sveltejs/kit@3` (npm, resolved 3.1.1 on 2026-11-09), NEVER an older version.
- Use `tailwindcss@4` (npm, resolved 4.3.5 on 2026-11-09), NEVER an older version.
- Use `vite@8` (npm, resolved 8.3.7 on 2026-11-09), NEVER an older version.
- Use `typescript@7` (npm, resolved 7.0.2 on 2026-11-09), NEVER an older version.
- Use `prettier@3` (npm, resolved 3.9.10 on 2026-11-09), NEVER an older version.
- Use `eslint@10` (npm, resolved 10.14.0 on 2026-11-09), NEVER an older version.
- Use `husky@9` (npm, resolved 9.1.7 on 2026-11-09), NEVER an older version.
- Use `lint-staged@17` (npm, resolved 17.6.0 on 2026-11-09), NEVER an older version.
- Use `fallow@3` (npm, resolved 3.41.0 on 2026-11-09), NEVER an older version.
- Use `vitest@5` (npm, resolved 5.1.0 on 2026-11-09), NEVER an older version.
- Use `@playwright/test@1` (npm, resolved 1.65.0 on 2026-11-09), NEVER an older version.
- Use `bun@1` (npm, resolved 1.4.4 on 2026-11-09), NEVER an older version.
- Use Rust toolchain `1.99.1` (stable on 2026-11-09, pinned in rust-toolchain.toml), NEVER an older one.
- Use Swift toolchain `6.4.2` (stable on 2026-11-09, pinned in .swift-version), NEVER an older one.

## Foundation decisions

Recorded at bootstrap (2026-11-09); details in `docs/decisions/0001-foundation.md`.

1. **Pins in use:** bun, typescript, eslint, prettier, husky, lint-staged, fallow, vitest.
   Not used (no web UI, no Rust/Swift): svelte, @sveltejs/kit, tailwindcss, @playwright/test,
   Rust, Swift; vite only arrives transitively through vitest. Every other package is pinned
   exactly to the registry's current stable at the time it was added; Dependabot keeps them
   current.
2. **Design:** there is no `docs/design` export and the product has no web UI, so there are
   no design tokens, favicon or Open Graph card. The `.mcpb` icon is added once a real
   logo/mark exists; never invent one.
3. **i18n:** human-facing CLI text in English and German (`src/i18n/{en,de}.json`, `en` is
   the reference). Language from `LC_ALL` > `LC_MESSAGES` > `LANG`, then the runtime's
   default locale; German locales get `de`, everything else `en`. No URL strategy (no web
   UI). Model-facing text stays English (PRD decision 3). Drift gate: `bun run check:i18n`
   (same keys, non-empty, same `{placeholders}`) in CI and the pre-push hook.
4. **App shell:** one bin, `sevdesk-mcp`, kept minimal: CLI router, stdio MCP server, locale
   reading, i18n. `setup` fails closed until implemented. `--profile` and everything else
   from the PRD come as backlog slices.
5. **Database:** none (PRD §5.5: no database, no server state besides profiles), so CI has no
   `db` job.
6. **Preview environments:** none. Try a branch locally with
   `bun run build && claude mcp add sevdesk-dev -- node <worktree>/dist/cli.js`.
7. **Worktree-safe tests:** no fixed ports, no shared paths. MCP tests use `InMemoryTransport`
   or spawn the entry over stdio. A mock sevDesk HTTP server listens on port `0` and reads
   the assigned port back. Config, PDF and audit-log directories come from a per-test
   `mkdtemp(join(tmpdir(), 'sevdesk-mcp-'))`. The OS keychain is an in-memory fake in tests.
   Tests never touch the real `~/Downloads/sevdesk`, keychain or user config.
8. **Runtime:** Node ≥ 22 (`engines.node`; the PRD's Node 20 is EOL since 2026-04). CI runs
   Node 22 and 24. Bun is the package manager and dev runner only; the published package
   runs on Node via `npx`.
9. **MCP SDK v2:** `@modelcontextprotocol/server` at runtime, `@modelcontextprotocol/client`
   for tests only. Stdio is served by `serveStdio(createServer)`, which handles both
   2025-era (`initialize`) and modern clients.
10. **Lint vs TypeScript 7:** typescript-eslint 8.x needs TypeScript's JS API, which TS 7
    does not ship. `typescript` is 7.0.2 (typecheck and build); `eslint-ts6-shim.js` resolves
    `typescript` to `@typescript/typescript6` for the lint packages only. Delete the shim, its
    import in `eslint.config.js` and the `@typescript/typescript6` devDependency once
    typescript-eslint supports TS 7 (typescript-eslint issue #10940, expected with TS 7.1).
11. **Source runs as-is:** relative imports carry `.ts` extensions
    (`rewriteRelativeImportExtensions` turns them into `.js` on emit) and `erasableSyntaxOnly`
    is on, so `node src/cli.ts` runs through Node's type stripping (Node ≥ 22.18 for
    development); the CLI tests rely on it. No enums, namespaces or parameter properties.

## Product decisions

Recorded in the P3 gap sweep (2026-11-09); numbers refer to
`docs/decisions/0002-product-decisions.md`, which also lists the M0 candidates.

1. **Tenant (1, 2, 12):** never guess. `SEVDESK_API_TOKEN` set → that one profile, keychain not
   read, `SEVDESK_PROFILE` only names it (default `env`). Else `--profile` pins and any other
   `account` is rejected. Else one profile → use it; several → `account` is required, otherwise
   fail with `account_required` listing names and company names. No default profile. No profile
   at all → server still starts, `search` works, `execute` returns a setup hint.
2. **Read-only (3):** `SEVDESK_READONLY` OR profile `readonly`; neither lifts the other. It
   rejects every non-GET and every call classified irreversible, including GETs (`getPdf`
   without `preventSendBy=true`); rejected, never held, so no token bypasses it. Then `execute`
   carries `readOnlyHint`.
3. **Confirmation (5, 6, 7):** irreversible calls are held (`{ held: true }`, the run continues);
   one token per run covers all held calls (single use, 10 min, in memory, bound to profile +
   method + path + body hash). `execute({ confirm })` replays exactly the stored calls without
   re-running code, stops at the first failure, reports per call. Classification fails closed:
   unknown write paths, `status` in the body of PUT/POST on Invoice/Order/CreditNote/Voucher, and
   `getPdf` without `preventSendBy=true` all need confirmation; only a new draft (a factory save
   without id, with the draft status) may carry a status. `savePdf` always sets
   `preventSendBy=true`; marking as sent (`sendBy`) is its own confirmed step.
4. **Preview (9):** English, structured: amount as number + currency code, ISO 8601 dates,
   recipient, subject, document number, profile and company name.
5. **Retries (10):** GET on 429/5xx, any method on 429; never POST/PUT/DELETE on 5xx, never a
   confirmed call.
6. **Result envelope (11):** return value, console output, a ledger of every executed write call
   (also when the code failed later), the confirmation request and the update hint (once per
   session) when present. Errors: `isError: true` with
   `{ kind, message, status?, method?, path?, sevdeskMessage?, hint? }`; API errors are catchable
   in the sandbox; `undefined` yields an explicit "no return value"; over ~20 KB is cut with a
   hint.
7. **Network (15, 21, 22):** `sevdesk.request` takes only paths relative to the HTTPS base URL;
   non-JSON responses are written to the download directory and return
   `{ path, contentType, bytes }`. Nothing but sevDesk and the anonymous npm update check
   (opt-out `SEVDESK_MCP_NO_UPDATE_CHECK=1`, failures silent on stderr). No telemetry.
8. **Local files (13, 14, 16, 17):** OS-standard dirs (XDG on Linux): config (profiles without
   tokens, global limits, paths, audit switch), data/state (audit log, update cache). PDFs:
   `~/Downloads/sevdesk/<profile>/<number>.pdf` (fallback `<Type>-<id>.pdf`), same name is
   overwritten. Audit log: monthly JSONL with time, profile, method, path, query, status, object
   id, body hash, outcome (`executed|held|confirmed|rejected`); never bodies, never the token.
   Upload (v1.x): off until a folder is configured; nothing outside it, symlinks included.
9. **Secrets (4):** never a plaintext token. No keychain → `setup` aborts, explains why and
   points to `SEVDESK_API_TOKEN`.
10. **Setup (18, 19, 20):** profile names `[a-z0-9-]{1,32}`; read-only asked (default no); 1.0
    accounts refused; `--remove` offers to remove client entries. Client configs: back up first,
    ask per client, never overwrite silently; entry `sevdesk`/`sevdesk-<profile>` running
    `npx -y @erwins-enkel/sevdesk-mcp --profile <name>`; run from a local checkout (package root
    not under `node_modules`) it runs `<absolute node> <checkout>/dist/cli.js --profile <name>`
    instead, and `setup` says which kind it wrote (local beta, issue #22). No TTY → abort with the
    env-var hint. Plain text, never colour-only, honour `NO_COLOR`. macOS, Windows and Linux are
    supported.
11. **Copy (27, 28):** German CLI text uses "du", short, factual, gender-inclusive with a colon.
    MCP `instructions` (search first, then execute; irreversible needs `confirm`) count toward
    the 1,500-token budget. Elicitation (v1.x, decision 8) text is localised.
12. **E2E (29):** local and manual only, never in CI (`SEVDESK_E2E_TOKEN`,
    `SEVDESK_E2E_MAIL_TO`; skip the mail test without it). Fixtures "MCP Test GmbH" and
    `mcp-test` are persistent. Sent test offers are reported, never deleted.
13. **Releases (23, 24, 25):** a tag triggers npm trusted publishing with provenance and attaches
    the `.mcpb`; the MCP Registry entry comes with 1.0. The sevDesk spec ships with attribution
    ("© sevDesk, not MIT"); verify sevDesk's terms before the first publish.

## How work flows here

> Tooling guardrails (lint/types/tests/CI): see Shepherd's Readiness tab.

- **Unit of work:** GitHub issues, grouped into epics. One issue is one PR.
- **Vertical slice:** a capability reachable through an MCP tool (`search`, `execute`) or the
  `sevdesk-mcp` CLI. It lands together with the building blocks it needs and a test that
  drives it end to end: over `InMemoryTransport` or the stdio entry, against a mock sevDesk
  server on port `0`, with per-test `mkdtemp` directories (foundation decision 7). Example
  seam: `savePdf` is one PR with the sandbox host function, the sevDesk client call, the
  download directory and a tool-level `execute` test.
- **No stubs:** a building block (sevDesk client, classifier, token store, audit writer)
  lands with the first slice that uses it. `audit:dead` (fallow) fails on unused files and
  exports, so a building block without a consumer does not pass the gate.
- **Done:** `bun run verify` is green; see `## Verify`.
- **German copy:** the operator does not review German CLI text in PRs and reports problems
  afterwards. The implementing agent still keeps `en.json` and `de.json` in step and follows
  the copy rules (product decision 11; 0002 decision 27).

## Verify

```sh
bun install       # installs dependencies and the git hooks (husky `prepare`)
bun run verify    # the full gate: identical to the pre-push hook and the CI `quality` job
```

`bun run verify` runs, in order: `format:check`, `lint`, `typecheck`, `test`, `build`,
`check:i18n`, `audit:dead` (fallow: dead code, duplication, complexity), `audit:env` (varlock:
env vars vs `.env.schema`), `lint:actions` (actionlint on `.github/workflows/`).

- Fix formatting: `bun run format`. One test file: `bunx vitest run test/cli.test.ts`.
- Smoke the binary: `bun run build && node dist/cli.js` (speaks MCP on stdio).
- `bun run test:e2e` is not part of `verify`: it runs by hand against a real account with
  `SEVDESK_E2E_TOKEN` (plus `SEVDESK_E2E_MAIL_TO` for the mail test) and skips without the token.
- Hooks: pre-commit runs lint-staged (eslint --fix + prettier on staged files), commit-msg
  runs commitlint (Conventional Commits), pre-push runs `bun run verify`.
- When you change a CI step, change the `verify` script too, and vice versa. CI runs the
  `quality` job on Linux, macOS and Windows (Node 22 and 24); macOS and Windows run only install,
  `test` and `build`, the platform-independent tooling steps stay Linux-only.
- New env var: declare it in `.env.schema` first, because `varlock audit` fails on undeclared
  and stale variables. Read it as a literal `process.env.NAME` so the audit can see it.
- New CLI message: add the key to every catalog in `src/i18n/`.
- New dependency: query the current stable (`npm view <pkg> version`) and pin it exactly.

## Design conformance

Every UI change ships a light AND dark screenshot next to the matching reference screen from
`docs/design`. (Today there is no UI and no `docs/design`; this applies as soon as either
exists.)

## What the guardrails can't catch

- **Fail closed.** Render error/unreachable paths as explicit failures; never let a
  swallowed error, empty result, or zero count masquerade as success.
- **Single source of truth.** Derive counts, totals, and dimensions from the data
  (array length, column count) — never hardcode a magic number that silently drifts.
- **Keep names and comments honest.** When you change a function's behavior, update
  its name, doc comment, and inline comments to match — no stale comment left behind.
