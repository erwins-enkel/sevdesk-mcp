import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { HostError } from './sandbox.ts';

// What a file name keeps: letters, digits, `.`, `_` and `-`. Anything else, path separators, `:`,
// whitespace, control and Windows-reserved characters among them, becomes `_`.
const UNSAFE_CHARACTER = /[^\p{L}\p{N}._-]/gu;

// Names Windows reserves for devices, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

// File extensions by media type for the non-JSON responses of `sevdesk.request`; others get `bin`.
const EXTENSIONS = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['text/csv', 'csv'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
  ['text/plain', 'txt'],
]);

const HINT =
  'Check that the directory can be created and written to; a profile in the config file can set its own downloadDir.';

/**
 * `text` (e.g. a sevDesk document number) as the stem of a file name that stays in its directory:
 * every character but letters, digits, `.`, `_` and `-` becomes `_`, and leading and trailing dots
 * go, so it never holds a path separator and is never `.` or `..`. Undefined when nothing usable is
 * left: an empty name or a Windows device name.
 */
export function fileStem(text: string): string | undefined {
  const stem = text.replace(UNSAFE_CHARACTER, '_').replace(/^\.+|\.+$/g, '');
  return stem === '' || WINDOWS_DEVICE.test(stem) ? undefined : stem;
}

/**
 * The file name of a non-JSON response to `path`: its segments joined by `-`, with the extension
 * of its content type (`bin` when unknown), e.g. `Export-datevCSV.csv` for `/Export/datevCSV`.
 */
export function binaryFileName(path: string, contentType: string): string {
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const stem = fileStem(path.slice(1).replaceAll('/', '-')) ?? 'download';
  return `${stem}.${EXTENSIONS.get(mediaType) ?? 'bin'}`;
}

/** The structured error of a file that could not be saved; only the error's code, if any. */
function downloadError(name: string, dir: string, error: unknown): HostError {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return new HostError({
    kind: 'download_error',
    message: `${name} could not be saved in ${dir}${code === undefined ? '' : ` (${code})`}.`,
    hint: HINT,
  });
}

/**
 * Creates the first free one of `name`, `<stem>-2.<ext>`, `<stem>-3.<ext>`, … in `dir` as an empty
 * file and returns its path. The exclusive create claims the name, so no other write can take it.
 */
async function reserve(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let number = 1; ; number += 1) {
    const path = join(dir, number === 1 ? name : `${stem}-${String(number)}${extension}`);
    try {
      await (await open(path, 'wx')).close();
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

interface SaveOptions {
  /** Replace a file of the same name (a PDF: the newest rendering wins); else pick a free name. */
  replace: boolean;
  /** Aborts the write; nothing is left behind then. */
  signal: AbortSignal;
}

/**
 * Saves `data` (bytes, or a stream of them) as `name` in `dir`, which is created if needed, and
 * returns the file's path and size. The data goes to a temporary file in `dir` first and is renamed
 * onto its name only when complete, so a failed or aborted write leaves nothing behind and never a
 * half-written file under the name; the rename also replaces a symlink there instead of writing
 * through it. Without `replace` an existing file is kept and the data gets the next free name (see
 * `reserve`). Any failure is a catchable `download_error`.
 */
export async function saveFile(
  dir: string,
  name: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  { replace, signal }: SaveOptions,
): Promise<{ path: string; bytes: number }> {
  const temporary = join(dir, `.${randomUUID()}.part`);
  let reserved: string | undefined;
  try {
    await mkdir(dir, { recursive: true });
    const source = data instanceof Uint8Array ? Readable.from([data]) : Readable.fromWeb(data);
    await pipeline(source, createWriteStream(temporary, { flags: 'wx' }), { signal });
    const { size } = await stat(temporary);
    if (!replace) reserved = await reserve(dir, name);
    const path = reserved ?? join(dir, name);
    await rename(temporary, path);
    return { path, bytes: size };
  } catch (error) {
    // Best effort: the error that stopped the write is the one to report.
    await rm(temporary, { force: true }).catch(() => undefined);
    if (reserved !== undefined) await rm(reserved, { force: true }).catch(() => undefined);
    throw downloadError(name, dir, error);
  }
}
