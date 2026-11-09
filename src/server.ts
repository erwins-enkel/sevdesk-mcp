import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';

// Resolves to the package root from both src/ and dist/, so name and version
// always match what is published.
const { name, version } = createRequire(import.meta.url)('../package.json') as {
  name: string;
  version: string;
};

/** Builds the MCP server. Tools are registered here as they are implemented. */
export function createServer(): McpServer {
  return new McpServer({ name, version });
}
