# sevdesk-mcp

A local, open-source MCP server (stdio) that makes the whole sevDesk API usable for AI
assistants through two tools, `search` and `execute`, in Code Mode: the model writes small
JavaScript snippets that run in a local QuickJS sandbox against the sevDesk API, and only the
result goes back into the context. Published as `@erwins-enkel/sevdesk-mcp` (MIT).

- Product source of truth: `docs/prd/PRD-sevdesk.md` (German).
- Foundation decisions and their rationale: `docs/decisions/0001-foundation.md`.
- Status: scaffold. The server boots over stdio with no tools yet; every feature (sevDesk
  client, sandbox, confirmation flow, audit log, keychain, profiles, setup) arrives as a
  backlog slice.

## Orientation

- `src/cli.ts`: the `sevdesk-mcp` bin. No command starts the MCP server on stdio; `setup`
  fails closed until it is implemented; `--help` prints the usage.
- `src/server.ts`: `createServer()`, the single place where MCP tools get registered.
- `src/i18n/`: human-facing CLI messages. `en.json` is the reference catalog, `de.json`
  mirrors it, `index.ts` exposes `resolveLocale()` and `t()`.
- `test/`: vitest. `scripts/`: the i18n drift gate and the pinned actionlint runner.
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
