import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// `src/manifest.ts` as an installed package sees it: the package root lies under node_modules (here
// npx's cache), so `setup` writes the npx entry of decision 18. Test files that check that entry
// mock `src/manifest.ts` with this module; the tests themselves run from a local checkout.
// It stands in for that module, so it has to export the same names.
// fallow-ignore-file duplicate-export

export const { name, version } = createRequire(import.meta.url)('../package.json') as {
  name: string;
  version: string;
};

export const root = resolve('/npx-cache/_npx/1a2b/node_modules/@erwins-enkel/sevdesk-mcp');
