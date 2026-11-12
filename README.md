# sevdesk-mcp

**The whole sevDesk API in two MCP tools.** A local, open-source MCP server that lets AI
assistants (Claude Desktop, ChatGPT Desktop, Claude Code, Codex CLI, …) work with sevDesk
through just `search` and `execute`: instead of one tool per endpoint, the model writes small
JavaScript snippets that run in a local sandbox against the sevDesk API ("Code Mode").

> **Status: early development.** The server offers `search` (explore the sevDesk API
> specification and curated recipes for offers, tax rules, dates and sending) and `execute`
> (reads and reversible writes such as drafts, with a token from `SEVDESK_API_TOKEN` or from a
> profile in the OS keychain, PDFs and exports saved to disk; every result lists the writes it
> sent). Irreversible calls (delete, send, enshrine, book, cancel, reset, status changes) are held
> until you confirm them; read-only mode blocks every change; a local audit log records every write
> call. `sevdesk-mcp setup` adds an account with its token in the OS keychain and registers it in
> Claude Desktop, Claude Code, ChatGPT Desktop / Codex and OpenCode, `setup --list` lists the
> accounts and `setup --remove` removes one; `sevdesk-mcp config` changes them in a menu. Do not
> use it with a real sevDesk account yet.

> Not developed or endorsed by sevDesk. (Nicht von sevDesk entwickelt oder unterstützt.)

## Configuration

The server runs without a config file. To change a default, create `config.json` in the config
directory:

| OS      | Config file                                                                      |
| ------- | -------------------------------------------------------------------------------- |
| Linux   | `$XDG_CONFIG_HOME/sevdesk-mcp/config.json` (default `~/.config/sevdesk-mcp/…`)   |
| macOS   | `~/Library/Application Support/sevdesk-mcp/config.json`                          |
| Windows | `%APPDATA%\sevdesk-mcp\config.json` (usually `C:\Users\<you>\AppData\Roaming\…`) |

Every key is optional; a key you leave out keeps its default. The limits apply to every `search`
and `execute` run.

```json
{
  "baseUrl": "https://my.sevdesk.de/api/v1",
  "limits": { "timeoutSeconds": 30, "memoryMb": 64, "callsPerRun": 50, "outputChars": 20000 },
  "profiles": { "manufare": { "company": "manu·fare GmbH", "readonly": false } },
  "audit": true
}
```

| Key                     | Default                        | Allowed                                                  |
| ----------------------- | ------------------------------ | -------------------------------------------------------- |
| `baseUrl`               | `https://my.sevdesk.de/api/v1` | an `https://` URL without credentials, query or fragment |
| `limits.timeoutSeconds` | `30`                           | time per run, whole seconds from 1 to 3600               |
| `limits.memoryMb`       | `64`                           | sandbox memory in MB, 16 to 2048                         |
| `limits.callsPerRun`    | `50`                           | sevDesk calls per `execute` run, 1 or more               |
| `limits.outputChars`    | `20000`                        | characters of result and of console output, 1 or more    |
| `profiles.<name>`       | none                           | a profile: name of 1 to 32 characters `a-z`, `0-9`, `-`  |
| `….company`             | required                       | the sevDesk company name, a non-empty string             |
| `….readonly`            | `false`                        | `true` or `false` ([read-only mode](#read-only-mode))    |
| `….downloadDir`         | `~/Downloads/sevdesk/<name>`   | where its files are saved, an absolute path              |
| `audit`                 | `true`                         | `true` or `false` ([audit log](#audit-log))              |

The server reads the file when it starts, so restart it (or your MCP client) after a change. If the
file is not valid JSON, has an unknown key or an invalid value, both tools refuse to run and
return an `invalid_config` error naming the file and the problem; the server never falls back to
the defaults for a broken file.

## Profiles

A profile is one sevDesk account. The config file holds its name, company and read-only flag; its
API token lives only in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
Service), under the service `sevdesk-mcp` with the profile name as the account. A token is never
read from a file; a `token` key in the config file is an error.

Add a profile in a terminal with `npx @erwins-enkel/sevdesk-mcp setup` (`setup --add` does the
same):

1. It asks for the profile name (1 to 32 characters `a-z`, `0-9`, `-`). An existing profile is
   replaced only after an explicit yes.
2. It asks for the API token without showing it, checks it against sevDesk and shows the company
   and bookkeeping system. A rejected token or an account on another system than 2.0 is refused.
3. It asks whether the profile is read-only (default no; when replacing, the profile's current
   setting).
4. It stores the token in the OS keychain and the profile (name, company, read-only) in the config
   file.
5. It offers to register the profile in each installed MCP client (see below) and prints the
   command for any other client: `npx -y @erwins-enkel/sevdesk-mcp --profile <name>`, or, run from
   a local checkout, the command that starts its build
   ([beta testing](#beta-testing-from-a-local-checkout)).

Until step 4 nothing is stored. There is no plaintext fallback: without an OS keychain
(headless Linux, WSL, Docker), `setup` stops and explains why, as a token in a plain file can be
read by any process and any backup and grants full access to the bookkeeping. Use
`SEVDESK_API_TOKEN` there instead. Without a terminal (scripts, CI), `setup` stops with the same
hint; it has no non-interactive options. Its exit code is 0 when the profile is stored and every
client config it touched could be read and written, and 1 otherwise.

`setup --list` prints every profile of the config file with its company and whether it is
read-only. It reads only the config file, never the keychain, so it never shows a token, and it
needs no terminal.

`setup --remove <name>` asks before it removes the profile (default no). After a yes it deletes the
token from the OS keychain and then the profile from the config file; every other key of the file
stays. It needs a terminal for the question. Its exit code is 0 when the profile is removed and 1
otherwise: after a no, for an unknown profile, or when the keychain or the config file fails. If
only the config file fails, the token is already gone; fix the file and run `setup --remove` again.
Once the profile is removed, it offers to remove the client entries that start it (see below).

### Changing profiles and settings: `config`

`sevdesk-mcp config` opens a menu in the terminal. It first shows the running version and its
updates, the config file, whether the audit log is on and where it is, and every profile with its company, read-only state, download
directory and, for each installed MCP client, the entries that start it and their kind (`npx` or
`local build`). The overview reads only the config file and the client configs, never the
keychain. Move with the arrow keys or type an item's number (1 to 9), choose with Enter, go back
with Esc or q. The output is plain text without colours, so it reads the same with `NO_COLOR`.

- **Per profile:** make it read-only or allow writes again, set its download directory (an
  absolute path) or reset it to the default, add it to or remove it from the installed MCP
  clients (the same questions and backups as `setup`, see below), check its connection (its token
  from the keychain against sevDesk, showing company and bookkeeping system, never the token) and
  remove it (as `setup --remove`).
- **Add a profile:** runs the `setup` dialogue.
- **Audit log:** turn it off or on.
- **Update** (local checkout only, see below): offered first when commits are waiting.

Run from a local checkout, `config` fetches the branch's upstream once when it opens (`git fetch`,
no user data) and shows the version with branch, commit and date, and whether commits are
waiting. If it cannot check, it says why ("unknown") and never claims to be up to date. When commits
are waiting, the branch has none of its own and no tracked file is changed, the menu offers
"Update to <commit>". It lists the waiting commits, asks (default yes) and then updates exactly as
the `version` tool does (see "Beta testing from a local checkout"). After an update, `config` ends; run
it again to see the new version. An installed package shows its version and does not check for
updates here.

Each change is written at once, keeping every other key of the file; restart the MCP clients so
they pick it up. Ctrl+C leaves at any point without a half-written change. Like `setup`, `config`
needs a terminal and stops with exit code 1 without one; it takes no options (an option or
argument is a usage error, exit code 2). Its exit code is 0 when you leave and every change went
through, and 1 when one failed (such as a client config that could not be written or a failed
connection check).

### MCP clients

`setup` registers the server in these clients when they are installed, and `setup --remove` offers
to remove their entries again:

| Client                  | Config file                                                                                                                                                                                     | Installed when             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Claude Desktop          | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`                                                                                                                        | the `Claude` folder exists |
|                         | Windows: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` (current installers), else `%APPDATA%\Claude\`                                                               |                            |
|                         | Linux: `$XDG_CONFIG_HOME/Claude/` (default `~/.config/Claude/`)                                                                                                                                 |                            |
| Claude Code             | `~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR` when that is set                                                                                                                     | the file exists            |
| ChatGPT Desktop / Codex | `config.toml` in `CODEX_HOME` when that is set, else `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`); ChatGPT Desktop and the Codex CLI share it                           | the folder exists          |
| OpenCode                | in `$XDG_CONFIG_HOME/opencode/` (default `~/.config/opencode/`, also on macOS and Windows): the first of `opencode.jsonc`, `opencode.json` and `config.json` that exists, else `opencode.jsonc` | the folder exists          |

The entry is named `sevdesk`, or `sevdesk-<profile>` when there are several profiles, and runs
`npx -y @erwins-enkel/sevdesk-mcp --profile <name>` (Claude Code on Windows: `cmd /c npx …`).
Run from a local checkout instead of an installed package, `setup` writes an entry that starts the
checkout's build ([beta testing](#beta-testing-from-a-local-checkout)); it says which kind it
writes. The entry never holds a token. In Codex's `config.toml` it is the table
`mcp_servers.sevdesk` with `command` and `args`; in OpenCode it is
`"sevdesk": { "type": "local", "command": [...] }` in its `mcp` section. A relative `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or (for OpenCode) `XDG_CONFIG_HOME`
depends on the directory the client starts in, so `setup` leaves that client alone. `setup` asks
once per client and shows the file:

- A new entry is added after a yes (the default).
- An existing entry of that name that runs something else is replaced only after an explicit yes;
  otherwise the file stays byte for byte as it was. An entry that already runs the same command is
  left alone without a question.
- Before it writes, `setup` saves the previous file next to it as
  `<file>.sevdesk-mcp-<time>.bak` and prints its path. It keeps every other key and entry, the
  file's permissions and a symlink. In Codex's TOML and OpenCode's JSONC it edits only the entry
  and keeps the comments; the Claude configs are JSON without comments and are written
  anew, two-space indented. If the file changed while you answered, it is left as it is.
- `setup --remove <name>` offers to remove every entry that runs this package (or, run from a
  local checkout, its build) with `--profile <name>` (default yes), with the same backup.
- A client config that cannot be read or written is reported and left as it is; the exit code is
  then 1. This includes an OpenCode config whose `mcp` section holds `servers`, the layout of
  OpenCode 2, which `setup` does not edit yet; add the printed command there yourself.

Restart the client afterwards. For any other client, add the printed command yourself.

The server never guesses which account a call is for:

1. With `SEVDESK_API_TOKEN` set, it has exactly that one profile (named by `SEVDESK_PROFILE`,
   default `env`) and does not read the keychain; otherwise it has the profiles of the config file.
2. `sevdesk-mcp --profile <name>` pins the server to one of them; `execute` accepts no other
   `account`. (`--reload`, for a local checkout's entries, is described under
   [beta testing](#beta-testing-from-a-local-checkout).)
3. Otherwise, with exactly one profile, `execute` uses it.
4. With several, `execute` needs `account`; without it, it answers `account_required` with the
   profile names and companies.

## Irreversible calls

Reading and creating or changing drafts run directly. Anything that cannot be undone (deleting,
sending, enshrining, booking, cancelling, resetting, changing a document's status, `getPdf`
without `preventSendBy=true`, and any write path the sevDesk specification does not know) is held
instead of sent:

1. The code's call resolves to `{ held: true }` and the code goes on, so drafts before and after it
   are created as usual.
2. If the run succeeds, its result carries `confirmation`: a token and a preview of every held
   call (the exact method, path, query and body; for an order, invoice, credit note or voucher its
   kind, number, date, net and gross amount with the currency, and the recipient; the mail
   subject; the profile and its company). The assistant shows you the preview.
3. Only after your yes does it call `execute` with `confirm` set to the token, and no code. The
   server then sends exactly the held calls, in order, each once and never retried. It stops at
   the first call sevDesk does not accept and reports every call as `sent`, `failed` or
   `not_sent`. A call sevDesk accepted (2xx) is `sent` even if its answer cannot be read.

A token works once, for 10 minutes, for the profile that held the calls, and only until the server
restarts. If the run fails, its held calls are dropped and no token is issued. Held calls, and the
reads of the documents they act on for the preview, count towards `limits.callsPerRun`. The profile
of `SEVDESK_API_TOKEN` has no company in the config file, so its preview names only the profile.

## Read-only mode

Read-only mode makes `execute` unable to change anything in sevDesk. It is on for a call when
either switch is on; neither can turn the other off:

- `SEVDESK_READONLY` in the environment of the MCP server turns it on for every profile. Any value
  but empty, `false` or `0` (case ignored) counts as on.
- `"readonly": true` in a profile of the config file turns it on for that profile, even with
  `SEVDESK_READONLY=false`. The profile of `SEVDESK_API_TOKEN` has no such flag; only
  `SEVDESK_READONLY` applies to it.

In read-only mode every call that is not a GET, and every call that would be held for confirmation
(including a GET such as `getPdf` without `preventSendBy=true`), fails with a `read_only` error.
Such a call is rejected outright, never held, so no confirmation token can get it through, and
`execute` with `confirm` is rejected as well. Reads and `sevdesk.savePdf` keep working (`savePdf`
always sets `preventSendBy=true`). The render `savePdf` sends for a draft is the one write that
read-only mode lets through: it changes no status, it keeps the PDF current, and it is listed in
`writes` and the audit log. The same render sent through `sevdesk.request` is rejected. When
`SEVDESK_READONLY` is on, or the server is pinned with `--profile` to a read-only profile, `execute`
carries the MCP `readOnlyHint` annotation. The server reads both switches when it starts, so restart
it after a change.

## Audit log

Every write call `execute` handles leaves one line in a local audit log, so you can see what the
server tried to change. It is a JSON Lines file per month (UTC), e.g. `2026-11.jsonl`, in the
`audit` folder of the data/state directory:

| OS      | Audit folder                                                                   |
| ------- | ------------------------------------------------------------------------------ |
| Linux   | `$XDG_STATE_HOME/sevdesk-mcp/audit/` (default `~/.local/state/sevdesk-mcp/…`)  |
| macOS   | `~/Library/Application Support/sevdesk-mcp/audit/`                             |
| Windows | `%LOCALAPPDATA%\sevdesk-mcp\audit\` (usually `C:\Users\<you>\AppData\Local\…`) |

A line holds `time` (ISO 8601, UTC), `profile`, `method`, `path`, `query` (if any), `status`
(sevDesk's HTTP status, if it answered), `objectId` (if the answer names one), `bodyHash` (the
SHA-256 of the JSON body, if any) and `outcome`:

- `executed`: a draft or other reversible write, sent directly.
- `held`: an irreversible call, held for your confirmation and not sent. A run that fails drops
  it; it is then never sent.
- `confirmed`: a held call, sent after your confirmation; `status` shows whether sevDesk accepted
  it.
- `rejected`: a call that read-only mode refused, or an irreversible read that `sevdesk.paginate`
  refused; not sent.

Reads get no line. The log never holds a request body (no customer data) or the token. The
server never deletes or rotates it; remove old months yourself. Several MCP clients, each with its
own server, can write to it at once without breaking lines, as long as the folder is on a local
disk (not a network share). If the log cannot be written, the call fails with an `audit_error`
and the run stops instead of going on unrecorded: a write is not sent, an irreversible call is not
held, and a confirmation sends nothing and keeps its token. Should writing fail only after sevDesk
answered (e.g. a full disk), the error says the call was sent. To turn the log off, set
`"audit": false` in the config file and restart the server.

## Files

PDFs and exports never pass through the assistant's context: the server saves them in the
profile's download directory and returns only the path. That directory is
`~/Downloads/sevdesk/<profile>/` unless the profile sets `downloadDir`; the profile of
`SEVDESK_API_TOKEN` is named by `SEVDESK_PROFILE` (default `env`).

- `sevdesk.savePdf(type, id)` saves the PDF of an order (offer), invoice or credit note as
  `<document number>.pdf`, or as `<Type>-<id>.pdf` when it has no number, and replaces an older
  copy of the same name. It always asks sevDesk not to mark the document as sent
  (`preventSendBy=true`). sevDesk keeps the PDF it rendered last, so `savePdf` renders a draft
  again first (`POST /{Type}/{id}/render` with `forceReload`, listed in `writes` and the audit
  log): its PDF always shows the draft as it is now. That costs 3 calls. Any other document gets
  the PDF sevDesk stored, the one it sent, in 2 calls. It returns the path and file name with the
  PDF's `bytes`, `sha256`, `pdfCreated` (its `/CreationDate`) and `documentUpdated` (the
  document's `update`), both in UTC.
- A `getPdf` of an order, invoice or credit note through `sevdesk.request` (with
  `preventSendBy=true`) is saved as a new file named after the path, e.g. `Order-7-getPdf.pdf`,
  whether sevDesk answers JSON or, with `download=true`, the PDF itself. It reads the document
  first (2 calls) and returns the same fields. Changes through the API do not update the PDF
  sevDesk stored, and this call returns that stored PDF; only `savePdf` renders a draft again.
- When a draft's PDF predates the draft's last change, the result adds `stale: true` and a hint,
  and the `execute` result's `notes` name the file. The file is saved all the same. Documents
  that are no drafts are never flagged: a status change such as sending moves `update` too.
- Any other response that is not JSON, such as a CSV export, is saved as a new file named after the
  request path, e.g. `Export-datevCSV.csv`. An existing file is kept; the new one gets `-2`, `-3`,
  … appended.

## Beta testing from a local checkout

Until the package is on npm, its `npx` entry cannot start. To try the whole flow in real clients
before that, run `setup` from a local checkout: `setup` counts as installed when it runs from a
folder under `node_modules` (as with `npx` or a global install), and as a local checkout otherwise.

1. Clone the repository into a folder that stays where it is, not a temporary worktree, and build
   it: `bun install && bun run build`. The client entries point into this folder.
2. Run `node dist/cli.js setup` there. It says that it runs from the local checkout, and every
   client entry it writes starts the checkout's build: the absolute path of the Node.js you ran it
   with (GUI clients often lack your `PATH`), the checkout's `dist/cli.js`, `--profile <name>`
   and `--reload`, for example
   `"command": "/usr/local/bin/node", "args": ["/home/you/sevdesk-mcp/dist/cli.js", "--profile", "acme", "--reload"]`.
   An entry written before `--reload` existed is offered for replacement when you run `setup` again.
   Everything else is as described under [MCP clients](#mcp-clients): the same entry names, a
   backup first, a question per client, nothing replaced without an explicit yes.
3. After every `git pull`, run `bun install && bun run build` again; the entries stay as they are.
   With `--reload` the client needs no restart: before each call the server checks whether the
   build (`dist/`) or the spec (`spec/`) changed, and once no call is in flight it starts the real
   server anew with the new build, behind the same connection. A server that ends (a crash, a broken
   build) answers its open calls with an error and starts again on the next call. A client restart
   is still needed for changes the client fetched once at connect (tool names, input schemas,
   descriptions, the instructions), for changes to the reload itself (`src/reload.ts`, `src/cli.ts`)
   and for config-file changes. A restart drops the confirmation tokens of held calls; ask for the
   preview again. If you move the checkout or remove that Node.js (for example with a
   version manager), run `setup` again and replace the entries. `setup --remove <name>` run from
   the checkout also offers to remove its entries.
4. Or ask the client for the sevdesk MCP's version. A server started from a local checkout has a
   third tool, `version` (the installed package keeps its two): it reports the package version,
   the checkout's branch and commit and, after a `git fetch` of the branch's upstream, the commits
   waiting there. When some are, the model asks you, and after your yes the server fast-forwards
   the checkout to exactly the commit it offered, runs `bun install --frozen-lockfile` when
   `package.json` or `bun.lock` changed, and runs `bun run build`; with `--reload` the next call
   runs the new build. It changes nothing when tracked files have uncommitted changes, the branch
   has commits of its own or no upstream, or bun is found neither on the client's `PATH` nor in
   `~/.bun/bin`. If the install or the build fails after the fast-forward, it says so and nothing
   is rolled back: run `bun install && bun run build` in the checkout. A client fetches the tool
   list once, so after the build that first brings `version`, restart the client once.
   `sevdesk-mcp config` shows the same state and offers the same update in the terminal.
5. Once the package is published, switch with `npx @erwins-enkel/sevdesk-mcp setup` and the same
   profile name: replace the profile (it asks for the token again), then answer yes when it asks to
   replace each client's entry with the `npx` one.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.4.4 and Node.js ≥ 22.18.

```sh
bun install       # dependencies + git hooks
bun run verify    # everything CI checks
bun run build && node dist/cli.js   # start the server on stdio
bun run build:watch   # rebuild dist/ on every change; a --reload entry runs it from the next call
bun run update-spec   # refresh the embedded sevDesk API specification
bun run test:e2e      # by hand only: Priority A against a real sevDesk account
```

`bun run test:e2e` runs the offer flow against the account of `SEVDESK_E2E_TOKEN` and skips
without it. It is never part of `bun run test`, `bun run verify` or CI. It writes only contacts
and offers, never invoices; it reads one existing invoice. Every offer goes to the contact "MCP Test GmbH" and carries
the tag `mcp-test` and the run id in its head text; the contact and the tag are created on the
first run and kept. With `SEVDESK_E2E_MAIL_TO` set, one offer is mailed to that address and only
there. At the end the run deletes its own offers that are still tagged drafts, through the
confirmation flow, and deletes nothing if any of them is not. Mailed offers are no longer drafts:
the report lists them, with anything else left behind, for deletion by hand. The report also
says whether `getPdf` without `preventSendBy=true` changed an offer's status and what a `getPdf`
without a render returns after a change of the draft (its `pdfCreated`, `documentUpdated` and
`stale`), and it contains neither the token nor the mail address. An interrupted run can leave offers too; find them by the
tag and the run id. The run also records the shape (field names and types, never values) of the
real answers the guides and helpers rely on in `test/sevdesk-shapes.json`, which `bun run test`
checks the patched spec and the mock's answers against; commit it after a run. Its report lists
how the real answers differ from the patched spec.

The product requirements live in [`docs/prd/PRD-sevdesk.md`](docs/prd/PRD-sevdesk.md), the
foundation decisions in [`docs/decisions/0001-foundation.md`](docs/decisions/0001-foundation.md).

## sevDesk API specification

[`spec/sevdesk-openapi.json`](spec/README.md) is the official sevDesk OpenAPI specification,
fetched from <https://api.sevdesk.de/openapi.yaml> with all `$ref`s resolved and known errors
corrected by [`spec/patches.json`](spec/README.md#corrections). `search` runs the model's code
against it. **© sevDesk, not covered by the MIT licence.**

## License

[MIT](LICENSE), except the sevDesk API specification in `spec/` (see above).
