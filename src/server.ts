import { McpServer } from '@modelcontextprotocol/server';
import { name, version } from './manifest.ts';
import { registerSearchTool } from './search.ts';

// Sent to the client on connect. It describes only the tools that exist; later tools extend it.
const instructions =
  'Use `search` to explore the sevDesk API: your JavaScript runs against its OpenAPI spec, and only what the code returns comes back.';

/** Builds the MCP server with its instructions and tools. Tools are registered here. */
export function createServer(): McpServer {
  const server = new McpServer({ name, version }, { instructions });
  registerSearchTool(server);
  return server;
}
