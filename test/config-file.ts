import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile } from '../src/config.ts';

/**
 * Writes the config file into this test's temporary config directory (`test/setup.ts`): a string
 * as it is, anything else as JSON. Returns the file's path.
 */
export function writeConfig(content: unknown): string {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
