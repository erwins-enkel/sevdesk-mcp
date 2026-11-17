# Configuration

[Deutsch](../de/konfiguration.md) · **English** · [Overview](../../README.md#english)

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

| Key                     | Default                        | Allowed                                                             |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `baseUrl`               | `https://my.sevdesk.de/api/v1` | an `https://` URL without credentials, query or fragment            |
| `limits.timeoutSeconds` | `30`                           | time per run, whole seconds from 1 to 3600                          |
| `limits.memoryMb`       | `64`                           | sandbox memory in MB, 16 to 2048                                    |
| `limits.callsPerRun`    | `50`                           | sevdesk calls per `execute` run, 1 or more                          |
| `limits.outputChars`    | `20000`                        | characters of result and of console output, 1 or more               |
| `profiles.<name>`       | none                           | a [profile](setup.md): name of 1 to 32 characters `a-z`, `0-9`, `-` |
| `….company`             | required                       | the sevdesk company name, a non-empty string                        |
| `….readonly`            | `false`                        | `true` or `false` ([read-only mode](safety.md#read-only-mode))      |
| `….downloadDir`         | `~/Downloads/sevdesk/<name>`   | where its [files](files.md) are saved, an absolute path             |
| `audit`                 | `true`                         | `true` or `false` ([audit log](safety.md#audit-log))                |

The server reads the file when it starts, so restart it (or your MCP client) after a change. If the
file is not valid JSON, has an unknown key or an invalid value, both tools refuse to run and
return an `invalid_config` error naming the file and the problem; the server never falls back to
the defaults for a broken file.

`sevdesk-mcp config` changes profiles and the audit switch in a menu in the terminal (see
[Setup and profiles](setup.md#changing-profiles-and-settings-config)).
