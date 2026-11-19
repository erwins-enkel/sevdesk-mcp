# Installing without technical knowledge

[Deutsch](../de/installation.md) · **English** · [Overview](../../README.md#english)

You need neither Git nor Bun nor a build. You need a sevdesk account on bookkeeping system 2.0 and
its API token: in sevdesk under Erweiterungen → API (Extensions → API). Treat the token like a
password, as it gives full access to your bookkeeping.

## Claude Desktop (Windows and macOS)

From version 0.1.1, sevdesk-mcp comes as an extension for Claude Desktop. Claude Desktop brings its
own Node.js, and you need no terminal.

1. Download the latest
   [sevdesk-mcp.mcpb](https://github.com/erwins-enkel/sevdesk-mcp/releases/latest/download/sevdesk-mcp.mcpb).
2. In Claude Desktop, open the settings, then **Extensions**, then **Advanced settings**, and click
   **Install Extension…**. Pick the downloaded file. Depending on the version and language, the
   menu items may be named a little differently.
3. Claude Desktop asks for two settings:
   - **sevdesk API token:** your API token. Claude Desktop keeps it in your system's keychain
     (Windows Credential Manager, macOS Keychain); the AI never sees it.
   - **Read-only:** turn this on to start with. The AI then only reads from sevdesk and cannot
     create, send or delete anything. You can turn it off later in the extension's settings.
4. Done. Ask Claude, for example: "Which invoices are more than 30 days overdue?"

PDFs and exports go to `~/Downloads/sevdesk/claude-desktop/` (on Windows
`C:\Users\<you>\Downloads\sevdesk\claude-desktop\`). For a new version, download the file again
and install it the same way. The extension connects exactly one sevdesk account; for several
accounts, set sevdesk-mcp up with `setup` (next section). Use only one of the two ways for Claude
Desktop, or it gets two sevdesk servers.

## ChatGPT Desktop and other clients

ChatGPT Desktop, the Codex CLI, Claude Code and OpenCode have no extension to click. You install
Node.js and enter one command once.

1. On [nodejs.org](https://nodejs.org/), download the installer of the LTS version for your system
   and run it with its default settings.
2. Open a terminal. On Windows: open the Start menu, type "Terminal", press Enter. On macOS:
   Applications → Utilities → Terminal.
3. Paste this command and press Enter. On Windows:

   ```sh
   npx.cmd -y @erwins-enkel/sevdesk-mcp setup
   ```

   On macOS:

   ```sh
   npx -y @erwins-enkel/sevdesk-mcp setup
   ```

   On Windows it says `npx.cmd`, because PowerShell often blocks a plain `npx` through its
   execution policy.

4. `setup` asks in turn for a profile name (for example `acme`: lowercase letters, digits and
   `-`), the API token (it stays invisible while you paste it), whether the profile may only read
   (to start with: yes) and, for each AI client it finds, whether to add the server there. The
   token goes into your system's keychain, never into a file.
5. Restart the AI client.

If `setup` does not list ChatGPT Desktop, the folder `.codex` in your user folder is missing. Then
add the server in ChatGPT yourself: in the settings under MCP servers, as a new STDIO server with
the command `npx` and the arguments `-y @erwins-enkel/sevdesk-mcp --profile <name>`, with your
profile name instead of `<name>`. The server reads the token from the keychain; it does not belong
in that form. More on profiles and clients: [setup and profiles](setup.md).

## Windows: not in WSL

On Windows, set sevdesk-mcp up directly, not in the Windows Subsystem for Linux (WSL): there is no
keychain there, and `setup` would not find the AI clients of Windows.

## Removing

Remove the extension in Claude Desktop under Extensions. Remove a profile from `setup` with
`npx.cmd -y @erwins-enkel/sevdesk-mcp setup --remove <name>` (macOS: `npx`); it deletes the token
from the keychain and offers to remove the entries in the clients.
