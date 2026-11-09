# sevdesk-mcp

**The whole sevDesk API in two MCP tools.** A local, open-source MCP server that lets AI
assistants (Claude Desktop, ChatGPT Desktop, Claude Code, Codex CLI, …) work with sevDesk
through just `search` and `execute`: instead of one tool per endpoint, the model writes small
JavaScript snippets that run in a local sandbox against the sevDesk API ("Code Mode").

> **Status: early development.** The server offers `search` (explore the sevDesk API
> specification) and a read-only `execute` (GET calls with a token from `SEVDESK_API_TOKEN`);
> writing is not there yet. Do not use it with a real sevDesk account yet.

> Not developed or endorsed by sevDesk. (Nicht von sevDesk entwickelt oder unterstützt.)

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
