import { createRequire } from 'node:module';

// The single source of the package name and version (MCP server info, `--version`).
// Resolves to the package root from both src/ and dist/, so they always match what is published.
export const { name, version } = createRequire(import.meta.url)('../package.json') as {
  name: string;
  version: string;
};
