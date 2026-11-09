import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** A JSON file as read: its exact bytes and the object it holds. */
export interface JsonFile {
  bytes: Buffer;
  json: Record<string, unknown>;
}

/** Whether `value` is a JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON object in `file` with the file's bytes, or undefined when there is no file. A leading
 * byte-order mark (some Windows editors write one) is not part of the JSON. Throws when the file
 * cannot be read, is not valid JSON or does not hold a JSON object.
 */
export function readJsonFile(file: string): JsonFile | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const json: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!isRecord(json)) throw new Error(`${file} does not hold a JSON object`);
  return { bytes, json };
}

/**
 * Writes `json` (two-space indented, with a final line break) as `file`, directory included. The
 * JSON goes into a temporary file next to it that is then renamed over it, so a failed write never
 * leaves a half-written file. An existing file keeps its permissions, and a symlink stays one: the
 * file it points to is replaced.
 */
export function writeJsonFile(file: string, json: Record<string, unknown>): void {
  let target = file;
  let mode: number | undefined;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(json, null, 2)}\n`, { flag: 'wx', mode });
    // The umask may have narrowed the mode the file was created with.
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
