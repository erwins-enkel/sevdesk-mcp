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
> until you confirm them. Read-only mode, the audit log and `setup` are not there yet. Do not use
> it with a real sevDesk account yet.

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
  "profiles": { "manufare": { "company": "manu·fare GmbH", "readonly": false } }
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
| `….readonly`            | `false`                        | `true` or `false` (not enforced yet)                     |
| `….downloadDir`         | `~/Downloads/sevdesk/<name>`   | where its files are saved, an absolute path              |

The server reads the file when it starts, so restart it (or your MCP client) after a change. If the
file is not valid JSON, has an unknown key or an invalid value, both tools refuse to run and
return an `invalid_config` error naming the file and the problem; the server never falls back to
the defaults for a broken file.

## Profiles

A profile is one sevDesk account. The config file holds its name, company and read-only flag; its
API token lives only in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
Service), under the service `sevdesk-mcp` with the profile name as the account. A token is never
read from a file; a `token` key in the config file is an error. `sevdesk-mcp setup` will store
tokens; it is not implemented yet, so use `SEVDESK_API_TOKEN` until then. On Linux without a
Secret Service (headless, WSL, Docker), use `SEVDESK_API_TOKEN` as well.

The server never guesses which account a call is for:

1. With `SEVDESK_API_TOKEN` set, it has exactly that one profile (named by `SEVDESK_PROFILE`,
   default `env`) and does not read the keychain; otherwise it has the profiles of the config file.
2. `sevdesk-mcp --profile <name>` pins the server to one of them; `execute` accepts no other
   `account`.
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

## Files

PDFs and exports never pass through the assistant's context: the server saves them in the
profile's download directory and returns only the path. That directory is
`~/Downloads/sevdesk/<profile>/` unless the profile sets `downloadDir`; the profile of
`SEVDESK_API_TOKEN` is named by `SEVDESK_PROFILE` (default `env`).

- `sevdesk.savePdf(type, id)` saves the PDF of an order (offer), invoice or credit note as
  `<document number>.pdf`, or as `<Type>-<id>.pdf` when it has no number, and replaces an older
  copy of the same name. It always asks sevDesk not to mark the document as sent
  (`preventSendBy=true`).
- Any other response that is not JSON, such as a CSV export, is saved as a new file named after the
  request path, e.g. `Export-datevCSV.csv`. An existing file is kept; the new one gets `-2`, `-3`,
  … appended.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.4.4 and Node.js ≥ 22.18.

```sh
bun install       # dependencies + git hooks
bun run verify    # everything CI checks
bun run build && node dist/cli.js   # start the server on stdio
bun run update-spec   # refresh the embedded sevDesk API specification
```

The product requirements live in [`docs/prd/PRD-sevdesk.md`](docs/prd/PRD-sevdesk.md), the
foundation decisions in [`docs/decisions/0001-foundation.md`](docs/decisions/0001-foundation.md).

## sevDesk API specification

[`spec/sevdesk-openapi.json`](spec/README.md) is the official sevDesk OpenAPI specification,
fetched from <https://api.sevdesk.de/openapi.yaml> with all `$ref`s resolved and known errors
corrected by [`spec/patches.json`](spec/README.md#corrections). `search` runs the model's code
against it. **© sevDesk, not covered by the MIT licence.**

## License

[MIT](LICENSE), except the sevDesk API specification in `spec/` (see above).
