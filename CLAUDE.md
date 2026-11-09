# sevdesk-mcp

A local, open-source MCP server (stdio) that makes the whole sevDesk API usable for AI
assistants through two tools, `search` and `execute`, in Code Mode: the model writes small
JavaScript snippets that run in a local QuickJS sandbox against the sevDesk API, and only the
result goes back into the context. Published as `@erwins-enkel/sevdesk-mcp` (MIT).

- Product source of truth: `docs/prd/PRD-sevdesk.md` (German).
- Foundation decisions and their rationale: `docs/decisions/0001-foundation.md`.
- Product decisions and their rationale: `docs/decisions/0002-product-decisions.md`.
- Status: early development. `search` runs in the QuickJS sandbox; `execute` reads sevDesk
  (GET only) with the profile from `SEVDESK_API_TOKEN`. Every other feature (writes,
  confirmation flow, audit log, keychain, profiles, setup) arrives as a backlog slice.

## Orientation

- `src/cli.ts`: the `sevdesk-mcp` bin. No command starts the MCP server on stdio; `setup`
  fails closed until it is implemented; `--help` prints the usage, `--version` the version
  from `src/manifest.ts` (the same source `createServer()` reports). Exit codes: 0 success,
  1 runtime failure, 2 usage error (unknown command or option); the usage text documents them.
- `src/server.ts`: `createServer()`, the single place where MCP tools and the MCP
  `instructions` get registered.
- `src/sandbox.ts`: `runSnippet()`, the QuickJS sandbox (a fresh WASM module per run, 30 s,
  64 MB, captured `console.log`, error kinds `timeout`/`memory_limit`/`snippet_error`). Host
  functions (`HostFunction`) return promises to the code; a `HostError` is catchable there and,
  uncaught, ends the run with its structured error; a fatal one ends the run at once.
  `src/envelope.ts`: `toToolResult()`, the JSON result envelope (`result`, `error`, `console`,
  `notes`; results over 20,000 characters are cut). `src/search.ts`: the `search` tool.
- `src/execute.ts`: the `execute` tool (bookkeeping-system check per profile and session).
  `src/sevdesk.ts`: `createClient()`, the host side of `sevdesk.request` (HTTPS base URL,
  relative paths only, token added host-side, call budget, fail-closed rules, structured
  errors). `src/profile.ts`: the profile from `SEVDESK_API_TOKEN`/`SEVDESK_PROFILE`.
- `spec/sevdesk-openapi.json`: the embedded sevDesk OpenAPI spec (`$ref`s resolved, © sevDesk,
  not MIT). Never edit it by hand: `bun run update-spec` regenerates it
  (`scripts/update-spec.ts`, `scripts/resolve-refs.ts`).
- `src/i18n/`: human-facing CLI messages. `en.json` is the reference catalog, `de.json`
  mirrors it, `index.ts` exposes `resolveLocale()` and `t()`.
- `test/`: vitest; `test/budget.test.ts` is the 1,500-token gate for instructions and tool
  descriptions. `test/mock-sevdesk.ts` starts a mock sevDesk on port 0 with per-test routes and
  stubs the global `fetch` to send calls for the real HTTPS base URL there (any other URL
  throws), so the code under test keeps its HTTPS rule and tests never reach sevDesk.
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
   `getPdf` without `preventSendBy=true` all need confirmation. `savePdf` always sets
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
    `npx -y @erwins-enkel/sevdesk-mcp --profile <name>`. No TTY → abort with the env-var hint.
    Plain text, never colour-only, honour `NO_COLOR`. macOS, Windows and Linux are supported.
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
- Hooks: pre-commit runs lint-staged (eslint --fix + prettier on staged files), commit-msg
  runs commitlint (Conventional Commits), pre-push runs `bun run verify`.
- When you change a CI step, change the `verify` script too, and vice versa.
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
