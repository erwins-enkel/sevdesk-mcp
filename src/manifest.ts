import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The single source of the package name and version (MCP server info, `--version`).
// Resolves to the package root from both src/ and dist/, so they always match what is published.
export const { name, version } = createRequire(import.meta.url)('../package.json') as {
  name: string;
  version: string;
};

/** The package root, the parent of src/ and dist/: a local checkout, or an installed package. */
export const root = dirname(dirname(fileURLToPath(import.meta.url)));
