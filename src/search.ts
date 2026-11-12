import { readFileSync } from 'node:fs';
import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server';
import { DEFAULT_CONFIG, type LoadedConfig } from './config.ts';
import { errorResult, toToolResult } from './envelope.ts';
import { GUIDES } from './guides.ts';
import { runSnippet } from './sandbox.ts';

// Shipped in the package next to dist/ (package.json "files"), so this resolves from src/ and dist/.
const specFile = new URL('../spec/sevdesk-openapi.json', import.meta.url);
let specJson: string | undefined;

/** The embedded spec as compact JSON, read on first use. A broken file fails here, not in a snippet. */
function loadSpec(): string {
  specJson ??= JSON.stringify(JSON.parse(readFileSync(specFile, 'utf8')));
  return specJson;
}

const guidesJson = JSON.stringify(GUIDES);

/** The tool description, with the configured output limit. */
const description = (
  outputChars: number,
) => `Explore the sevDesk REST API. \`code\` is the body of an async JavaScript function, run in a sandbox with \`spec\` (the official sevDesk OpenAPI 3.0 spec with known errors patched, all $refs resolved), \`guides\` (curated recipes as { id: { title, text } }: offers, tax rules, invoices, receipts, pagination, dates and time zone, sending, status codes; list the titles and read the matching one before writing to sevDesk) and \`console.log\`; no network or file access. Only the return value and console output come back, each cut at ${String(outputChars)} characters, so return just what you need, e.g.:
return Object.entries(spec.paths).filter(([p]) => p.startsWith('/Order')).map(([p, ops]) => ({ path: p, methods: Object.keys(ops) }))`;

/**
 * Registers `search`: the model's code runs against the embedded sevDesk OpenAPI spec and the
 * guides, within the configured limits. With an invalid config file it returns the config error and
 * runs nothing.
 */
export function registerSearchTool(server: McpServer, loaded: LoadedConfig): void {
  const { limits } = loaded.ok ? loaded.config : DEFAULT_CONFIG;
  server.registerTool(
    'search',
    {
      description: description(limits.outputChars),
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
    async ({ code }) => {
      if (!loaded.ok) return errorResult(loaded.error);
      const globals = { spec: loadSpec(), guides: guidesJson };
      return toToolResult(await runSnippet(code, globals, limits), limits.outputChars);
    },
  );
}
