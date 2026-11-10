# 0002: Product decisions

- Status: accepted
- Date: 2026-11-09
- Deciders: Kai Osthoff (operator), bootstrap agent (phase P3 gap sweep)

## Context

The bootstrap gap sweep (phase P3) checked `docs/prd/PRD-sevdesk.md` against the scaffold that
exists today (`src/cli.ts`, `src/server.ts`, `src/i18n/`, `.env.schema`, CI) and settled the open
product decisions with the operator in one numbered round.

**No design input.** There is no `docs/design` export, and the product has no web UI (0001). The
sweep therefore covers the PRD and the scaffold only. Screen-oriented checklist items (states,
forms, layout, first run) were mapped to the surfaces this product really has: MCP tool results,
the confirmation preview, the `setup` CLI and local files. The check "screens without a story,
stories without a screen" does not apply.

Decisions already recorded in 0001 (Node ≥ 22, MCP SDK v2, i18n en/de with English model-facing
text, no database, no preview environments, worktree-safe tests) were not asked again.

## Decisions

Each entry: the question, the answer, and the PRD section it comes from. The PRD has been
supplemented in place with these answers; `CLAUDE.md` (`## Product decisions`) carries the short
rules.

### Profiles and permissions

1. **Which sevDesk tenant does a call go to when several profiles exist?**
   **Answer:** The server never guesses the tenant, and there is no default profile. Resolution:
   `SEVDESK_API_TOKEN` set → one profile from the environment (decision 2). Otherwise
   `--profile <name>` pins the server entry to one profile, and `execute` rejects any other
   `account`. Otherwise, with exactly one profile that profile is used. With several profiles
   `account` is mandatory: a call without it fails with `account_required`, listing the profile
   names with their sevDesk company names, so the model asks the human when the conversation does
   not make the tenant clear. The `account` parameter lists the reachable profile names as an
   enum with the company names in its description. Every confirmation preview names the profile
   and the company. The operator chose this over "default profile" and "only writes need
   `account`". **Source:** §5.1, §7 ("sonst gilt das Standardprofil" is superseded).
2. **What does `SEVDESK_PROFILE` mean next to `SEVDESK_API_TOKEN`?**
   **Answer:** With `SEVDESK_API_TOKEN` set, the server runs with exactly that one profile and does not
   read the keychain. `SEVDESK_PROFILE` only names this profile (audit log, PDF subfolder); the
   default name is `env`. **Source:** §7.
3. **How do the two read-only switches combine, and what does read-only block?**
   **Answer:** `SEVDESK_READONLY=true` and a profile's `readonly: true` combine with OR; neither can
   lift the other. In read-only mode every call that is not a GET, and every call classified as
   irreversible (decisions 6 and 7), is rejected. That includes an irreversible GET such as
   `getPdf` without `preventSendBy=true`. Such calls are rejected outright, not held for
   confirmation, so no token can get them past read-only. `savePdf` keeps working because it
   always sets `preventSendBy=true`. When the global switch is on or the pinned profile is
   read-only, `execute` carries the `readOnlyHint` annotation. **Source:** §6.
4. **What happens when no OS keychain is available (headless Linux, WSL, Docker)?**
   **Answer:** `setup` aborts. There is no plaintext fallback. The message explains why (a token in a
   plain file can be read by any process and any backup, and it grants full access to the
   bookkeeping) and points to `SEVDESK_API_TOKEN` for such environments. **Source:** §7.

### Confirmation of irreversible calls

5. **How does the confirmation round trip avoid duplicates?** Re-running the code with `confirm`
   would create drafts a second time and change the body hash of the bound call.
   **Answer:** Irreversible calls are _held_ in the first run: they are not sent, they return the
   placeholder `{ held: true }`, and the run continues. The result lists every held call in the
   preview and carries one token that covers all of them. `execute({ confirm })` (without `code`)
   replays exactly the stored calls in order without re-running any code, stops at the first
   failure and reports a result per call. The token is single-use, valid for 10 minutes, bound to
   the profile and to method, path and body hash of each held call, and kept in memory only (a
   server restart means asking again). **Source:** §6.
6. **What about write paths the classification table does not know?**
   **Answer:** Fail closed: an unknown write path is treated as irreversible. A status change is
   recognised by a `status` field in the body of a PUT or POST on Invoice, Order, CreditNote or
   Voucher. Creating a draft is no status change: a factory save
   (`POST /{Type}/Factory/save{Type}`) of a new document (without id) with the draft status (100,
   vouchers 50) runs directly, since these saves require a status. **Source:** §6
   ("Statusänderungen auf Rechnungen").
7. **How is a PDF fetched without flipping the sent status?**
   **Answer:** `savePdf` always passes `preventSendBy=true`; per third-party documentation `getPdf`
   may otherwise mark the document as sent (to verify against the live API in P4). A `getPdf` via
   `request` without `preventSendBy=true` is irreversible and needs confirmation. On the "PDF
   only" delivery path the document status stays unchanged; marking it as sent (`sendBy`) is a
   separate step that needs confirmation. **Source:** §4 A.4, §6.
8. **Elicitation in v1 or v1.x?** §6 step 3 lists it in the flow, §9 puts it in v1.x.
   **Answer:** v1.x. Client support (Claude Desktop, ChatGPT Desktop, Cowork) is inconsistent today,
   so v1 relies on the token alone. Once built, the server elicits additionally during the
   confirmation run; decline or timeout aborts. Elicitation text is human-facing and therefore
   localised (en/de). **Source:** §6, §9.
9. **In which format is the preview?** The PRD example is German-formatted, but model-facing text
   is English.
   **Answer:** English and structured: amounts as a number plus currency code (`3600.00 EUR net`), ISO
   8601 dates, recipient, subject, document number, profile and company. The model phrases it for
   the human in their language. **Source:** §6.
10. **When may a request be retried automatically?**
    **Answer:** GET on 429 or 5xx; any method on 429. Never on 5xx for POST, PUT or DELETE (it could
    create a duplicate), and never for a confirmed call. **Source:** §5.3.

### Results and errors

11. **What shape does every tool result have?**
    **Answer:** An `execute` result always carries the return value, the `console.log` output, and a
    ledger of every write call actually executed (method, path, status, object id), also when the
    code failed afterwards, so no created draft goes unnoticed. Where applicable it adds the
    confirmation request and the update hint. Errors come as `isError: true` with
    `{ kind, message, status?, method?, path?, sevdeskMessage?, hint? }`. An API error throws a
    catchable error inside the sandbox; an uncaught one ends the run with that shape. Returning
    `undefined` yields an explicit "no return value" note instead of a silent empty success.
    Results over ~20 KB are cut with a hint to filter more narrowly. A 401 adds a hint to re-run
    `setup`; a 403 passes the sevDesk message through. **Source:** §5.3.
12. **How does the server behave without a profile, and when is the system version checked?**
    **Answer:** The server always starts. `search` works without an account (it only reads the
    spec); `execute` answers with a setup hint. The sevDesk system 2.0 check runs on the first
    `execute` per profile and is cached for the session, not at server start, so startup stays
    fast and needs no network. **Source:** §5.4, §7.

### Local data

13. **Where do local files live?**
    **Answer:** In the OS-standard directories (XDG on Linux). The config directory holds the config
    file (profiles without tokens, limits, paths, audit switch); the data/state directory holds
    the audit log and the update-check cache. Limits are global, not per profile. **Source:** §5.3,
    §5.5, §6.
14. **Where do PDFs go?** (§12 open item)
    **Answer:** `~/Downloads/sevdesk/<profile>/`. The file name is the sevDesk document number
    (`AN-1042.pdf`), falling back to `<Type>-<id>.pdf`. A file with the same name is overwritten
    (the newest rendering wins). The directory is configurable per profile. **Source:** §5.1, §12.
15. **What happens with binary responses, such as a DATEV export?**
    **Answer:** When `sevdesk.request` gets a non-JSON response, the host writes it to the download
    directory and returns `{ path, contentType, bytes }`. "Binary data never enters the context"
    thus holds for exports too, without another helper. `savePdf` stays as the shortcut for
    documents. **Source:** §4, §5.1.
16. **What does the audit log contain?**
    **Answer:** Time, profile, method, path, query, status, sevDesk object id, body hash and outcome
    (`executed`, `held`, `confirmed`, `rejected`). No request bodies (no customer data) and never
    the token. One JSONL file per month, never deleted automatically. `audit: false` in the config
    turns it off. **Source:** §6.
17. **Which folder may `sevdesk.upload` read?** (v1.x)
    **Answer:** There is no default folder; upload stays off until one is configured. Paths outside it
    are rejected, including those reached through a symlink. **Source:** §5.1.

### Setup and clients

18. **How does `setup` work in detail?**
    **Answer:** Profile names use `[a-z0-9-]`, 1 to 32 characters. Read-only is asked when a profile
    is added (default: no). A system 1.0 account is refused and not stored. `setup --remove`
    deletes the profile and its token and offers to remove the client entries that use it.
    Writing client configs: a backup copy first, a question per client, an existing entry is never
    overwritten silently. The entry is named `sevdesk`, or `sevdesk-<profile>` when several exist,
    and runs `npx -y @erwins-enkel/sevdesk-mcp --profile <name>`. There is no default profile and
    no `setup --default` (decision 1). **Source:** §7.
    **Addendum (2026-11-10, issue #22):** Until the package is on npm the `npx` entry cannot start,
    so the operator beta-tests from a local checkout. When `setup` runs from a local checkout (its
    package root does not lie under a `node_modules` folder), the entry runs the absolute path of
    the running Node executable (GUI clients often lack the user's `PATH`) with the checkout's
    built `dist/cli.js` and `--profile <name>`; an installed package keeps the `npx` entry above.
    `setup` says which kind of entry it writes. Everything else above holds: the entry names, the
    backup first, a question per client, no silent overwrite, and `setup --remove` run from the
    checkout also offers to remove the entries that start its build. Switching to the published
    package later is an ordinary "replace entry?" question when `setup` runs again through `npx`.
    **Addendum (2026-11-10, reload without a client restart):** The local entry also passes
    `--reload`. Clients such as Claude Desktop start the server once and cannot restart one server
    alone, so every new build of the checkout needed a full client restart. With `--reload` the
    started process serves through a child running the real server and starts a new child once the
    build changed and no call is in flight, replaying the client's opening; Code Mode's two fixed
    tools keep the swap invisible to the client. A restart drops held calls' confirmation tokens
    (as §6 already says for a server restart). Changed tool schemas, descriptions or `instructions`
    still need a client restart. `npx` entries do not pass `--reload`. An earlier local entry
    without it is a "replace entry?" question when `setup` runs again.
19. **Setup without a terminal, and accessibility of the CLI.**
    **Answer:** Without a TTY, `setup` aborts with a hint to `SEVDESK_API_TOKEN`; there are no
    non-interactive flags. Output is plain text, status is never conveyed by colour alone,
    `NO_COLOR` is honoured, and there are no spinner-only states. **Source:** §7.
20. **Which operating systems are supported?**
    **Answer:** macOS, Windows and Linux (Claude Desktop runs on macOS and Windows only). CI gains macOS
    and Windows runs once keychain and path code lands. **Source:** §3, §7.

### Data flow and privacy

21. **The runtime update check queries the npm registry, a third party, which contradicts §11.**
    **Answer:** Allowed, because it is an anonymous read of public package metadata carrying no user
    data. Opt-out: `SEVDESK_MCP_NO_UPDATE_CHECK=1`. §11 now reads "no _user data_ to third
    parties". The hint appears once per session; a failed check stays silent apart from stderr.
    **Source:** §5.6, §11.
22. **Telemetry, and what users must know about data flow.**
    **Answer:** No telemetry and no crash reports. The README states plainly that whatever `execute`
    returns goes to the AI provider behind the client, so results should be filtered narrowly.
    **Source:** §11.

### Publishing and copy

23. **May the sevDesk OpenAPI file be redistributed inside an MIT package?** Its licence is
    unclear.
    **Answer:** Embed it with attribution and mark it in the README as "© sevDesk, not covered by the
    MIT licence". Verify sevDesk's terms before the first npm release (P4). If redistribution is
    not allowed, the server downloads the spec on first start and caches it. **Source:** §5.4.
24. **How are releases published and versioned?**
    **Answer:** 0.1.0 once Priority A works end to end; 1.0.0 when the v1 row of the roadmap is
    complete. A tag set by the operator triggers a GitHub Actions workflow that publishes with npm
    trusted publishing (OIDC, provenance) and attaches the `.mcpb` to the GitHub release. A merged
    spec update ships as a patch release. **Source:** §5.6, §9.
25. **Listing in the official MCP Registry (`server.json`)?**
    **Answer:** Yes, from 1.0. **Source:** §1.
26. **README language?**
    **Answer:** English, plus a short German "Schnellstart" section (installation and safety).
    **Source:** §2.
27. **Tone of the German CLI texts, and who maintains translations?**
    **Answer:** Informal "du", short and factual, gender-inclusive with a colon (as in the PRD);
    English equally short. The implementing agent maintains both catalogs; the operator reviews
    the German in review. **Source:** 0001 (i18n).
    **Addendum (2026-11-09, issue #3):** The operator no longer reviews German CLI text in pull
    requests; problems are reported afterwards as issues. This replaces "the operator reviews
    the German in review" above. The implementing agent still maintains both catalogs and
    follows the tone rules above.
28. **Does the server send MCP `instructions` on connect?**
    **Answer:** Yes, a short usage note: `search` first, then `execute`; irreversible calls need
    `confirm`. It counts toward the 1,500-token budget. **Source:** §5.1, §10.

### Tests

29. **How do the end-to-end tests against the real account run?**
    **Answer:** Locally and manually only (`bun run test:e2e`, token from `SEVDESK_E2E_TOKEN`), never in
    CI, because the repository is public. The mail test address (§12 open item) comes from
    `SEVDESK_E2E_MAIL_TO` and never appears in the repository; without it the mail test is skipped.
    The test contact "MCP Test GmbH" and the tag `mcp-test` are persistent fixtures, created once
    and never deleted. An offer sent by mail is no longer a draft, so the strict cleanup rule keeps
    it; the run ends by listing such offers for manual deletion. **Source:** §8, §12.

### Settled without a question

- §5.5 follows 0001: Node ≥ 22 and the split MCP SDK v2 (`@modelcontextprotocol/server`).
- §5.5 and §5.6 appear in numeric order; their numbers are unchanged.
- `npm run update-spec` becomes `bun run update-spec` (Bun is the package manager, 0001).
- `sevdesk.request` accepts only paths relative to the configured base URL, and the base URL must
  be HTTPS. This follows from §5.3: the token never leaves the host process.
- The `.mcpb` icon waits for a real logo (0001).

## Gap table

Every finding of the sweep, with where it went. "M0" refers to `## M0 candidates` below, "P4" to
`## P4 candidates`.

| #   | Finding                                                                                              | Resolution              |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Tenant selection with several profiles is implicit (default profile); a wrong tenant is a real risk  | Decision 1, M0-3        |
| 2   | Meaning of `SEVDESK_PROFILE` next to `SEVDESK_API_TOKEN` is ambiguous                                | Decision 2, M0-3        |
| 3   | Interplay of the global and the per-profile read-only switch is undefined                            | Decision 3, M0-3        |
| 4   | No behaviour defined when the OS keychain is missing                                                 | Decision 4, P4-5        |
| 5   | Re-running code with `confirm` duplicates drafts and breaks the body-hash binding                    | Decision 5, M0-7        |
| 6   | Runtime handling of write paths missing from the classification table is undefined                   | Decision 6, M0-7        |
| 7   | "Statusänderungen auf Rechnungen" is not mapped to concrete calls                                    | Decision 6, M0-7        |
| 8   | `getPdf` may set the sent status, so "read-only = GET only" is not side-effect free                  | Decisions 3, 7, M0-7    |
| 9   | Document status after the "PDF only" delivery path is undefined                                      | Decision 7, P4-3        |
| 10  | Elicitation is in the v1 flow (§6) but in v1.x on the roadmap (§9)                                   | Decision 8, P4-14       |
| 11  | Preview example is German-formatted while model-facing text is English                               | Decision 9, M0-7        |
| 12  | Automatic retry on 5xx would duplicate non-idempotent writes                                         | Decision 10, M0-4       |
| 13  | Tool result and error shape, empty return and partial success are undefined                          | Decision 11, M0-6       |
| 14  | Unauthorised (401) and forbidden (403) states are undefined                                          | Decision 11, M0-6       |
| 15  | Behaviour without any profile is undefined; a 2.0 check at startup would need the network            | Decision 12, M0-3       |
| 16  | Locations of config, profiles, audit log and caches are undefined                                    | Decision 13, M0-2       |
| 17  | "Limits (konfigurierbar)" does not say where they are configured                                     | Decision 13, M0-2       |
| 18  | PDF directory (§12), file naming, collisions and per-tenant separation are open                      | Decision 14, P4-3       |
| 19  | Exports (e.g. DATEV) cannot work with `savePdf` alone while binary data must stay out of the context | Decision 15, M0-4       |
| 20  | Audit log content, personal data and retention are undefined                                         | Decision 16, M0-8       |
| 21  | The upload folder for `sevdesk.upload` is undefined                                                  | Decision 17, P4-13      |
| 22  | Setup: profile name rules, read-only, 1.0 accounts, removal and client config writes are undefined   | Decision 18, P4-5       |
| 23  | Setup without a TTY and accessibility of the CLI output are undefined                                | Decision 19, M0-1       |
| 24  | Supported operating systems are implicit; CI runs on Linux only                                      | Decision 20, M0-2       |
| 25  | The runtime update check contacts the npm registry, contradicting §11                                | Decision 21, P4-9       |
| 26  | Telemetry and the data flow to the AI provider are not addressed                                     | Decision 22, P4-12      |
| 27  | Licence for redistributing the sevDesk OpenAPI file is unclear                                       | Decision 23, P4-10      |
| 28  | Release process, versioning and publishing mechanics are undefined                                   | Decision 24, P4-11      |
| 29  | Discoverability beyond npm (MCP Registry) is not addressed                                           | Decision 25, P4-11      |
| 30  | README language is undefined                                                                         | Decision 26, P4-12      |
| 31  | Tone of the German CLI texts and translation ownership are undefined                                 | Decision 27             |
| 32  | The model gets no usage guidance on connect                                                          | Decision 28, M0-9       |
| 33  | E2E: where it runs, the mail test address (§12), fixtures, and sent offers versus the cleanup rule   | Decision 29, P4-15      |
| 34  | §5.5 says Node ≥ 20 and `@modelcontextprotocol/sdk`; 0001 decided Node ≥ 22 and SDK v2               | Resolved in place       |
| 35  | §5.6 appears before §5.5                                                                             | Resolved in place       |
| 36  | `npm run update-spec` contradicts Bun as the package manager                                         | Resolved in place       |
| 37  | npm organisation `erwins-enkel` must exist before publishing (§12)                                   | P4-11 (operator step)   |
| 38  | Endpoints missing or wrong in the official spec (§12)                                                | P4-10                   |
| 39  | "Exporte, die Dateien an Dritte übergeben (falls vorhanden)" is not mapped to concrete calls         | P4-4 (backstop: dec. 6) |
| 40  | The 1,500-token budget for tool descriptions has no measurement                                      | M0-9                    |
| 41  | "Every spec path is classified" needs a test that fails on a new unclassified write path             | M0-7                    |
| 42  | The CLI has no `--version`                                                                           | M0-1                    |
| 43  | Nothing stops `sevdesk.request` from sending the token to another host                               | Settled, M0-4           |
| 44  | Date formats and time zone of sevDesk documents are not described for the model                      | P4-10 (guides)          |
| 45  | Page size and call budget of `sevdesk.paginate` are undefined                                        | P4-2                    |
| 46  | The daily spec check depends on scraping the API news page; a format change must not pass silently   | P4-9                    |
| 47  | Several server processes (one per client) append to the same audit log                               | M0-8                    |

## M0 candidates

Foundation stories for the backlog: the app shell, shared components and cross-cutting states.
Intent only. Per 0001 nothing is stubbed: each lands with the first slice that uses it, so the
backlog may fold a candidate into that slice.

1. **CLI shell completion.** `--version`, consistent exit codes, plain-text output (`NO_COLOR`,
   never colour-only), TTY detection for interactive commands, stderr-only logging while serving.
   (Decision 19)
2. **Config and local paths.** OS-standard config and data/state directories, the config file
   (profiles without tokens, global limits, PDF directory per profile, audit switch), per-test
   temporary directories; CI runs on macOS and Windows as soon as this lands. (Decisions 13, 20)
3. **Profile resolution.** Single profile from `SEVDESK_API_TOKEN`, `--profile` pinning, mandatory
   `account` when several profiles are reachable (`account_required` with names and company
   names), the profile enum in the `execute` schema, read-only OR, the setup hint when no profile
   exists. (Decisions 1, 2, 3, 12)
4. **sevDesk HTTP client.** Configurable HTTPS base URL with relative paths only, the token added
   on the host side only, the retry policy, structured API errors, the system 2.0 check per profile
   and session, non-JSON responses saved to disk, the per-run call counter. (Decisions 10, 12, 15)
5. **Sandbox runtime.** QuickJS without file system, environment or network; only the host
   functions; limits from the config; API errors catchable inside the snippet. Shared by `search`
   and `execute`. (PRD §5.3, decision 11)
6. **Tool result and error envelope.** One shape for `search` and `execute`: return value, console
   output, ledger of executed write calls, confirmation request, update hint; the `isError` shape;
   truncation with a hint; an explicit "no return value". (Decision 11)
7. **Confirmation gate.** Classification table (all DELETEs, send, enshrine/book, cancel, reset,
   `status` in body, `getPdf` without `preventSendBy`, unknown write paths fail closed) with a test
   that every spec path is classified; held calls; the in-memory token store (single use,
   10 minutes, bound to profile, method, path and body hash); the structured English preview with
   profile and company. (Decisions 5, 6, 7, 9)
8. **Audit log writer.** Monthly JSONL in the state directory, the agreed fields and outcomes, no
   bodies and no token, safe for several processes appending at once, `audit: false` honoured.
   (Decision 16)
9. **Tool-description budget gate.** MCP `instructions` plus all tool descriptions measured in a
   test that fails above the 1,500-token budget. (Decision 28, PRD §10)

## P4 candidates

Feature slices that the findings feed into; the backlog (phase P4) cuts and orders them.

1. `search` tool with the embedded spec and the guides.
2. `execute` read path, including `sevdesk.paginate` (page size, call budget).
3. Priority A end to end: find or create a contact, offer draft, `savePdf` (naming, directory,
   `preventSendBy`), delivery by sevDesk mail or "PDF only", explicit `sendBy`.
4. Complete the classification table from the spec, including exports that hand files to third
   parties.
5. Setup assistant: token check, keychain (with the clear abort when there is none), profiles,
   `--add`/`--list`/`--remove`, client detection and registration.
6. `.mcpb` package with the token field.
7. Read-only switches end to end (env and profile, `readOnlyHint`).
8. Audit log wired into every write path.
9. Update checks: daily GitHub Action (spec diff, API news, issue on breaking changes, fails
   visibly when the news page changes) and the runtime hint with its opt-out.
10. Spec maintenance: `bun run update-spec`, the patch file for known spec errors, the licence
    check, guides (including date formats and time zone).
11. Release workflow: tag-triggered npm trusted publishing, `.mcpb` on the GitHub release, npm
    organisation `erwins-enkel` (operator step), MCP Registry `server.json`.
12. README: installation per client, safety, privacy note, German quick start, sevDesk disclaimer
    and spec attribution.
13. File upload for receipts (`sevdesk.upload`, configured folder only).
14. Elicitation during the confirmation run.
15. E2E harness against the real account (`test:e2e`, guarded cleanup, persistent fixtures).
16. Curated tools: `find_contact`, `create_offer`, `get_document_pdf`.
