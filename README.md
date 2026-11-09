# sevdesk-mcp

**The whole sevDesk API in two MCP tools.** A local, open-source MCP server that lets AI
assistants (Claude Desktop, ChatGPT Desktop, Claude Code, Codex CLI, …) work with sevDesk
through just `search` and `execute`: instead of one tool per endpoint, the model writes small
JavaScript snippets that run in a local sandbox against the sevDesk API ("Code Mode").

> **Status: early development.** The server offers `search` (explore the sevDesk API
> specification) and a read-only `execute` (GET calls with a token from `SEVDESK_API_TOKEN`);
> writing is not there yet. Do not use it with a real sevDesk account yet.

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
  "limits": { "timeoutSeconds": 30, "memoryMb": 64, "callsPerRun": 50, "outputChars": 20000 }
}
```

| Key                     | Default                        | Allowed                                                  |
| ----------------------- | ------------------------------ | -------------------------------------------------------- |
| `baseUrl`               | `https://my.sevdesk.de/api/v1` | an `https://` URL without credentials, query or fragment |
| `limits.timeoutSeconds` | `30`                           | time per run, whole seconds from 1 to 3600               |
| `limits.memoryMb`       | `64`                           | sandbox memory in MB, 16 to 2048                         |
| `limits.callsPerRun`    | `50`                           | sevDesk calls per `execute` run, 1 or more               |
| `limits.outputChars`    | `20000`                        | characters of result and of console output, 1 or more    |

The server reads the file when it starts, so restart it (or your MCP client) after a change. If the
file is not valid JSON, has an unknown key or an invalid value, both tools refuse to run and
return an `invalid_config` error naming the file and the problem; the server never falls back to
the defaults for a broken file.

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
fetched from <https://api.sevdesk.de/openapi.yaml> with all `$ref`s resolved. `search` runs the
model's code against it. **© sevDesk, not covered by the MIT licence.**

## License

[MIT](LICENSE), except the sevDesk API specification in `spec/` (see above).
