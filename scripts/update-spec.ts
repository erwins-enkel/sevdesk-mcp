// `bun run update-spec`: fetches the official sevDesk OpenAPI file, applies the corrections of
// spec/patches.json, inlines its `$ref`s and writes the result to spec/sevdesk-openapi.json, the
// spec the `search` tool embeds. Fails on a non-2xx response, a document that is not an OpenAPI 3
// spec with paths or a patch that no longer applies, never writing a partial or unpatched file.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { applyPatches } from './patch-spec.ts';
import { resolveRefs, type Json } from './resolve-refs.ts';

const source = 'https://api.sevdesk.de/openapi.yaml';
const target = new URL('../spec/sevdesk-openapi.json', import.meta.url);
const patchFile = new URL('../spec/patches.json', import.meta.url);

const response = await fetch(source);
if (!response.ok) throw new Error(`GET ${source} failed: ${String(response.status)}`);

const document = parse(await response.text()) as unknown;
if (
  document === null ||
  typeof document !== 'object' ||
  !('openapi' in document) ||
  typeof document.openapi !== 'string' ||
  !document.openapi.startsWith('3.') ||
  !('paths' in document) ||
  document.paths === null ||
  typeof document.paths !== 'object' ||
  Object.keys(document.paths).length === 0
) {
  throw new Error(`${source} is not an OpenAPI 3 document with paths`);
}

const patches = JSON.parse(readFileSync(patchFile, 'utf8')) as unknown[];
const patched = applyPatches(document as Json, patches);
const spec = resolveRefs(patched) as { info: { version: string }; paths: object };
const text = `${JSON.stringify(spec, null, 2)}\n`;
writeFileSync(target, text);
console.log(
  `spec: sevDesk API ${spec.info.version}, ${String(Object.keys(spec.paths).length)} paths, ${String(patches.length)} patches applied, ${String(text.length)} characters`,
);
