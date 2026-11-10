import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig } from './config.ts';
import { registerExecuteTool } from './execute.ts';
import { name, version } from './manifest.ts';
import { registerSearchTool } from './search.ts';
import { registerVersionTool } from './version.ts';

// Sent to the client on connect. It describes only the tools that exist; later tools extend it.
const instructions =
  'Use `search` first to find the sevDesk endpoints and parameters you need (your JavaScript runs against the OpenAPI spec), then `execute` to call the API with them. Only what the code returns comes back. Irreversible calls (sending, deleting, enshrining, booking, cancelling) are held: show the user the preview, and only after their yes call `execute` with `confirm`.';

/**
 * Builds the MCP server with its instructions and tools. Tools are registered here. The config file
 * is read once per server; an invalid one makes every tool return its error instead of running.
 * `pinnedProfile` (`--profile <name>`) limits `execute` to that one profile. `checkout`, the local
 * checkout this server runs from (never an installed package), adds the `version` tool for it.
 */
export function createServer({
  pinnedProfile,
  checkout,
}: { pinnedProfile?: string; checkout?: string } = {}): McpServer {
  const config = loadConfig();
  const server = new McpServer({ name, version }, { instructions });
  registerSearchTool(server, config);
  registerExecuteTool(server, config, pinnedProfile);
  if (checkout !== undefined) registerVersionTool(server, checkout);
  return server;
}
