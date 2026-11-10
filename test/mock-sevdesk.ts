import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { DEFAULT_BASE_URL } from '../src/sevdesk.ts';
import { redirectFetch } from './redirect-fetch.ts';

/**
 * What a mock route answers: `json` by default, or `text` or raw `bytes` with their own content
 * type (`null` sends none).
 */
export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string | null;
  /** Further response headers, e.g. `retry-after`. */
  headers?: Record<string, string>;
}

/**
 * A request the mock received; `path` is relative to the API base, `body` the request body as text
 * (empty without one).
 */
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** Route handlers keyed by `METHOD /path` relative to the API base, e.g. `GET /Contact`. */
export type MockRoutes = Record<string, (request: MockRequest) => MockResponse>;

const defaultRoutes: MockRoutes = {
  'GET /Tools/bookkeepingSystemVersion': () => ({ json: { objects: { version: '2.0' } } }),
};

/** A JSON schema of the embedded spec, as far as the tests read it. */
export interface SpecSchema {
  required?: string[];
  properties?: Record<string, SpecSchema>;
  items?: SpecSchema;
}

/** An operation of the embedded spec, as far as the tests read it. */
interface SpecOperation {
  requestBody?: { content?: Record<string, { schema?: SpecSchema } | undefined> };
}

const spec = JSON.parse(
  readFileSync(new URL('../spec/sevdesk-openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, SpecOperation>> };

// The sevDesk endpoints the server uses that the spec lacks: `companyName()` reads GET /SevClient.
const UNDOCUMENTED = new Set(['GET /SevClient']);

// Every operation of the embedded spec, its path template as a pattern: a parameter matches one
// segment.
const OPERATIONS = Object.entries(spec.paths).flatMap(([template, methods]) => {
  const pattern = new RegExp(`^${template.replace(/\{\w+\}/g, '[^/]+')}$`);
  return Object.entries(methods).map(([method, operation]) => ({
    method: method.toUpperCase(),
    pattern,
    operation,
  }));
});

/**
 * The operation of the embedded spec that `method path` (a path relative to the API base) is an
 * instance of, or undefined when the spec has none (PRD §8: the mock follows the spec). The
 * undocumented endpoints the server uses count as operations without a schema.
 */
export function specOperation(method: string, path: string): SpecOperation | undefined {
  if (UNDOCUMENTED.has(`${method} ${path}`)) return {};
  return OPERATIONS.find((operation) => operation.method === method && operation.pattern.test(path))
    ?.operation;
}

/**
 * What the mock answers `request`: its route's answer, a 404 when it has no route, and a 404 naming
 * the spec, without reaching a route, when it is no operation of the embedded spec.
 */
function answerTo(request: MockRequest, handlers: MockRoutes): MockResponse {
  const { method, path } = request;
  if (specOperation(method, path) === undefined) {
    const message = `${method} ${path} is not in the embedded sevDesk spec`;
    return { status: 404, json: { objects: null, error: { message } } };
  }
  const handler = handlers[`${method} ${path}`];
  return handler
    ? handler(request)
    : { status: 404, json: { objects: null, error: { message: 'Not found' } } };
}

/**
 * Starts a mock sevDesk on a free port with `routes` over the defaults (a system 2.0 account;
 * anything else answers 404) and points the global `fetch` at it: calls to `baseUrl` (the real API
 * base unless a test configures another) go to the mock, any other URL throws, so a test never
 * reaches sevDesk. The HTTPS base URL stays as it is in the code under test. The mock follows the
 * embedded spec: a route that is no spec operation (`specOperation`) fails the start, and a request
 * that is none answers 404 without reaching a route. Every request is recorded in `requests`.
 * `serverImport` is the module a spawned server preloads (`node --import <serverImport> …`) to send
 * its calls here too. Undo with `vi.unstubAllGlobals()` and `close()`.
 */
export async function startMockSevdesk(routes: MockRoutes = {}, baseUrl = DEFAULT_BASE_URL) {
  const outside = Object.keys(routes).filter((key) => {
    const [method = '', path = ''] = key.split(' ');
    return specOperation(method, path) === undefined;
  });
  if (outside.length > 0) {
    throw new Error(
      `The mock sevDesk follows the embedded spec, which lacks ${outside.join(', ')}`,
    );
  }
  const base = new URL(baseUrl);
  const requests: MockRequest[] = [];
  const handlers = { ...defaultRoutes, ...routes };
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://mock');
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: MockRequest = {
        method: incoming.method ?? '',
        path: url.pathname.slice(base.pathname.length),
        query: url.searchParams,
        authorization: incoming.headers.authorization,
        contentType: incoming.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      const answer = answerTo(request, handlers);
      const contentType =
        answer.contentType === undefined ? 'application/json' : answer.contentType;
      response.writeHead(answer.status ?? 200, {
        ...(contentType === null ? {} : { 'content-type': contentType }),
        ...answer.headers,
      });
      response.end(answer.bytes ?? answer.text ?? JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  vi.stubGlobal('fetch', redirectFetch(baseUrl, origin, globalThis.fetch));

  // A spawned server cannot be stubbed from here, so it preloads this module, which wraps its own
  // fetch with the same redirect.
  const redirect = new URL('./redirect-fetch.ts', import.meta.url).href;
  const preload = `import { redirectFetch } from ${JSON.stringify(redirect)};
globalThis.fetch = redirectFetch(${JSON.stringify(baseUrl)}, ${JSON.stringify(origin)}, globalThis.fetch);`;

  return {
    requests,
    serverImport: `data:text/javascript,${encodeURIComponent(preload)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
