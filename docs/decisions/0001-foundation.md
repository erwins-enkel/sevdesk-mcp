# 0001: Foundation

- Status: accepted
- Date: 2026-11-09
- Deciders: Kai Osthoff (operator), bootstrap agent

## Context

`docs/prd/PRD-sevdesk.md` describes a local stdio MCP server in TypeScript, distributed via
npm and `npx`, without a web UI and without a database. The bootstrap had to turn that into a
runnable scaffold with every guardrail, on the pinned stack (`CLAUDE.md`, "Pinned stack"). The
web-oriented bootstrap topics (design tokens, favicon, OG card, CI database, preview deploys)
were checked against that shape before deciding.

## Decisions

### Design export: none, UI artefacts skipped

There is no `docs/design`. The operator chose to proceed without one: the product has no web
UI, so there are no design tokens, favicon, `theme-color` or Open Graph card. The `.mcpb`
package icon is added once a real logo/mark exists. Never invent one.

### i18n: English + German for humans, English for the model

- Human-facing CLI text (setup assistant, errors shown to people) ships in English and German.
  The audience is German-speaking sevDesk users, and the repo is public.
- Catalogs: `src/i18n/en.json` (reference) and `src/i18n/de.json`, flat dotted keys,
  `{name}` placeholders.
- Locale: `LC_ALL` > `LC_MESSAGES` > `LANG` (POSIX precedence), then the runtime's default
  locale (macOS/Windows GUI clients often spawn servers without `LANG`). German → `de`,
  everything else → `en`.
- URL language strategy: not applicable (no web UI).
- Model-facing text (tool names, descriptions, guides, errors returned to the model) stays
  English, per PRD decision 3 and the token budget in PRD §10.
- Drift gate: `scripts/check-i18n.ts` (`bun run check:i18n`) fails on missing, extra or
  empty keys and on differing placeholders. It runs in CI and the pre-push hook.

### App shell: minimal

One bin, `sevdesk-mcp`. Without a command it serves MCP over stdio; `--help` prints the
usage; `setup` fails closed with an explicit "not implemented yet" message until its slice
lands. The PRD's shared building blocks (sevDesk client, QuickJS sandbox, confirmation
classifier and tokens, audit log, keychain, profiles) are not stubbed. Each arrives with the
first slice that needs it, so the dead-code audit stays meaningful.

### CI database: none

PRD §5.5: "Keine Datenbank, kein Server-Zustand außer Profilen." No service container and no
`db` job.

### Preview environments: none

There is nothing to deploy. A branch is tried locally by building it and registering the
worktree's `dist/cli.js` with a client, e.g. `claude mcp add sevdesk-dev -- node
<worktree>/dist/cli.js`. A per-PR npm preview (pkg.pr.new) was considered and declined for
now. It would need a third-party GitHub App.

### Worktree-safe tests: port 0 + mkdtemp

Parallel worktrees must never collide:

- MCP tests use `InMemoryTransport` (no port) or spawn the entry point over stdio.
- A mock sevDesk HTTP server listens on port `0` and reads the OS-assigned port back.
- Config, PDF and audit-log directories come from a per-test
  `mkdtemp(join(tmpdir(), 'sevdesk-mcp-'))`.
- The OS keychain is replaced by an in-memory fake in tests.

### Runtime floor: Node ≥ 22

The PRD says Node ≥ 20, but Node 20 has been end-of-life since 2026-04. Node 22 is the oldest
maintained line, so it keeps the widest reach for `npx` users while still receiving security
fixes. CI runs Node 22 and 24. Bun is the package manager and dev runner only. The
published package runs on Node.

## Consequences and technical notes

- **MCP SDK v2.** The registry's current major is the split v2 SDK
  (`@modelcontextprotocol/server` 2.4.0, `latest`), not `@modelcontextprotocol/sdk` 1.x. Stdio
  uses `serveStdio(createServer)`, which serves 2025-era `initialize` clients (Claude Desktop,
  ChatGPT Desktop today) and modern ones from the same factory.
- **ESLint with TypeScript 7.** TS 7 is the Go-native compiler and ships no JS compiler API;
  typescript-eslint 8.x requires `typescript <6.1`. The operator chose a lint-only shim:
  `typescript` stays 7.0.2 for typecheck and build, and `eslint-ts6-shim.js` (a
  `module.registerHooks` resolve hook) gives the lint packages `@typescript/typescript6`.
  Typed rules (`strictTypeChecked`) work. ESLint must run on Node, not the Bun runtime.
  Removal trigger: typescript-eslint support for TS 7, tracked in
  https://github.com/typescript-eslint/typescript-eslint/issues/10940 and expected with TS 7.1.
  Rejected alternatives: aliasing TS 6 as `typescript` in `package.json` (the manifest would
  then claim an older TypeScript), and Oxlint (departs from the eslint pin).
- **Source runs without a build.** `.ts` import extensions with
  `rewriteRelativeImportExtensions` and `erasableSyntaxOnly` let Node's type stripping run
  `src/cli.ts` directly (Node ≥ 22.18 for development). The CLI tests spawn the real entry
  point that way.
- **Env schema.** `.env.schema` (varlock) declares every variable the code reads; today only
  the locale variables. `varlock audit` fails on undeclared and stale ones, so PRD variables
  (`SEVDESK_API_TOKEN`, `SEVDESK_PROFILE`, `SEVDESK_READONLY`) are declared by the slice that
  first reads them.
- **actionlint** is not an npm package. `scripts/actionlint.sh` downloads the pinned release
  (v1.7.12) once into `node_modules/.cache` and verifies its SHA-256 before running it.
- **Forge settings** (branch protection, required checks) are applied by the operator from
  Shepherd's Readiness tab, not by this scaffold.
