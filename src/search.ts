import { readFileSync } from 'node:fs';
import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { toToolResult } from './envelope.ts';
import { DEFAULT_LIMITS, runSnippet } from './sandbox.ts';

// Shipped in the package next to dist/ (package.json "files"), so this resolves from src/ and dist/.
const specFile = new URL('../spec/sevdesk-openapi.json', import.meta.url);
let specJson: string | undefined;

/** The embedded spec as compact JSON, read on first use. A broken file fails here, not in a snippet. */
function loadSpec(): string {
  specJson ??= JSON.stringify(JSON.parse(readFileSync(specFile, 'utf8')));
  return specJson;
}

const description = `Explore the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`spec\` (the official sevDesk OpenAPI 3.0 spec, all $refs resolved) and \`console.log\`; no network or file access. Only the return value and console output come back, each cut at ${String(DEFAULT_LIMITS.outputChars)} characters, so return just what you need, e.g.:
return Object.entries(spec.paths).filter(([p]) => p.startsWith('/Order')).map(([p, ops]) => ({ path: p, methods: Object.keys(ops) }))`;

/** Registers `search`: the model's code runs against the embedded sevDesk OpenAPI spec. */
export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    'search',
    {
      description,
      inputSchema: fromJsonSchema<{ code: string }>({
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Body of an async JavaScript function; use return.',
          },
        },
        required: ['code'],
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ code }) =>
      toToolResult(await runSnippet(code, { spec: loadSpec() }), DEFAULT_LIMITS.outputChars),
  );
}
