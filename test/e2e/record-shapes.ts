import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { DEFAULT_BASE_URL } from '../../src/sevdesk.ts';
import { endpointOf, mergeShapes, type Shape, shapeOf } from '../response-shapes.ts';

// The shape recorder of the manual E2E run (issue #60). The run loads it into the server it spawns
// with `--import <recorderImport(file)>`; then it wraps the server's fetch and appends one line per
// 2xx JSON answer from sevDesk to `file`: the call's method and path and the answer's shape
// (test/response-shapes.ts). The shape is taken in the server, from a clone, before the server reads
// or discards the answer, so getPdf's JSON and render's unread answer are recorded too, no value
// reaches the file, and the server gets the answer unchanged. Imported without the query, as
// live.e2e.ts does for `recorderImport` and `readRecorded`, it records nothing.

/** One line of a recording file: the shape of an answer, or why the recorder could not take it. */
interface Line {
  method: string;
  path: string;
  shape?: Shape;
  /** The error's name only: its message could quote the answer. */
  error?: string;
}

/** The `--import` specifier that makes a server record the shapes of its sevDesk answers in `file`. */
export function recorderImport(file: string): string {
  const url = new URL(import.meta.url);
  url.searchParams.set('file', file);
  return url.href;
}

/**
 * What the recorder wrote to `file`: the shape of each recorded endpoint (test/response-shapes.ts
 * `RECORDED`) it saw, all its answers merged, and the calls whose shape it could not take.
 */
export function readRecorded(file: string): { seen: Record<string, Shape>; errors: string[] } {
  if (!existsSync(file)) return { seen: {}, errors: ['the recorder wrote no file'] };
  const seen: Record<string, Shape> = {};
  const errors: string[] = [];
  for (const text of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const { method, path, shape, error } = JSON.parse(text) as Line;
    if (error !== undefined) errors.push(`${method} ${path}: ${error}`);
    const endpoint = endpointOf(method, path);
    if (endpoint !== undefined && shape !== undefined) {
      seen[endpoint] = mergeShapes(seen[endpoint] ?? {}, shape);
    }
  }
  return { seen, errors };
}

const base = new URL(DEFAULT_BASE_URL);

/** The path of a call to sevDesk relative to the API base, or undefined for any other URL. */
function sevdeskPath(input: Parameters<typeof fetch>[0]): string | undefined {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) return undefined;
  return url.pathname.slice(base.pathname.length);
}

/**
 * Appends the shape of `response` to `file`, or the name of the error that kept it from being
 * taken; the run fails on such a line, and should even it not reach the file, on the shapes it
 * misses. Never throws: the server keeps its answer either way.
 */
async function append(file: string, method: string, path: string, response: Response) {
  const write = (line: Line) => {
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  };
  try {
    write({ method, path, shape: shapeOf(await response.clone().json()) });
  } catch (error) {
    try {
      write({ method, path, error: error instanceof Error ? error.name : 'unknown error' });
    } catch {
      // Nothing more to record.
    }
  }
}

/** Wraps the global fetch so that it appends the shape of each 2xx JSON answer from sevDesk to `file`. */
function record(file: string): void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const path = sevdeskPath(input);
    const json = /json/i.test(response.headers.get('content-type') ?? '');
    if (path !== undefined && response.ok && json) {
      await append(file, init?.method ?? 'GET', path, response);
    }
    return response;
  };
}

const file = new URL(import.meta.url).searchParams.get('file');
if (file !== null) record(file);
