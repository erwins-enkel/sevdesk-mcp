# Safety and privacy

[Deutsch](../de/sicherheit.md) · **English** · [Overview](../../README.md#english)

## Irreversible calls

Reading and creating or changing drafts run directly. Anything that cannot be undone (deleting,
sending, enshrining, booking, cancelling, resetting, changing a document's status, `getPdf`
without `preventSendBy=true`, and any path the sevdesk specification does not know, for reads and
writes alike) is held instead of sent:

1. The code's call resolves to `{ held: true }` and the code goes on, so drafts before and after it
   are created as usual.
2. If the run succeeds, its result carries `confirmation`: a token and a preview of every held
   call (the exact method, path, query and body; for an order, invoice, credit note or voucher its
   kind, number, date, net and gross amount with the currency, and the recipient; the mail
   subject; the profile and its company). The assistant shows you the preview.
3. Only after your yes does it call `execute` with `confirm` set to the token, and no code. The
   server first reads every document of the preview again. If one changed since the preview,
   through a later run or in sevdesk itself, or cannot be read, nothing is sent and the token is
   used up; a new run gives a fresh preview. Only the document as the preview read it is
   compared, not its positions or the contact it names. Otherwise the server sends exactly the
   held calls, in order, each once and never retried. It stops at the first call sevdesk does not
   accept and reports every call as `sent`, `failed` or `not_sent`. A call sevdesk accepted (2xx)
   is `sent` even if its answer cannot be read.

Deleting includes a write whose body names something to delete in a key ending in `Delete`, such
as `orderPosDelete` (positions) or `discountDelete` (discounts) of a factory save like
`POST /Order/Factory/saveOrder`. Set to `null` or left empty, the key deletes nothing and the save
runs directly.

Changing a document's status includes a write on an order, invoice, credit note or voucher with
`status` in its body, or with a query parameter whose name contains `status` (such as `status` or
`invoice[status]`, case ignored). Only the factory save of a new draft may carry the draft status,
in its body; a status in the query is always held.

A read is held too when the specification does not know its path, since some GETs of the
specification change data as well, such as `getPdf`. The one exception is `GET /SevClient`, which
the server reads for the company name.

A token works once, for 10 minutes, for the profile that held the calls, and only until the server
restarts. If the run fails, its held calls are dropped and no token is issued. Held calls, and the
reads of the documents they act on for the preview, count towards
[`limits.callsPerRun`](configuration.md). The reads before a confirmation and its calls together
run within [`limits.timeoutSeconds`](configuration.md). The profile of `SEVDESK_API_TOKEN` has no
company in the config file, so its preview names only the profile.

## Read-only mode

Read-only mode makes `execute` unable to change anything in sevdesk. It is on for a call when
either switch is on; neither can turn the other off:

- `SEVDESK_READONLY` in the environment of the MCP server turns it on for every profile. Any value
  but empty, `false` or `0` (case ignored) counts as on.
- `"readonly": true` in a profile of the [config file](configuration.md) turns it on for that
  profile, even with `SEVDESK_READONLY=false`. The profile of `SEVDESK_API_TOKEN` has no such flag;
  only `SEVDESK_READONLY` applies to it.

In read-only mode every call that is not a GET, and every call that would be held for confirmation
(including a GET such as `getPdf` without `preventSendBy=true`, or a GET of a path the specification
does not know), fails with a `read_only` error. Such a call is rejected outright, never held, so no
confirmation token can get it through, and `execute` with `confirm` is rejected as well. Reads and
`sevdesk.savePdf` keep working (`savePdf` always sets `preventSendBy=true`). The render `savePdf`
sends for a draft is the one write that read-only mode lets through: it changes no status, it keeps
the PDF current, and it is listed in `writes` and the audit log. The same render sent through
`sevdesk.request` is rejected. When `SEVDESK_READONLY` is on, or the server is pinned with
`--profile` to a read-only profile, `execute` carries the MCP `readOnlyHint` annotation. The server
reads both switches when it starts, so restart it after a change.

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
(sevdesk's HTTP status, if it answered), `objectId` (if the answer names one), `bodyHash` (the
SHA-256 of the JSON body, if any) and `outcome`:

- `executed`: a draft or other reversible write, sent directly.
- `held`: an irreversible call, held for your confirmation and not sent. A run that fails drops
  it; it is then never sent.
- `confirmed`: a held call, sent after your confirmation; `status` shows whether sevdesk accepted
  it.
- `rejected`: a call that read-only mode refused, or an irreversible read that `sevdesk.paginate`
  refused; not sent.

Reads get no line. The log never holds a request body (no customer data) or the token. The
server never deletes or rotates it; remove old months yourself. Several MCP clients, each with its
own server, can write to it at once without breaking lines, as long as the folder is on a local
disk (not a network share). If the log cannot be written, the call fails with an `audit_error`
and the run stops instead of going on unrecorded: a write is not sent, an irreversible call is not
held, and a confirmation sends nothing and keeps its token. Should writing fail only after sevdesk
answered (e.g. a full disk), the error says the call was sent. To turn the log off, set
`"audit": false` in the config file and restart the server.

## Privacy

The server runs on your computer and talks to sevdesk only. It sends no telemetry and no crash
reports. Run from a local checkout, the `version` tool and `sevdesk-mcp config` also run a
`git fetch` of the checkout's upstream, which sends no user data
([beta testing](local-checkout.md)).

The API token stays on your computer: it comes from the OS keychain or `SEVDESK_API_TOKEN` and is
added to each request outside the sandbox, so neither the code the model writes nor the model
ever sees it.

Whatever `execute` returns goes to the AI provider behind your MCP client, as does everything else
in the conversation: the result, the console output and the list of writes. So ask for what you
need, such as totals instead of every invoice, rather than whole records. PDFs and exports are
saved on disk and only their path goes back ([files](files.md)).
