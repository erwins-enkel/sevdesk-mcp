import { McpServer } from '@modelcontextprotocol/server';
import { name, version } from './manifest.ts';

/** Builds the MCP server. Tools are registered here as they are implemented. */
export function createServer(): McpServer {
  return new McpServer({ name, version });
}
