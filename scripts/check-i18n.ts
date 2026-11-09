// i18n drift gate: every catalog in src/i18n must have exactly the keys of en.json,
// with non-empty strings and the same {placeholders}. Runs in CI and the pre-push hook.
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/i18n/', import.meta.url);
const load = (file: string) =>
  JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, unknown>;
const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(',');

const reference = load('en.json');
const files = readdirSync(dir).filter((file) => file.endsWith('.json') && file !== 'en.json');
const problems: string[] = [];

if (files.length === 0) problems.push('no catalogs besides en.json found in src/i18n');

for (const file of files) {
  const catalog = load(file);
  for (const [key, expected] of Object.entries(reference)) {
    const actual = catalog[key];
    if (typeof actual !== 'string' || actual === '') {
      problems.push(`${file}: missing or empty "${key}"`);
    } else if (placeholders(actual) !== placeholders(String(expected))) {
      problems.push(`${file}: placeholders of "${key}" differ from en.json`);
    }
  }
  for (const key of Object.keys(catalog)) {
    if (!(key in reference)) problems.push(`${file}: "${key}" is not in en.json`);
  }
}

if (problems.length > 0) {
  console.error(`i18n drift:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `i18n: ${String(files.length + 1)} catalogs in parity (${String(Object.keys(reference).length)} keys)`,
);
