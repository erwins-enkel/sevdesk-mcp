# sevdesk-mcp

**The whole sevDesk API in two MCP tools.** A local, open-source MCP server that lets AI
assistants (Claude Desktop, ChatGPT Desktop, Claude Code, Codex CLI, …) work with sevDesk
through just `search` and `execute`: instead of one tool per endpoint, the model writes small
JavaScript snippets that run in a local sandbox against the sevDesk API ("Code Mode").

> **Status: early development.** The server starts, but has no tools yet. Do not use it with
> a real sevDesk account yet.

> Not developed or endorsed by sevDesk. (Nicht von sevDesk entwickelt oder unterstützt.)

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.4.4 and Node.js ≥ 22.18.

```sh
bun install       # dependencies + git hooks
bun run verify    # everything CI checks
bun run build && node dist/cli.js   # start the server on stdio
```

The product requirements live in [`docs/prd/PRD-sevdesk.md`](docs/prd/PRD-sevdesk.md), the
foundation decisions in [`docs/decisions/0001-foundation.md`](docs/decisions/0001-foundation.md).

## License

[MIT](LICENSE)
