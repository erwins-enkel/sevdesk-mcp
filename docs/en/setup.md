# Setup and profiles

[Deutsch](../de/einrichtung.md) · **English** · [Overview](../../README.md#english)

A profile is one sevdesk account. The [config file](configuration.md) holds its name, company and
read-only flag; its API token lives only in the OS keychain (macOS Keychain, Windows Credential
Manager, Linux Secret Service), under the service `sevdesk-mcp` with the profile name as the
account. A token is never read from a file; a `token` key in the config file is an error.

## Adding a profile: `setup`

Add a profile in a terminal with `npx @erwins-enkel/sevdesk-mcp setup` (`setup --add` does the
same). From a local checkout, run `node dist/cli.js setup` instead
([beta testing](local-checkout.md)).

1. It asks for the profile name (1 to 32 characters `a-z`, `0-9`, `-`). An existing profile is
   replaced only after an explicit yes.
2. It asks for the API token without showing it, checks it against sevdesk and shows the company
   and bookkeeping system. A rejected token or an account on another system than 2.0 is refused.
   You find the token in sevdesk under Erweiterungen → API (Extensions → API).
3. It asks whether the profile is read-only (default no; when replacing, the profile's current
   setting).
4. It stores the token in the OS keychain and the profile (name, company, read-only) in the config
   file.
5. It offers to register the profile in each installed MCP client (see
   [MCP clients](#mcp-clients)) and prints the command for any other client:
   `npx -y @erwins-enkel/sevdesk-mcp --profile <name>`, or, run from a local checkout, the command
   that starts its build ([beta testing](local-checkout.md)).

Until step 4 nothing is stored. There is no plaintext fallback: without an OS keychain
(headless Linux, WSL, Docker), `setup` stops and explains why, as a token in a plain file can be
read by any process and any backup and grants full access to the bookkeeping. Use
`SEVDESK_API_TOKEN` there instead. Without a terminal (scripts, CI), `setup` stops with the same
hint; it has no non-interactive options. Its exit code is 0 when the profile is stored and every
client config it touched could be read and written, and 1 otherwise.

## Listing and removing profiles

`setup --list` prints every profile of the config file with its company and whether it is
read-only. It reads only the config file, never the keychain, so it never shows a token, and it
needs no terminal.

`setup --remove <name>` asks before it removes the profile (default no). After a yes it deletes the
token from the OS keychain and then the profile from the config file; every other key of the file
stays. It needs a terminal for the question. Its exit code is 0 when the profile is removed and 1
otherwise: after a no, for an unknown profile, or when the keychain or the config file fails. If
only the config file fails, the token is already gone; fix the file and run `setup --remove` again.
Once the profile is removed, it offers to remove the client entries that start it (see
[MCP clients](#mcp-clients)).

## Changing profiles and settings: `config`

`sevdesk-mcp config` opens a menu in the terminal. It first shows the running version and its
updates, the config file, whether the audit log is on and where it is, and every profile with its
company, read-only state, download directory and, for each installed MCP client, the entries that
start it and their kind (`npx` or `local build`). The overview reads only the config file and the
client configs, never the keychain. Move with the arrow keys or type an item's number (1 to 9),
choose with Enter, go back with Esc or q. The output is plain text without colours, so it reads the
same with `NO_COLOR`.

- **Per profile:** make it read-only or allow writes again, set its download directory (an
  absolute path) or reset it to the default, add it to or remove it from the installed MCP
  clients (the same questions and backups as `setup`, see [MCP clients](#mcp-clients)), check its
  connection (its token from the keychain against sevdesk, showing company and bookkeeping system,
  never the token) and remove it (as `setup --remove`).
- **Add a profile:** runs the `setup` dialogue.
- **Audit log:** turn it off or on.
- **Update** (local checkout only, see below): offered first when commits are waiting.

Run from a local checkout, `config` fetches the branch's upstream once when it opens (`git fetch`,
no user data) and shows the version with branch, commit and date, and whether commits are
waiting. If it cannot check, it says why ("unknown") and never claims to be up to date. When commits
are waiting, the branch has none of its own and no tracked file is changed, the menu offers
"Update to <commit>". It lists the waiting commits, asks (default yes) and then updates exactly as
the `version` tool does (see [beta testing](local-checkout.md)). After an update, `config` ends;
run it again to see the new version. An installed package shows its version and does not check for
updates here.

Each change is written at once, keeping every other key of the file; restart the MCP clients so
they pick it up. Ctrl+C leaves at any point without a half-written change. Like `setup`, `config`
needs a terminal and stops with exit code 1 without one; it takes no options (an option or
argument is a usage error, exit code 2). Its exit code is 0 when you leave and every change went
through, and 1 when one failed (such as a client config that could not be written or a failed
connection check).

## MCP clients

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
checkout's build ([beta testing](local-checkout.md)); it says which kind it writes. The entry
never holds a token. In Codex's `config.toml` it is the table `mcp_servers.sevdesk` with `command`
and `args`; in OpenCode it is `"sevdesk": { "type": "local", "command": [...] }` in its `mcp`
section. A relative `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or (for OpenCode) `XDG_CONFIG_HOME` depends
on the directory the client starts in, so `setup` leaves that client alone. `setup` asks once per
client and shows the file:

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

## Which account a call uses

The server never guesses which account a call is for:

1. With `SEVDESK_API_TOKEN` set, it has exactly that one profile (named by `SEVDESK_PROFILE`,
   default `env`) and does not read the keychain; otherwise it has the profiles of the config file.
2. `sevdesk-mcp --profile <name>` pins the server to one of them; `execute` accepts no other
   `account`. (`--reload`, for a local checkout's entries, is described under
   [beta testing](local-checkout.md).)
3. Otherwise, with exactly one profile, `execute` uses it.
4. With several, `execute` needs `account`; without it, it answers `account_required` with the
   profile names and companies.
