import { McpServer } from '@modelcontextprotocol/server';
import { registerExecuteTool } from './execute.ts';
import { name, version } from './manifest.ts';
import { registerSearchTool } from './search.ts';

// Sent to the client on connect. It describes only the tools that exist; later tools extend it.
const instructions =
  'Use `search` first to find the sevDesk endpoints and parameters you need (your JavaScript runs against the OpenAPI spec), then `execute` to call the API with them. Only what the code returns comes back.';

/** Builds the MCP server with its instructions and tools. Tools are registered here. */
export function createServer(): McpServer {
  const server = new McpServer({ name, version }, { instructions });
  registerSearchTool(server);
  registerExecuteTool(server);
  return server;
}
