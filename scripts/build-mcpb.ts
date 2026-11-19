// Builds the Claude Desktop extension into build/mcpb/sevdesk-mcp.mcpb (`bun run build:mcpb`; the
// release workflow attaches it to the GitHub release). See scripts/mcpb.ts.
import { fileURLToPath } from 'node:url';
import { buildMcpb } from './mcpb.ts';

console.log(await buildMcpb(fileURLToPath(new URL('../build/mcpb', import.meta.url))));
