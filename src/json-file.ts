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

/** A text file as read: its exact bytes and its text without a leading byte-order mark. */
export interface TextFile {
  bytes: Buffer;
  text: string;
}

/** Whether `value` is a JSON object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The UTF-8 text of `file` with the file's bytes, or undefined when there is no file. A leading
 * byte-order mark (some Windows editors write one) is not part of the text. Throws when the file
 * cannot be read.
 */
export function readTextFile(file: string): TextFile | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return { bytes, text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
}

/** The JSON object in `text`, the content of `file`. Throws when it is not valid JSON or no object. */
export function parseJsonObject(text: string, file: string): Record<string, unknown> {
  const json: unknown = JSON.parse(text);
  if (!isRecord(json)) throw new Error(`${file} does not hold a JSON object`);
  return json;
}

/**
 * The JSON object in `file`, or undefined when there is no file. Throws when the file cannot be
 * read, is not valid JSON or does not hold a JSON object.
 */
export function readJsonFile(file: string): Record<string, unknown> | undefined {
  const read = readTextFile(file);
  return read === undefined ? undefined : parseJsonObject(read.text, file);
}

/** Writes `json` (two-space indented, with a final line break) as `file`, as `writeTextFile` does. */
export function writeJsonFile(file: string, json: Record<string, unknown>): void {
  writeTextFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

/**
 * Writes `text` as `file`, directory included. The text goes into a temporary file next to it that
 * is then renamed over it, so a failed write never leaves a half-written file. An existing file
 * keeps its permissions, and a symlink stays one: the file it points to is replaced.
 */
export function writeTextFile(file: string, text: string): void {
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
    writeFileSync(temporary, text, { flag: 'wx', mode });
    // The umask may have narrowed the mode the file was created with.
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
